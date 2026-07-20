import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_PLATFORMS } from "./sdk-platforms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [assetArgument, outputArgument = "sdk-artifacts"] = process.argv.slice(2);
if (!assetArgument) {
	throw new Error(
		"Usage: package-sdk-artifacts <release-asset-directory> [output-directory]",
	);
}
const assets = path.resolve(assetArgument);
const output = path.resolve(outputArgument);
const npmOutput = path.join(output, "npm");
const pythonOutput = path.join(output, "pypi");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(npmOutput, { recursive: true });
fs.mkdirSync(pythonOutput, { recursive: true });

function run(command, arguments_, options = {}) {
	const result = spawnSync(command, arguments_, {
		cwd: root,
		encoding: "utf8",
		stdio: "inherit",
		...options,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${arguments_.join(" ")} failed with ${result.status}.`,
	);
}

const rootPackage = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const typescriptPackage = JSON.parse(
	fs.readFileSync(
		path.join(root, "sdk", "typescript-sdk", "package.json"),
		"utf8",
	),
);
const pythonProject = fs.readFileSync(
	path.join(root, "sdk", "python-sdk", "pyproject.toml"),
	"utf8",
);
const pythonVersion = pythonProject.match(/^version = "([^"]+)"$/m)?.[1];
assert.equal(typescriptPackage.name, "@getcrafty/browser-agent");
assert.equal(typescriptPackage.version, rootPackage.version);
assert.equal(pythonVersion, rootPackage.version);

const platforms = {};
for (const target of SDK_PLATFORMS) {
	const executable = path.join(assets, target.asset);
	assert(
		fs.existsSync(executable),
		`Missing GitHub Release asset: ${target.asset}`,
	);
	fs.chmodSync(executable, 0o755);
	platforms[target.key] = {
		asset: target.asset,
		url: `https://github.com/getcrafty/browser-agent/releases/download/browser-agent-cli-v${rootPackage.version}/${target.asset}`,
		sha256: createHash("sha256")
			.update(fs.readFileSync(executable))
			.digest("hex"),
	};
}
const cliManifest = {
	version: rootPackage.version,
	repository: "getcrafty/browser-agent",
	platforms,
};
const manifestPath = path.join(
	root,
	"sdk",
	"typescript-sdk",
	"cli-manifest.json",
);
fs.writeFileSync(manifestPath, `${JSON.stringify(cliManifest, null, "\t")}\n`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
run(npm, [
	"pack",
	"--pack-destination",
	npmOutput,
	path.join(root, "sdk", "typescript-sdk"),
]);
const npmTarballs = fs
	.readdirSync(npmOutput)
	.filter((name) => name.endsWith(".tgz"));
assert.equal(npmTarballs.length, 1);
run(process.execPath, [
	path.join(root, "scripts", "verify-npm-packages.mjs"),
	path.join(npmOutput, npmTarballs[0]),
	assets,
]);

const uv = process.platform === "win32" ? "uv.exe" : "uv";
for (const target of SDK_PLATFORMS) {
	run(
		uv,
		[
			"build",
			"--wheel",
			"--out-dir",
			pythonOutput,
			path.join(root, "sdk", "python-sdk"),
		],
		{
			env: {
				...process.env,
				BROWSER_AGENT_CLI_ASSET_DIR: assets,
				BROWSER_AGENT_CLI_MANIFEST: manifestPath,
				BROWSER_AGENT_SDK_PLATFORM: target.key,
				BROWSER_AGENT_WHEEL_PLATFORM_TAG: target.wheelTag,
			},
		},
	);
}
const wheels = fs
	.readdirSync(pythonOutput)
	.filter((name) => name.endsWith(".whl"));
assert.equal(wheels.length, SDK_PLATFORMS.length);
const pypiFileSizeLimit = 100 * 1024 * 1024;
for (const wheel of wheels) {
	assert(
		fs.statSync(path.join(pythonOutput, wheel)).size <= pypiFileSizeLimit,
		`${wheel} exceeds PyPI's 100 MiB file-size limit`,
	);
}
for (const target of SDK_PLATFORMS) {
	const wheel = wheels.find((name) =>
		name.endsWith(`-${target.wheelTag}.whl`),
	);
	assert(wheel, `Missing Python wheel for ${target.key}`);
	run(process.platform === "win32" ? "python.exe" : "python3", [
		path.join(root, "scripts", "verify-python-wheel.py"),
		path.join(pythonOutput, wheel),
		target.key,
		path.join(assets, target.asset),
		manifestPath,
	]);
}

console.log(`SDK artifacts built and verified for ${rootPackage.version}.`);
