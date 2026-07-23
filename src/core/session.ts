import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "../browser/types.js";
import type { BrowserSession } from "./session-registry.js";
import type {
	CoreDeps,
	CreateSessionInput,
	CreateSessionResult,
} from "./types.js";
import { DataExtractionCoordinator } from "../agents/executor-utils/data-extraction-coordinator.js";

export class SessionConflictError extends Error {
	readonly port: number;

	constructor(port: number) {
		super(`Browser session already exists for port ${port}.`);
		this.name = "SessionConflictError";
		this.port = port;
	}
}

export class PortInUseError extends Error {
	readonly port: number;

	constructor(port: number) {
		super(`Port ${port} is already in use.`);
		this.name = "PortInUseError";
		this.port = port;
	}
}

export class SessionNotFoundError extends Error {
	readonly port: number;

	constructor(port: number) {
		super(`No active browser session found for port ${port}.`);
		this.name = "SessionNotFoundError";
		this.port = port;
	}
}

function isPortConflictError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const err = error as { code?: unknown; message?: unknown };
	if (err.code === "EADDRINUSE") {
		return true;
	}
	const message = typeof err.message === "string" ? err.message : "";
	return /EADDRINUSE|address already in use|port .* already in use/i.test(
		message,
	);
}

export async function closeAndDeleteSession(
	deps: Pick<CoreDeps, "closeBrowser" | "registry">,
	session: BrowserSession,
): Promise<void> {
	await session.dataExtractionCoordinator?.close();
	await deps.closeBrowser(session.browser);
	if (session.memoryFile && fs.existsSync(session.memoryFile)) {
		fs.unlinkSync(session.memoryFile);
	}
	if (
		session.extractDataMemoryFile &&
		fs.existsSync(session.extractDataMemoryFile)
	) {
		fs.unlinkSync(session.extractDataMemoryFile);
	}
	if (
		session.temporaryStateDir &&
		fs.existsSync(session.temporaryStateDir)
	) {
		fs.rmdirSync(session.temporaryStateDir);
	}
	deps.registry.delete(session.port);
}

function normalizePreparedPasteFiles(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter(
					(entry) =>
						entry.startsWith("./") &&
						!entry.split("/").some((part) => part === ".."),
				)
		: [];
}

/** Creates independent node state around an already-connected scoped browser. */
export function createBorrowedSession(
	input: CreateSessionInput,
	browser: Browser,
): BrowserSession {
	if (input.port !== browser.port) {
		throw new Error(
			`Borrowed browser port ${browser.port} does not match session port ${input.port}.`,
		);
	}
	const stateDir = fs.mkdtempSync(
		path.join(os.tmpdir(), `browser-agent-workflow-${input.port}-`),
	);
	const memoryFile = path.join(stateDir, "memory.txt");
	const extractDataMemoryFile = path.join(stateDir, "extract-data-memory.txt");
	fs.writeFileSync(memoryFile, "", "utf-8");
	fs.writeFileSync(extractDataMemoryFile, "", "utf-8");
	browser.fileWorkspaceRoot = input.fileWorkspaceRoot;
	browser.downloadRootDir = input.downloadRootDir ?? input.downloadDir;

	return {
		port: input.port,
		headless: input.headless,
		browser,
		memoryFile,
		extractDataMemoryFile,
		temporaryStateDir: stateDir,
		dataExtractionCoordinator: new DataExtractionCoordinator(),
		pinnedMemoryContent:
			typeof input.pinnedMemoryContent === "string" &&
			input.pinnedMemoryContent.length > 0
				? input.pinnedMemoryContent
				: undefined,
		preparedPasteFiles: normalizePreparedPasteFiles(input.preparedPasteFiles),
		activePlan: [],
		activeChecklist: [],
		planStatuses: [],
		keepPlanInHistory: false,
		recentExecutions: [],
		lastTask: null,
		pendingMemoryRead: false,
		previousInteractionErrors: [],
		previousToolObservations: [],
		previousStepTabs: null,
		downloadedFileSignatures: null,
		downloadedNewFilePaths: new Set<string>(),
		screenshotToolObservations: [],
		screenshotToolSignalCaptures: [],
		excludedWebsiteToolNames: new Set<string>(),
		activeWebsiteToolGuidance: undefined,
		websiteToolResults: [],
		lastActionSignatureWithUrl: null,
		lastProgressSignature: null,
		sameActionSignatureStreak: 0,
		noProgressStreak: 0,
		incrementalDomContext: {},
	};
}

