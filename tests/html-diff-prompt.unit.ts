import { assert } from "chai";
import { describe, it } from "mocha";
import { buildHtmlUnifiedDiff } from "../src/core/html-diff.js";

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
});
