import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { MarkItDown } from "markitdown-ts";
import type { Browser } from "../../browser/types.js";

export interface CapturedPageFileSnapshot {
	name: string;
	content: string;
}

export interface CaptureCurrentPageToMarkdownInput {
	browser: Browser;
	directory: string;
	sequence: number;
	protectedBids?: string[];
	capturedAt?: Date;
}

export interface CaptureCurrentPageToMarkdownResult {
	fileName: string;
	filePath: string;
	title: string;
	url: string;
}

export interface SaveCapturedMarkdownPageInput {
	directory: string;
	sequence: number;
	title: string;
	url: string;
	markdown: string;
	capturedAt?: Date;
	source?: "browser" | "web_fetch";
	requestedUrl?: string;
}

const MAX_CAPTURED_PAGE_FILE_NAME_BYTES = 240;
const CAPTURED_PAGE_FILE_NAME_PATTERN = /^(\d+) - .+\.md$/;
const LEGACY_CAPTURED_PAGE_FILE_NAME_PATTERN = /^page-(\d{4,})\.md$/;

const CAPTURE_EXPRESSION = (protectedBids: string[]): string => `(() => {
  const protectedBids = new Set(${JSON.stringify(protectedBids)});
  const clone = document.documentElement.cloneNode(true);
  for (const element of clone.querySelectorAll("script,style,noscript,template,svg")) {
    element.remove();
  }
  for (const element of clone.querySelectorAll("input,textarea,select,[contenteditable]")) {
    element.removeAttribute("value");
    element.removeAttribute("checked");
    element.removeAttribute("selected");
    if (element.tagName === "TEXTAREA" || element.hasAttribute("contenteditable")) {
      element.textContent = "";
    }
    if (element.tagName === "SELECT") {
      for (const option of element.querySelectorAll("option")) {
        option.removeAttribute("selected");
      }
    }
  }
  for (const element of clone.querySelectorAll("[value]")) {
    element.removeAttribute("value");
  }
  for (const element of clone.querySelectorAll("[bid],[data-bid]")) {
    const isProtected = protectedBids.has(element.getAttribute("bid")) || protectedBids.has(element.getAttribute("data-bid"));
    if (isProtected) element.textContent = "";
    element.removeAttribute("bid");
    element.removeAttribute("data-bid");
  }
  for (const element of clone.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    }
  }
  return {
    html: clone.outerHTML,
    title: document.title || "",
    url: location.href,
  };
})()`;

function ensureCapturedPagesDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function capturedPageSequence(fileName: string): number | undefined {
	const match =
		CAPTURED_PAGE_FILE_NAME_PATTERN.exec(fileName) ??
		LEGACY_CAPTURED_PAGE_FILE_NAME_PATTERN.exec(fileName);
	if (!match) return undefined;
	const sequence = Number(match[1]);
	return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function truncateUtf8(input: string, maxBytes: number): string {
	let result = "";
	let bytes = 0;
	for (const character of input) {
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function buildCapturedPageFileName(sequence: number, url: string): string {
	const prefix = `${sequence} - `;
	const extension = ".md";
	const maxUrlBytes =
		MAX_CAPTURED_PAGE_FILE_NAME_BYTES -
		Buffer.byteLength(prefix + extension, "utf-8");
	if (maxUrlBytes < Buffer.byteLength("url", "utf-8")) {
		throw new Error("captured page sequence is too long for a safe filename");
	}

	const sanitized = url
		.trim()
		.replace(/[\s<>:"/\\|?*\u0000-\u001f\u007f-\u009f]+/g, "_")
		.replace(/^[_ .]+|[_ .]+$/g, "");
	const urlPart =
		truncateUtf8(sanitized || "url", maxUrlBytes).replace(/[_ .]+$/g, "") ||
		"url";
	return `${prefix}${urlPart}${extension}`;
}

export function listCapturedPageFiles(directory: string): string[] {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isFile() && capturedPageSequence(entry.name) !== undefined,
			)
			.map((entry) => entry.name)
			.sort((left, right) => {
				const sequenceDifference =
					(capturedPageSequence(left) ?? 0) -
					(capturedPageSequence(right) ?? 0);
				return sequenceDifference || left.localeCompare(right);
			});
	} catch {
		return [];
	}
}

export function snapshotCapturedPages(
	directory: string,
): CapturedPageFileSnapshot[] {
	return listCapturedPageFiles(directory).map((name) => ({
		name,
		content: fs.readFileSync(path.join(directory, name), "utf-8"),
	}));
}

export function restoreCapturedPages(
	directory: string,
	files: CapturedPageFileSnapshot[],
): void {
	clearCapturedPages(directory);
	ensureCapturedPagesDirectory(directory);
	for (const file of files) {
		fs.writeFileSync(path.join(directory, file.name), file.content, {
			encoding: "utf-8",
			mode: 0o600,
		});
	}
}

export function clearCapturedPages(directory: string): void {
	ensureCapturedPagesDirectory(directory);
	for (const name of listCapturedPageFiles(directory)) {
		fs.unlinkSync(path.join(directory, name));
	}
}

export function saveCapturedMarkdownPage(
	input: SaveCapturedMarkdownPageInput,
): CaptureCurrentPageToMarkdownResult {
	ensureCapturedPagesDirectory(input.directory);
	const markdown = input.markdown.trim();
	if (!markdown) throw new Error("captured page produced empty Markdown");
	const metadata = yaml
		.dump(
			{
				title: input.title,
				url: input.url,
				captured_at: (input.capturedAt ?? new Date()).toISOString(),
				...(input.source ? { source: input.source } : {}),
				...(input.requestedUrl ? { requested_url: input.requestedUrl } : {}),
			},
			{ lineWidth: -1 },
		)
		.trim();
	const content = `---\n${metadata}\n---\n\n${markdown}\n`;
	const fileName = buildCapturedPageFileName(input.sequence, input.url);
	const filePath = path.join(input.directory, fileName);
	const tempPath = path.join(
		input.directory,
		`.captured-page-${process.pid}-${input.sequence}-${Date.now()}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
	}
	return {
		fileName,
		filePath,
		title: input.title,
		url: input.url,
	};
}

export async function captureCurrentPageToMarkdown(
	input: CaptureCurrentPageToMarkdownInput,
): Promise<CaptureCurrentPageToMarkdownResult> {
	ensureCapturedPagesDirectory(input.directory);
	const evaluation = await input.browser.Runtime.evaluate({
		expression: CAPTURE_EXPRESSION(input.protectedBids ?? []),
		returnByValue: true,
	});
	if (evaluation.exceptionDetails) {
		throw new Error("unable to capture current page HTML");
	}
	const value = evaluation.result.value as
		{ html?: unknown; title?: unknown; url?: unknown } | undefined;
	if (!value || typeof value.html !== "string" || !value.html.trim()) {
		throw new Error("current page returned empty HTML");
	}
	const title = typeof value.title === "string" ? value.title.trim() : "";
	const url = typeof value.url === "string" ? value.url.trim() : "";
	if (!url) throw new Error("current page returned an empty URL");

	const converted = await new MarkItDown().convertBuffer(
		Buffer.from(value.html, "utf-8"),
		{ file_extension: ".html", url },
	);
	const markdown = converted?.markdown?.trim();
	if (!markdown) throw new Error("current page produced empty Markdown");

	return saveCapturedMarkdownPage({
		directory: input.directory,
		sequence: input.sequence,
		title,
		url,
		markdown,
		capturedAt: input.capturedAt,
	});
}
