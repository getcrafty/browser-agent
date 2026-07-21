import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { describe, it } from "mocha";
import {
	getExecutorSystem,
	getExecutorSystemBase,
	getExecutorSystemPlannerEmbed,
	getPlanSystem,
} from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";
import { defaultGeneratedToolsDir } from "../src/website-tools.js";

describe("executor planner embed prompt", () => {
	it("includes role, DOM format, and tool usage in the planner embed", () => {
		const prompt = getExecutorSystemPlannerEmbed();

		assert.include(prompt, "You are a browser automation executor.");
		assert.include(prompt, "### HTML Format");
		assert.include(prompt, "### Tool Types & Usage");
		assert.include(prompt, "memory_read");
	});

	it("excludes executor step payload, response schema, and misc sections", () => {
		const prompt = getExecutorSystemPlannerEmbed();

		assert.notInclude(prompt, "### Payload Format");
		assert.notInclude(prompt, "### Expected Output");
		assert.notInclude(prompt, "### Misc Instructions");
		assert.notInclude(prompt, "previousStepStatus");
		assert.notInclude(prompt, "previousStepPlanUpdate");
		assert.notInclude(prompt, "Each key (previousStepPlanUpdate");
	});

	it("keeps core executor sections in runAgent and base prompts", () => {
		const runAgentPrompt = getExecutorSystem();
		const basePrompt = getExecutorSystemBase();

		for (const prompt of [runAgentPrompt, basePrompt]) {
			assert.include(prompt, "### Payload Format");
			assert.include(prompt, "### Expected Output");
			assert.notInclude(prompt, "### Misc Instructions");
			assert.include(prompt, "previousStepStatus");
		}
	});

	it("includes misc instructions only when enableMiscInstruction is enabled", () => {
		const originalEnableMiscInstruction =
			featureFlags.enableMiscInstruction;
		try {
			featureFlags.enableMiscInstruction = false;
			assert.notInclude(getExecutorSystem(), "### Misc Instructions");
			assert.notInclude(getExecutorSystemBase(), "### Misc Instructions");

			featureFlags.enableMiscInstruction = true;
			assert.include(getExecutorSystem(), "### Misc Instructions");
			assert.include(getExecutorSystemBase(), "### Misc Instructions");
		} finally {
			featureFlags.enableMiscInstruction =
				originalEnableMiscInstruction;
		}
	});

	it("uses the planner embed inside the generated plan system", () => {
		const originalEnablePlanning = featureFlags.enablePlanning;
		try {
			featureFlags.enablePlanning = true;
			const plannerEmbed = getExecutorSystemPlannerEmbed();
			const planSystem = getPlanSystem();

			assert.include(planSystem, plannerEmbed);
			assert.include(
				planSystem,
				"summarizes the executor's DOM format and available tools/capabilities",
			);
			assert.include(
				planSystem,
				'Your planning response MUST use only the planner output format defined below (a YAML object with a "steps" array).',
			);
			assert.notInclude(planSystem, "### Expected Output");
			assert.notInclude(planSystem, "### Payload Format");
		} finally {
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("includes matching website tools in the createPlan context", async () => {
		const original = { ...configFeatureFlags };
		await withGeneratedTool("planner_search_prices", async () => {
			try {
				setConfigFeatureFlags({ websiteAPIficationTools: true });
				const prompt = getPlanSystem({
					currentUrl: "https://example.com/search",
				});
				assert.include(prompt, "planner_search_prices");
				assert.include(prompt, "website_tool:");

				const wrongDomainPrompt = getPlanSystem({
					currentUrl: "https://other.example/search",
				});
				assert.notInclude(wrongDomainPrompt, "planner_search_prices");
			} finally {
				setConfigFeatureFlags(original);
			}
		});
	});

	it("omits planning prompt fields when planning is disabled", () => {
		const originalEnablePlanning = featureFlags.enablePlanning;
		try {
			featureFlags.enablePlanning = false;
			const prompt = getExecutorSystem();

			assert.notInclude(prompt, "- plan:");
			assert.notInclude(prompt, "previousStepPlanUpdate");
			assert.notInclude(prompt, "regenerate_plan");
			assert.notInclude(prompt, "The backend may regenerate");
			assert.notInclude(prompt, "TACKLE THE PLAN LIST");
			assert.notMatch(prompt, /\bplan/i);
		} finally {
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});
});

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
\t"name": "${name}",
\t"description": "Search prices quickly.",
\t"inputSchema": {
\t\t"query": {
\t\t\t"type": "string",
\t\t\t"description": "Search query"
\t\t}
\t},
\t"domains": ["example.com"],
\t"createdAt": "2026-01-01T00:00:00.000Z"
} satisfies WebsiteToolMetadata;

export async function runWebsiteTool(input: WebsiteToolRunInput) {
\tvoid input;
\treturn { completed: true };
}
`;
}
