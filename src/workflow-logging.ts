import type {
  RunTaskWorkflowPlanningEvent,
  WorkflowNodeRuntimeEvent,
} from "./core/workflow-types.js";

export interface WorkflowPlanningLogContext {
  taskNumber: number;
  totalTasks: number;
}

// Covers OSC/DCS strings, CSI sequences, and remaining two-byte ESC forms.
const ANSI_ESCAPE_SEQUENCE =
  /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[P^_][\s\S]*?\u001B\\|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-_])/g;
const TERMINAL_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Sanitizes untrusted model text for one printable terminal line. */
export function sanitizeWorkflowLogText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(TERMINAL_CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function printable(value: string): string {
  return sanitizeWorkflowLogText(value) || "(empty)";
}

function formatHeader(
  event: RunTaskWorkflowPlanningEvent,
  context: WorkflowPlanningLogContext,
): string {
  return [
    "=== Workflow",
    `Task ${context.taskNumber}/${context.totalTasks}`,
    `Run ${event.runIndex}/${event.totalRuns}`,
    `Attempt ${event.attemptOrdinal}/${event.totalAttempts} ===`,
  ].join(" | ");
}

/** Returns a complete readable block without a trailing newline. */
export function formatWorkflowPlanningEventBlock(
  event: RunTaskWorkflowPlanningEvent,
  context: WorkflowPlanningLogContext,
): string {
  const lines = [formatHeader(event, context)];
  if (event.status === "bypassed") {
    lines.push("Workflow decision: bypassed (explicit initial plan override).");
    return lines.join("\n");
  }
  if (event.status === "fallback") {
    lines.push(
      "Workflow decision: direct fallback.",
      `Fallback: ${printable(event.fallbackReason)}`,
      `Reason: ${printable(event.decision.reason)}`,
    );
    return lines.join("\n");
  }
  if (event.status === "direct") {
    lines.push(
      "Workflow decision: direct execution.",
      `Reason: ${printable(event.decision.reason)}`,
    );
    return lines.join("\n");
  }

  lines.push(
    `Workflow decision: DAG with ${event.decision.nodes.length} node(s).`,
    `Reason: ${printable(event.decision.reason)}`,
    "Nodes:",
  );
  for (const [index, node] of event.decision.nodes.entries()) {
    lines.push(
      `  ${index + 1}. ${printable(node.id)} [${node.kind}]`,
      `     Task: ${printable(node.task)}`,
      `     Depends on: ${
        node.dependsOn.length > 0
          ? node.dependsOn.map(printable).join(", ")
          : "none"
      }`,
    );
  }
  return lines.join("\n");
}

/** Formats one security-safe workflow lifecycle event for task logs. */
export function formatWorkflowNodeEventLine(
  event: WorkflowNodeRuntimeEvent,
): string {
  const fields = [
    "[workflow-node]",
    `node=${printable(event.nodeId)}`,
    `kind=${event.kind}`,
    `status=${event.status}`,
  ];
  if (event.status === "started") return fields.join(" ");

  fields.push(`duration_ms=${event.durationMs}`);
  const diagnostic = event.diagnostic;
  if (!diagnostic) return fields.join(" ");

  fields.push(`phase=${diagnostic.phase}`, `code=${diagnostic.code}`);
  if (diagnostic.sourceScopeId) {
    fields.push(`source_scope=${printable(diagnostic.sourceScopeId)}`);
  }
  if (diagnostic.destinationScopeId) {
    fields.push(
      `destination_scope=${printable(diagnostic.destinationScopeId)}`,
    );
  }
  if (diagnostic.sourceTargetCount !== undefined) {
    fields.push(`source_targets=${diagnostic.sourceTargetCount}`);
  }
  if (diagnostic.destinationTargetCount !== undefined) {
    fields.push(`destination_targets=${diagnostic.destinationTargetCount}`);
  }
  if (diagnostic.cancelledByNodeId) {
    fields.push(`cancelled_by=${printable(diagnostic.cancelledByNodeId)}`);
  }
  return fields.join(" ");
}
