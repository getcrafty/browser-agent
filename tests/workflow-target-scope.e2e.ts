import { assert } from "chai";
import { describe, it } from "mocha";
import {
	close,
	launch,
	listTabs,
	newTab,
	switchTab,
} from "../src/browser/index.js";
import { TargetScopeCoordinator } from "../src/browser/target-scope.js";
import type { Browser } from "../src/browser/types.js";

describe("workflow target scoping e2e", function () {
	this.timeout(90_000);

	it("keeps concurrent node tabs disjoint on one CDP instance", async () => {
		let root: Browser | undefined;
		let left: Browser | undefined;
		let right: Browser | undefined;
		try {
			root = await launch(undefined, true);
			const coordinator = new TargetScopeCoordinator(root);
			await coordinator.createPreparationScope("prepare");
			await coordinator.fanOut("prepare", ["left", "right"]);
			await coordinator.releaseScope("prepare", { closeTargets: true });
			left = await coordinator.createScopedBrowser("left");
			right = await coordinator.createScopedBrowser("right");

			const leftBefore = await listTabs(left);
			const rightBefore = await listTabs(right);
			assert.isNotEmpty(leftBefore);
			assert.isNotEmpty(rightBefore);
			assert.deepEqual(
				leftBefore
					.map((tab) => tab.targetId)
					.filter((targetId) =>
						rightBefore.some((tab) => tab.targetId === targetId),
					),
				[],
			);

			await Promise.all([
				left.Page.navigate({
					url: "data:text/html,<title>left-progress</title><main id='state'>left</main>",
				}),
				right.Page.navigate({
					url: "data:text/html,<title>right-progress</title><main id='state'>right</main>",
				}),
			]);
			await new Promise((resolve) => setTimeout(resolve, 100));
			await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					Promise.all([
						left!.Runtime.evaluate({
							expression: `document.querySelector('#state').textContent += '-L${index}'`,
						}),
						right!.Runtime.evaluate({
							expression: `document.querySelector('#state').textContent += '-R${index}'`,
						}),
					]),
				),
			);
			const [leftState, rightState] = await Promise.all([
				left.Runtime.evaluate({
					expression: "document.querySelector('#state').textContent",
					returnByValue: true,
				}),
				right.Runtime.evaluate({
					expression: "document.querySelector('#state').textContent",
					returnByValue: true,
				}),
			]);
			assert.equal(
				leftState.result.value,
				"left-L0-L1-L2-L3-L4-L5-L6-L7",
			);
			assert.equal(
				rightState.result.value,
				"right-R0-R1-R2-R3-R4-R5-R6-R7",
			);

			const opened = await newTab(
				left,
				"data:text/html,<title>left-only</title>",
			);
			assert.include(
				(await listTabs(left)).map((tab) => tab.targetId),
				opened.targetId,
			);
			assert.notInclude(
				(await listTabs(right)).map((tab) => tab.targetId),
				opened.targetId,
			);
			let switchError: unknown;
			try {
				await switchTab(right, opened.targetId);
			} catch (error) {
				switchError = error;
			}
			assert.instanceOf(switchError, Error);
			assert.match((switchError as Error).message, /does not own browser target/);
		} finally {
			if (left) await close(left).catch(() => undefined);
			if (right) await close(right).catch(() => undefined);
			if (root) await close(root).catch(() => undefined);
		}
	});
});
