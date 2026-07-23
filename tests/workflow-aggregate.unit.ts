import { assert } from "chai";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import {
  buildAggregatedResultCandidates,
  finalizeWorkflowAggregate,
} from "../src/core/run-workflow.js";
import type { WorkflowResult } from "../src/core/workflow-types.js";
import type { VerifyTaskSuccessInput } from "../src/agents/success-verifier.js";

const usage = {
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: 12,
};

function workflow(): WorkflowResult {
  return {
    decision: {
      mode: "workflow",
      reason: "Parallel research",
      nodes: [
        {
          id: "node_1",
          kind: "normal",
          task: "Identify laureates and Wikipedia links",
          dependsOn: [],
        },
        {
          id: "node_2",
          kind: "normal",
          task: "Research Hopfield",
          dependsOn: ["node_1"],
        },
        {
          id: "node_3",
          kind: "normal",
          task: "Research Hinton",
          dependsOn: ["node_1"],
        },
      ],
    },
    nodes: [
      {
        nodeId: "node_1",
        kind: "normal",
        status: "succeeded",
        result: [
          "- link: https://en.wikipedia.org/wiki/John_Hopfield",
          "  summary: John Hopfield",
          "- link: https://en.wikipedia.org/wiki/Geoffrey_Hinton",
          "  summary: Geoffrey Hinton",
        ].join("\n"),
      },
      {
        nodeId: "node_2",
        kind: "normal",
        status: "succeeded",
        result: [
          "- link: https://cornell.example",
          "  summary: Hopfield received his PhD from Cornell.",
        ].join("\n"),
      },
      {
        nodeId: "node_3",
        kind: "normal",
        status: "succeeded",
        result: [
          "- link: https://edinburgh.example",
          "  summary: Hinton received his PhD from Edinburgh.",
        ].join("\n"),
      },
    ],
    terminalNodeIds: ["node_2", "node_3"],
    result: "old terminal-only result",
    completed: true,
    successful: true,
  };
}

const llmOptions = {
  provider: "openai" as const,
  model: "gpt-test",
  reasoningEffort: "low" as const,
};

describe("workflow aggregate finalization", () => {
  it("selects ancestor and terminal results, then validates the flat aggregate once", async () => {
    let selectionCalls = 0;
    const verificationInputs: VerifyTaskSuccessInput[] = [];
    const finalized = await finalizeWorkflowAggregate({
      task: "Return laureates, Wikipedia links, and PhD research",
      workflow: workflow(),
      executedSteps: 12,
      aggregatedResultsLLMOptions: llmOptions,
      verifySuccessLLMOptions: llmOptions,
      select: async ({ candidates }) => {
        selectionCalls += 1;
        assert.deepEqual(
          candidates.map(({ index, nodeId, selectable }) => ({
            index,
            nodeId,
            selectable,
          })),
          [
            { index: 1, nodeId: "node_1", selectable: true },
            { index: 2, nodeId: "node_2", selectable: true },
            { index: 3, nodeId: "node_3", selectable: true },
          ],
        );
        return { selectedNodeIndices: [1, 2, 3], usages: [usage] };
      },
      verify: async (input) => {
        verificationInputs.push(input);
        return {
          success: true,
          summary: "Complete",
          reasons: [],
          model: "gpt-test",
          provider: "openai",
          reasoningEffort: "low",
          usage,
        };
      },
    });

    assert.equal(selectionCalls, 1);
    assert.lengthOf(verificationInputs, 1);
    assert.equal(
      verificationInputs[0].task,
      "Return laureates, Wikipedia links, and PhD research",
    );
    assert.equal(verificationInputs[0].purpose, "completion_verifier");
    assert.equal(verificationInputs[0].contextMode, "compact");
    assert.deepEqual(verificationInputs[0].checklist, []);
    assert.equal(verificationInputs[0].finalStep.result, finalized.result);
    assert.deepEqual(yaml.load(finalized.result), [
      {
        link: "https://en.wikipedia.org/wiki/John_Hopfield",
        summary: "John Hopfield",
      },
      {
        link: "https://en.wikipedia.org/wiki/Geoffrey_Hinton",
        summary: "Geoffrey Hinton",
      },
      {
        link: "https://cornell.example",
        summary: "Hopfield received his PhD from Cornell.",
      },
      {
        link: "https://edinburgh.example",
        summary: "Hinton received his PhD from Edinburgh.",
      },
    ]);
    assert.deepEqual(finalized.workflow.selectedNodeIndices, [1, 2, 3]);
    assert.deepEqual(finalized.workflow.selectedNodeIds, [
      "node_1",
      "node_2",
      "node_3",
    ]);
    assert.deepEqual(finalized.workflow.terminalNodeIds, ["node_2", "node_3"]);
    assert.isTrue(finalized.workflow.completed);
    assert.isTrue(finalized.workflow.successful);
    assert.deepEqual(finalized.usages, [usage, usage]);
  });

  it("retains a rejected aggregate and marks the workflow unsuccessful", async () => {
    let verificationCalls = 0;
    const finalized = await finalizeWorkflowAggregate({
      task: "Original task",
      workflow: workflow(),
      executedSteps: 12,
      aggregatedResultsLLMOptions: llmOptions,
      verifySuccessLLMOptions: llmOptions,
      select: async () => ({ selectedNodeIndices: [2], usages: [] }),
      verify: async () => {
        verificationCalls += 1;
        return {
          success: false,
          summary: "Missing Wikipedia links",
          reasons: ["Missing Wikipedia links"],
          model: "gpt-test",
          provider: "openai",
          reasoningEffort: "low",
          usage,
        };
      },
    });
    assert.equal(verificationCalls, 1);
    assert.isTrue(finalized.workflow.completed);
    assert.isFalse(finalized.workflow.successful);
    assert.equal(finalized.workflow.result, finalized.result);
    assert.isFalse(finalized.successVerification.success);
  });

  it("keeps orchestrator control entries indexed but unselectable", () => {
    const value = workflow();
    if (value.decision.mode !== "workflow") assert.fail("expected workflow");
    value.decision.nodes.splice(1, 0, {
      id: "node_control",
      kind: "orchestrator",
      task: "Expand",
      dependsOn: ["node_1"],
    });
    value.nodes.splice(1, 0, {
      nodeId: "node_control",
      kind: "orchestrator",
      status: "succeeded",
      result: null,
    });
    assert.deepEqual(
      buildAggregatedResultCandidates(value).map(
        ({ index, nodeId, selectable }) => ({ index, nodeId, selectable }),
      ),
      [
        { index: 1, nodeId: "node_1", selectable: true },
        { index: 2, nodeId: "node_control", selectable: false },
        { index: 3, nodeId: "node_2", selectable: true },
        { index: 4, nodeId: "node_3", selectable: true },
      ],
    );
  });
});
