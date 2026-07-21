import yaml from "js-yaml";
import type {
	LLMOptions,
	Message,
	ScreenshotToolCaptureCall,
} from "../agents/types.js";
import type { buildStepMessages } from "../agents/executor-utils/step-execution.js";
import { stripDomContextFromHistoryPayload } from "../agents/executor-utils/history-payload.js";

const HTML_TRUNCATION_MARKER = "\n...[truncated for context budget]...\n";
const VLLM_PROMPT_BUDGET_SAFETY_MARGIN_TOKENS = 4096;

export interface FitStepPromptToBudgetInput {
	llmOptions?: LLMOptions;
	systemPrompt: string;
	history: Message[];
	payload: Record<string, unknown>;
	buildStepMessages: typeof buildStepMessages;
	estimateTokenCount: (text: string) => number;
	screenshotToolSignalCaptures?: ScreenshotToolCaptureCall[];
	currentPageScreenshotDataUrl?: string;
	incrementalDomContext?: {
		enabled: boolean;
		canonicalHtml: string;
	};
}

export interface FitStepPromptToBudgetResult {
	messages: Message[];
	payload: Record<string, unknown>;
	screenshotToolSignalCaptures: ScreenshotToolCaptureCall[];
	currentPageScreenshotDataUrl?: string;
}

function getMaxInputTokens(llmOptions?: LLMOptions): number | null {
	if (
		typeof llmOptions?.maxModelLen !== "number" ||
		typeof llmOptions.reserveOutputTokens !== "number"
	) {
		return null;
	}
	const safetyMargin =
		llmOptions.provider === "vllm"
			? VLLM_PROMPT_BUDGET_SAFETY_MARGIN_TOKENS
			: 0;
	return Math.max(
		0,
		llmOptions.maxModelLen - llmOptions.reserveOutputTokens - safetyMargin,
	);
}

function flattenContentForTokenEstimate(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			return "[image]";
		})
		.join("\n");
}

function estimateMessagesTokenCount(
	messages: Message[],
	estimateTokenCount: (text: string) => number,
): number {
	const serialized = messages
		.map(
			(message) =>
				`${message.role}:\n${flattenContentForTokenEstimate(message.content)}`,
		)
		.join("\n\n");
	return estimateTokenCount(serialized);
}

function truncateMiddle(text: string, targetLength: number): string {
	if (targetLength <= 0) return "";
	if (text.length <= targetLength) return text;
	if (targetLength <= HTML_TRUNCATION_MARKER.length) {
		return HTML_TRUNCATION_MARKER.slice(0, targetLength);
	}

	const remaining = targetLength - HTML_TRUNCATION_MARKER.length;
	const headLength = Math.ceil(remaining / 2);
	const tailLength = Math.floor(remaining / 2);
	return (
		text.slice(0, headLength) +
		HTML_TRUNCATION_MARKER +
		text.slice(text.length - tailLength)
	);
}

function withUpdatedHtml(
	payload: Record<string, unknown>,
	html: string,
): Record<string, unknown> {
	return {
		...payload,
		html,
	};
}

function maybeOmitCurrentPageScreenshotFlag(
	payload: Record<string, unknown>,
	currentPageScreenshotDataUrl?: string,
): Record<string, unknown> {
	if (currentPageScreenshotDataUrl) return payload;
	const nextPayload = { ...payload };
	delete nextPayload.currentPageScreenshotIncludedAsImagePart;
	return nextPayload;
}

function stripDomContextFromHistoryMessages(history: Message[]): Message[] {
	return history.map((message) => {
		if (message.role !== "user" || typeof message.content !== "string") {
			return message;
		}
		let parsed: unknown;
		try {
			parsed = yaml.load(message.content);
		} catch {
			return message;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return message;
		}
		const payload = { ...(parsed as Record<string, unknown>) };
		stripDomContextFromHistoryPayload(payload);
		return { ...message, content: yaml.dump(payload) };
	});
}

function buildAndCountMessages(params: {
	systemPrompt: string;
	history: Message[];
	payload: Record<string, unknown>;
	buildStepMessages: typeof buildStepMessages;
	estimateTokenCount: (text: string) => number;
	screenshotToolSignalCaptures: ScreenshotToolCaptureCall[];
	currentPageScreenshotDataUrl?: string;
}): { messages: Message[]; tokenCount: number } {
	const messages = params.buildStepMessages({
		systemPrompt: params.systemPrompt,
		history: params.history,
		payload: params.payload,
		screenshotToolSignalCaptures: params.screenshotToolSignalCaptures,
		currentPageScreenshotDataUrl: params.currentPageScreenshotDataUrl,
	});
	return {
		messages,
		tokenCount: estimateMessagesTokenCount(
			messages,
			params.estimateTokenCount,
		),
	};
}

