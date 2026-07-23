import { assert } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "mocha";
import { executeActions } from "../src/agents/executor-utils/action-execution.js";
import {
  fetchWebPage,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WebFetchError,
  type CurlRunner,
} from "../src/agents/executor-utils/web-fetch.js";
import { featureFlags } from "../src/featureFlags.js";
import { makeFakeBrowser } from "./helpers/core-deps-fixtures.js";

const METADATA_MARKER = "__BROWSER_AGENT_WEB_FETCH_METADATA__";

function curlResponse(params: {
  body: string | Buffer;
  status?: number;
  contentType?: string;
  url?: string;
}): Buffer {
  return Buffer.concat([
    Buffer.isBuffer(params.body)
      ? params.body
      : Buffer.from(params.body, "utf-8"),
    Buffer.from(
      `\n${METADATA_MARKER}${params.status ?? 200}\t${params.contentType ?? "text/html; charset=utf-8"}\t${params.url ?? "https://example.com/page"}`,
      "utf-8",
    ),
  ]);
}

function runnerFor(
  params: Parameters<typeof curlResponse>[0],
  onArgs?: (args: string[]) => void,
): CurlRunner {
  return async (args) => {
    onArgs?.(args);
    return { stdout: curlResponse(params), stderr: "" };
  };
}

async function expectWebFetchError(
  promise: Promise<unknown>,
  code: WebFetchError["code"],
): Promise<WebFetchError> {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.instanceOf(error, WebFetchError);
    assert.equal((error as WebFetchError).code, code);
    return error as WebFetchError;
  }
}

describe("web_fetch curl retrieval", () => {
  it("uses bounded anonymous curl arguments and converts HTML to Markdown", async () => {
    let args: string[] = [];
    const result = await fetchWebPage({
      url: "https://example.com/start",
      runCurl: runnerFor(
        {
          body: "<!doctype html><html><head><title>Example &amp; News</title></head><body><main><h1>Headline</h1><p>Details</p></main></body></html>",
          url: "https://example.com/final",
        },
        (value) => {
          args = value;
        },
      ),
    });

    assert.equal(result.requestedUrl, "https://example.com/start");
    assert.equal(result.url, "https://example.com/final");
    assert.equal(result.title, "Example & News");
    assert.include(result.markdown, "Headline");
    assert.include(result.markdown, "Details");
    assert.include(args, "--location");
    assert.include(args, "--compressed");
    assert.include(args, "=http,https");
    assert.include(args, String(WEB_FETCH_MAX_RESPONSE_BYTES));
    assert.equal(args.at(-1), "https://example.com/start");
  });

  it("preserves JSON and plain text as Markdown", async () => {
    const json = await fetchWebPage({
      url: "https://example.com/data.json",
      runCurl: runnerFor({
        body: '{"answer":42}',
        contentType: "application/json",
        url: "https://example.com/data.json",
      }),
    });
    assert.equal(json.markdown, '```json\n{"answer":42}\n```');

    const text = await fetchWebPage({
      url: "https://example.com/robots.txt",
      runCurl: runnerFor({
        body: "User-agent: *\nDisallow:",
        contentType: "text/plain",
        url: "https://example.com/robots.txt",
      }),
    });
    assert.equal(text.markdown, "User-agent: *\nDisallow:");
  });

  it("classifies hard and soft not-found responses", async () => {
    for (const status of [404, 410]) {
      await expectWebFetchError(
        fetchWebPage({
          url: "https://example.com/missing",
          runCurl: runnerFor({ body: "missing", status }),
        }),
        "not_found",
      );
    }
    await expectWebFetchError(
      fetchWebPage({
        url: "https://example.com/soft-missing",
        runCurl: runnerFor({
          body: "<html><title>Page Not Found</title><body>Sorry</body></html>",
        }),
      }),
      "not_found",
    );
  });

  it("classifies blocked statuses and successful challenge pages as anti-bot", async () => {
    for (const status of [403, 429]) {
      await expectWebFetchError(
        fetchWebPage({
          url: "https://example.com/blocked",
          runCurl: runnerFor({ body: "blocked", status }),
        }),
        "anti_bot",
      );
    }
    await expectWebFetchError(
      fetchWebPage({
        url: "https://example.com/challenge",
        runCurl: runnerFor({
          body: "<html><title>Just a moment...</title><body>Verify you are human</body></html>",
        }),
      }),
      "anti_bot",
    );
  });

  it("does not treat passive MediaWiki hcaptcha configuration as a challenge", async () => {
    const result = await fetchWebPage({
      url: "https://en.wikipedia.org/wiki/John_Hopfield",
      runCurl: runnerFor({
        body: `<html><head><title>John Hopfield - Wikipedia</title></head><body><script>RLCONF={"wgConfirmEditCaptchaNeededForGenericEdit":"hcaptcha","wgConfirmEditForceShowCaptcha":false};</script><main><h1>John Hopfield</h1><p>American physicist.</p></main></body></html>`,
        contentType: "text/html; charset=UTF-8",
        url: "https://en.wikipedia.org/wiki/John_Hopfield",
      }),
    });

    assert.equal(result.status, 200);
    assert.include(result.markdown, "John Hopfield");
  });

  it("rejects unsafe URLs, binary or oversized responses, and runner failures", async () => {
    for (const url of [
      "file:///tmp/secret",
      "https://user:password@example.com/private",
      "not a url",
    ]) {
      await expectWebFetchError(fetchWebPage({ url }), "fetch_failed");
    }
    await expectWebFetchError(
      fetchWebPage({
        url: "https://example.com/image.png",
        runCurl: runnerFor({
          body: "PNG",
          contentType: "image/png",
        }),
      }),
      "fetch_failed",
    );
    await expectWebFetchError(
      fetchWebPage({
        url: "https://example.com/huge",
        runCurl: runnerFor({
          body: Buffer.alloc(WEB_FETCH_MAX_RESPONSE_BYTES + 1, "x"),
          contentType: "text/plain",
        }),
      }),
      "fetch_failed",
    );
    await expectWebFetchError(
      fetchWebPage({
        url: "https://example.com/timeout",
        runCurl: async () => {
          throw new Error("curl unavailable");
        },
      }),
      "fetch_failed",
    );
  });
});

