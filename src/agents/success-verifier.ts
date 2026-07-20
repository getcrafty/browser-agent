import yaml from "js-yaml";
import { chatYAML, userMessage } from "./providers/router.js";
import type {
	LLMOptions,
	Message,
	StepResult,
	SuccessVerificationResult,
	SuccessVerificationVerdict,
	StageModelInvocationTrace,
} from "./types.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";

const SUCCESS_VERIFIER_SYSTEM = `You evaluate whether a browser automation run actually succeeded.

Your job is to classify task success, not whether the agent stopped.

You are given:
- the original task
- a lightweight stepHistory showing prior stripped user/assistant exchanges
- the final step emitted by the executor
- the final prompt payload / final browser state

Return success: true ONLY if the original task was fully completed and there is no hard basis to conclude otherwise.

Rules:
- Treat the agent's final "done" flag as only a claim that it stopped, not proof of success.
- Use the original task as the source of truth for required outcomes.
- Defer to the executor's judgment when you do NOT have a hard basis to overrule it.
- Do NOT fail a task merely because the final browser state does not independently prove every earlier intermediate action.
- Do NOT fail a task merely because evidence is limited, as long as it does not contradict the executor's claim and the task did not explicitly require that missing evidence.
- ONLY return success: false when at least one of these is true:
  1. The original task explicitly required specific evidence, data, artifact, or link, and the executor did not provide it.
  2. The supplied evidence directly contradicts the executor's claim.
  3. The executor's own final result or reasoning directly admits the task was not actually completed as required.
- A contradiction can come from the final browser state, downloadedFiles, workspaceFiles, interactionErrors, explicit filenames/links, or the executor's own words.
- If the executor plausibly completed the task and you cannot point to a concrete missing required artifact/evidence or a concrete contradiction, return success: true.

Respond with raw YAML only:
success: false
summary: "Short verdict summary."
reasons:
  - "Specific reason 1"
  - "Specific reason 2"`;

export interface VerifyTaskSuccessInput {
	task: string;
	executedSteps: number;
	maxSteps?: number;
	finalStep: StepResult;
	finalPromptPayload: Record<string, unknown>;
	historyMessages?: Message[];
	llmOptions: LLMOptions;
	caller?: string;
	onTrace?: (trace: StageModelInvocationTrace) => void;
	traceMeta?: Record<string, unknown>;
}

function normalizeReasons(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(entry): entry is string =>
			typeof entry === "string" && entry.trim().length > 0,
	);
}

function normalizeVerdict(
	raw: SuccessVerificationVerdict,
): SuccessVerificationVerdict {
	return {
		success: raw.success === true,
		summary:
			typeof raw.summary === "string" && raw.summary.trim().length > 0
				? raw.summary.trim()
				: raw.success
					? "Task succeeded."
					: "Task failed success verification.",
		reasons: normalizeReasons(raw.reasons),
	};
}

function normalizeMessageContent(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	const textParts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n").trim();
}

function serializeHistoryMessages(messages: Message[] | undefined): Array<{
	role: "user" | "assistant";
	content: string;
}> {
	if (!Array.isArray(messages)) {
		return [];
	}
	return messages
		.filter(
			(message): message is Message & { role: "user" | "assistant" } =>
				message.role === "user" || message.role === "assistant",
		)
		.map((message) => ({
			role: message.role,
			content: normalizeMessageContent(message.content),
		}))
		.filter((message) => message.content.length > 0);
}

export async function verifyTaskSuccess(
	input: VerifyTaskSuccessInput,
): Promise<SuccessVerificationResult> {
	const messages: Message[] = [
		{ role: "system", content: SUCCESS_VERIFIER_SYSTEM },
		userMessage(
			yaml.dump({
				task: input.task,
				executedSteps: input.executedSteps,
				maxSteps: input.maxSteps,
				stepHistory: serializeHistoryMessages(input.historyMessages),
				finalStep: {
					thinking: input.finalStep.thinking,
					previousStepPlanUpdate:
						input.finalStep.previousStepPlanUpdate,
					tools: input.finalStep.actions,
					done: input.finalStep.done,
					result: input.finalStep.result ?? null,
				},
				finalPromptPayload: input.finalPromptPayload,
			}),
		),
	];

	const { data, usage } = await chatYAML<SuccessVerificationVerdict>(
		messages,
		input.llmOptions,
		input.caller ?? "verifyTaskSuccess",
		(trace) =>
			input.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "verifySuccess",
					trace,
					meta: input.traceMeta,
				}),
			),
	);
	const verdict = normalizeVerdict(data);

	return {
		...verdict,
		model: input.llmOptions.model,
		provider: input.llmOptions.provider,
		reasoningEffort: input.llmOptions.reasoningEffort,
		usage,
	};
}
