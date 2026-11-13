import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { closedLoopReplacedAnswers, isFinalAnswer } from "@oh-my-pi/pi-coding-agent/modes/utils/advisor-closed-loop";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function reply(text: string, toolCall = false): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolCall ? [{ type: "toolCall", id: `call-${text}`, name: "step", arguments: {} }] : []),
		],
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function advisorCard(note: string): AgentMessage {
	return {
		role: "custom",
		customType: "advisor",
		content: note,
		display: true,
		attribution: "agent",
		details: { notes: [{ note, severity: "concern" }] },
		timestamp: 0,
	} as AgentMessage;
}

describe("advisor closed loop transcript", () => {
	it("hides every final answer of a user turn but the last, and keeps progress updates", () => {
		const progress = reply("checking the file", true);
		const draft = reply("draft answer");
		const revision = reply("revised answer");
		const second = reply("second turn answer");
		const messages = [user("first"), progress, draft, advisorCard("fix it"), revision, user("second"), second];

		expect([...closedLoopReplacedAnswers(messages)]).toEqual([draft]);
	});

	it("treats only text without a tool call as a final answer", () => {
		expect(isFinalAnswer(reply("done"))).toBe(true);
		expect(isFinalAnswer(reply("working", true))).toBe(false);
		expect(isFinalAnswer(reply("   "))).toBe(false);
	});

	it("does not start a new turn at an agent-attributed user message", () => {
		const draft = reply("draft");
		const revision = reply("revision");
		const redirect = { ...user("advisor redirect"), attribution: "agent" } as AgentMessage;
		expect([...closedLoopReplacedAnswers([user("go"), draft, redirect, revision])]).toEqual([draft]);
	});
});
