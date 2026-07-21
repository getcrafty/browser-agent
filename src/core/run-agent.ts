import * as fs from "fs";
import yaml from "js-yaml";
import { MAX_STEPS } from "../agents/constants.js";
import { MAX_STEP_FINALIZATION_INSTRUCTION } from "../agents/prompts.js";
import { chatYAML } from "../agents/providers/router.js";
import type {
	ChatJSONResult,
	MainLoopStepEntry,
	Message,
	StepResult as ModelStepResult,
	StepTokenUsage,
	TokenUsage,
} from "../agents/types.js";
import { getDefaultBrowserAgentArtifactDirectories } from "../browser/constants.js";
import { createSessionAuthTakeoverState } from "../auth/crypto.js";
import {
	formatStepForPrompt,
	logStepActionContext,
	logStepModelResponse,
	saveStepContextIfNeeded,
	serializeMessagesForDisk,
} from "../agents/executor-utils/step-execution.js";
import { featureFlags } from "../featureFlags.js";
import { configFeatureFlags } from "../config-feature-flags.js";
import { shouldSaveStepsContext } from "../runtime-options.js";
import { createDefaultCoreDeps } from "./deps.js";
import {
	MAX_STEP_RETRIES,
	ReplanReason,
	STAGNATION_NO_PROGRESS_THRESHOLD,
	STAGNATION_SAME_ACTION_THRESHOLD,
	buildActionSignatureWithUrl,
	buildProgressSignature,
	formatPlanWithStatuses,
	getReplanReason,
	type PlanProgressStatus,
	type StepExecutionSnapshot,
} from "./run-agent-loop-state.js";
import { closeSession, createSession } from "./session.js";
import { preprocessTask } from "./preprocess-task.js";
import { processModelStepOutput } from "./process-model-step-output.js";
import {
	createPromptForStep,
	processModelOutputAndBrowse,
	processStepModelOutput,
} from "./step.js";
import type {
	CoreDeps,
	RunAgentGenerateStep,
	RunAgentInput,
	RunAgentResult,
	RunAgentStepArtifact,
	RunAgentTokenTotals,
	StepHistoryEntry,
	StepRuntimeMetrics,
	ValidatorFeedback,
	ValidatorLifecycleOptions,
} from "./types.js";
import type { BrowserSession } from "./session-registry.js";
import type { UserTakeoverCategory } from "../user-action-types.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import {
	DEFAULT_EXECUTOR_STEP_DELAY_MS,
	canSkipExecutorStepDelay,
} from "./executor-step-delay.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_VALIDATOR_LIFECYCLE: ValidatorLifecycleOptions = {
	mode: "terminal",
	maxFailures: 3,
};

function resolveValidatorLifecycle(
	value: RunAgentInput["validatorLifecycle"],
): ValidatorLifecycleOptions {
	if (!value) return DEFAULT_VALIDATOR_LIFECYCLE;
	if (
		(value.mode !== "terminal" && value.mode !== "retry") ||
		!Number.isInteger(value.maxFailures) ||
		value.maxFailures < 1 ||
		value.maxFailures > 3
	) {
		throw new Error(
			"validatorLifecycle must use mode terminal|retry and maxFailures between 1 and 3.",
		);
	}
	return value;
}

