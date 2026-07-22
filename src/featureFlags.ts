export const featureFlags = {
	// Controls initial planning, replanning, and plan-related executor prompt/context fields.
	enablePlanning: false,
	// Adds the catch-all executor misc-instructions section to full executor prompts.
	enableMiscInstruction: false,
	// Replaces vertically distant simplified-DOM subtrees with scroll-to-reveal placeholders.
	hideOffscreenDomContent: false,
	// Hides raw href attributes and URL values from every model-facing DOM context.
	removeHrefsFromInputContext: true,
	// Removes simplified-DOM branches that contain no semantic content beyond bid/ncid handles.
	discardEmptyBids: true,
	// Controls exposing prune/unprune live-DOM actions in executor prompts and execution.
	domPruneActionTools: false,
	// Sends full/diff DOM context and retains prior assistant reasoning for cacheable executor trajectories.
	incrementalDomContext: true,
	// Requires a top-level executor thinking field for any model reasoning.
	executorThinkingField: false,
};
