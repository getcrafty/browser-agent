import { assert } from "chai";
import { describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import {
	close,
	getSimplifiedDOM,
	launch,
	navigate,
} from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";
import { featureFlags } from "../src/featureFlags.js";

function fixtureUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Visible viewport content</h1>
      <div style="height: 2400px"></div>
      <section>
        <article><p>Deep target content revealed by scrolling</p></article>
      </section>
      <div style="height: 1200px"></div>
    </main>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

describe("offscreen DOM scroll e2e", function () {
	this.timeout(30_000);

	it("reveals omitted content using the marker's scroll instruction", async () => {
		const originalFlag = featureFlags.hideOffscreenDomContent;
		let browser: Browser | null = null;
		try {
			featureFlags.hideOffscreenDomContent = true;
			browser = await launch(undefined, true);
			await navigate(browser, fixtureUrl());

			const initialDom = await getSimplifiedDOM(browser);
			assert.include(initialDom, "Visible viewport content");
			assert.notInclude(
				initialDom,
				"Deep target content revealed by scrolling",
			);
			const marker = initialDom.match(
				/content-hidden-outside-viewport bid="([^"]+)" scroll-delta-y="(-?\d+)"/,
			);
			assert.isNotNull(marker, "expected an offscreen placeholder");
			const bid = marker?.[1] ?? "";
			const deltaY = Number(marker?.[2] ?? 0);
			assert.isAbove(deltaY, 0);

			const execution = await executeActions({
				b: browser,
				actions: [{ type: "scroll", bid, deltaY }],
				openTabs: [],
				memoryFile: "/tmp/browser-agent-offscreen-scroll-memory.txt",
			});
			assert.deepEqual(execution.interactionErrors, []);

			const revealedDom = await getSimplifiedDOM(browser);
			assert.include(
				revealedDom,
				"Deep target content revealed by scrolling",
			);
		} finally {
			featureFlags.hideOffscreenDomContent = originalFlag;
			if (browser) await close(browser);
		}
	});
});
