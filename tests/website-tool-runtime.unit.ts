import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assert } from "chai";
import { describe, it } from "mocha";
import { getExecutorSystem } from "../src/agents/prompts.js";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import type { Browser } from "../src/browser/types.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";

describe("guided website-tool runtime", () => {
	it("delimits active guidance and states its instruction priority", () => {
		const originalFlag = configFeatureFlags.websiteAPIficationTools;
		setConfigFeatureFlags({ websiteAPIficationTools: true });
		try {
			const prompt = getExecutorSystem({
				activeWebsiteToolGuidance: {
					toolName: "search_catalog",
					section: "recovery",
					content: "Continue from the visible filters.",
					bytes: 34,
					hash: "deadbeef",
				},
			});

			assert.include(prompt, "<ACTIVE_WEBSITE_TOOL_GUIDANCE");
			assert.include(prompt, "Continue from the visible filters.");
			assert.include(prompt, "higher-priority safety");
		} finally {
			setConfigFeatureFlags({ websiteAPIficationTools: originalFlag });
		}
	});

	it("treats website_tool as a final-action barrier", async () => {
		const memoryFile = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "website-tool-runtime-")),
			"memory.txt",
		);
		fs.writeFileSync(memoryFile, "", "utf-8");

		const result = await executeActions({
			b: {} as Browser,
			actions: [
				{ type: "memory_write", content: "before" },
				{
					type: "website_tool",
					name: "definitely_missing_runtime_test_tool",
					inputs: {},
				},
				{ type: "memory_write", content: "after" },
			],
			openTabs: [],
			memoryFile,
			currentUrl: "https://example.com",
			excludedWebsiteToolNames: new Set<string>(),
		});

		assert.include(fs.readFileSync(memoryFile, "utf-8"), "before");
		assert.notInclude(fs.readFileSync(memoryFile, "utf-8"), "after");
		assert.include(
			result.interactionErrors.join("\n"),
			"must be the final action",
		);
	});
});
