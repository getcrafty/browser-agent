import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";
import { featureFlags } from "../../featureFlags.js";
import { configFeatureFlags } from "../../config-feature-flags.js";
import { getHTML } from "../../browser/browser.js";
import type { Browser } from "../../browser/types.js";
import { userMessage } from "../providers/router.js";
import { PREPARED_MEMORY_CONTEXT_HINT } from "../planner.js";
import { stripPayloadForHistory } from "./history-payload.js";
import { normalizeMemoryContentForRead } from "./memory-file.js";
import type {
	Action,
	ContentPart,
	Message,
	ScreenshotToolCaptureCall,
	ScreenshotToolObservation,
	StepResult,
} from "../types.js";
import type { WebsiteToolResultContext } from "../../website-tools.js";
import type { ValidatorFeedback } from "../../core/types.js";

type MessageWithReasoningTokens = Message & {
	reasoning_tokens?: string;
};

type SerializedMessageForDisk = {
	role: Message["role"];
	content: Message["content"];
	reasoning_tokens: string;
};

function redactContentForDisk(content: Message["content"]): unknown {
	if (typeof content === "string") return content;
	return content.map((part) => {
		if (part.type !== "image_url") return part;
		return {
			type: "image_url",
			image_url: {
				detail: part.image_url.detail || "auto",
				url: "(base64 omitted)",
			},
		};
	});
}

export function serializeMessagesForDisk(
	messages: MessageWithReasoningTokens[],
): SerializedMessageForDisk[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		reasoning_tokens:
			typeof message.reasoning_tokens === "string"
				? message.reasoning_tokens
				: "",
	}));
}

function sanitizeFileFragment(value: string): string {
	const cleaned = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "unknown";
}

