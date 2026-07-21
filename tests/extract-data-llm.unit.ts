import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { extractDataResultsFromSnapshot } from "../src/agents/data-extraction.js";
import { __setProviderOverrideForTests } from "../src/agents/providers/ai-sdk.js";
import type { StageModelInvocationTrace } from "../src/agents/types.js";
import { featureFlags } from "../src/featureFlags.js";

const LLM_OPTIONS = { provider: "openai", model: "gpt-test" } as const;
const originalDisableHref = featureFlags.disableHref;

describe("extractDataResultsFromSnapshot", () => {
	async function expectRejection(
		promise: Promise<unknown>,
		expectedMessage?: string,
	): Promise<void> {
		try {
			await promise;
			assert.fail("Expected promise to reject");
		} catch (error) {
			assert.instanceOf(error, Error);
			if (expectedMessage) {
				assert.strictEqual((error as Error).message, expectedMessage);
			}
		}
	}

	function mockResponse(content: string): void {
		__setProviderOverrideForTests("openai", async () => ({
			content,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			reasoning_tokens: "",
		}));
	}

	afterEach(() => {
		__setProviderOverrideForTests("openai", null);
		featureFlags.disableHref = originalDisableHref;
	});

	it("replaces hrefs with link IDs and resolves selected IDs", async () => {
		const traces: StageModelInvocationTrace[] = [];
		let prompt = "";
		let calls = 0;
		__setProviderOverrideForTests("openai", async (args) => {
			calls++;
			prompt = args.prompt;
			return {
				content: [
					"items:",
					"  - link_id: link_1",
					"    summary: First product, $12",
					"  - link_id: link_2",
					"    summary: Second product, $15",
					"  - link_id: link_3",
					"    summary: Duplicate destination",
				].join("\n"),
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				reasoning_tokens: "",
			};
		});

		const result = await extractDataResultsFromSnapshot({
			task: "Extract product names and prices",
			currentUrl: "https://example.com/search?q=laptop",
			simplifiedDom: [
				'article href="/one": First product $12',
				'  a href="/two": Second product $15',
				'article href="/one": First product duplicate',
			].join("\n"),
			llmOptions: LLM_OPTIONS,
			traceOptions: {
				onTrace: (trace) => traces.push(trace),
				meta: { root: "!1" },
			},
		});

		assert.strictEqual(calls, 1);
		assert.deepStrictEqual(result.items, [
			{ link: "https://example.com/one", summary: "First product, $12" },
			{ link: "https://example.com/two", summary: "Second product, $15" },
			{
				link: "https://example.com/one",
				summary: "Duplicate destination",
			},
		]);
		assert.include(prompt, "Extract product names and prices");
		assert.include(prompt, "https://example.com/search?q=laptop");
		assert.include(prompt, 'article link_id="link_1": First product $12');
		assert.include(prompt, '  a link_id="link_2": Second product $15');
		assert.include(
			prompt,
			'article link_id="link_3": First product duplicate',
		);
		assert.notInclude(prompt, "href=");
		assert.notInclude(prompt, "/one");
		assert.notInclude(prompt, "/two");
		assert.include(prompt, "link_current");
		assert.include(prompt, "link_id: <quoted link_id>");
		assert.strictEqual(traces[0]?.stage, "dataExtraction");
		assert.deepStrictEqual(traces[0]?.meta, { root: "!1" });
	});

	it("keeps hrefs alongside link IDs when href removal is disabled", async () => {
		featureFlags.disableHref = false;
		let prompt = "";
		__setProviderOverrideForTests("openai", async (args) => {
			prompt = args.prompt;
			return {
				content: [
					"items:",
					"  - link_id: link_1",
					"    summary: Product",
				].join("\n"),
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
			};
		});

		const result = await extractDataResultsFromSnapshot({
			task: "Extract products",
			currentUrl: "https://example.com/catalog",
			simplifiedDom: 'a href="/product": Product',
			llmOptions: LLM_OPTIONS,
		});

		assert.include(prompt, 'a href="/product" link_id="link_1": Product');
		assert.deepStrictEqual(result.items, [
			{ link: "https://example.com/product", summary: "Product" },
		]);
	});

	it("resolves browser URL forms and falls back for unusable hrefs", async () => {
		mockResponse(
			[
				"items:",
				...Array.from({ length: 11 }, (_, index) => [
					`  - link_id: link_${index + 1}`,
					`    summary: Item ${index + 1}`,
				]).flat(),
			].join("\n"),
		);
		const currentUrl = "https://example.com/base/page?old=1#old";
		const hrefs = [
			"https://other.example/item",
			"//cdn.example/item",
			"/root",
			"path",
			"?sort=asc",
			"#details",
			"",
			"http://[invalid",
			"javascript:void(0)",
			"mailto:test@example.com",
			"data:text/plain,test",
		];

		const result = await extractDataResultsFromSnapshot({
			task: "Extract items",
			currentUrl,
			simplifiedDom: hrefs
				.map(
					(href, index) =>
						`a href=${JSON.stringify(href)}: Item ${index + 1}`,
				)
				.join("\n"),
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(
			result.items.map(({ link }) => link),
			[
				"https://other.example/item",
				"https://cdn.example/item",
				"https://example.com/root",
				"https://example.com/base/path",
				"https://example.com/base/page?sort=asc",
				"https://example.com/base/page?old=1#details",
				currentUrl,
				currentUrl,
				currentUrl,
				currentUrl,
				currentUrl,
			],
		);
	});

	it("supports repeated selection of one ID and link_current for linkless items", async () => {
		mockResponse(
			[
				"items:",
				"  - link_id: link_1",
				"    summary: First observation",
				"  - link_id: link_1",
				"    summary: Second observation",
				"  - link_id: link_current",
				"    summary: Linkless observation",
			].join("\n"),
		);

		const result = await extractDataResultsFromSnapshot({
			task: "Extract observations",
			currentUrl: "https://example.com/current",
			simplifiedDom: [
				'a href="/detail": Detail',
				"p: Linkless fact",
			].join("\n"),
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(result.items, [
			{
				link: "https://example.com/detail",
				summary: "First observation",
			},
			{
				link: "https://example.com/detail",
				summary: "Second observation",
			},
			{
				link: "https://example.com/current",
				summary: "Linkless observation",
			},
		]);
	});

	it("distinguishes semantic link roles from explicit link_id attributes", async () => {
		let prompt = "";
		__setProviderOverrideForTests("openai", async (args) => {
			prompt = args.prompt;
			return {
				content: [
					"items:",
					"  - link_id: link_current",
					"    summary: Delta nonstop flight, €3,277",
				].join("\n"),
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				reasoning_tokens: "",
			};
		});
		const currentUrl = "https://www.google.com/travel/flights/search";
		const semanticLink =
			'bid="2o" link: "From 3277 euros round trip total. Nonstop flight with Delta. Select flight"';

		const result = await extractDataResultsFromSnapshot({
			task: "Extract the available flights",
			currentUrl,
			simplifiedDom: semanticLink,
			llmOptions: LLM_OPTIONS,
		});

		assert.deepStrictEqual(result.items, [
			{
				link: currentUrl,
				summary: "Delta nonstop flight, €3,277",
			},
		]);
		assert.include(prompt, semanticLink);
		const semanticLinkPromptLine = prompt
			.split("\n")
			.find((line) => line.includes(semanticLink));
		assert.isDefined(semanticLinkPromptLine);
		assert.notInclude(semanticLinkPromptLine ?? "", "link_id=");
		assert.include(prompt, "link_id is the only valid DOM attribute");
		assert.include(
			prompt,
			"including link, role, aria-label, label, href, bid, ncid",
		);
		assert.include(
			prompt,
			"A bare link token indicates only that an element has link semantics",
		);
		assert.include(prompt, "literal link_current");
		assert.include(prompt, "exactly the two fields link_id and summary");
	});

	it("rejects a semantic link label copied into link_id", async () => {
		const semanticLabel =
			"From 3277 euros round trip total. Nonstop flight with Delta. Select flight";
		mockResponse(
			[
				"items:",
				`  - link_id: ${JSON.stringify(semanticLabel)}`,
				"    summary: Delta nonstop flight, €3,277",
			].join("\n"),
		);

		await expectRejection(
			extractDataResultsFromSnapshot({
				task: "Extract the available flights",
				currentUrl: "https://www.google.com/travel/flights/search",
				simplifiedDom: `bid="2o" link: ${JSON.stringify(semanticLabel)}`,
				llmOptions: LLM_OPTIONS,
			}),
			`extract_data item 1 has unknown link_id ${JSON.stringify(semanticLabel)}`,
		);
	});

	for (const testCase of [
		{
			content: "result: invalid",
			message: "extract_data returned an invalid response",
		},
		{ content: "items: []", message: "extract_data returned no items" },
		{
			content: "items:\n  - summary: Product",
			message: "extract_data item 1 has an invalid link_id",
		},
		{
			content: "items:\n  - link_id: ''\n    summary: Product",
			message: "extract_data item 1 has an empty link_id",
		},
		{
			content: "items:\n  - link_id: 1\n    summary: Product",
			message: "extract_data item 1 has an invalid link_id",
		},
		{
			content: "items:\n  - link_id: link_999\n    summary: Product",
			message: 'extract_data item 1 has unknown link_id "link_999"',
		},
		{
			content:
				"items:\n  - link: https://example.com/invented\n    summary: Product",
			message: "extract_data item 1 contains a legacy link field",
		},
		{
			content: "items:\n  - link_id: link_current\n    summary: ''",
			message: "extract_data item 1 has an empty summary",
		},
	] as const) {
		it(`rejects ${testCase.message}`, async () => {
			mockResponse(testCase.content);
			await expectRejection(
				extractDataResultsFromSnapshot({
					task: "Extract products",
					currentUrl: "https://example.com",
					simplifiedDom: 'a href="/product": Product',
					llmOptions: LLM_OPTIONS,
				}),
				testCase.message,
			);
		});
	}

	it("rejects an empty current URL before calling the model", async () => {
		let called = false;
		__setProviderOverrideForTests("openai", async () => {
			called = true;
			throw new Error("unexpected");
		});
		await expectRejection(
			extractDataResultsFromSnapshot({
				task: "Extract",
				currentUrl: " ",
				simplifiedDom: "main: Products",
				llmOptions: LLM_OPTIONS,
			}),
			"extract_data requires a non-empty current URL",
		);
		assert.isFalse(called);
	});

	it("forwards abortSignal through chatYAML to the provider", async () => {
		const controller = new AbortController();
		let providerSignal: AbortSignal | undefined;
		__setProviderOverrideForTests("openai", async (args) => {
			providerSignal = args.abortSignal;
			return await new Promise((_resolve, reject) => {
				args.abortSignal?.addEventListener(
					"abort",
					() => reject(new Error("provider aborted")),
					{ once: true },
				);
			});
		});

		const extraction = extractDataResultsFromSnapshot({
			task: "Extract",
			currentUrl: "https://example.com",
			simplifiedDom: "main: Products",
			llmOptions: LLM_OPTIONS,
			abortSignal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.isFalse(providerSignal?.aborted);

		controller.abort(new Error("stop extraction"));
		await expectRejection(extraction, "stop extraction");
		assert.isTrue(providerSignal?.aborted);
	});
});
