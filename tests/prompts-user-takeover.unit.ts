import { assert } from "chai";
import { describe, it } from "mocha";
import { getExecutorSystem } from "../src/agents/prompts.js";
import {
	configFeatureFlags,
	setConfigFeatureFlags,
} from "../src/config-feature-flags.js";
import { featureFlags } from "../src/featureFlags.js";
import {
	AUTH_TAKEOVER_FORM_SYSTEM,
	AUTH_TAKEOVER_RESULT_SYSTEM,
} from "../src/auth/prompt.js";

describe("executor prompt user_takeover tool", () => {
	it("keeps the system prompt free of the runtime date and time", () => {
		const prompt = getExecutorSystem();

		assert.notInclude(prompt, "Today's date/time is");
		assert.notInclude(prompt, "dd/mm/yyyy hh:mm time zone");
	});

	it("documents user_takeover schema, categories, and sensitive-use guidance", () => {
		const originalUserTakeoverTool = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		configFeatureFlags.userTakeoverTool = true;
		configFeatureFlags.authTakeover = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(prompt, `### Tool Types & Usage`);
			assert.include(prompt, `click:`);
			assert.include(prompt, `type:`);
			assert.include(prompt, `scroll:`);
			assert.include(prompt, `dropdown_select:`);
			assert.include(prompt, `evaluate:`);
			assert.include(prompt, `wait:`);
			assert.include(prompt, `Prefer waits of 1000 ms or less.`);
			assert.include(
				prompt,
				`Use a wait longer than 1000 ms only when the page is currently unusable, or when you just initiated a search and visual cues show that more time is needed for all results to load.`,
			);
			assert.include(prompt, `navigate:`);
			assert.include(prompt, `switch_tab:`);
			assert.include(prompt, `download_current_file:`);
			assert.include(prompt, `memory_write:`);
			assert.include(prompt, `memory_read:`);
			assert.include(
				prompt,
				`If the simplified DOM indicates a file-view/non-HTML document and the user wants the file or artifact, prefer this tool.`,
			);
			assert.include(prompt, `user_takeover:`);
			assert.include(prompt, `category: "authentication"`);
			assert.include(
				prompt,
				`request: "Sensitive step requiring manual user interaction`,
			);
			assert.include(
				prompt,
				`Use "user_takeover" ONLY for sensitive user-only interactions`,
			);
			assert.include(prompt, `Always include "category"`);
			assert.include(prompt, `"otp"`);
			assert.include(prompt, `"verification"`);
			assert.include(prompt, `"payment"`);
			assert.include(
				prompt,
				`When you use "user_takeover", do not include additional tool calls in the same step`,
			);
			assert.notInclude(
				prompt,
				`- Use "memory_write" to store intermediate findings and "memory_read" to retrieve them before final synthesis.`,
			);
			assert.notInclude(prompt, `The DOM uses a compact bracket format:`);
			assert.notInclude(prompt, `Each node starts with "<".`);
		} finally {
			configFeatureFlags.userTakeoverTool = originalUserTakeoverTool;
			configFeatureFlags.authTakeover = originalAuthTakeover;
		}
	});

	it("keeps authentication user_takeover guidance when manual takeover is disabled but auth takeover is enabled", () => {
		const originalUserTakeoverTool = configFeatureFlags.userTakeoverTool;
		const originalAuthTakeover = configFeatureFlags.authTakeover;
		configFeatureFlags.userTakeoverTool = false;
		configFeatureFlags.authTakeover = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(prompt, `user_takeover:`);
			assert.include(prompt, `category: "authentication"`);
			assert.include(
				prompt,
				`request: "Authentication is required to continue."`,
			);
			assert.include(
				prompt,
				`the runtime may attempt supported authentication automatically`,
			);
			assert.notInclude(prompt, `"otp"`);
			assert.notInclude(prompt, `"payment"`);
		} finally {
			configFeatureFlags.userTakeoverTool = originalUserTakeoverTool;
			configFeatureFlags.authTakeover = originalAuthTakeover;
		}
	});

	it("omits thinking field requirements when omitExecutorThinkingField is enabled", () => {
		const originalFlag = configFeatureFlags.omitExecutorThinkingField;
		const originalActionContext = featureFlags.executorActionContextFields;
		const originalEnablePlanning = featureFlags.enablePlanning;
		setConfigFeatureFlags({ omitExecutorThinkingField: true });
		featureFlags.executorActionContextFields = false;
		featureFlags.enablePlanning = true;
		try {
			const prompt = getExecutorSystem();
			assert.notInclude(
				prompt,
				`thinking: "Reasoning based on what you observe`,
			);
			assert.include(
				prompt,
				`Each key (previousStepPlanUpdate, tools) must be present at most once and in the specified order.`,
			);
			assert.notInclude(prompt, "\ndone:");
			assert.notInclude(prompt, `previousStepStatus: "opened_tab"`);
			assert.notInclude(prompt, `previousStepStatus must be one of:`);
			assert.notInclude(
				prompt,
				`PUT ANY THINKING OR REASONING IN THE "thinking" FIELD OF THE YAML.`,
			);
		} finally {
			setConfigFeatureFlags({ omitExecutorThinkingField: originalFlag });
			featureFlags.executorActionContextFields = originalActionContext;
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("includes action-context schema when enabled alongside omitted thinking", () => {
		const originalFlag = configFeatureFlags.omitExecutorThinkingField;
		const originalActionContext = featureFlags.executorActionContextFields;
		const originalEnablePlanning = featureFlags.enablePlanning;
		setConfigFeatureFlags({ omitExecutorThinkingField: true });
		featureFlags.executorActionContextFields = true;
		featureFlags.enablePlanning = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(
				prompt,
				`Each key (previousStepPlanUpdate, previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale, tools) must be present at most once and in the specified order.`,
			);
			assert.notInclude(prompt, "\ndone:");
			assert.include(prompt, `previousStepStatus: "opened_tab"`);
			assert.include(
				prompt,
				`previousStepOutcome: |-
  Opened Gmail sign-in tab.`,
			);
			assert.include(
				prompt,
				`currentStateObservation: |-
  Current tab is still the Workspace landing page.`,
			);
			assert.include(
				prompt,
				`nextActionRationale: |-
  Switch to the Gmail tab to continue login.`,
			);
		} finally {
			setConfigFeatureFlags({ omitExecutorThinkingField: originalFlag });
			featureFlags.executorActionContextFields = originalActionContext;
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("includes thinking and action-context schema when thinking is enabled", () => {
		const originalFlag = configFeatureFlags.omitExecutorThinkingField;
		const originalActionContext = featureFlags.executorActionContextFields;
		const originalEnablePlanning = featureFlags.enablePlanning;
		setConfigFeatureFlags({ omitExecutorThinkingField: false });
		featureFlags.executorActionContextFields = true;
		featureFlags.enablePlanning = true;
		try {
			const prompt = getExecutorSystem();
			assert.include(
				prompt,
				`thinking: "Reasoning based on what you observe`,
			);
			assert.include(
				prompt,
				`Each key (thinking, previousStepPlanUpdate, previousStepStatus, previousStepOutcome, currentStateObservation, nextActionRationale, tools) must be present at most once and in the specified order.`,
			);
			assert.notInclude(prompt, "\ndone:");
			assert.include(prompt, `previousStepStatus: "opened_tab"`);
			assert.include(prompt, `previousStepStatus must be one of:`);
			assert.include(
				prompt,
				`PUT ANY THINKING OR REASONING IN THE "thinking" FIELD OF THE YAML.`,
			);
		} finally {
			setConfigFeatureFlags({ omitExecutorThinkingField: originalFlag });
			featureFlags.executorActionContextFields = originalActionContext;
			featureFlags.enablePlanning = originalEnablePlanning;
		}
	});

	it("defines dedicated auth takeover form and result prompts", () => {
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`Respond with a single <yaml> marker immediately followed by raw YAML`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`action: "advance_identifier_step" | "select_account" | "submit_credentials" | "cannot_attempt"`,
		);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `usernameBid: "N"`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `passwordBid: "N"`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `submitBid: "N"`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `continueBid: "N"`);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`stayLoggedInCheckboxBid: "N"`,
		);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `switchIdentifierBid: "N"`);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `accountBid: "N"`);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`if an account list contains [AUTH_IDENTIFIER_MATCH]`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`changes the email/username/account before password entry`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`when the matching email is inside a button/link`,
		);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`use the parent button/link bid as accountBid`,
		);
		assert.include(AUTH_TAKEOVER_FORM_SYSTEM, `Examples:`);
		assert.include(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`You are part of an authentication takeover runtime.`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`outcome: "invalid_credentials" | "success_or_redirect" | "requires_user_takeover" | "unknown"`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`You classify the result of an attempted login after real credential submission.`,
		);
		assert.include(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`Classify using only the latest DOM snapshot.`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`The DOM uses a compact bracket format:`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`The DOM uses a compact bracket format:`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_FORM_SYSTEM,
			`Each node starts with "<".`,
		);
		assert.notInclude(
			AUTH_TAKEOVER_RESULT_SYSTEM,
			`Each node starts with "<".`,
		);
	});
});
