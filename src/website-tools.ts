import * as fs from "fs";
import { createHash } from "crypto";
import * as path from "path";
import * as vm from "vm";
import { fileURLToPath, pathToFileURL } from "url";
import type { Browser } from "./browser/types.js";
import { shouldLogTimingDuration } from "./timing-logs.js";

export type WebsiteToolInputValue = string | number | boolean;
export type WebsiteToolInputs = Record<string, WebsiteToolInputValue>;

export interface WebsiteToolInputSchemaEntry {
	type: "string" | "number" | "boolean";
	description?: string;
	default?: WebsiteToolInputValue;
}

export interface WebsiteToolMetadata {
	name: string;
	description: string;
	inputSchema: Record<string, WebsiteToolInputSchemaEntry>;
	domains: string[];
	createdAt: string;
	endState?: string;
}

export interface WebsiteToolRunInput {
	browser: Browser;
	inputs: WebsiteToolInputs;
}

export interface WebsiteToolRunResult {
	completed: boolean;
	result?: unknown;
	notes?: string[];
}

export type RunWebsiteTool = (
	input: WebsiteToolRunInput,
) => Promise<WebsiteToolRunResult | void>;

export interface WebsiteToolDescriptor {
	metadata: WebsiteToolMetadata;
	filePath: string;
	format: "legacy" | "bundle";
	scriptPath?: string;
	bundlePath?: string;
	guidance?: WebsiteToolGuidance;
}

export interface WebsiteToolGuidance {
	preScript: string;
	postScript: string;
	recovery: string;
}

export type WebsiteToolGuidanceSection = "post-script" | "recovery";

export interface WebsiteToolActiveGuidance {
	toolName: string;
	section: WebsiteToolGuidanceSection;
	content: string;
	bytes: number;
	hash: string;
}

export interface WebsiteToolExecutionOutcome {
	toolName: string;
	completed: boolean;
	status: "success" | "incomplete" | "error";
	disableTool: boolean;
	result?: unknown;
	notes: string[];
	activeGuidance?: WebsiteToolActiveGuidance;
	descriptor: WebsiteToolDescriptor;
}

export interface WebsiteToolResultContext {
	toolName: string;
	result: unknown;
}

interface WebsiteToolModule {
	tool?: unknown;
	runWebsiteTool?: unknown;
}

const TOOL_METADATA_PATTERN =
	/export const tool = (\{[\s\S]*?\}) satisfies WebsiteToolMetadata;/;
const PRE_GUIDANCE_LIMIT_BYTES = 4 * 1024;
const ACTIVE_GUIDANCE_LIMIT_BYTES = 16 * 1024;
const WEBSITE_TOOL_RESULT_LIMIT_BYTES = 64 * 1024;
const PROMPT_PRE_GUIDANCE_BUDGET_BYTES = 16 * 1024;
const GUIDE_HEADINGS = [
	"## Pre-script guidance",
	"## Post-script guidance",
	"## Recovery guidance",
] as const;

export function defaultGeneratedToolsDir(): string {
	return path.join(agentRoot(), "generated-tools");
}

