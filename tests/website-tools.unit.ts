import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import {
	normalizeActionList,
	normalizeActionListWithDiagnostics,
} from "../src/agents/executor-utils/action-normalization.js";
import { getExecutorSystem } from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import {
	defaultGeneratedToolsDir,
	formatWebsiteToolsForPrompt,
	loadWebsiteToolDescriptors,
	parseWebsiteToolGuidance,
	runGeneratedWebsiteTool,
} from "../src/website-tools.js";
import type { Browser } from "../src/browser/types.js";

describe("website apification tools", () => {
	it("does not expose the removed website-tool:create script", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
		) as { scripts?: Record<string, string> };
		assert.notProperty(packageJson.scripts ?? {}, "website-tool:create");
	});

	it("normalizes website_tool actions", () => {
		assert.deepEqual(
			normalizeActionList([
				{
					website_tool: {
						name: "search_prices",
						inputs: {
							query: "chairs",
							count: 2,
							include_ads: false,
							ignored: { nested: true },
						},
					},
				},
			]),
			[
				{
					type: "website_tool",
					name: "search_prices",
					inputs: {
						query: "chairs",
						count: 2,
						include_ads: false,
					},
				},
			],
		);

		const malformed = normalizeActionListWithDiagnostics([
			{ website_tool: { inputs: { query: "chairs" } } },
		]);
		assert.deepEqual(malformed.actions, []);
		assert.deepEqual(malformed.diagnostics, [
			'actions[0]: website_tool requires a non-empty "name" string',
		]);
	});

	it("injects generated tool descriptions only when enabled, domain-matched, and not excluded", async () => {
		const original = { ...configFeatureFlags };
		await withGeneratedTool("search_prices", async () => {
			try {
				setConfigFeatureFlags({ websiteAPIficationTools: false });
				assert.notInclude(
					getExecutorSystem({
						currentUrl: "https://example.com/search",
					}),
					"search_prices",
				);
				assert.notInclude(
					getExecutorSystem({
						currentUrl: "https://example.com/search",
					}),
					"websiteToolResults",
				);

				setConfigFeatureFlags({ websiteAPIficationTools: true });
				const enabledPrompt = getExecutorSystem({
					currentUrl: "https://example.com/search",
				});
				assert.include(enabledPrompt, "website_tool:");
				assert.include(
					enabledPrompt,
					`  - website_tool:\n      name: "tool_name"\n      inputs:\n        query: "value"`,
				);
				assert.include(enabledPrompt, "websiteToolResults");
				assert.notInclude(enabledPrompt, "Tool-call shorthand mapping");
				assert.include(
					enabledPrompt,
					"do not call extract_data for the same facts",
				);
				assert.include(enabledPrompt, "search_prices");
				assert.include(enabledPrompt, "query: string");
				assert.include(enabledPrompt, "form_ready_before_submit");
				assert.include(
					enabledPrompt,
					"Every argument is mandatory in the tool call",
				);
				assert.include(
					enabledPrompt,
					"Defaults are runtime fallbacks only",
				);

				const wrongDomainPrompt = getExecutorSystem({
					currentUrl: "https://other.example/search",
				});
				assert.notInclude(wrongDomainPrompt, "search_prices");
				assert.notInclude(wrongDomainPrompt, "websiteToolResults");

				const priorResultPrompt = getExecutorSystem({
					currentUrl: "https://other.example/search",
					websiteToolResultsAvailable: true,
				});
				assert.include(priorResultPrompt, "websiteToolResults");
				assert.notInclude(priorResultPrompt, "search_prices");

				const excludedPrompt = getExecutorSystem({
					excludedWebsiteToolNames: new Set(["search_prices"]),
					currentUrl: "https://example.com/search",
				});
				assert.notInclude(excludedPrompt, "search_prices");
				assert.notInclude(excludedPrompt, "websiteToolResults");
			} finally {
				setConfigFeatureFlags(original);
			}
		});
	});

	it("executes generated tools and disables failed tools", async () => {
		const browser = {
			Runtime: {
				evaluate: async () => ({ result: { value: 1 } }),
			},
		} as unknown as Browser;

		await withGeneratedTool("search_prices", async () => {
			const excluded = new Set<string>();
			const success = await executeActions({
				b: browser,
				actions: [
					{
						type: "website_tool",
						name: "search_prices",
						inputs: { query: "chairs" },
					},
				],
				openTabs: [],
				memoryFile: "/tmp/unused-memory.txt",
				excludedWebsiteToolNames: excluded,
				currentUrl: "https://example.com/search",
			});
			assert.deepEqual(success.interactionErrors, []);
			assert.deepEqual([...excluded], []);
			assert.deepEqual(success.websiteToolOutcome?.result, {
				profileUrl: "https://example.com/chairs",
				profileTitle: "chairs",
			});
			assert.include(
				success.toolObservations?.join("\n") ?? "",
				"result_available=true",
			);
		});

		await withGeneratedTool("search_prices", async () => {
			const excluded = new Set<string>();
			const failure = await executeActions({
				b: browser,
				actions: [
					{
						type: "website_tool",
						name: "search_prices",
						inputs: { query: "fail" },
					},
				],
				openTabs: [],
				memoryFile: "/tmp/unused-memory.txt",
				excludedWebsiteToolNames: excluded,
				currentUrl: "https://example.com/search",
			});
			assert.include(failure.interactionErrors[0], "website_tool");
			assert.include(failure.interactionErrors[0], "disabled");
			assert.deepEqual([...excluded], ["search_prices"]);
		});
	});

	it("rejects generated tool execution on non-matching domains", async () => {
		const browser = {
			Runtime: {
				evaluate: async () => ({ result: { value: 1 } }),
			},
		} as unknown as Browser;

		await withGeneratedTool("search_prices", async () => {
			const excluded = new Set<string>();
			const result = await executeActions({
				b: browser,
				actions: [
					{
						type: "website_tool",
						name: "search_prices",
						inputs: { query: "chairs" },
					},
				],
				openTabs: [],
				memoryFile: "/tmp/unused-memory.txt",
				excludedWebsiteToolNames: excluded,
				currentUrl: "https://other.example/search",
			});

			assert.include(result.interactionErrors[0], "current domain");
			assert.deepEqual([...excluded], ["search_prices"]);
		});
	});
});

