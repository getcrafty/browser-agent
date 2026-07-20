import path from "node:path";
import fs from "node:fs";

const [entrypoint, outfile, platform] = process.argv.slice(2);
if (!entrypoint || !outfile || !platform) {
	throw new Error(
		"Usage: compile-standalone <entrypoint> <outfile> <platform>",
	);
}
const root = path.resolve(import.meta.dirname, "..");
const canvasPlatform = platform.startsWith("linux-")
	? `${platform}-gnu`
	: platform;
const canvasEntrypoint = Bun.resolveSync("@napi-rs/canvas", root);
const canvasNativePackage = path.join(
	root,
	"node_modules",
	"@napi-rs",
	`canvas-${canvasPlatform}`,
);
const canvasNative = fs
	.readdirSync(canvasNativePackage)
	.map((name) => path.join(canvasNativePackage, name))
	.find((filename) => filename.endsWith(".node"));
if (!canvasNative) {
	throw new Error(`Unable to locate canvas binding for ${platform}.`);
}
const canvasBase64 = fs.readFileSync(canvasNative).toString("base64");
const languageBase64 = fs
	.readFileSync(
		path.join(
			root,
			"node_modules",
			"@tesseract.js-data",
			"eng",
			"4.0.0",
			"eng.traineddata.gz",
		),
	)
	.toString("base64");
const wrapper = path.join(path.dirname(outfile), "standalone-entry.ts");
fs.writeFileSync(
	wrapper,
	`
if (!process.argv.includes("--version-json")) {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-canvas-"));
	const addon = path.join(directory, ${JSON.stringify(path.basename(canvasNative))});
	fs.writeFileSync(addon, Buffer.from(${JSON.stringify(canvasBase64)}, "base64"));
	process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
	const canvas = require(addon);
	const { DOMMatrix, DOMPoint, DOMRect } = require(${JSON.stringify(
		path.join(root, "node_modules", "@napi-rs", "canvas", "geometry.js"),
	)});
	const canvasModule = {
		...canvas,
		DOMMatrix,
		DOMPoint,
		DOMRect,
		Path2D: canvas.Path,
		createCanvas: (width, height) => new canvas.CanvasElement(width, height),
	};
	Object.assign(globalThis, {
		DOMMatrix,
		ImageData: canvas.ImageData,
		Path2D: canvas.Path,
		__browserAgentCanvasModule: canvasModule,
	});
	const { WorkerMessageHandler } = await import(${JSON.stringify(
		path.join(
			root,
			"node_modules",
			"pdfjs-dist",
			"legacy",
			"build",
			"pdf.worker.mjs",
		),
	)});
	globalThis.pdfjsWorker = { WorkerMessageHandler };
	const langPath = path.join(directory, "tesseract");
	fs.mkdirSync(langPath);
	fs.writeFileSync(
		path.join(langPath, "eng.traineddata.gz"),
		Buffer.from(${JSON.stringify(languageBase64)}, "base64"),
	);
	globalThis.__browserAgentTesseractOptions = {
		cachePath: langPath,
		gzip: true,
		workerPath:
			"/$bunfs/root/node_modules/tesseract.js/src/worker-script/node/index.js",
		langPath,
	};
	process.once("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
}
await import(${JSON.stringify(entrypoint)});
`,
);
const addon = Bun.resolveSync(`@img/sharp-${platform}/sharp.node`, root);
const vipsModule = Bun.resolveSync(`@img/sharp-libvips-${platform}/lib`, root);
const vips = fs
	.readdirSync(path.dirname(vipsModule))
	.map((name) => path.join(path.dirname(vipsModule), name))
	.find((filename) => /libvips-cpp/.test(filename));
if (!vips) throw new Error(`Unable to locate libvips for ${platform}.`);
const addonBase64 = fs.readFileSync(addon).toString("base64");
const vipsBase64 = fs.readFileSync(vips).toString("base64");
const embeddedSharp = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-sharp-"));
const addonDirectory = path.join(root, "node_modules/@img/sharp-${platform}/lib");
const vipsDirectory = path.join(root, "node_modules/@img/sharp-libvips-${platform}/lib");
fs.mkdirSync(addonDirectory, { recursive: true });
fs.mkdirSync(vipsDirectory, { recursive: true });
const addon = path.join(addonDirectory, ${JSON.stringify(path.basename(addon))});
fs.writeFileSync(addon, Buffer.from(${JSON.stringify(addonBase64)}, "base64"));
fs.writeFileSync(
	path.join(vipsDirectory, ${JSON.stringify(path.basename(vips))}),
	Buffer.from(${JSON.stringify(vipsBase64)}, "base64"),
);
process.once("exit", () => fs.rmSync(root, { recursive: true, force: true }));
module.exports = require(addon);
`;

const result = await Bun.build({
	entrypoints: [
		wrapper,
		canvasEntrypoint,
		path.join(
			root,
			"node_modules",
			"tesseract.js",
			"src",
			"worker-script",
			"node",
			"index.js",
		),
	],
	compile: { outfile },
	minify: true,
	plugins: [
		{
			name: "use-embedded-canvas",
			setup(build) {
				build.onLoad(
					{ filter: /pdfjs-dist\/legacy\/build\/pdf\.mjs$/ },
					async ({ path: filename }) => {
						let source = await Bun.file(filename).text();
						const setupStart = source.indexOf(
							"  let canvas;\n  try {",
						);
						const setupEnd = source.indexOf(
							"  if (!globalThis.DOMMatrix) {",
							setupStart,
						);
						if (setupStart < 0 || setupEnd < 0) {
							throw new Error(
								"Unable to patch pdfjs embedded canvas setup.",
							);
						}
						source = `${source.slice(0, setupStart)}  const canvas = globalThis.__browserAgentCanvasModule;\n${source.slice(setupEnd)}`;
						const factoryRequire =
							'    const require = process.getBuiltinModule("module").createRequire(import.meta.url);\n    const canvas = require("@napi-rs/canvas");';
						if (!source.includes(factoryRequire)) {
							throw new Error(
								"Unable to patch pdfjs canvas factory.",
							);
						}
						source = source.replace(
							factoryRequire,
							"    const canvas = globalThis.__browserAgentCanvasModule;",
						);
						return { contents: source, loader: "js" };
					},
				);
			},
		},
		{
			name: "embed-sharp-addon",
			setup(build) {
				build.onLoad({ filter: /sharp\/lib\/sharp\.js$/ }, () => ({
					contents: embeddedSharp,
					loader: "js",
				}));
			},
		},
	],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
