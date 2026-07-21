import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { featureFlags } from "../src/featureFlags.js";
import {
	closeSession,
	createPromptForStep,
	createSession,
	processModelOutputAndBrowse,
	step,
} from "../src/core/index.js";
import type { StepHistoryEntry } from "../src/core/types.js";
import { createMockCoreDeps } from "./helpers/core-deps-fixtures.js";

function makeDom(changingText: string): string {
	return [
		"main: Stable page",
		...Array.from(
			{ length: 100 },
			(_, index) => `  section: Stable content ${index}`,
		),
		`  button bid="1": ${changingText}`,
	].join("\n");
}

describe("incremental HTML context", () => {
	const originalFlag = featureFlags.incrementalDomContext;

	afterEach(() => {
		featureFlags.incrementalDomContext = originalFlag;
	});

	it("chains diffs, emits empty unchanged diffs, and rebases substantial changes", async () => {
		featureFlags.incrementalDomContext = true;
		let currentDom = makeDom("Old");
		let executedDom: string | undefined;
		const deps = createMockCoreDeps({
			getSimplifiedDOM: async () => currentDom,
			executeActions: async (params) => {
				executedDom = params.simplifiedDom;
				return {
					pendingMemoryRead: false,
					interactionErrors: [],
					pendingPlanRegeneration: false,
					screenshotToolObservations: [],
					screenshotToolCaptures: [],
				};
			},
		});
		const port = 9551;
		const stepsHistory: StepHistoryEntry[] = [];
		await createSession(deps, { port, headless: true });

		try {
			const first = await createPromptForStep(deps, {
				port,
				userTask: "Test incremental HTML",
				stepsHistory,
				stepNumber: 1,
			});
			assert.strictEqual(first.prompt.payload.htmlContextMode, "full");
			assert.strictEqual(first.prompt.payload.html, currentDom);
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: first.prompt.payload,
				stepsHistory,
			});

			currentDom = makeDom("New");
			const second = await createPromptForStep(deps, {
				port,
				userTask: "Test incremental HTML",
				stepsHistory,
				stepNumber: 2,
			});
			assert.strictEqual(second.prompt.payload.htmlContextMode, "diff");
			assert.include(String(second.prompt.payload.html), "-  button");
			assert.include(String(second.prompt.payload.html), "+  button");
			const retriedSecond = await createPromptForStep(deps, {
				port,
				userTask: "Test incremental HTML",
				stepsHistory,
				stepNumber: 2,
			});
			assert.strictEqual(
				retriedSecond.prompt.payload.htmlContextMode,
				"diff",
			);
			assert.strictEqual(
				retriedSecond.prompt.payload.html,
				second.prompt.payload.html,
			);
			await processModelOutputAndBrowse(deps, port, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [{ wait: 1 }] },
				promptPayload: retriedSecond.prompt.payload,
				stepsHistory,
			});
			assert.strictEqual(executedDom, currentDom);

			const third = await createPromptForStep(deps, {
				port,
				userTask: "Test incremental HTML",
				stepsHistory,
				stepNumber: 3,
			});
			assert.strictEqual(third.prompt.payload.htmlContextMode, "diff");
			assert.strictEqual(third.prompt.payload.html, "");
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: third.prompt.payload,
				stepsHistory,
			});

			currentDom = 'dialog bid="9": Completely different';
			const fourth = await createPromptForStep(deps, {
				port,
				userTask: "Test incremental HTML",
				stepsHistory,
				stepNumber: 4,
			});
			assert.strictEqual(fourth.prompt.payload.htmlContextMode, "full");
			assert.strictEqual(fourth.prompt.payload.html, currentDom);
			const fourthMessages = JSON.stringify(fourth.prompt.messages);
			assert.notInclude(fourthMessages, "Stable content 0");
			assert.include(fourthMessages, "tools");

			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: fourth.prompt.payload,
				stepsHistory,
			});
			for (const entry of stepsHistory.slice(0, -1)) {
				assert.notProperty(entry.payload, "html");
				assert.notProperty(entry.payload, "htmlContextMode");
			}
			assert.strictEqual(
				stepsHistory.at(-1)?.payload.htmlContextMode,
				"full",
			);
			assert.strictEqual(stepsHistory.at(-1)?.payload.html, currentDom);
		} finally {
			await closeSession(deps, port);
		}
	});

	it("preserves legacy full-HTML payload and stripped history when disabled", async () => {
		featureFlags.incrementalDomContext = false;
		const deps = createMockCoreDeps();
		const port = 9552;
		const stepsHistory: StepHistoryEntry[] = [];
		await createSession(deps, { port, headless: true });

		try {
			const prompt = await createPromptForStep(deps, {
				port,
				userTask: "Legacy behavior",
				stepsHistory,
			});
			assert.notProperty(prompt.prompt.payload, "htmlContextMode");
			assert.strictEqual(
				prompt.prompt.payload.html,
				'div bid="1": hello',
			);
			await step(deps, {
				mode: "process_model_step_output",
				rawStepOutput: { tools: [] },
				promptPayload: prompt.prompt.payload,
				stepsHistory,
			});
			assert.notProperty(stepsHistory[0].payload, "html");
		} finally {
			await closeSession(deps, port);
		}
	});
});
