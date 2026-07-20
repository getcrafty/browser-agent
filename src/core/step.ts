import yaml from "js-yaml";
import { configFeatureFlags } from "../config-feature-flags.js";
import { stripPayloadForHistory } from "../agents/executor-utils/history-payload.js";
import {
	buildMaxStepFinalizationMessages,
	formatStepForPrompt,
} from "../agents/executor-utils/step-execution.js";
import {
	buildDownloadedFilesPayload,
	buildWorkspaceFilesPayload,
} from "../agents/executor-utils/step-context.js";
import { canonicalizeStepDownloadedFilePaths } from "../agents/executor-utils/downloaded-file-paths.js";
import { buildHistoryMessagesFromFullStepHistory } from "./history-adapter.js";
import { normalizeUserTakeoverCategory } from "../user-action-types.js";
import { fitStepPromptToBudget } from "./prompt-budget.js";
import type {
	BrowseInput,
	BrowseResult,
	CoreDeps,
	CreatePromptForStepInput,
	CreatePromptForStepResult,
	ProcessModelStepOutputInput,
	ProcessModelStepOutputResult,
	StepInput,
	StepInputByMode,
	StepHistoryEntry,
	StepResult,
	StepResultByMode,
} from "./types.js";
import { SessionNotFoundError } from "./session.js";
import type { BrowserSession } from "./session-registry.js";
import type { Tab } from "../browser/types.js";
import { processModelStepOutput } from "./process-model-step-output.js";
import { Action } from "../agents/types.js";
import { attemptAutomatedAuthTakeover } from "../auth/runtime.js";
import { verifyTaskSuccess as defaultVerifyTaskSuccess } from "../agents/success-verifier.js";
import {
	applyPlanStepUpdates,
	formatPlanWithStatuses,
	normalizePlanStepUpdates,
} from "./run-agent-loop-state.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import { featureFlags } from "../featureFlags.js";
import { shouldUseExecutorReasoningTraceContext } from "../agents/prompts.js";

const PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT = 2;
const PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS = 150;
const EMPTY_SIMPLIFIED_DOM_RETRY_DELAY_MS = 3_000;
const EMPTY_SIMPLIFIED_DOM_MAX_RETRIES = 2;
const BLANK_DOWNLOAD_TAB_CONTEXT_NOTE =
	"Ignored blank download tab; stayed on source tab.";

export class MissingPlanError extends Error {
	constructor() {
		super(
			"No plan available. Run /start_browser first or provide a plan in steps_history payload.",
		);
		this.name = "MissingPlanError";
	}
}

function getSessionOrThrow(deps: CoreDeps, port: number): BrowserSession {
	const session = deps.registry.get(port);
	if (!session) {
		throw new SessionNotFoundError(port);
	}
	return session;
}

function shouldProtectAuthContext(session: BrowserSession): boolean {
	const sessionAuth = session.authTakeover;
	if (
		!sessionAuth?.suppressScreenshots ||
		sessionAuth.protectedBids.size === 0
	) {
		return false;
	}
	return true;
}

async function getAuthUsernameForContext(params: {
	session: BrowserSession;
	currentUrl: string;
}): Promise<string | undefined> {
	const sessionAuth = params.session.authTakeover;
	if (
		!sessionAuth?.enabled ||
		!sessionAuth.requestAuthDomainCandidates ||
		!sessionAuth.requestAuthIdentifierForDomain
	) {
		return undefined;
	}
	try {
		const candidates = await sessionAuth.requestAuthDomainCandidates(
			params.currentUrl,
			{ purpose: "step_context" },
		);
		if (candidates.length === 0) {
			return undefined;
		}
		const identifier = await sessionAuth.requestAuthIdentifierForDomain(
			params.currentUrl,
			{ purpose: "step_context" },
		);
		return typeof identifier === "string" && identifier.trim()
			? identifier
			: undefined;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlankDownloadArtifactTab(tab: Tab): boolean {
	const normalizedUrl = tab.url.trim().toLowerCase();
	const normalizedTitle = tab.title.trim().toLowerCase();
	return (
		(normalizedUrl === "" ||
			normalizedUrl === "about:blank" ||
			normalizedUrl === ":") &&
		(normalizedTitle === "" || normalizedTitle === "new tab")
	);
}

function firstMeaningfulNewTab(tabs: Tab[]): Tab | undefined {
	return tabs.find((tab) => !isBlankDownloadArtifactTab(tab));
}

async function restoreSourceTabAfterBlankDownloadTab(input: {
	deps: CoreDeps;
	session: BrowserSession;
	openTabs: Tab[];
	currentUrl: string;
	newlyOpenedTabs: Tab[];
}): Promise<{ currentUrl: string; restored: boolean }> {
	if (!input.newlyOpenedTabs.some(isBlankDownloadArtifactTab)) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	const currentTab =
		input.openTabs.find((tab) => tab.url === input.currentUrl) ??
		input.openTabs.find(
			(tab) => tab.targetId === input.session.browser.currentTargetId,
		);
	if (currentTab && !isBlankDownloadArtifactTab(currentTab)) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	const sourceTab = input.openTabs.find(
		(tab) =>
			!input.newlyOpenedTabs.some(
				(newTab) => newTab.targetId === tab.targetId,
			) && !isBlankDownloadArtifactTab(tab),
	);
	if (!sourceTab) {
		return { currentUrl: input.currentUrl, restored: false };
	}
	await input.deps.switchTab(input.session.browser, sourceTab.targetId);
	return {
		currentUrl: await input.deps.getCurrentURL(input.session.browser),
		restored: true,
	};
}

function logStateExtractionPhase(params: {
	stepNumber?: number;
	phase: string;
	durationMs: number;
	status?: "ok" | "error";
	detail?: string;
}): void {
	const status = params.status ?? "ok";
	if (!shouldLogTimingDuration(params.durationMs, status)) {
		return;
	}
	const prefix =
		typeof params.stepNumber === "number"
			? `  [step ${params.stepNumber} state-extraction]`
			: "  [state-extraction]";
	const detail = params.detail ? ` | ${params.detail}` : "";
	console.log(
		`${prefix} ${params.phase} status=${status} duration_ms=${params.durationMs}${detail}`,
	);
}

function logCreatePromptTotal(params: {
	stepNumber?: number;
	durationMs: number;
	status?: "ok" | "error";
}): void {
	const status = params.status ?? "ok";
	if (!shouldLogTimingDuration(params.durationMs, status)) {
		return;
	}
	const prefix =
		typeof params.stepNumber === "number"
			? `  [step ${params.stepNumber} create-prompt]`
			: "  [create-prompt]";
	console.log(
		`${prefix} total status=${status} duration_ms=${params.durationMs}`,
	);
}

async function timeStateExtractionPhase<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await fn();
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: toErrorMessage(error),
		});
		throw error;
	}
}