export function loadWebsiteToolDescriptors(params: {
	enabled: boolean;
	generatedToolsDir?: string;
	excludedNames?: Iterable<string>;
	currentUrl?: string;
	warn?: (message: string) => void;
}): WebsiteToolDescriptor[] {
	if (!params.enabled) return [];
	const loadStartedAt = nowMs();
	const generatedToolsDir =
		params.generatedToolsDir ?? defaultGeneratedToolsDir();
	const excluded = new Set(params.excludedNames ?? []);
	const currentHostname = hostnameFromUrl(params.currentUrl);
	if (!fs.existsSync(generatedToolsDir)) {
		const totalMs = elapsedMs(loadStartedAt);
		logWebsiteToolTiming(
			totalMs,
			`load_descriptors total_ms=${totalMs} dir_exists=false dir=${JSON.stringify(generatedToolsDir)}`,
		);
		return [];
	}
	const descriptors: WebsiteToolDescriptor[] = [];
	const readDirStartedAt = nowMs();
	const files = fs.readdirSync(generatedToolsDir).sort();
	const readDirMs = elapsedMs(readDirStartedAt);
	let sourceReadMs = 0;
	let candidateCount = 0;
	let invalidCount = 0;
	let excludedCount = 0;
	let domainFilteredCount = 0;
	for (const file of files) {
		const filePath = path.join(generatedToolsDir, file);
		const isLegacy = file.endsWith(".ts");
		let isBundle = false;
		try {
			const entryStat = fs.lstatSync(filePath);
			if (entryStat.isSymbolicLink()) {
				throw new Error("symbolic links are not allowed");
			}
			isBundle = entryStat.isDirectory();
		} catch (error) {
			invalidCount += 1;
			params.warn?.(
				`[website_tool] ignored ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (!isLegacy && !isBundle) continue;
		candidateCount += 1;
		try {
			const readStartedAt = nowMs();
			const descriptor = isLegacy
				? loadLegacyDescriptor(filePath)
				: loadBundleDescriptor(filePath, file);
			sourceReadMs += elapsedMs(readStartedAt);
			if (excluded.has(descriptor.metadata.name)) {
				excludedCount += 1;
				continue;
			}
			if (
				currentHostname &&
				!descriptor.metadata.domains.some((domain) =>
					domainMatchesHostname(domain, currentHostname),
				)
			) {
				domainFilteredCount += 1;
				continue;
			}
			descriptors.push(descriptor);
		} catch (error) {
			invalidCount += 1;
			params.warn?.(
				`[website_tool] ignored ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const totalMs = elapsedMs(loadStartedAt);
	logWebsiteToolTiming(
		totalMs,
		`load_descriptors total_ms=${totalMs} read_dir_ms=${readDirMs} source_read_ms=${roundMs(sourceReadMs)} files=${files.length} candidates=${candidateCount} loaded=${descriptors.length} excluded=${excludedCount} domain_filtered=${domainFilteredCount} invalid=${invalidCount} current_domain=${JSON.stringify(currentHostname ?? "")}`,
	);
	return descriptors;
}

function loadLegacyDescriptor(filePath: string): WebsiteToolDescriptor {
	assertRegularFile(filePath);
	const source = fs.readFileSync(filePath, "utf-8");
	return {
		metadata: parseWebsiteToolMetadata(source),
		filePath,
		format: "legacy",
		scriptPath: filePath,
	};
}

function loadBundleDescriptor(
	bundlePath: string,
	directoryName: string,
): WebsiteToolDescriptor {
	const manifestPath = path.join(bundlePath, "tool.json");
	assertRegularFile(manifestPath);
	const metadata = validateWebsiteToolMetadata(
		JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown,
	);
	if (metadata.name !== directoryName) {
		throw new Error(
			`tool name "${metadata.name}" must match directory "${directoryName}"`,
		);
	}
	const scriptPath = optionalRegularFile(path.join(bundlePath, "index.ts"));
	const guidancePath = optionalRegularFile(
		path.join(bundlePath, "AGENTS.md"),
	);
	if (!scriptPath && !guidancePath) {
		throw new Error("bundle must contain index.ts or AGENTS.md");
	}
	const guidance = guidancePath
		? parseWebsiteToolGuidance(fs.readFileSync(guidancePath, "utf-8"))
		: undefined;
	return {
		metadata,
		filePath: scriptPath ?? manifestPath,
		format: "bundle",
		...(scriptPath ? { scriptPath } : {}),
		bundlePath,
		...(guidance ? { guidance } : {}),
	};
}

function optionalRegularFile(filePath: string): string | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	assertRegularFile(filePath);
	return filePath;
}

function assertRegularFile(filePath: string): void {
	const stat = fs.lstatSync(filePath);
	if (stat.isSymbolicLink()) {
		throw new Error(
			`${path.basename(filePath)} may not be a symbolic link`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`${path.basename(filePath)} must be a regular file`);
	}
}

export function parseWebsiteToolGuidance(source: string): WebsiteToolGuidance {
	if (/^\s*(?:!include|@include)\b/im.test(source)) {
		throw new Error("remote includes are not allowed in AGENTS.md");
	}
	const headings = [...source.matchAll(/^#{1,2}\s+.*$/gm)].map((match) =>
		match[0].trim(),
	);
	if (
		headings.length !== GUIDE_HEADINGS.length ||
		!headings.every((heading, index) => heading === GUIDE_HEADINGS[index])
	) {
		throw new Error(
			`AGENTS.md must contain only the ordered headings: ${GUIDE_HEADINGS.join(", ")}`,
		);
	}
	const offsets = GUIDE_HEADINGS.map((heading) => source.indexOf(heading));
	if (source.slice(0, offsets[0]).trim()) {
		throw new Error(
			"AGENTS.md may not contain content before its first heading",
		);
	}
	const section = (index: number): string => {
		const start = offsets[index] + GUIDE_HEADINGS[index].length;
		const end = offsets[index + 1] ?? source.length;
		return source.slice(start, end).trim();
	};
	const guidance = {
		preScript: section(0),
		postScript: section(1),
		recovery: section(2),
	};
	assertByteLimit(
		guidance.preScript,
		PRE_GUIDANCE_LIMIT_BYTES,
		"Pre-script guidance",
	);
	assertByteLimit(
		guidance.postScript,
		ACTIVE_GUIDANCE_LIMIT_BYTES,
		"Post-script guidance",
	);
	assertByteLimit(
		guidance.recovery,
		ACTIVE_GUIDANCE_LIMIT_BYTES,
		"Recovery guidance",
	);
	return guidance;
}

function assertByteLimit(content: string, limit: number, label: string): void {
	const bytes = Buffer.byteLength(content, "utf-8");
	if (bytes > limit) {
		throw new Error(`${label} exceeds ${limit} byte limit`);
	}
}

export function formatWebsiteToolsForPrompt(
	descriptors: WebsiteToolDescriptor[],
): string {
	const startedAt = nowMs();
	if (descriptors.length === 0) return "";
	const lines = [
		"website_tool:",
		"  - Use for recurring tasks on supported websites when the current task matches a listed generated tool.",
		"  - Provide the exact tool name and every declared input. Every argument is mandatory in the tool call, even when its schema has a default.",
		"  - Defaults are runtime fallbacks only. Never omit an argument because a default exists, and do not invent input keys.",
		"  - If a website_tool reports an interaction error, do not call that same tool again in this trajectory.",
		"  - A successful structured result appears in websiteToolResults on the next step. If it fully answers the task, return it directly without repeating page extraction.",
		"  - Available generated tools:",
	];
	let preGuidanceBytes = 0;
	let includedCount = 0;
	for (const descriptor of descriptors) {
		const preGuidance = descriptor.guidance?.preScript ?? "";
		const bytes = Buffer.byteLength(preGuidance, "utf-8");
		if (preGuidanceBytes + bytes > PROMPT_PRE_GUIDANCE_BUDGET_BYTES) {
			continue;
		}
		preGuidanceBytes += bytes;
		includedCount += 1;
		const inputs = Object.entries(descriptor.metadata.inputSchema).map(
			([name, schema]) =>
				`${name}: ${schema.type}${schema.description ? ` (${schema.description})` : ""}`,
		);
		lines.push(
			`    - name: ${descriptor.metadata.name}`,
			`      description: ${descriptor.metadata.description}`,
			`      domains: ${descriptor.metadata.domains.join(", ") || "unspecified"}`,
			...(descriptor.metadata.endState
				? [
						`      endState: ${descriptor.metadata.endState} (tool stops here; use websiteToolResults when present, otherwise inspect the page before continuing)`,
					]
				: []),
			`      inputs: ${inputs.join("; ") || "none"}`,
			...(preGuidance
				? [
						"      pre-script guidance:",
						...preGuidance
							.split("\n")
							.map((line) => `        ${line}`),
					]
				: []),
		);
	}
	if (includedCount === 0) return "";
	const formatted = lines.join("\n");
	const totalMs = elapsedMs(startedAt);
	logWebsiteToolTiming(
		totalMs,
		`format_prompt total_ms=${totalMs} descriptors=${descriptors.length} included=${includedCount} pre_guidance_bytes=${preGuidanceBytes} chars=${formatted.length}`,
	);
	return formatted;
}

export async function runGeneratedWebsiteTool(params: {
	name: string;
	inputs: WebsiteToolInputs;
	browser: Browser;
	generatedToolsDir?: string;
	excludedNames?: Set<string>;
	currentUrl?: string;
}): Promise<WebsiteToolExecutionOutcome> {
	const startedAt = nowMs();
	if (params.excludedNames?.has(params.name)) {
		throw new Error(
			`website tool "${params.name}" is disabled for this run`,
		);
	}
	let loadMs = 0;
	let validateMs = 0;
	let importMs = 0;
	let runMs = 0;
	let phase = "load";
	let runStartedAt = 0;
	try {
		const loadStartedAt = nowMs();
		const descriptor = loadWebsiteToolDescriptors({
			enabled: true,
			generatedToolsDir: params.generatedToolsDir,
			excludedNames: params.excludedNames,
			currentUrl: params.currentUrl,
		}).find((candidate) => candidate.metadata.name === params.name);
		loadMs = elapsedMs(loadStartedAt);
		if (!descriptor) {
			throw new Error(
				params.currentUrl
					? `website tool "${params.name}" was not found for current domain`
					: `website tool "${params.name}" was not found`,
			);
		}
		phase = "validate";
		const validateStartedAt = nowMs();
		const inputs = validateInputs(descriptor.metadata, params.inputs);
		validateMs = elapsedMs(validateStartedAt);
		if (!descriptor.scriptPath) {
			return executionOutcome(descriptor, {
				completed: true,
				status: "success",
				disableTool: false,
				notes: [],
			});
		}
		phase = "import";
		const importStartedAt = nowMs();
		let module: WebsiteToolModule;
		try {
			module = (await import(
				`${pathToFileURL(descriptor.scriptPath).href}?t=${Date.now()}`
			)) as WebsiteToolModule;
		} catch (error) {
			return executionOutcome(descriptor, {
				completed: false,
				status: "error",
				disableTool: true,
				notes: [error instanceof Error ? error.message : String(error)],
			});
		}
		importMs = elapsedMs(importStartedAt);
		if (typeof module.runWebsiteTool !== "function") {
			return executionOutcome(descriptor, {
				completed: false,
				status: "error",
				disableTool: true,
				notes: [
					`website tool "${params.name}" does not export runWebsiteTool`,
				],
			});
		}
		phase = "run";
		runStartedAt = nowMs();
		try {
			const result = await (module.runWebsiteTool as RunWebsiteTool)({
				browser: params.browser,
				inputs,
			});
			const completed =
				descriptor.format === "bundle"
					? result?.completed === true
					: result?.completed !== false;
			const resultSnapshot =
				result && "result" in result
					? snapshotWebsiteToolResult(result.result)
					: undefined;
			return executionOutcome(descriptor, {
				completed,
				status: completed ? "success" : "incomplete",
				disableTool: !completed,
				...(resultSnapshot !== undefined
					? { result: resultSnapshot }
					: {}),
				notes: normalizeNotes(result?.notes),
			});
		} catch (error) {
			return executionOutcome(descriptor, {
				completed: false,
				status: "error",
				disableTool: true,
				notes: [error instanceof Error ? error.message : String(error)],
			});
		}
	} finally {
		if (runStartedAt > 0) runMs = elapsedMs(runStartedAt);
		const totalMs = elapsedMs(startedAt);
		logWebsiteToolTiming(
			totalMs,
			`execute name=${JSON.stringify(params.name)} phase=${phase} total_ms=${totalMs} load_ms=${loadMs} validate_ms=${validateMs} import_ms=${importMs} run_ms=${roundMs(runMs)}`,
		);
	}
}

function snapshotWebsiteToolResult(result: unknown): unknown {
	if (result === undefined) return undefined;
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(result);
	} catch (error) {
		throw new Error(
			`website tool result must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) {
		throw new Error("website tool result must be JSON-serializable");
	}
	assertByteLimit(
		serialized,
		WEBSITE_TOOL_RESULT_LIMIT_BYTES,
		"Website tool result",
	);
	return JSON.parse(serialized) as unknown;
}

function executionOutcome(
	descriptor: WebsiteToolDescriptor,
	outcome: Omit<
		WebsiteToolExecutionOutcome,
		"toolName" | "descriptor" | "activeGuidance"
	>,
): WebsiteToolExecutionOutcome {
	const section: WebsiteToolGuidanceSection = outcome.completed
		? "post-script"
		: "recovery";
	const content = outcome.completed
		? descriptor.guidance?.postScript
		: descriptor.guidance?.recovery;
	return {
		toolName: descriptor.metadata.name,
		...outcome,
		descriptor: snapshotDescriptor(descriptor),
		...(content !== undefined
			? {
					activeGuidance: snapshotGuidance(
						descriptor.metadata.name,
						section,
						content,
					),
				}
			: {}),
	};
}

function snapshotDescriptor(
	descriptor: WebsiteToolDescriptor,
): WebsiteToolDescriptor {
	return {
		...descriptor,
		metadata: {
			...descriptor.metadata,
			domains: [...descriptor.metadata.domains],
			inputSchema: Object.fromEntries(
				Object.entries(descriptor.metadata.inputSchema).map(
					([name, value]) => [name, { ...value }],
				),
			),
		},
		...(descriptor.guidance
			? { guidance: { ...descriptor.guidance } }
			: {}),
	};
}

export function snapshotGuidance(
	toolName: string,
	section: WebsiteToolGuidanceSection,
	content: string,
): WebsiteToolActiveGuidance {
	return {
		toolName,
		section,
		content,
		bytes: Buffer.byteLength(content, "utf-8"),
		hash: createHash("sha256").update(content, "utf-8").digest("hex"),
	};
}

function normalizeNotes(notes: unknown): string[] {
	if (!Array.isArray(notes)) return [];
	return notes
		.filter((note): note is string => typeof note === "string")
		.map((note) => note.trim())
		.filter(Boolean);
}

function parseWebsiteToolMetadata(source: string): WebsiteToolMetadata {
	const match = source.match(TOOL_METADATA_PATTERN);
	if (!match) {
		throw new Error(
			"missing parseable `export const tool = ... satisfies WebsiteToolMetadata` metadata",
		);
	}
	return validateWebsiteToolMetadata(parseMetadataLiteral(match[1]));
}

function parseMetadataLiteral(literal: string): unknown {
	try {
		return JSON.parse(literal);
	} catch {
		// Generated tools are trusted local TypeScript files. Metadata is often
		// emitted as a TS object literal with unquoted keys, so strict JSON is
		// only a fast path.
		return new vm.Script(`(${literal})`).runInNewContext(
			Object.create(null),
			{ timeout: 100 },
		);
	}
}

function validateWebsiteToolMetadata(value: unknown): WebsiteToolMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("tool metadata must be an object");
	}
	const record = value as Record<string, unknown>;
	const name = stringField(record.name, "name");
	const description = stringField(record.description, "description");
	const createdAt = stringField(record.createdAt, "createdAt");
	const endState =
		typeof record.endState === "string" && record.endState.trim()
			? record.endState.trim()
			: undefined;
	if (!/^[a-z][a-z0-9_]*$/.test(name)) {
		throw new Error(`invalid tool name "${name}"`);
	}
	const domains = Array.isArray(record.domains)
		? record.domains.filter(
				(domain): domain is string =>
					typeof domain === "string" && domain.trim() !== "",
			)
		: [];
	const inputSchema = parseInputSchema(record.inputSchema);
	return {
		name,
		description,
		inputSchema,
		domains,
		createdAt,
		...(endState ? { endState } : {}),
	};
}

function parseInputSchema(
	value: unknown,
): Record<string, WebsiteToolInputSchemaEntry> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const schema: Record<string, WebsiteToolInputSchemaEntry> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!/^[a-z][a-z0-9_]*$/.test(name)) continue;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const record = raw as Record<string, unknown>;
		if (
			record.type !== "string" &&
			record.type !== "number" &&
			record.type !== "boolean"
		) {
			continue;
		}
		schema[name] = {
			type: record.type,
			...(typeof record.description === "string" &&
			record.description.trim()
				? { description: record.description.trim() }
				: {}),
			...(isWebsiteToolInputValue(record.default)
				? { default: record.default }
				: {}),
		};
	}
	return schema;
}

function validateInputs(
	metadata: WebsiteToolMetadata,
	inputs: WebsiteToolInputs,
): WebsiteToolInputs {
	const materializedInputs: WebsiteToolInputs = { ...inputs };
	for (const [name, schema] of Object.entries(metadata.inputSchema)) {
		const value = inputs[name] ?? schema.default;
		if (value === undefined) {
			throw new Error(
				`website tool "${metadata.name}" missing input "${name}"`,
			);
		}
		if (typeof value !== schema.type) {
			throw new Error(
				`website tool "${metadata.name}" input "${name}" must be ${schema.type}`,
			);
		}
		materializedInputs[name] = value;
	}
	return materializedInputs;
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`tool metadata missing ${field}`);
	}
	return value.trim();
}

function isWebsiteToolInputValue(
	value: unknown,
): value is WebsiteToolInputValue {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function hostnameFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function domainMatchesHostname(domain: string, hostname: string): boolean {
	const normalized = normalizeDomain(domain);
	if (!normalized) return false;
	return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function normalizeDomain(domain: string): string {
	const trimmed = domain.trim().toLowerCase();
	if (!trimmed) return "";
	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
			.hostname;
	} catch {
		return trimmed.replace(/^www\./, "");
	}
}

function agentRoot(): string {
	let current = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		if (fs.existsSync(path.join(current, "package.json"))) return current;
		current = path.dirname(current);
	}
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function nowMs(): number {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function elapsedMs(startedAt: number): number {
	return roundMs(nowMs() - startedAt);
}

function roundMs(value: number): number {
	return Math.round(value * 100) / 100;
}

function logWebsiteToolTiming(durationMs: number, message: string): void {
	if (!shouldLogTimingDuration(durationMs)) {
		return;
	}
	console.log(`[website_tool timing] ${message}`);
}
