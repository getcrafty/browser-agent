import { chatYAML } from "./providers/router.js";
import type { Message, LLMOptions, TargetURL, Plan } from "./types.js";
import { URL_SYSTEM, getPlanSystem } from "./prompts.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";
import type { StageModelInvocationTrace } from "./types.js";
import { featureFlags } from "../featureFlags.js";
import type { WebsiteToolActiveGuidance } from "../website-tools.js";

interface StageTraceOptions {
	onTrace?: (trace: StageModelInvocationTrace) => void;
	meta?: Record<string, unknown>;
}

export const PREPARED_MEMORY_CONTEXT_HINT =
	"Prepared workspace/file context is available to the executor through memory_read. Plan for the executor to call memory_read before searching for, opening, uploading, or reading local/workspace files online.";

export interface PlannerRuntimeContext {
	memoryAvailable?: boolean;
	agentTakeoverAvailable?: boolean;
	preparedPasteFiles?: string[];
	currentUrl?: string;
	activeWebsiteToolGuidance?: WebsiteToolActiveGuidance;
}

export function buildCreatePlanUserContent(params: {
	task: string;
	dom: string;
	runtimeContext?: PlannerRuntimeContext;
}) {
	const runtimeContext =
		params.runtimeContext?.memoryAvailable === true
			? `\n\nRuntime context:\n- ${PREPARED_MEMORY_CONTEXT_HINT}`
			: "";
	const preparedPasteFiles = Array.isArray(
		params.runtimeContext?.preparedPasteFiles,
	)
		? params.runtimeContext.preparedPasteFiles
				.filter((entry) => typeof entry === "string" && entry.trim())
				.map((entry) => entry.trim())
		: [];
	const pasteFileHint =
		preparedPasteFiles.length > 0
			? `${runtimeContext ? "" : "\n\nRuntime context:"}\n- Prepared workspace file(s) contain exact text payloads for page text fields: ${preparedPasteFiles.map((entry) => JSON.stringify(entry)).join(", ")}. Plan for the executor to use paste_file with the supplied workspace-relative path when filling a page text area; do not plan to type or regenerate the file contents.`
			: "";
	const agentTakeoverHint =
		params.runtimeContext?.agentTakeoverAvailable === true
			? `${runtimeContext || pasteFileHint ? "" : "\n\nRuntime context:"}\n- If memory_read is missing or incomplete for required workspace/local/downloaded file content, plan for the executor to call agent_takeover before continuing with browser work.`
			: "";
	return `Task: ${params.task}${runtimeContext}${pasteFileHint}${agentTakeoverHint}\n\nCurrent page HTML:\n${params.dom}`;
}

export async function findTargetURL(
	task: string,
	options: LLMOptions,
	traceOptions?: StageTraceOptions,
): Promise<string> {
	const messages: Message[] = [
		{ role: "system", content: URL_SYSTEM },
		{ role: "user", content: `Task: ${task}` },
	];

	const { data } = await chatYAML<TargetURL>(
		messages,
		options,
		"findTargetURL",
		(trace) =>
			traceOptions?.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "findTargetURL",
					trace,
					meta: traceOptions.meta,
				}),
			),
	);
	return data.url;
}

export async function createPlan(
	task: string,
	dom: string,
	options: LLMOptions,
	traceOptions?: StageTraceOptions,
	runtimeContext?: PlannerRuntimeContext,
): Promise<Plan> {
	if (!featureFlags.enablePlanning) {
		return { steps: [] };
	}

	const messages: Message[] = [
		{
			role: "system",
			content: getPlanSystem({
				currentUrl: runtimeContext?.currentUrl,
				activeWebsiteToolGuidance:
					runtimeContext?.activeWebsiteToolGuidance,
			}),
		},
		{
			role: "user",
			content: buildCreatePlanUserContent({
				task,
				dom,
				runtimeContext,
			}),
		},
	];

	const { data } = await chatYAML<Plan>(
		messages,
		options,
		"createPlan",
		(trace) =>
			traceOptions?.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "createPlan",
					trace,
					meta: traceOptions.meta,
				}),
			),
	);
	return data;
}
