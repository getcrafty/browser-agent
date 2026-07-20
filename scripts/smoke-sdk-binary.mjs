import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = `${process.platform}-${process.arch}`;
const suffix = process.platform === "win32" ? ".exe" : "";
const executable = process.argv[2]
	? path.resolve(process.argv[2])
	: path.join(
			root,
			"sdk",
			"typescript-sdk",
			"platform-packages",
			platform,
			"bin",
			`browser-agent${suffix}`,
		);
const isolatedDirectory = fs.mkdtempSync(
	path.join(os.tmpdir(), "browser-agent-standalone-smoke-"),
);
const environment = {
	HOME: isolatedDirectory,
	PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
	OPENAI_API_KEY: "smoke-test",
};

function run(arguments_, input) {
	const result = spawnSync(executable, arguments_, {
		cwd: isolatedDirectory,
		env: environment,
		encoding: "utf8",
		input,
	});
	assert.equal(result.error, undefined);
	return result;
}

const before = new Set(
	fs
		.readdirSync(os.tmpdir())
		.filter((name) => name.startsWith("browser-agent-sharp-")),
);
const version = run(["--version-json"]);
assert.equal(version.status, 0);
assert.deepEqual(JSON.parse(version.stdout), {
	version: "1.0.0",
	rpcProtocolVersion: 1,
});
const after = fs
	.readdirSync(os.tmpdir())
	.filter((name) => name.startsWith("browser-agent-sharp-"));
assert(after.every((name) => before.has(name)));

const selfTest = run(["--sdk-self-test-json"]);
assert.equal(selfTest.status, 0, selfTest.stderr);
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

const request = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "crafty/run",
	params: {},
})}\n`;
const rpc = run(
	[
		path.join(root, "sdk/sdk-test-fixtures/smoke-preflight-config.json"),
		"--rpc",
	],
	request,
);
const response = JSON.parse(rpc.stdout.trim());
assert.equal(response.error.data.code, "CHROME_NOT_FOUND");

const credentialRequest = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 2,
	method: "crafty/run",
	params: {
		tasks: [
			{
				credentials: [
					{
						username: "",
						password: "standalone-secret",
						domain: "https://example.com",
					},
				],
			},
		],
	},
})}\n`;
const credentialRpc = run(
	[
		path.join(root, "sdk/sdk-test-fixtures/smoke-preflight-config.json"),
		"--rpc",
	],
	credentialRequest,
);
const credentialResponse = JSON.parse(credentialRpc.stdout.trim());
assert.equal(credentialResponse.error.data.code, "CONFIG_INVALID");
assert(!credentialRpc.stdout.includes("standalone-secret"));
assert(!credentialRpc.stderr.includes("standalone-secret"));
fs.rmSync(isolatedDirectory, { recursive: true, force: true });
console.log(`Standalone SDK binary smoke tests passed for ${platform}.`);
