import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const [wrapperTarball, platformTarball, platform] = process.argv.slice(2);
if (!wrapperTarball || !platformTarball || !platform) {
	throw new Error(
		"Usage: verify-npm-packages <wrapper.tgz> <platform.tgz> <platform>",
	);
}
const absoluteWrapper = path.resolve(wrapperTarball);
const absolutePlatform = path.resolve(platformTarball);
const suffix = platform.startsWith("win32-") ? ".exe" : "";
const packageName = `crafty-browser-agent-${platform}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(
	path.join(os.tmpdir(), "browser-agent-npm-package-"),
);

function run(command, arguments_, options = {}) {
	const result = spawnSync(command, arguments_, {
		cwd: directory,
		encoding: "utf8",
		...options,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${arguments_.join(" ")} failed:\n${result.stderr}`,
	);
	return result;
}

try {
	fs.writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	run(process.platform === "win32" ? "npm.cmd" : "npm", [
		"install",
		"--ignore-scripts",
		"--no-package-lock",
		"--offline",
		absolutePlatform,
		absoluteWrapper,
	]);
	const require = createRequire(path.join(directory, "package.json"));
	const platformManifest = require.resolve(`${packageName}/package.json`);
	const executable = path.join(
		path.dirname(platformManifest),
		"bin",
		`browser-agent${suffix}`,
	);
	const testedExecutable = path.join(
		root,
		"sdk",
		"typescript-sdk",
		"platform-packages",
		platform,
		"bin",
		`browser-agent${suffix}`,
	);
	assert(
		fs.existsSync(executable),
		`Missing packaged executable: ${executable}`,
	);
	const digest = (file) =>
		createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	assert.equal(
		digest(executable),
		digest(testedExecutable),
		"Packaged executable differs from the tested binary",
	);
	const runtime = await import(
		pathToFileURL(
			path.join(
				path.dirname(
					require.resolve("crafty-browser-agent/package.json"),
				),
				"dist",
				"runtime.js",
			),
		).href
	);
	assert.equal(await runtime.resolveExecutable(), executable);
	const selfTest = run(executable, ["--sdk-self-test-json"]);
	assert.deepEqual(JSON.parse(selfTest.stdout), {
		sharp: true,
		tesseract: true,
		pdf: true,
		docx: true,
		xlsx: true,
	});
	assert.doesNotMatch(
		selfTest.stderr,
		/Cannot (find|load) .*module|native binding/i,
	);
	run(process.execPath, [
		path.join(root, "scripts", "smoke-sdk-binary.mjs"),
		executable,
	]);
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}

console.log(`npm SDK packages verified for ${platform}.`);
