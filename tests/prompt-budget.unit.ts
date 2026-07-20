import { assert } from "chai";
import { describe, it } from "mocha";
import { buildStepMessages } from "../src/agents/executor-utils/step-execution.js";
import type {
	LLMOptions,
	Message,
	ScreenshotToolCaptureCall,
} from "../src/agents/types.js";
import { fitStepPromptToBudget } from "../src/core/prompt-budget.js";

function estimateTokenCount(text: string): number {
	return text.length;
}

function flattenContentForEstimate(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : "[image]"))
		.join("\n");
}

function estimateMessages(messages: Message[]): number {
	return estimateTokenCount(
		messages
			.map(
				(message) =>
					`${message.role}:\n${flattenContentForEstimate(message.content)}`,
			)
			.join("\n\n"),
	);
}

function makeBudget(maxInputTokens: number): LLMOptions {
	return {
		provider: "openai",
		model: "gpt-test",
		maxModelLen: maxInputTokens + 10,
		reserveOutputTokens: 10,
	};
}

function makeVllmBudget(maxInputTokens: number): LLMOptions {
	return {
		provider: "vllm",
		model: "test-model",
		vllmBaseURL: "http://localhost:8000/v1",
		maxModelLen: maxInputTokens + 10 + 4096,
		reserveOutputTokens: 10,
	};
}

const SCREENSHOT_SIGNAL_CAPTURES: ScreenshotToolCaptureCall[] = [
	{
		callSequence: 1,
		captures: [{ bid: "1", imageBase64: "AAAA" }],
	},
];

describe("prompt-budget", () => {
	it("is a no-op when no prompt budget is configured", () => {
		const result = fitStepPromptToBudget({
			systemPrompt: "SYSTEM",
			history: [
				{ role: "user", content: "history-user" },
				{ role: "assistant", content: "history-assistant" },
			],
			payload: {
				html: "hello",
				currentPageScreenshotIncludedAsImagePart: true,
			},
			buildStepMessages,
			estimateTokenCount,
			screenshotToolSignalCaptures: SCREENSHOT_SIGNAL_CAPTURES,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});

		assert.strictEqual(result.payload.html, "hello");
		assert.strictEqual(
			result.currentPageScreenshotDataUrl,
			"data:image/jpeg;base64,BBBB",
		);
		assert.deepEqual(
			result.screenshotToolSignalCaptures,
			SCREENSHOT_SIGNAL_CAPTURES,
		);
		assert.include(JSON.stringify(result.messages), "history-user");
	});

	it("drops screenshots before trimming history or html", () => {
		const history: Message[] = [
			{ role: "user", content: "history-user" },
			{ role: "assistant", content: "history-assistant" },
		];
		const payload = {
			html: "small-html",
			currentPageScreenshotIncludedAsImagePart: true,
		};
		const fullMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history,
			payload,
			screenshotToolSignalCaptures: SCREENSHOT_SIGNAL_CAPTURES,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});
		const withoutImagesMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history,
			payload: { html: "small-html" },
			screenshotToolSignalCaptures: [],
		});
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(withoutImagesMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
			screenshotToolSignalCaptures: SCREENSHOT_SIGNAL_CAPTURES,
			currentPageScreenshotDataUrl: "data:image/jpeg;base64,BBBB",
		});

		assert.isAbove(
			estimateMessages(fullMessages),
			estimateMessages(withoutImagesMessages),
		);
		assert.strictEqual(result.currentPageScreenshotDataUrl, undefined);
		assert.deepEqual(result.screenshotToolSignalCaptures, []);
		assert.include(JSON.stringify(result.messages), "history-user");
		assert.strictEqual(result.payload.html, "small-html");
		assert.notProperty(
			result.payload,
			"currentPageScreenshotIncludedAsImagePart",
		);
	});

	it("trims oldest history before truncating html", () => {
		const history: Message[] = [
			{ role: "user", content: "history-user-1" },
			{ role: "assistant", content: "history-assistant-1" },
		];
		const payload = {
			html: "html-that-should-stay-intact",
		};
		const withoutHistoryMessages = buildStepMessages({
			systemPrompt: "SYSTEM",
			history: [],
			payload,
		});
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(estimateMessages(withoutHistoryMessages)),
			systemPrompt: "SYSTEM",
			history,
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.strictEqual(result.payload.html, "html-that-should-stay-intact");
		assert.notInclude(JSON.stringify(result.messages), "history-user-1");
	});

	it("truncates html as the final fallback", () => {
		const payload = {
			html: "A".repeat(400),
		};
		const result = fitStepPromptToBudget({
			llmOptions: makeBudget(180),
			systemPrompt: "SYSTEM",
			history: [],
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.isString(result.payload.html);
		assert.notStrictEqual(result.payload.html, payload.html);
		assert.include(
			String(result.payload.html),
			"...[truncated for context budget]...",
		);
	});

	it("applies an extra safety margin for vllm prompt budgets", () => {
		const payload = {
			html: "A".repeat(400),
		};
		const result = fitStepPromptToBudget({
			llmOptions: makeVllmBudget(180),
			systemPrompt: "SYSTEM",
			history: [],
			payload,
			buildStepMessages,
			estimateTokenCount,
		});

		assert.isString(result.payload.html);
		assert.notStrictEqual(result.payload.html, payload.html);
		assert.include(
			String(result.payload.html),
			"...[truncated for context budget]...",
		);
	});
});
