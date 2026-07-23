import { assert } from "chai";
import { describe, it } from "mocha";
import {
	planWorkflow,
	validateWorkflowDecision,
	WORKFLOW_PLANNER_SYSTEM,
	WorkflowDecisionValidationError,
} from "../src/agents/workflow-planner.js";

const llmOptions = {
	provider: "openai" as const,
	model: "test-model",
	reasoningEffort: "none" as const,
};

function validWorkflow() {
	return {
		mode: "workflow",
		reason: "Independent research can run concurrently.",
		nodes: [
			{
				task: "Prepare the shared browser context.",
				dependsOn: [] as number[],
			},
			{
				task: "Research the left source.",
				dependsOn: [1],
			},
			{
				task: "Research the right source.",
				dependsOn: [1],
			},
			{
				task: "Combine both results.",
				dependsOn: [2, 3],
			},
		],
	};
}

function normalizedWorkflow() {
	return {
		mode: "workflow",
		reason: "Independent research can run concurrently.",
		nodes: [
			{
				id: "node_1",
				kind: "preparation",
				task: "Prepare the shared browser context.",
				dependsOn: [],
			},
			{
				id: "node_2",
				kind: "task",
				task: "Research the left source.",
				dependsOn: ["node_1"],
			},
			{
				id: "node_3",
				kind: "task",
				task: "Research the right source.",
				dependsOn: ["node_1"],
			},
			{
				id: "node_4",
				kind: "task",
				task: "Combine both results.",
				dependsOn: ["node_2", "node_3"],
			},
		],
	};
}

describe("workflow planner", () => {
	it("uses a general preparation example without imposing authentication", () => {
		assert.include(
			WORKFLOW_PLANNER_SYSTEM,
			"All task descriptions in the workflow shape below are examples only to demonstrate what a valid schema looks like.",
		);
		assert.include(
			WORKFLOW_PLANNER_SYSTEM,
			"Prepare the shared browser context and resources needed by downstream nodes.",
		);
		assert.notInclude(WORKFLOW_PLANNER_SYSTEM, "synthesis sink");
		assert.notInclude(
			WORKFLOW_PLANNER_SYSTEM,
			"complete any required authentication",
		);
		assert.include(
			WORKFLOW_PLANNER_SYSTEM,
			"Only when the task requires authentication or shared origin setup",
		);
		assert.include(
			WORKFLOW_PLANNER_SYSTEM,
			"Example 3:",
		);
		assert.include(
			WORKFLOW_PLANNER_SYSTEM,
			"every remaining node is a task node",
		);
	});

	it("normalizes valid direct and parallel workflow decisions", () => {
		assert.deepEqual(
			validateWorkflowDecision({ mode: "direct", reason: " Simple. " }),
			{ mode: "direct", reason: "Simple." },
		);
		assert.deepEqual(
			validateWorkflowDecision(validWorkflow()),
			normalizedWorkflow(),
		);
	});

	it("rejects invalid dependencies, ordering, and roots", () => {
		const missing = validWorkflow();
		missing.nodes[1].dependsOn = [5];
		assert.throws(
			() => validateWorkflowDecision(missing),
			WorkflowDecisionValidationError,
		);

		const forwardReference = validWorkflow();
		forwardReference.nodes[0].dependsOn = [2];
		assert.throws(
			() => validateWorkflowDecision(forwardReference),
			/must refer to earlier nodes/,
		);

		const extraRoot = validWorkflow();
		extraRoot.nodes[1].dependsOn = [];
		assert.throws(
			() => validateWorkflowDecision(extraRoot),
			/only root/,
		);

		const extraSink = validWorkflow();
		extraSink.nodes[3].dependsOn = [2];
		const normalized = validateWorkflowDecision(extraSink);
		assert.equal(normalized.mode, "workflow");
		if (normalized.mode === "workflow") {
			assert.deepEqual(
				normalized.nodes
					.filter((node) =>
						normalized.nodes.every(
							(candidate) => !candidate.dependsOn.includes(node.id),
						),
					)
					.map((node) => node.id),
				["node_3", "node_4"],
			);
		}
	});

	it("rejects model-generated node ids and kinds", () => {
		const withRuntimeFields = validWorkflow();
		Object.assign(withRuntimeFields.nodes[1], {
			id: "left",
			kind: "task",
		});
		assert.throws(
			() => validateWorkflowDecision(withRuntimeFields),
			/must not include id or kind/,
		);
	});

	it("keeps runtime ids and kinds out of the model YAML schema", async () => {
		let systemPrompt = "";
		const result = await planWorkflow({
			task: "Compare two sources",
			llmOptions,
			requestDecision: async ({ messages }) => {
				systemPrompt = messages[0]?.content ?? "";
				return validWorkflow();
			},
		});
		assert.equal(result.decision.mode, "workflow");
		assert.notInclude(systemPrompt, "  - id:");
		assert.notInclude(systemPrompt, "    kind:");
		assert.include(systemPrompt, "dependsOn: [1]");
	});

	it("falls back to direct execution for malformed model output", async () => {
		let attempts = 0;
		const result = await planWorkflow({
			task: "Do something complex",
			llmOptions,
			requestDecision: async () => {
				attempts += 1;
				return { mode: "workflow", nodes: [] };
			},
		});
		assert.equal(result.decision.mode, "direct");
		assert.match(result.fallbackReason ?? "", /reason/);
		assert.equal(attempts, 3);
	});

	it("accepts a valid decision after a malformed schema retry", async () => {
		let attempts = 0;
		const result = await planWorkflow({
			task: "Compare two sources",
			llmOptions,
			requestDecision: async () => {
				attempts += 1;
				return attempts === 1
					? { mode: "workflow", reason: "retry", nodes: [] }
					: validWorkflow();
			},
		});
		assert.equal(result.decision.mode, "workflow");
		assert.equal(attempts, 2);
	});

	it("propagates aborts instead of falling back", async () => {
		const abort = new Error("stop");
		abort.name = "AbortError";
		let thrown: unknown;
		try {
			await planWorkflow({
				task: "Stop",
				llmOptions,
				requestDecision: async () => {
					throw abort;
				},
			});
		} catch (error) {
			thrown = error;
		}
		assert.strictEqual(thrown, abort);
	});
});
