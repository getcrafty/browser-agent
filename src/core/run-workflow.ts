import * as path from "node:path";
import { planWorkflow } from "../agents/workflow-planner.js";
import {
  TargetScopeCoordinator,
  TargetScopeViolationError,
  WorkflowScopeNotEmptyError,
  WorkflowScopeNotFoundError,
} from "../browser/target-scope.js";
import { getDefaultBrowserAgentArtifactDirectories } from "../browser/constants.js";
import { formatWorkflowNodeEventLine } from "../workflow-logging.js";
import { createDefaultCoreDeps } from "./deps.js";
import { runAgent, runAgentWithBorrowedSession } from "./run-agent.js";
import {
  assertAuthenticationBarrierCleared,
  closeSession,
  createBorrowedSession,
  createSession,
} from "./session.js";
import {
  buildWorkflowNodeTask,
  runWorkflowDAG,
  WorkflowNodeExecutionError,
} from "./workflow-scheduler.js";
import type {
  BorrowedRunAgentInput,
  RunAgentInput,
  RunAgentResult,
  RunAgentTokenTotals,
} from "./types.js";
import type { BrowserSession } from "./session-registry.js";
import type {
  OnWorkflowPlanned,
  WorkflowNode,
  WorkflowNodeDiagnostic,
  WorkflowNodeExecutionPhase,
  WorkflowPlanningEvent,
} from "./workflow-types.js";
import type { WorkflowPlanningOutcome } from "../agents/workflow-planner.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    signal.reason instanceof Error
      ? signal.reason.message
      : "Workflow execution was aborted.",
  );
  error.name = "AbortError";
  throw error;
}

export function buildWorkflowPlanningEvent(
  planning: WorkflowPlanningOutcome,
): Exclude<WorkflowPlanningEvent, { status: "bypassed" }> {
  if (planning.decision.mode === "workflow") {
    return { status: "workflow", decision: planning.decision };
  }
  if (planning.fallbackReason) {
    return {
      status: "fallback",
      decision: planning.decision,
      fallbackReason: planning.fallbackReason,
    };
  }
  return { status: "direct", decision: planning.decision };
}

export type WorkflowPlanningResolution =
  | { status: "disabled" }
  | { status: "bypassed" }
  | {
      status: "direct" | "fallback" | "workflow";
      planning: WorkflowPlanningOutcome;
    };

export async function resolveWorkflowPlanning(params: {
  enabled: boolean;
  hasInitialPlanOverride: boolean;
  plan: () => Promise<WorkflowPlanningOutcome>;
  onWorkflowPlanned?: OnWorkflowPlanned;
}): Promise<WorkflowPlanningResolution> {
  if (!params.enabled) return { status: "disabled" };
  if (params.hasInitialPlanOverride) {
    await params.onWorkflowPlanned?.({
      status: "bypassed",
      reason: "initial_plan_override",
    });
    return { status: "bypassed" };
  }
  const planning = await params.plan();
  const event = buildWorkflowPlanningEvent(planning);
  await params.onWorkflowPlanned?.(event);
  return { status: event.status, planning };
}

interface ScopeDiagnosticContext {
  sourceScopeId?: string;
  destinationScopeId?: string;
  sourceTargetCount?: number;
  destinationTargetCount?: number;
}

function buildNodeDiagnostic(
  phase: WorkflowNodeExecutionPhase,
  error: unknown,
  context: ScopeDiagnosticContext = {},
): WorkflowNodeDiagnostic {
  if (error instanceof WorkflowNodeExecutionError) {
    return error.diagnostic;
  }
  if (error instanceof WorkflowScopeNotFoundError) {
    return {
      phase,
      code: "scope_missing",
      ...context,
      ...(error.scopeId === context.sourceScopeId
        ? { sourceScopeId: error.scopeId }
        : { destinationScopeId: error.scopeId }),
    };
  }
  if (error instanceof WorkflowScopeNotEmptyError) {
    return {
      phase,
      code: "scope_not_empty",
      ...context,
      destinationScopeId: error.scopeId,
      destinationTargetCount: error.targetCount,
    };
  }
  if (error instanceof TargetScopeViolationError) {
    return {
      phase,
      code: "scope_ownership_violation",
      ...context,
      ...(error.scopeId === context.sourceScopeId
        ? { sourceScopeId: error.scopeId }
        : { destinationScopeId: error.scopeId }),
    };
  }
  return {
    phase,
    code:
      phase === "authentication_barrier"
        ? "authentication_failed"
        : "unexpected_error",
    ...context,
  };
}

