import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { Browser } from "../src/browser/types.js";
import { createSession } from "../src/core/session.js";
import { SessionRegistry } from "../src/core/session-registry.js";
import type { CoreDeps } from "../src/core/types.js";

function createBrowser(downloadDir?: string): Browser {
	return {
		client: {} as Browser["client"],
		chrome: {} as Browser["chrome"],
		Page: {} as Browser["Page"],
		Runtime: {} as Browser["Runtime"],
		DOM: {} as Browser["DOM"],
		DOMSnapshot: {} as Browser["DOMSnapshot"],
		Input: {} as Browser["Input"],
		Target: {} as Browser["Target"],
		Accessibility: {} as Browser["Accessibility"],
		port: 9222,
		downloadDir,
	};
}

function createDeps(params: {
	onLaunchBrowser: (
		port: number,
		headless: boolean,
		proxy?: {
			host: string;
			port: number;
		},
		downloadDir?: string,
		userDataDir?: string,
	) => Promise<Browser>;
}): CoreDeps {
	return {
		featureFlags: {
			preStepScreenshotInLatestUserPrompt: false,
			userTakeoverTool: false,
			authTakeover: false,
			agentTakeoverTool: false,
			dismissCookieBanner: true,
			preExecutionDomPruning: true,
			websiteAPIficationTools: false,
		},
		userActionBehavior: "block",
		registry: new SessionRegistry(),
		isPortInUse: async () => false,
		launchBrowser: params.onLaunchBrowser,
		closeBrowser: async () => {},
		navigateBrowser: async () => {},
		getCurrentURL: async () => "about:blank",
		getSimplifiedDOM: async () => "",
		listTabs: async () => [],
		extractValidBids: () => [],
		findTargetURL: async () => "https://example.com",
		dismissCookieBanner: async () => {},
		createPlan: async () => ({ steps: [] }),
		choosePreExecutionDomNonClickableIdsToExclude: async () => ({
			thinking: "",
			excludedNonClickableIds: [],
			tokenUsage: {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
			},
		}),
		pruneLiveDomByIdentifiers: (async () => ({
			matchedNonClickableIds: [],
			markedNodeCount: 0,
			errors: [],
		})) as CoreDeps["pruneLiveDomByIdentifiers"],
		buildStepPayload: (() => ({
			payload: {},
			pendingMemoryRead: false,
		})) as CoreDeps["buildStepPayload"],
		buildStepMessages: (() => []) as CoreDeps["buildStepMessages"],
		getExecutorSystem: () => "",
		normalizeActionList: () => [],
		executeActions: (async () => ({
			interactionErrors: [],
			screenshotToolObservations: [],
			screenshotToolCaptures: [],
		})) as CoreDeps["executeActions"],
		resolveCurrentTabIndex: async () => 0,
		getNewlyOpenedTabs: () => [],
		capturePreStepScreenshotDataUrl: (async () =>
			null) as CoreDeps["capturePreStepScreenshotDataUrl"],
		estimateTokenCount: () => 0,
		formatTabTitle: () => "",
		createSessionMemoryFile: () => "/tmp/browser-agent-test-memory.txt",
		createSessionExtractDataMemoryFile: () =>
			"/tmp/browser-agent-test-extract-data-memory.txt",
	};
}

describe("createSession", () => {
	it("passes the download directory override to the browser launcher", async () => {
		const requestedDownloadDir = "/tmp/custom-downloads";
		const requestedDownloadRootDir = "/tmp/download-root";
		let launchArgs:
			| {
					port: number;
					headless: boolean;
					proxy?: {
						host: string;
						port: number;
					};
					downloadDir?: string;
					userDataDir?: string;
			  }
			| undefined;
		const deps = createDeps({
			onLaunchBrowser: async (
				port,
				headless,
				proxy,
				downloadDir,
				userDataDir,
			) => {
				launchArgs = {
					port,
					headless,
					proxy,
					downloadDir,
					userDataDir,
				};
				return createBrowser(downloadDir);
			},
		});

		const result = await createSession(deps, {
			port: 9222,
			headless: true,
			downloadDir: requestedDownloadDir,
			downloadRootDir: requestedDownloadRootDir,
			forceRestart: true,
		});

		assert.deepEqual(launchArgs, {
			port: 9222,
			headless: true,
			proxy: undefined,
			downloadDir: requestedDownloadDir,
			userDataDir: undefined,
		});
		assert.equal(result.session.browser.downloadDir, requestedDownloadDir);
		assert.equal(
			result.session.browser.downloadRootDir,
			requestedDownloadRootDir,
		);
	});
});
