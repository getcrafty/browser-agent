import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operatingSystem = { darwin: "darwin", linux: "linux", win32: "win32" }[
	process.platform
];
const architecture = { arm64: "arm64", x64: "x64" }[process.arch];
if (!operatingSystem || !architecture) {
	throw new Error(
		`Unsupported build host: ${process.platform}-${process.arch}`,
	);
}
const platform = `${operatingSystem}-${architecture}`;
const suffix = process.platform === "win32" ? ".exe" : "";
const temporary = path.join(root, ".sdk-build", `browser-agent${suffix}`);
const targets = [
	path.join(
		root,
		"sdk",
		"typescript-sdk",
		"platform-packages",
		platform,
		"bin",
		`browser-agent${suffix}`,
	),
	path.join(
		root,
		"sdk",
		"python-sdk",
		"src",
		"browser_agent",
		"bin",
		platform,
		`browser-agent${suffix}`,
	),
];

await rm(path.dirname(temporary), { recursive: true, force: true });
await mkdir(path.dirname(temporary), { recursive: true });
const bunExecutable = path.join(root, "node_modules", "bun", "bin", "bun.exe");
const result = spawnSync(
	bunExecutable,
	[
		path.join(root, "scripts", "compile-standalone.ts"),
		path.join(root, "src", "standalone-cli.ts"),
		temporary,
		platform,
	],
	{ cwd: root, encoding: "utf8", stdio: "inherit" },
);
if (result.error) {
	throw new Error(`Unable to start Bun: ${result.error.message}`, {
		cause: result.error,
	});
}
if (result.status !== 0) {
	throw new Error(
		`Standalone browser-agent build failed with status ${result.status}.`,
	);
}
for (const target of targets) {
	await mkdir(path.dirname(target), { recursive: true });
	await cp(temporary, target);
}
await rm(path.dirname(temporary), { recursive: true, force: true });
console.log(`Built browser-agent for ${platform} and copied it to both SDKs.`);
