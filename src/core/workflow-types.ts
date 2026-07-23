export type WorkflowNodeKind = "normal" | "orchestrator";

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  task: string;
  dependsOn: string[];
}

export type WorkflowDecision =
  | {
      mode: "direct";
      reason: string;
    }
  | {
      mode: "workflow";
      reason: string;
      nodes: WorkflowNode[];
    };

export type WorkflowNodeStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type WorkflowNodeExecutionPhase =
  | "agent_execution"
  | "result_validation"
  | "authentication_barrier"
  | "dependency_handoff"
  | "successor_handoff"
  | "successor_fanout"
  | "scope_release"
  | "orchestration_expansion";

export type WorkflowNodeFailureCode =
  | "node_incomplete"
  | "validation_failed"
  | "authentication_failed"
  | "scope_missing"
  | "scope_not_empty"
  | "scope_ownership_violation"
  | "planning_failed"
  | "cancelled"
  | "unexpected_error";

/** Security-safe failure context suitable for logs and persisted artifacts. */
export interface WorkflowNodeDiagnostic {
  phase: WorkflowNodeExecutionPhase;
  code: WorkflowNodeFailureCode;
  sourceScopeId?: string;
  destinationScopeId?: string;
  sourceTargetCount?: number;
  destinationTargetCount?: number;
  cancelledByNodeId?: string;
}

export type WorkflowNodeRuntimeEvent =
  | {
      status: "started";
      nodeId: string;
      kind: WorkflowNodeKind;
    }
  | {
      status: "succeeded" | "failed" | "cancelled";
      nodeId: string;
      kind: WorkflowNodeKind;
      durationMs: number;
      diagnostic?: WorkflowNodeDiagnostic;
    };

export type OnWorkflowNodeEvent = (event: WorkflowNodeRuntimeEvent) => void;

export type WorkflowAuthenticationPolicy = "allow" | "reject";

export type WorkflowPlanningEvent =
  | {
      status: "bypassed";
      reason: "initial_plan_override";
    }
  | {
      status: "direct";
      decision: Extract<WorkflowDecision, { mode: "direct" }>;
    }
  | {
      status: "fallback";
      decision: Extract<WorkflowDecision, { mode: "direct" }>;
      fallbackReason: string;
    }
  | {
      status: "workflow";
      decision: Extract<WorkflowDecision, { mode: "workflow" }>;
    };

export type RunTaskWorkflowPlanningEvent = WorkflowPlanningEvent & {
  runIndex: number;
  totalRuns: number;
  attemptOrdinal: number;
  totalAttempts: number;
};

export type OnWorkflowPlanned = (
  event: WorkflowPlanningEvent,
) => void | Promise<void>;

export type OnRunTaskWorkflowPlanned = (
  event: RunTaskWorkflowPlanningEvent,
) => void | Promise<void>;

export interface WorkflowNodeResult {
  nodeId: string;
  kind: WorkflowNodeKind;
  status: WorkflowNodeStatus;
  result?: string | null;
  error?: string;
  diagnostic?: WorkflowNodeDiagnostic;
  durationMs?: number;
}

export interface WorkflowResult {
  /** Original model decision when one or more orchestrator nodes expanded. */
  initialDecision?: WorkflowDecision;
  /** Final resolved DAG after successful orchestrator nodes were grafted. */
  decision: WorkflowDecision;
  /** Runtime results, including replaced orchestrator control nodes. */
  nodes: WorkflowNodeResult[];
  /** Leaf nodes whose results form the workflow output. */
  terminalNodeIds: string[];
  /** Present when the workflow has exactly one terminal node. */
  finalNodeId?: string;
  result: string | null;
  completed: boolean;
  successful: boolean;
  fallbackReason?: string;
}
