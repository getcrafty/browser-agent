import { execFile } from "node:child_process";
import { MarkItDown } from "markitdown-ts";

export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const CURL_METADATA_MARKER = "__BROWSER_AGENT_WEB_FETCH_METADATA__";
const CURL_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export type WebFetchErrorCode = "not_found" | "anti_bot" | "fetch_failed";

export class WebFetchError extends Error {
  constructor(
    readonly code: WebFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface CurlRunResult {
  stdout: Buffer;
  stderr: string;
}

export type CurlRunner = (args: string[]) => Promise<CurlRunResult>;

export interface WebFetchInput {
  url: string;
  runCurl?: CurlRunner;
}

export interface WebFetchResult {
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  title: string;
  markdown: string;
}

function defaultCurlRunner(args: string[]): Promise<CurlRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      args,
      {
        encoding: "buffer",
        maxBuffer: WEB_FETCH_MAX_RESPONSE_BYTES + 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr)
            ? stderr.toString("utf-8").trim()
            : String(stderr ?? "").trim();
          reject(
            new WebFetchError(
              "fetch_failed",
              detail || error.message || "curl failed",
            ),
          );
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout)
            ? stdout
            : Buffer.from(String(stdout ?? ""), "utf-8"),
          stderr: Buffer.isBuffer(stderr)
            ? stderr.toString("utf-8")
            : String(stderr ?? ""),
        });
      },
    );
  });
}

function validateUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebFetchError("fetch_failed", "URL must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebFetchError(
      "fetch_failed",
      "only anonymous http and https URLs are supported",
    );
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new WebFetchError(
      "fetch_failed",
      "URLs containing credentials are not supported",
    );
  }
  return parsed;
}

function parseCurlOutput(stdout: Buffer): {
  body: Buffer;
  status: number;
  contentType: string;
  url: string;
} {
  const marker = Buffer.from(`\n${CURL_METADATA_MARKER}`, "utf-8");
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new WebFetchError(
      "fetch_failed",
      "curl response metadata was missing",
    );
  }
  const metadata = stdout
    .subarray(markerIndex + marker.length)
    .toString("utf-8")
    .trim();
  const [statusText, contentType = "", ...urlParts] = metadata.split("\t");
  const status = Number(statusText);
  const url = urlParts.join("\t").trim();
  if (!Number.isInteger(status) || status < 100 || !url) {
    throw new WebFetchError(
      "fetch_failed",
      "curl returned invalid response metadata",
    );
  }
  return {
    body: stdout.subarray(0, markerIndex),
    status,
    contentType: contentType.trim(),
    url,
  };
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSupportedTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/xml" ||
    contentType.endsWith("+xml") ||
    contentType === "application/xhtml+xml"
  );
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlText(match[1]).slice(0, 500) : "";
}

function isSoftNotFound(bodyText: string, title: string): boolean {
  if (bodyText.length > 10_000) return false;
  if (/^(?:404|410)(?:\b|\s*[-:])|^(?:page\s+)?not found$/i.test(title)) {
    return true;
  }
  const plainText = decodeHtmlText(bodyText).slice(0, 500);
  return /^(?:(?:error\s+)?(?:404|410)\b.{0,100}(?:not found|gone)|(?:page\s+)?not found\b)/i.test(
    plainText,
  );
}

function containsAntiBotChallenge(bodyText: string, title: string): boolean {
  const sample = `${title}\n${bodyText.slice(0, 250_000)}`;
  return [
    /\bcf-chl-/i,
    /attention required.{0,120}cloudflare/is,
    /just a moment.{0,200}(?:enable javascript|checking your browser)/is,
    /verify (?:that )?you are (?:a )?human/i,
    /(?:complete|solve|pass).{0,80}\bcaptcha\b/is,
    /\b(?:g-recaptcha|cf-turnstile)\b/i,
    /unusual traffic from your computer network/i,
    /\bdatadome\b/i,
    /\bperimeterx\b|_pxCaptcha/i,
    /\bincapsula\b/i,
    /akamai bot manager/i,
    /access denied.{0,160}reference\s*(?:#|number)/is,
  ].some((pattern) => pattern.test(sample));
}

function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
  } catch {
    return url;
  }
}

