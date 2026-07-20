import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import type { Browser } from "../src/browser/types.js";
import { validateGeneratedWebsiteTool } from "../src/website-tool-validation.js";

test("validates an explicit successful result through the production loader", async () => {
	await withTool(
		"valid_tool",
		`import { sleep } from "../../src/browser/index.js";

export async function runWebsiteTool() {
	await sleep(0);
	return {
		completed: true,
		result: { url: "https://example.com/result" },
		notes: ["ready"],
	};
}`,
		async ({ generatedToolsDir, browser }) => {
			const receipt = await validateGeneratedWebsiteTool({
				artifactHash: "sha256:test",
				exampleIndex: 0,
				name: "valid_tool",
				inputs: { query: "chairs" },
				browser,
				generatedToolsDir,
				currentUrl: "https://example.com/",
			});

			assert.equal(receipt.passed, true);
			assert.equal(receipt.code, "SUCCESS");
			assert.equal(receipt.completed, true);
			assert.equal(receipt.artifactHash, "sha256:test");
			assert.equal(receipt.finalUrl, "https://example.com/final");
			assert.deepEqual(receipt.result, {
				url: "https://example.com/result",
			});
			assert.deepEqual(receipt.notes, ["ready"]);
		},
	);
});

test("rejects completed:false and thrown tool outcomes", async () => {
	await withTool(
		"incomplete_tool",
		`export async function runWebsiteTool() {
	return { completed: false, notes: ["no stable result state"] };
}`,
		async ({ generatedToolsDir, browser }) => {
			const receipt = await validate(
				generatedToolsDir,
				browser,
				"incomplete_tool",
			);
			assert.equal(receipt.passed, false);
			assert.equal(receipt.code, "INCOMPLETE");
			assert.deepEqual(receipt.notes, ["no stable result state"]);
		},
	);

	await withTool(
		"throwing_tool",
		`export async function runWebsiteTool() {
	throw new TypeError("cannot read best");
}`,
		async ({ generatedToolsDir, browser }) => {
			const receipt = await validate(
				generatedToolsDir,
				browser,
				"throwing_tool",
			);
			assert.equal(receipt.passed, false);
			assert.equal(receipt.code, "EXECUTION_ERROR");
			assert.deepEqual(receipt.notes, ["cannot read best"]);
		},
	);
});

test("classifies discovery failures and clears bounded timeout timers", async () => {
	await withTool(
		"domain_tool",
		`export async function runWebsiteTool() {
	return { completed: true };
}`,
		async ({ generatedToolsDir, browser }) => {
			const missing = await validateGeneratedWebsiteTool({
				exampleIndex: 0,
				name: "domain_tool",
				inputs: { query: "chairs" },
				browser,
				generatedToolsDir,
				currentUrl: "https://other.example/",
			});
			assert.equal(missing.code, "HARNESS_ERROR");
			assert.match(missing.notes[0], /not found for current domain/);
		},
	);

	await withTool(
		"timeout_tool",
		`export async function runWebsiteTool() {
	return await new Promise(() => {});
}`,
		async ({ generatedToolsDir, browser }) => {
			const startedAt = performance.now();
			const timedOut = await validateGeneratedWebsiteTool({
				exampleIndex: 0,
				name: "timeout_tool",
				inputs: { query: "chairs" },
				browser,
				generatedToolsDir,
				currentUrl: "https://example.com/",
				timeoutMs: 10,
			});
			assert.equal(timedOut.code, "TIMEOUT");
			assert.ok(performance.now() - startedAt < 1_000);
		},
	);
});

test("captures browser Runtime.evaluate inspection exceptions", async () => {
	await withTool(
		"inspection_tool",
		`export async function runWebsiteTool() {
	return { completed: true };
}`,
		async ({ generatedToolsDir }) => {
			const receipt = await validateGeneratedWebsiteTool({
				exampleIndex: 0,
				name: "inspection_tool",
				inputs: { query: "chairs" },
				browser: fakeBrowser({ failInspection: true }),
				generatedToolsDir,
				currentUrl: "https://example.com/",
			});

			assert.equal(receipt.code, "BROWSER_INSPECTION_ERROR");
			assert.match(receipt.notes[0], /inspection exploded/);
		},
	);
});

