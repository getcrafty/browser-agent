import { assert } from "chai";
import * as fs from "node:fs";
import { describe, it } from "mocha";
import { createMockCoreDeps, makeFakeBrowser } from "./helpers/core-deps-fixtures.js";
import { createBorrowedSession } from "../src/core/session.js";
import { runAgentWithBorrowedSession } from "../src/core/run-agent.js";

describe("runAgentWithBorrowedSession", () => {
	it("uses a scoped client without launching or closing caller-owned Chrome", async () => {
		let launches = 0;
		let scopedCloses = 0;
		const deps = createMockCoreDeps({
			launchBrowser: async () => {
				launches += 1;
				throw new Error("borrowed runs must not launch Chrome");
			},
			closeBrowser: async (browser) => {
				assert.strictEqual(browser.targetScope?.scopeId, "node-a");
				scopedCloses += 1;
			},
		});
		const browser = makeFakeBrowser(9222);
		browser.targetScope = {
			scopeId: "node-a",
			refresh: async () => {},
			listTargetIds: () => new Set(["tab-1"]),
			assertOwned: () => {},
			claimCreatedTarget: async () => {},
			releaseTarget: () => {},
		};
		const sessionInput = { port: 9222, headless: true };
		const session = createBorrowedSession(sessionInput, browser);
		const temporaryStateDir = session.temporaryStateDir!;
		assert.isTrue(fs.existsSync(temporaryStateDir));

		const result = await runAgentWithBorrowedSession(
			deps,
			{
				sessionInput,
				task: "Return the result",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					dismissCookieBanner: { provider: "openai", model: "gpt-test" },
					createPlan: { provider: "openai", model: "gpt-test" },
					preExecutionDomPruning: { provider: "openai", model: "gpt-test" },
					runAgent: { provider: "openai", model: "gpt-test" },
					verifySuccess: { provider: "openai", model: "gpt-test" },
					dataExtraction: { provider: "openai", model: "gpt-test" },
				},
				featureFlags: deps.featureFlags,
				authenticationPolicy: "reject",
				maxSteps: 1,
				generateStep: async () => ({
					data: {
						thinking: "Done",
						actions: [{ type: "return_results" }],
						done: false,
					},
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				}),
			},
			session,
		);

		assert.isTrue(result.completed);
		assert.strictEqual(launches, 0);
		assert.strictEqual(scopedCloses, 1);
		assert.isFalse(fs.existsSync(temporaryStateDir));
	});
});
