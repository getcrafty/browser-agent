import { assert } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import yaml from "js-yaml";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import { makeFakeBrowser } from "./helpers/core-deps-fixtures.js";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-page-actions-"));
	const pages = path.join(root, "pages");
	fs.mkdirSync(pages);
	const memoryFile = path.join(root, "memory.txt");
	fs.writeFileSync(memoryFile, "scratch");
	return { root, pages, memoryFile };
}

describe("saved-page actions", () => {
	it("accumulates sequential captures and clears them through memory_result", async () => {
		const files = fixture();
		let sequence = 1;
		try {
			const captureCalls: number[] = [];
			const result = await executeActions({
				b: makeFakeBrowser(9222),
				actions: [{ type: "extract_data" }, { type: "extract_data" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				capturedPagesDirectory: files.pages,
				allocateCapturedPageSequence: () => sequence++,
				captureCurrentPageToMarkdown: async ({ directory, sequence }) => {
					captureCalls.push(sequence);
					const fileName = `${sequence} - https_example.com.md`;
					const filePath = path.join(directory, fileName);
					fs.writeFileSync(filePath, `page ${sequence}`);
					return {
						fileName,
						filePath,
						title: "Page",
						url: "https://example.com",
					};
				},
			});
			assert.deepEqual(captureCalls, [1, 2]);
			assert.lengthOf(result.toolObservations ?? [], 2);
			await executeActions({
				b: makeFakeBrowser(9222),
				actions: [{ type: "memory_clear", target: "memory_result" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				capturedPagesDirectory: files.pages,
				resetCapturedPageSequence: () => {
					sequence = 1;
				},
			});
			assert.deepEqual(fs.readdirSync(files.pages), []);
			assert.equal(sequence, 1);
			assert.equal(fs.readFileSync(files.memoryFile, "utf-8"), "scratch");
		} finally {
			fs.rmSync(files.root, { recursive: true, force: true });
		}
	});

	it("returns Pi results on complete and feedback without completion on incomplete", async () => {
		const files = fixture();
		try {
			const traces: unknown[] = [];
			const complete = await executeActions({
				b: makeFakeBrowser(9222),
				actions: [{ type: "return_results" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				capturedPagesDirectory: files.pages,
				userTask: "Find the grounded result",
				piAgent: { model: "openai/gpt-5.4:low", apiKey: "secret" },
				stepNumber: 7,
				recordModelInvocation: (trace) => traces.push(trace),
				runPiResultAgent: async (input) => {
					assert.equal(input.model, "openai/gpt-5.4:low");
					assert.equal(input.task, "Find the grounded result");
					assert.equal(input.stepNumber, 7);
					input.onTrace?.({
						step_kind: "stage_llm",
						stage: "piResultAgent",
						attempt: 1,
						caller: "return_results:piAgent:turn1",
						provider: "openai",
						model: "gpt-5.4",
						messages: [],
						usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
						reasoning_tokens: "",
					});
					return {
						status: "complete",
						results: [{ link: "https://example.com", summary: "Grounded" }],
					};
				},
			});
			assert.deepEqual(yaml.load(complete.returnedResult ?? ""), [
				{ link: "https://example.com", summary: "Grounded" },
			]);
			assert.lengthOf(traces, 1);

			const incomplete = await executeActions({
				b: makeFakeBrowser(9222),
				actions: [{ type: "return_results" }, { type: "extract_data" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				capturedPagesDirectory: files.pages,
				piAgent: { model: "openai/gpt-5.4:low" },
				runPiResultAgent: async () => ({
					status: "incomplete",
					feedback: "Open the item detail page and save it.",
				}),
				captureCurrentPageToMarkdown: async () => {
					throw new Error("later batch action must not execute");
				},
			});
			assert.isUndefined(incomplete.returnedResult);
			assert.deepEqual(incomplete.interactionErrors, []);
			assert.include(
				(incomplete.toolObservations ?? []).join("\n"),
				"Open the item detail page",
			);
		} finally {
			fs.rmSync(files.root, { recursive: true, force: true });
		}
	});

	it("surfaces Pi timeouts, authentication failures, and malformed-output failures", async () => {
		for (const message of [
			"Pi result agent timed out after 5ms",
			"Pi authentication failed",
			"Pi return_results response is not valid YAML",
		]) {
			const files = fixture();
			try {
				const result = await executeActions({
					b: makeFakeBrowser(9222),
					actions: [{ type: "return_results" }],
					openTabs: [],
					memoryFile: files.memoryFile,
					capturedPagesDirectory: files.pages,
					piAgent: { model: "openai/gpt-5.4:low" },
					runPiResultAgent: async () => {
						throw new Error(message);
					},
				});
				assert.isUndefined(result.returnedResult);
				assert.include(result.interactionErrors.join("\n"), message);
			} finally {
				fs.rmSync(files.root, { recursive: true, force: true });
			}
		}
	});

	it("redacts the Pi API key from failures and logs", async () => {
		const files = fixture();
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (...values) => logs.push(values.join(" "));
		try {
			const result = await executeActions({
				b: makeFakeBrowser(9222),
				actions: [{ type: "return_results" }],
				openTabs: [],
				memoryFile: files.memoryFile,
				capturedPagesDirectory: files.pages,
				piAgent: { model: "openai/gpt-5.4:low", apiKey: "pi-secret" },
				runPiResultAgent: async () => {
					throw new Error("provider rejected pi-secret");
				},
			});
			assert.notInclude(JSON.stringify(result), "pi-secret");
			assert.notInclude(logs.join("\n"), "pi-secret");
			assert.include(result.interactionErrors.join("\n"), "[REDACTED]");
		} finally {
			console.log = originalLog;
			fs.rmSync(files.root, { recursive: true, force: true });
		}
	});
});