export function fitStepPromptToBudget(
	input: FitStepPromptToBudgetInput,
): FitStepPromptToBudgetResult {
	const maxInputTokens = getMaxInputTokens(input.llmOptions);
	let payload = { ...input.payload };
	let history = [...input.history];
	let screenshotToolSignalCaptures = [
		...(input.screenshotToolSignalCaptures ?? []),
	];
	let currentPageScreenshotDataUrl = input.currentPageScreenshotDataUrl;

	let built = buildAndCountMessages({
		systemPrompt: input.systemPrompt,
		history,
		payload,
		buildStepMessages: input.buildStepMessages,
		estimateTokenCount: input.estimateTokenCount,
		screenshotToolSignalCaptures,
		currentPageScreenshotDataUrl,
	});

	if (maxInputTokens === null || built.tokenCount <= maxInputTokens) {
		return {
			messages: built.messages,
			payload,
			screenshotToolSignalCaptures,
			currentPageScreenshotDataUrl,
		};
	}

	if (screenshotToolSignalCaptures.length > 0) {
		screenshotToolSignalCaptures = [];
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			screenshotToolSignalCaptures,
			currentPageScreenshotDataUrl,
		});
		if (built.tokenCount <= maxInputTokens) {
			return {
				messages: built.messages,
				payload,
				screenshotToolSignalCaptures,
				currentPageScreenshotDataUrl,
			};
		}
	}

	if (currentPageScreenshotDataUrl) {
		currentPageScreenshotDataUrl = undefined;
		payload = maybeOmitCurrentPageScreenshotFlag(
			payload,
			currentPageScreenshotDataUrl,
		);
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			screenshotToolSignalCaptures,
			currentPageScreenshotDataUrl,
		});
		if (built.tokenCount <= maxInputTokens) {
			return {
				messages: built.messages,
				payload,
				screenshotToolSignalCaptures,
				currentPageScreenshotDataUrl,
			};
		}
	}

	if (
		input.incrementalDomContext?.enabled &&
		payload.htmlContextMode === "diff" &&
		built.tokenCount > maxInputTokens
	) {
		history = stripDomContextFromHistoryMessages(history);
		payload = {
			...payload,
			htmlContextMode: "full",
			html: input.incrementalDomContext.canonicalHtml,
		};
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			screenshotToolSignalCaptures,
			currentPageScreenshotDataUrl,
		});
	}

	while (history.length > 0 && built.tokenCount > maxInputTokens) {
		history = history.slice(Math.min(2, history.length));
		built = buildAndCountMessages({
			systemPrompt: input.systemPrompt,
			history,
			payload,
			buildStepMessages: input.buildStepMessages,
			estimateTokenCount: input.estimateTokenCount,
			screenshotToolSignalCaptures,
			currentPageScreenshotDataUrl,
		});
	}

	const html = typeof payload.html === "string" ? payload.html : "";
	if (built.tokenCount > maxInputTokens && html) {
		let low = 0;
		let high = html.length;
		let bestHtml = "";
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const candidatePayload = withUpdatedHtml(
				payload,
				truncateMiddle(html, mid),
			);
			const candidate = buildAndCountMessages({
				systemPrompt: input.systemPrompt,
				history,
				payload: candidatePayload,
				buildStepMessages: input.buildStepMessages,
				estimateTokenCount: input.estimateTokenCount,
				screenshotToolSignalCaptures,
				currentPageScreenshotDataUrl,
			});
			if (candidate.tokenCount <= maxInputTokens) {
				bestHtml = String(candidatePayload.html ?? "");
				built = candidate;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		payload = withUpdatedHtml(payload, bestHtml);
		if (bestHtml.length === 0) {
			built = buildAndCountMessages({
				systemPrompt: input.systemPrompt,
				history,
				payload,
				buildStepMessages: input.buildStepMessages,
				estimateTokenCount: input.estimateTokenCount,
				screenshotToolSignalCaptures,
				currentPageScreenshotDataUrl,
			});
		}
	}

	return {
		messages: built.messages,
		payload,
		screenshotToolSignalCaptures,
		currentPageScreenshotDataUrl,
	};
}
