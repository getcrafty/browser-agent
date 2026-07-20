import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { resolveProviderRuntimeConfig } from "../src/agents/providers/ai-sdk.js";

describe("llm provider runtime config", () => {
	let originalOpenAI: string | undefined;
	let originalVLLM: string | undefined;

	beforeEach(() => {
		originalOpenAI = process.env.OPENAI_API_KEY;
		originalVLLM = process.env.VLLM_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.VLLM_API_KEY;
	});

	afterEach(() => {
		if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalOpenAI;
		if (originalVLLM === undefined) delete process.env.VLLM_API_KEY;
		else process.env.VLLM_API_KEY = originalVLLM;
	});

	it("prefers an explicit provider API key over environment fallback", () => {
		process.env.VLLM_API_KEY = "env-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "vllm",
			model: "Qwen/Qwen3.6-27B",
			apiKey: "explicit-token",
			endpointUrl: "http://127.0.0.1:9000/v1",
		});

		assert.equal(runtimeConfig.apiKey, "explicit-token");
	});

	it("keeps environment API key fallback when no explicit key is provided", () => {
		process.env.VLLM_API_KEY = "env-token";

		const runtimeConfig = resolveProviderRuntimeConfig({
			provider: "vllm",
			model: "Qwen/Qwen3.6-27B",
			endpointUrl: "http://127.0.0.1:9000/v1",
		});

		assert.equal(runtimeConfig.apiKey, "env-token");
	});
});
