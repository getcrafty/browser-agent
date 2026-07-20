import { assert } from "chai";
import { describe, it } from "mocha";
import { resolveElement } from "../src/browser/interaction/utils.js";
import type { Browser } from "../src/browser/types.js";

function createBaseBrowser(): Browser {
	return {
		port: 9222,
		client: {} as any,
		chrome: {} as any,
		Page: {} as any,
		Runtime: {} as any,
		DOMSnapshot: {} as any,
		Input: {} as any,
		Target: {} as any,
		Accessibility: {} as any,
		DOM: {} as any,
	};
}

describe("resolveElement", () => {
	it("resolves a light-DOM data-bid match", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({
					root: {
						nodeId: 1,
						children: [
							{ nodeId: 11, attributes: ["data-bid", "def"] },
							{ nodeId: 12, attributes: ["data-bid", "abc"] },
						],
					},
				}),
				resolveNode: async ({ nodeId }: { nodeId: number }) => ({
					object: { objectId: `object-${nodeId}` },
				}),
			} as any,
		} satisfies Browser;

		const result = await resolveElement(browser, "abc");
		assert.deepEqual(result, { nodeId: 12, objectId: "object-12" });
	});

	it("matches a comma-separated bid token", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({
					root: {
						nodeId: 1,
						children: [
							{
								nodeId: 11,
								attributes: ["data-bid", "x, y, 2b"],
							},
						],
					},
				}),
				resolveNode: async () => ({
					object: { objectId: "object-11" },
				}),
			} as any,
		} satisfies Browser;

		const result = await resolveElement(browser, "2b");
		assert.deepEqual(result, { nodeId: 11, objectId: "object-11" });
	});

	it("searches a pierced tree for shadow-root nodes", async () => {
		let getDocumentArgs: unknown;
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async (args: unknown) => {
					getDocumentArgs = args;
					return {
						root: {
							nodeId: 9,
							children: [
								{
									nodeId: 101,
									attributes: ["data-bid", "light-target"],
								},
								{
									nodeId: 200,
									shadowRoots: [
										{
											nodeId: 201,
											children: [
												{
													nodeId: 102,
													attributes: [
														"data-bid",
														"shadow-target",
													],
												},
											],
										},
									],
								},
							],
						},
					};
				},
				resolveNode: async ({ nodeId }: { nodeId: number }) => ({
					object: { objectId: `object-${nodeId}` },
				}),
			} as any,
		} satisfies Browser;

		const result = await resolveElement(browser, "shadow-target");
		assert.deepEqual(getDocumentArgs, { depth: -1, pierce: true });
		assert.deepEqual(result, { nodeId: 102, objectId: "object-102" });
	});

	it("throws a clear error when no stamped bid matches", async () => {
		const browser = {
			...createBaseBrowser(),
			DOM: {
				getDocument: async () => ({
					root: {
						nodeId: 1,
						children: [
							{ nodeId: 11, attributes: ["data-bid", "other"] },
						],
					},
				}),
				resolveNode: async () => ({
					object: { objectId: "object-11" },
				}),
			} as any,
		} satisfies Browser;

		try {
			await resolveElement(browser, "missing");
			assert.fail("Expected resolveElement to throw");
		} catch (error) {
			assert.include(String(error), "Element not found: bid=missing");
		}
	});
});
