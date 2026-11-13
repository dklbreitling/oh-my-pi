import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { canonicalizeMessage } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { isUserTurnInitiator } from "../../session/messages";
import { cfgAdvisorClosedLoop } from "../../advisor/settings";
import { settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";

/**
 * Display side of `advisor.closedLoop`: the interactive transcript shows the
 * settled reply of each user turn and nothing of the review around it. The
 * session, its log, and what the model sees do not change.
 */
export function advisorClosedLoopActive(ctx: { session: AgentSession; viewSession: unknown }): boolean {
	return cfgAdvisorClosedLoop.get(settings) && ctx.viewSession === ctx.session && ctx.session.isAdvisorEnabled();
}

/**
 * A final answer: assistant text with no tool call. The closed loop holds these
 * until the run's review is done; a message with a tool call is a progress
 * update and is drawn when it completes.
 */
export function isFinalAnswer(message: AgentMessage): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		!message.content.some(block => block.type === "toolCall") &&
		message.content.some(block => block.type === "text" && canonicalizeMessage(block.text))
	);
}

/** Whether a message starts a user turn: a prompt the user wrote, or a custom prompt attributed to the user. */
function startsUserTurn(message: AgentMessage): boolean {
	if (message.role === "user") return message.attribution !== "agent" && !message.synthetic;
	return message.role === "custom" && isUserTurnInitiator(message);
}

/**
 * Final answers a replayed transcript draws as nothing: every final answer of a
 * user turn except the last, which replaces them (an advisor revision).
 */
export function closedLoopReplacedAnswers(messages: readonly AgentMessage[]): Set<AgentMessage> {
	const replaced = new Set<AgentMessage>();
	let answers: AgentMessage[] = [];
	for (const message of messages) {
		if (startsUserTurn(message)) {
			for (const answer of answers.slice(0, -1)) replaced.add(answer);
			answers = [];
		} else if (isFinalAnswer(message)) {
			answers.push(message);
		}
	}
	for (const answer of answers.slice(0, -1)) replaced.add(answer);
	return replaced;
}
