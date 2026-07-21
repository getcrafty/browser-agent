import type {
	CoreDeps,
	PreprocessTaskInput,
	PreprocessTaskResult,
} from "./types.js";
import { SessionNotFoundError } from "./session.js";
import { type PlanProgressStatus } from "./run-agent-loop-state.js";
import { shouldLogTimingDuration } from "../timing-logs.js";
import { featureFlags } from "../featureFlags.js";

const CREATE_PLAN_MAX_ATTEMPTS = 2;

function getSessionOrThrow(deps: CoreDeps, port: number) {
	const session = deps.registry.get(port);
	if (!session) {
		throw new SessionNotFoundError(port);
	}
	return session;
}

function createEmptyDomPruningResult(): PreprocessTaskResult["dom_pruning"] {
	return {
		thinking: "",
		excluded_non_clickable_ids: [],
		token_usage: {
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		},
	};
}

function formatPreprocessLogTimestamp(date: Date): string {
	const pad2 = (value: number) => String(value).padStart(2, "0");
	return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} - ${pad2(
		date.getHours(),
	)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

async function measureLoggedStage<T>(params: {
	port: number;
	stage: string;
	log?: (message: string) => void;
	run: () => Promise<T>;
}): Promise<T> {
	const startedAt = Date.now();
	try {
		return await params.run();
	} finally {
		const durationMs = Date.now() - startedAt;
		if (params.log && shouldLogTimingDuration(durationMs)) {
			const timestamp = formatPreprocessLogTimestamp(new Date());
			params.log(
				`[${timestamp}] [port ${params.port}] [preprocessTask] ${params.stage} took ${durationMs}ms`,
			);
		}
	}
}

function getInvalidPlanMessage(plan: unknown): string | null {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
		return `expected YAML object with steps: string[], got ${plan === null ? "null" : Array.isArray(plan) ? "array" : typeof plan}`;
	}

	if (!("steps" in plan)) {
		return `missing "steps" field; received keys: ${Object.keys(plan).join(", ") || "(none)"}`;
	}

	const steps = (plan as { steps?: unknown }).steps;
	if (!Array.isArray(steps)) {
		return `"steps" must be an array, got ${steps === null ? "null" : Array.isArray(steps) ? "array" : typeof steps}`;
	}

	const invalidIndex = steps.findIndex((step) => typeof step !== "string");
	if (invalidIndex >= 0) {
		return `"steps[${invalidIndex}]" must be a string, got ${typeof steps[invalidIndex]}`;
	}

	return null;
}

async function createPlanWithRetry(params: {
	deps: CoreDeps;
	input: PreprocessTaskInput;
	dom: string;
	currentUrl: string;
	memoryAvailable: boolean;
	preparedPasteFiles: string[];
}): Promise<{ steps: string[] }> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= CREATE_PLAN_MAX_ATTEMPTS; attempt++) {
		let plan: unknown;

		try {
			plan = await measureLoggedStage({
				port: params.input.port,
				stage: "createPlan",
				log: params.input.log,
				run: async () =>
					await params.deps.createPlan(
						params.input.userTask,
						params.dom,
						params.input.stageLLMs.createPlan,
						{
							onTrace: params.input.recordModelInvocation,
							meta: {
								planAttempt: attempt,
								phase: "initial_plan",
							},
						},
						{
							memoryAvailable: params.memoryAvailable,
							preparedPasteFiles: params.preparedPasteFiles,
							currentUrl: params.currentUrl,
							agentTakeoverAvailable:
								params.deps.featureFlags.agentTakeoverTool ===
								true,
						},
					),
			});
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));
			if (attempt < CREATE_PLAN_MAX_ATTEMPTS) {
				console.warn(
					`[preprocessTask] createPlan attempt ${attempt} failed: ${lastError.message}. Retrying...`,
				);
				continue;
			}
			break;
		}

		const invalidPlanMessage = getInvalidPlanMessage(plan);
		if (!invalidPlanMessage) {
			return plan as { steps: string[] };
		}

		lastError = new Error(
			`Invalid createPlan response: ${invalidPlanMessage}`,
		);
		if (attempt < CREATE_PLAN_MAX_ATTEMPTS) {
			console.warn(
				`[preprocessTask] createPlan attempt ${attempt} returned an invalid plan schema: ${invalidPlanMessage}. Retrying...`,
			);
		}
	}

	throw new Error(
		`Invalid createPlan response after ${CREATE_PLAN_MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown planner error"}`,
	);
}

