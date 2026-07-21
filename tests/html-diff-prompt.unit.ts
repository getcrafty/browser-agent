import { assert } from "chai";
import { describe, it } from "mocha";
import {
	buildHtmlUnifiedDiff,
	resolveIncrementalHtmlContext,
} from "../src/core/html-diff.js";

describe("html diff prompt helper", () => {
	it("builds a compact diff for a small edit", () => {
		const diff = buildHtmlUnifiedDiff(
			["<main>", '  <button bid="1">Old</button>', "</main>"].join("\n"),
			["<main>", '  <button bid="1">New</button>', "</main>"].join("\n"),
		);

		assert.isString(diff);
		assert.include(diff ?? "", "--- previous-html");
		assert.include(diff ?? "", '-  <button bid="1">Old</button>');
		assert.include(diff ?? "", '+  <button bid="1">New</button>');
	});

	it("captures insertions", () => {
		const diff = buildHtmlUnifiedDiff(
			["<main>", "</main>"].join("\n"),
			["<main>", '  <a bid="2">Next</a>', "</main>"].join("\n"),
		);

		assert.include(diff ?? "", '+  <a bid="2">Next</a>');
	});

	it("captures deletions", () => {
		const diff = buildHtmlUnifiedDiff(
			["<main>", "  <p>Remove me</p>", "</main>"].join("\n"),
			["<main>", "</main>"].join("\n"),
		);

		assert.include(diff ?? "", "-  <p>Remove me</p>");
	});

	it("returns null without a usable base or change", () => {
		assert.strictEqual(buildHtmlUnifiedDiff("", "<main />"), null);
		assert.strictEqual(buildHtmlUnifiedDiff("<main />", "<main />"), null);
	});

	it("uses an empty diff for identical HTML", () => {
		assert.deepEqual(
			resolveIncrementalHtmlContext({
				previousHtml: "<main />",
				currentHtml: "<main />",
			}),
			{ mode: "diff", html: "", diffLength: 0 },
		);
	});

	it("uses a diff at the exact threshold and resets above it", () => {
		const previousHtml = [
			"<main>",
			...Array.from({ length: 80 }, (_, index) => `  <p>${index}</p>`),
			"  <button>Old</button>",
			"</main>",
		].join("\n");
		const currentHtml = previousHtml.replace(
			"<button>Old</button>",
			"<button>New</button>",
		);
		const diff = buildHtmlUnifiedDiff(previousHtml, currentHtml);
		assert.isString(diff);
		const exactRatio = (diff?.length ?? 0) / currentHtml.length;

		assert.strictEqual(
			resolveIncrementalHtmlContext({
				previousHtml,
				currentHtml,
				maxDiffToFullRatio: exactRatio,
			}).mode,
			"diff",
		);
		assert.strictEqual(
			resolveIncrementalHtmlContext({
				previousHtml,
				currentHtml,
				maxDiffToFullRatio: exactRatio / 2,
			}).mode,
			"full",
		);
	});

	it("falls back safely for large replacement diffs", () => {
		const previousHtml = Array.from(
			{ length: 1_100 },
			(_, index) => `old-${index}`,
		).join("\n");
		const currentHtml = Array.from(
			{ length: 1_100 },
			(_, index) => `new-${index}`,
		).join("\n");

		const result = resolveIncrementalHtmlContext({
			previousHtml,
			currentHtml,
		});
		assert.strictEqual(result.mode, "full");
		assert.strictEqual(result.html, currentHtml);
	});
});
