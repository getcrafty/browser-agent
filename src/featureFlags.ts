export const featureFlags = {
	// Controls initial planning, replanning, and plan-related executor prompt/context fields.
	enablePlanning: false,
	// Replaces vertically distant simplified-DOM subtrees with scroll-to-reveal placeholders.
	hideOffscreenDomContent: false,
	// Controls exposing prune/unprune live-DOM actions in executor prompts and execution.
	domPruneActionTools: false,
	// Controls replacing omitted executor thinking with structured previous-step action context fields.
	executorActionContextFields: true,
	// Replaces executor action-context fields with prior reasoning traces for non-OpenAI executor models.
	executorReasoningTraceContext: false,
	// Sends full/diff DOM context and retains prior assistant reasoning for cacheable executor trajectories.
	incrementalDomContext: false,
};
