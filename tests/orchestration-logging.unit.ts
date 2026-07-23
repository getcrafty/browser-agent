import { assert } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "mocha";
import {
  resetOrchestrationLogsDir,
  saveOrchestrationLogs,
} from "../src/orchestration-logging.js";

describe("orchestration logging", () => {
  it("stores one self-contained DAG file per task attempt without subdirectories", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-agent-orchestration-"),
    );
    try {
      const outputDir = saveOrchestrationLogs({
        orchestrationLogsDir: path.join(root, "orchestration_logs"),
        taskNumber: 2,
        event: {
          status: "workflow",
          runIndex: 3,
          totalRuns: 4,
          attemptOrdinal: 2,
          totalAttempts: 3,
          decision: {
            mode: "workflow",
            reason: "Parallel work",
            nodes: [
              {
                id: "node_1",
                kind: "preparation",
                task: "Open the site",
                dependsOn: [],
              },
              {
                id: "node_2",
                kind: "synthesis",
                task: "Summarize the result",
                dependsOn: ["node_1"],
              },
            ],
          },
        },
      });

      const expectedFile = path.join(
        root,
        "orchestration_logs",
        "dag-task-002-attempt-008.json",
      );
      assert.equal(outputDir, expectedFile);
      assert.deepEqual(fs.readdirSync(path.join(root, "orchestration_logs")), [
        "dag-task-002-attempt-008.json",
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(expectedFile, "utf-8")), {
        mode: "workflow",
        reason: "Parallel work",
        nodes: [
          {
            id: "node_1",
            kind: "preparation",
            task: "Open the site",
            dependsOn: [],
          },
          {
            id: "node_2",
            kind: "synthesis",
            task: "Summarize the result",
            dependsOn: ["node_1"],
          },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears stale nested layouts before a run", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-agent-orchestration-"),
    );
    const logsDir = path.join(root, "orchestration_logs");
    try {
      fs.mkdirSync(path.join(logsDir, "stale", "nested"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(logsDir, "stale", "dag.json"), "{}\n");

      resetOrchestrationLogsDir(true, logsDir);

      assert.deepEqual(fs.readdirSync(logsDir), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create artifacts for a direct decision", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-agent-orchestration-"),
    );
    try {
      const output = saveOrchestrationLogs({
        orchestrationLogsDir: path.join(root, "orchestration_logs"),
        taskNumber: 1,
        event: {
          status: "direct",
          runIndex: 1,
          totalRuns: 1,
          attemptOrdinal: 1,
          totalAttempts: 1,
          decision: { mode: "direct", reason: "Simple task" },
        },
      });
      assert.isUndefined(output);
      assert.isFalse(fs.existsSync(path.join(root, "orchestration_logs")));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
