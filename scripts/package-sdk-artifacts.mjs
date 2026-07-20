import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [requestedPlatform, outputArgument = "sdk-artifacts"] =
	process.argv.slice(2);
const platform = `${process.platform}-${process.arch}`;
if (!requestedPlatform || requestedPlatform !== platform) {
	throw new Error(
		`This host builds ${platform}; requested ${requestedPlatform || "nothing"}.`,
	);
}
const output = path.resolve(outputArgument);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

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

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const wrapperPackage = JSON.parse(
	fs.readFileSync(
		path.join(root, "sdk", "typescript-sdk", "package.json"),
		"utf8",
	),
);
const nativePackage = JSON.parse(
	fs.readFileSync(
		path.join(
			root,
			"sdk",
			"typescript-sdk",
			"platform-packages",
			platform,
			"package.json",
		),
		"utf8",
	),
);
const pythonProject = fs.readFileSync(
	path.join(root, "sdk", "python-sdk", "pyproject.toml"),
	"utf8",
);
const pythonVersion = pythonProject.match(/^version = "([^"]+)"$/m)?.[1];
assert.equal(nativePackage.version, wrapperPackage.version);
assert.equal(pythonVersion, wrapperPackage.version);
assert.equal(
	wrapperPackage.optionalDependencies[nativePackage.name],
	nativePackage.version,
);
run(npm, [
	"pack",
	"--pack-destination",
	output,
	path.join(root, "sdk", "typescript-sdk", "platform-packages", platform),
]);
run(npm, [
	"pack",
	"--pack-destination",
	output,
	path.join(root, "sdk", "typescript-sdk"),
]);
const wrapper = path.join(
	output,
	`crafty-browser-agent-${wrapperPackage.version}.tgz`,
);
const native = path.join(
	output,
	`crafty-browser-agent-${platform}-${nativePackage.version}.tgz`,
);
assert(fs.existsSync(wrapper), `Missing wrapper tarball: ${wrapper}`);
assert(fs.existsSync(native), `Missing native tarball: ${native}`);
run(process.execPath, [
	path.join(root, "scripts", "verify-npm-packages.mjs"),
	wrapper,
	native,
	platform,
]);

const uv = process.platform === "win32" ? "uv.exe" : "uv";
run(uv, [
	"build",
	"--wheel",
	"--out-dir",
	output,
	path.join(root, "sdk", "python-sdk"),
]);
const wheels = fs.readdirSync(output).filter((name) => name.endsWith(".whl"));
assert.equal(
	wheels.length,
	1,
	`Expected one wheel, found: ${wheels.join(", ")}`,
);
const python = process.platform === "win32" ? "python.exe" : "python3";
run(python, [
	path.join(root, "scripts", "verify-python-wheel.py"),
	path.join(output, wheels[0]),
	platform,
]);

console.log(`SDK artifacts built and verified in ${output}.`);
