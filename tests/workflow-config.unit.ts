import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "mocha";
import { loadConfig } from "../src/utils.js";

function configPath(extra = ""): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-"));
	const file = path.join(directory, "config.yaml");
	fs.writeFileSync(
		file,
		`provider: openai
model: gpt-5.4
reasoning_effort: none
concurrency: 1
tasks: [test]
${extra}`,
	);
	return file;
}

describe("workflow config", () => {
	it("defaults orchestration off, concurrency to four, and planner to createPlan", () => {
		const config = loadConfig(configPath());
		assert.isFalse(config.featureFlags.workflowOrchestration);
		assert.equal(config.workflowMaxParallelNodes, 4);
		assert.deepEqual(config.stageLLMs.workflowPlanner, config.stageLLMs.createPlan);
		assert.isUndefined(config.stageLLMs.aggregatedResults);
	});

	it("parses workflow aliases and a dedicated planner model", () => {
		const config = loadConfig(
			configPath(`feature_flags:
  workflow_orchestration: true
workflow_max_parallel_nodes: 8
stage_llms:
  aggregate_results:
    provider: openai
    model: gpt-5.4
    reasoning_effort: medium
  workflow_planner:
    provider: openai
    model: gpt-5.4-mini
    reasoning_effort: low
`),
		);
		assert.isTrue(config.featureFlags.workflowOrchestration);
		assert.equal(config.workflowMaxParallelNodes, 8);
		assert.equal(config.stageLLMs.workflowPlanner.model, "gpt-5.4-mini");
		assert.deepEqual(config.stageLLMs.aggregatedResults, {
			provider: "openai",
			model: "gpt-5.4",
			reasoningEffort: "medium",
			endpointUrl: undefined,
		});
	});

	it("requires explicit aggregate settings only when orchestration is enabled", () => {
		const originalExit = process.exit;
		const originalError = console.error;
		const errors: string[] = [];
		process.exit = (() => {
			throw new Error("exit");
		}) as typeof process.exit;
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		try {
			assert.throws(
				() =>
					loadConfig(
						configPath(
							`feature_flags:\n  workflow_orchestration: true\n`,
						),
					),
				/exit/,
			);
			assert.include(errors.join("\n"), "stage_llms.aggregatedResults");
		} finally {
			process.exit = originalExit;
			console.error = originalError;
		}
	});

	it("rejects workflow concurrency outside 1..8", () => {
		const originalExit = process.exit;
		const originalError = console.error;
		process.exit = (() => {
			throw new Error("exit");
		}) as typeof process.exit;
		console.error = () => undefined;
		try {
			assert.throws(
				() => loadConfig(configPath("workflow_max_parallel_nodes: 9\n")),
				/exit/,
			);
		} finally {
			process.exit = originalExit;
			console.error = originalError;
		}
	});
});
