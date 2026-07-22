import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import {
	appendHistoryWithStrippedPayload,
	buildMaxStepFinalizationMessages,
	buildStepMessages,
	buildStepPayload,
	saveStepContextIfNeeded,
	serializeActionsForPrompt,
	serializeMessagesForDisk,
} from "../src/agents/executor-utils/step-execution.js";
import { PREPARED_MEMORY_CONTEXT_HINT } from "../src/agents/planner.js";
import { close, launch, navigate } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";
import { featureFlags } from "../src/featureFlags.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import type {
	Message,
	ScreenshotToolObservation,
} from "../src/agents/types.js";

function buildObservations(): ScreenshotToolObservation[] {
	return [
		{
			requestedBids: ["10"],
			capturedBids: ["10"],
		},
	];
}

describe("step-execution-messages", () => {
	it("summarizes large action payloads and keeps paste_file by reference", () => {
		const serialized = serializeActionsForPrompt([
			{ type: "type", bid: "12", text: "x".repeat(1200) },
			{
				type: "paste_file",
				bid: "12",
				path: "./extracted.txt",
			},
		]);

		assert.deepEqual(serialized[1], {
			paste_file: {
				bid: "12",
				path: "./extracted.txt",
			},
		});
		assert.deepEqual(serialized[0], {
			type: "12",
			text: '[omitted 1200 characters; starts with "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]',
		});
	});

	it("serializes extract_data roots", () => {
		assert.deepEqual(
			serializeActionsForPrompt([
				{
					type: "extract_data",
					root: "!a,42,!b",
				},
			]),
			[
				{
					extract_data: "!a,42,!b",
				},
			],
		);
	});

	it("serializes whole-context extraction as a bare tool", () => {
		const original = configFeatureFlags.extractDataWholeContext;
		try {
			setConfigFeatureFlags({ extractDataWholeContext: true });
			assert.deepEqual(
				serializeActionsForPrompt([{ type: "extract_data" }]),
				["extract_data"],
			);
		} finally {
			setConfigFeatureFlags({ extractDataWholeContext: original });
		}
	});

	it("preserves explicit return_results items in trajectory messages", () => {
		assert.deepEqual(
			serializeActionsForPrompt([
				{
					type: "return_results",
					results: [
						{
							link: "https://example.com/profile",
							summary: "Verified profile",
						},
					],
				},
			]),
			[
				{
					return_results: [
						{
							link: "https://example.com/profile",
							summary: "Verified profile",
						},
					],
				},
			],
		);
	});

	it("includes screenshot observations in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: buildObservations(),
		});

		assert.deepEqual(payload.screenshotToolObservations, buildObservations());
	});

	it("includes successful website tool results in the executor payload", () => {
		const websiteToolResults = [
			{
				toolName: "find_profile",
				result: {
					profileUrl: "https://example.com/profile",
					profileTitle: "Example Profile",
				},
			},
		];
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: [],
			url: "https://example.com",
			previousInteractionErrors: [],
			websiteToolResults,
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
		});

		assert.deepEqual(payload.websiteToolResults, websiteToolResults);
	});

	it("includes current-page screenshot marker in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
			currentPageScreenshotIncludedAsImagePart: true,
		});

		assert.strictEqual(payload.currentPageScreenshotIncludedAsImagePart, true);
	});

	it("omits validBids from payload and prompt messages", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: 'button bid="a": Go',
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
		});
		const messages = buildStepMessages({
			systemPrompt: "system",
			history: [],
			payload: {
				...payload,
				validBids: ["legacy-bid"],
			},
		});

		assert.notProperty(payload, "validBids");
		assert.notInclude(JSON.stringify(messages), "validBids");
		assert.notInclude(JSON.stringify(messages), "legacy-bid");
		assert.include(JSON.stringify(messages), "button bid=");
		assert.include(JSON.stringify(messages), "Go");
	});

	it("includes tab titles and newly opened tab titles in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			currentTab: 1,
			openTabs: ["Home", "Results"],
			newlyOpenedTabs: ["Results"],
			autoTabSwitchNote: "Auto-switched to first newly opened tab.",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
		});

		assert.strictEqual(payload.currentTab, 1);
		assert.deepEqual(payload.openTabs, ["Home", "Results"]);
		assert.deepEqual(payload.newlyOpenedTabs, ["Results"]);
		assert.strictEqual(
			payload.autoTabSwitchNote,
			"Auto-switched to first newly opened tab.",
		);
	});

	it("includes downloaded files in payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
			downloadedFiles: [
				"/tmp/downloads/file-a.pdf",
				"[NEW] /tmp/downloads/file-b.pdf",
			],
		});

		assert.deepEqual(payload.downloadedFiles, [
			"/tmp/downloads/file-a.pdf",
			"[NEW] /tmp/downloads/file-b.pdf",
		]);
	});

	it("keeps pinned memory hidden until memory_read is pending", () => {
		const originalEnablePlanning = featureFlags.enablePlanning;
		try {
			featureFlags.enablePlanning = true;
			const memoryFile = path.join(
				os.tmpdir(),
				"browser-agent-pinned-memory-test.txt",
			);
			fs.writeFileSync(memoryFile, "scratch note", "utf-8");

			const { payload, pendingMemoryRead } = buildStepPayload({
				task: "task",
				planForPayload: ["step one"],
				url: "https://example.com",
				previousInteractionErrors: [],
				dom: "html",
				pendingMemoryRead: false,
				memoryFile,
				pinnedMemoryContent: "Pinned workspace context",
				screenshotToolObservations: [],
			});

			assert.strictEqual(pendingMemoryRead, false);
			assert.isUndefined(payload.memoryContent);
			assert.strictEqual(payload.memoryAvailable, PREPARED_MEMORY_CONTEXT_HINT);
		} finally {
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("combines pinned memory context with mutable scratchpad after memory_read", () => {
		const memoryFile = path.join(
			os.tmpdir(),
			"browser-agent-pinned-memory-read-test.txt",
		);
		fs.writeFileSync(memoryFile, "scratch note", "utf-8");

		const { payload, pendingMemoryRead } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: true,
			memoryFile,
			pinnedMemoryContent: "Pinned workspace context",
			screenshotToolObservations: [],
		});

		assert.strictEqual(pendingMemoryRead, false);
		assert.strictEqual(
			payload.memoryContent,
			[
				"Runtime-pinned workspace/file context:",
				"Pinned workspace context",
				"",
				"Mutable browser scratchpad:",
				"scratch note",
				"",
				"Extracted page data/result memory:",
				"(empty)",
			].join("\n"),
		);
	});

	it("exposes plain extracted-data memory in memoryContent", () => {
		const memoryFile = path.join(
			os.tmpdir(),
			"browser-agent-memory-result-scratchpad-read-test.txt",
		);
		const extractDataMemoryFile = path.join(
			os.tmpdir(),
			"browser-agent-memory-result-read-test.txt",
		);
		try {
			fs.writeFileSync(memoryFile, "note", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				[
					'- link: "https://example.com/one"',
					'  summary: "One: quoted"',
					"- link: https://example.com/two",
					"  summary: |",
					"    Two",
					"    lines",
				].join("\n"),
				"utf-8",
			);

			const { payload } = buildStepPayload({
				task: "task",
				planForPayload: ["step one"],
				url: "https://example.com",
				previousInteractionErrors: [],
				dom: "html",
				pendingMemoryRead: true,
				memoryFile,
				extractDataMemoryFile,
				screenshotToolObservations: [],
			});

			const content = String(payload.memoryContent);
			assert.include(content, "Extracted page data/result memory:");
			assert.include(content, 'link: "https://example.com/one"');
			assert.include(content, "link: https://example.com/two");
		} finally {
			fs.rmSync(memoryFile, { force: true });
			fs.rmSync(extractDataMemoryFile, { force: true });
		}
	});

	it("builds string content step messages", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: buildObservations(),
		});

		const messages = buildStepMessages({
			systemPrompt: "sys",
			history: [],
			payload,
		});

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(typeof messages[1].content, "string");
		const userPayload = yaml.load(String(messages[1].content)) as Record<
			string,
			unknown
		>;
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		assert.match(
			String(userPayload.currentDateTime),
			/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} .+ \(.+; dd\/mm\/yyyy hh:mm time zone\)$/,
		);
		assert.include(String(userPayload.currentDateTime), timeZone);
	});

	it("includes screenshot signals as image parts in step messages", () => {
		const messages = buildStepMessages({
			systemPrompt: "sys",
			history: [],
			payload: { task: "task", html: "dom" },
			screenshotToolSignalCaptures: [
				{
					callSequence: 1,
					captures: [
						{
							bid: "10",
							imageBase64: Buffer.from("fake-png").toString("base64"),
						},
					],
				},
			],
		});

		assert.strictEqual(messages.length, 2);
		assert.notStrictEqual(typeof messages[1].content, "string");
		const userContent = messages[1].content as Exclude<
			Message["content"],
			string
		>;
		assert.strictEqual(userContent[0].type, "text");
		assert.strictEqual(userContent[1].type, "text");
		assert.strictEqual(userContent[2].type, "text");
		assert.strictEqual(userContent[3].type, "image_url");
		const screenshotPart = userContent[3] as Extract<
			(typeof userContent)[number],
			{ type: "image_url" }
		>;
		assert.strictEqual(
			screenshotPart.image_url.url.startsWith("data:image/png;base64,"),
			true,
		);
	});

	it("includes pre-step screenshot as image part in step messages", () => {
		const messages = buildStepMessages({
			systemPrompt: "sys",
			history: [],
			payload: { task: "task", html: "dom" },
			currentPageScreenshotDataUrl:
				"data:image/jpeg;base64," + Buffer.from("fake-jpeg").toString("base64"),
		});

		assert.strictEqual(messages.length, 2);
		assert.notStrictEqual(typeof messages[1].content, "string");
		const userContent = messages[1].content as Exclude<
			Message["content"],
			string
		>;
		assert.strictEqual(userContent[0].type, "text");
		assert.strictEqual(userContent[1].type, "image_url");
		const screenshotPart = userContent[1] as Extract<
			(typeof userContent)[number],
			{ type: "image_url" }
		>;
		assert.strictEqual(
			screenshotPart.image_url.url.startsWith("data:image/jpeg;base64,"),
			true,
		);
	});

	it("appends the max-step finalization instruction as a trailing user message", () => {
		const messages = buildMaxStepFinalizationMessages({
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "payload" },
			],
			finalizationInstruction: "finalize now",
		});

		assert.lengthOf(messages, 3);
		assert.deepEqual(messages[2], {
			role: "user",
			content: "finalize now",
		});
	});

	it("omits currentStep from payload", () => {
		const { payload } = buildStepPayload({
			task: "task",
			planForPayload: ["step one"],
			url: "https://example.com",
			previousInteractionErrors: [],
			dom: "html",
			pendingMemoryRead: false,
			memoryFile: path.join(os.tmpdir(), "unused-memory.txt"),
			screenshotToolObservations: [],
		});

		assert.strictEqual("currentStep" in payload, false);
	});

	it("strips plan from past-step history payload by default", () => {
		const history: Message[] = [];
		appendHistoryWithStrippedPayload({
			history,
			payload: {
				task: "task",
				plan: ["one", "two"],
				currentURL: "https://example.com",
				html: "dom",
				validBids: ["a"],
				currentTab: 0,
				openTabs: ["Home"],
				newlyOpenedTabs: ["Search"],
				autoTabSwitchNote: "Auto-switched to first newly opened tab.",
				interactionErrors: [],
				currentPageScreenshotIncludedAsImagePart: true,
			},
			step: {
				thinking: "",
				actions: [],
				done: false,
			},
			keepPlanInHistory: false,
		});

		assert.strictEqual(history.length, 2);
		const userMessageContent = history[0].content;
		assert.strictEqual(typeof userMessageContent, "string");
		const parsed = yaml.load(userMessageContent as string) as Record<
			string,
			unknown
		>;
		assert.strictEqual("plan" in parsed, false);
		assert.strictEqual("currentStep" in parsed, false);
		assert.strictEqual("currentTab" in parsed, false);
		assert.strictEqual("openTabs" in parsed, false);
		assert.strictEqual("newlyOpenedTabs" in parsed, false);
		assert.strictEqual("autoTabSwitchNote" in parsed, false);
		assert.strictEqual(
			"currentPageScreenshotIncludedAsImagePart" in parsed,
			false,
		);
		const assistant = yaml.load(String(history[1].content)) as Record<
			string,
			unknown
		>;
		assert.notProperty(assistant, "done");
		assert.notProperty(assistant, "result");
	});

	it("keeps plan in past-step history payload for exceptions", () => {
		const history: Message[] = [];
		appendHistoryWithStrippedPayload({
			history,
			payload: {
				task: "task",
				plan: ["one", "two"],
				currentURL: "https://example.com",
				html: "dom",
				validBids: ["a"],
				currentTab: 0,
				openTabs: ["Home"],
				interactionErrors: [],
			},
			step: {
				thinking: "",
				actions: [],
				done: false,
			},
			keepPlanInHistory: true,
		});

		assert.strictEqual(history.length, 2);
		const userMessageContent = history[0].content;
		assert.strictEqual(typeof userMessageContent, "string");
		const parsed = yaml.load(userMessageContent as string) as Record<
			string,
			unknown
		>;
		assert.strictEqual("plan" in parsed, true);
		assert.strictEqual("currentStep" in parsed, false);
		assert.strictEqual("currentTab" in parsed, false);
		assert.strictEqual("openTabs" in parsed, false);
		const assistant = yaml.load(String(history[1].content)) as Record<
			string,
			unknown
		>;
		assert.notProperty(assistant, "done");
		assert.notProperty(assistant, "result");
	});

	it("preserves image payloads when serializing task step messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,SECRETDATA",
							detail: "auto",
						},
					},
				],
			},
		];

		const serialized = serializeMessagesForDisk(messages);
		const serializedUser = serialized[1] as any;
		assert.strictEqual(
			serializedUser.content[1].image_url.url,
			"data:image/png;base64,SECRETDATA",
		);
	});

	it("always persists reasoning_tokens when serializing", () => {
		const messages = [
			{ role: "system" as const, content: "sys" },
			{ role: "user" as const, content: "user" },
			{
				role: "assistant" as const,
				content: "done: false",
				reasoning_tokens: "chain of thought sample",
			},
		];

		const serialized = serializeMessagesForDisk(messages);
		const serializedSystem = serialized[0] as Record<string, unknown>;
		const serializedUser = serialized[1] as Record<string, unknown>;
		const serializedAssistant = serialized[2] as Record<string, unknown>;
		assert.strictEqual(serializedSystem.reasoning_tokens, "");
		assert.strictEqual(serializedUser.reasoning_tokens, "");
		assert.strictEqual(
			serializedAssistant.reasoning_tokens,
			"chain of thought sample",
		);
	});

	it("redacts context YAML, preserves multiline text, and persists tool screenshots", async () => {
		let browser: Browser | null = null;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-ctx-test-"));
		const contextDir = path.join(tmpDir, "context");
		const stepsDir = path.join(tmpDir, "steps");
		const memoryFile = path.join(tmpDir, "memory.txt");
		const extractDataMemoryFile = path.join(tmpDir, "extract-data-memory.txt");

		try {
			fs.writeFileSync(memoryFile, "pre memory state", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				"pre extract data memory state",
				"utf-8",
			);
			browser = await launch(undefined, true);
			await navigate(browser, "data:text/html,<html><body>ok</body></html>");

			await saveStepContextIfNeeded({
				saveStepsContext: true,
				contextDir,
				stepsDir,
				stepNumber: 1,
				messages: [
					{ role: "system", content: "sys" },
					{
						role: "user",
						content: [
							{ type: "text", text: "line one\nline two" },
							{
								type: "image_url",
								image_url: {
									url: "data:image/png;base64,SECRETDATA",
									detail: "auto",
								},
							},
						],
					},
				],
				simplifiedDom: "dom",
				browser,
				memoryFile,
				extractDataMemoryFile,
				memorySnapshotPhase: "pre-llm",
				toolCallScreenshots: [
					{
						callSequence: 1,
						captures: [
							{
								bid: "12x",
								imageBase64: Buffer.from("fake-png").toString("base64"),
							},
						],
					},
				],
			});

			const contextYaml = fs.readFileSync(
				path.join(contextDir, "context-001.yaml"),
				"utf-8",
			);
			assert(!contextYaml.includes("SECRETDATA"));
			assert(contextYaml.includes("(base64 omitted)"));
			assert(!contextYaml.includes("line one\\nline two"));
			assert(contextYaml.includes("line one\n"));
			assert(contextYaml.includes("line two"));
			const parsed = yaml.load(contextYaml) as Array<{
				content: Array<{ text?: string } | { image_url?: { url?: string } }>;
			}>;
			assert.strictEqual(parsed[1]?.content?.[0]?.text, "line one\nline two");
			const screenshotPath = path.join(
				contextDir,
				"screenshots",
				"step-001",
				"call-01-bid-12x.png",
			);
			assert(
				fs.existsSync(screenshotPath),
				"Expected tool-call screenshot to be saved to disk",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.pre-llm.txt"),
					"utf-8",
				),
				"pre memory state",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.pre-llm.txt"),
					"utf-8",
				),
				"pre extract data memory state",
			);

			fs.writeFileSync(memoryFile, "post memory state", "utf-8");
			fs.writeFileSync(
				extractDataMemoryFile,
				"post extract data memory state",
				"utf-8",
			);
			await saveStepContextIfNeeded({
				saveStepsContext: true,
				contextDir,
				stepsDir,
				stepNumber: 1,
				messages: [],
				simplifiedDom: "updated dom should not overwrite",
				browser,
				memoryFile,
				extractDataMemoryFile,
				memorySnapshotPhase: "post-actions",
				writeCoreFiles: false,
			});
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "memory-001.post-actions.txt"),
					"utf-8",
				),
				"post memory state",
			);
			assert.strictEqual(
				fs.readFileSync(
					path.join(contextDir, "extract-data-memory-001.post-actions.txt"),
					"utf-8",
				),
				"post extract data memory state",
			);
			assert.strictEqual(
				fs.readFileSync(path.join(stepsDir, "step-001.yaml"), "utf-8"),
				"dom",
			);
		} finally {
			if (browser) await close(browser);
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
