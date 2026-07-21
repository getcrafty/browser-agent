import type { StepHistoryEntry } from "../../core/types.js";

const PROMPT_ONLY_PAYLOAD_FIELDS = [
	"validBids",
	"interactionErrors",
	"screenshotToolObservations",
	"latestUserPromptTokenCount",
	"currentTab",
	"openTabs",
	"newlyOpenedTabs",
	"downloadedFiles",
	"workspaceFiles",
	"autoTabSwitchNote",
	"currentPageScreenshotIncludedAsImagePart",
	"previousAction",
	"task",
	"memoryAvailable",
	"memoryContent",
	"websiteToolResults",
	"authContext",
] as const;

export function stripDomContextFromHistoryPayload(
	payload: Record<string, unknown>,
): void {
	delete payload.html;
	delete payload.htmlContextMode;
}

function stripCommonPromptOnlyFields(
	payload: Record<string, unknown>,
	keepPlanInHistory: boolean,
): void {
	for (const field of PROMPT_ONLY_PAYLOAD_FIELDS) {
		delete payload[field];
	}
	if (!keepPlanInHistory) {
		delete payload.plan;
	}
}

export function stripPayloadForHistory(params: {
	payload: Record<string, unknown>;
	keepPlanInHistory: boolean;
	incrementalDomContextEnabled?: boolean;
	htmlContextMode?: "full" | "diff";
	stepsHistory?: StepHistoryEntry[];
}): Record<string, unknown> {
	const strippedPayload: Record<string, unknown> = { ...params.payload };
	stripCommonPromptOnlyFields(strippedPayload, params.keepPlanInHistory);
	if (!params.incrementalDomContextEnabled) {
		stripDomContextFromHistoryPayload(strippedPayload);
		return strippedPayload;
	}
	if (params.htmlContextMode === "full" && params.stepsHistory) {
		resetIncrementalDomHistoryBeforeNewAnchor(params.stepsHistory);
	}
	if (
		params.htmlContextMode !== "full" &&
		params.htmlContextMode !== "diff"
	) {
		stripDomContextFromHistoryPayload(strippedPayload);
	}
	return strippedPayload;
}

export function resetIncrementalDomHistoryBeforeNewAnchor(
	stepsHistory: StepHistoryEntry[],
): void {
	for (const entry of stepsHistory) {
		stripDomContextFromHistoryPayload(entry.payload);
	}
}
