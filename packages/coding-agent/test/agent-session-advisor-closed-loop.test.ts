import { afterEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const stepSchema = type({});
const GUIDANCE = "The user does not see advisor notes";

function text(content: string): MockResponse {
	return { content: [content], stopReason: "stop" };
}

/** The primary's Nth answer (0 = the draft after the tool step). */
function answer(index: number): string {
	return `ANSWER_${index}`;
}

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
});

interface ReviewOptions {
	closedLoop: boolean;
	/** Answers (0 = the draft) the advisor raises a concern against, each with a distinct note. */
	rejected: ReadonlySet<number>;
	steps?: number;
	reviewMode?: "turn" | "agent-end";
	reviewInterval?: number;
}

/**
 * A run of `steps` tool steps and then answers, reviewed by an advisor that
 * raises a concern against each answer in `rejected`. Catch-up is off and only
 * blockers continue a finished run, so everything the closed loop does comes
 * from it.
 */
async function runReview({
	closedLoop,
	rejected,
	steps = 1,
	reviewMode = "turn",
	reviewInterval = 1,
}: ReviewOptions): Promise<{ primaryContexts: string[]; agentStarts: number; advisorCalls: number }> {
	const temp = TempDir.createSync("@pi-advisor-closed-loop-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const primaryContexts: string[] = [];
	const primary = createMockModel({
		id: "closed-loop-primary",
		provider: "anthropic",
		handler: () => {
			const call = primaryContexts.length;
			if (call <= steps) {
				return {
					content: [{ type: "toolCall", id: `step-${call}`, name: "step", arguments: {} }],
					stopReason: "toolUse",
				};
			}
			return text(answer(call - steps - 1));
		},
	});
	const advised = new Set<number>();
	let advisorCalls = 0;
	const advisor = createMockModel({
		id: "closed-loop-advisor",
		provider: "anthropic",
		handler: context => {
			advisorCalls++;
			const seen = JSON.stringify(context.messages);
			for (const index of rejected) {
				if (advised.has(index) || !seen.includes(answer(index))) continue;
				advised.add(index);
				return {
					content: [
						{
							type: "toolCall",
							id: `advice-${index}`,
							name: "advise",
							arguments: { note: `answer ${index} skips edge case ${index}`, severity: "concern" },
						},
					],
					stopReason: "toolUse",
				};
			}
			return text("advisor quiet");
		},
	});
	const step: AgentTool<typeof stepSchema, undefined> = {
		name: "step",
		label: "step",
		description: "step test tool",
		parameters: stepSchema,
		execute: async () => ({ content: [{ type: "text", text: "step complete" }] }),
	};
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["closed loop"], tools: [step] },
		convertToLlm,
		streamFn: (messages, context, options) => {
			primaryContexts.push(JSON.stringify(context.messages));
			return primary.stream(messages, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
		"advisor.continueSeverity": "blocker",
		"advisor.closedLoop": closedLoop,
		"advisor.reviewMode": reviewMode,
		"advisor.reviewInterval": reviewInterval,
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorStreamFn: advisor.stream,
	});
	active = { session, auth, temp };
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
	let agentStarts = 0;
	session.subscribe(event => {
		if (event.type === "agent_start") agentStarts++;
	});
	await session.prompt("run a step then answer");
	await session.waitForIdle();
	await session.waitForAdvisorCatchup(2_000);
	await session.waitForIdle();
	return { primaryContexts, agentStarts, advisorCalls };
}

it("revises the draft inside the same run when the closed loop is on", async () => {
	const { primaryContexts, agentStarts } = await runReview({ closedLoop: true, rejected: new Set([0]) });
	// The final review held the run open, so its concern revised the draft before the run ended.
	expect(primaryContexts).toHaveLength(3);
	expect(agentStarts).toBe(1);
	expect(primaryContexts[2]).toContain("answer 0 skips edge case 0");
	expect(primaryContexts[2]).toContain(GUIDANCE);
});

it("shows the revision without reviewing it again", async () => {
	const { primaryContexts } = await runReview({ closedLoop: true, rejected: new Set([0, 1]) });
	// The reviewer would reject revision 1 too, but it never sees it.
	expect(primaryContexts).toHaveLength(3);
});

it("reviews the final answer even when the cadence would skip it", async () => {
	const { primaryContexts } = await runReview({
		closedLoop: true,
		rejected: new Set([0]),
		steps: 3,
		reviewInterval: 5,
	});
	expect(primaryContexts).toHaveLength(5);
	expect(primaryContexts[4]).toContain("answer 0 skips edge case 0");
});

it("calls the advisor once for a multi-step prompt in agent-end mode", async () => {
	const { primaryContexts, advisorCalls } = await runReview({
		closedLoop: true,
		rejected: new Set(),
		steps: 3,
		reviewMode: "agent-end",
	});
	expect(primaryContexts).toHaveLength(4);
	expect(advisorCalls).toBe(1);
});

it("leaves a late concern for the next prompt when the closed loop is off", async () => {
	const { primaryContexts } = await runReview({ closedLoop: false, rejected: new Set([0]) });
	expect(primaryContexts).toHaveLength(2);
	expect(primaryContexts.some(context => context.includes(GUIDANCE))).toBe(false);
});
