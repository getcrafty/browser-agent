import { assert } from "chai";
import { describe, it } from "mocha";
import { stripPayloadForHistory } from "../src/agents/executor-utils/history-payload.js";
import { featureFlags } from "../src/featureFlags.js";
import { buildHistoryMessagesFromFullStepHistory } from "../src/core/history-adapter.js";

describe("history prompt safety", () => {
	it("strips prompt-only payload fields and optionally preserves the plan", () => {
		const payload = {
			task: "Log in safely",
			plan: ["Step 1"],
			currentURL: "https://example.com",
			html: "<div>dom</div>",
			validBids: ["1"],
			interactionErrors: ["x"],
			screenshotToolObservations: ["obs"],
			latestUserPromptTokenCount: 10,
			currentTab: 0,
			openTabs: ["Home"],
			newlyOpenedTabs: ["New"],
			downloadedFiles: ["a.pdf"],
			workspaceFiles: ["./downloads/a.pdf"],
			autoTabSwitchNote: "note",
			currentPageScreenshotIncludedAsImagePart: true,
			previousAction: "click",
			memoryAvailable: "Prepared context is available.",
			memoryContent: "Sensitive scratchpad content",
			authContext: {
				usernameOrEmail: "user@example.com",
			},
		};

		assert.deepEqual(
			stripPayloadForHistory({ payload, keepPlanInHistory: true }),
			{
				plan: ["Step 1"],
				currentURL: "https://example.com",
			},
		);
		assert.deepEqual(
			stripPayloadForHistory({ payload, keepPlanInHistory: false }),
			{
				currentURL: "https://example.com",
			},
		);
	});

	it("retains incremental HTML while stripping sensitive fields", () => {
		const originalIncrementalDomContext = featureFlags.incrementalDomContext;
		featureFlags.incrementalDomContext = true;
		try {
			const stepsHistory = [
				{
					payload: {
						currentURL: "https://example.com/old",
						htmlContextMode: "full",
						html: "old anchor",
					},
					assistant: {},
				},
			];
			const stripped = stripPayloadForHistory({
				payload: {
					task: "task",
					currentURL: "https://example.com/new",
					htmlContextMode: "diff",
					html: "@@ diff",
					memoryContent: "private memory",
					authContext: { usernameOrEmail: "private@example.com" },
				},
				keepPlanInHistory: false,
				incrementalDomContextEnabled: true,
				htmlContextMode: "diff",
				stepsHistory,
			});

			assert.deepEqual(stripped, {
				currentURL: "https://example.com/new",
				htmlContextMode: "diff",
				html: "@@ diff",
			});
			assert.strictEqual(stepsHistory[0].payload.html, "old anchor");
		} finally {
			featureFlags.incrementalDomContext = originalIncrementalDomContext;
		}
	});

	it("canonicalizes history assistant messages for strings, arbitrary objects, and step-like records", () => {
		const originalEnablePlanning = featureFlags.enablePlanning;
		featureFlags.enablePlanning = true;
		try {
			const messages = buildHistoryMessagesFromFullStepHistory([
				{
					payload: {
						currentURL: "https://example.com/login",
					},
					assistant: "plain string assistant",
				},
				{
					payload: {
						currentURL: "https://example.com/form",
					},
					assistant: {
						custom: "object assistant",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/list",
					},
					assistant: ["array assistant"],
				},
				{
					payload: {
						currentURL: "https://example.com/app",
					},
					assistant: {
						thinking: "Continue",
						tools: [{ click: "1" }],
						done: false,
						result: { ok: true },
						previousStepPlanUpdate: ["Updated"],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-tools",
					},
					assistant: {
						tools: [{ click: "3" }],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-actions",
					},
					assistant: {
						actions: [{ type: "click", bid: "4" }],
						done: "not-a-boolean",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-result",
					},
					assistant: {
						result: "Only result",
					},
				},
				{
					payload: {
						currentURL: "https://example.com/only-plan-update",
					},
					assistant: {
						previousStepPlanUpdate: ["Only update"],
					},
				},
				{
					payload: {
						currentURL: "https://example.com/final",
					},
					assistant: {
						thinking: "Done",
						actions: [{ type: "click", bid: "2" }],
						done: true,
						result: "Finished",
					},
				},
			]);

			assert.lengthOf(messages, 18);
			assert.strictEqual(messages[0].role, "user");
			assert.include(String(messages[0].content), "currentURL");
			assert.strictEqual(messages[1].role, "assistant");
			assert.strictEqual(messages[1].content, "plain string assistant");
			assert.strictEqual(messages[3].role, "assistant");
			assert.include(String(messages[3].content), "custom: object assistant");
			assert.strictEqual(messages[5].role, "assistant");
			assert.include(String(messages[5].content), "- array assistant");
			assert.strictEqual(messages[7].role, "assistant");
			assert.include(String(messages[7].content), "Updated");
			assert.notInclude(String(messages[7].content), "ok: true");
			assert.notInclude(String(messages[7].content), "thinking:");
			assert.strictEqual(messages[9].role, "assistant");
			assert.include(String(messages[9].content), "click:");
			assert.notInclude(String(messages[9].content), "type: click");
			assert.strictEqual(messages[11].role, "assistant");
			assert.include(String(messages[11].content), "click:");
			assert.notInclude(String(messages[11].content), "type: click");
			assert.notInclude(String(messages[11].content), "done:");
			assert.strictEqual(messages[13].role, "assistant");
			assert.notInclude(String(messages[13].content), "Only result");
			assert.strictEqual(messages[15].role, "assistant");
			assert.include(String(messages[15].content), "Only update");
			assert.strictEqual(messages[17].role, "assistant");
			assert.notInclude(String(messages[17].content), "Finished");
			assert.include(String(messages[17].content), "click:");
			assert.notInclude(String(messages[17].content), "type: click");
			assert.notInclude(String(messages[17].content), "thinking:");
			assert.notInclude(String(messages[17].content), "done:");
			assert.notInclude(String(messages[17].content), "result:");
		} finally {
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("includes action-context fields in canonicalized assistant messages by default", () => {
		const messages = buildHistoryMessagesFromFullStepHistory([
			{
				payload: {
					currentURL: "https://example.com/final",
				},
				assistant: {
					previousStepStatus: "opened_tab",
					previousStepOutcome: "Opened Gmail sign-in tab.",
					currentStateObservation:
						"Current tab is still the Workspace landing page.",
					nextActionRationale: "Switch to the Gmail tab to continue login.",
					actions: [{ type: "switch_tab", index: 1 }],
					done: false,
				},
			},
		]);
		assert.strictEqual(messages[1].role, "assistant");
		assert.include(
			String(messages[1].content),
			"previousStepStatus: opened_tab",
		);
		assert.include(
			String(messages[1].content),
			"previousStepOutcome: Opened Gmail sign-in tab.",
		);
		assert.include(
			String(messages[1].content),
			"currentStateObservation: Current tab is still the Workspace landing page.",
		);
		assert.include(
			String(messages[1].content),
			"nextActionRationale: Switch to the Gmail tab to continue login.",
		);
		assert.include(String(messages[1].content), "switch_tab: 1");
		assert.notInclude(String(messages[1].content), "thinking:");
		assert.notInclude(String(messages[1].content), "done:");
		assert.notInclude(String(messages[1].content), "result:");
	});

	it("omits legacy thinking fields from canonicalized assistant messages", () => {
		const messages = buildHistoryMessagesFromFullStepHistory([
			{
				payload: {
					currentURL: "https://example.com/final",
				},
				assistant: {
					thinking: "Done",
					previousStepStatus: "progressed",
					previousStepOutcome: "Clicked the result.",
					currentStateObservation: "The result page is open.",
					nextActionRationale: "Read the result page.",
					actions: [{ type: "click", bid: "2" }],
					done: true,
					result: "Finished",
				},
			},
		]);
		assert.strictEqual(messages[1].role, "assistant");
		assert.notInclude(String(messages[1].content), "thinking:");
		assert.include(
			String(messages[1].content),
			"previousStepStatus: progressed",
		);
		assert.include(
			String(messages[1].content),
			"previousStepOutcome: Clicked the result.",
		);
		assert.include(
			String(messages[1].content),
			"currentStateObservation: The result page is open.",
		);
		assert.include(
			String(messages[1].content),
			"nextActionRationale: Read the result page.",
		);
		assert.include(String(messages[1].content), "click:");
		assert.notInclude(String(messages[1].content), "type: click");
		assert.notInclude(String(messages[1].content), "done:");
		assert.notInclude(String(messages[1].content), "result:");
	});

	it("injects reasoning traces only with incremental context", () => {
		const originalIncrementalDomContext = featureFlags.incrementalDomContext;
		featureFlags.incrementalDomContext = false;
		const stepsHistory = [
			{
				payload: { currentURL: "https://example.com/results" },
				assistant: {
					previousStepStatus: "progressed",
					previousStepOutcome: "Loaded results.",
					currentStateObservation: "Results are visible.",
					nextActionRationale: "Inspect the first result.",
					actions: [{ type: "click", bid: "2" }],
					done: false,
				},
				reasoningTokens: "Inspect page:\nstatus: ready",
			},
		];

		try {
			const nonOpenAI = buildHistoryMessagesFromFullStepHistory(stepsHistory, {
				provider: "vllm",
			});
			const nonOpenAIContent = String(nonOpenAI[1].content);
			assert.notInclude(nonOpenAIContent, "<think>");
			assert.notInclude(nonOpenAIContent, "Inspect page:");
			assert.include(nonOpenAIContent, "previousStepStatus: progressed");
			assert.include(nonOpenAIContent, "previousStepOutcome: Loaded results.");
			assert.include(
				nonOpenAIContent,
				"currentStateObservation: Results are visible.",
			);
			assert.include(nonOpenAIContent, "nextActionRationale:");
			assert.include(nonOpenAIContent, "click: '2'");
			assert.notInclude(nonOpenAIContent, "done:");
			assert.notInclude(nonOpenAIContent, "result:");

			const openAI = buildHistoryMessagesFromFullStepHistory(stepsHistory, {
				provider: "openai",
			});
			const openAIContent = String(openAI[1].content);
			assert.notInclude(openAIContent, "<think>");
			assert.notInclude(openAIContent, "Inspect page:");
			assert.include(openAIContent, "previousStepStatus: progressed");
			assert.include(openAIContent, "nextActionRationale:");
			assert.notInclude(openAIContent, "done:");
			assert.notInclude(openAIContent, "result:");

			featureFlags.incrementalDomContext = true;
			const incrementalOpenAI = buildHistoryMessagesFromFullStepHistory(
				stepsHistory,
				{
					provider: "openai",
				},
			);
			const incrementalOpenAIContent = String(incrementalOpenAI[1].content);
			assert.include(
				incrementalOpenAIContent,
				"<think>\nInspect page:\nstatus: ready\n</think>",
			);
			assert.include(
				incrementalOpenAIContent,
				"previousStepStatus: progressed",
			);
		} finally {
			featureFlags.incrementalDomContext = originalIncrementalDomContext;
		}
	});
});
