import { assert } from "chai";
import { describe, it } from "mocha";
import {
  formatWorkflowPlanningEventBlock,
  formatWorkflowNodeEventLine,
  sanitizeWorkflowLogText,
} from "../src/workflow-logging.js";

const coordinates = { taskNumber: 2, totalTasks: 7 };

describe("workflow planning logging", () => {
  it("formats a complete DAG with full collapsed task text", () => {
    const longTask = `Review   every result\n\tand preserve this complete clause ${"without truncation ".repeat(12)}`;
    const block = formatWorkflowPlanningEventBlock(
      {
        status: "workflow",
        runIndex: 3,
        totalRuns: 4,
        attemptOrdinal: 2,
        totalAttempts: 5,
        decision: {
          mode: "workflow",
          reason: "Parallel research is useful.",
          nodes: [
            {
              id: "prepare",
              kind: "normal",
              task: "Authenticate first",
              dependsOn: [],
            },
            {
              id: "research",
              kind: "normal",
              task: longTask,
              dependsOn: ["prepare"],
            },
          ],
        },
      },
      coordinates,
    );

    assert.include(block, "Task 2/7 | Run 3/4 | Attempt 2/5");
    assert.include(block, "Workflow decision: DAG with 2 node(s).");
    assert.include(block, "1. prepare [normal]");
    assert.include(block, "Depends on: prepare");
    assert.include(block, sanitizeWorkflowLogText(longTask));
    assert.notInclude(block, "\t");
    assert.notInclude(block, "…");
    assert.isFalse(block.endsWith("\n"));
  });

  it("removes ANSI and terminal control characters from model text", () => {
    const block = formatWorkflowPlanningEventBlock(
      {
        status: "workflow",
        runIndex: 1,
        totalRuns: 1,
        attemptOrdinal: 1,
        totalAttempts: 1,
        decision: {
          mode: "workflow",
          reason: "\u001b[31mred\u001b[0m\u0007 reason",
          nodes: [
            {
              id: "node\u001b]0;owned\u0007",
              kind: "normal",
              task: "first\u0000 second\r\nthird",
              dependsOn: [],
            },
          ],
        },
      },
      coordinates,
    );

    assert.notMatch(block, /[\u001b\u0000\u0007]/);
    assert.include(block, "Reason: red reason");
    assert.include(block, "Task: first second third");
  });

  it("formats direct, fallback, and bypass events concisely", () => {
    const base = {
      runIndex: 1,
      totalRuns: 2,
      attemptOrdinal: 1,
      totalAttempts: 3,
    };
    const direct = formatWorkflowPlanningEventBlock(
      {
        ...base,
        status: "direct",
        decision: { mode: "direct", reason: "One simple action." },
      },
      coordinates,
    );
    const fallback = formatWorkflowPlanningEventBlock(
      {
        ...base,
        status: "fallback",
        decision: { mode: "direct", reason: "Use the safe path." },
        fallbackReason: "Planner output was invalid.",
      },
      coordinates,
    );
    const bypass = formatWorkflowPlanningEventBlock(
      {
        ...base,
        status: "bypassed",
        reason: "initial_plan_override",
      },
      coordinates,
    );

    assert.lengthOf(direct.split("\n"), 3);
    assert.include(direct, "direct execution");
    assert.lengthOf(fallback.split("\n"), 4);
    assert.include(fallback, "Fallback: Planner output was invalid.");
    assert.lengthOf(bypass.split("\n"), 2);
    assert.include(bypass, "explicit initial plan override");
  });

  it("formats allowlisted node diagnostics on one safe line", () => {
    const line = formatWorkflowNodeEventLine({
      status: "failed",
      nodeId: "laureates_phds\nforged-log-line",
      kind: "normal",
      durationMs: 1234,
      diagnostic: {
        phase: "successor_handoff",
        code: "scope_not_empty",
        sourceScopeId: "wf-n1",
        destinationScopeId: "wf-e1-3",
        sourceTargetCount: 2,
        destinationTargetCount: 1,
      },
    });

    assert.notInclude(line, "\n");
    assert.include(line, "node=laureates_phds forged-log-line");
    assert.include(line, "status=failed");
    assert.include(line, "phase=successor_handoff");
    assert.include(line, "code=scope_not_empty");
    assert.include(line, "source_targets=2");
    assert.include(line, "destination_targets=1");
  });
});
