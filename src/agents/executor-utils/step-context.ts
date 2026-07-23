import * as fs from "fs";
import * as path from "path";
import { encoding_for_model } from "tiktoken";
import type { Browser, Tab } from "../../browser/types.js";
import { captureScreenshotWithBidBorders } from "../../browser/index.js";
import {
  isPathInsideOrEqual,
  toLogicalDownloadPath,
} from "../../file-workspace.js";

const PROMPT_TOKEN_ESTIMATE_MODEL = "gpt-5";
const PRE_STEP_SCREENSHOT_JPEG_QUALITY = 100;
let promptTokenEncoding: ReturnType<typeof encoding_for_model> | null = null;

function buildDownloadFileSignature(stats: fs.Stats): string {
  return `${stats.size}:${stats.mtimeMs}`;
}

function isInvisibleName(name: string): boolean {
  return name.startsWith(".");
}

function toRelativeWorkspacePath(
  rootDir: string,
  filePath: string,
): string | null {
  const relativePath = path.relative(rootDir, filePath);
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  const normalized = relativePath.split(path.sep).join("/");
  return normalized ? `./${normalized}` : null;
}

function isDownloadInProgressFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".crdownload");
}

function collectDownloadFileEntries(
  downloadDir: string,
  excludedRoot?: string,
): Array<{ filePath: string; isDownloading: boolean }> {
  const discovered = new Map<string, boolean>();
  const stack = [downloadDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isInvisibleName(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (excludedRoot && isPathInsideOrEqual(excludedRoot, fullPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      discovered.set(fullPath, isDownloadInProgressFile(entry.name));
    }
  }

  return [...discovered.entries()]
    .map(([filePath, isDownloading]) => ({ filePath, isDownloading }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export function buildDownloadedFilesPayload(params: {
  downloadDir?: string;
  fileWorkspaceRoot?: string;
  downloadRootDir?: string;
  previousFileSignatures: Map<string, string> | null;
  previousNewFilePaths: Set<string> | null;
}): {
  downloadedFiles: string[];
  fileSignatures: Map<string, string>;
  newFilePaths: Set<string>;
} {
  const previousSignatures = params.previousFileSignatures;
  const previousNewFilePaths = params.previousNewFilePaths ?? new Set<string>();
  const nextNewFilePaths = new Set(previousNewFilePaths);
  const nextSignatures = new Map<string, string>();
  if (!params.downloadDir) {
    return {
      downloadedFiles: [],
      fileSignatures: nextSignatures,
      newFilePaths: nextNewFilePaths,
    };
  }

  const fileEntries = collectDownloadFileEntries(params.downloadDir);
  const downloadedFiles: string[] = [];

  for (const { filePath, isDownloading } of fileEntries) {
    const relativeFilePath = toLogicalDownloadPath({
      filePath,
      roots: {
        downloadDir: params.downloadDir,
        downloadRootDir: params.downloadRootDir,
        fileWorkspaceRoot: params.fileWorkspaceRoot,
      },
    });
    if (!relativeFilePath) {
      continue;
    }
    if (isDownloading) {
      downloadedFiles.push(`[DOWNLOADING] ${relativeFilePath}`);
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    const signature = buildDownloadFileSignature(stats);
    nextSignatures.set(filePath, signature);
    const isNewThisStep =
      previousSignatures !== null &&
      previousSignatures.get(filePath) !== signature;
    if (isNewThisStep) {
      nextNewFilePaths.add(filePath);
    }
    const wasMarkedNewEarlier = nextNewFilePaths.has(filePath);
    downloadedFiles.push(
      wasMarkedNewEarlier ? `[NEW] ${relativeFilePath}` : relativeFilePath,
    );
  }

  return {
    downloadedFiles,
    fileSignatures: nextSignatures,
    newFilePaths: nextNewFilePaths,
  };
}

export function buildWorkspaceFilesPayload(params: {
  fileWorkspaceRoot?: string;
  downloadRootDir?: string;
}): string[] {
  if (!params.fileWorkspaceRoot) {
    return [];
  }
  const excludedDownloadRoot =
    params.downloadRootDir &&
    isPathInsideOrEqual(params.fileWorkspaceRoot, params.downloadRootDir)
      ? params.downloadRootDir
      : undefined;
  const fileEntries = collectDownloadFileEntries(
    params.fileWorkspaceRoot,
    excludedDownloadRoot,
  );
  return fileEntries
    .filter(({ isDownloading }) => !isDownloading)
    .map(({ filePath }) =>
      toRelativeWorkspacePath(params.fileWorkspaceRoot as string, filePath),
    )
    .filter((filePath): filePath is string => Boolean(filePath));
}

export function estimateTokenCount(text: string): number {
  try {
    if (!promptTokenEncoding) {
      promptTokenEncoding = encoding_for_model(PROMPT_TOKEN_ESTIMATE_MODEL);
    }
    return promptTokenEncoding.encode(text).length;
  } catch {
    // Fallback heuristic if tokenizer init fails in a given runtime.
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

export function formatTabTitle(tab: Pick<Tab, "title">): string {
  const title = typeof tab.title === "string" ? tab.title.trim() : "";
  return title || "(untitled)";
}

export function getNewlyOpenedTabs(
  previousTabs: Tab[] | null,
  currentTabs: Tab[],
): Tab[] {
  if (!previousTabs) return [];
  const previousTargetIds = new Set(previousTabs.map((tab) => tab.targetId));
  return currentTabs.filter((tab) => !previousTargetIds.has(tab.targetId));
}

export async function resolveCurrentTabIndex(params: {
  b: Browser;
  openTabs: Tab[];
  currentUrl: string;
}): Promise<number> {
  if (params.openTabs.length === 0) return 0;

  // A scoped browser tracks its active target explicitly. Prefer it over
  // Target.getTargets(), whose attached flag also includes sibling agents on
  // the shared CDP instance.
  if (params.b.currentTargetId) {
    const scopedIndex = params.openTabs.findIndex(
      (tab) => tab.targetId === params.b.currentTargetId,
    );
    if (scopedIndex >= 0) return scopedIndex;
  }

  try {
    const targetResponse = (await params.b.Target.getTargets()) as {
      targetInfos?: Array<{
        type?: string;
        targetId?: string;
        attached?: boolean;
      }>;
    };
    const attachedPageTarget = targetResponse.targetInfos?.find(
      (info) => info.type === "page" && info.attached,
    );
    if (attachedPageTarget?.targetId) {
      const index = params.openTabs.findIndex(
        (tab) => tab.targetId === attachedPageTarget.targetId,
      );
      if (index >= 0) return index;
    }
  } catch {
    // Fall back to URL matching below if target lookup is unavailable.
  }

  const indexByUrl = params.openTabs.findIndex(
    (tab) => tab.url === params.currentUrl,
  );
  return indexByUrl >= 0 ? indexByUrl : 0;
}

export async function capturePreStepScreenshotDataUrl(params: {
  b: Browser;
  validBids: string[];
  jpegQuality?: number;
}): Promise<string> {
  const imageBase64 = await captureScreenshotWithBidBorders({
    page: params.b.Page,
    runtime: params.b.Runtime,
    dom: params.b.DOM,
    bids: params.validBids,
    captureScreenshotParams: {
      format: "jpeg",
      quality: params.jpegQuality ?? PRE_STEP_SCREENSHOT_JPEG_QUALITY,
      captureBeyondViewport: false,
      fromSurface: true,
    },
  });
  if (!imageBase64.trim()) {
    throw new Error(
      "capturePreStepScreenshotDataUrl received empty screenshot bytes",
    );
  }
  return `data:image/jpeg;base64,${imageBase64}`;
}
