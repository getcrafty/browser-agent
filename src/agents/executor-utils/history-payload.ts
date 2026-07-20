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
}): Record<string, unknown> {
	const strippedPayload: Record<string, unknown> = { ...params.payload };
	stripDomContextFromHistoryPayload(strippedPayload);
	stripCommonPromptOnlyFields(strippedPayload, params.keepPlanInHistory);
	return strippedPayload;
}
