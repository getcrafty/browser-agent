import * as fs from "node:fs";
import * as path from "node:path";
import type { RunTaskWorkflowPlanningEvent } from "./core/workflow-types.js";

function padded(value: number): string {
  return String(value).padStart(3, "0");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function resetOrchestrationLogsDir(
  enabled: boolean,
  orchestrationLogsDir: string,
): void {
  if (fs.existsSync(orchestrationLogsDir)) {
    fs.rmSync(orchestrationLogsDir, { recursive: true, force: true });
  }
  if (enabled) {
    fs.mkdirSync(orchestrationLogsDir, { recursive: true });
  }
}

function taskAttemptIndex(event: RunTaskWorkflowPlanningEvent): number {
  return (event.runIndex - 1) * event.totalAttempts + event.attemptOrdinal;
}

/** Persists one flat, self-contained validated DAG file per task attempt. */
export function saveOrchestrationLogs(params: {
  orchestrationLogsDir: string;
  taskNumber: number;
  event: RunTaskWorkflowPlanningEvent;
}): string | undefined {
  if (params.event.status !== "workflow") return undefined;

  fs.mkdirSync(params.orchestrationLogsDir, { recursive: true });
  const filePath = path.join(
    params.orchestrationLogsDir,
    `dag-task-${padded(params.taskNumber)}-attempt-${padded(taskAttemptIndex(params.event))}.json`,
  );
  writeJson(filePath, params.event.decision);
  return filePath;
}
