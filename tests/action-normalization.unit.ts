import { assert } from "chai";
import { describe, it } from "mocha";
import {
	normalizeActionList,
	normalizeActionListWithDiagnostics,
	normalizeShorthandActionEntry,
} from "../src/agents/executor-utils/action-normalization.js";

describe("action-normalization dropdown_select", () => {
	it("accepts typed dropdown_select", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "dropdown_select",
			bid: "n",
			value: "4",
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			bid: "n",
			value: "4",
		});
	});

	it("accepts shorthand dropdown_select map", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { bid: "n", value: "4" },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			bid: "n",
			value: "4",
		});
	});

	it("allows empty string value (placeholder option)", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { bid: "x", value: "" },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			bid: "x",
			value: "",
		});
	});

	it("coerces numeric value to string", () => {
		const parsed = normalizeShorthandActionEntry({
			dropdown_select: { bid: "x", value: 12 },
		});
		assert.deepStrictEqual(parsed, {
			type: "dropdown_select",
			bid: "x",
			value: "12",
		});
	});

	it("normalizes a list of mixed actions", () => {
		const list = normalizeActionList([
			{ click: "1" },
			{ dropdown_select: { bid: "n", value: "3" } },
			{ type: "type", bid: "2", text: "hi" },
		]);
		assert.strictEqual(list.length, 3);
		assert.deepStrictEqual(list[1], {
			type: "dropdown_select",
			bid: "n",
			value: "3",
		});
	});
});

describe("action-normalization paste_file", () => {
	it("accepts typed paste_file", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "paste_file",
			bid: "12",
			path: "./extracted.txt",
		});
		assert.deepStrictEqual(parsed, {
			type: "paste_file",
			bid: "12",
			path: "./extracted.txt",
		});
	});

	it("accepts shorthand paste_file map", () => {
		const parsed = normalizeShorthandActionEntry({
			paste_file: { bid: "12", path: "./extracted.txt" },
		});
		assert.deepStrictEqual(parsed, {
			type: "paste_file",
			bid: "12",
			path: "./extracted.txt",
		});
	});

	it("rejects paste_file without bid or path", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				paste_file: { bid: "12" },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				paste_file: { path: "./extracted.txt" },
			}),
		);
	});
});

describe("action-normalization return_results", () => {
	it("accepts shorthand string action", () => {
		const parsed = normalizeShorthandActionEntry("return_results");
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts map shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			return_results: true,
		});
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts typed action", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "return_results",
		});
		assert.deepStrictEqual(parsed, { type: "return_results" });
	});

	it("accepts an explicit result list", () => {
		const parsed = normalizeShorthandActionEntry({
			return_results: [
				{
					link: " https://example.com/item ",
					summary: " matching item ",
				},
			],
		});
		assert.deepStrictEqual(parsed, {
			type: "return_results",
			results: [
				{
					link: "https://example.com/item",
					summary: "matching item",
				},
			],
		});
	});

	it("rejects the old memory_return_results tool name", () => {
		assert.isNull(normalizeShorthandActionEntry("memory_return_results"));
		assert.isNull(
			normalizeShorthandActionEntry({
				memory_return_results: true,
			}),
		);
	});
});

describe("action-normalization memory_clear", () => {
	it("accepts shorthand target", () => {
		const parsed = normalizeShorthandActionEntry({
			memory_clear: "memory_result",
		});
		assert.deepStrictEqual(parsed, {
			type: "memory_clear",
			target: "memory_result",
		});
	});

	it("accepts typed target", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "memory_clear",
			target: "all",
		});
		assert.deepStrictEqual(parsed, {
			type: "memory_clear",
			target: "all",
		});
	});

	it("rejects invalid target", () => {
		assert.isNull(
			normalizeShorthandActionEntry({ memory_clear: "unknown" }),
		);
	});
});

