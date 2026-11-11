import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Proxy } from "http-mitm-proxy";
import {
  clearAppData,
  restoreCliConfig,
  seedCliConfig,
  seedSettings,
  snapshotCliConfig,
  type CliConfigSnapshot,
} from "#e2e/helpers/desktop-app";
import { DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY } from "#e2e/helpers/network-capture-proxy";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE_NAME = "conversation-session-webfetch";
const WEBFETCH_TOOL_NAME = "WebFetch";
const WEBFETCH_TARGET_HOST = "webfetch.e2e.test";
const WEBFETCH_TARGET_URL = `https://${WEBFETCH_TARGET_HOST}/e2e-webfetch-success`;
const WEBFETCH_TOOL_CALL_ID = "toolu_e2e_webfetch_success";
const WEBFETCH_HTML_MARKER = "E2E_WEBFETCH_HTML_MARKER";
const WEBFETCH_EXTRACTED_MARKER = "E2E_WEBFETCH_EXTRACTED_OK";
const WEBFETCH_FINAL_MARKER = "E2E_WEBFETCH_FINAL_OK";
const WEBFETCH_REQUEST_MARKER = "E2E_WEBFETCH_REQUEST";
const WEBFETCH_PROXY_ROOT = resolve(homedir(), "..", ".e2e-network-capture", CASE_NAME);

interface WebFetchProxyRecord {
  host: string;
  isSSL: boolean;
  path: string;
  userAgent: string;
}

interface WebFetchStubProxy {
  caCertPath: string;
  errors: string[];
  proxyUrl: string;
  records: WebFetchProxyRecord[];
  stop(): Promise<void>;
}

