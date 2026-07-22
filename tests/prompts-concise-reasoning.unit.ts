import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	getExecutorSystem,
	getExecutorSystemPlannerEmbed,
} from "../src/agents/prompts.js";
import { featureFlags } from "../src/featureFlags.js";

describe("executor reasoning prompts", () => {
	const originalEnableMiscInstruction = featureFlags.enableMiscInstruction;

	afterEach(() => {
		featureFlags.enableMiscInstruction = originalEnableMiscInstruction;
	});

	it("keeps action-context fields for every executor provider", () => {
		featureFlags.enableMiscInstruction = true;

		for (const prompt of [
			getExecutorSystem({ provider: "vllm" }),
			getExecutorSystem({ provider: "openai" }),
			getExecutorSystem(),
		]) {
			for (const field of [
				"previousStepStatus",
				"previousStepOutcome",
				"currentStateObservation",
				"nextActionRationale",
			]) {
				assert.include(prompt, field);
			}
		}
	});

	it("keeps provider-side effort independent from executor prompt instructions", () => {
		const runAgentPrompt = getExecutorSystem();
		const plannerEmbedPrompt = getExecutorSystemPlannerEmbed();

		assert.include(runAgentPrompt, "previousStepStatus");
		assert.notInclude(plannerEmbedPrompt, "previousStepStatus");
		assert.notInclude(
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