describe("guided website tool bundles", () => {
	it("loads script, hybrid, guidance-only, and legacy tools", () => {
		withBundleTools((dir) => {
			writeBundle(dir, "script_only", { script: successfulScript() });
			writeBundle(dir, "hybrid", {
				script: successfulScript(),
				guidance: guide(
					"Before hybrid",
					"After hybrid",
					"Recover hybrid",
				),
			});
			writeBundle(dir, "guidance_only", {
				guidance: guide("Before guide", "After guide", "Recover guide"),
			});
			fs.writeFileSync(
				path.join(dir, "legacy.ts"),
				generatedToolSource("legacy"),
				"utf-8",
			);

			const descriptors = loadWebsiteToolDescriptors({
				enabled: true,
				generatedToolsDir: dir,
				currentUrl: "https://example.com",
			});
			assert.deepEqual(
				descriptors.map(({ metadata }) => metadata.name),
				["guidance_only", "hybrid", "legacy", "script_only"],
			);
			assert.isUndefined(
				descriptors.find(
					(item) => item.metadata.name === "guidance_only",
				)?.scriptPath,
			);
			assert.equal(
				descriptors.find((item) => item.metadata.name === "hybrid")
					?.guidance?.postScript,
				"After hybrid",
			);
		});
	});

	it("strictly validates guidance structure, sizes, and remote includes", () => {
		assert.deepEqual(
			parseWebsiteToolGuidance(guide("pre", "post", "recover")),
			{
				preScript: "pre",
				postScript: "post",
				recovery: "recover",
			},
		);
		assert.throws(
			() =>
				parseWebsiteToolGuidance(
					"## Post-script guidance\nx\n## Pre-script guidance\ny\n## Recovery guidance\nz",
				),
			"ordered headings",
		);
		assert.throws(
			() => parseWebsiteToolGuidance(`${guide("", "", "")}\n## Extra\nx`),
			"only the ordered headings",
		);
		assert.throws(
			() =>
				parseWebsiteToolGuidance(
					guide("@include https://bad.test/x", "", ""),
				),
			"remote includes",
		);
		assert.throws(
			() => parseWebsiteToolGuidance(guide("x".repeat(4097), "", "")),
			"4096 byte limit",
		);
		assert.throws(
			() => parseWebsiteToolGuidance(guide("", "x".repeat(16385), "")),
			"16384 byte limit",
		);
	});

	it("rejects malformed bundles and symlinked artifacts", () => {
		withBundleTools((dir) => {
			writeBundle(dir, "empty", {});
			writeBundle(dir, "wrong_name", {
				metadataName: "different",
				guidance: guide("", "", ""),
			});
			const target = path.join(dir, "target.md");
			fs.writeFileSync(target, guide("", "", ""), "utf-8");
			const linkedDir = path.join(dir, "linked");
			fs.mkdirSync(linkedDir);
			fs.writeFileSync(
				path.join(linkedDir, "tool.json"),
				JSON.stringify(bundleMetadata("linked")),
			);
			fs.symlinkSync(target, path.join(linkedDir, "AGENTS.md"));
			const warnings: string[] = [];
			const descriptors = loadWebsiteToolDescriptors({
				enabled: true,
				generatedToolsDir: dir,
				warn: (message) => warnings.push(message),
			});
			assert.deepEqual(descriptors, []);
			assert.lengthOf(warnings, 3);
			assert.match(warnings.join("\n"), /index\.ts or AGENTS\.md/);
			assert.match(warnings.join("\n"), /must match directory/);
			assert.match(warnings.join("\n"), /symbolic link/);
		});
	});

	it("filters by domain and omits whole tools beyond the pre-guide budget", () => {
		withBundleTools((dir) => {
			for (let index = 1; index <= 5; index += 1) {
				writeBundle(dir, `guided_${index}`, {
					guidance: guide(
						String(index).repeat(4096),
						"post",
						"recovery",
					),
				});
			}
			writeBundle(dir, "wrong_domain", {
				guidance: guide("wrong", "post", "recovery"),
				domains: ["other.test"],
			});
			const descriptors = loadWebsiteToolDescriptors({
				enabled: true,
				generatedToolsDir: dir,
				currentUrl: "https://example.com/x",
			});
			const prompt = formatWebsiteToolsForPrompt(descriptors);
			for (let index = 1; index <= 4; index += 1) {
				assert.include(prompt, `name: guided_${index}`);
			}
			assert.notInclude(prompt, "name: guided_5");
			assert.notInclude(prompt, "wrong_domain");
		});
	});

	it("returns snapshotted post and recovery outcomes", async () => {
		await withBundleTools(async (dir) => {
			writeBundle(dir, "hybrid", {
				script: outcomeScript(),
				guidance: guide("pre", "continue safely", "recover safely"),
				inputSchema: { mode: { type: "string" } },
			});
			writeBundle(dir, "guidance_only", {
				guidance: guide(
					"pre",
					"manual continuation",
					"manual recovery",
				),
			});
			writeBundle(dir, "broken_script", {
				script: "this is not valid TypeScript",
				guidance: guide("pre", "post", "repair manually"),
			});
			writeBundle(dir, "bundle_void", {
				script: "export async function runWebsiteTool() {}\n",
			});
			fs.writeFileSync(
				path.join(dir, "legacy_void.ts"),
				legacyVoidSource(),
				"utf-8",
			);
			const browser = {} as Browser;
			const success = await runGeneratedWebsiteTool({
				name: "hybrid",
				inputs: { mode: "success" },
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(success.status, "success");
			assert.equal(success.activeGuidance?.section, "post-script");
			assert.equal(success.activeGuidance?.content, "continue safely");
			assert.lengthOf(success.activeGuidance?.hash ?? "", 64);

			const incomplete = await runGeneratedWebsiteTool({
				name: "hybrid",
				inputs: { mode: "incomplete" },
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(incomplete.status, "incomplete");
			assert.isTrue(incomplete.disableTool);
			assert.equal(incomplete.activeGuidance?.section, "recovery");

			const failed = await runGeneratedWebsiteTool({
				name: "hybrid",
				inputs: { mode: "throw" },
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(failed.status, "error");
			assert.deepEqual(failed.notes, ["script failed"]);
			assert.equal(failed.activeGuidance?.content, "recover safely");

			const guidanceOnly = await runGeneratedWebsiteTool({
				name: "guidance_only",
				inputs: {},
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(guidanceOnly.status, "success");
			assert.equal(
				guidanceOnly.activeGuidance?.content,
				"manual continuation",
			);

			const brokenScript = await runGeneratedWebsiteTool({
				name: "broken_script",
				inputs: {},
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(brokenScript.status, "error");
			assert.isTrue(brokenScript.disableTool);
			assert.equal(
				brokenScript.activeGuidance?.content,
				"repair manually",
			);

			const legacyVoid = await runGeneratedWebsiteTool({
				name: "legacy_void",
				inputs: {},
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(legacyVoid.status, "success");
			assert.isTrue(legacyVoid.completed);

			const bundleVoid = await runGeneratedWebsiteTool({
				name: "bundle_void",
				inputs: {},
				browser,
				generatedToolsDir: dir,
			});
			assert.equal(bundleVoid.status, "incomplete");
			assert.isFalse(bundleVoid.completed);
		});
	});
});

function withBundleTools<T>(run: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join("/tmp", "website-tools-"));
	try {
		const result = run(dir);
		if (result instanceof Promise) {
			return result.finally(() =>
				fs.rmSync(dir, { recursive: true, force: true }),
			) as T;
		}
		fs.rmSync(dir, { recursive: true, force: true });
		return result;
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

function writeBundle(
	root: string,
	name: string,
	options: {
		metadataName?: string;
		script?: string;
		guidance?: string;
		domains?: string[];
		inputSchema?: Record<string, { type: "string" | "number" | "boolean" }>;
	},
): void {
	const dir = path.join(root, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(
		path.join(dir, "tool.json"),
		JSON.stringify(
			bundleMetadata(
				options.metadataName ?? name,
				options.domains,
				options.inputSchema,
			),
		),
		"utf-8",
	);
	if (options.script !== undefined) {
		fs.writeFileSync(path.join(dir, "index.ts"), options.script, "utf-8");
	}
	if (options.guidance !== undefined) {
		fs.writeFileSync(
			path.join(dir, "AGENTS.md"),
			options.guidance,
			"utf-8",
		);
	}
}

function bundleMetadata(
	name: string,
	domains = ["example.com"],
	inputSchema: Record<string, { type: "string" | "number" | "boolean" }> = {},
) {
	return {
		name,
		description: `${name} description`,
		inputSchema,
		domains,
		createdAt: "2026-01-01T00:00:00.000Z",
		endState: "handoff ready",
	};
}

function guide(pre: string, post: string, recovery: string): string {
	return `## Pre-script guidance\n${pre}\n\n## Post-script guidance\n${post}\n\n## Recovery guidance\n${recovery}\n`;
}

function successfulScript(): string {
	return "export async function runWebsiteTool() { return { completed: true }; }\n";
}

function outcomeScript(): string {
	return `export async function runWebsiteTool({ inputs }: { inputs: Record<string, unknown> }) {
	if (inputs.mode === "throw") throw new Error("script failed");
	if (inputs.mode === "incomplete") return { completed: false, notes: ["not ready"] };
	return { completed: true, result: "done", notes: ["ready"] };
}
`;
}

function legacyVoidSource(): string {
	return `type WebsiteToolMetadata = any;

export const tool = {
	name: "legacy_void",
	description: "Legacy void tool",
	inputSchema: {},
	domains: ["example.com"],
	createdAt: "2026-01-01T00:00:00.000Z"
} satisfies WebsiteToolMetadata;

export async function runWebsiteTool() {}
`;
}

async function withGeneratedTool<T>(
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	const dir = defaultGeneratedToolsDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${name}.ts`);
	const previous = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: undefined;
	fs.writeFileSync(filePath, generatedToolSource(name), "utf-8");
	try {
		return await run();
	} finally {
		if (previous === undefined) {
			fs.rmSync(filePath, { force: true });
		} else {
			fs.writeFileSync(filePath, previous, "utf-8");
		}
	}
}

function generatedToolSource(name: string): string {
	return `import type { WebsiteToolMetadata, WebsiteToolRunInput } from "../src/website-tools.js";

export const tool = {
\tname: "${name}",
\tdescription: "Search prices quickly.",
\tinputSchema: {
\t\tquery: {
\t\t\ttype: "string",
\t\t\tdescription: "Search query"
\t\t}
\t},
\tdomains: ["example.com"],
\tendState: "form_ready_before_submit",
\tcreatedAt: "2026-01-01T00:00:00.000Z"
} satisfies WebsiteToolMetadata;

export async function runWebsiteTool(input: WebsiteToolRunInput) {
\tif (input.inputs.query === "fail") {
\t\tthrow new Error("planned failure");
\t}
\tawait input.browser.Runtime.evaluate({ expression: "1", returnByValue: true });
\treturn {
\t\tcompleted: true,
\t\tresult: {
\t\t\tprofileUrl: "https://example.com/" + input.inputs.query,
\t\t\tprofileTitle: input.inputs.query
\t\t}
\t};
}
`;
}
