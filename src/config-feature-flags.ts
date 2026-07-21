export interface ConfigFeatureFlags {
	/** Attach a fresh full-page screenshot to the latest executor prompt before each step. */
	preStepScreenshotInLatestUserPrompt: boolean;
	/** Let the executor pause and request manual interaction from the user. */
	userTakeoverTool: boolean;
	/** Let the runtime attempt authentication with configured encrypted credentials. */
	authTakeover: boolean;
	/** Let the executor delegate bounded local or workspace file work to an agent. */
	agentTakeoverTool: boolean;
	/** Run automatic cookie-banner dismissal while preparing the initial page. */
	dismissCookieBanner: boolean;
	/** Prune task-irrelevant DOM content before planning begins. */
	preExecutionDomPruning: boolean;
	/** Expose site-specific website tools and their results to the executor. */
	websiteAPIficationTools: boolean;
	/** Skip the post-step settling delay when every action is agent-local. */
	optimizeExecutorStepDelays: boolean;
	/** Insert text in bulk for safe fields instead of typing one character at a time. */
	optimizeTextInput: boolean;
	/** Hide raw href attributes and their URL values from model-facing DOM context. */
	removeHrefsFromInputContext: boolean;
}

export const configFeatureFlags: ConfigFeatureFlags = {
	preStepScreenshotInLatestUserPrompt: true,
	userTakeoverTool: true,
	authTakeover: false,
	agentTakeoverTool: false,
	dismissCookieBanner: true,
	preExecutionDomPruning: true,
	websiteAPIficationTools: false,
	optimizeExecutorStepDelays: false,
	optimizeTextInput: false,
	removeHrefsFromInputContext: false,
};

export function mergeConfigFeatureFlags(
	base: ConfigFeatureFlags,
	overrides: Partial<ConfigFeatureFlags> = {},
): ConfigFeatureFlags {
	return {
		...base,
		...(overrides.preStepScreenshotInLatestUserPrompt !== undefined
			? {
					preStepScreenshotInLatestUserPrompt:
						overrides.preStepScreenshotInLatestUserPrompt,
				}
			: {}),
		...(overrides.userTakeoverTool !== undefined
			? { userTakeoverTool: overrides.userTakeoverTool }
			: {}),
		...(overrides.authTakeover !== undefined
			? { authTakeover: overrides.authTakeover }
			: {}),
		...(overrides.agentTakeoverTool !== undefined
			? { agentTakeoverTool: overrides.agentTakeoverTool }
			: {}),
		...(overrides.dismissCookieBanner !== undefined
			? { dismissCookieBanner: overrides.dismissCookieBanner }
			: {}),
		...(overrides.preExecutionDomPruning !== undefined
			? { preExecutionDomPruning: overrides.preExecutionDomPruning }
			: {}),
		...(overrides.websiteAPIficationTools !== undefined
			? { websiteAPIficationTools: overrides.websiteAPIficationTools }
			: {}),
		...(overrides.optimizeExecutorStepDelays !== undefined
			? {
					optimizeExecutorStepDelays: overrides.optimizeExecutorStepDelays,
				}
			: {}),
		...(overrides.optimizeTextInput !== undefined
			? { optimizeTextInput: overrides.optimizeTextInput }
			: {}),
		...(overrides.removeHrefsFromInputContext !== undefined
			? {
					removeHrefsFromInputContext:
						overrides.removeHrefsFromInputContext,
				}
			: {}),
	};
}

export function setConfigFeatureFlags(
	flags: Partial<ConfigFeatureFlags>,
): void {
	if (flags.preStepScreenshotInLatestUserPrompt !== undefined) {
		configFeatureFlags.preStepScreenshotInLatestUserPrompt =
			flags.preStepScreenshotInLatestUserPrompt;
	}
	if (flags.userTakeoverTool !== undefined) {
		configFeatureFlags.userTakeoverTool = flags.userTakeoverTool;
	}
	if (flags.authTakeover !== undefined) {
		configFeatureFlags.authTakeover = flags.authTakeover;
	}
	if (flags.agentTakeoverTool !== undefined) {
		configFeatureFlags.agentTakeoverTool = flags.agentTakeoverTool;
	}
	if (flags.dismissCookieBanner !== undefined) {
		configFeatureFlags.dismissCookieBanner = flags.dismissCookieBanner;
	}
	if (flags.preExecutionDomPruning !== undefined) {
		configFeatureFlags.preExecutionDomPruning =
			flags.preExecutionDomPruning;
	}
	if (flags.websiteAPIficationTools !== undefined) {
		configFeatureFlags.websiteAPIficationTools =
			flags.websiteAPIficationTools;
	}
	if (flags.optimizeExecutorStepDelays !== undefined) {
		configFeatureFlags.optimizeExecutorStepDelays =
			flags.optimizeExecutorStepDelays;
	}
	if (flags.optimizeTextInput !== undefined) {
		configFeatureFlags.optimizeTextInput = flags.optimizeTextInput;
	}
	if (flags.removeHrefsFromInputContext !== undefined) {
		configFeatureFlags.removeHrefsFromInputContext =
			flags.removeHrefsFromInputContext;
	}
}