function timeStateExtractionPhaseSync<T>(
	params: {
		stepNumber?: number;
		phase: string;
		detail?: () => string | undefined;
	},
	fn: () => T,
): T {
	const startedAt = Date.now();
	try {
		const result = fn();
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "ok",
			detail: params.detail?.(),
		});
		return result;
	} catch (error) {
		logStateExtractionPhase({
			stepNumber: params.stepNumber,
			phase: params.phase,
			durationMs: Date.now() - startedAt,
			status: "error",
			detail: toErrorMessage(error),
		});
		throw error;
	}
}

function isSimplifiedDomBlank(dom: string): boolean {
	return dom.trim().length === 0;
}

async function fetchSimplifiedDomWithRetry(params: {
	stepNumber?: number;
	getSimplifiedDom: () => Promise<string>;
}): Promise<string> {
	let dom = await params.getSimplifiedDom();
	if (!isSimplifiedDomBlank(dom)) return dom;

	for (let retry = 1; retry <= EMPTY_SIMPLIFIED_DOM_MAX_RETRIES; retry++) {
		console.warn(
			`[core][step ${params.stepNumber ?? "?"}] Simplified DOM is empty. Waiting ${EMPTY_SIMPLIFIED_DOM_RETRY_DELAY_MS}ms before retry ${retry}/${EMPTY_SIMPLIFIED_DOM_MAX_RETRIES}.`,
		);
		await timeStateExtractionPhase(
			{
				stepNumber: params.stepNumber,
				phase: `getSimplifiedDOM:emptyRetryWait${retry}`,
				detail: () => `wait_ms=${EMPTY_SIMPLIFIED_DOM_RETRY_DELAY_MS}`,
			},
			async () => await sleep(EMPTY_SIMPLIFIED_DOM_RETRY_DELAY_MS),
		);
		dom = await params.getSimplifiedDom();
		if (!isSimplifiedDomBlank(dom)) return dom;
	}

	console.warn(
		`[core][step ${params.stepNumber ?? "?"}] Simplified DOM is still empty after ${EMPTY_SIMPLIFIED_DOM_MAX_RETRIES} retries. Continuing with empty DOM.`,
	);
	return dom;
}

function getPlanForPrompt(params: {
	session: BrowserSession;
	stepsHistory: StepHistoryEntry[];
}): { plan: string[]; fromHistory: boolean } | null {
	if (params.session.activePlan.length > 0) {
		return { plan: [...params.session.activePlan], fromHistory: false };
	}

	for (let i = params.stepsHistory.length - 1; i >= 0; i--) {
		const maybePlan = params.stepsHistory[i].payload.plan;
		if (!Array.isArray(maybePlan)) continue;
		const plan = maybePlan.filter(
			(entry): entry is string => typeof entry === "string",
		);
		if (plan.length > 0) {
			return { plan, fromHistory: true };
		}
	}

	return null;
}

export async function createPromptForStep(
	deps: CoreDeps,
	input: CreatePromptForStepInput,
): Promise<CreatePromptForStepResult> {
	const startedAt = Date.now();
	try {
		const result = await createPromptForStepImpl(deps, input);
		logCreatePromptTotal({
			stepNumber: input.stepNumber,
			durationMs: Date.now() - startedAt,
			status: "ok",
		});
		return result;
	} catch (error) {
		logCreatePromptTotal({
			stepNumber: input.stepNumber,
			durationMs: Date.now() - startedAt,
			status: "error",
		});
		throw error;
	}
}

