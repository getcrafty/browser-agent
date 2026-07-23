import type { LLMOptions } from "../agents/types.js";
import type { PreprocessStageLLMs } from "../core/types.js";
import type { Config, StageLLMOptions } from "../utils.js";

function readEnvString(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveLLMOptionsFromEnv(options: LLMOptions): LLMOptions {
	if (options.provider !== "vllm") {
		return options;
	}
	return {
		...options,
		endpointUrl: options.endpointUrl || readEnvString("VLLM_BASE_URL"),
	};
}

export function resolvePreprocessStageLLMsFromEnv(
	stageLLMs: PreprocessStageLLMs,
): PreprocessStageLLMs {
	return {
		...(stageLLMs.workflowPlanner
			? {
					workflowPlanner: resolveLLMOptionsFromEnv(
						stageLLMs.workflowPlanner,
					),
				}
			: {}),
		findTargetURL: resolveLLMOptionsFromEnv(stageLLMs.findTargetURL),
		dismissCookieBanner: resolveLLMOptionsFromEnv(
			stageLLMs.dismissCookieBanner,
		),
		createPlan: resolveLLMOptionsFromEnv(stageLLMs.createPlan),
		createChecklist: resolveLLMOptionsFromEnv(
			stageLLMs.createChecklist ?? stageLLMs.createPlan,
		),
		preExecutionDomPruning: resolveLLMOptionsFromEnv(
			stageLLMs.preExecutionDomPruning,
		),
	};
}

export function resolveStageLLMsFromEnv(
	stageLLMs: StageLLMOptions,
): StageLLMOptions {
	return {
		workflowPlanner: resolveLLMOptionsFromEnv(
			stageLLMs.workflowPlanner ?? stageLLMs.createPlan,
		),
		findTargetURL: resolveLLMOptionsFromEnv(stageLLMs.findTargetURL),
		dismissCookieBanner: resolveLLMOptionsFromEnv(
			stageLLMs.dismissCookieBanner,
		),
		createPlan: resolveLLMOptionsFromEnv(stageLLMs.createPlan),
		createChecklist: resolveLLMOptionsFromEnv(
			stageLLMs.createChecklist ?? stageLLMs.createPlan,
		),
		preExecutionDomPruning: resolveLLMOptionsFromEnv(
			stageLLMs.preExecutionDomPruning,
		),
		runAgent: resolveLLMOptionsFromEnv(stageLLMs.runAgent),
		dataExtraction: resolveLLMOptionsFromEnv(stageLLMs.dataExtraction),
		verifySuccess: resolveLLMOptionsFromEnv(stageLLMs.verifySuccess),
	};
}

export function resolveConfigFromEnv(config: Config): Config {
	return {
		...config,
		stageLLMs: resolveStageLLMsFromEnv(config.stageLLMs),
	};
}
