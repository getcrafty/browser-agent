import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	getExecutorSystem,
	getExecutorSystemPlannerEmbed,
} from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";

describe("executor reasoning prompt flags", () => {
	const originalOmitExecutorThinkingField =
		configFeatureFlags.omitExecutorThinkingField;
	const originalReasoningTraceContext =
		featureFlags.executorReasoningTraceContext;

	afterEach(() => {
		setConfigFeatureFlags({
			omitExecutorThinkingField: originalOmitExecutorThinkingField,
		});
		featureFlags.executorReasoningTraceContext =
			originalReasoningTraceContext;
	});

	it("replaces action-context fields with reasoning trace context for non-OpenAI executors", () => {
		featureFlags.executorReasoningTraceContext = true;
		const prompt = getExecutorSystem({ provider: "vllm" });

		for (const field of [
			"previousStepStatus",
			"previousStepOutcome",
			"currentStateObservation",
			"nextActionRationale",
		]) {
			assert.notInclude(prompt, field);
		}
		assert.include(prompt, "<think>...</think>");
		assert.include(prompt, "fallible reasoning");
	});

	it("keeps action-context fields for OpenAI and unknown providers", () => {
		featureFlags.executorReasoningTraceContext = true;

		for (const prompt of [
			getExecutorSystem({ provider: "openai" }),
			getExecutorSystem(),
		]) {
			assert.include(prompt, "previousStepStatus");
			assert.include(prompt, "nextActionRationale");
			assert.notInclude(prompt, "fallible reasoning");
		}
	});

	it("keeps provider-side effort independent from executor prompt instructions", () => {
		setConfigFeatureFlags({
			omitExecutorThinkingField: true,
		});
		const runAgentPrompt = getExecutorSystem();
		const plannerEmbedPrompt = getExecutorSystemPlannerEmbed();

		assert.include(runAgentPrompt, "previousStepStatus");
		assert.notInclude(plannerEmbedPrompt, "previousStepStatus");
		assert.include(
			runAgentPrompt,
			"ALWAYS THINK OR REASON BEFORE ANSWERING.",
		);
	});

	it("uses only current HTML bid instructions", () => {
		const prompt = getExecutorSystem();

		assert.notInclude(prompt, "validBids");
		assert.include(
			prompt,
			"Must use a bid that is included in the current HTML context",
		);
	});
});
