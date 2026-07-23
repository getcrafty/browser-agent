import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";
import {
	closeSession,
	createSession,
	preprocessTask,
} from "../src/core/index.js";
import { featureFlags } from "../src/featureFlags.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("preprocess task checklist", () => {
	const originalPlanning = featureFlags.enablePlanning;
	afterEach(() => {
		featureFlags.enablePlanning = originalPlanning;
	});

	it("runs DOM-aware planning and task-only checklist creation concurrently", async () => {
		featureFlags.enablePlanning = true;
		const planStarted = deferred();
		const checklistStarted = deferred();
		const deps = createMockCoreDeps({
			featureFlags: {
				...createMockCoreDeps().featureFlags,
				taskChecklist: true,
				preExecutionDomPruning: false,
			},
			createPlan: async (_task, dom) => {
				assert.include(dom, "hello");
				planStarted.resolve();
				await checklistStarted.promise;
				return { steps: ["Navigate"] };
			},
			createChecklist: async (task) => {
				assert.equal(task, "Return every requested field");
				checklistStarted.resolve();
				await planStarted.promise;
				return { items: ["Return every requested field."] };
			},
		});
		await createSession(deps, {
			port: 9390,
			headless: true,
			url: "https://example.com",
			forceRestart: true,
		});
		try {
			const result = await preprocessTask(deps, {
				port: 9390,
				userTask: "Return every requested field",
				url: "https://example.com",
				stageLLMs: {
					findTargetURL: { provider: "openai", model: "gpt-test" },
					dismissCookieBanner: { provider: "openai", model: "gpt-test" },
					createPlan: { provider: "openai", model: "gpt-test" },
					createChecklist: { provider: "openai", model: "gpt-test" },
					preExecutionDomPruning: {
						provider: "openai",
						model: "gpt-test",
					},
				},
			});
			assert.deepEqual(result.plan, ["Navigate"]);
			assert.deepEqual(result.checklist, [
				{
					id: "C1",
					requirement: "Return every requested field.",
					status: "TODO",
				},
			]);
		} finally {
			await closeSession(deps, 9390);
		}
	});
});
