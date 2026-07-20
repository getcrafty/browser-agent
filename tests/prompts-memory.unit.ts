import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
	getExecutorSystemBase,
	getExecutorSystemPlannerEmbed,
	PLAN_SYSTEM,
} from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import {
	buildCreatePlanUserContent,
	PREPARED_MEMORY_CONTEXT_HINT,
} from "../src/agents/planner.js";

describe("executor memory prompt", () => {
	const originalWebsiteAPIficationTools =
		configFeatureFlags.websiteAPIficationTools;

	afterEach(() => {
		setConfigFeatureFlags({
			websiteAPIficationTools: originalWebsiteAPIficationTools,
		});
	});

	it("documents memory_read for preloaded context and mutable scratchpad behavior", () => {
		setConfigFeatureFlags({ websiteAPIficationTools: false });
		const prompt = getExecutorSystemBase();

		assert.include(prompt, "runtime-pinned workspace/file context");
		assert.include(prompt, "mutable browser scratchpad");
		assert.include(prompt, "extracted page data/result memory");
		assert.include(prompt, "Appends to the mutable browser scratchpad");
		assert.include(prompt, "return_results");
		assert.include(prompt, "local Markdown conversion for CSV/DOCX/XLSX");
		assert.include(
			prompt,
			"Scanned PDFs without a text layer are unsupported",
		);
		assert.notInclude(prompt, "memory_return_results");
		assert.include(prompt, "memory_clear");
		assert.include(
			prompt,
			`Use "memory_result" to clear extracted page data/result memory.`,
		);
		assert.include(prompt, "extract_data");
		assert.include(prompt, "Launches data extraction asynchronously.");
		assert.include(
			prompt,
			"runtime transparently waits for all pending extractions",
		);
		assert.include(
			prompt,
			"do not poll or add wait calls for extraction completion",
		);
		assert.include(
			prompt,
			'appears in "interactionErrors" on the next step',
		);
		assert.notInclude(prompt, "has synchronously stored");
		assert.notInclude(
			prompt,
			"Any earlier extract_data action has already finished",
		);
		assert.notInclude(prompt, "\ndone:");
		assert.notInclude(prompt, "done MUST");
		assert.include(prompt, "Do not provide done or result fields.");
		assert.include(prompt, "completed extract_data");
		assert.include(prompt, "memoryContent after memory_read");
		assert.notInclude(prompt, "websiteToolResults");
		assert.notInclude(
			prompt,
			"When the task is complete, set done: true and put the answer in result.",
		);
		assert.include(
			prompt,
			"Use to store intermediate findings, but not intermediate results",
		);
		assert.include(prompt, 'extract_data: "!a"');
		assert.notInclude(prompt, 'extract_data:\n      root: "!a"');
		assert.include(prompt, "ncid handle");
		assert.include(
			prompt,
			"extraction parses all result items from the selected subtrees together.",
		);
		assert.include(
			prompt,
			'removed "root", "items", "bid", "url_bid", "hierarchy", "write_to", "writeTo", "start", "end_exclusive", or "endExclusive"',
		);
		assert.include(prompt, "comma-separated list");
		assert.include(prompt, "always written to memory_result");
		assert.include(prompt, "provide the final list");
		assert.notInclude(
			prompt,
			"do not call extract_data for the same facts",
		);
		assert.include(
			prompt,
			`without a specific web URL, and "memoryContent" is absent or incomplete, call "memory_read"`,
		);
		assert.include(prompt, "memoryAvailable");
		assert.include(PLAN_SYSTEM, "include an early plan step");
		assert.include(getExecutorSystemPlannerEmbed(), "memory_read");
	});

	it("adds a compact planner hint when prepared memory is available", () => {
		const content = buildCreatePlanUserContent({
			task: "Find the pdf file on disk",
			dom: "html",
			runtimeContext: { memoryAvailable: true },
		});

		assert.include(content, PREPARED_MEMORY_CONTEXT_HINT);
		assert.include(content, "Runtime context:");
		assert.notInclude(content, "Runtime-pinned workspace/file context:");
	});

	it("documents paste_file for exact workspace file transfer", () => {
		const prompt = getExecutorSystemBase();

		assert.include(prompt, "paste_file:");
		assert.include(prompt, "exact text contents");
		assert.include(prompt, "helps discover paths but is not an allowlist");
		assert.include(prompt, 'Use this instead of "type"');
		assert.include(PLAN_SYSTEM, "use paste_file");
		assert.include(getExecutorSystemPlannerEmbed(), "paste_file");
	});

	it("adds a planner hint for prepared paste files", () => {
		const content = buildCreatePlanUserContent({
			task: "Paste the extracted workbook text into the notepad",
			dom: "html",
			runtimeContext: {
				preparedPasteFiles: ["./project_template_extracted.txt"],
			},
		});

		assert.include(content, "Prepared workspace file(s)");
		assert.include(content, "./project_template_extracted.txt");
		assert.include(content, "paste_file");
		assert.include(content, "do not plan to type or regenerate");
	});

	it("omits the planner memory hint when no prepared memory exists", () => {
		const content = buildCreatePlanUserContent({
			task: "Search the web",
			dom: "html",
		});

		assert.notInclude(content, PREPARED_MEMORY_CONTEXT_HINT);
		assert.notInclude(content, "Runtime context:");
	});

	it("documents request-based agent_takeover when enabled", () => {
		const original = { ...configFeatureFlags };
		try {
			setConfigFeatureFlags({ agentTakeoverTool: true });
			const prompt = getExecutorSystemBase();
			assert.include(
				prompt,
				`agent_takeover:\n      request: "Create ./downloads/report/financial_report.pdf from ./downloads/report/source.txt, then verify the PDF exists."`,
			);
			assert.include(prompt, `Provide a non-empty "request" string`);
			assert.include(prompt, "bounded file postprocessing");
			assert.include(prompt, "requested output filename/path");
			assert.include(prompt, 'existing "./downloads/..." tree');
			assert.include(prompt, "use the memoryContent");
			assert.notInclude(prompt, "sourceHints");
		} finally {
			setConfigFeatureFlags(original);
		}
	});

	it("omits agent_takeover when disabled", () => {
		const original = { ...configFeatureFlags };
		try {
			setConfigFeatureFlags({ agentTakeoverTool: false });
			const prompt = getExecutorSystemBase();
			assert.notInclude(prompt, `  - agent_takeover:`);
			assert.notInclude(prompt, "agent_takeover:\n  - Use only");
		} finally {
			setConfigFeatureFlags(original);
		}
	});

	it("adds a planner hint when agent takeover is available", () => {
		const content = buildCreatePlanUserContent({
			task: "Complete a form using the PDF",
			dom: "html",
			runtimeContext: { agentTakeoverAvailable: true },
		});

		assert.include(content, "agent_takeover");
		assert.include(content, "before continuing with browser work");
	});
});
