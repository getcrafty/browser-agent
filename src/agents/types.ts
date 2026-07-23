import type { UserTakeoverCategory } from "../user-action-types.js";
import type {
	RequestAuthDomainCandidates,
	RequestAuthIdentifierForDomain,
	RequestAuthPasswordForDomain,
} from "../auth/types.js";
import type {
	WebsiteToolExecutionOutcome,
	WebsiteToolInputs,
} from "../website-tools.js";
import type { Provider, ReasoningEffort } from "../llm-capabilities.js";

// LLM types
export {
	SUPPORTED_PROVIDERS,
	type Provider,
	type ReasoningEffort,
} from "../llm-capabilities.js";

export interface Message {
	role: "system" | "user" | "assistant";
	content: string | ContentPart[];
}

export type ContentPart =
	| { type: "text"; text: string }
	| {
			type: "image_url";
			image_url: { url: string; detail?: "low" | "high" | "auto" };
	  };

export interface LLMOptions {
	provider: Provider;
	model: string;
	apiKey?: string;
	reasoningEffort: ReasoningEffort;
	maxModelLen?: number;
	reserveOutputTokens?: number;
	endpointUrl?: string;
	openrouterProvider?: string;
}

export interface TokenUsage {
	input_tokens: number;
	cached_input_tokens?: number;
	reasoning_tokens?: number;
	non_reasoning_output_tokens?: number;
	output_tokens: number;
	total_tokens: number;
	time_to_first_token_ms?: number;
	generation_time_ms?: number;
}

export interface ChatJSONResult<T> {
	data: T;
	usage: TokenUsage;
	reasoning_tokens: string;
}

export interface SuccessVerificationVerdict {
	success: boolean;
	summary: string;
	reasons: string[];
}

export interface SuccessVerificationResult extends SuccessVerificationVerdict {
	model: string;
	provider: Provider;
	reasoningEffort?: ReasoningEffort;
	usage: TokenUsage;
}

export interface ChatYAMLTraceEvent<T = unknown> {
	caller: string;
	provider: Provider;
	model: string;
	attempt: number;
	messages: Message[];
	output?: T;
	raw_response?: string;
	usage?: TokenUsage;
	reasoning_tokens?: string;
	error?: string;
}

export interface StageModelInvocationTrace {
	step_kind: "stage_llm";
	stage: string;
	attempt: number;
	caller: string;
	provider: Provider;
	model: string;
	messages: unknown[];
	output?: unknown;
	raw_response?: string;
	usage?: TokenUsage;
	reasoning_tokens: string;
	error?: string;
	meta?: Record<string, unknown>;
}

// Cookie types
export interface CookieAnalysis {
	hasBanner: boolean;
	action: { type: "click"; bid: string } | null;
}

// Planner types
export interface TargetURL {
	url: string;
}

export interface Plan {
	steps: string[];
}

// Executor types
export type PreviousStepStatus =
	| "none"
	| "progressed"
	| "no_change"
	| "blocked"
	| "opened_tab"
	| "switched_context"
	| "partial";

export interface StepResult {
	thinking: string;
	previousStepPlanUpdate: PlanStepUpdate[];
	previousStepStatus: PreviousStepStatus;
	previousStepOutcome: string;
	currentStateObservation: string;
	nextActionRationale: string;
	actions: Action[];
	done: boolean;
	result?: string;
}

export interface PlanStepUpdate {
	index: number;
	status: "done" | "regressed";
}

export interface ExecutorResultItem {
	link: string;
	summary: string;
	downloaded_file_path?: string;
}

export interface AuthTakeoverAttemptEvent {
	step_kind: "auth_takeover_attempt";
	step?: number;
	attempt_index: number;
	messages?: unknown[];
	token_usage?: TokenUsage;
	decision?: string;
	action?: string;
	result?: string;
	outcome?: string;
	handled?: boolean;
	reason?: string;
	message?: string;
	stage?: "probe" | "result";
	current_url?: string;
	max_attempts?: number;
}

