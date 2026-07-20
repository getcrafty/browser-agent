import type { Browser } from "../browser/types.js";
import { click, getSimplifiedDOM } from "../browser/index.js";
import { chatYAML, userMessage } from "./providers/router.js";
import type {
	Message,
	LLMOptions,
	CookieAnalysis,
	StageModelInvocationTrace,
} from "./types.js";
import { COOKIE_SYSTEM } from "./prompts.js";
import { buildStageModelInvocationTrace } from "./model-invocation-tracing.js";

interface StageTraceOptions {
	onTrace?: (trace: StageModelInvocationTrace) => void;
	meta?: Record<string, unknown>;
}

export async function dismissCookieBanner(
	b: Browser,
	maxAttempts = 1,
	options: LLMOptions,
	traceOptions?: StageTraceOptions,
): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		const dom = await getSimplifiedDOM(b);
		const messages: Message[] = [
			{ role: "system", content: COOKIE_SYSTEM },
			userMessage(dom),
		];
		const { data: analysis } = await chatYAML<CookieAnalysis>(
			messages,
			options,
			"dismissCookieBanner",
			(trace) =>
				traceOptions?.onTrace?.(
					buildStageModelInvocationTrace({
						stage: "dismissCookieBanner",
						trace,
						meta: {
							...(traceOptions.meta ?? {}),
							cookieDismissAttempt: i + 1,
						},
					}),
				),
		);

		if (!analysis.hasBanner) return;
		if (!analysis.action) return;

		console.log(
			`  [cookie] Dismissing banner: click(bid=${analysis.action.bid})`,
		);
		try {
			await click(b, analysis.action.bid);
		} catch (e) {
			console.log(
				`  [cookie] Click failed (attempt ${i + 1}/${maxAttempts}), retrying...`,
			);
			continue;
		}
	}
}
