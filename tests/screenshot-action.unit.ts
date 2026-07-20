import { assert } from "chai";
import { describe, it } from "mocha";
import { normalizeScreenshotBids } from "../src/agents/executor-utils/screenshot-action.js";

describe("screenshot-action", () => {
	it("normalizes and deduplicates screenshot bids", () => {
		assert.deepEqual(normalizeScreenshotBids([]), []);
		assert.deepEqual(normalizeScreenshotBids(["1"]), ["1"]);
		assert.deepEqual(normalizeScreenshotBids(["1, 2", "2", "3"]), [
			"1",
			"2",
			"3",
		]);
		assert.deepEqual(normalizeScreenshotBids(["  ", "4,,5", "5 , 6"]), [
			"4",
			"5",
			"6",
		]);
	});
});