describe("会话区 WebFetch E2E", () => {
  let webFetchProxy: WebFetchStubProxy | null = null;
  let cliConfigSnapshot: CliConfigSnapshot | null = null;

  afterEach(async () => {
    const snapshot = cliConfigSnapshot;
    cliConfigSnapshot = null;
    try {
      if (snapshot) {
        await restoreCliConfig(snapshot);
      }
    } finally {
      await webFetchProxy?.stop();
      webFetchProxy = null;
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("O10: WebFetch 应通过 agent HttpClientPort 完成成功抓取和工具结果回灌", async function () {
    this.timeout(180000);

    webFetchProxy = await startWebFetchStubProxy();
    cliConfigSnapshot = await snapshotCliConfig();
    await seedSettings({
      httpProxy: webFetchProxy.proxyUrl,
      httpProxyCaCertPath: webFetchProxy.caCertPath,
      httpProxyNoProxy: DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
      messageStreamShowTodos: true,
    });
    await seedCliConfig({
      network: {
        httpProxy: webFetchProxy.proxyUrl,
        caCertFile: webFetchProxy.caCertPath,
        noProxy: DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
      },
    });
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const marker = `${WEBFETCH_REQUEST_MARKER}_${Date.now()}`;
    const prompt = [
      `${marker}: Use ${WEBFETCH_TOOL_NAME} exactly once.`,
      `Fetch ${WEBFETCH_TARGET_URL}.`,
      `Ask the tool to extract ${WEBFETCH_HTML_MARKER}.`,
      `Then reply with exactly "${WEBFETCH_FINAL_MARKER}" and no other text.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "WebFetch prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(marker);
    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [WEBFETCH_REQUEST_MARKER, WEBFETCH_TARGET_URL],
      },
      "没有捕获到 WebFetch 首段主模型请求",
      60000,
    );

    const toolBlock = await waitForToolCallBlockByToolName(WEBFETCH_TOOL_NAME, 60000);
    expect(toolBlock.exists).toBe(true);

    const proxyRecord = await waitForWebFetchProxyRecord(webFetchProxy);
    expect(proxyRecord.isSSL).toBe(true);
    expect(proxyRecord.path).toBe("/e2e-webfetch-success");
    expect(proxyRecord.userAgent).toContain("ZCode-WebFetch");

    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [
          "Web page content:",
          WEBFETCH_HTML_MARKER,
          "Extract the e2e marker from the fetched page.",
        ],
      },
      "没有捕获到 WebFetch 内部 lite model 抽取请求",
      60000,
    );

    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [WEBFETCH_REQUEST_MARKER, WEBFETCH_TOOL_CALL_ID, WEBFETCH_EXTRACTED_MARKER],
      },
      "WebFetch 工具结果没有进入后续主模型请求",
      90000,
    );
    await waitForV4AssistantMessageContaining(WEBFETCH_FINAL_MARKER);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "WebFetch E2E 完成后没有回到 idle",
      90000,
    );
    expect(webFetchProxy.errors).toEqual([]);
  });
});

async function startWebFetchStubProxy(): Promise<WebFetchStubProxy> {
  await rm(WEBFETCH_PROXY_ROOT, { recursive: true, force: true });
  await mkdir(WEBFETCH_PROXY_ROOT, { recursive: true });

  const host = "127.0.0.1";
  const proxy = new Proxy();
  const records: WebFetchProxyRecord[] = [];
  const errors: string[] = [];

  proxy.onError((ctx, error, errorKind) => {
    const requestHost = normalizeHost(ctx?.clientToProxyRequest?.headers.host);
    const message = [errorKind, requestHost, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join(": ");
    errors.push(message || "WebFetch stub proxy error");
  });

  proxy.onRequest((ctx) => {
    const requestHost = normalizeHost(ctx.clientToProxyRequest.headers.host);
    const requestPath = normalizePath(ctx.clientToProxyRequest.url);
    if (requestHost === WEBFETCH_TARGET_HOST) {
      records.push({
        host: requestHost,
        isSSL: ctx.isSSL,
        path: requestPath,
        userAgent: headerValue(ctx.clientToProxyRequest.headers["user-agent"]),
      });
      ctx.proxyToClientResponse.writeHead(200, "OK", {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      ctx.proxyToClientResponse.end(
        [
          "<!doctype html>",
          "<html><body>",
          "<h1>WebFetch E2E Fixture</h1>",
          `<p>${WEBFETCH_HTML_MARKER}: WebFetch successfully reached the local stub proxy.</p>`,
          "</body></html>",
        ].join(""),
      );
      return;
    }

    // 修复原因：该 case 只允许 WebFetch 目标流量进入 stub proxy；
    // 其它请求如果误走这里，直接失败以暴露代理/NoProxy 边界漂移。
    const unexpectedTarget = `Unexpected proxy target: ${requestHost}${requestPath}`;
    errors.push(unexpectedTarget);
    ctx.proxyToClientResponse.writeHead(502, "Unexpected Proxy Target", {
      "content-type": "text/plain; charset=utf-8",
    });
    ctx.proxyToClientResponse.end(unexpectedTarget);
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    proxy.listen(
      {
        host,
        keepAlive: true,
        port: 0,
        sslCaDir: WEBFETCH_PROXY_ROOT,
      },
      (error?: Error | null) => {
        if (error) {
          rejectStart(error);
          return;
        }
        resolveStart();
      },
    );
  });

  return {
    caCertPath: join(WEBFETCH_PROXY_ROOT, "certs", "ca.pem"),
    errors,
    proxyUrl: `http://${host}:${proxy.httpPort}`,
    records,
    async stop() {
      await new Promise<void>((resolveStop) => {
        proxy.close();
        resolveStop();
      });
    },
  };
}

async function waitForWebFetchProxyRecord(proxy: WebFetchStubProxy) {
  await browser.waitUntil(
    async () => proxy.records.some((record) => record.host === WEBFETCH_TARGET_HOST),
    {
      timeout: 60000,
      timeoutMsg: `WebFetch stub proxy 没有收到目标请求: ${JSON.stringify(proxy.records)}`,
    },
  );
  const record = proxy.records.find((item) => item.host === WEBFETCH_TARGET_HOST);
  if (!record) {
    throw new Error("WebFetch stub proxy record disappeared after wait");
  }
  return record;
}

function normalizeHost(value: string | string[] | undefined): string {
  const raw = headerValue(value).toLowerCase();
  return raw.replace(/:\d+$/u, "");
}

function normalizePath(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value;
  }
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
