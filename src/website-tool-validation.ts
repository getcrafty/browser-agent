import type { Browser } from "./browser/types.js";
import {
	runGeneratedWebsiteTool,
	type WebsiteToolExecutionOutcome,
	type WebsiteToolInputs,
} from "./website-tools.js";
import {
	MAX_PAGE_FIELD_BYTES,
	boundValidationNotes,
	boundValidationResult,
	truncateUtf8,
	validationErrorMessage,
} from "./website-tool-validation-receipt.js";

export type WebsiteToolValidationCode =
	| "SUCCESS"
	| "INCOMPLETE"
	| "EXECUTION_ERROR"
	| "HARNESS_ERROR"
	| "TIMEOUT"
	| "BROWSER_INSPECTION_ERROR";

export interface WebsiteToolValidationReceipt {
	artifactHash?: string;
	exampleIndex: number;
	passed: boolean;
	code: WebsiteToolValidationCode;
	durationMs: number;
	completed: boolean;
	finalUrl?: string;
	finalTitle?: string;
	notes: string[];
	notesTruncated?: true;
	result?: unknown;
	resultOmitted?: { reason: "size_limit"; bytes: number };
}

export interface ValidateGeneratedWebsiteToolParams {
	artifactHash?: string;
	exampleIndex: number;
	name: string;
	inputs: WebsiteToolInputs;
	browser: Browser;
	generatedToolsDir: string;
	currentUrl: string;
	timeoutMs?: number;
	inspectionTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INSPECTION_TIMEOUT_MS = 2_000;

class WebsiteToolValidationTimeout extends Error {
	constructor(readonly timeoutMs: number) {
		super(`website tool validation timed out after ${timeoutMs}ms`);
		this.name = "WebsiteToolValidationTimeout";
	}
}

export async function validateGeneratedWebsiteTool(
	params: ValidateGeneratedWebsiteToolParams,
): Promise<WebsiteToolValidationReceipt> {
	const startedAt = performance.now();
	let outcome: WebsiteToolExecutionOutcome;
	try {
		outcome = await withTimeout(
			runGeneratedWebsiteTool({
				name: params.name,
				inputs: params.inputs,
				browser: params.browser,
				generatedToolsDir: params.generatedToolsDir,
				currentUrl: params.currentUrl,
			}),
			params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
	} catch (error) {
		return receipt(params, startedAt, {
			passed: false,
			code:
				error instanceof WebsiteToolValidationTimeout
					? "TIMEOUT"
					: "HARNESS_ERROR",
			completed: false,
			notes: [validationErrorMessage(error)],
		});
	}

	const pageState = await inspectPage(
		params.browser,
		params.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
	);
	if (pageState.error && outcome.status === "success") {
		return receipt(params, startedAt, {
			passed: false,
			code: "BROWSER_INSPECTION_ERROR",
			completed: false,
			notes: [...outcome.notes, pageState.error],
		});
	}

	const result = boundValidationResult(outcome.result);
	const passed = outcome.status === "success" && outcome.completed === true;
	return receipt(params, startedAt, {
		passed,
		code: passed
			? "SUCCESS"
			: outcome.status === "error"
				? "EXECUTION_ERROR"
				: "INCOMPLETE",
		completed: outcome.completed === true,
		...(pageState.state ?? {}),
		notes: [
			...outcome.notes,
			...(pageState.error ? [pageState.error] : []),
		],
		...result,
	});
}

async function inspectPage(
	browser: Browser,
	timeoutMs: number,
): Promise<{
	state?: { finalUrl: string; finalTitle: string };
	error?: string;
}> {
	try {
		const response = await withTimeout(
			browser.Runtime.evaluate({
				expression:
					"({ finalUrl: location.href, finalTitle: document.title })",
				returnByValue: true,
			}),
			timeoutMs,
		);
		if (response.exceptionDetails) {
			throw new Error(
				response.exceptionDetails.exception?.description ??
					response.exceptionDetails.text ??
					"Runtime.evaluate failed while inspecting the final page",
			);
		}
		const value = response.result.value as
			| { finalUrl?: unknown; finalTitle?: unknown }
			| undefined;
		if (
			typeof value?.finalUrl !== "string" ||
			typeof value.finalTitle !== "string"
		) {
			throw new Error(
				"Runtime.evaluate returned an invalid final page state",
			);
		}
		return {
			state: {
				finalUrl: truncateUtf8(value.finalUrl, MAX_PAGE_FIELD_BYTES)
					.value,
				finalTitle: truncateUtf8(value.finalTitle, MAX_PAGE_FIELD_BYTES)
					.value,
			},
		};
	} catch (error) {
		return {
			error: `final page inspection failed: ${validationErrorMessage(error)}`,
		};
	}
}

function receipt(
	params: ValidateGeneratedWebsiteToolParams,
	startedAt: number,
	input: Omit<
		WebsiteToolValidationReceipt,
		"artifactHash" | "exampleIndex" | "durationMs" | "notesTruncated"
	>,
): WebsiteToolValidationReceipt {
	const boundedNotes = boundValidationNotes(input.notes);
	return {
		...(params.artifactHash ? { artifactHash: params.artifactHash } : {}),
		exampleIndex: params.exampleIndex,
		durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
		...input,
		notes: boundedNotes.notes,
		...(boundedNotes.truncated ? { notesTruncated: true } : {}),
	};
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new WebsiteToolValidationTimeout(timeoutMs)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
