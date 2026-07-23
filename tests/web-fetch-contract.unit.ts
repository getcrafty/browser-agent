import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  normalizeActionListWithDiagnostics,
  normalizeShorthandActionEntry,
} from "../src/agents/executor-utils/action-normalization.js";
import { formatStepForPrompt } from "../src/agents/executor-utils/step-execution.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import type { StepResult } from "../src/agents/types.js";
import { canSkipExecutorStepDelay } from "../src/core/executor-step-delay.js";
import { featureFlags } from "../src/featureFlags.js";

describe("web_fetch executor contract", () => {
  const originalFlag = featureFlags.webFetchTool;

  afterEach(() => {
    featureFlags.webFetchTool = originalFlag;
  });

  it("normalizes typed and shorthand actions and reports malformed URLs", () => {
    assert.deepEqual(
      normalizeShorthandActionEntry({
        type: "web_fetch",
        url: " https://example.com/page ",
      }),
      { type: "web_fetch", urls: ["https://example.com/page"] },
    );
    assert.deepEqual(
      normalizeShorthandActionEntry({
        web_fetch: " https://example.com/data ",
      }),
      { type: "web_fetch", urls: ["https://example.com/data"] },
    );
    assert.deepEqual(
      normalizeShorthandActionEntry({
        web_fetch: ["https://example.com/0", " https://example.com/1 "],
      }),
      {
        type: "web_fetch",
        urls: ["https://example.com/0", "https://example.com/1"],
      },
    );
    const malformed = normalizeActionListWithDiagnostics([{ web_fetch: "  " }]);
    assert.deepEqual(malformed.actions, []);
    assert.deepEqual(malformed.diagnostics, [
      "actions[0]: web_fetch requires a non-empty URL string or URL list",
    ]);
    assert.isNull(
      normalizeShorthandActionEntry({
        web_fetch: ["https://example.com/0", ""],
      }),
    );
  });

  it("round-trips the action into canonical executor history", () => {
    const step: StepResult = {
      thinking: "",
      previousStepPlanUpdate: [],
      previousStepStatus: "none",
      previousStepOutcome: "",
      currentStateObservation: "",
      nextActionRationale: "fetch public page",
      actions: [
        {
          type: "web_fetch",
          urls: ["https://example.com/0", "https://example.com/1"],
        },
      ],
      done: false,
    };
    assert.deepEqual(formatStepForPrompt(step).tools, [
      {
        web_fetch: ["https://example.com/0", "https://example.com/1"],
      },
    ]);
    assert.isTrue(canSkipExecutorStepDelay(step.actions));
  });

  it("exposes all instructions only while the internal flag is enabled", () => {
    featureFlags.webFetchTool = false;
    const disabled = getExecutorSystem();
    assert.notInclude(disabled, "web_fetch:");
    assert.notInclude(disabled, "successful web_fetch");

    featureFlags.webFetchTool = true;
    const enabled = getExecutorSystem();
    assert.include(enabled, "web_fetch:");
    assert.include(enabled, "quick anonymous read");
    assert.include(enabled, "ordered list");
    assert.include(enabled, "fetched concurrently");
    assert.include(enabled, "zero-based indices");
    assert.include(enabled, "saves the full Markdown as captured evidence");
    assert.include(enabled, "do not retry web_fetch");
    assert.include(enabled, "Navigate to it and use the real browser");
    assert.include(enabled, "successful web_fetch");
  });
});