async function convertToMarkdown(params: {
  body: Buffer;
  bodyText: string;
  contentType: string;
  url: string;
}): Promise<string> {
  if (
    params.contentType === "text/html" ||
    params.contentType === "application/xhtml+xml" ||
    (!params.contentType && /<html\b|<!doctype\s+html/i.test(params.bodyText))
  ) {
    const converted = await new MarkItDown().convertBuffer(params.body, {
      file_extension: ".html",
      url: params.url,
    });
    return converted?.markdown?.trim() ?? "";
  }
  if (
    params.contentType === "application/json" ||
    params.contentType.endsWith("+json")
  ) {
    return `\`\`\`json\n${params.bodyText.trim()}\n\`\`\``;
  }
  if (
    params.contentType === "application/xml" ||
    params.contentType.endsWith("+xml") ||
    params.contentType === "text/xml"
  ) {
    return `\`\`\`xml\n${params.bodyText.trim()}\n\`\`\``;
  }
  return params.bodyText.trim();
}

export async function fetchWebPage(
  input: WebFetchInput,
): Promise<WebFetchResult> {
  const requestedUrl = validateUrl(input.url.trim()).toString();
  const writeOut = `\n${CURL_METADATA_MARKER}%{http_code}\t%{content_type}\t%{url_effective}`;
  let raw: CurlRunResult;
  try {
    raw = await (input.runCurl ?? defaultCurlRunner)([
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--max-time",
      String(WEB_FETCH_TIMEOUT_MS / 1000),
      "--connect-timeout",
      "5",
      "--max-filesize",
      String(WEB_FETCH_MAX_RESPONSE_BYTES),
      "--proto",
      "=http,https",
      "--proto-redir",
      "=http,https",
      "--user-agent",
      CURL_USER_AGENT,
      "--header",
      "Accept: text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1",
      "--output",
      "-",
      "--write-out",
      writeOut,
      "--",
      requestedUrl,
    ]);
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    throw new WebFetchError(
      "fetch_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const response = parseCurlOutput(raw.stdout);
  if (response.body.length > WEB_FETCH_MAX_RESPONSE_BYTES) {
    throw new WebFetchError(
      "fetch_failed",
      `response exceeded ${WEB_FETCH_MAX_RESPONSE_BYTES} bytes`,
    );
  }
  const contentType = normalizeContentType(response.contentType);
  const bodyText = response.body.toString("utf-8");
  const title = extractHtmlTitle(bodyText);

  if (response.status === 404 || response.status === 410) {
    throw new WebFetchError(
      "not_found",
      `URL returned HTTP ${response.status}`,
    );
  }
  if (
    response.status === 403 ||
    response.status === 429 ||
    containsAntiBotChallenge(bodyText, title)
  ) {
    throw new WebFetchError(
      "anti_bot",
      `page is protected by anti-bot verification (HTTP ${response.status})`,
    );
  }
  if (response.status >= 400) {
    throw new WebFetchError(
      "fetch_failed",
      `URL returned HTTP ${response.status}`,
    );
  }
  if (isSoftNotFound(bodyText, title)) {
    throw new WebFetchError("not_found", "page reported that it was not found");
  }
  if (contentType && !isSupportedTextContentType(contentType)) {
    throw new WebFetchError(
      "fetch_failed",
      `unsupported content type ${contentType}`,
    );
  }
  if (response.body.length === 0 || !bodyText.trim()) {
    throw new WebFetchError("fetch_failed", "page returned an empty response");
  }

  const markdown = await convertToMarkdown({
    body: response.body,
    bodyText,
    contentType,
    url: response.url,
  });
  if (!markdown) {
    throw new WebFetchError("fetch_failed", "page produced empty Markdown");
  }
  return {
    requestedUrl,
    url: response.url,
    status: response.status,
    contentType: contentType || "text/plain",
    title: title || fallbackTitle(response.url),
    markdown,
  };
}