async function runNodePhase<T>(
  phase: WorkflowNodeExecutionPhase,
  run: () => T | Promise<T>,
  context: ScopeDiagnosticContext = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new WorkflowNodeExecutionError(
      buildNodeDiagnostic(phase, error, context),
      { cause: error },
    );
  }
}

function sumTokenTotals(results: RunAgentResult[]): RunAgentTokenTotals {
  return results.reduce<RunAgentTokenTotals>(
    (totals, result) => ({
      input_tokens: totals.input_tokens + result.tokenTotals.input_tokens,
      cached_input_tokens:
        totals.cached_input_tokens + result.tokenTotals.cached_input_tokens,
      output_tokens: totals.output_tokens + result.tokenTotals.output_tokens,
      total_tokens: totals.total_tokens + result.tokenTotals.total_tokens,
    }),
    {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  );
}

function flattenNodeResults(
  nodes: WorkflowNode[],
  runResults: Map<string, RunAgentResult>,
): Pick<
  RunAgentResult,
  | "steps"
  | "stepsHistory"
  | "mainLoopEntries"
  | "stepTokenUsage"
  | "stepRuntimeMetrics"
  | "stepArtifacts"
> {
  const steps: RunAgentResult["steps"] = [];
  const stepsHistory: RunAgentResult["stepsHistory"] = [];
  const mainLoopEntries: RunAgentResult["mainLoopEntries"] = [];
  const stepTokenUsage: RunAgentResult["stepTokenUsage"] = [];
  const stepRuntimeMetrics: RunAgentResult["stepRuntimeMetrics"] = [];
  const stepArtifacts: NonNullable<RunAgentResult["stepArtifacts"]> = [];
  let offset = 0;

  for (const node of nodes) {
    const result = runResults.get(node.id);
    if (!result) continue;
    steps.push(
      ...result.steps.map((entry) => ({
        ...entry,
        step: entry.step + offset,
      })),
    );
    stepsHistory.push(...result.stepsHistory);
    mainLoopEntries.push(
      ...result.mainLoopEntries.map((entry) => ({
        ...entry,
        step: entry.step + offset,
        workflow_node_id: node.id,
        workflow_node_kind: node.kind,
      })),
    );
    stepTokenUsage.push(
      ...result.stepTokenUsage.map((entry) => ({
        ...entry,
        step: entry.step + offset,
      })),
    );
    stepRuntimeMetrics.push(
      ...result.stepRuntimeMetrics.map((entry) => ({
        ...entry,
        stepNumber: entry.stepNumber + offset,
      })),
    );
    stepArtifacts.push(
      ...(result.stepArtifacts ?? []).map((entry) => ({
        ...entry,
        stepNumber: entry.stepNumber + offset,
      })),
    );
    offset += result.mainLoopEntries.length;
  }

  return {
    steps,
    stepsHistory,
    mainLoopEntries,
    stepTokenUsage,
    stepRuntimeMetrics,
    ...(stepArtifacts.length > 0 ? { stepArtifacts } : {}),
  };
}

/** Dispatches to the existing direct runner or a scoped DAG workflow. */
export async function runAgentWithWorkflow(
  input: RunAgentInput,
  workflowMaxParallelNodes = 4,
): Promise<RunAgentResult> {
  if (input.featureFlags.workflowOrchestration) {
    throwIfAborted(input.abortSignal);
  }
  const resolution = await resolveWorkflowPlanning({
    enabled: input.featureFlags.workflowOrchestration,
    hasInitialPlanOverride: (input.initialPlanOverride?.length ?? 0) > 0,
    onWorkflowPlanned: input.onWorkflowPlanned,
    plan: async () =>
      await planWorkflow({
        task: input.task,
        llmOptions:
          input.stageLLMs.workflowPlanner ?? input.stageLLMs.createPlan,
        abortSignal: input.abortSignal,
        onTrace: input.recordModelInvocation,
      }),
  });
  if (resolution.status === "disabled" || resolution.status === "bypassed") {
    return await runAgent(input);
  }
  const planning = resolution.planning;
  if (planning.decision.mode === "direct") {
    const direct = await runAgent(input);
    return {
      ...direct,
      workflow: {
        decision: planning.decision,
        nodes: [],
        terminalNodeIds: [],
        result: direct.result,
        completed: direct.completed,
        successful: direct.successful,
        ...(planning.fallbackReason
          ? { fallbackReason: planning.fallbackReason }
          : {}),
      },
    };
  }

  const deps = createDefaultCoreDeps({
    featureFlags: input.featureFlags,
    userActionBehavior: input.userActionBehavior,
    onUserActionRequired: input.onUserActionRequired,
    requestAgentTakeover: input.requestAgentTakeover,
    defaultAuthProbeLLMOptions: input.stageLLMs.runAgent,
    defaultSuccessVerifierLLMOptions: input.stageLLMs.verifySuccess,
  });
  let rootSessionStarted = false;
  const runResults = new Map<string, RunAgentResult>();
  const borrowedSessions = new Map<string, BrowserSession>();
  const nodeIndex = new Map(
    planning.decision.nodes.map((node, index) => [node.id, index]),
  );
  const dependents = new Map(
    planning.decision.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const node of planning.decision.nodes) {
    for (const dependency of node.dependsOn) {
      dependents.get(dependency)?.push(node.id);
    }
  }
  const nodeScopeId = (nodeId: string): string =>
    `wf-n${nodeIndex.get(nodeId) ?? 0}`;
  const edgeScopeId = (fromId: string, toId: string): string =>
    `wf-e${nodeIndex.get(fromId) ?? 0}-${nodeIndex.get(toId) ?? 0}`;

  try {
    await input.onRunStarted?.({ task: input.task, session: input.session });
    await input.onBeforeSessionCreated?.(input.session);
    const rootResult = await createSession(deps, input.session);
    rootSessionStarted = true;
    await input.onSessionCreated?.(rootResult);
    const coordinator = new TargetScopeCoordinator(rootResult.session.browser);
    const preparation = planning.decision.nodes.find(
      (node) => node.kind === "preparation",
    ) as WorkflowNode;
    await coordinator.createPreparationScope(nodeScopeId(preparation.id));
    const defaults = getDefaultBrowserAgentArtifactDirectories();

    const workflow = await runWorkflowDAG({
      decision: planning.decision,
      maxParallelNodes: workflowMaxParallelNodes,
      abortSignal: input.abortSignal,
      onNodeEvent: (event) => console.log(formatWorkflowNodeEventLine(event)),
      executeNode: async (node, context) => {
        throwIfAborted(context.signal);
        const scopeId = nodeScopeId(node.id);
        if (node.kind !== "preparation") {
          const incomingScopes = node.dependsOn.map((dependency) =>
            edgeScopeId(dependency, node.id),
          );
          if (incomingScopes.length === 1) {
            const sourceScopeId = incomingScopes[0];
            const sourceState = coordinator.diagnosticState(sourceScopeId);
            const destinationState = coordinator.diagnosticState(scopeId);
            await runNodePhase(
              "dependency_handoff",
              () => coordinator.handoff(sourceScopeId, scopeId),
              {
                sourceScopeId,
                destinationScopeId: scopeId,
                sourceTargetCount: sourceState.targetCount,
                destinationTargetCount: destinationState.targetCount,
              },
            );
          } else {
            await runNodePhase("dependency_handoff", () =>
              coordinator.join(incomingScopes, scopeId),
            );
          }
        }

        const browser = await runNodePhase("agent_execution", () =>
          coordinator.createScopedBrowser(scopeId),
        );
        const sessionInput = {
          ...input.session,
          url: node.kind === "preparation" ? input.session.url : undefined,
          forceRestart: false,
        };
        const session = await runNodePhase("agent_execution", () =>
          createBorrowedSession(sessionInput, browser),
        );
        borrowedSessions.set(node.id, session);
        const artifactBase = input.artifactDirectories ?? defaults;
        const nodeInput: BorrowedRunAgentInput = {
          sessionInput,
          task: buildWorkflowNodeTask(node, context.dependencies),
          stageLLMs: input.stageLLMs,
          featureFlags: input.featureFlags,
          authenticationPolicy:
            node.kind === "preparation" ? "allow" : "reject",
          autoSwitchToNewTab: input.autoSwitchToNewTab,
          requestAuthDomainCandidates:
            node.kind === "preparation"
              ? input.requestAuthDomainCandidates
              : undefined,
          requestAuthIdentifierForDomain:
            node.kind === "preparation"
              ? input.requestAuthIdentifierForDomain
              : undefined,
          requestAuthPasswordForDomain:
            node.kind === "preparation"
              ? input.requestAuthPasswordForDomain
              : undefined,
          userActionBehavior:
            node.kind === "preparation" ? input.userActionBehavior : "return",
          onUserActionRequired:
            node.kind === "preparation"
              ? input.onUserActionRequired
              : undefined,
          requestAgentTakeover: input.requestAgentTakeover,
          recordModelInvocation: input.recordModelInvocation
            ? (trace) =>
                input.recordModelInvocation?.({
                  ...trace,
                  meta: {
                    ...(trace.meta ?? {}),
                    workflowNodeId: node.id,
                    workflowNodeKind: node.kind,
                  },
                })
            : undefined,
          onPreprocessedTask: input.onPreprocessedTask,
          onStepGenerated: input.onStepGenerated,
          onStepCompleted: input.onStepCompleted,
          maxSteps: input.maxSteps,
          validatorLifecycle: input.validatorLifecycle,
          saveStepsContext: input.saveStepsContext,
          artifactDirectories: {
            stepsDir: path.join(
              artifactBase.stepsDir ?? defaults.stepsDir,
              `workflow-${node.id}`,
            ),
            contextDir: path.join(
              artifactBase.contextDir ?? defaults.contextDir,
              `workflow-${node.id}`,
            ),
          },
          includeStepArtifactsInResult: input.includeStepArtifactsInResult,
          generateStep: input.generateStep,
          abortSignal: context.signal,
          cleanupSession: true,
        };
        const result = await runNodePhase("agent_execution", () =>
          runAgentWithBorrowedSession(deps, nodeInput, session),
        );
        runResults.set(node.id, result);
        if (!result.completed || !result.successful) {
          throw new WorkflowNodeExecutionError({
            phase: "result_validation",
            code:
              result.successVerification?.success === false
                ? "validation_failed"
                : "node_incomplete",
          });
        }
        if (node.kind === "preparation") {
          await runNodePhase("authentication_barrier", () =>
            assertAuthenticationBarrierCleared(session),
          );
        }

        const successors = dependents.get(node.id) ?? [];
        if (successors.length === 1) {
          const destinationScopeId = edgeScopeId(node.id, successors[0]);
          const sourceState = coordinator.diagnosticState(scopeId);
          const destinationState =
            coordinator.diagnosticState(destinationScopeId);
          await runNodePhase(
            "successor_handoff",
            () => coordinator.handoff(scopeId, destinationScopeId),
            {
              sourceScopeId: scopeId,
              destinationScopeId,
              sourceTargetCount: sourceState.targetCount,
              destinationTargetCount: destinationState.targetCount,
            },
          );
        } else if (successors.length > 1) {
          await runNodePhase(
            "successor_fanout",
            () =>
              coordinator.fanOut(
                scopeId,
                successors.map((successor) => edgeScopeId(node.id, successor)),
              ),
            {
              sourceScopeId: scopeId,
              sourceTargetCount:
                coordinator.diagnosticState(scopeId).targetCount,
            },
          );
          await runNodePhase(
            "scope_release",
            () => coordinator.releaseScope(scopeId, { closeTargets: true }),
            {
              sourceScopeId: scopeId,
              sourceTargetCount:
                coordinator.diagnosticState(scopeId).targetCount,
            },
          );
        }
        return { result: result.result };
      },
    });

    const orderedRunResults = planning.decision.nodes
      .map((node) => runResults.get(node.id))
      .filter((result): result is RunAgentResult => Boolean(result));
    const preparationResult = runResults.get(preparation.id);
    if (!preparationResult) {
      throw new Error("Workflow preparation did not produce a result.");
    }
    const singleTerminalResult =
      workflow.terminalNodeIds.length === 1
        ? runResults.get(workflow.terminalNodeIds[0])
        : undefined;
    const flattened = flattenNodeResults(planning.decision.nodes, runResults);
    return {
      preprocess: preparationResult.preprocess,
      completed: workflow.completed,
      successful: workflow.successful,
      result: workflow.result,
      ...flattened,
      tokenTotals: sumTokenTotals(orderedRunResults),
      ...(singleTerminalResult?.successVerification
        ? { successVerification: singleTerminalResult.successVerification }
        : {}),
      ...(orderedRunResults.find((result) => result.userActionRequired)
        ?.userActionRequired
        ? {
            userActionRequired: orderedRunResults.find(
              (result) => result.userActionRequired,
            )?.userActionRequired,
          }
        : {}),
      workflow,
    };
  } finally {
    if (rootSessionStarted) {
      await closeSession(deps, input.session.port);
    }
  }
}
