import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const PROGRESS = "PROGRESS UPDATE WITH A TOOL CALL";
const DRAFT = "DRAFT ANSWER BEFORE REVIEW";
const SETTLED = "SETTLED ANSWER AFTER REVIEW";
const NOTE = "ADVISOR NOTE TEXT";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function answer(text: string, toolCall = false): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolCall ? [{ type: "toolCall" as const, id: "call-1", name: "step", arguments: {} }] : []),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		stopReason: toolCall ? "toolUse" : "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

const advisorCard: CustomMessage = {
	role: "custom",
	customType: "advisor",
	content: NOTE,
	display: true,
	attribution: "agent",
	details: { notes: [{ note: NOTE, severity: "concern" }] },
	timestamp: 2,
};

function createFixture() {
	const ctx = createInteractiveModeContext({
		session: { isAdvisorEnabled: () => true },
		lastAssistantUsage: zeroUsage(),
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
	return { controller: new EventController(ctx), ctx };
}

async function stream(controller: EventController, message: AssistantMessage): Promise<void> {
	await controller.handleEvent({ type: "message_start", message } as AgentSessionEvent);
	await controller.handleEvent({ type: "message_end", message } as AgentSessionEvent);
}

describe("EventController advisor closed loop", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "display.smoothStreaming": false, "advisor.closedLoop": true },
		});
		vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("shows progress when it completes and only the last final answer after the run ends", async () => {
		const { controller, ctx } = createFixture();
		const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));

		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await stream(controller, answer(PROGRESS, true));
		// A progress update (text with a tool call) appears once complete, before the run ends.
		expect(rendered().split(PROGRESS)).toHaveLength(2);
		await stream(controller, answer(DRAFT));
		await controller.handleEvent({ type: "message_start", message: advisorCard } as AgentSessionEvent);
		await stream(controller, answer(SETTLED));
		// Final answers wait for the end of the run; advisor notes never appear.
		expect(rendered()).not.toContain(DRAFT);
		expect(rendered()).not.toContain(NOTE);
		expect(rendered()).not.toContain(SETTLED);

		await controller.handleEvent({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);

		const settled = rendered();
		expect(settled.split(SETTLED)).toHaveLength(2);
		expect(settled.split(PROGRESS)).toHaveLength(2);
		expect(settled).not.toContain(DRAFT);
		expect(settled).not.toContain(NOTE);
	});

	it("draws answers live when the closed loop is off", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
		const { controller, ctx } = createFixture();

		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await stream(controller, answer(DRAFT));

		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain(DRAFT);
	});
});
