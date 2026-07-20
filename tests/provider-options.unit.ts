import { assert } from "chai";
import { describe, it } from "mocha";
import {
	__buildProviderOptionsForTests,
	__toTokenUsageForTests,
} from "../src/agents/providers/ai-sdk.js";

describe("provider options", () => {
	it("passes the exact OpenAI reasoning effort", () => {
		const options = __buildProviderOptionsForTests({
			model: "gpt-5.5",
			provider: "openai",
			reasoningEffort: "medium",
		});

		assert.deepEqual(options.openai, {
			include_usage: true,
			reasoningSummary: "detailed",
			reasoningEffort: "medium",
		});
	});

	it("sends Together reasoning disable options for none", () => {
		const disabled = __buildProviderOptionsForTests({
			model: "zai-org/GLM-5.2",
			provider: "together",
			reasoningEffort: "none",
		});

		assert.deepEqual(disabled.together, {
			include_usage: true,
			reasoning: { enabled: false },
			chat_template_kwargs: {
				enable_thinking: false,
				thinking: false,
			},
		});
	});

	it("sets Together GLM-5.2 reasoning effort exactly", () => {
		const enabled = __buildProviderOptionsForTests({
			model: "zai-org/GLM-5.2",
			provider: "together",
			reasoningEffort: "max",
		});

		assert.deepEqual(enabled.together, {
			include_usage: true,
			reasoningEffort: "max",
		});
	});

	it("maps vLLM Qwen efforts to enable_thinking", () => {
		const disabled = __buildProviderOptionsForTests({
			model: "Qwen/Qwen3.5-397B-A17B-FP8",
			provider: "vllm",
			reasoningEffort: "none",
		});
		const enabled = __buildProviderOptionsForTests({
			model: "qwen3.5-4b-sft",
			provider: "vllm",
			reasoningEffort: "enabled",
		});

		assert.equal(
			disabled.vllm?.chat_template_kwargs.enable_thinking,
			false,
		);
		assert.equal(enabled.vllm?.chat_template_kwargs.enable_thinking, true);
	});

	it("disables reasoning for vLLM GLM", () => {
		const options = __buildProviderOptionsForTests({
			model: "lukealonso/GLM-5.1-NVFP4",
			provider: "vllm",
			reasoningEffort: "none",
		});
		assert.deepEqual(options.vllm, {
			include_usage: true,
			reasoning: { enabled: false },
			chat_template_kwargs: {
				enable_thinking: false,
				thinking: false,
			},
		});
	});
});

describe("provider token usage", () => {
	it("splits reasoning from non-reasoning output tokens", () => {
		assert.deepEqual(
			__toTokenUsageForTests({
				inputTokens: 20,
				inputTokenDetails: {
					noCacheTokens: 15,
					cacheReadTokens: 5,
					cacheWriteTokens: undefined,
				},
				outputTokens: 10,
				outputTokenDetails: {
					textTokens: 7,
					reasoningTokens: 3,
				},
				totalTokens: 30,
				raw: undefined,
			}),
			{
				input_tokens: 20,
				cached_input_tokens: 5,
				reasoning_tokens: 3,
				non_reasoning_output_tokens: 7,
				output_tokens: 10,
				total_tokens: 30,
			},
		);
	});

	it("preserves an unavailable reasoning split", () => {
		assert.deepEqual(
			__toTokenUsageForTests({
				inputTokens: 20,
				inputTokenDetails: {
					noCacheTokens: 20,
					cacheReadTokens: undefined,
					cacheWriteTokens: undefined,
				},
				outputTokens: 10,
				outputTokenDetails: {
					textTokens: undefined,
					reasoningTokens: undefined,
				},
				totalTokens: 30,
				raw: undefined,
			}),
			{
				input_tokens: 20,
				cached_input_tokens: 0,
				reasoning_tokens: undefined,
				non_reasoning_output_tokens: undefined,
				output_tokens: 10,
				total_tokens: 30,
			},
		);
	});
});