export interface MainLoopStepEntry {
	step: number;
	messages: unknown[];
	workflow_node_id?: string;
	workflow_node_kind?: "preparation" | "task" | "synthesis";
	step_kind?:
		"executor_step" | "auth_takeover_attempt" | "max_step_finalization";
	auth_takeover_attempt?: AuthTakeoverAttemptEvent;
}

export type Action =
	| { type: "click"; bid: string }
	| { type: "long_press"; bid: string; durationMs?: number }
	| { type: "type"; bid: string; text: string; enter?: boolean }
	| { type: "scroll"; bid: string; deltaX?: number; deltaY?: number }
	| { type: "evaluate"; script: string }
	| { type: "dropdown_select"; bid: string; value: string }
	| { type: "prune"; bids: string[] }
	| { type: "unprune" }
	| { type: "navigate"; url: string }
	| { type: "switch_tab"; index: number }
	| { type: "wait"; ms: number }
	| { type: "download_current_file" }
	| { type: "upload_files"; bid: string; paths: string[] }
	| { type: "paste_file"; bid: string; path: string }
	| {
			type: "user_takeover";
			reason: string;
			category?: UserTakeoverCategory;
	  }
	| { type: "memory_write"; content: string }
	| { type: "memory_read" }
	| { type: "read_file"; path: string }
	| { type: "return_results"; results?: ExecutorResultItem[] }
	| { type: "memory_clear"; target: "memory" | "memory_result" | "all" }
	| { type: "extract_data"; root: string }
	| { type: "agent_takeover"; request: string }
	| { type: "website_tool"; name: string; inputs: WebsiteToolInputs }
	| { type: "regenerate_plan" };

export interface StepTokenUsage {
	step: number;
	input_tokens: number;
	cached_input_tokens?: number;
	reasoning_tokens?: number;
	non_reasoning_output_tokens?: number;
	output_tokens: number;
	total_tokens: number;
}

export interface ExtractionStepUsage {
	parentStep: number;
	extractionIndex: number;
	usage: TokenUsage;
}

export interface RecapStageUsage {
	phase: "preprocess" | "verification";
	stage: string;
	usage?: TokenUsage;
}

export interface ExecuteResult {
	completed: boolean;
	successful: boolean;
	result: string;
	steps: number;
	tokenUsage: StepTokenUsage[];
	successVerification?: SuccessVerificationResult;
	jsonlEntry: {
		task: string;
		steps: MainLoopStepEntry[];
		completed: boolean;
		successful: boolean;
		finalResult: string | null;
		successVerification?: SuccessVerificationResult;
		modelInvocations?: StageModelInvocationTrace[];
	};
}

export interface ExecuteOptions {
	maxSteps?: number;
	requestAuthDomainCandidates?: RequestAuthDomainCandidates;
	requestAuthIdentifierForDomain?: RequestAuthIdentifierForDomain;
	requestAuthPasswordForDomain?: RequestAuthPasswordForDomain;
	recordModelInvocation?: (trace: StageModelInvocationTrace) => void;
}

export interface ExecuteActionsResult {
	pendingMemoryRead: boolean;
	interactionErrors: string[];
	toolObservations?: string[];
	pendingPlanRegeneration: boolean;
	returnedResult?: string;
	screenshotToolObservations: ScreenshotToolObservation[];
	screenshotToolCaptures: ScreenshotToolCaptureCall[];
	authTakeoverAttempts?: AuthTakeoverAttemptEvent[];
	authenticationOutcome?: "handled" | "unhandled";
	userTakeover?: {
		reason: string;
		category?: UserTakeoverCategory;
	};
	websiteToolOutcome?: WebsiteToolExecutionOutcome;
}

export interface ScreenshotToolObservation {
	requestedBids: string[];
	capturedBids: string[];
	errors?: string[];
}

export interface ScreenshotToolCapture {
	bid: string;
	imageBase64: string;
}

export interface ScreenshotToolCaptureCall {
	callSequence: number;
	captures: ScreenshotToolCapture[];
}