describe("web_fetch action execution", () => {
  const originalFlag = featureFlags.webFetchTool;

  afterEach(() => {
    featureFlags.webFetchTool = originalFlag;
  });

  function actionFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-fetch-action-"));
    const pages = path.join(root, "pages");
    fs.mkdirSync(pages);
    const memoryFile = path.join(root, "memory.txt");
    fs.writeFileSync(memoryFile, "", "utf-8");
    return { root, pages, memoryFile };
  }

  it("saves full Markdown evidence and returns a bounded memory preview", async () => {
    featureFlags.webFetchTool = true;
    const files = actionFixture();
    try {
      const markdown = `# Retrieved\n\n${"detail ".repeat(10_000)}`;
      const result = await executeActions({
        b: makeFakeBrowser(9222),
        actions: [
          { type: "web_fetch", urls: ["https://example.com/start"] },
        ],
        openTabs: [],
        memoryFile: files.memoryFile,
        capturedPagesDirectory: files.pages,
        allocateCapturedPageSequence: () => 7,
        fetchWebPage: async () => ({
          requestedUrl: "https://example.com/start",
          url: "https://example.com/final",
          status: 200,
          contentType: "text/html",
          title: "Retrieved page",
          markdown,
        }),
      });

      assert.isTrue(result.pendingMemoryRead);
      const fileName = "7 - https_example.com_final.md";
      assert.deepEqual(fs.readdirSync(files.pages), [fileName]);
      const saved = fs.readFileSync(
        path.join(files.pages, fileName),
        "utf-8",
      );
      assert.include(saved, "source: web_fetch");
      assert.include(saved, "requested_url: https://example.com/start");
      assert.include(saved, "url: https://example.com/final");
      assert.include(saved, markdown.trim());
      const memory = fs.readFileSync(files.memoryFile, "utf-8");
      assert.include(memory, fileName);
      assert.include(memory, "preview truncated");
      assert.isBelow(memory.length, markdown.length);
      assert.include(
        (result.toolObservations ?? []).join("\n"),
        `[0] success ${fileName}`,
      );
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("fetches URL lists concurrently while preserving original indices", async () => {
    featureFlags.webFetchTool = true;
    const files = actionFixture();
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let sequence = 1;
    const urls = [
      "https://example.com/slow",
      "https://example.com/missing",
      "https://example.com/fast",
    ];
    try {
      const result = await executeActions({
        b: makeFakeBrowser(9222),
        actions: [{ type: "web_fetch", urls }],
        openTabs: [],
        memoryFile: files.memoryFile,
        capturedPagesDirectory: files.pages,
        allocateCapturedPageSequence: () => sequence++,
        fetchWebPage: async ({ url }) => {
          activeCalls += 1;
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
          try {
            if (url.endsWith("/slow")) {
              await new Promise((resolve) => setTimeout(resolve, 40));
            } else if (url.endsWith("/missing")) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              throw new WebFetchError("not_found", "HTTP 404");
            } else {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            return {
              requestedUrl: url,
              url,
              status: 200,
              contentType: "text/plain",
              title: url.split("/").pop() ?? url,
              markdown: `content for ${url}`,
            };
          } finally {
            activeCalls -= 1;
          }
        },
      });

      assert.equal(maxActiveCalls, 3);
      const slowFileName = "1 - https_example.com_slow.md";
      const fastFileName = "2 - https_example.com_fast.md";
      assert.deepEqual(fs.readdirSync(files.pages), [
        slowFileName,
        fastFileName,
      ]);
      assert.include(
        fs.readFileSync(path.join(files.pages, slowFileName), "utf-8"),
        urls[0],
      );
      assert.include(
        fs.readFileSync(path.join(files.pages, fastFileName), "utf-8"),
        urls[2],
      );
      const memory = fs.readFileSync(files.memoryFile, "utf-8");
      assert.isBelow(memory.indexOf("[0] web_fetch"), memory.indexOf("[2] web_fetch"));
      assert.include(result.interactionErrors.join("\n"), "web_fetch[1]");
      assert.include(result.interactionErrors.join("\n"), "not_found");
      assert.include(
        (result.toolObservations ?? []).join("\n"),
        `[0] success ${slowFileName}; [1] error not_found; [2] success ${fastFileName}`,
      );
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("returns classified fallback guidance without changing evidence or memory", async () => {
    featureFlags.webFetchTool = true;
    const files = actionFixture();
    fs.writeFileSync(files.memoryFile, "existing", "utf-8");
    try {
      const result = await executeActions({
        b: makeFakeBrowser(9222),
        actions: [
          { type: "web_fetch", urls: ["https://example.com/blocked"] },
        ],
        openTabs: [],
        memoryFile: files.memoryFile,
        capturedPagesDirectory: files.pages,
        fetchWebPage: async () => {
          throw new WebFetchError("anti_bot", "verification required");
        },
      });

      assert.isFalse(result.pendingMemoryRead);
      assert.deepEqual(fs.readdirSync(files.pages), []);
      assert.equal(fs.readFileSync(files.memoryFile, "utf-8"), "existing");
      assert.include(result.interactionErrors.join("\n"), "anti_bot");
      assert.include(result.interactionErrors.join("\n"), "use navigate");
      assert.include(result.interactionErrors.join("\n"), "real browser");
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("does not execute when disabled and enforces the final-action barrier", async () => {
    const files = actionFixture();
    let calls = 0;
    try {
      featureFlags.webFetchTool = false;
      const disabled = await executeActions({
        b: makeFakeBrowser(9222),
        actions: [{ type: "web_fetch", urls: ["https://example.com"] }],
        openTabs: [],
        memoryFile: files.memoryFile,
        capturedPagesDirectory: files.pages,
        fetchWebPage: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      });
      assert.equal(calls, 0);
      assert.include(disabled.interactionErrors.join("\n"), "feature flag");

      featureFlags.webFetchTool = true;
      const barrier = await executeActions({
        b: makeFakeBrowser(9222),
        actions: [
          { type: "web_fetch", urls: ["https://example.com"] },
          { type: "memory_write", content: "must be ignored" },
        ],
        openTabs: [],
        memoryFile: files.memoryFile,
        capturedPagesDirectory: files.pages,
        fetchWebPage: async () => ({
          requestedUrl: "https://example.com/",
          url: "https://example.com/",
          status: 200,
          contentType: "text/plain",
          title: "Example",
          markdown: "fetched content",
        }),
      });
      assert.include(barrier.interactionErrors.join("\n"), "final action");
      assert.notInclude(
        fs.readFileSync(files.memoryFile, "utf-8"),
        "must be ignored",
      );
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });
});