describe("action-normalization extract_data", () => {
	it("accepts and canonicalizes extract_data roots", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "extract_data",
			root: " !a, 42 ,!b ",
		});
		assert.deepStrictEqual(parsed, {
			type: "extract_data",
			root: "!a,42,!b",
		});
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				extract_data: " !a, 42 ,!b ",
			}),
			{
				type: "extract_data",
				root: "!a,42,!b",
			},
		);
	});

	it("rejects empty root segments and removed range fields", () => {
		for (const extract_data of [
			"",
			"   ",
			"42,",
			",42",
			"42, ,43",
			{ root: "42", start: "43", end_exclusive: "44" },
			{ root: "42", end_exclusive: "44" },
			{ start: "42" },
			{ end_exclusive: "44" },
			{ endExclusive: "44" },
			{ root: "" },
			{ root: "42," },
			{ root: ",42" },
			{ root: "42, ,43" },
			42,
		]) {
			assert.isNull(
				normalizeShorthandActionEntry({
					extract_data,
				}),
			);
		}
	});

	it("rejects nested and legacy per-item contracts", () => {
		for (const legacy of [
			{ root: "42" },
			{ items: [{ bid: "42" }] },
			{ bid: "42" },
			{ root: "42", hierarchy: 0 },
			{ root: "42", url_bid: "43" },
			{ root: "42", write_to: "memory_result" },
			{ root: "42", writeTo: "memory_result" },
		]) {
			assert.isNull(
				normalizeShorthandActionEntry({ extract_data: legacy }),
			);
		}
	});
});

describe("action-normalization scroll", () => {
	it("accepts typed scroll with numeric deltas", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "scroll",
			bid: "s1",
			deltaX: 0,
			deltaY: 320,
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			bid: "s1",
			deltaX: 0,
			deltaY: 320,
		});
	});

	it("accepts shorthand scroll map", () => {
		const parsed = normalizeShorthandActionEntry({
			scroll: { bid: "s2", deltaY: 240 },
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			bid: "s2",
			deltaY: 240,
		});
	});

	it("coerces string deltas to numbers", () => {
		const parsed = normalizeShorthandActionEntry({
			scroll: { bid: "s3", deltaX: "12.5", deltaY: "-300" },
		});
		assert.deepStrictEqual(parsed, {
			type: "scroll",
			bid: "s3",
			deltaX: 12.5,
			deltaY: -300,
		});
	});

	it("rejects scroll entries with no finite delta values", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				scroll: { bid: "s4" },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				scroll: { bid: "s4", deltaY: "abc" },
			}),
		);
	});
});

describe("action-normalization agent_takeover", () => {
	it("accepts string-only agent_takeover shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			agent_takeover: "Extract the service ID from ./bill.pdf.",
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
	});

	it("accepts typed agent_takeover with a string request", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID from ./bill.pdf.",
		});
	});

	it("accepts nested agent_takeover maps with request", () => {
		const parsed = normalizeShorthandActionEntry({
			agent_takeover: {
				request: "Extract the service ID.",
				sourceHints: ["./bill.pdf"],
			},
		});
		assert.deepStrictEqual(parsed, {
			type: "agent_takeover",
			request: "Extract the service ID.",
		});
	});

	it("rejects reason as an agent_takeover request alias", () => {
		const result = normalizeActionListWithDiagnostics([
			{
				type: "agent_takeover",
				reason: "Extract the service ID.",
			},
		]);
		assert.deepStrictEqual(result.actions, []);
		assert.deepStrictEqual(result.diagnostics, [
			'actions[0]: agent_takeover requires a non-empty "request" string',
		]);
	});
});