function truncateFeedbackText(value: string, maxChars: number): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()}… [truncated]`;
}

function buildValidatorFeedback(params: {
	failure: number;
	maxFailures: number;
	verification: NonNullable<RunAgentResult["successVerification"]>;
}): ValidatorFeedback {
	return {
		failure: params.failure,
		maxFailures: params.maxFailures,
		summary: truncateFeedbackText(params.verification.summary, 500),
		reasons: params.verification.reasons
			.slice(0, 3)
			.map((reason) => truncateFeedbackText(reason, 400)),
		instruction:
			"The validator rejected the attempted final result. Continue the task, address each concrete issue using browser or file evidence, then return a corrected result. Do not merely restate the rejected answer.",
	};
}

function sumTokenUsage(usages: TokenUsage[]): RunAgentTokenTotals {
	return usages.reduce<RunAgentTokenTotals>(
		(acc, usage) => ({
			input_tokens: acc.input_tokens + usage.input_tokens,
			cached_input_tokens:
				acc.cached_input_tokens + (usage.cached_input_tokens ?? 0),
			output_tokens: acc.output_tokens + usage.output_tokens,
			total_tokens: acc.total_tokens + usage.total_tokens,
		}),
		{
			input_tokens: 0,
			cached_input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		},
	);
}

function buildStepTokenUsage(step: number, usage?: TokenUsage): StepTokenUsage {
	const result: StepTokenUsage = {
		step,
		input_tokens: usage?.input_tokens ?? 0,
		cached_input_tokens: usage?.cached_input_tokens ?? 0,
		output_tokens: usage?.output_tokens ?? 0,
		total_tokens: usage?.total_tokens ?? 0,
	};
	if (
		usage &&
		("reasoning_tokens" in usage || "non_reasoning_output_tokens" in usage)
	) {
		result.reasoning_tokens = usage.reasoning_tokens;
		result.non_reasoning_output_tokens = usage.non_reasoning_output_tokens;
	}
	return result;
}

function isCoreDeps(value: unknown): value is CoreDeps {
	if (!value || typeof value !== "object") {
		return false;
	}
	return (
		"registry" in value &&
		"launchBrowser" in value &&
		"featureFlags" in value
	);
}

class RunAgentAbortError extends Error {
	constructor(reason?: unknown) {
		super(
			reason instanceof Error
				? reason.message
				: "Browser agent run cancelled.",
		);
		this.name = "AbortError";
	}
}

function createRunAgentAbortError(signal?: AbortSignal) {
	return new RunAgentAbortError(signal?.reason);
}

function isAbortError(error: unknown) {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.message === "Browser agent run cancelled.")
	);
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw createRunAgentAbortError(signal);
	}
}

async function withAbort<T>(
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	throwIfAborted(signal);
	const operation = run();
	if (!signal) {
		return await operation;
	}
	let handleAbort: (() => void) | null = null;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				handleAbort = () => reject(createRunAgentAbortError(signal));
				signal.addEventListener("abort", handleAbort, { once: true });
			}),
		]);
	} finally {
		if (handleAbort) {
			signal.removeEventListener("abort", handleAbort);
		}
	}
}

function createDefaultGenerateStep(): RunAgentGenerateStep {
	return async ({
		stepNumber,
		messages,
		llmOptions,
		caller,
		abortSignal,
	}): Promise<ChatJSONResult<ModelStepResult>> =>
		await chatYAML<ModelStepResult>(
			messages,
			llmOptions,
			caller ?? `runAgent:step${stepNumber}`,
			undefined,
			abortSignal,
		);
}

function redactMessageContentForDisk(content: Message["content"]): unknown {
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

function serializeStepContextForDisk(
	messages: Message[],
): RunAgentStepArtifact["contextJson"] {
	return messages.map((message) => ({
		role: message.role,
		content: redactMessageContentForDisk(message.content),
	}));
}

function isSerializableAuthMessage(value: unknown): value is {
	role: "system" | "user" | "assistant";
	content: string | Message["content"];
	reasoning_tokens?: string;
} {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const role = record.role;
	if (role !== "system" && role !== "user" && role !== "assistant") {
		return false;
	}
	const content = record.content;
	if (typeof content === "string") return true;
	if (!Array.isArray(content)) return false;
	return content.every((part) => {
		if (!part || typeof part !== "object") return false;
		const contentPart = part as Record<string, unknown>;
		if (contentPart.type === "text") {
			return typeof contentPart.text === "string";
		}
		if (contentPart.type === "image_url") {
			if (
				!contentPart.image_url ||
				typeof contentPart.image_url !== "object"
			) {
				return false;
			}
			const imageUrl = contentPart.image_url as Record<string, unknown>;
			return typeof imageUrl.url === "string";
		}
		return false;
	});
}

function serializeAuthAttemptMessages(
	messages: unknown[] | undefined,
): unknown[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return [];
	}
	return serializeMessagesForDisk(messages.filter(isSerializableAuthMessage));
}

interface StepPartTimingEntry {
	part: string;
	durationMs: number;
}

async function measureStepPart<T>(params: {
	timings: StepPartTimingEntry[];
	part: string;
	run: () => T | Promise<T>;
}): Promise<T> {
	const startedAt = Date.now();
	try {
		return await params.run();
	} finally {
		params.timings.push({
			part: params.part,
			durationMs: Date.now() - startedAt,
		});
	}
}

const BROWSER_INTERACTION_TIMING_PARTS = new Set([
	"process_model_output_and_browse",
	"process_step_model_output",
	"wait_for_settle",
]);

function computeStepTimingSplit(params: {
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): Pick<StepRuntimeMetrics, "tokenGenerationMs" | "browserInteractionMs"> {
	const sumParts = (parts: Set<string>) =>
		params.timings.reduce(
			(total, entry) =>
				parts.has(entry.part) ? total + entry.durationMs : total,
			0,
		);
	const llmDecisionMs = sumParts(new Set(["llm_step_call"]));
	const browserInteractionMs = sumParts(BROWSER_INTERACTION_TIMING_PARTS);
	const tokenGenerationMs =
		typeof params.usage?.generation_time_ms === "number"
			? params.usage.generation_time_ms
			: llmDecisionMs;
	return { tokenGenerationMs, browserInteractionMs };
}

function logStepPartTimings(params: {
	stepNumber: number;
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): void {
	if (!shouldLogTimingDuration(params.totalDurationMs)) return;
	const { tokenGenerationMs, browserInteractionMs } =
		computeStepTimingSplit(params);
	const stateExtractionMs = Math.max(
		0,
		params.totalDurationMs - tokenGenerationMs - browserInteractionMs,
	);
	const parts = params.timings.map(
		(entry) => `${entry.part}=${entry.durationMs}ms`,
	);
	parts.push(`total=${params.totalDurationMs}ms`);
	console.log(`  [step ${params.stepNumber} timings] ${parts.join(" | ")}`);
	console.log(
		`  [step ${params.stepNumber} timing-split] state_extraction_ms=${stateExtractionMs} | llm_decision_ms=${tokenGenerationMs} | tool_execution_ms=${browserInteractionMs}`,
	);
}

function recordStepRuntimeMetrics(params: {
	stepRuntimeMetrics: StepRuntimeMetrics[];
	stepNumber: number;
	timings: StepPartTimingEntry[];
	totalDurationMs: number;
	usage?: TokenUsage;
}): void {
	const split = computeStepTimingSplit({
		timings: params.timings,
		totalDurationMs: params.totalDurationMs,
		usage: params.usage,
	});
	params.stepRuntimeMetrics.push({
		stepNumber: params.stepNumber,
		totalDurationMs: params.totalDurationMs,
		tokenGenerationMs: split.tokenGenerationMs,
		browserInteractionMs: split.browserInteractionMs,
	});
	logStepPartTimings({
		stepNumber: params.stepNumber,
		timings: params.timings,
		totalDurationMs: params.totalDurationMs,
		usage: params.usage,
	});
}

function emitStagnationWarning(
	session: BrowserSession,
	stepNumber: number,
): void {
	if (
		session.sameActionSignatureStreak !==
			STAGNATION_SAME_ACTION_THRESHOLD &&
		session.noProgressStreak !== STAGNATION_NO_PROGRESS_THRESHOLD
	) {
		return;
	}
	console.warn(
		JSON.stringify({
			event: "browser_agent.stagnation_detected",
			timestamp: new Date().toISOString(),
			level: "warning",
			payload: {
				step: stepNumber,
				same_action_signature_streak: session.sameActionSignatureStreak,
				no_progress_streak: session.noProgressStreak,
				thresholds: {
					same_action_signature: STAGNATION_SAME_ACTION_THRESHOLD,
					no_progress: STAGNATION_NO_PROGRESS_THRESHOLD,
				},
			},
		}),
	);
}

function authProtectedDomOptions(session: BrowserSession): {
	redactInputBids?: string[];
	redactPasswordInputs?: boolean;
} {
	if (
		!session.authTakeover ||
		session.authTakeover.protectedBids.size === 0
	) {
		return {};
	}
	return {
		redactInputBids: [...session.authTakeover.protectedBids],
		redactPasswordInputs: true,
	};
}

async function replanFromCurrentDom(params: {
	deps: CoreDeps;
	session: BrowserSession;
	task: string;
	stepNumber: number;
	reason: ReplanReason;
	createPlanLLMOptions: RunAgentInput["stageLLMs"]["createPlan"];
	recordModelInvocation?: RunAgentInput["recordModelInvocation"];
}): Promise<void> {
	if (params.reason === "model_requested") {
		console.log(
			`  [step ${params.stepNumber}] regenerate_plan requested by model. Replanning...`,
		);
	} else {
		console.log(
			`  [step ${params.stepNumber}] Detected repeated identical tool calls with no progress. Replanning...`,
		);
	}

	const replanningDom = await params.deps.getSimplifiedDOM(
		params.session.browser,
		authProtectedDomOptions(params.session),
	);
	const currentUrl = await params.deps.getCurrentURL(params.session.browser);
	const replanned = await params.deps.createPlan(
		params.task,
		replanningDom,
		params.createPlanLLMOptions,
		{
			onTrace: params.recordModelInvocation,
			meta: {
				phase: "replan",
				reason: params.reason,
				stepNumber: params.stepNumber,
			},
		},
		{
			memoryAvailable:
				typeof params.session.pinnedMemoryContent === "string",
			preparedPasteFiles: params.session.preparedPasteFiles,
			currentUrl,
			agentTakeoverAvailable:
				params.deps.featureFlags.agentTakeoverTool === true,
			activeWebsiteToolGuidance: params.session.activeWebsiteToolGuidance,
		},
	);
	if (replanned.steps.length === 0) {
		console.log(
			"  [replan] Planner returned an empty plan, keeping current plan.",
		);
		return;
	}
	params.session.activePlan = [...replanned.steps];
	params.session.planStatuses = replanned.steps.map(
		(): PlanProgressStatus => "TODO",
	);
	params.session.keepPlanInHistory = true;
	params.session.recentExecutions = [];
	console.log(
		`  [replan] New plan (${params.session.activePlan.length} steps):`,
	);
	params.session.activePlan.forEach((step, index) =>
		console.log(`    ${index + 1}. ${step}`),
	);
}

interface SessionSnapshot {
	activePlan: string[];
	planStatuses: PlanProgressStatus[];
	keepPlanInHistory: boolean;
	recentExecutions: StepExecutionSnapshot[];
	lastTask: string | null;
	pendingMemoryRead: boolean;
	previousInteractionErrors: string[];
	previousToolObservations: string[];
	previousStepTabs: BrowserSession["previousStepTabs"];
	downloadedFileSignatures: BrowserSession["downloadedFileSignatures"];
	downloadedNewFilePaths: Set<string>;
	screenshotToolObservations: BrowserSession["screenshotToolObservations"];
	screenshotToolSignalCaptures: BrowserSession["screenshotToolSignalCaptures"];
	excludedWebsiteToolNames: Set<string>;
	activeWebsiteToolGuidance?: BrowserSession["activeWebsiteToolGuidance"];
	websiteToolResults: BrowserSession["websiteToolResults"];
	lastActionSignatureWithUrl: string | null;
	lastProgressSignature: string | null;
	sameActionSignatureStreak: number;
	noProgressStreak: number;
	incrementalDomContext: BrowserSession["incrementalDomContext"];
	dataExtractionCheckpoint: ReturnType<
		BrowserSession["dataExtractionCoordinator"]["checkpoint"]
	>;
	memoryFileContents: string;
	extractDataMemoryFileContents: string;
}

function cloneDownloadedFileSignatures(
	value: BrowserSession["downloadedFileSignatures"],
): BrowserSession["downloadedFileSignatures"] {
	return value ? new Map(value) : null;
}

function snapshotSession(session: BrowserSession): SessionSnapshot {
	return {
		activePlan: [...session.activePlan],
		planStatuses: [...session.planStatuses],
		keepPlanInHistory: session.keepPlanInHistory,
		recentExecutions: session.recentExecutions.map((entry) => ({
			...entry,
		})),
		lastTask: session.lastTask,
		pendingMemoryRead: session.pendingMemoryRead,
		previousInteractionErrors: [...session.previousInteractionErrors],
		previousToolObservations: [...session.previousToolObservations],
		previousStepTabs: session.previousStepTabs
			? session.previousStepTabs.map((tab) => ({ ...tab }))
			: null,
		downloadedFileSignatures: cloneDownloadedFileSignatures(
			session.downloadedFileSignatures,
		),
		downloadedNewFilePaths: new Set(session.downloadedNewFilePaths),
		screenshotToolObservations: [...session.screenshotToolObservations],
		screenshotToolSignalCaptures: [...session.screenshotToolSignalCaptures],
		excludedWebsiteToolNames: new Set(session.excludedWebsiteToolNames),
		activeWebsiteToolGuidance: session.activeWebsiteToolGuidance
			? { ...session.activeWebsiteToolGuidance }
			: undefined,
		websiteToolResults: session.websiteToolResults.map((entry) => ({
			...entry,
		})),
		lastActionSignatureWithUrl: session.lastActionSignatureWithUrl,
		lastProgressSignature: session.lastProgressSignature,
		sameActionSignatureStreak: session.sameActionSignatureStreak,
		noProgressStreak: session.noProgressStreak,
		incrementalDomContext: {
			committed: session.incrementalDomContext.committed
				? { ...session.incrementalDomContext.committed }
				: undefined,
			pending: session.incrementalDomContext.pending
				? { ...session.incrementalDomContext.pending }
				: undefined,
		},
		dataExtractionCheckpoint:
			session.dataExtractionCoordinator.checkpoint(),
		memoryFileContents: (() => {
			try {
				return fs.readFileSync(session.memoryFile, "utf-8");
			} catch {
				return "";
			}
		})(),
		extractDataMemoryFileContents: (() => {
			try {
				return fs.readFileSync(session.extractDataMemoryFile, "utf-8");
			} catch {
				return "";
			}
		})(),
	};
}

async function restoreSession(
	session: BrowserSession,
	snapshot: SessionSnapshot,
): Promise<void> {
	session.activePlan = [...snapshot.activePlan];
	session.planStatuses = [...snapshot.planStatuses];
	session.keepPlanInHistory = snapshot.keepPlanInHistory;
	session.recentExecutions = snapshot.recentExecutions.map((entry) => ({
		...entry,
	}));
	session.lastTask = snapshot.lastTask;
	session.pendingMemoryRead = snapshot.pendingMemoryRead;
	session.previousInteractionErrors = [...snapshot.previousInteractionErrors];
	session.previousToolObservations = [...snapshot.previousToolObservations];
	session.previousStepTabs = snapshot.previousStepTabs
		? snapshot.previousStepTabs.map((tab) => ({ ...tab }))
		: null;
	session.downloadedFileSignatures = cloneDownloadedFileSignatures(
		snapshot.downloadedFileSignatures,
	);
	session.downloadedNewFilePaths = new Set(snapshot.downloadedNewFilePaths);
	session.screenshotToolObservations = [
		...snapshot.screenshotToolObservations,
	];
	session.screenshotToolSignalCaptures = [
		...snapshot.screenshotToolSignalCaptures,
	];
	session.excludedWebsiteToolNames = new Set(
		snapshot.excludedWebsiteToolNames,
	);
	session.activeWebsiteToolGuidance = snapshot.activeWebsiteToolGuidance
		? { ...snapshot.activeWebsiteToolGuidance }
		: undefined;
	session.websiteToolResults = snapshot.websiteToolResults.map((entry) => ({
		...entry,
	}));
	session.lastActionSignatureWithUrl = snapshot.lastActionSignatureWithUrl;
	session.lastProgressSignature = snapshot.lastProgressSignature;
	session.sameActionSignatureStreak = snapshot.sameActionSignatureStreak;
	session.noProgressStreak = snapshot.noProgressStreak;
	session.incrementalDomContext = {
		committed: snapshot.incrementalDomContext.committed
			? { ...snapshot.incrementalDomContext.committed }
			: undefined,
		pending: snapshot.incrementalDomContext.pending
			? { ...snapshot.incrementalDomContext.pending }
			: undefined,
	};
	session.dataExtractionCoordinator.rollback(
		snapshot.dataExtractionCheckpoint,
	);
	fs.writeFileSync(session.memoryFile, snapshot.memoryFileContents, "utf-8");
	fs.writeFileSync(
		session.extractDataMemoryFile,
		snapshot.extractDataMemoryFileContents,
		"utf-8",
	);
}

function resolveBrowserAgentArtifactDirectories(
	input: RunAgentInput["artifactDirectories"],
) {
	const defaults = getDefaultBrowserAgentArtifactDirectories();
	return {
		stepsDir: input?.stepsDir ?? defaults.stepsDir,
		contextDir: input?.contextDir ?? defaults.contextDir,
	};
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult>;

export async function runAgent(
	deps: CoreDeps,
	input: RunAgentInput,
): Promise<RunAgentResult>;

export async function runAgent(
	depsOrInput: CoreDeps | RunAgentInput,
	maybeInput?: RunAgentInput,
): Promise<RunAgentResult> {
	const rawInput = isCoreDeps(depsOrInput) ? maybeInput : depsOrInput;
	if (!rawInput) {
		throw new Error("runAgent input is required.");
	}
	const successVerifierLLMOptions = isCoreDeps(depsOrInput)
		? (depsOrInput.defaultSuccessVerifierLLMOptions ??
			rawInput.stageLLMs.verifySuccess)
		: rawInput.stageLLMs.verifySuccess;
	if (!successVerifierLLMOptions) {
		throw new Error(
			"Browser success verification requires an explicit stageLLMs.verifySuccess model configuration.",
		);
	}
	const baseDeps = isCoreDeps(depsOrInput)
		? {
				...depsOrInput,
				waitForAutomationPermission:
					depsOrInput.waitForAutomationPermission ?? (async () => {}),
				defaultSuccessVerifierLLMOptions:
					depsOrInput.defaultSuccessVerifierLLMOptions ??
					successVerifierLLMOptions,
			}
		: createDefaultCoreDeps({
				featureFlags: depsOrInput.featureFlags,
				userActionBehavior: depsOrInput.userActionBehavior,
				onUserActionRequired: depsOrInput.onUserActionRequired,
				requestAgentTakeover: depsOrInput.requestAgentTakeover,
				defaultSuccessVerifierLLMOptions: successVerifierLLMOptions,
			});
	const removeHrefsFromInputContext =
		featureFlags.removeHrefsFromInputContext;
	const deps: CoreDeps = {
		...baseDeps,
		getSimplifiedDOM: (browser, options) =>
			baseDeps.getSimplifiedDOM(browser, {
				...options,
				...(removeHrefsFromInputContext
					? { omitHrefs: options?.preserveFullHrefs !== true }
					: {}),
			}),
	};
	const input = rawInput;
	const executorPromptOptions = {
		provider: input.stageLLMs.runAgent.provider,
	};
	const abortSignal = input.abortSignal;
	throwIfAborted(abortSignal);
	await input.onRunStarted?.({
		task: input.task,
		session: input.session,
	});

	const stepsHistory: StepHistoryEntry[] = [];
	const usages: TokenUsage[] = [];
	const steps: RunAgentResult["steps"] = [];
	const mainLoopEntries: MainLoopStepEntry[] = [];
	const stepTokenUsage: StepTokenUsage[] = [];
	const stepRuntimeMetrics: StepRuntimeMetrics[] = [];
	const stepArtifacts: RunAgentStepArtifact[] = [];
	let planningDomForRun: string | undefined;
	let preExecutionPrunerDomForRun: string | undefined;
	const maxSteps = input.maxSteps ?? MAX_STEPS;
	const validatorLifecycle = resolveValidatorLifecycle(
		input.validatorLifecycle,
	);
	const generateStep = input.generateStep ?? createDefaultGenerateStep();
	let validatorFailureCount = 0;
	let pendingValidatorFeedback: ValidatorFeedback | undefined;
	let sessionStarted = false;
	try {
		await input.onBeforeSessionCreated?.(input.session);
		const sessionResult = await withAbort(
			abortSignal,
			async () => await createSession(deps, input.session),
		);
		sessionStarted = true;
		sessionResult.session.authTakeover = createSessionAuthTakeoverState({
			enabled: input.featureFlags.authTakeover,
			requestAuthDomainCandidates: input.requestAuthDomainCandidates,
			requestAuthIdentifierForDomain:
				input.requestAuthIdentifierForDomain,
			requestAuthPasswordForDomain: input.requestAuthPasswordForDomain,
			authProbeLLM:
				deps.defaultAuthProbeLLMOptions ?? input.stageLLMs.runAgent,
		});
		await input.onSessionCreated?.(sessionResult);

		const preprocess = await withAbort(
			abortSignal,
			async () =>
				await preprocessTask(deps, {
					port: input.session.port,
					userTask: input.task,
					url: input.session.url,
					stageLLMs: input.stageLLMs,
					initialPlanOverride: input.initialPlanOverride,
					recordModelInvocation: input.recordModelInvocation,
					savePlanningDom: async (dom) => {
						planningDomForRun = dom;
						await input.savePlanningDom?.(dom);
					},
					savePreExecutionPrunerDom: async (dom) => {
						preExecutionPrunerDomForRun = dom;
						await input.savePreExecutionPrunerDom?.(dom);
					},
				}),
		);
		await input.onPreprocessedTask?.({
			preprocess,
			planningDom: planningDomForRun,
			preExecutionPrunerDom: preExecutionPrunerDomForRun,
		});
		const saveStepsContext =
			input.saveStepsContext ?? shouldSaveStepsContext();
		const artifactDirectories = resolveBrowserAgentArtifactDirectories(
			input.artifactDirectories,
		);
		const session = sessionResult.session;
		let finalResult: string | null = null;

		for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
			throwIfAborted(abortSignal);
			let stepResult:
				| {
						status: "continue";
				  }
				| {
						status: "user_takeover";
						reason: string;
						category?: UserTakeoverCategory;
				  }
				| {
						status: "done";
						result: string | null;
						successful: boolean;
						successVerification?: RunAgentResult["successVerification"];
				  } = { status: "continue" };

			for (let attempt = 1; attempt <= MAX_STEP_RETRIES; attempt++) {
				const stepTimings: StepPartTimingEntry[] = [];
				const stepStartedAt = Date.now();
				const snapshot = snapshotSession(session);
				const validatorFailureCountAtAttemptStart =
					validatorFailureCount;
				const pendingValidatorFeedbackAtAttemptStart =
					pendingValidatorFeedback;
				const historyDomContextsAtAttemptStart = stepsHistory.map(
					(entry) => ({
						hasHtml: Object.prototype.hasOwnProperty.call(
							entry.payload,
							"html",
						),
						html: entry.payload.html,
						hasHtmlContextMode:
							Object.prototype.hasOwnProperty.call(
								entry.payload,
								"htmlContextMode",
							),
						htmlContextMode: entry.payload.htmlContextMode,
					}),
				);
				const lengths = {
					stepsHistory: stepsHistory.length,
					usages: usages.length,
					steps: steps.length,
					mainLoopEntries: mainLoopEntries.length,
					stepTokenUsage: stepTokenUsage.length,
					stepRuntimeMetrics: stepRuntimeMetrics.length,
					stepArtifacts: stepArtifacts.length,
				};
				try {
					await withAbort(
						abortSignal,
						async () => await deps.waitForAutomationPermission(),
					);
					const isMaxStepFinalization = stepNumber === maxSteps;
					const promptResult = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "create_prompt_for_step",
								run: async () =>
									await createPromptForStep(deps, {
										port: input.session.port,
										userTask: input.task,
										stepsHistory,
										llmOptions: input.stageLLMs.runAgent,
										autoSwitchToNewTab:
											input.autoSwitchToNewTab,
										stepNumber,
										finalizationInstruction:
											isMaxStepFinalization
												? MAX_STEP_FINALIZATION_INSTRUCTION
												: undefined,
										forceMemoryContent:
											isMaxStepFinalization,
										validatorFeedback:
											pendingValidatorFeedback,
									}),
							}),
					);
					if (isMaxStepFinalization) {
						console.log(
							`[runAgent] max steps reached at step ${stepNumber}; running return_results-only finalization`,
						);
					}
					if (input.includeStepArtifactsInResult) {
						stepArtifacts.push({
							stepNumber,
							simplifiedDomYaml:
								promptResult.artifacts.canonicalSimplifiedDom,
							contextJson: serializeStepContextForDisk(
								promptResult.prompt.messages as Message[],
							),
						});
					}
					await measureStepPart({
						timings: stepTimings,
						part: "save_step_context_pre_llm",
						run: async () =>
							await saveStepContextIfNeeded({
								saveStepsContext,
								contextDir: artifactDirectories.contextDir,
								stepsDir: artifactDirectories.stepsDir,
								stepNumber,
								messages: promptResult.prompt
									.messages as Message[],
								simplifiedDom:
									promptResult.artifacts
										.canonicalSimplifiedDom,
								browser: session.browser,
								memoryFile: session.memoryFile,
								extractDataMemoryFile:
									session.extractDataMemoryFile,
								memorySnapshotPhase: "pre-llm",
								preStepScreenshotDataUrl:
									promptResult.artifacts
										.preStepScreenshotDataUrl,
							}),
					});
					const {
						data: rawStep,
						usage,
						reasoning_tokens,
					} = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "llm_step_call",
								run: async () =>
									await generateStep({
										stepNumber,
										messages: promptResult.prompt
											.messages as Message[],
										llmOptions: input.stageLLMs.runAgent,
										promptPayload:
											promptResult.prompt.payload,
										stepsHistory,
										caller: isMaxStepFinalization
											? "runAgent:maxStepFinalization"
											: undefined,
										stepKind: isMaxStepFinalization
											? "max_step_finalization"
											: "executor_step",
										abortSignal,
									}),
							}),
					);
					await input.onStepGenerated?.({
						stepNumber,
						step: rawStep,
						usage,
					});
					usages.push(usage);
					const parsedRawStep = processModelStepOutput(rawStep).step;
					logStepActionContext(parsedRawStep);

					const planForLog = Array.isArray(
						promptResult.prompt.payload.plan,
					)
						? promptResult.prompt.payload.plan.filter(
								(entry): entry is string =>
									typeof entry === "string",
							)
						: formatPlanWithStatuses(
								session.activePlan,
								session.planStatuses,
							);

					const maxStepHasOnlyReturnResults =
						parsedRawStep.actions.length === 1 &&
						parsedRawStep.actions[0]?.type === "return_results";
					if (isMaxStepFinalization && !maxStepHasOnlyReturnResults) {
						const mainLoopStepIndex = mainLoopEntries.length + 1;
						mainLoopEntries.push({
							step: mainLoopStepIndex,
							step_kind: "max_step_finalization",
							messages: serializeMessagesForDisk([
								...(promptResult.prompt.messages as Message[]),
								{
									role: "assistant",
									content: yaml.dump(
										formatStepForPrompt(
											parsedRawStep,
											executorPromptOptions,
										),
									),
									reasoning_tokens,
								},
							]),
						});
						stepTokenUsage.push(
							buildStepTokenUsage(mainLoopStepIndex, usage),
						);
						logStepModelResponse({
							stepNumber: mainLoopStepIndex,
							planForPayload: planForLog,
							step: parsedRawStep,
							totalTokens: usage.total_tokens,
						});
						steps.push({
							step: stepNumber,
							model: parsedRawStep,
							usage,
						});
						await input.onStepCompleted?.({
							stepNumber,
							step: parsedRawStep,
							usage,
							promptContext: {
								current_url:
									typeof promptResult.prompt.payload
										.currentURL === "string"
										? promptResult.prompt.payload.currentURL
										: undefined,
								current_tab:
									typeof promptResult.prompt.payload
										.currentTab === "number"
										? promptResult.prompt.payload.currentTab
										: undefined,
								open_tabs: Array.isArray(
									promptResult.prompt.payload.openTabs,
								)
									? promptResult.prompt.payload.openTabs.filter(
											(item): item is string =>
												typeof item === "string",
										)
									: undefined,
								downloaded_files: Array.isArray(
									promptResult.prompt.payload.downloadedFiles,
								)
									? promptResult.prompt.payload.downloadedFiles.filter(
											(item): item is string =>
												typeof item === "string",
										)
									: undefined,
							},
						});
						console.warn(
							"[runAgent] max-step finalization did not return exactly one return_results tool call; treating run as incomplete",
						);
						stepResult = { status: "continue" };
						recordStepRuntimeMetrics({
							stepRuntimeMetrics,
							stepNumber: mainLoopStepIndex,
							timings: stepTimings,
							totalDurationMs: Date.now() - stepStartedAt,
							usage,
						});
						break;
					}

					const processResult = await withAbort(
						abortSignal,
						async () =>
							await measureStepPart({
								timings: stepTimings,
								part: "process_model_output_and_browse",
								run: async () =>
									await processModelOutputAndBrowse(
										deps,
										input.session.port,
										{
											mode: "process_model_step_output",
											rawStepOutput: rawStep,
											executorProvider:
												input.stageLLMs.runAgent
													.provider,
											reasoningTokens: reasoning_tokens,
											promptPayload:
												promptResult.prompt.payload,
											stepsHistory,
											stepNumber,
											dataExtractionLLMOptions:
												input.stageLLMs.dataExtraction,
											recordModelInvocation:
												input.recordModelInvocation,
											keepPlanInHistory:
												session.keepPlanInHistory,
											planLength:
												session.activePlan.length,
											sessionPlanStatuses:
												session.planStatuses,
											allowFatalActionErrors: true,
											autoSwitchToNewTab:
												input.autoSwitchToNewTab,
										},
									),
							}),
					);
					pendingValidatorFeedback = undefined;
					session.keepPlanInHistory = false;
					const mainLoopStepIndex = mainLoopEntries.length + 1;
					mainLoopEntries.push({
						step: mainLoopStepIndex,
						step_kind: isMaxStepFinalization
							? "max_step_finalization"
							: "executor_step",
						messages: serializeMessagesForDisk([
							...(promptResult.prompt.messages as Message[]),
							{
								role: "assistant",
								content: yaml.dump(
									formatStepForPrompt(
										processResult.step,
										executorPromptOptions,
									),
								),
								reasoning_tokens,
							},
						]),
					});
					stepTokenUsage.push(
						buildStepTokenUsage(mainLoopStepIndex, usage),
					);
					logStepModelResponse({
						stepNumber: mainLoopStepIndex,
						planForPayload: planForLog,
						step: processResult.step,
						totalTokens: usage.total_tokens,
					});

					const authTakeoverAttempts =
						processResult.browse?.execution
							.auth_takeover_attempts ?? [];
					for (const authAttempt of authTakeoverAttempts) {
						const authStepIndex = mainLoopEntries.length + 1;
						mainLoopEntries.push({
							step: authStepIndex,
							step_kind: "auth_takeover_attempt",
							messages: serializeAuthAttemptMessages(
								authAttempt.messages,
							),
						});
						const authUsage = authAttempt.token_usage;
						stepTokenUsage.push(
							buildStepTokenUsage(authStepIndex, authUsage),
						);
						const authGenerationMs =
							authUsage?.generation_time_ms ?? 0;
						if (shouldLogTimingDuration(authGenerationMs)) {
							console.log(
								`  [step ${authStepIndex} timing-split] state_extraction_ms=0 | llm_decision_ms=${authGenerationMs} | tool_execution_ms=0`,
							);
						}
					}

					steps.push({
						step: stepNumber,
						model: processResult.step,
						usage,
						browse: processResult.browse,
					});
					await input.onStepCompleted?.({
						stepNumber,
						step: processResult.step,
						usage,
						browse: processResult.browse,
						promptContext: {
							current_url:
								typeof promptResult.prompt.payload
									.currentURL === "string"
									? promptResult.prompt.payload.currentURL
									: undefined,
							current_tab:
								typeof promptResult.prompt.payload
									.currentTab === "number"
									? promptResult.prompt.payload.currentTab
									: undefined,
							open_tabs: Array.isArray(
								promptResult.prompt.payload.openTabs,
							)
								? promptResult.prompt.payload.openTabs.filter(
										(item): item is string =>
											typeof item === "string",
									)
								: undefined,
							downloaded_files: Array.isArray(
								promptResult.prompt.payload.downloadedFiles,
							)
								? promptResult.prompt.payload.downloadedFiles.filter(
										(item): item is string =>
											typeof item === "string",
									)
								: undefined,
						},
					});
					await measureStepPart({
						timings: stepTimings,
						part: "save_step_context_post_actions",
						run: async () =>
							await saveStepContextIfNeeded({
								saveStepsContext,
								contextDir: artifactDirectories.contextDir,
								stepsDir: artifactDirectories.stepsDir,
								stepNumber,
								messages: promptResult.prompt
									.messages as Message[],
								simplifiedDom:
									promptResult.artifacts
										.canonicalSimplifiedDom,
								browser: session.browser,
								memoryFile: session.memoryFile,
								extractDataMemoryFile:
									session.extractDataMemoryFile,
								memorySnapshotPhase: "post-actions",
								toolCallScreenshots:
									processResult.browse?.execution
										.screenshot_tool_captures,
								writeCoreFiles: false,
							}),
					});

					const userTakeover =
						processResult.browse?.execution.user_takeover;
					if (userTakeover) {
						stepResult = {
							status: "user_takeover",
							reason: userTakeover.reason,
							category: userTakeover.category,
						};
					} else if (processResult.step.done) {
						finalResult = processResult.step.result ?? null;
						const rejectedByValidator =
							processResult.successVerification?.success ===
							false;
						if (rejectedByValidator) {
							validatorFailureCount += 1;
						}
						const continueAfterRejection =
							rejectedByValidator &&
							validatorLifecycle.mode === "retry" &&
							validatorFailureCount <
								validatorLifecycle.maxFailures &&
							stepNumber < maxSteps;
						if (
							continueAfterRejection &&
							processResult.successVerification
						) {
							pendingValidatorFeedback = buildValidatorFeedback({
								failure: validatorFailureCount,
								maxFailures: validatorLifecycle.maxFailures,
								verification: processResult.successVerification,
							});
							console.warn(
								`[runAgent] validator rejected result (${validatorFailureCount}/${validatorLifecycle.maxFailures}); continuing with feedback`,
							);
							stepResult = { status: "continue" };
						} else {
							stepResult = {
								status: "done",
								result: finalResult,
								successful: processResult.successful,
								successVerification:
									processResult.successVerification,
							};
						}
					} else {
						const promptPayloadUrl =
							typeof promptResult.prompt.payload.currentURL ===
							"string"
								? promptResult.prompt.payload.currentURL
								: "";
						const repeatedActionSignature = yaml.dump(
							processResult.step.actions,
						);
						const actionSignature = buildActionSignatureWithUrl(
							processResult.step,
							promptPayloadUrl,
						);
						if (
							session.lastActionSignatureWithUrl ===
							actionSignature
						) {
							session.sameActionSignatureStreak += 1;
						} else {
							session.sameActionSignatureStreak = 1;
						}
						session.lastActionSignatureWithUrl = actionSignature;

						const progressSignature = buildProgressSignature({
							url:
								processResult.browse?.context.current_url ?? "",
							dom: processResult.browse?.context.html ?? "",
							downloadedFiles:
								processResult.browse?.context
									.downloaded_files ?? [],
						});
						if (
							session.lastProgressSignature === progressSignature
						) {
							session.noProgressStreak += 1;
						} else {
							session.noProgressStreak = 1;
						}
						session.lastProgressSignature = progressSignature;
						emitStagnationWarning(session, stepNumber);

						const replanReason = featureFlags.enablePlanning
							? getReplanReason({
									recentExecutions: session.recentExecutions,
									actionSignature: repeatedActionSignature,
									pendingPlanRegeneration:
										processResult.browse?.execution
											.pending_plan_regeneration === true,
								})
							: null;
						if (replanReason) {
							await withAbort(
								abortSignal,
								async () =>
									await measureStepPart({
										timings: stepTimings,
										part: "replan",
										run: async () =>
											await replanFromCurrentDom({
												deps,
												session,
												task: input.task,
												stepNumber,
												reason: replanReason,
												createPlanLLMOptions:
													input.stageLLMs.createPlan,
												recordModelInvocation:
													input.recordModelInvocation,
											}),
									}),
							);
						}
						await withAbort(
							abortSignal,
							async () =>
								await measureStepPart({
									timings: stepTimings,
									part: "wait_for_settle",
									run: async () => {
										if (
											input.featureFlags
												.optimizeExecutorStepDelays &&
											canSkipExecutorStepDelay(
												processResult.step.actions,
											)
										) {
											return;
										}
										await sleep(
											DEFAULT_EXECUTOR_STEP_DELAY_MS,
										);
									},
								}),
						);
						stepResult = { status: "continue" };
					}
					recordStepRuntimeMetrics({
						stepRuntimeMetrics,
						stepNumber: mainLoopStepIndex,
						timings: stepTimings,
						totalDurationMs: Date.now() - stepStartedAt,
						usage,
					});
					break;
				} catch (error) {
					if (isAbortError(error) || abortSignal?.aborted) {
						throw isAbortError(error)
							? error
							: createRunAgentAbortError(abortSignal);
					}
					await restoreSession(session, snapshot);
					validatorFailureCount = validatorFailureCountAtAttemptStart;
					pendingValidatorFeedback =
						pendingValidatorFeedbackAtAttemptStart;
					for (
						let index = 0;
						index < historyDomContextsAtAttemptStart.length;
						index++
					) {
						const entry = stepsHistory[index];
						const domContext =
							historyDomContextsAtAttemptStart[index];
						if (!entry || !domContext) continue;
						if (domContext.hasHtml) {
							entry.payload.html = domContext.html;
						} else {
							delete entry.payload.html;
						}
						if (domContext.hasHtmlContextMode) {
							entry.payload.htmlContextMode =
								domContext.htmlContextMode;
						} else {
							delete entry.payload.htmlContextMode;
						}
					}
					stepsHistory.length = lengths.stepsHistory;
					usages.length = lengths.usages;
					steps.length = lengths.steps;
					mainLoopEntries.length = lengths.mainLoopEntries;
					stepTokenUsage.length = lengths.stepTokenUsage;
					stepRuntimeMetrics.length = lengths.stepRuntimeMetrics;
					stepArtifacts.length = lengths.stepArtifacts;
					console.error(
						`[step ${stepNumber}] execution failed (attempt ${attempt}/${MAX_STEP_RETRIES}): ${
							error instanceof Error
								? (error.stack ?? error.message)
								: String(error)
						}`,
					);
					if (attempt === MAX_STEP_RETRIES) {
						throw error;
					}
					await sleep(500 * attempt);
				}
			}
			if (stepResult.status === "user_takeover") {
				return {
					preprocess,
					completed: false,
					successful: false,
					result: null,
					steps,
					stepsHistory,
					mainLoopEntries,
					stepTokenUsage,
					stepRuntimeMetrics,
					...(input.includeStepArtifactsInResult
						? { stepArtifacts }
						: {}),
					tokenTotals: sumTokenUsage(usages),
					userActionRequired: {
						kind: "browser_user_takeover",
						reason: stepResult.reason,
						category: stepResult.category,
					},
				};
			}

			if (stepResult.status === "done") {
				return {
					preprocess,
					completed: true,
					successful: stepResult.successful,
					result: stepResult.result,
					steps,
					stepsHistory,
					mainLoopEntries,
					stepTokenUsage,
					stepRuntimeMetrics,
					...(input.includeStepArtifactsInResult
						? { stepArtifacts }
						: {}),
					tokenTotals: sumTokenUsage(usages),
					successVerification: stepResult.successVerification,
				};
			}
		}

		return {
			preprocess,
			completed: false,
			successful: false,
			result: finalResult,
			steps,
			stepsHistory,
			mainLoopEntries,
			stepTokenUsage,
			stepRuntimeMetrics,
			...(input.includeStepArtifactsInResult ? { stepArtifacts } : {}),
			tokenTotals: sumTokenUsage(usages),
		};
	} finally {
		if (sessionStarted && !input.keepSessionOpen) {
			await closeSession(deps, input.session.port);
		}
	}
}
