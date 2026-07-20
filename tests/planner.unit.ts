import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { createPlan, findTargetURL } from "../src/agents/planner.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import { configFeatureFlags } from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";

describe("planner", () => {
	const originalEnablePlanning = featureFlags.enablePlanning;
	const originalWebsiteAPIficationTools =
		configFeatureFlags.websiteAPIficationTools;

	afterEach(() => {
		__setProviderOverrideForTests("vllm", null);
		featureFlags.enablePlanning = originalEnablePlanning;
		configFeatureFlags.websiteAPIficationTools =
			originalWebsiteAPIficationTools;
	});

	it("forwards the configured URL-discovery reasoning effort", async () => {
		let reasoningEffort: string | undefined;

		__setProviderOverrideForTests("vllm", async (args) => {
			reasoningEffort = args.options.reasoningEffort;
			return {
				content: 'url: "https://www.example.com"',
				usage: {
					input_tokens: 5,
					output_tokens: 4,
					total_tokens: 9,
				},
				reasoning_tokens: "",
			};
		});

		const url = await findTargetURL("Find a useful site.", {
			provider: "vllm",
			model: "Qwen/Qwen3.5-4B",
			reasoningEffort: "none",
		});

		assert.strictEqual(url, "https://www.example.com");
		assert.strictEqual(reasoningEffort, "none");
	});

	it("forwards the configured planning reasoning effort", async () => {
		let reasoningEffort: string | undefined;
		featureFlags.enablePlanning = true;

		__setProviderOverrideForTests("vllm", async (args) => {
			reasoningEffort = args.options.reasoningEffort;
			return {
				content: `steps:
  - "Open the page"
  - "Finish"`,
				usage: {
					input_tokens: 5,
					output_tokens: 4,
					total_tokens: 9,
				},
				reasoning_tokens: "",
			};
		});

		const plan = await createPlan("Finish task.", 'div bid="1": hello', {
			provider: "vllm",
			model: "Qwen/Qwen3.5-4B",
			reasoningEffort: "enabled",
		});

		assert.deepEqual(plan.steps, ["Open the page", "Finish"]);
		assert.strictEqual(reasoningEffort, "enabled");
	});

	it("includes active website-tool guidance only when supplied by runtime context", async () => {
		const systemPrompts: string[] = [];
		featureFlags.enablePlanning = true;
		configFeatureFlags.websiteAPIficationTools = true;
		__setProviderOverrideForTests("vllm", async (args) => {
			systemPrompts.push(args.prompt);
			return {
				content: 'steps:\n  - "Continue"',
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
			};
		});

		await createPlan("Task", "DOM", {
			provider: "vllm",
			model: "Qwen/Qwen3.5-4B",
			reasoningEffort: "enabled",
		});
		await createPlan(
			"Task",
			"DOM",
			{
				provider: "vllm",
				model: "Qwen/Qwen3.5-4B",
				reasoningEffort: "enabled",
			},
			undefined,
			{
				activeWebsiteToolGuidance: {
					toolName: "guided_tool",
					section: "post-script",
					content: "Inspect the rendered results.",
					bytes: 29,
					hash: "abc123",
				},
			},
		);

		assert.notInclude(systemPrompts[0], "Inspect the rendered results.");
		assert.include(systemPrompts[1], "Inspect the rendered results.");
		assert.include(systemPrompts[1], "guided_tool");
	});

	it("returns an empty plan without calling the model when planning is disabled", async () => {
		let providerCalls = 0;
		featureFlags.enablePlanning = false;

		__setProviderOverrideForTests("vllm", async () => {
			providerCalls += 1;
			return {
				content: `steps:
  - "Should not run"`,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
				},
				reasoning_tokens: "",
			};
		});

		const plan = await createPlan("Finish task.", 'div bid="1": hello', {
			provider: "vllm",
			model: "Qwen/Qwen3.5-4B",
			reasoningEffort: "enabled",
		});

		assert.deepEqual(plan.steps, []);
		assert.strictEqual(providerCalls, 0);
	});
});
