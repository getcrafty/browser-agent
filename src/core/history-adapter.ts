import yaml from "js-yaml";
import type { Message, StepResult } from "../agents/types.js";
import { userMessage } from "../agents/providers/router.js";
import { formatStepForPrompt } from "../agents/executor-utils/step-execution.js";
import { normalizeActionList } from "../agents/executor-utils/action-normalization.js";
import type { StepHistoryEntry } from "./types.js";
import { stripDomContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";
import type { PreviousStepStatus } from "../agents/types.js";
import { featureFlags } from "../featureFlags.js";
import {
	shouldIncludeExecutorReasoningHistory,
	type ExecutorPromptOptions,
} from "../agents/prompts.js";

function isStepLikeRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		Object.prototype.hasOwnProperty.call(obj, "thinking") ||
		Object.prototype.hasOwnProperty.call(obj, "previousStepStatus") ||
		Object.prototype.hasOwnProperty.call(obj, "previousStepOutcome") ||
		Object.prototype.hasOwnProperty.call(obj, "currentStateObservation") ||
		Object.prototype.hasOwnProperty.call(obj, "nextActionRationale") ||
		Object.prototype.hasOwnProperty.call(obj, "actionContext") ||
		Object.prototype.hasOwnProperty.call(obj, "tools") ||
		Object.prototype.hasOwnProperty.call(obj, "actions") ||
		Object.prototype.hasOwnProperty.call(obj, "done") ||
		Object.prototype.hasOwnProperty.call(obj, "result") ||
		Object.prototype.hasOwnProperty.call(obj, "previousStepPlanUpdate") ||
		Object.prototype.hasOwnProperty.call(obj, "checklistUpdate")
	);
}

function toCanonicalAssistantContent(assistant: unknown): string {
	if (typeof assistant === "string") {
		return assistant;
	}

	if (!isStepLikeRecord(assistant)) {
		return yaml.dump(assistant);
	}

	const obj = assistant as Record<string, unknown>;
	const actionContext =
		obj.actionContext && typeof obj.actionContext === "object"
			? (obj.actionContext as Record<string, unknown>)
			: null;
	const normalizePreviousStepStatus = (value: unknown): PreviousStepStatus => {
		switch (value) {
			case "none":
			case "progressed":
			case "no_change":
			case "blocked":
			case "opened_tab":
			case "switched_context":
			case "partial":
				return value;
			default:
				return "none";
		}
	};
	const normalizeShortText = (value: unknown): string =>
		typeof value === "string" ? value.trim() : "";
	const step: StepResult = {
		thinking: "",
		previousStepPlanUpdate: [],
		checklistUpdate: undefined,
		previousStepStatus: normalizePreviousStepStatus(
			obj.previousStepStatus ?? actionContext?.status,
		),
		previousStepOutcome: normalizeShortText(
			obj.previousStepOutcome ?? actionContext?.outcome,
		),
		currentStateObservation: normalizeShortText(
			obj.currentStateObservation ?? actionContext?.state,
		),
		nextActionRationale: normalizeShortText(
			obj.nextActionRationale ?? actionContext?.next,
		),
		actions: normalizeActionList(
			Array.isArray(obj.tools) ? obj.tools : obj.actions,
		),
		done: typeof obj.done === "boolean" ? obj.done : false,
	};

	if (Array.isArray(obj.previousStepPlanUpdate)) {
		step.previousStepPlanUpdate = obj.previousStepPlanUpdate as any;
	}
	if (
		obj.checklistUpdate &&
		typeof obj.checklistUpdate === "object" &&
		!Array.isArray(obj.checklistUpdate)
	) {
		step.checklistUpdate = obj.checklistUpdate as any;
	}
	if (typeof obj.result === "string") {
		step.result = obj.result;
	} else if (
		Array.isArray(obj.result) ||
		(obj.result && typeof obj.result === "object")
	) {
		step.result = yaml.dump(obj.result).trim();
	}

	return yaml.dump(formatStepForPrompt(step));
}

function injectReasoningTrace(params: {
	content: string;
	reasoningTokens?: string;
}): string {
	if (!shouldIncludeExecutorReasoningHistory()) {
		return params.content;
	}
	const reasoningTrace = params.reasoningTokens?.trim();
	if (!reasoningTrace) return params.content;
	return `<think>\n${reasoningTrace}\n</think>\n${params.content}`;
}

export function buildHistoryMessagesFromFullStepHistory(
	stepsHistory: StepHistoryEntry[],
	_options: ExecutorPromptOptions = {},
	historyOptions: {
		omitDomContext?: boolean;
	} = {},
): Message[] {
	const messages: Message[] = [];

	for (const step of stepsHistory) {
		const payload = { ...step.payload };
		if (historyOptions.omitDomContext) {
			stripDomContextFromHistoryPayload(payload);
		}
		delete payload.validBids;
		if (!featureFlags.enablePlanning) {
			delete payload.plan;
		}
		messages.push(userMessage(yaml.dump(payload)));
		messages.push({
			role: "assistant",
			content: injectReasoningTrace({
				content: toCanonicalAssistantContent(step.assistant),
				reasoningTokens: step.reasoningTokens,
			}),
		});
	}

	return messages;
}
