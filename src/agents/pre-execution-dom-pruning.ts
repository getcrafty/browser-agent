import yaml from "js-yaml";
import { extractValidBids } from "./extract-valid-bids.js";
import { extractValidNonClickableIds } from "./extract-valid-nonclickable-ids.js";
import { chatYAML } from "./providers/router.js";
import type {
	LLMOptions,
	Message,
	TokenUsage,
	StageModelInvocationTrace,
} from "./types.js";
import type { Browser } from "../browser/types.js";
import { captureScreenshotWithBidBorders } from "../browser/interaction/capture-screenshot-with-bid-borders.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";

interface PreExecutionDomPruneResponse {
	thinking?: unknown;
	excludeNonClickableIds?: unknown;
}

export interface PreExecutionDomPruneDecision {
	thinking: string;
	excludedNonClickableIds: string[];
	tokenUsage: TokenUsage;
}

const PRE_EXECUTION_DOM_PRUNER_SYSTEM = `You are a DOM context pruner for a browser automation executor.
Given:
- a user task
- a plan
- validNonClickableIds currently present in the page DOM
- simplified DOM html
- a screenshot of the current page as additional visual context

Your job is to identify NON-CLICKABLE ids that are very likely irrelevant for solving the task and plan.
Examples of typically irrelevant UI: global footer links, copyright notices, legal boilerplate, social links, newsletter signup, ad/telemetry widgets unrelated to completing the task.
Prioritize coarse pruning of irrelevant hierarchy chunks, not detailed per-element pruning.

Be VERY conservative:
- ONLY exclude ids you are confident are irrelevant.
- If unsure, keep the element.
- Never invent ids; only return values from validNonClickableIds.
- Never return clickable/interactive bids.


Here are some elements you can prune by default (UNLESS THE USER TASK OR PLAN SPECIFICALLY MENTIONS INTERACTING WITH THEM):
- Large chunks of texts unrelated to the task
- Advertisements, promo banners
- Customer service chats/widgets
- Global footer links and legal notices
- Social media links and widgets
- Newsletter sign-up forms

Format your response with raw YAML only (no markdown):
thinking: "short reason"
excludeNonClickableIds:
  - "ncid1"
  - "ncid2"`;

async function capturePrunerScreenshotDataUrl(
	b: Browser,
	bids: string[],
): Promise<string> {
	const data = await captureScreenshotWithBidBorders({
		page: b.Page,
		runtime: b.Runtime,
		dom: b.DOM,
		bids,
		captureScreenshotParams: {
			format: "jpeg",
			quality: 100,
			captureBeyondViewport: false,
		},
	});
	if (!data.trim()) {
		throw new Error(
			"capturePrunerScreenshotDataUrl received empty screenshot bytes",
		);
	}
	return `data:image/jpeg;base64,${data}`;
}

function normalizeExcludedIds(raw: unknown, allowedIds: Set<string>): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const id = value.trim();
		if (!id || seen.has(id) || !allowedIds.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

export async function choosePreExecutionDomNonClickableIdsToExclude(params: {
	browser: Browser;
	task: string;
	plan: string[];
	dom: string;
	llmOptions: LLMOptions;
	onTrace?: (trace: StageModelInvocationTrace) => void;
	traceMeta?: Record<string, unknown>;
}): Promise<PreExecutionDomPruneDecision> {
	const validNonClickableIds = extractValidNonClickableIds(params.dom);
	if (validNonClickableIds.length === 0) {
		return {
			thinking: "",
			excludedNonClickableIds: [],
			tokenUsage: {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
			},
		};
	}
	const validBids = extractValidBids(params.dom);

	const screenshotDataUrl = await capturePrunerScreenshotDataUrl(
		params.browser,
		validBids,
	);

	const basePayload = {
		task: params.task,
		plan: params.plan,
		validNonClickableIds,
		html: params.dom,
	};
	const payload =
		params.llmOptions.provider === "openai"
			? {
					...basePayload,
					screenshotIncludedAsImagePart: true,
				}
			: {
					...basePayload,
				};

	const messages: Message[] = [
		{ role: "system", content: PRE_EXECUTION_DOM_PRUNER_SYSTEM },
		params.llmOptions.provider === "openai"
			? {
					role: "user",
					content: [
						{ type: "text", text: yaml.dump(payload) },
						{
							type: "image_url",
							image_url: {
								url: screenshotDataUrl,
								detail: "low",
							},
						},
					],
				}
			: {
					role: "user",
					content: yaml.dump(payload),
				},
	];

	const { data, usage } = await chatYAML<PreExecutionDomPruneResponse>(
		messages,
		params.llmOptions,
		"preExecutionDomPrune",
		(trace) =>
			params.onTrace?.(
				buildStageModelInvocationTrace({
					stage: "preExecutionDomPruning",
					trace,
					meta: params.traceMeta,
				}),
			),
	);

	return {
		thinking: typeof data.thinking === "string" ? data.thinking : "",
		excludedNonClickableIds: normalizeExcludedIds(
			data.excludeNonClickableIds,
			new Set(validNonClickableIds),
		),
		tokenUsage: usage,
	};
}