async function createPromptForStepImpl(
	deps: CoreDeps,
	input: CreatePromptForStepInput,
): Promise<CreatePromptForStepResult> {
	const session = getSessionOrThrow(deps, input.port);
	const planState = featureFlags.enablePlanning
		? getPlanForPrompt({
				session,
				stepsHistory: input.stepsHistory,
			})
		: null;
	if (!planState && featureFlags.enablePlanning) {
		throw new MissingPlanError();
	}
	if (planState?.fromHistory) {
		session.activePlan = [...planState.plan];
		session.planStatuses = planState.plan.map(() => "TODO");
	}
	const activePlan = planState?.plan ?? [];
	const executorPromptOptions = {
		provider: input.llmOptions?.provider,
	};

	session.lastTask = input.userTask;

	let history: ReturnType<typeof buildHistoryMessagesFromFullStepHistory> =
		[];
	history = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildHistoryMessages",
			detail: () => `history_messages=${history.length}`,
		},
		() => {
			history = buildHistoryMessagesFromFullStepHistory(
				input.stepsHistory,
				executorPromptOptions,
			);
			return history;
		},
	);
	let currentUrl = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "getCurrentURL",
		},
		async () => await deps.getCurrentURL(session.browser),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "getCurrentURL:value",
		durationMs: 0,
		detail: currentUrl,
	});
	const protectAuthContext = shouldProtectAuthContext(session);
	const domOptions = {
		includeNonClickableIds: true,
		redactInputBids: protectAuthContext
			? [...(session.authTakeover?.protectedBids || [])]
			: [],
		redactPasswordInputs: protectAuthContext,
	};
	const promptInteractionErrors = [...session.previousInteractionErrors];
	for (const toolName of session.excludedWebsiteToolNames) {
		promptInteractionErrors.push(
			`website_tool(name=${JSON.stringify(toolName)}): disabled for the remainder of this trajectory after a previous execution error`,
		);
	}
	let dom = "";
	let validBids: string[] = [];
	const getSimplifiedDomWithRetry = async (): Promise<string> =>
		await fetchSimplifiedDomWithRetry({
			stepNumber: input.stepNumber,
			getSimplifiedDom: async () => {
				const options =
					typeof input.stepNumber === "number"
						? { ...domOptions, stepNumber: input.stepNumber }
						: domOptions;
				return await deps.getSimplifiedDOM(session.browser, options);
			},
		});
	const refreshDomContext = async (): Promise<void> => {
		try {
			dom = await timeStateExtractionPhase(
				{
					stepNumber: input.stepNumber,
					phase: "getSimplifiedDOM",
					detail: () => `html_chars=${dom.length}`,
				},
				async () => {
					dom = await getSimplifiedDomWithRetry();
					return dom;
				},
			);
			validBids = timeStateExtractionPhaseSync(
				{
					stepNumber: input.stepNumber,
					phase: "extractValidBids",
					detail: () => `valid_bids=${validBids.length}`,
				},
				() => {
					validBids = deps.extractValidBids(dom);
					return validBids;
				},
			);
		} catch (error) {
			const message = toErrorMessage(error);
			if (isStaleContextNodeError(message)) {
				try {
					dom = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "getSimplifiedDOM:retry",
							detail: () => `html_chars=${dom.length}`,
						},
						async () => {
							dom = await getSimplifiedDomWithRetry();
							return dom;
						},
					);
					validBids = timeStateExtractionPhaseSync(
						{
							stepNumber: input.stepNumber,
							phase: "extractValidBids:retry",
							detail: () => `valid_bids=${validBids.length}`,
						},
						() => {
							validBids = deps.extractValidBids(dom);
							return validBids;
						},
					);
				} catch (retryError) {
					promptInteractionErrors.push(
						`context(html): ${toErrorMessage(retryError)}`,
					);
				}
			} else {
				promptInteractionErrors.push(`context(html): ${message}`);
			}
		}
	};
	await refreshDomContext();
	let openTabs = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "listTabs",
		},
		async () => await deps.listTabs(session.browser),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "listTabs:value",
		durationMs: 0,
		detail: `tabs=${openTabs.length}`,
	});
	let newlyOpenedTabs = deps.getNewlyOpenedTabs(
		session.previousStepTabs,
		openTabs,
	);
	let autoTabSwitchNote: string | undefined;
	if ((input.autoSwitchToNewTab ?? true) && newlyOpenedTabs.length > 0) {
		await timeStateExtractionPhase(
			{
				stepNumber: input.stepNumber,
				phase: "autoSwitchToNewTab",
				detail: () =>
					`newly_opened_tabs=${newlyOpenedTabs.length} switched=${autoTabSwitchNote ? "yes" : "no"}`,
			},
			async () => {
				const firstNewTab = firstMeaningfulNewTab(newlyOpenedTabs);
				if (!firstNewTab) {
					return;
				}
				const currentTabIndex = await deps.resolveCurrentTabIndex({
					b: session.browser,
					openTabs,
					currentUrl,
				});
				const currentTabTargetId = openTabs[currentTabIndex]?.targetId;
				if (currentTabTargetId !== firstNewTab.targetId) {
					console.log(
						`Auto-switching to first newly opened tab: "${deps.formatTabTitle(firstNewTab)}"`,
					);
					await deps.switchTab(session.browser, firstNewTab.targetId);
					currentUrl = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "getCurrentURL:autoSwitch",
						},
						async () => await deps.getCurrentURL(session.browser),
					);
					logStateExtractionPhase({
						stepNumber: input.stepNumber,
						phase: "getCurrentURL:autoSwitch:value",
						durationMs: 0,
						detail: currentUrl,
					});
					await refreshDomContext();
					openTabs = await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: "listTabs:autoSwitch",
						},
						async () => await deps.listTabs(session.browser),
					);
					logStateExtractionPhase({
						stepNumber: input.stepNumber,
						phase: "listTabs:autoSwitch:value",
						durationMs: 0,
						detail: `tabs=${openTabs.length}`,
					});
					newlyOpenedTabs = deps.getNewlyOpenedTabs(
						session.previousStepTabs,
						openTabs,
					);
					autoTabSwitchNote =
						"Auto-switched to first newly opened tab.";
				}
			},
		);
	}

	let preStepScreenshotDataUrl = "";
	if (
		configFeatureFlags.preStepScreenshotInLatestUserPrompt &&
		!protectAuthContext
	) {
		for (
			let attempt = 1;
			attempt <= PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT + 1;
			attempt++
		) {
			try {
				preStepScreenshotDataUrl = await timeStateExtractionPhase(
					{
						stepNumber: input.stepNumber,
						phase:
							attempt === 1
								? "capturePreStepScreenshotDataUrl"
								: `capturePreStepScreenshotDataUrl:retry${attempt}`,
						detail: () =>
							preStepScreenshotDataUrl
								? `image_chars=${preStepScreenshotDataUrl.length}`
								: undefined,
					},
					async () => {
						preStepScreenshotDataUrl =
							await deps.capturePreStepScreenshotDataUrl({
								b: session.browser,
								validBids,
							});
						return preStepScreenshotDataUrl;
					},
				);
				break;
			} catch (error) {
				const message = toErrorMessage(error);
				const canRetryStaleNodeError =
					attempt <= PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_COUNT &&
					isStaleContextNodeError(message);
				if (canRetryStaleNodeError) {
					await timeStateExtractionPhase(
						{
							stepNumber: input.stepNumber,
							phase: `capturePreStepScreenshotDataUrl:retryWait${attempt}`,
							detail: () =>
								`wait_ms=${PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS}`,
						},
						async () =>
							await sleep(
								PRE_STEP_SCREENSHOT_STALE_NODE_RETRY_DELAY_MS,
							),
					);
					continue;
				}
				promptInteractionErrors.push(
					`context(pre_step_screenshot): ${message}`,
				);
				break;
			}
		}
	}

	const currentTab = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "resolveCurrentTabIndex",
		},
		async () =>
			await deps.resolveCurrentTabIndex({
				b: session.browser,
				openTabs,
				currentUrl,
			}),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "resolveCurrentTabIndex:value",
		durationMs: 0,
		detail: `current_tab=${currentTab}`,
	});
	let downloadedFilesState: ReturnType<typeof buildDownloadedFilesPayload>;
	downloadedFilesState = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildDownloadedFilesPayload",
			detail: () =>
				`downloaded_files=${downloadedFilesState.downloadedFiles.length} new_files=${downloadedFilesState.newFilePaths.size}`,
		},
		() => {
			downloadedFilesState = buildDownloadedFilesPayload({
				downloadDir: session.browser.downloadDir,
				downloadRootDir: session.browser.downloadRootDir,
				fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
				previousFileSignatures: session.downloadedFileSignatures,
				previousNewFilePaths: session.downloadedNewFilePaths,
			});
			return downloadedFilesState;
		},
	);
	let workspaceFiles: ReturnType<typeof buildWorkspaceFilesPayload> = [];
	workspaceFiles = timeStateExtractionPhaseSync(
		{
			stepNumber: input.stepNumber,
			phase: "buildWorkspaceFilesPayload",
			detail: () => `workspace_files=${workspaceFiles.length}`,
		},
		() => {
			workspaceFiles = buildWorkspaceFilesPayload({
				fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
				downloadRootDir: session.browser.downloadRootDir,
			});
			return workspaceFiles;
		},
	);
	let authUsernameOrEmail: string | undefined;
	authUsernameOrEmail = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "getAuthUsernameForContext",
			detail: () =>
				`auth_context=${authUsernameOrEmail ? "available" : "none"}`,
		},
		async () => {
			authUsernameOrEmail = await getAuthUsernameForContext({
				session,
				currentUrl,
			});
			return authUsernameOrEmail;
		},
	);

	let forceMemoryContent = input.forceMemoryContent;
	let forcedMemoryBarrierFailed = false;
	if (forceMemoryContent) {
		const extractionBarrier =
			await session.dataExtractionCoordinator.waitForAllAndFlush({
				filePath: session.extractDataMemoryFile,
			});
		session.previousToolObservations.push(
			...extractionBarrier.observations,
		);
		if (extractionBarrier.errors.length > 0) {
			promptInteractionErrors.push(...extractionBarrier.errors);
			forceMemoryContent = false;
			forcedMemoryBarrierFailed = true;
		}
	}
	promptInteractionErrors.push(
		...session.dataExtractionCoordinator.drainErrors(),
	);

	const payloadState = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "buildStepPayload",
			detail: () =>
				`interaction_errors=${promptInteractionErrors.length} open_tabs=${openTabs.length} newly_opened_tabs=${newlyOpenedTabs.length}`,
		},
		async () =>
			deps.buildStepPayload({
				task: input.userTask,
				planForPayload: formatPlanWithStatuses(
					activePlan,
					session.planStatuses,
				),
				url: currentUrl,
				previousInteractionErrors: promptInteractionErrors,
				previousToolObservations: session.previousToolObservations,
				websiteToolResults: configFeatureFlags.websiteAPIficationTools
					? session.websiteToolResults
					: undefined,
				dom,
				currentTab,
				openTabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
				newlyOpenedTabs: newlyOpenedTabs.map((tab) =>
					deps.formatTabTitle(tab),
				),
				autoTabSwitchNote,
				downloadedFiles: downloadedFilesState.downloadedFiles,
				workspaceFiles,
				authUsernameOrEmail,
				pendingMemoryRead: forcedMemoryBarrierFailed
					? false
					: session.pendingMemoryRead,
				forceMemoryContent,
				memoryFile: session.memoryFile,
				extractDataMemoryFile: session.extractDataMemoryFile,
				pinnedMemoryContent: session.pinnedMemoryContent,
				screenshotToolObservations: session.screenshotToolObservations,
				currentPageScreenshotIncludedAsImagePart: Boolean(
					preStepScreenshotDataUrl,
				),
				validatorFeedback: input.validatorFeedback,
			}),
	);
	if (input.finalizationInstruction) {
		payloadState.payload.remainingSteps = 0;
		payloadState.payload.maxStepFinalization = true;
	}
	session.pendingMemoryRead = payloadState.pendingMemoryRead;
	session.downloadedFileSignatures = downloadedFilesState.fileSignatures;
	session.downloadedNewFilePaths = downloadedFilesState.newFilePaths;
	const firstTokenEstimateStartedAt = Date.now();
	payloadState.payload.latestUserPromptTokenCount = deps.estimateTokenCount(
		yaml.dump(payloadState.payload),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "estimateTokenCount:initial",
		durationMs: Date.now() - firstTokenEstimateStartedAt,
		detail: `tokens=${payloadState.payload.latestUserPromptTokenCount}`,
	});

	const fittedPrompt = await timeStateExtractionPhase(
		{
			stepNumber: input.stepNumber,
			phase: "fitStepPromptToBudget",
			detail: () =>
				`history_messages=${history.length} screenshot_captures=${session.screenshotToolSignalCaptures.length} image_part=${preStepScreenshotDataUrl ? "yes" : "no"}`,
		},
		async () =>
			fitStepPromptToBudget({
				llmOptions: input.llmOptions,
				systemPrompt: deps.getExecutorSystem({
					excludedWebsiteToolNames: session.excludedWebsiteToolNames,
					currentUrl,
					websiteToolResultsAvailable:
						configFeatureFlags.websiteAPIficationTools &&
						session.websiteToolResults.length > 0,
					activeWebsiteToolGuidance:
						session.activeWebsiteToolGuidance,
					...executorPromptOptions,
				}),
				history,
				payload: payloadState.payload,
				buildStepMessages: (params) => {
					const baseMessages = deps.buildStepMessages(params);
					if (!input.finalizationInstruction) {
						return baseMessages;
					}
					return buildMaxStepFinalizationMessages({
						messages: baseMessages,
						finalizationInstruction: input.finalizationInstruction,
					});
				},
				estimateTokenCount: deps.estimateTokenCount,
				screenshotToolSignalCaptures:
					session.screenshotToolSignalCaptures,
				currentPageScreenshotDataUrl:
					preStepScreenshotDataUrl || undefined,
			}),
	);
	payloadState.payload = fittedPrompt.payload;
	session.screenshotToolSignalCaptures =
		fittedPrompt.screenshotToolSignalCaptures;
	preStepScreenshotDataUrl = fittedPrompt.currentPageScreenshotDataUrl || "";
	const finalTokenEstimateStartedAt = Date.now();
	payloadState.payload.latestUserPromptTokenCount = deps.estimateTokenCount(
		yaml.dump(payloadState.payload),
	);
	logStateExtractionPhase({
		stepNumber: input.stepNumber,
		phase: "estimateTokenCount:final",
		durationMs: Date.now() - finalTokenEstimateStartedAt,
		detail: `tokens=${payloadState.payload.latestUserPromptTokenCount}`,
	});
	const messages = fittedPrompt.messages;

	session.previousStepTabs = openTabs;
	const latestUserPromptTokenCount = Number(
		payloadState.payload.latestUserPromptTokenCount ?? 0,
	);

	return {
		prompt: {
			messages,
			payload: payloadState.payload,
		},
		artifacts: {
			preStepScreenshotDataUrl: preStepScreenshotDataUrl || undefined,
		},
		context: {
			current_url: currentUrl,
			open_tabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
			valid_bids_count: validBids.length,
			latest_user_prompt_token_count: latestUserPromptTokenCount,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGeneratedActionsInput(input: unknown): unknown {
	if (Array.isArray(input)) {
		return input;
	}
	if (isRecord(input)) {
		if (Array.isArray(input.tools)) return input.tools;
		if (Array.isArray(input.actions)) return input.actions;
	}
	return input;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStaleContextNodeError(message: string): boolean {
	return (
		message.includes("Could not find node with given id") ||
		message.includes("Node does not have a layout object") ||
		message.includes("Could not find object with given id")
	);
}

export async function browse(
	deps: CoreDeps,
	input: BrowseInput,
): Promise<BrowseResult> {
	const session = getSessionOrThrow(deps, input.port);
	const normalizedInput = normalizeGeneratedActionsInput(
		input.generatedActions,
	);
	const additionalInteractionErrors: string[] = [];
	const normalizedActions =
		input.generatedActionsAreNormalized && Array.isArray(normalizedInput)
			? {
					actions: normalizedInput as Action[],
					diagnostics: [],
				}
			: (deps.normalizeActionListWithDiagnostics?.(normalizedInput) ?? {
					actions: deps.normalizeActionList(normalizedInput),
					diagnostics: [],
				});
	const actions = normalizedActions.actions;
	for (const diagnostic of normalizedActions.diagnostics) {
		additionalInteractionErrors.push(`action_normalization: ${diagnostic}`);
	}

	let openTabs: Tab[] = session.previousStepTabs ?? [];
	try {
		openTabs = await deps.listTabs(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(open_tabs:before): ${toErrorMessage(error)}`,
		);
	}
	let currentUrlBeforeActions = "";
	try {
		currentUrlBeforeActions = await deps.getCurrentURL(session.browser);
	} catch {
		currentUrlBeforeActions = "";
	}
	const protectAuthContext = shouldProtectAuthContext(session);
	const domOptions = {
		includeNonClickableIds: true,
		redactInputBids: protectAuthContext
			? [...(session.authTakeover?.protectedBids || [])]
			: [],
		redactPasswordInputs: protectAuthContext,
	};
	let simplifiedDomBeforeActions = input.simplifiedDom;
	if (actions.some((action) => action.type === "extract_data")) {
		try {
			simplifiedDomBeforeActions = await deps.getSimplifiedDOM(
				session.browser,
				{ ...domOptions, preserveFullHrefs: true },
			);
		} catch (error) {
			additionalInteractionErrors.push(
				`context(html:before_extract_data): ${toErrorMessage(error)}`,
			);
		}
	}

	let execution: Awaited<ReturnType<CoreDeps["executeActions"]>>;
	try {
		execution = await deps.executeActions({
			b: session.browser,
			actions,
			openTabs,
			memoryFile: session.memoryFile,
			extractDataMemoryFile: session.extractDataMemoryFile,
			fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
			userActionBehavior: deps.userActionBehavior,
			onUserActionRequired: deps.onUserActionRequired,
			requestAgentTakeover: deps.requestAgentTakeover,
			waitForAutomationPermission: deps.waitForAutomationPermission,
			excludedWebsiteToolNames: session.excludedWebsiteToolNames,
			stepNumber: input.stepNumber,
			currentUrl: currentUrlBeforeActions,
			userTask: input.userTask,
			simplifiedDom: simplifiedDomBeforeActions,
			dataExtractionLLMOptions: input.dataExtractionLLMOptions,
			recordModelInvocation: input.recordModelInvocation,
			downloadedFiles: input.promptDownloadedFiles,
			workspaceFiles: input.promptWorkspaceFiles,
			memoryContentAvailable: input.memoryContentAvailable,
			websiteToolResultsAvailable:
				configFeatureFlags.websiteAPIficationTools &&
				session.websiteToolResults.length > 0,
			extractDataResultsFromSnapshot: deps.extractDataResultsFromSnapshot,
			dataExtractionCoordinator: session.dataExtractionCoordinator,
			stepBaseIndex:
				typeof input.stepNumber === "number"
					? Math.max(0, input.stepNumber)
					: undefined,
			attemptAutomatedAuthTakeover: async (authInput) =>
				await attemptAutomatedAuthTakeover({
					deps,
					browser: session.browser,
					sessionAuth: session.authTakeover,
					stepBaseIndex: authInput.stepBaseIndex,
				}),
		});
	} catch (error) {
		if (input.allowFatalActionErrors) {
			throw error;
		}
		additionalInteractionErrors.push(
			`execute_actions: ${toErrorMessage(error)}`,
		);
		execution = {
			pendingMemoryRead: false,
			interactionErrors: [],
			toolObservations: [],
			pendingPlanRegeneration: false,
			screenshotToolObservations: [],
			screenshotToolCaptures: [],
			authTakeoverAttempts: [],
			returnedResult: undefined,
			userTakeover: undefined,
		};
	}

	session.pendingMemoryRead =
		session.pendingMemoryRead || execution.pendingMemoryRead;
	session.previousToolObservations = execution.toolObservations ?? [];
	if (execution.websiteToolOutcome) {
		session.activeWebsiteToolGuidance =
			execution.websiteToolOutcome.activeGuidance;
		if (
			execution.websiteToolOutcome.status === "success" &&
			execution.websiteToolOutcome.result !== undefined
		) {
			session.websiteToolResults = [
				...session.websiteToolResults.filter(
					(entry) =>
						entry.toolName !==
						execution.websiteToolOutcome?.toolName,
				),
				{
					toolName: execution.websiteToolOutcome.toolName,
					result: execution.websiteToolOutcome.result,
				},
			];
		}
	}
	session.screenshotToolObservations = execution.screenshotToolObservations;
	session.screenshotToolSignalCaptures = execution.screenshotToolCaptures;

	let currentUrl = "";
	try {
		currentUrl = await deps.getCurrentURL(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(current_url): ${toErrorMessage(error)}`,
		);
	}

	let nextOpenTabs: Tab[] = openTabs;
	try {
		nextOpenTabs = await deps.listTabs(session.browser);
	} catch (error) {
		additionalInteractionErrors.push(
			`context(open_tabs:after): ${toErrorMessage(error)}`,
		);
	}

	let newlyOpenedTabs = deps.getNewlyOpenedTabs(
		session.previousStepTabs,
		nextOpenTabs,
	);
	let skippedBlankDownloadTab = false;
	if ((input.autoSwitchToNewTab ?? true) && newlyOpenedTabs.length > 0) {
		const firstNewTab = firstMeaningfulNewTab(newlyOpenedTabs);
		if (firstNewTab) {
			const currentTabTargetId =
				nextOpenTabs.find((tab) => tab.url === currentUrl)?.targetId ??
				session.browser.currentTargetId;
			if (currentTabTargetId !== firstNewTab.targetId) {
				console.log(
					`Auto-switching to first newly opened tab after actions: "${deps.formatTabTitle(firstNewTab)}"`,
				);
				await deps.switchTab(session.browser, firstNewTab.targetId);
				currentUrl = await deps.getCurrentURL(session.browser);
				nextOpenTabs = await deps.listTabs(session.browser);
				newlyOpenedTabs = deps.getNewlyOpenedTabs(
					session.previousStepTabs,
					nextOpenTabs,
				);
			}
		} else {
			const restored = await restoreSourceTabAfterBlankDownloadTab({
				deps,
				session,
				openTabs: nextOpenTabs,
				currentUrl,
				newlyOpenedTabs,
			});
			currentUrl = restored.currentUrl;
			skippedBlankDownloadTab = restored.restored;
			if (restored.restored) {
				nextOpenTabs = await deps.listTabs(session.browser);
				newlyOpenedTabs = deps.getNewlyOpenedTabs(
					session.previousStepTabs,
					nextOpenTabs,
				);
			}
		}
	}

	let currentTab = 0;
	try {
		currentTab = await deps.resolveCurrentTabIndex({
			b: session.browser,
			openTabs: nextOpenTabs,
			currentUrl,
		});
	} catch (error) {
		additionalInteractionErrors.push(
			`context(current_tab): ${toErrorMessage(error)}`,
		);
	}
	if (
		!Number.isInteger(currentTab) ||
		currentTab < 0 ||
		currentTab >= nextOpenTabs.length
	) {
		currentTab = 0;
	}
	if (!currentUrl) {
		currentUrl =
			nextOpenTabs[currentTab]?.url || nextOpenTabs[0]?.url || "";
	}
	let dom = "";
	let validBids: string[] = [];
	try {
		dom = await deps.getSimplifiedDOM(session.browser, domOptions);
		validBids = deps.extractValidBids(dom);
	} catch (error) {
		const message = toErrorMessage(error);
		if (message.includes("bad bids") || message.includes("valid_bids")) {
			additionalInteractionErrors.push(`context(valid_bids): ${message}`);
		} else {
			additionalInteractionErrors.push(`context(html): ${message}`);
		}
	}
	if (dom && validBids.length === 0) {
		try {
			validBids = deps.extractValidBids(dom);
		} catch (error) {
			additionalInteractionErrors.push(
				`context(valid_bids): ${toErrorMessage(error)}`,
			);
		}
	}

	const downloadedFilesState = buildDownloadedFilesPayload({
		downloadDir: session.browser.downloadDir,
		downloadRootDir: session.browser.downloadRootDir,
		fileWorkspaceRoot: session.browser.fileWorkspaceRoot,
		previousFileSignatures: session.downloadedFileSignatures,
		previousNewFilePaths: session.downloadedNewFilePaths,
	});
	if (skippedBlankDownloadTab && downloadedFilesState.newFilePaths.size > 0) {
		additionalInteractionErrors.push(BLANK_DOWNLOAD_TAB_CONTEXT_NOTE);
	}
	const interactionErrors = [
		...execution.interactionErrors,
		...additionalInteractionErrors,
		...session.dataExtractionCoordinator.drainErrors(),
	];
	const normalizedUserTakeover = execution.userTakeover
		? {
				reason: execution.userTakeover.reason,
				category: normalizeUserTakeoverCategory({
					category: execution.userTakeover.category,
					reason: execution.userTakeover.reason,
				}),
			}
		: undefined;
	session.previousInteractionErrors = interactionErrors;
	session.previousStepTabs = nextOpenTabs;
	session.downloadedFileSignatures = downloadedFilesState.fileSignatures;
	session.downloadedNewFilePaths = downloadedFilesState.newFilePaths;

	return {
		execution: {
			pending_memory_read: execution.pendingMemoryRead,
			pending_plan_regeneration: execution.pendingPlanRegeneration,
			returned_result: execution.returnedResult,
			interaction_errors: interactionErrors,
			screenshot_tool_observations: execution.screenshotToolObservations,
			screenshot_tool_captures: execution.screenshotToolCaptures,
			auth_takeover_attempts: execution.authTakeoverAttempts,
			user_takeover: normalizedUserTakeover,
		},
		context: {
			current_url: currentUrl,
			open_tabs: nextOpenTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
			downloaded_files: downloadedFilesState.downloadedFiles,
			html: dom,
			valid_bids: validBids,
		},
	};
}

export async function processStepModelOutput(
	deps: CoreDeps,
	input: ProcessModelStepOutputInput,
): Promise<ProcessModelStepOutputResult> {
	const downloadedFiles = Array.isArray(input.promptPayload.downloadedFiles)
		? input.promptPayload.downloadedFiles.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	const processedStep = processModelStepOutput(input.rawStepOutput);
	const step = canonicalizeStepDownloadedFilePaths({
		step: processedStep.step,
		downloadedFiles,
	});
	const normalizedPlanUpdates = normalizePlanStepUpdates(
		featureFlags.enablePlanning ? step.previousStepPlanUpdate : [],
		input.planLength ?? 0,
	);
	step.previousStepPlanUpdate = normalizedPlanUpdates;
	if (normalizedPlanUpdates.length > 0 && input.sessionPlanStatuses) {
		applyPlanStepUpdates(input.sessionPlanStatuses, normalizedPlanUpdates);
	}
	if (input.allowModelResultCompletion === false && step.done) {
		step.done = false;
		delete step.result;
	}
	const executorPromptOptions = { provider: input.executorProvider };
	const assistant = formatStepForPrompt(step, executorPromptOptions);
	const priorHistoryMessages = buildHistoryMessagesFromFullStepHistory(
		input.stepsHistory,
	);
	const historyEntry: StepHistoryEntry = {
		payload: stripPayloadForHistory({
			payload: input.promptPayload,
			keepPlanInHistory: input.keepPlanInHistory ?? false,
		}),
		assistant,
		...(shouldUseExecutorReasoningTraceContext(executorPromptOptions) &&
		input.reasoningTokens?.trim()
			? { reasoningTokens: input.reasoningTokens.trim() }
			: {}),
	};
	input.stepsHistory.push(historyEntry);

	const successVerification =
		step.done && deps.defaultSuccessVerifierLLMOptions
			? await (deps.verifyTaskSuccess ?? defaultVerifyTaskSuccess)({
					task:
						typeof input.promptPayload.task === "string"
							? input.promptPayload.task
							: "",
					executedSteps: input.stepsHistory.length,
					maxSteps:
						typeof input.promptPayload.maxSteps === "number"
							? input.promptPayload.maxSteps
							: undefined,
					finalStep: step,
					finalPromptPayload: input.promptPayload,
					historyMessages: priorHistoryMessages,
					llmOptions: deps.defaultSuccessVerifierLLMOptions,
					caller: "processStepModelOutput:verifySuccess",
					onTrace: input.recordModelInvocation,
				})
			: undefined;
	return {
		step,
		history_entry: historyEntry,
		successful: successVerification?.success === true,
		successVerification,
	};
}

export async function processModelOutputAndBrowse(
	deps: CoreDeps,
	port: number,
	input: StepInputByMode<"process_model_step_output">,
): Promise<{
	step: ProcessModelStepOutputResult["step"];
	successful: boolean;
	successVerification?: ProcessModelStepOutputResult["successVerification"];
	browse?: BrowseResult;
}> {
	const preprocessResult = await processStepModelOutput(deps, {
		...input,
		allowModelResultCompletion: false,
	});
	if (preprocessResult.step.done) {
		return {
			step: preprocessResult.step,
			successful: preprocessResult.successful,
			successVerification: preprocessResult.successVerification,
		};
	}

	const result = await browse(deps, {
		port,
		generatedActions: preprocessResult.step.actions as Action[],
		generatedActionsAreNormalized: true,
		userTask:
			typeof input.promptPayload.task === "string"
				? input.promptPayload.task
				: undefined,
		simplifiedDom:
			typeof input.promptPayload.html === "string"
				? input.promptPayload.html
				: undefined,
		dataExtractionLLMOptions: input.dataExtractionLLMOptions,
		recordModelInvocation: input.recordModelInvocation,
		stepNumber: input.stepNumber,
		allowFatalActionErrors: input.allowFatalActionErrors,
		autoSwitchToNewTab: input.autoSwitchToNewTab,
		promptDownloadedFiles: Array.isArray(
			input.promptPayload.downloadedFiles,
		)
			? input.promptPayload.downloadedFiles.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [],
		promptWorkspaceFiles: Array.isArray(input.promptPayload.workspaceFiles)
			? input.promptPayload.workspaceFiles.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [],
		memoryContentAvailable:
			typeof input.promptPayload.memoryContent === "string",
	});

	if (typeof result.execution.returned_result === "string") {
		preprocessResult.step.done = true;
		preprocessResult.step.result = result.execution.returned_result;
		const successVerification = deps.defaultSuccessVerifierLLMOptions
			? await (deps.verifyTaskSuccess ?? defaultVerifyTaskSuccess)({
					task:
						typeof input.promptPayload.task === "string"
							? input.promptPayload.task
							: "",
					executedSteps: input.stepsHistory.length,
					maxSteps:
						typeof input.promptPayload.maxSteps === "number"
							? input.promptPayload.maxSteps
							: undefined,
					finalStep: preprocessResult.step,
					finalPromptPayload: input.promptPayload,
					historyMessages: buildHistoryMessagesFromFullStepHistory(
						input.stepsHistory,
					),
					llmOptions: deps.defaultSuccessVerifierLLMOptions,
					caller: "processModelOutputAndBrowse:verifyMemoryReturnResults",
					onTrace: input.recordModelInvocation,
				})
			: undefined;
		return {
			step: preprocessResult.step,
			successful: successVerification?.success === true,
			successVerification,
			browse: result,
		};
	}

	return {
		step: preprocessResult.step,
		successful: false,
		browse: result,
	};
}

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"create_prompt_for_step">,
): Promise<StepResultByMode<"create_prompt_for_step">>;

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"browse">,
): Promise<StepResultByMode<"browse">>;

export async function step(
	deps: CoreDeps,
	input: StepInputByMode<"process_model_step_output">,
): Promise<StepResultByMode<"process_model_step_output">>;

export async function step(
	deps: CoreDeps,
	input: StepInput,
): Promise<StepResult> {
	if (input.mode === "create_prompt_for_step") {
		const result = await createPromptForStep(deps, input);
		return { mode: input.mode, ...result };
	}

	if (input.mode === "process_model_step_output") {
		const result = await processStepModelOutput(deps, input);
		return { mode: input.mode, ...result };
	}

	const result = await browse(deps, input);
	return { mode: input.mode, ...result };
}
