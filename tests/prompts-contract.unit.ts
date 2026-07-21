import { assert } from "chai";
import yaml from "js-yaml";
import { afterEach, describe, it } from "mocha";
import { encoding_for_model } from "tiktoken";
import {
	getExecutorSystem,
	getExecutorSystemBase,
	getExecutorSystemPlannerEmbed,
} from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";

const originalConfigFeatureFlags = { ...configFeatureFlags };
const originalFeatureFlags = { ...featureFlags };

function occurrences(value: string, search: string): number {
	return value.split(search).length - 1;
}

function canonicalToolNames(prompt: string): string[] {
	const expectedOutput = prompt.split("### Expected Output\n")[1];
	assert.isString(expectedOutput, "expected output section");
	const example = expectedOutput.split("\n\nRules:\n")[0];
	const yamlStart = example.indexOf("\n") + 1;
	const parsed = yaml.load(example.slice(yamlStart)) as {
		tools: Array<string | Record<string, unknown>>;
	};
	return parsed.tools.map((tool) =>
		typeof tool === "string" ? tool : Object.keys(tool)[0],
	);
}

function assertToolContract(
	prompt: string,
	toolNames: readonly string[],
): void {
	const exampleNames = canonicalToolNames(prompt);
	for (const toolName of toolNames) {
		assert.include(exampleNames, toolName, `${toolName} YAML example`);
		assert.include(prompt, `\n${toolName}:\n`, `${toolName} guidance`);
	}
}

describe("executor prompt contract", () => {
	afterEach(() => {
		setConfigFeatureFlags(originalConfigFeatureFlags);
		Object.assign(featureFlags, originalFeatureFlags);
	});

	it("keeps one YAML response contract and removes redundant instructions", () => {
		const prompt = getExecutorSystemBase();
		const responseSection = prompt
			.split("### Expected Output\n")[1]
			.split("### Tool Types & Usage\n")[0];

		assert.strictEqual(occurrences(prompt, "Respond with raw YAML ONLY"), 1);
		assert.notInclude(prompt, "Tool-call shorthand mapping");
		assert.notInclude(prompt, "ALWAYS THINK OR REASON BEFORE ANSWERING");
		assert.notMatch(prompt, /\n{3,}/);
		assert.notInclude(responseSection, 'For "type" tool calls');
		assert.notInclude(responseSection, 'input type="date"');
		assert.notInclude(responseSection, "When the task is complete");
		assert.strictEqual(occurrences(prompt, "canonical YYYY-MM-DD"), 1);
		assert.strictEqual(
			occurrences(prompt, "This is the only normal tool that can complete the task"),
			1,
		);
	});

	it("keeps shared tool invariants and default tool contracts", () => {
		const prompt = getExecutorSystemBase();
		assert.include(
			prompt,
			"Every bid or ncid must come from the current HTML context; never invent one.",
		);
		assert.include(prompt, 'File paths must use safe "./..." workspace/download paths.');
		assert.include(prompt, '"workspaceFiles" is informational, not an allowlist.');
		assert.include(prompt, "extract_data runs asynchronously.");
		assert.include(prompt, "memory_read and return_results transparently wait");
		assert.include(prompt, 'failures appear in "interactionErrors"');
		assert.include(
			prompt,
			"Use once the final answer is available from any of these result sources",
		);

		assertToolContract(prompt, [
			"click",
			"long_press",
			"type",
			"scroll",
			"evaluate",
			"dropdown_select",
			"navigate",
			"switch_tab",
			"wait",
			"download_current_file",
			"upload_files",
			"paste_file",
			"memory_write",
			"memory_read",
			"read_file",
			"return_results",
			"memory_clear",
			"extract_data",
			"user_takeover",
		]);
	});

	it("keeps planning, takeover, and reasoning-trace variants complete", () => {
		featureFlags.enablePlanning = true;
		featureFlags.executorReasoningTraceContext = true;
		setConfigFeatureFlags({
			authTakeover: true,
			userTakeoverTool: false,
		});
		const prompt = getExecutorSystem({ provider: "vllm" });

		assertToolContract(prompt, ["regenerate_plan", "user_takeover"]);
		assert.include(prompt, "the runtime may attempt supported authentication automatically");
		assert.include(prompt, "<think>...</think>");
		assert.notInclude(prompt, "previousStepStatus");
		assert.notInclude(prompt, "Tool-call shorthand mapping");
	});

	it("keeps screenshot guidance conditional", () => {
		setConfigFeatureFlags({ preStepScreenshotInLatestUserPrompt: true });
		const enabledPrompt = getExecutorSystem();
		assert.include(enabledPrompt, "currentPageScreenshotIncludedAsImagePart");
		assert.include(enabledPrompt, "captureBeyondViewport=true");

		setConfigFeatureFlags({ preStepScreenshotInLatestUserPrompt: false });
		const disabledPrompt = getExecutorSystem();
		assert.notInclude(disabledPrompt, "currentPageScreenshotIncludedAsImagePart");
		assert.notInclude(disabledPrompt, "captureBeyondViewport=true");
	});

	it("stays within the GPT-5 default prompt budgets", () => {
		const encoding = encoding_for_model("gpt-5");
		try {
			assert.isAtMost(encoding.encode(getExecutorSystemBase()).length, 4_500);
			assert.isAtMost(
				encoding.encode(getExecutorSystemPlannerEmbed()).length,
				2_500,
			);
		} finally {
			encoding.free();
		}
	});
});