export async function preprocessTask(
	deps: CoreDeps,
	input: PreprocessTaskInput,
): Promise<PreprocessTaskResult> {
	const session = getSessionOrThrow(deps, input.port);

	async function findTargetURL(): Promise<string> {
		return await measureLoggedStage({
			port: input.port,
			stage: "findTargetURL",
			log: input.log,
			run: async () =>
				await deps.findTargetURL(
					input.userTask,
					input.stageLLMs.findTargetURL,
					{
						onTrace: input.recordModelInvocation,
					},
				),
		});
	}

	async function dismissCookieBannerIfEnabled(): Promise<void> {
		if (!deps.featureFlags.dismissCookieBanner) {
			return;
		}
		await measureLoggedStage({
			port: input.port,
			stage: "dismissCookieBanner",
			log: input.log,
			run: async () =>
				await deps.dismissCookieBanner(
					session.browser,
					1,
					input.stageLLMs.dismissCookieBanner,
					{
						onTrace: input.recordModelInvocation,
					},
				),
		});
	}

	async function navigateAndGetPlanningDom(url: string): Promise<string> {
		await deps.navigateBrowser(session.browser, url);
		await dismissCookieBannerIfEnabled();
		return await deps.getSimplifiedDOM(session.browser, {
			...(featureFlags.removeHrefsFromInputContext
				? { omitHrefs: true }
				: {}),
		});
	}

	const explicitStartUrl = input.url?.trim();
	const targetURL = explicitStartUrl || (await findTargetURL());
	let planningDom: string;
	if (explicitStartUrl) {
		await dismissCookieBannerIfEnabled();
		planningDom = await deps.getSimplifiedDOM(session.browser, {
			...(featureFlags.removeHrefsFromInputContext
				? { omitHrefs: true }
				: {}),
		});
	} else {
		planningDom = await navigateAndGetPlanningDom(targetURL);
	}
	const initialPlanOverride = normalizeInitialPlanOverride(
		input.initialPlanOverride,
	);
	if (initialPlanOverride) {
		console.log(
			`[preprocessTask] Using provided initial plan override (${initialPlanOverride.length} steps).`,
		);
	}
	await input.savePlanningDom?.(planningDom);
	const planningEnabled = featureFlags.enablePlanning;
	const plan = !planningEnabled
		? { steps: [] }
		: initialPlanOverride
			? { steps: initialPlanOverride }
			: await createPlanWithRetry({
					deps,
					input,
					dom: planningDom,
					currentUrl: targetURL,
					memoryAvailable:
						typeof session.pinnedMemoryContent === "string",
					preparedPasteFiles: session.preparedPasteFiles,
				});

	const domPruning = createEmptyDomPruningResult();
	if (deps.featureFlags.preExecutionDomPruning) {
		const prunerDom = await deps.getSimplifiedDOM(session.browser, {
			includeNonClickableIds: true,
			...(featureFlags.removeHrefsFromInputContext
				? { omitHrefs: true }
				: {}),
		});
		await input.savePreExecutionPrunerDom?.(prunerDom);
		const pruneDecision = await measureLoggedStage({
			port: input.port,
			stage: "preExecutionDomPruning",
			log: input.log,
			run: async () =>
				await deps.choosePreExecutionDomNonClickableIdsToExclude({
					browser: session.browser,
					task: input.userTask,
					plan: plan.steps,
					dom: prunerDom,
					llmOptions: input.stageLLMs.preExecutionDomPruning,
					onTrace: input.recordModelInvocation,
					traceMeta: {
						phase: "pre_execution_dom_pruning",
						pruneAttempt: 1,
					},
				}),
		});
		domPruning.thinking = pruneDecision.thinking;
		domPruning.excluded_non_clickable_ids =
			pruneDecision.excludedNonClickableIds;
		domPruning.token_usage = pruneDecision.tokenUsage;
		if (pruneDecision.excludedNonClickableIds.length > 0) {
			await deps.pruneLiveDomByIdentifiers(session.browser, {
				nonClickableIds: pruneDecision.excludedNonClickableIds,
			});
		}
	}

	const finalUrl = await deps.getCurrentURL(session.browser);
	const openTabs = await deps.listTabs(session.browser);
	const currentTab = await deps.resolveCurrentTabIndex({
		b: session.browser,
		openTabs,
		currentUrl: finalUrl,
	});

	session.activePlan = [...plan.steps];
	session.planStatuses = plan.steps.map((): PlanProgressStatus => "TODO");
	session.keepPlanInHistory = planningEnabled;
	session.recentExecutions = [];
	session.lastTask = input.userTask;
	session.pendingMemoryRead = false;
	session.previousInteractionErrors = [];
	session.previousToolObservations = [];
	session.screenshotToolObservations = [];
	session.screenshotToolSignalCaptures = [];
	session.activeWebsiteToolGuidance = undefined;
	session.websiteToolResults = [];
	session.previousStepTabs = openTabs;
	session.downloadedFileSignatures = null;
	session.lastActionSignatureWithUrl = null;
	session.lastProgressSignature = null;
	session.sameActionSignatureStreak = 0;
	session.noProgressStreak = 0;

	return {
		target_url: targetURL,
		final_url: finalUrl,
		plan: plan.steps,
		dom_pruning: domPruning,
		context: {
			current_url: finalUrl,
			open_tabs: openTabs.map((tab) => deps.formatTabTitle(tab)),
			current_tab: currentTab,
		},
		execution_overrides: {
			initialPlanOverride: !!initialPlanOverride,
		},
	};
}

function normalizeInitialPlanOverride(
	steps: string[] | undefined,
): string[] | null {
	if (!Array.isArray(steps)) {
		return null;
	}
	const normalized = steps
		.filter((step): step is string => typeof step === "string")
		.map((step) => step.trim())
		.filter(Boolean);
	return normalized.length > 0 ? normalized : null;
}
