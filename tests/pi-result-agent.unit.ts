import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildPiModelInvocationTraces,
  parsePiOutcome,
} from "../src/agents/pi-result-agent.js";

describe("Pi result agent contract", () => {
  it("converts every Pi assistant turn into token-usage traces", () => {
    const traces = buildPiModelInvocationTraces(
      [
        { role: "user", content: "secret task" },
        {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 40,
            cacheWrite: 5,
            reasoning: 7,
            totalTokens: 165,
          },
          content: [{ type: "text", text: "secret response" }],
        },
        { role: "toolResult", content: "secret saved page" },
        {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          responseModel: "gpt-5.4-2026-06-01",
          usage: {
            input: 50,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 60,
          },
        },
      ],
      12,
    );

    assert.lengthOf(traces, 2);
    assert.deepEqual(
      traces.map(({ stage, caller, provider, model, usage, meta }) => ({
        stage,
        caller,
        provider,
        model,
        usage,
        meta,
      })),
      [
        {
          stage: "piResultAgent",
          caller: "return_results:piAgent:turn1",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input_tokens: 145,
            cached_input_tokens: 40,
            reasoning_tokens: 7,
            non_reasoning_output_tokens: 13,
            output_tokens: 20,
            total_tokens: 165,
          },
          meta: { phase: "pi_result", piTurn: 1, stepNumber: 12 },
        },
        {
          stage: "piResultAgent",
          caller: "return_results:piAgent:turn2",
          provider: "openai",
          model: "gpt-5.4-2026-06-01",
          usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
            non_reasoning_output_tokens: 10,
            output_tokens: 10,
            total_tokens: 60,
          },
          meta: { phase: "pi_result", piTurn: 2, stepNumber: 12 },
        },
      ],
    );
    assert.notInclude(JSON.stringify(traces), "secret");
  });

  it("parses complete and incomplete YAML", () => {
    assert.deepEqual(
      parsePiOutcome(
        "status: complete\nresults:\n  - link: https://example.com\n    summary: Grounded result",
      ),
      {
        status: "complete",
        results: [{ link: "https://example.com", summary: "Grounded result" }],
      },
    );
    assert.deepEqual(
      parsePiOutcome("status: incomplete\nfeedback: Inspect the detail page"),
      { status: "incomplete", feedback: "Inspect the detail page" },
    );
  });

  it("rejects malformed YAML, empty result items, and invalid statuses", () => {
    for (const output of [
      "not: [valid",
      "status: complete\nresults: []",
      "status: complete\nresults:\n  - link: ''\n    summary: x",
      "status: incomplete\nfeedback: ''",
      "status: unknown",
      "status: incomplete\nfeedback: missing\nresults: []",
      "status: complete\nresults:\n  - link: https://example.com\n    summary: x\n    extra: y",
    ]) {
      assert.throws(() => parsePiOutcome(output));
    }
  });
});
