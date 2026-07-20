import { assert } from "chai";
import { describe, it } from "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { saveStepContextIfNeeded } from "../src/agents/executor-utils/step-execution.js";
import type { Browser } from "../src/browser/types.js";

describe("screenshot-action-persistence", () => {
	it("writes tool-call screenshots and skips persistence when disabled", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "screenshot-persist-test-"),
		);
		const contextDir = path.join(tmpDir, "context");
		const stepsDir = path.join(tmpDir, "steps");
		try {
			await saveStepContextIfNeeded({
				saveStepsContext: true,
				contextDir,
				stepsDir,
				stepNumber: 7,
				messages: [{ role: "system", content: "sys" }],
				simplifiedDom: "dom",
				browser: {} as Browser,
				writeCoreFiles: false,
				preStepScreenshotDataUrl: `data:image/jpeg;base64,${Buffer.from("pre-step").toString("base64")}`,
				toolCallScreenshots: [
					{
						callSequence: 2,
						captures: [
							{
								bid: "3f",
								imageBase64: Buffer.from("a").toString("base64"),
							},
							{
								bid: "3f",
								imageBase64: Buffer.from("b").toString("base64"),
							},
						],
					},
				],
			});

			const stepDir = path.join(contextDir, "screenshots", "step-007");
			assert(fs.existsSync(stepDir), "Expected screenshot step directory");

			const files = fs.readdirSync(stepDir).sort();
			assert(files.includes("call-02-bid-3f.png"));
			assert(files.includes("call-02-bid-3f-2.png"));
			assert(files.includes("pre-step-current-page.jpg"));
			const preStepScreenshotPath = path.join(
				stepDir,
				"pre-step-current-page.jpg",
			);
			assert.strictEqual(
				fs.readFileSync(preStepScreenshotPath, "utf-8"),
				"pre-step",
			);

			const beforeCount = files.length;
			await saveStepContextIfNeeded({
				saveStepsContext: false,
				contextDir,
				stepsDir,
				stepNumber: 8,
				messages: [{ role: "system", content: "sys" }],
				simplifiedDom: "dom",
				browser: {} as Browser,
				writeCoreFiles: false,
				toolCallScreenshots: [
					{
						callSequence: 1,
						captures: [
							{
								bid: "4a",
								imageBase64: Buffer.from("c").toString("base64"),
							},
						],
					},
				],
			});
			const filesAfter = fs.readdirSync(stepDir);
			assert.strictEqual(filesAfter.length, beforeCount);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