export function assertAuthenticationBarrierCleared(
	session: BrowserSession,
): void {
	if (
		session.workflowAuthenticationUnresolved ||
		session.authTakeover?.suppressScreenshots ||
		(session.authTakeover?.protectedBids.size ?? 0) > 0
	) {
		throw new Error(
			"Workflow authentication preparation is unresolved or still has protected browser state.",
		);
	}
}

export async function createSession(
	deps: CoreDeps,
	input: CreateSessionInput,
): Promise<CreateSessionResult> {
	const existingSession = deps.registry.get(input.port);
	if (existingSession) {
		if (!input.forceRestart) {
			throw new SessionConflictError(input.port);
		}
		await closeAndDeleteSession(deps, existingSession);
	}

	if (await deps.isPortInUse(input.port)) {
		throw new PortInUseError(input.port);
	}

	let browser;
	try {
		browser = await deps.launchBrowser(
			input.port,
			input.headless,
			input.proxy,
			input.downloadDir,
			input.userDataDir,
			input.windowMode,
			input.executablePath,
		);
	} catch (error) {
		if (isPortConflictError(error)) {
			throw new PortInUseError(input.port);
		}
		throw error;
	}

	if (input.url) {
		await deps.navigateBrowser(browser, input.url);
	}
	browser.fileWorkspaceRoot = input.fileWorkspaceRoot;
	browser.downloadRootDir = input.downloadRootDir ?? input.downloadDir;

	const currentUrl = await deps.getCurrentURL(browser);
	const memoryFile = deps.createSessionMemoryFile(input.port);
	const extractDataMemoryFile = deps.createSessionExtractDataMemoryFile(
		input.port,
	);
	const pinnedMemoryContent =
		typeof input.pinnedMemoryContent === "string" &&
		input.pinnedMemoryContent.length > 0
			? input.pinnedMemoryContent
			: undefined;
	const preparedPasteFiles = Array.isArray(input.preparedPasteFiles)
		? input.preparedPasteFiles
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter(
					(entry) =>
						entry.startsWith("./") &&
						!entry.split("/").some((part) => part === ".."),
				)
		: [];
	const session: BrowserSession = {
		port: input.port,
		headless: input.headless,
		browser,
		memoryFile,
		extractDataMemoryFile,
		dataExtractionCoordinator: new DataExtractionCoordinator(),
		pinnedMemoryContent,
		preparedPasteFiles,
		activePlan: [],
		activeChecklist: [],
		planStatuses: [],
		keepPlanInHistory: false,
		recentExecutions: [],
		lastTask: null,
		pendingMemoryRead: false,
		previousInteractionErrors: [],
		previousToolObservations: [],
		previousStepTabs: null,
		downloadedFileSignatures: null,
		downloadedNewFilePaths: new Set<string>(),
		screenshotToolObservations: [],
		screenshotToolSignalCaptures: [],
		excludedWebsiteToolNames: new Set<string>(),
		activeWebsiteToolGuidance: undefined,
		websiteToolResults: [],
		lastActionSignatureWithUrl: null,
		lastProgressSignature: null,
		sameActionSignatureStreak: 0,
		noProgressStreak: 0,
		incrementalDomContext: {},
	};
	deps.registry.set(session);

	return {
		session,
		currentUrl,
	};
}

export async function closeSession(
	deps: CoreDeps,
	port: number,
): Promise<void> {
	const session = deps.registry.get(port);
	if (!session) {
		throw new SessionNotFoundError(port);
	}
	await closeAndDeleteSession(deps, session);
}

export async function shutdownSessions(
	deps: Pick<CoreDeps, "registry" | "closeBrowser">,
): Promise<void> {
	for (const session of deps.registry.values()) {
		try {
			await closeAndDeleteSession(deps, session);
		} catch (error) {
			console.warn(
				`[server] Failed to close browser on port ${session.port}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
