import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import {
  AggregatedResultsSelectionError,
  materializeAggregatedResults,
  selectAggregatedResults,
  validateAggregatedResultsSelection,
  type AggregatedResultCandidate,
} from "../src/agents/aggregated-results.js";

const candidates: AggregatedResultCandidate[] = [
  {
    index: 1,
    nodeId: "node_1",
    kind: "normal",
    task: "Discover",
    status: "succeeded",
    selectable: true,
    result: '- link: "https://one.example"\n  summary: "One"',
  },
  {
    index: 2,
    nodeId: "node_2",
    kind: "orchestrator",
    task: "Expand",
    status: "succeeded",
    selectable: false,
    result: null,
  },
  {
    index: 3,
    nodeId: "node_3",
    kind: "normal",
    task: "Research",
    status: "succeeded",
    selectable: true,
    result: [
      '- link: "https://three.example/a"',
      '  summary: "Three A"',
      '  downloaded_file_path: "./downloads/a.pdf"',
      '- link: "https://three.example/b"',
      '  summary: "Three B"',
    ].join("\n"),
  },
];

describe("aggregated results", () => {
  it("accepts an ordered, unique selection of selectable 1-based indices", () => {
    assert.deepEqual(
      validateAggregatedResultsSelection({ selected: [3, 1] }, candidates),
      [3, 1],
    );
  });

  it("rejects malformed, duplicate, missing, and unselectable indices", () => {
    for (const value of [
      null,
      {},
      { selected: [] },
      { selected: [1, 1] },
      { selected: [0] },
      { selected: [2] },
      { selected: ["1"] },
      { selected: [1], extra: true },
    ]) {
      assert.throws(
        () => validateAggregatedResultsSelection(value, candidates),
        AggregatedResultsSelectionError,
      );
    }
  });

  it("allows exactly three total schema attempts", async () => {
    const attempts: number[] = [];
    const selection = await selectAggregatedResults({
      task: "Return all required results",
      candidates,
      llmOptions: {
        provider: "openai",
        model: "gpt-test",
        reasoningEffort: "low",
      },
      requestSelection: async ({ attempt }) => {
        attempts.push(attempt);
        return attempt < 3 ? { selected: [2] } : { selected: [1, 3] };
      },
    });
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(selection.selectedNodeIndices, [1, 3]);

    let failedAttempts = 0;
    try {
      await selectAggregatedResults({
        task: "Return all required results",
        candidates,
        llmOptions: {
          provider: "openai",
          model: "gpt-test",
          reasoningEffort: "low",
        },
        requestSelection: async () => {
          failedAttempts += 1;
          return { selected: [] };
        },
      });
      assert.fail("expected aggregate selection to fail");
    } catch (error) {
      assert.instanceOf(error, AggregatedResultsSelectionError);
    }
    assert.equal(failedAttempts, 3);
  });

  it("concatenates exact selected result objects in selection order", () => {
    const aggregate = materializeAggregatedResults({
      candidates,
      selectedNodeIndices: [3, 1],
    });
    assert.deepEqual(aggregate.selectedNodeIds, ["node_3", "node_1"]);
    assert.deepEqual(yaml.load(aggregate.result), [
      {
        link: "https://three.example/a",
        summary: "Three A",
        downloaded_file_path: "./downloads/a.pdf",
      },
      { link: "https://three.example/b", summary: "Three B" },
      { link: "https://one.example", summary: "One" },
    ]);
  });

  it("rejects malformed selected node result objects", () => {
    assert.throws(
      () =>
        materializeAggregatedResults({
          candidates: [
            {
              ...candidates[0],
              result: "- link: https://example.com\n  extra: wrong",
            },
          ],
          selectedNodeIndices: [1],
        }),
      /unexpected key extra|non-empty summary/,
    );
  });
});
