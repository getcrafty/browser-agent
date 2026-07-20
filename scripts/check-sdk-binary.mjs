import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operatingSystem = { darwin: "darwin", linux: "linux", win32: "win32" }[
	process.platform
];
const architecture = { arm64: "arm64", x64: "x64" }[process.arch];
if (!operatingSystem || !architecture) {
	throw new Error(
		`Unsupported package host: ${process.platform}-${process.arch}`,
	);
}
const suffix = process.platform === "win32" ? ".exe" : "";
const platform = `${operatingSystem}-${architecture}`;
const packageName = process.argv[2];
const requestedPlatform = process.argv[3] ?? platform;
if (requestedPlatform !== platform) {
	throw new Error(
		`Cannot verify ${requestedPlatform} SDK executable on ${platform}`,
	);
}
const executable =
	packageName === "typescript"
		? path.join(
				root,
				"sdk",
				"typescript-sdk",
				"platform-packages",
				requestedPlatform,
				"bin",
				`browser-agent${suffix}`,
			)
		: path.join(
				root,
				"sdk",
				"python-sdk",
				"src",
				"browser_agent",
				"bin",
				requestedPlatform,
				`browser-agent${suffix}`,
			);
try {
	await access(
		executable,
		process.platform === "win32" ? constants.F_OK : constants.X_OK,
	);
} catch {
	throw new Error(
		`Missing SDK executable for ${requestedPlatform}: ${executable}`,
	);
}

const directory = await mkdtemp(path.join(os.tmpdir(), "browser-agent-check-"));
try {
	const result = spawnSync(executable, ["--sdk-self-test-json"], {
		cwd: directory,
		env: {
			...process.env,
			HOME: directory,
			PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
		},
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(
		result.status,
		0,
		`SDK executable self-test failed:\n${result.stderr || result.stdout}`,
	);
	assert.deepEqual(JSON.parse(result.stdout.trim()), {
		sharp: true,
		tesseract: true,
		pdf: true,
		docx: true,
		xlsx: true,
	});
	assert.doesNotMatch(
		result.stderr,
		/Cannot (?:find|load).*module|native binding/i,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}

console.log(
	`Verified SDK executable and runtime assets for ${requestedPlatform}.`,
);