describe("action-normalization user_takeover", () => {
	it("accepts typed user_takeover with a string request", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "user_takeover",
			category: "authentication",
			request: "Use secure authentication handling for sign-in.",
		});
		assert.deepStrictEqual(parsed, {
			type: "user_takeover",
			category: "authentication",
			reason: "Use secure authentication handling for sign-in.",
		});
	});

	it("rejects reason as a user_takeover request alias", () => {
		const result = normalizeActionListWithDiagnostics([
			{
				type: "user_takeover",
				category: "authentication",
				reason: "Use secure authentication handling for sign-in.",
			},
		]);
		assert.deepStrictEqual(result.actions, []);
		assert.deepStrictEqual(result.diagnostics, [
			'actions[0]: user_takeover requires a non-empty "request" string',
		]);
	});

	it("normalizes a single action object instead of dropping it", () => {
		const result = normalizeActionListWithDiagnostics({
			type: "agent_takeover",
			request: "Rename ./downloads/source.pdf to ./downloads/final.pdf.",
		});
		assert.deepStrictEqual(result.actions, [
			{
				type: "agent_takeover",
				request:
					"Rename ./downloads/source.pdf to ./downloads/final.pdf.",
			},
		]);
		assert.deepStrictEqual(result.diagnostics, []);
	});
});

describe("action-normalization download_current_file", () => {
	it("accepts shorthand string action", () => {
		const parsed = normalizeShorthandActionEntry("download_current_file");
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("accepts map shorthand", () => {
		const parsed = normalizeShorthandActionEntry({
			download_current_file: true,
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("ignores map shorthand targetPath", () => {
		const parsed = normalizeShorthandActionEntry({
			download_current_file: {
				targetPath: "./downloads/financial_report.pdf",
			},
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});

	it("ignores typed action targetPath", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "download_current_file",
			targetPath: "./downloads/financial_report.pdf",
		});
		assert.deepStrictEqual(parsed, { type: "download_current_file" });
	});
});

describe("action-normalization upload_files", () => {
	it("accepts typed upload_files", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "upload_files",
			bid: "12",
			paths: ["./report.pdf", "./downloads/file.csv"],
		});
		assert.deepStrictEqual(parsed, {
			type: "upload_files",
			bid: "12",
			paths: ["./report.pdf", "./downloads/file.csv"],
		});
	});

	it("accepts shorthand upload_files map", () => {
		const parsed = normalizeShorthandActionEntry({
			upload_files: {
				bid: "22",
				paths: "./input.txt",
			},
		});
		assert.deepStrictEqual(parsed, {
			type: "upload_files",
			bid: "22",
			paths: ["./input.txt"],
		});
	});

	it("rejects upload_files without bid or paths", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				upload_files: {
					paths: ["./input.txt"],
				},
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				upload_files: {
					bid: "22",
					paths: [],
				},
			}),
		);
	});
});

describe("action-normalization typed wait/type", () => {
	it("accepts typed wait when duration is provided as value", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "wait",
			value: 3000,
		});
		assert.deepStrictEqual(parsed, {
			type: "wait",
			ms: 3000,
		});
	});

	it("coerces typed type action text to string", () => {
		const parsed = normalizeShorthandActionEntry({
			type: "type",
			bid: "f",
			text: 20240101,
		});
		assert.deepStrictEqual(parsed, {
			type: "type",
			bid: "f",
			text: "20240101",
		});
	});
});

describe("action-normalization long_press/read_file", () => {
	it("accepts typed and shorthand long_press actions", () => {
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				type: "long_press",
				bid: "hold",
			}),
			{ type: "long_press", bid: "hold" },
		);
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				long_press: { bid: "hold", durationMs: 2500 },
			}),
			{ type: "long_press", bid: "hold", durationMs: 2500 },
		);
	});

	it("rejects invalid long_press duration and missing bid", () => {
		assert.isNull(
			normalizeShorthandActionEntry({
				long_press: { bid: "hold", durationMs: 99 },
			}),
		);
		assert.isNull(
			normalizeShorthandActionEntry({
				long_press: { durationMs: 1000 },
			}),
		);
	});

	it("accepts typed and shorthand read_file actions", () => {
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				type: "read_file",
				path: "./downloads/source.pdf",
			}),
			{ type: "read_file", path: "./downloads/source.pdf" },
		);
		assert.deepStrictEqual(
			normalizeShorthandActionEntry({
				read_file: { path: "./notes.txt" },
			}),
			{ type: "read_file", path: "./notes.txt" },
		);
	});
});
