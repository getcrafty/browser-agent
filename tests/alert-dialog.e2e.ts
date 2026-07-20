import { assert } from "chai";
import { describe, it } from "mocha";
import { click, close, launch, navigate } from "../src/browser/index.js";
import type { Browser } from "../src/browser/types.js";

function buildAlertOnClickPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <button id="trigger" data-bid="1" onclick="window.__alertCount += 1; alert('Blocking alert'); document.getElementById('status').textContent = 'after-alert';">
      Trigger alert
    </button>
    <div id="status">before-alert</div>
    <script>
      window.__alertCount = 0;
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

function buildShadowClickPageDataUrl(): string {
	const html = `<!doctype html>
<html>
  <body>
    <div id="host"></div>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="shadow-button" data-bid="shadow-click">Click me</button>';
      root.getElementById("shadow-button").addEventListener("click", () => {
        host.setAttribute("data-clicked", "yes");
      });
    </script>
  </body>
</html>`;
	return `data:text/html,${encodeURIComponent(html)}`;
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

function isSandboxLocalhostPolicyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("Blocked by sandbox network policy") &&
		message.includes("127.0.0.1")
	);
}

describe("alert dialog e2e", function () {
	this.timeout(90_000);

	it("auto-accepts alert dialogs so click interactions can continue", async function () {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, false);
			await navigate(browser, buildAlertOnClickPageDataUrl());

			await withTimeout(click(browser, "1"), 5_000, "click with alert");

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => ({
          alertCount: window.__alertCount,
          status: document.getElementById("status")?.textContent || ""
        }))()`,
				returnByValue: true,
			});
			const value = (result.value ?? {}) as {
				alertCount?: number;
				status?: string;
			};

			assert.strictEqual(value.alertCount, 1);
			assert.strictEqual(value.status, "after-alert");
		} catch (error) {
			if (isSandboxLocalhostPolicyError(error)) {
				this.skip();
				return;
			}
			throw error;
		} finally {
			if (browser) await close(browser);
		}
	});

	it("registers clicks on elements inside open shadow roots", async function () {
		let browser: Browser | null = null;
		try {
			browser = await launch(undefined, true);
			await navigate(browser, buildShadowClickPageDataUrl());

			await withTimeout(
				click(browser, "shadow-click"),
				5_000,
				"shadow click",
			);

			const { result } = await browser.Runtime.evaluate({
				expression: `(() => document.getElementById("host")?.getAttribute("data-clicked") || "")()`,
				returnByValue: true,
			});
			const value = typeof result.value === "string" ? result.value : "";
			assert.strictEqual(value, "yes");
		} catch (error) {
			if (isSandboxLocalhostPolicyError(error)) {
				this.skip();
				return;
			}
			throw error;
		} finally {
			if (browser) await close(browser);
		}
	});
});
