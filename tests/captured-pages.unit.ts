import { assert } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import { JSDOM } from "jsdom";
import type { Browser } from "../src/browser/types.js";
import {
	captureCurrentPageToMarkdown,
	clearCapturedPages,
	listCapturedPageFiles,
	restoreCapturedPages,
	saveCapturedMarkdownPage,
	snapshotCapturedPages,
} from "../src/agents/executor-utils/captured-pages.js";

function browserForHtml(html: string, url: string): Browser {
	const dom = new JSDOM(html, { url, runScripts: "outside-only" });
	const document = dom.window.document;
	(document.querySelector("#username") as HTMLInputElement).value =
		"live-user@example.com";
	(document.querySelector("#password") as HTMLInputElement).value =
		"live-password";
	(document.querySelector("#notes") as HTMLTextAreaElement).value =
		"live textarea secret";
	return {
		Runtime: {
			evaluate: async ({ expression }: { expression: string }) => ({
				result: { value: dom.window.eval(expression) },
			}),
		} as Browser["Runtime"],
	} as Browser;
}

describe("captured pages", () => {
	it("saves sequential full-page Markdown with metadata and no live values or bids", async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "captured-pages-test-"),
		);
		try {
			const browser = browserForHtml(
				`<!doctype html><html><head><title>Account page</title><script>window.SECRET = "script-secret"</script></head><body>
        <main><h1>Grounded heading</h1><a href="https://example.com/item">Item</a></main>
        <input id="username" bid="user-bid" value="default-user@example.com">
        <input id="password" type="password" bid="password-bid" value="default-password">
        <textarea id="notes">default textarea secret</textarea>
        <div bid="protected-account">protected-user@example.com</div>
        <button data-bid="ordinary-bid" onclick="steal()">Continue</button>
        </body></html>`,
				"https://example.com/account?tab=security",
			);
			const capturedAt = new Date("2026-07-22T12:00:00.000Z");
			const first = await captureCurrentPageToMarkdown({
				browser,
				directory,
				sequence: 1,
				protectedBids: ["user-bid", "password-bid", "protected-account"],
				capturedAt,
			});
			const second = await captureCurrentPageToMarkdown({
				browser,
				directory,
				sequence: 2,
				protectedBids: ["user-bid", "password-bid", "protected-account"],
				capturedAt,
			});

			assert.equal(
				first.fileName,
				"1 - https_example.com_account_tab=security.md",
			);
			assert.equal(
				second.fileName,
				"2 - https_example.com_account_tab=security.md",
			);
			assert.deepEqual(listCapturedPageFiles(directory), [
				"1 - https_example.com_account_tab=security.md",
				"2 - https_example.com_account_tab=security.md",
			]);
			const content = fs.readFileSync(first.filePath, "utf-8");
			assert.include(content, "title: Account page");
			assert.include(
				content,
				"url: https://example.com/account?tab=security",
			);
			assert.include(content, "captured_at: '2026-07-22T12:00:00.000Z'");
			assert.include(content, "Grounded heading");
			for (const forbidden of [
				"live-user@example.com",
				"default-user@example.com",
				"live-password",
				"default-password",
				"live textarea secret",
				"default textarea secret",
				"protected-user@example.com",
				"user-bid",
				"password-bid",
				"protected-account",
				"ordinary-bid",
				"script-secret",
				"onclick",
			]) {
				assert.notInclude(content, forbidden);
			}
			assert.isEmpty(
				fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("sanitizes unsafe URL characters and truncates without splitting Unicode", () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "captured-pages-filename-"),
		);
		try {
			const sanitized = saveCapturedMarkdownPage({
				directory,
				sequence: 12,
				title: "Unsafe URL",
				url: ' https://example.com/a path/<report>?q="x"|* ',
				markdown: "content",
			});
			assert.equal(
				sanitized.fileName,
				"12 - https_example.com_a_path_report_q=_x.md",
			);

			const longUrl = `https://example.com/${"😀".repeat(100)}`;
			const truncated = saveCapturedMarkdownPage({
				directory,
				sequence: 13,
				title: "Long URL",
				url: longUrl,
				markdown: "content",
			});
			assert.isAtMost(Buffer.byteLength(truncated.fileName, "utf-8"), 240);
			assert.notInclude(truncated.fileName, "�");
			assert.include(
				fs.readFileSync(truncated.filePath, "utf-8"),
				`url: ${longUrl}`,
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("sorts, snapshots, clears, and restores new and legacy page names", () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "captured-pages-rollback-"),
		);
		try {
			fs.writeFileSync(path.join(directory, "10 - https_ten.test.md"), "ten");
			fs.writeFileSync(path.join(directory, "2 - https_two.test.md"), "two");
			fs.writeFileSync(path.join(directory, "1 - https_one.test.md"), "one");
			fs.writeFileSync(path.join(directory, "page-0003.md"), "legacy");
			fs.writeFileSync(path.join(directory, "notes.md"), "unrelated");
			assert.deepEqual(listCapturedPageFiles(directory), [
				"1 - https_one.test.md",
				"2 - https_two.test.md",
				"page-0003.md",
				"10 - https_ten.test.md",
			]);
			const snapshot = snapshotCapturedPages(directory);
			clearCapturedPages(directory);
			assert.deepEqual(listCapturedPageFiles(directory), []);
			assert.equal(
				fs.readFileSync(path.join(directory, "notes.md"), "utf-8"),
				"unrelated",
			);
			fs.writeFileSync(path.join(directory, "4 - https_retry.test.md"), "retry");
			restoreCapturedPages(directory, snapshot);
			assert.deepEqual(listCapturedPageFiles(directory), [
				"1 - https_one.test.md",
				"2 - https_two.test.md",
				"page-0003.md",
				"10 - https_ten.test.md",
			]);
			assert.equal(
				fs.readFileSync(
					path.join(directory, "2 - https_two.test.md"),
					"utf-8",
				),
				"two",
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