function buildUniqueScreenshotPath(
	dir: string,
	callSequence: number,
	bid: string,
): string {
	const callSuffix = String(callSequence).padStart(2, "0");
	const safeBid = sanitizeFileFragment(bid);
	const baseName = `call-${callSuffix}-bid-${safeBid}`;
	let candidate = path.join(dir, `${baseName}.png`);
	let dedupe = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${baseName}-${dedupe}.png`);
		dedupe += 1;
	}
	return candidate;
}

function saveToolCallScreenshots(params: {
	contextDir: string;
	stepId: string;
	toolCallScreenshots: ScreenshotToolCaptureCall[];
}): void {
	if (params.toolCallScreenshots.length === 0) return;

	const stepScreenshotDir = path.join(
		params.contextDir,
		"screenshots",
		`step-${params.stepId}`,
	);
	fs.mkdirSync(stepScreenshotDir, { recursive: true });

	for (const call of params.toolCallScreenshots) {
		for (const capture of call.captures) {
			if (!capture.imageBase64) continue;
			const filePath = buildUniqueScreenshotPath(
				stepScreenshotDir,
				call.callSequence,
				capture.bid,
			);
			try {
				fs.writeFileSync(
					filePath,
					Buffer.from(capture.imageBase64, "base64"),
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				console.warn(
					`[executor] Failed to save screenshot for step ${params.stepId}, call ${call.callSequence}, bid=${capture.bid}: ${message}`,
				);
			}
		}
	}
}

function savePreStepScreenshot(params: {
	contextDir: string;
	stepId: string;
	preStepScreenshotDataUrl: string;
}): void {
	const match = params.preStepScreenshotDataUrl.match(
		/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i,
	);
	if (!match) return;

	const rawFormat = match[1].toLowerCase();
	const base64Payload = match[2];
	const fileExt = rawFormat === "jpeg" ? "jpg" : rawFormat;
	const stepScreenshotDir = path.join(
		params.contextDir,
		"screenshots",
		`step-${params.stepId}`,
	);
	const filePath = path.join(
		stepScreenshotDir,
		`pre-step-current-page.${fileExt}`,
	);

	try {
		fs.mkdirSync(stepScreenshotDir, { recursive: true });
		fs.writeFileSync(filePath, Buffer.from(base64Payload, "base64"));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.warn(
			`[executor] Failed to save pre-step screenshot for step ${params.stepId}: ${message}`,
		);
	}
}

function toDataUrl(base64Png: string): string {
	return `data:image/png;base64,${base64Png}`;
}

function buildScreenshotSignalParts(
	screenshotToolSignalCaptures: ScreenshotToolCaptureCall[],
): ContentPart[] {
	const contentParts: ContentPart[] = [];
	for (const call of screenshotToolSignalCaptures) {
		for (const capture of call.captures) {
			if (!capture.imageBase64) continue;
			contentParts.push({
				type: "text",
				text: `Screenshot signal from previous step (call=${call.callSequence}, bid="${capture.bid}")`,
			});
			contentParts.push({
				type: "image_url",
				image_url: {
					url: toDataUrl(capture.imageBase64),
					detail: "auto",
				},
			});
		}
	}
	return contentParts;
}

export function hasPinnedMemoryContent(
	value: string | undefined,
): value is string {
	return typeof value === "string" && value.length > 0;
}

export function formatMemoryContent(params: {
	pinnedMemoryContent?: string;
	scratchpadContent: string;
	extractDataContent: string;
}): string {
	const sections: string[] = [];
	if (hasPinnedMemoryContent(params.pinnedMemoryContent)) {
		sections.push(
			"Runtime-pinned workspace/file context:",
			params.pinnedMemoryContent,
			"",
		);
	}
	sections.push(
		"Mutable browser scratchpad:",
		params.scratchpadContent || "(empty)",
		"",
		"Extracted page data/result memory:",
		params.extractDataContent || "(empty)",
	);
	return sections.join("\n");
}

function getMemoryAvailableHint(): string {
	if (featureFlags.enablePlanning) {
		return PREPARED_MEMORY_CONTEXT_HINT;
	}
	return "Prepared workspace/file context is available to the executor through memory_read. The executor should call memory_read before searching for, opening, uploading, or reading local/workspace files online.";
}

export function buildStepPayload(params: {
	task: string;
	planForPayload: string[];
	checklistForPayload?: string[];
	url: string;
	previousInteractionErrors: string[];
	previousToolObservations?: string[];
	websiteToolResults?: WebsiteToolResultContext[];
	dom: string;
	currentTab?: number;
	openTabs?: string[];
	newlyOpenedTabs?: string[];
	downloadedFiles?: string[];
	workspaceFiles?: string[];
	authUsernameOrEmail?: string;
	autoTabSwitchNote?: string;
	pendingMemoryRead: boolean;
	forceMemoryContent?: boolean;
	memoryFile: string;
	extractDataMemoryFile?: string;
	pinnedMemoryContent?: string;
	screenshotToolObservations: ScreenshotToolObservation[];
	currentPageScreenshotIncludedAsImagePart?: boolean;
	validatorFeedback?: ValidatorFeedback;
}): { payload: Record<string, unknown>; pendingMemoryRead: boolean } {
	const currentDateTime = new Date().toLocaleDateString("en-GB", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	});
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const payload: Record<string, unknown> = {
		task: params.task,
		currentDateTime: `${currentDateTime} (${timeZone}; dd/mm/yyyy hh:mm time zone)`,
		currentURL: params.url,
		interactionErrors: params.previousInteractionErrors,
		currentTab:
			Number.isInteger(params.currentTab) &&
			(params.currentTab as number) >= 0
				? params.currentTab
				: 0,
		openTabs: Array.isArray(params.openTabs) ? params.openTabs : [],
		downloadedFiles: Array.isArray(params.downloadedFiles)
			? params.downloadedFiles
			: [],
		workspaceFiles: Array.isArray(params.workspaceFiles)
			? params.workspaceFiles
			: [],
		html: params.dom,
	};
	if (params.previousToolObservations?.length) {
		payload.toolObservations = params.previousToolObservations;
	}
	if (params.validatorFeedback) {
		payload.validatorFeedback = params.validatorFeedback;
	}
	if (params.websiteToolResults?.length) {
		payload.websiteToolResults = params.websiteToolResults;
	}
	if (featureFlags.enablePlanning) {
		payload.plan = params.planForPayload;
	}
	if (configFeatureFlags.taskChecklist) {
		payload.checklist = params.checklistForPayload ?? [];
	}
	if (hasPinnedMemoryContent(params.pinnedMemoryContent)) {
		payload.memoryAvailable = getMemoryAvailableHint();
	}
	if (params.authUsernameOrEmail) {
		payload.authContext = {
			usernameOrEmail: params.authUsernameOrEmail,
		};
	}
	if (params.currentPageScreenshotIncludedAsImagePart) {
		payload.currentPageScreenshotIncludedAsImagePart = true;
	}
	if (
		Array.isArray(params.newlyOpenedTabs) &&
		params.newlyOpenedTabs.length > 0
	) {
		payload.newlyOpenedTabs = params.newlyOpenedTabs;
	}
	if (
		typeof params.autoTabSwitchNote === "string" &&
		params.autoTabSwitchNote.trim()
	) {
		payload.autoTabSwitchNote = params.autoTabSwitchNote.trim();
	}
	if (params.screenshotToolObservations.length > 0) {
		payload.screenshotToolObservations = params.screenshotToolObservations;
	}

	let nextPendingMemoryRead = params.pendingMemoryRead;
	if (nextPendingMemoryRead || params.forceMemoryContent) {
		const scratchpadContent = normalizeMemoryContentForRead(
			fs.readFileSync(params.memoryFile, "utf-8"),
		);
		const extractDataContent = params.extractDataMemoryFile
			? normalizeMemoryContentForRead(
					fs.readFileSync(params.extractDataMemoryFile, "utf-8"),
				)
			: "";
		payload.memoryContent = formatMemoryContent({
			pinnedMemoryContent: params.pinnedMemoryContent,
			scratchpadContent,
			extractDataContent,
		});
		if (nextPendingMemoryRead) {
			nextPendingMemoryRead = false;
		}
	}

	return { payload, pendingMemoryRead: nextPendingMemoryRead };
}

export function buildStepMessages(params: {
	systemPrompt: string;
	history: Message[];
	payload: Record<string, unknown>;
	screenshotToolSignalCaptures?: ScreenshotToolCaptureCall[];
	currentPageScreenshotDataUrl?: string;
}): Message[] {
	const payload = { ...params.payload };
	delete payload.validBids;
	const payloadText = yaml.dump(payload);
	const contentParts: ContentPart[] = [
		{ type: "text", text: payloadText },
	];

	if (params.currentPageScreenshotDataUrl) {
		contentParts.push({
			type: "image_url",
			image_url: {
				url: params.currentPageScreenshotDataUrl,
				detail: "low",
			},
		});
	}

	const screenshotSignalParts = buildScreenshotSignalParts(
		params.screenshotToolSignalCaptures || [],
	);
	if (screenshotSignalParts.length > 0) {
		contentParts.push({
			type: "text",
			text: "Screenshot signal(s) from the previous step are attached below as conditional visual context. Use them only when relevant.",
		});
		contentParts.push(...screenshotSignalParts);
	}

	const currentMsg =
		contentParts.length === 1
			? userMessage(payloadText)
			: userMessage(contentParts);
	return [
		{ role: "system", content: params.systemPrompt },
		...params.history,
		currentMsg,
	];
}

export function buildMaxStepFinalizationMessages(params: {
	messages: Message[];
	finalizationInstruction: string;
}): Message[] {
	return [...params.messages, userMessage(params.finalizationInstruction)];
}

function saveMemorySnapshot(params: {
	sourceFile?: string;
	snapshotFile: string;
	stepId: string;
	phase: "pre-llm" | "post-actions";
	label: string;
}): void {
	let memoryContent = "";
	if (params.sourceFile) {
		try {
			if (fs.existsSync(params.sourceFile)) {
				memoryContent = fs.readFileSync(params.sourceFile, "utf-8");
			} else {
				console.warn(
					`[executor] ${params.label} memory file missing for step ${params.stepId} ${params.phase} snapshot: ${params.sourceFile}`,
				);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.warn(
				`[executor] Failed to read ${params.label} memory file for step ${params.stepId} ${params.phase} snapshot: ${message}`,
			);
		}
	}
	fs.writeFileSync(params.snapshotFile, memoryContent, "utf-8");
}

export async function saveStepContextIfNeeded(params: {
	saveStepsContext: boolean;
	contextDir: string;
	stepsDir: string;
	stepNumber: number;
	messages: Message[];
	simplifiedDom: string;
	browser: Browser;
	memoryFile?: string;
	extractDataMemoryFile?: string;
	memorySnapshotPhase?: "pre-llm" | "post-actions";
	toolCallScreenshots?: ScreenshotToolCaptureCall[];
	preStepScreenshotDataUrl?: string;
	writeCoreFiles?: boolean;
}): Promise<void> {
	if (!params.saveStepsContext) return;

	const stepId = String(params.stepNumber).padStart(3, "0");
	fs.mkdirSync(params.contextDir, { recursive: true });
	fs.mkdirSync(params.stepsDir, { recursive: true });

	const contextFile = path.join(
		params.contextDir,
		`context-${stepId}.yaml`,
	);
	const stepYamlFile = path.join(params.stepsDir, `step-${stepId}.yaml`);
	const rawHtmlFile = path.join(
		params.contextDir,
		`raw-html-${stepId}.html`,
	);
	const memorySnapshotFile = params.memorySnapshotPhase
		? path.join(
				params.contextDir,
				`memory-${stepId}.${params.memorySnapshotPhase}.txt`,
			)
		: null;
	const extractDataMemorySnapshotFile = params.memorySnapshotPhase
		? path.join(
				params.contextDir,
				`extract-data-memory-${stepId}.${params.memorySnapshotPhase}.txt`,
			)
		: null;

	const contextDump = params.messages.map((m) => ({
		role: m.role,
		content: redactContentForDisk(m.content),
	}));

	if (params.writeCoreFiles !== false) {
		fs.writeFileSync(
			contextFile,
			yaml.dump(contextDump, {
				lineWidth: -1,
				noRefs: true,
			}),
			"utf-8",
		);
		fs.writeFileSync(stepYamlFile, params.simplifiedDom, "utf-8");

		try {
			const rawHtml = await getHTML(params.browser);
			fs.writeFileSync(rawHtmlFile, rawHtml, "utf-8");
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.warn(
				`[executor] Failed to save raw HTML for step ${stepId}: ${message}`,
			);
		}
	}

	if (memorySnapshotFile) {
		saveMemorySnapshot({
			sourceFile: params.memoryFile,
			snapshotFile: memorySnapshotFile,
			stepId,
			phase: params.memorySnapshotPhase!,
			label: "Scratchpad",
		});
	}

	if (extractDataMemorySnapshotFile) {
		saveMemorySnapshot({
			sourceFile: params.extractDataMemoryFile,
			snapshotFile: extractDataMemorySnapshotFile,
			stepId,
			phase: params.memorySnapshotPhase!,
			label: "Extract-data",
		});
	}

	if (params.preStepScreenshotDataUrl) {
		savePreStepScreenshot({
			contextDir: params.contextDir,
			stepId,
			preStepScreenshotDataUrl: params.preStepScreenshotDataUrl,
		});
	}

	saveToolCallScreenshots({
		contextDir: params.contextDir,
		stepId,
		toolCallScreenshots: params.toolCallScreenshots || [],
	});
}

export function logStepModelResponse(params: {
	stepNumber: number;
	planForPayload: string[];
	step: StepResult;
	totalTokens: number;
}): void {
	console.log(
		`\n\n  [step ${params.stepNumber}] tools=${params.step.actions.length} | tokens=${params.totalTokens}`,
	);
	if (featureFlags.enablePlanning) {
		console.log("    plan:");
		for (const planItem of params.planForPayload) {
			console.log(`      - ${planItem}`);
		}
	}
	logStepActionContext(params.step);
}

export function logStepActionContext(step: StepResult): void {
	if (step.previousStepStatus !== "none") {
		console.log(`    previousStepStatus: ${step.previousStepStatus}`);
	}
	if (step.previousStepOutcome) {
		console.log(`    previousStepOutcome: ${step.previousStepOutcome}`);
	}
	if (step.currentStateObservation) {
		console.log(
			`    currentStateObservation: ${step.currentStateObservation}`,
		);
	}
	if (step.nextActionRationale) {
		console.log(`    nextActionRationale: ${step.nextActionRationale}`);
	}
}

export function serializeActionsForPrompt(
	actions: Action[],
): Array<string | Record<string, unknown>> {
	const summarizeLargeText = (value: string) => {
		const maxChars = 500;
		if (value.length <= maxChars) {
			return value;
		}
		return `[omitted ${value.length} characters; starts with ${JSON.stringify(value.slice(0, 120))}]`;
	};
	return actions.map((action) => {
		switch (action.type) {
			case "click":
				return { click: action.bid };
			case "long_press":
				return {
					long_press: {
						bid: action.bid,
						...(typeof action.durationMs === "number"
							? { durationMs: action.durationMs }
							: {}),
					},
				};
			case "type":
				return {
					type: action.bid,
					text: summarizeLargeText(action.text),
					...(typeof action.enter === "boolean"
						? { enter: action.enter }
						: {}),
				};
			case "scroll":
				return {
					scroll: {
						bid: action.bid,
						...(typeof action.deltaX === "number"
							? { deltaX: action.deltaX }
							: {}),
						...(typeof action.deltaY === "number"
							? { deltaY: action.deltaY }
							: {}),
					},
				};
			case "evaluate":
				return {
					evaluate: { script: summarizeLargeText(action.script) },
				};
			case "dropdown_select":
				return {
					dropdown_select: {
						bid: action.bid,
						value: action.value,
					},
				};
			case "prune":
				return { prune: { bids: action.bids } };
			case "unprune":
				return "unprune";
			case "navigate":
				return { navigate: action.url };
			case "switch_tab":
				return { switch_tab: action.index };
			case "wait":
				return { wait: action.ms };
			case "download_current_file":
				return "download_current_file";
			case "upload_files":
				return {
					upload_files: {
						bid: action.bid,
						paths: action.paths,
					},
				};
			case "paste_file":
				return {
					paste_file: {
						bid: action.bid,
						path: action.path,
					},
				};
			case "user_takeover":
				return {
					user_takeover: {
						...(typeof action.category === "string"
							? { category: action.category }
							: {}),
						request: action.reason,
					},
				};
			case "memory_write":
				return { memory_write: summarizeLargeText(action.content) };
			case "memory_read":
				return "memory_read";
			case "read_file":
				return { read_file: { path: action.path } };
			case "return_results":
				return action.results
					? { return_results: action.results }
					: "return_results";
			case "memory_clear":
				return { memory_clear: action.target };
			case "extract_data":
				return configFeatureFlags.extractDataWholeContext ||
					!action.root
					? "extract_data"
					: { extract_data: action.root };
			case "agent_takeover":
				return { agent_takeover: { request: action.request } };
			case "website_tool":
				return {
					website_tool: {
						name: action.name,
						inputs: action.inputs,
					},
				};
			case "regenerate_plan":
				return "regenerate_plan";
		}
	});
}

export function formatStepForPrompt(step: StepResult): Record<string, unknown> {
	const formatted: Record<string, unknown> = {};
	if (featureFlags.enablePlanning) {
		formatted.previousStepPlanUpdate = step.previousStepPlanUpdate;
	}
	if (
		configFeatureFlags.taskChecklist &&
		step.checklistUpdate &&
		Object.keys(step.checklistUpdate).length > 0
	) {
		formatted.checklistUpdate = step.checklistUpdate;
	}
	formatted.previousStepStatus = step.previousStepStatus;
	formatted.previousStepOutcome = step.previousStepOutcome;
	formatted.currentStateObservation = step.currentStateObservation;
	formatted.nextActionRationale = step.nextActionRationale;
	formatted.tools = serializeActionsForPrompt(step.actions);
	return formatted;
}

export function appendHistoryWithStrippedPayload(params: {
	history: Message[];
	payload: Record<string, unknown>;
	step: StepResult;
	keepPlanInHistory: boolean;
}): void {
	const strippedPayload = stripPayloadForHistory({
		payload: params.payload,
		keepPlanInHistory: params.keepPlanInHistory,
	});
	params.history.push(userMessage(yaml.dump(strippedPayload)));
	params.history.push({
		role: "assistant",
		content: yaml.dump(formatStepForPrompt(params.step)),
	});
}
