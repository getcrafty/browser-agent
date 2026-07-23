import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildWorkflowPlanningEvent,
  resolveWorkflowPlanning,
} from "../src/core/run-workflow.js";
import {
  __runTaskRetryLoopForTests,
  buildRunTaskWorkflowPlanningEvent,
} from "../src/core/run-task.js";
import type {
  RunTaskWorkflowPlanningEvent,
  WorkflowDecision,
  WorkflowPlanningEvent,
} from "../src/core/workflow-types.js";

const directDecision: Extract<WorkflowDecision, { mode: "direct" }> = {
  mode: "direct",
  reason: "One agent is sufficient.",
};

const workflowDecision: Extract<WorkflowDecision, { mode: "workflow" }> = {
  mode: "workflow",
  reason: "The branches are independent.",
  nodes: [
    { id: "prepare", kind: "normal", task: "Prepare", dependsOn: [] },
    { id: "research", kind: "normal", task: "Research", dependsOn: ["prepare"] },
    {
      id: "synthesize",
      kind: "normal",
      task: "Synthesize",
      dependsOn: ["research"],
    },
  ],
};

describe("workflow planning callbacks", () => {
  it("emits nothing when orchestration is disabled", async () => {
    let planCalls = 0;
    const events: WorkflowPlanningEvent[] = [];
    const resolution = await resolveWorkflowPlanning({
      enabled: false,
      hasInitialPlanOverride: false,
      plan: async () => {
        planCalls += 1;
        return { decision: directDecision };
      },
      onWorkflowPlanned: (event) => events.push(event),
    });
    assert.deepEqual(resolution, { status: "disabled" });
    assert.equal(planCalls, 0);
    assert.deepEqual(events, []);
  });

  it("emits bypassed without invoking the planner for an initial plan override", async () => {
    let planCalls = 0;
    const events: WorkflowPlanningEvent[] = [];
    const resolution = await resolveWorkflowPlanning({
      enabled: true,
      hasInitialPlanOverride: true,
      plan: async () => {
        planCalls += 1;
        return { decision: directDecision };
      },
      onWorkflowPlanned: (event) => events.push(event),
    });
    assert.deepEqual(resolution, { status: "bypassed" });
    assert.equal(planCalls, 0);
    assert.deepEqual(events, [
      { status: "bypassed", reason: "initial_plan_override" },
    ]);
  });

  it("classifies direct, fallback, and workflow results exactly once", async () => {
    const cases = [
      {
        planning: { decision: directDecision },
        expected: { status: "direct", decision: directDecision },
      },
      {
        planning: {
          decision: directDecision,
          fallbackReason: "Invalid graph.",
        },
        expected: {
          status: "fallback",
          decision: directDecision,
          fallbackReason: "Invalid graph.",
        },
      },
      {
        planning: { decision: workflowDecision },
        expected: { status: "workflow", decision: workflowDecision },
      },
    ] as const;

    for (const { planning, expected } of cases) {
      const events: WorkflowPlanningEvent[] = [];
      const resolution = await resolveWorkflowPlanning({
        enabled: true,
        hasInitialPlanOverride: false,
        plan: async () => planning,
        onWorkflowPlanned: (event) => events.push(event),
      });
      assert.equal(resolution.status, expected.status);
      assert.deepEqual(events, [expected]);
      assert.deepEqual(buildWorkflowPlanningEvent(planning), expected);
    }
  });

  it("awaits callback delivery and propagates callback failures", async () => {
    const callbackError = new Error("callback failed");
    let thrown: unknown;
    try {
      await resolveWorkflowPlanning({
        enabled: true,
        hasInitialPlanOverride: false,
        plan: async () => ({ decision: directDecision }),
        onWorkflowPlanned: async () => {
          await Promise.resolve();
          throw callbackError;
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert.strictEqual(thrown, callbackError);
  });

  it("delivers one runTask event per retry attempt with ordinal metadata", async () => {
    const events: RunTaskWorkflowPlanningEvent[] = [];
    await __runTaskRetryLoopForTests({
      taskRuns: 1,
      taskRunRetryCount: 1,
      stopOnFirstSuccess: false,
      sleepFn: async () => undefined,
      executeRun: async (runIndex, attemptOrdinal) => {
        await resolveWorkflowPlanning({
          enabled: true,
          hasInitialPlanOverride: false,
          plan: async () => ({ decision: directDecision }),
          onWorkflowPlanned: (event) => {
            events.push(
              buildRunTaskWorkflowPlanningEvent({
                event,
                runIndex,
                totalRuns: 1,
                attemptOrdinal,
                totalAttempts: 2,
              }),
            );
          },
        });
        if (attemptOrdinal === 1) throw new Error("retry");
        return { status: "success" };
      },
    });

    assert.deepEqual(
      events.map(({ status, runIndex, attemptOrdinal, totalAttempts }) => ({
        status,
        runIndex,
        attemptOrdinal,
        totalAttempts,
      })),
      [
        { status: "direct", runIndex: 1, attemptOrdinal: 1, totalAttempts: 2 },
        { status: "direct", runIndex: 1, attemptOrdinal: 2, totalAttempts: 2 },
      ],
    );
  });
});