test("bounds notes and structured result data in receipts", async () => {
	await withTool(
		"large_tool",
		`export async function runWebsiteTool() {
	return {
		completed: true,
		notes: ["x".repeat(10000)],
		result: { text: "y".repeat(20000) },
	};
}`,
		async ({ generatedToolsDir, browser }) => {
			const receipt = await validate(
				generatedToolsDir,
				browser,
				"large_tool",
			);
			assert.equal(receipt.code, "SUCCESS");
			assert.equal(receipt.notesTruncated, true);
			assert.ok(
				Buffer.byteLength(receipt.notes.join(""), "utf8") <= 4 * 1024,
			);
			assert.equal(receipt.result, undefined);
			assert.equal(receipt.resultOmitted?.reason, "size_limit");
			assert.ok((receipt.resultOmitted?.bytes ?? 0) > 16 * 1024);
		},
	);
});

test("catches compiler-injected __name in a stringified browser helper", async () => {
	const source = `async function pageProbe(): Promise<string> {
	const fold = (value: unknown): string => String(value).toLowerCase();
	return fold("OK");
}

export async function runWebsiteTool(input: any) {
	const response = await input.browser.Runtime.evaluate({
		expression: "(" + pageProbe.toString() + ")()",
		awaitPromise: true,
		returnByValue: true,
	});
	if (response.exceptionDetails) {
		throw new Error(
			response.exceptionDetails.exception?.description ??
				response.exceptionDetails.text,
		);
	}
	return { completed: response.result.value === "ok" };
}`;
	assert.doesNotMatch(source, /\b__name\b/);

	await withTool(
		"name_regression_tool",
		source,
		async ({ generatedToolsDir, browser }) => {
			const receipt = await validate(
				generatedToolsDir,
				browser,
				"name_regression_tool",
			);
			assert.equal(receipt.code, "EXECUTION_ERROR");
			assert.match(receipt.notes[0], /__name is not defined/);
		},
	);
});

async function validate(
	generatedToolsDir: string,
	browser: Browser,
	name: string,
) {
	return await validateGeneratedWebsiteTool({
		exampleIndex: 0,
		name,
		inputs: { query: "chairs" },
		browser,
		generatedToolsDir,
		currentUrl: "https://example.com/",
	});
}

async function withTool(
	name: string,
	script: string,
	run: (params: {
		generatedToolsDir: string;
		browser: Browser;
	}) => Promise<void>,
): Promise<void> {
	const agentRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const generatedToolsDir = fs.mkdtempSync(
		path.join(agentRoot, ".website-validation-"),
	);
	const bundleDir = path.join(generatedToolsDir, name);
	fs.mkdirSync(bundleDir, { recursive: true });
	fs.writeFileSync(
		path.join(bundleDir, "tool.json"),
		JSON.stringify({
			name,
			description: "Validation fixture",
			inputSchema: { query: { type: "string" } },
			domains: ["example.com"],
			createdAt: "2026-07-15T00:00:00.000Z",
			endState: "A deterministic fixture state is visible",
		}),
	);
	fs.writeFileSync(path.join(bundleDir, "index.ts"), script);
	try {
		await run({ generatedToolsDir, browser: fakeBrowser() });
	} finally {
		fs.rmSync(generatedToolsDir, { recursive: true, force: true });
	}
}

function fakeBrowser(options: { failInspection?: boolean } = {}): Browser {
	const Runtime = {
		evaluate: async ({ expression }: { expression: string }) => {
			if (expression.includes("finalUrl: location.href")) {
				if (options.failInspection) {
					return {
						result: {},
						exceptionDetails: {
							text: "Uncaught",
							exception: { description: "inspection exploded" },
						},
					};
				}
				return {
					result: {
						value: {
							finalUrl: "https://example.com/final",
							finalTitle: "Fixture page",
						},
					},
				};
			}
			try {
				const value = await vm.runInNewContext(expression, {
					String,
				});
				return { result: { value } };
			} catch (error) {
				const description =
					error instanceof Error
						? (error.stack ?? error.message)
						: String(error);
				return {
					result: {},
					exceptionDetails: {
						text: "Uncaught",
						exception: { description },
					},
				};
			}
		},
	};
	return { Runtime } as unknown as Browser;
}
