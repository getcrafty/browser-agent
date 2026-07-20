import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveOptions } from "../src/options.js";
import {
	bundledExecutable,
	createRuntimeFiles,
	platformKey,
	resolveExecutable,
	verifyExecutable,
} from "../src/runtime.js";
import { fakeExecutable, withMode } from "./helpers.js";

test("creates private files and preserves caller-owned directories", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-config-"));
	const workspace = path.join(root, "workspace");
	const downloads = path.join(root, "downloads");
	try {
		const files = await createRuntimeFiles(
			resolveOptions({
				provider: "openai",
				model: "gpt-5.4",
				apiKey: "secret",
				downloadDirectory: downloads,
				workspaceDirectory: workspace,
				executablePath: "./chrome",
				endpointUrl: "https://example.com/v1",
			}),
			[{ task: "go", url: "https://example.com" }],
		);
		const runtimeDirectory = path.dirname(files.configPath);
		assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(files.configPath).mode & 0o777, 0o600);
		const config = JSON.parse(fs.readFileSync(files.configPath, "utf8"));
		assert.equal(config.executable_path, path.resolve("chrome"));
		assert.equal(config.endpoint_url, "https://example.com/v1");
		await files.cleanup();
		assert.equal(fs.existsSync(runtimeDirectory), false);
		assert.equal(fs.existsSync(workspace), true);
		assert.equal(fs.existsSync(downloads), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("normalizes platforms and resolves executable bundles", async () => {
	assert.equal(platformKey(), `${process.platform}-${process.arch}`);
	const syntheticPackage = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"node_modules",
		"crafty-browser-agent-aix-ppc64",
	);
	fs.mkdirSync(syntheticPackage, { recursive: true });
	fs.writeFileSync(
		path.join(syntheticPackage, "package.json"),
		JSON.stringify({ name: "crafty-browser-agent-aix-ppc64" }),
	);
	try {
		assert.match(
			bundledExecutable("aix", "ppc64"),
			/crafty-browser-agent-aix-ppc64\/bin\/browser-agent$/,
		);
	} finally {
		fs.rmSync(syntheticPackage, { recursive: true, force: true });
	}
	assert.match(
		bundledExecutable("win32", "x64"),
		/crafty-browser-agent-win32-x64\/(?:bin\/)?browser-agent\.exe$/,
	);
	assert.match(
		bundledExecutable("linux", "arm64"),
		/crafty-browser-agent-linux-arm64\/(?:bin\/)?browser-agent$/,
	);
	const executable = path.join(os.tmpdir(), `sdk-executable-${Date.now()}`);
	fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
	try {
		assert.equal(await resolveExecutable(executable), executable);
	} finally {
		fs.rmSync(executable, { force: true });
	}
	await assert.rejects(resolveExecutable("/definitely/missing"), {
		code: "CLI_NOT_FOUND",
	});
	const absentPlatform = process.platform === "win32" ? "darwin" : "win32";
	await assert.rejects(resolveExecutable(undefined, absentPlatform, "x64"), {
		code: "CLI_NOT_FOUND",
		message: /optional dependencies/,
	});
	await assert.rejects(resolveExecutable(undefined, "aix", "ppc64"), {
		code: "CLI_NOT_FOUND",
		message: /does not provide/,
	});
});

test("verifies compatible, incompatible, missing, and timed-out executables", async () => {
	await withMode("success", () => verifyExecutable(fakeExecutable));
	await withMode("version-mismatch", async () => {
		await assert.rejects(verifyExecutable(fakeExecutable), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
	});
	await assert.rejects(
		verifyExecutable(path.join(os.tmpdir(), "missing-cli")),
		{
			code: "CLI_NOT_FOUND",
		},
	);
	const sleeper = path.join(os.tmpdir(), `sdk-sleeper-${Date.now()}`);
	const failing = path.join(os.tmpdir(), `sdk-failing-${Date.now()}`);
	fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 1\n", { mode: 0o700 });
	fs.writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	try {
		await assert.rejects(verifyExecutable(sleeper, 5), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
		await assert.rejects(verifyExecutable(failing), {
			code: "CLI_VERSION_INCOMPATIBLE",
		});
	} finally {
		fs.rmSync(sleeper, { force: true });
		fs.rmSync(failing, { force: true });
	}
});

test("cleans partial runtime files after setup failure", async () => {
	const before = new Set(
		fs
			.readdirSync(process.cwd())
			.filter((name) => name.startsWith(".browser-agent-workspace-")),
	);
	const file = path.join(os.tmpdir(), `ts-sdk-file-${Date.now()}`);
	fs.writeFileSync(file, "");
	try {
		await assert.rejects(
			createRuntimeFiles(
				resolveOptions({
					provider: "openai",
					model: "gpt-5.4",
					apiKey: "secret",
					downloadDirectory: file,
				}),
				[{ task: "go" }],
			),
		);
		const after = fs
			.readdirSync(process.cwd())
			.filter((name) => name.startsWith(".browser-agent-workspace-"));
		assert(after.every((name) => before.has(name)));
	} finally {
		fs.rmSync(file, { force: true });
	}
});
