import yaml from "js-yaml";
import { normalizeActionList } from "../agents/executor-utils/action-normalization.js";
import { formatStepForPrompt } from "../agents/executor-utils/step-execution.js";
import type { PreviousStepStatus, StepResult } from "../agents/types.js";
import { featureFlags } from "../featureFlags.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePreviousStepStatus(value: unknown): PreviousStepStatus {
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
}

function normalizeShortText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeModelStep(raw: unknown): StepResult {
	if (!isRecord(raw)) {
		return {
			thinking: "",
			previousStepPlanUpdate: [],
			checklistUpdate: undefined,
			previousStepStatus: "none",
			previousStepOutcome: "",
			currentStateObservation: "",
			nextActionRationale: "",
			actions: [],
			done: false,
		};
	}

	const rawActionContext = isRecord(raw.actionContext)
		? raw.actionContext
		: null;
	const parsedActions = normalizeActionList(
		Array.isArray(raw.tools) ? raw.tools : raw.actions,
	);
	const step: StepResult = {
		thinking: typeof raw.thinking === "string" ? raw.thinking : "",
		previousStepPlanUpdate: Array.isArray(raw.previousStepPlanUpdate)
			? (raw.previousStepPlanUpdate as StepResult["previousStepPlanUpdate"])
			: [],
		checklistUpdate:
			raw.checklistUpdate &&
			typeof raw.checklistUpdate === "object" &&
			!Array.isArray(raw.checklistUpdate)
				? (raw.checklistUpdate as StepResult["checklistUpdate"])
				: undefined,
		previousStepStatus: normalizePreviousStepStatus(
			raw.previousStepStatus ?? rawActionContext?.status,
		),
		previousStepOutcome: normalizeShortText(
			raw.previousStepOutcome ?? rawActionContext?.outcome,
		),
		currentStateObservation: normalizeShortText(
			raw.currentStateObservation ?? rawActionContext?.state,
		),
		nextActionRationale: normalizeShortText(
			raw.nextActionRationale ?? rawActionContext?.next,
		),
		actions: parsedActions,
		done: typeof raw.done === "boolean" ? raw.done : false,
	};

	if (typeof raw.result === "string") {
		step.result = raw.result;
	} else if (
		Array.isArray(raw.result) ||
		(raw.result && typeof raw.result === "object")
	) {
		step.result = yaml.dump(raw.result).trim();
	}

	return step;
}

function toAssistantStep(step: StepResult): Record<string, unknown> {
	return formatStepForPrompt(step);
}

export interface ProcessedModelStepOutput {
	step: StepResult;
	assistant: Record<string, unknown>;
}

export function processModelStepOutput(
	rawStepOutput: unknown,
): ProcessedModelStepOutput {
	const step = normalizeModelStep(rawStepOutput);
	return {
		step,
		assistant: toAssistantStep(step),
	};
}
