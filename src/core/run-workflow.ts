import * as path from "node:path";
import {
  planWorkflow,
  planWorkflowExpansion,
} from "../agents/workflow-planner.js";
import {
  materializeAggregatedResults,
  selectAggregatedResults,
  type AggregatedResultCandidate,
} from "../agents/aggregated-results.js";
import { verifyTaskSuccess as defaultVerifyTaskSuccess } from "../agents/success-verifier.js";
import type {
  StepResult,
  SuccessVerificationResult,
  TokenUsage,
} from "../agents/types.js";
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
  WorkflowResult,
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

function sumTokenTotals(
  results: RunAgentResult[],
  additionalUsages: TokenUsage[] = [],
): RunAgentTokenTotals {
  const totals = results.reduce<RunAgentTokenTotals>(
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
  for (const usage of additionalUsages) {
    totals.input_tokens += usage.input_tokens;
    totals.cached_input_tokens += usage.cached_input_tokens ?? 0;
    totals.output_tokens += usage.output_tokens;
    totals.total_tokens += usage.total_tokens;
  }
  return totals;
}

export function buildAggregatedResultCandidates(
  workflow: WorkflowResult,
): AggregatedResultCandidate[] {
  if (workflow.decision.mode !== "workflow") return [];
  const resultByNodeId = new Map(
    workflow.nodes.map((node) => [node.nodeId, node]),
  );
  return workflow.decision.nodes.map((node, position) => {
    const nodeResult = resultByNodeId.get(node.id);
    const result = nodeResult?.result;
    return {
      index: position + 1,
      nodeId: node.id,
      kind: node.kind,
      task: node.task,
      status: nodeResult?.status ?? "pending",
      result,
      selectable:
        node.kind === "normal" &&
        nodeResult?.status === "succeeded" &&
        typeof result === "string" &&
        result.trim().length > 0,
    };
  });
}

export interface FinalizeWorkflowAggregateInput {
  task: string;
  workflow: WorkflowResult;
  executedSteps: number;
  aggregatedResultsLLMOptions: NonNullable<
    RunAgentInput["stageLLMs"]["aggregatedResults"]
  >;
  verifySuccessLLMOptions: NonNullable<
    RunAgentInput["stageLLMs"]["verifySuccess"]
  >;
  abortSignal?: AbortSignal;
  recordModelInvocation?: RunAgentInput["recordModelInvocation"];
  select?: typeof selectAggregatedResults;
  verify?: typeof defaultVerifyTaskSuccess;
}

export interface FinalizeWorkflowAggregateResult {
  workflow: WorkflowResult;
  result: string;
  successVerification: SuccessVerificationResult;
  usages: TokenUsage[];
}

export async function finalizeWorkflowAggregate(
  input: FinalizeWorkflowAggregateInput,
): Promise<FinalizeWorkflowAggregateResult> {
  if (!input.workflow.successful || !input.workflow.completed) {
    throw new Error("Cannot aggregate an incomplete workflow");
  }
  const candidates = buildAggregatedResultCandidates(input.workflow);
  const selection = await (input.select ?? selectAggregatedResults)({
    task: input.task,
    candidates,
    llmOptions: input.aggregatedResultsLLMOptions,
    abortSignal: input.abortSignal,
    onTrace: input.recordModelInvocation,
  });
  const aggregate = materializeAggregatedResults({
    candidates,
    selectedNodeIndices: selection.selectedNodeIndices,
  });
  const finalStep: StepResult = {
    thinking: "",
    previousStepPlanUpdate: [],
    previousStepStatus: "progressed",
    previousStepOutcome: "Completed all workflow nodes.",
    currentStateObservation: "Selected workflow results were aggregated.",
    nextActionRationale: "Validate the aggregate against the original task.",
    actions: [{ type: "return_results" }],
    done: true,
    result: aggregate.result,
  };
  const successVerification = await (input.verify ?? defaultVerifyTaskSuccess)({
    task: input.task,
    executedSteps: input.executedSteps,
    finalStep,
    finalPromptPayload: {},
    checklist: [],
    purpose: "completion_verifier",
    contextMode: "compact",
    llmOptions: input.verifySuccessLLMOptions,
    caller: "runAgentWithWorkflow:verifyAggregate",
    onTrace: input.recordModelInvocation,
    traceMeta: { phase: "workflow_aggregate_validation" },
  });
  return {
    result: aggregate.result,
    successVerification,
    usages: [...selection.usages, successVerification.usage],
    workflow: {
      ...input.workflow,
      selectedNodeIndices: selection.selectedNodeIndices,
      selectedNodeIds: aggregate.selectedNodeIds,
      result: aggregate.result,
      completed: true,
      successful: successVerification.success,
      successVerification,
    },
  };
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
  const nodeOrdinal = new Map(
    planning.decision.nodes.map((node, index) => [node.id, index]),
  );
  let nextNodeOrdinal = planning.decision.nodes.length;
  const ensureNodeOrdinal = (nodeId: string): number => {
    const existing = nodeOrdinal.get(nodeId);
    if (existing !== undefined) return existing;
    const ordinal = nextNodeOrdinal;
    nextNodeOrdinal += 1;
    nodeOrdinal.set(nodeId, ordinal);
    return ordinal;
  };
  const nodeScopeId = (nodeId: string): string =>
    `wf-n${ensureNodeOrdinal(nodeId)}`;
  const edgeScopeId = (fromId: string, toId: string): string =>
    `wf-e${ensureNodeOrdinal(fromId)}-${ensureNodeOrdinal(toId)}`;

  try {
    await input.onRunStarted?.({ task: input.task, session: input.session });
    await input.onBeforeSessionCreated?.(input.session);
    const rootResult = await createSession(deps, input.session);
    rootSessionStarted = true;
    await input.onSessionCreated?.(rootResult);
    const coordinator = new TargetScopeCoordinator(rootResult.session.browser);
    const initialNode = planning.decision.nodes[0] as WorkflowNode;
    await coordinator.createInitialScope(nodeScopeId(initialNode.id));
    const defaults = getDefaultBrowserAgentArtifactDirectories();
    const preparedExpansionRoots = new Set<string>();

    const workflow = await runWorkflowDAG({
      decision: planning.decision,
      maxParallelNodes: workflowMaxParallelNodes,
      abortSignal: input.abortSignal,
      onNodeEvent: (event) => console.log(formatWorkflowNodeEventLine(event)),
      expandNode: async (node, context) => {
        try {
          const expansion = await planWorkflowExpansion({
            task: buildWorkflowNodeTask(node, context.dependencies),
            workflowNodeId: node.id,
            llmOptions:
              input.stageLLMs.workflowPlanner ?? input.stageLLMs.createPlan,
            abortSignal: context.signal,
            onTrace: input.recordModelInvocation,
          });
          return { reason: expansion.reason, nodes: expansion.nodes };
        } catch (error) {
          throwIfAborted(context.signal);
          throw new WorkflowNodeExecutionError(
            {
              phase: "orchestration_expansion",
              code: "planning_failed",
            },
            { cause: error },
          );
        }
      },
      prepareExpansion: async ({ signal, orchestrator, rootNodes }) => {
        throwIfAborted(signal);
        for (const node of rootNodes) ensureNodeOrdinal(node.id);
        await runNodePhase("orchestration_expansion", async () => {
          const controlScopeId = nodeScopeId(orchestrator.id);
          const incomingScopes = orchestrator.dependsOn.map((dependency) =>
            edgeScopeId(dependency, orchestrator.id),
          );
          if (incomingScopes.length === 1) {
            coordinator.handoff(incomingScopes[0], controlScopeId);
          } else {
            coordinator.join(incomingScopes, controlScopeId);
          }
          if (rootNodes.length === 1) {
            coordinator.handoff(controlScopeId, nodeScopeId(rootNodes[0].id));
          } else {
            await coordinator.fanOut(
              controlScopeId,
              rootNodes.map((node) => nodeScopeId(node.id)),
            );
            await coordinator.releaseScope(controlScopeId, {
              closeTargets: true,
            });
          }
          for (const node of rootNodes) preparedExpansionRoots.add(node.id);
        });
      },
      executeNode: async (node, context) => {
        throwIfAborted(context.signal);
        const scopeId = nodeScopeId(node.id);
        const isInitialNode = node.id === initialNode.id;
        const expansionRootPrepared = preparedExpansionRoots.delete(node.id);
        if (!isInitialNode && !expansionRootPrepared) {
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
          url: isInitialNode ? input.session.url : undefined,
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
          authenticationPolicy: isInitialNode ? "allow" : "reject",
          autoSwitchToNewTab: input.autoSwitchToNewTab,
          requestAuthDomainCandidates: isInitialNode
            ? input.requestAuthDomainCandidates
            : undefined,
          requestAuthIdentifierForDomain: isInitialNode
            ? input.requestAuthIdentifierForDomain
            : undefined,
          requestAuthPasswordForDomain: isInitialNode
            ? input.requestAuthPasswordForDomain
            : undefined,
          userActionBehavior: isInitialNode
            ? input.userActionBehavior
            : "return",
          onUserActionRequired: isInitialNode
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
        if (isInitialNode) {
          await runNodePhase("authentication_barrier", () =>
            assertAuthenticationBarrierCleared(session),
          );
        }

        const successors = context.successors.map((successor) => successor.id);
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

    if (workflow.decision.mode !== "workflow") {
      throw new Error("Resolved workflow decision was not a workflow.");
    }
    const resolvedNodes = workflow.decision.nodes;
    const orderedRunResults = resolvedNodes
      .map((node) => runResults.get(node.id))
      .filter((result): result is RunAgentResult => Boolean(result));
    const initialNodeResult = runResults.get(initialNode.id);
    if (!initialNodeResult) {
      throw new Error("Workflow initial node did not produce a result.");
    }
    const flattened = flattenNodeResults(resolvedNodes, runResults);
    let finalizedWorkflow = workflow;
    let finalizedResult = workflow.result;
    let aggregateVerification: SuccessVerificationResult | undefined;
    let aggregateUsages: TokenUsage[] = [];
    if (workflow.successful && workflow.completed) {
      if (!input.stageLLMs.aggregatedResults) {
        throw new Error(
          "Workflow orchestration requires stageLLMs.aggregatedResults",
        );
      }
      if (!input.stageLLMs.verifySuccess) {
        throw new Error(
          "Workflow aggregate validation requires stageLLMs.verifySuccess",
        );
      }
      const finalized = await finalizeWorkflowAggregate({
        task: input.task,
        workflow,
        executedSteps: flattened.mainLoopEntries.length,
        aggregatedResultsLLMOptions: input.stageLLMs.aggregatedResults,
        verifySuccessLLMOptions: input.stageLLMs.verifySuccess,
        abortSignal: input.abortSignal,
        recordModelInvocation: input.recordModelInvocation,
      });
      finalizedWorkflow = finalized.workflow;
      finalizedResult = finalized.result;
      aggregateVerification = finalized.successVerification;
      aggregateUsages = finalized.usages;
    }
    return {
      preprocess: initialNodeResult.preprocess,
      completed: finalizedWorkflow.completed,
      successful: finalizedWorkflow.successful,
      result: finalizedResult,
      ...flattened,
      tokenTotals: sumTokenTotals(orderedRunResults, aggregateUsages),
      ...(aggregateVerification
        ? { successVerification: aggregateVerification }
        : {}),
      ...(orderedRunResults.find((result) => result.userActionRequired)
        ?.userActionRequired
        ? {
            userActionRequired: orderedRunResults.find(
              (result) => result.userActionRequired,
            )?.userActionRequired,
          }
        : {}),
      workflow: finalizedWorkflow,
    };
  } finally {
    if (rootSessionStarted) {
      await closeSession(deps, input.session.port);
    }
  }
}
