import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";

function createScrollActionBrowser(): any {
	return {
		DOM: {
			getDocument: async () => ({
				root: {
					nodeId: 1,
					children: [
						{
							nodeId: 2,
							attributes: ["data-bid", "s1"],
						},
					],
				},
			}),
			resolveNode: async ({ nodeId }: { nodeId: number }) => ({
				object: { objectId: `obj-scroll-${nodeId}` },
			}),
			scrollIntoViewIfNeeded: async () => undefined,
		},
		Runtime: {
			callFunctionOn: async (input: {
				functionDeclaration: string;
				arguments?: Array<{ value: unknown }>;
			}) => {
				if (
					input.functionDeclaration.includes("getBoundingClientRect")
				) {
					return { result: { value: "" } };
				}
				if (input.functionDeclaration.includes("WheelEvent")) {
					return { result: { value: true } };
				}
				return { result: { value: undefined } };
			},
		},
	};
}

describe("scroll action execution", () => {
	it("dispatches bid-targeted scroll without interaction errors", async () => {
		const result = await executeActions({
			b: createScrollActionBrowser(),
			actions: [
				{
					type: "scroll",
					bid: "s1",
					deltaY: 280,
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-scroll-action-memory.txt",
		});

		assert.deepEqual(result.interactionErrors, []);
		assert.isFalse(result.pendingMemoryRead);
	});

	it("reports validation errors when scroll deltas are zero", async () => {
		const result = await executeActions({
			b: createScrollActionBrowser(),
			actions: [
				{
					type: "scroll",
					bid: "s2",
					deltaX: 0,
					deltaY: 0,
				},
			],
			openTabs: [],
			memoryFile: "/tmp/browser-agent-scroll-action-memory.txt",
		});

		assert.strictEqual(result.interactionErrors.length, 1);
		assert.include(result.interactionErrors[0], "scroll(bid=s2");
		assert.include(result.interactionErrors[0], "non-zero delta");
	});
});
