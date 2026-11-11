/* eslint-disable max-lines -- Upstream E2E 回放服务需要集中维护 fixture 匹配、capture artifact、chunk timeline 和 SSE 时间轴回放，拆开会让录制/回放协议更难追踪。 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
  E2ENetworkCaptureResponseEvent,
  E2ENetworkResponseChunk,
} from "./network-capture-proxy.js";
import { isE2EFileReplaceConflict, writeE2EJsonFileAtomically } from "./e2e-atomic-json-file.js";
import {
  redactE2ENetworkCaptureJson,
  redactE2ENetworkCaptureJsonText,
  sanitizeE2ENetworkCaptureHeaders,
} from "./e2e-network-capture-redaction.js";
import { resolveUpstreamModels } from "./upstream-recorded-models.js";

// 夹具未写模型时，回放响应使用与 E2E 供应商相同的模型（环境变量或录制模型）。
const DEFAULT_REPLAY_MODEL = resolveUpstreamModels().model;
const LATEST_AGENT_ID_REPLAY_TOKEN = "{{latestAgentId}}";
const LATEST_BASH_TASK_ID_REPLAY_TOKEN = "{{latestBashTaskId}}";
const MEMORY_ROOT_REPLAY_TOKEN = "{{memoryRoot}}";
const LATEST_AUTOMATION_ID_REPLAY_TOKEN = "{{latestAutomationId}}";
const LATEST_WORKFLOW_RUN_ID_REPLAY_TOKEN = "{{latestWorkflowRunId}}";
const LATEST_WORKFLOW_QUESTION_ID_REPLAY_TOKEN = "{{latestWorkflowQuestionId}}";
const BROWSER_FIXTURE_URL_REPLAY_TOKEN = "{{browserFixtureUrl}}";
const LATEST_BROWSER_TAB_ID_REPLAY_TOKEN = "{{latestBrowserTabId}}";
const LATEST_BROWSER_TAB_A_ID_REPLAY_TOKEN = "{{latestBrowserTabAId}}";
const LATEST_BROWSER_TAB_B_ID_REPLAY_TOKEN = "{{latestBrowserTabBId}}";
const ARTIFACT_RETRY_MIN_DELAY_MS = 50;
const ARTIFACT_RETRY_MAX_DELAY_MS = 1000;

export interface UpstreamReplayServer {
  artifactPath: string;
  baseUrl: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

interface StartUpstreamReplayServerOptions {
  artifactPath: string;
  artifactWriter?: typeof writeE2EJsonFileAtomically;
  fixtureVariables?: Readonly<Record<string, string>>;
  fixturePaths: string[];
  host?: string;
  port?: number;
}

interface UpstreamReplayFixtureFile {
  fixtures: UpstreamReplayFixture[];
  version: 1;
}

type UpstreamReplayCloseMode = "end" | "destroy";

interface UpstreamReplayFixture {
  metadata?: { timingPolicy?: string };
  captured?: {
    capturedAt?: string;
    model?: string;
    requestBodyBytes?: number;
    responseBodyBytes?: number;
    statusCode?: number;
    url?: string;
  };
  description?: string;
  id: string;
  maxMatches?: number;
  match: {
    bodyExcludes?: string[];
    bodyIncludes?: string[];
    lastUserMessageExcludes?: string[];
    lastUserMessageIncludes?: string[];
    method?: string;
    pathIncludes?: string;
  };
  replay?: {
    consumeOnce?: boolean;
  };
  response: {
    body?: string;
    chunks?: UpstreamReplayResponseChunk[];
    closeMode?: UpstreamReplayCloseMode;
    delayMs?: number;
    /** 仅 controlled-stream：每个边界均等待测试完成对应操作再释放。 */
    releaseAfterChunks?: number | number[];
    events?: E2ENetworkCaptureResponseEvent[];
    headers?: Record<string, string>;
    statusCode: number;
    statusMessage?: string;
    text?: UpstreamReplayTextResponse | string;
    toolUse?: UpstreamReplayToolUseResponse;
    toolUses?: UpstreamReplayToolUseResponse[];
  };
}

interface ReplayVariables {
  browserFixtureUrl?: string;
  latestBrowserTabAId?: string;
  latestBrowserTabBId?: string;
  latestBrowserTabId?: string;
  latestAgentId?: string;
  latestBashTaskId?: string;
  memoryRoot?: string;
  latestAutomationId?: string;
  latestWorkflowRunId?: string;
  appControlTargetRef?: Record<string, unknown>;
  appControlResults?: Record<string, unknown>;
  latestWorkflowQuestionId?: string;
}

interface UpstreamReplayResponseChunk {
  base64?: string;
  byteLength?: number;
  offsetMs: number;
  text?: string;
}

interface UpstreamReplayTextResponse {
  id?: string;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  text: string;
}

interface UpstreamReplayToolUseResponse {
  id?: string;
  input: Record<string, unknown>;
  inputTokens?: number;
  messageId?: string;
  model?: string;
  name: string;
  outputTokens?: number;
}

type MutableCaptureRecord = E2ENetworkCaptureRecord;

export async function startUpstreamReplayServer(
  options: StartUpstreamReplayServerOptions,
): Promise<UpstreamReplayServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const artifactPath = resolve(options.artifactPath);
  const artifactWriter = options.artifactWriter ?? writeE2EJsonFileAtomically;
  // Bug 根因：provider fixture 里的绝对路径过去只能写死为 POSIX 临时目录，
  // Windows Node 与 Git Bash 因而会访问不同文件。静态变量必须在 matcher 之前展开，
  // 否则 response 虽能拿到正确路径，请求仍会先因 matcher 含 token 而 miss。
  const fixtures = options.fixturePaths.flatMap((path) =>
    loadFixtureFile(path, options.fixtureVariables),
  );
  for (const fixture of fixtures) {
    const boundary = fixture.response.releaseAfterChunks;
    if (boundary === undefined) continue;
    const counts = Array.isArray(boundary) ? boundary : [boundary];
    if (
      fixture.metadata?.timingPolicy !== "controlled-stream" ||
      counts.length === 0 ||
      counts.some(
        (count, index) =>
          !Number.isInteger(count) ||
          count < 1 ||
          count >= (fixture.response.chunks?.length ?? 0) ||
          (index > 0 && count <= counts[index - 1]!),
      ) ||
      fixture.response.events?.length
    ) {
      throw new Error(`无效受控流 fixture: ${fixture.id}；不得改变 recorded/fault stream 的时间轴`);
    }
  }
  const fixtureMatchCounts = new Map<string, number>();
  const records: MutableCaptureRecord[] = [];
  const gates = new Map<string, { release(): void; cancel(): void }>();

  const holdStream = (id: string, response: ServerResponse) =>
    new Promise<void>((resolveGate, rejectGate) => {
      if (gates.has(id)) {
        rejectGate(new Error(`重复的受控请求: ${id}`));
        return;
      }
      const finish = (error?: Error) => {
        clearTimeout(timer);
        response.off("close", closed);
        gates.delete(id);
        if (error) rejectGate(error);
        else resolveGate();
      };
      const closed = () => finish(new Error(`受控流已断开: ${id}`));
      const timer = setTimeout(() => finish(new Error(`受控流未被测试释放: ${id}`)), 120_000);
      gates.set(id, { release: () => finish(), cancel: closed });
      response.once("close", closed);
    });

  let serverPort = requestedPort;
  let baseUrl = `http://${host}:${serverPort}`;

  // Bug 原因（CR-01）：capture 是 records 的全量快照，测试端直接轮询文件、不会触发写入。
  // 旧实现在入队时生成快照，请求内写入撞上 Windows 占用冲突（reader 整文件读取 60MB
  // capture 时 rename 持续 EPERM）只告警丢弃，冲突解除后没有新请求就不会再写，
  // waitForUpstreamRequest 一直读到旧快照而超时。
  // 修复：唯一数据源是内存 records；变化只标记 artifactDirty，由唯一的串行写入循环在写入时
  // 生成最新快照（多次变化合并，旧快照不会覆盖新快照）。占用冲突保持 dirty 并退避重试，
  // 补写不依赖下一次模型请求或 stop()。
  let artifactDirty = false;
  let artifactWriteLoop: Promise<void> | undefined;
  let artifactRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let artifactRetryDelayMs = ARTIFACT_RETRY_MIN_DELAY_MS;
  let artifactWritesClosed = false;

  const buildArtifact = (): E2ENetworkCaptureArtifact => ({
    generatedAt: new Date().toISOString(),
    proxy: {
      caCertPath: "",
      host,
      port: serverPort,
      proxyUrl: baseUrl,
    },
    records: records.map(serializeRecord),
    version: 1,
  });

  const runArtifactWrites = async () => {
    while (artifactDirty) {
      artifactDirty = false;
      try {
        await artifactWriter(artifactPath, buildArtifact());
        artifactRetryDelayMs = ARTIFACT_RETRY_MIN_DELAY_MS;
      } catch (error) {
        artifactDirty = true;
        if (isE2EFileReplaceConflict(error)) scheduleArtifactRetry();
        throw error;
      }
    }
  };

  /** 标记待写并加入唯一写入循环；返回的 promise 在覆盖本次变化的写入完成或失败时结算。 */
  const writeArtifact = () => {
    artifactDirty = true;
    artifactWriteLoop ??= runArtifactWrites().finally(() => {
      artifactWriteLoop = undefined;
    });
    return artifactWriteLoop;
  };

  function scheduleArtifactRetry() {
    if (artifactWritesClosed || artifactRetryTimer) return;
    const delayMs = artifactRetryDelayMs;
    artifactRetryDelayMs = Math.min(delayMs * 2, ARTIFACT_RETRY_MAX_DELAY_MS);
    artifactRetryTimer = setTimeout(() => {
      artifactRetryTimer = undefined;
      if (artifactWritesClosed || !artifactDirty) return;
      // 后台补写没有调用方可收口：占用冲突已在循环内重新排期；其它错误保留 dirty，
      // 由 stop() 的最终写入抛出。
      void writeArtifact().catch((error: unknown) => {
        console.warn(
          `[upstream-replay] capture snapshot retry failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, delayMs);
  }

  /** 停止后台补写并等待在途写入收口；之后的 writeArtifact 只做一次性写入，失败直接抛出。 */
  const closeArtifactWrites = async () => {
    artifactWritesClosed = true;
    clearTimeout(artifactRetryTimer);
    artifactRetryTimer = undefined;
    await artifactWriteLoop?.catch(() => undefined);
  };

  // 请求途中的快照遇到占用冲突只告警、请求照常回放（旧实现曾把它打成 500，BG46 台账
  // 留下 fixtureId=null 记录）；补写由写入循环负责。其它写入错误仍按原合同结束请求。
  const writeArtifactSnapshot = () =>
    writeArtifact().catch((error: unknown) => {
      if (!isE2EFileReplaceConflict(error)) throw error;
      console.warn(
        `[upstream-replay] capture snapshot deferred (file locked): ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  const server = createServer((request, response) => {
    // 控制端不进入模型请求台账；每个独立 replay server 只释放自己的正在等待的 fixture。
    if (request.method === "GET" && request.url === "/__e2e__/gates") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([...gates.keys()]));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/__e2e__/release/")) {
      const gate = gates.get(request.url.slice("/__e2e__/release/".length));
      response.statusCode = gate ? 204 : 409;
      gate?.release();
      response.end();
      return;
    }
    void handleReplayRequest(request, response, {
      baseUrl,
      fixtureMatchCounts,
      fixtures,
      records,
      writeArtifact: writeArtifactSnapshot,
      holdStream,
    }).catch((error: unknown) => {
      // Bug 根因：旧 handler 是裸 `void Promise`，capture 写入抛错后没有任何人
      // 收口 response，provider 只能一直等 socket。证据通道失败必须显式结束请求。
      closeReplayResponseAfterHandlerError(response, error);
    });
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.listen(requestedPort, host, () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        rejectStart(new Error("Upstream replay server did not expose an address"));
        return;
      }
      serverPort = address.port;
      baseUrl = `http://${host}:${serverPort}`;
      resolveStart();
    });
    server.once("error", rejectStart);
  });
  try {
    await writeArtifact();
  } catch (error) {
    // Bug 根因：listen 成功后首次 artifact 写入失败会直接退出启动流程，
    // 但旧实现没有关闭 HTTP server，导致端口和进程句柄跨测试泄漏。
    // 清理错误不能覆盖原始写入错误；同时显式等待队列收口再向调用方失败。
    await closeServerListener(server).catch(() => undefined);
    await closeArtifactWrites();
    throw error;
  }

  return {
    artifactPath,
    baseUrl,
    host,
    port: serverPort,
    stop: () => {
      for (const gate of gates.values()) gate.cancel();
      return stopServer(server, closeArtifactWrites, writeArtifact);
    },
  };
}

async function handleReplayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    baseUrl: string;
    fixtureMatchCounts: Map<string, number>;
    fixtures: UpstreamReplayFixture[];
    records: MutableCaptureRecord[];
    writeArtifact(): Promise<void>;
    holdStream(id: string, response: ServerResponse): Promise<void>;
  },
) {
  const startedAt = new Date().toISOString();
  const requestBody = await readRequestBody(request);
  const requestText = requestBody.toString("utf-8");
  const requestJson = parseJson(requestText);
  const requestUrl = buildRequestUrl(request, context.baseUrl);
  const record: MutableCaptureRecord = {
    host: requestUrl.host,
    id: randomUUID(),
    method: request.method ?? "GET",
    path: requestUrl.pathname + requestUrl.search,
    protocol: requestUrl.protocol === "https:" ? "https" : "http",
    requestBodyBytes: requestBody.length,
    requestHeaders: sanitizeE2ENetworkCaptureHeaders(request.headers),
    requestJson: requestJson ? redactE2ENetworkCaptureJson(requestJson) : undefined,
    requestTextPreview: requestJson ? undefined : requestText,
    responseBodyBytes: 0,
    responseHeaders: {},
    startedAt,
    status: "pending",
    url: requestUrl.toString(),
  };
  context.records.push(record);
  await context.writeArtifact();

  const fixtureIndex = findFixtureIndex(
    context.fixtures,
    record,
    requestText,
    requestJson,
    context.fixtureMatchCounts,
  );
  const fixture = fixtureIndex >= 0 ? context.fixtures[fixtureIndex] : undefined;
  if (!fixture) {
    const body = JSON.stringify(
      {
        error: {
          message: `Missing Upstream e2e fixture for ${record.method} ${record.path}`,
        },
      },
      null,
      2,
    );
    await writeResponse(response, record, {
      body,
      headers: { "content-type": "application/json; charset=utf-8" },
      statusCode: 500,
      statusMessage: "Missing Fixture",
    });
    await context.writeArtifact();
    return;
  }
  context.fixtureMatchCounts.set(fixture.id, (context.fixtureMatchCounts.get(fixture.id) ?? 0) + 1);
  record.replay = {
    closeMode: fixture.response.closeMode ?? "end",
    fixtureId: fixture.id,
  };
  await context.writeArtifact();

  if (fixture.response.delayMs && fixture.response.delayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, fixture.response.delayMs));
  }

  if (fixture.response.events?.length) {
    await writeEventStreamResponse(response, record, {
      events: fixture.response.events,
      closeMode: fixture.response.closeMode ?? "end",
      headers: fixture.response.headers ?? {},
      statusCode: fixture.response.statusCode,
      statusMessage: fixture.response.statusMessage ?? "OK",
    });
  } else {
    const resolvedBody = resolveFixtureResponseBody(
      fixture.response,
      extractReplayVariables(requestText, requestJson),
      isStreamingRequest(requestJson),
    );
    if (
      resolvedBody.body.includes(BROWSER_FIXTURE_URL_REPLAY_TOKEN) ||
      resolvedBody.body.includes(LATEST_WORKFLOW_RUN_ID_REPLAY_TOKEN) ||
      /\{\{appControl(?:Target(?:Project)?Ref|Result:[^}]+)\}\}/u.test(resolvedBody.body)
    ) {
      // 修复原因：动态 URL marker 缺失或格式错误时保留模板会让 Browser tool
      // 导航到字面量 `{{browserFixtureUrl}}`，随后可能被 compact 摘要掩盖成成功。
      // replay 必须 fail closed，让 fixture/request 契约错误直接可见。
      await writeResponse(response, record, {
        body: JSON.stringify({
          error: {
            message: resolvedBody.body.includes(BROWSER_FIXTURE_URL_REPLAY_TOKEN)
              ? "Missing E2E_BROWSER_FIXTURE_URL replay variable"
              : /\{\{appControl(?:Target(?:Project)?Ref|Result:[^}]+)\}\}/u.test(resolvedBody.body)
                ? "Missing authoritative App session ref replay variable"
                : "Missing workflow-hole run ID replay variable",
          },
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
        statusCode: 500,
        statusMessage: "Missing Replay Variable",
      });
      // Bug 根因：artifact 写入改为异步后，这个 fail-closed 分支仍然 fire-and-forget；
      // Windows 原子替换最终失败时 rejection 会逃出统一 handler catch。返回前等待，
      // 让诊断落盘失败按请求生命周期收口，且不覆盖已经返回的 500 业务证据。
      await context.writeArtifact();
      return;
    }
    await writeResponse(response, record, {
      body: resolvedBody.body,
      chunks: fixture.response.chunks,
      closeMode: fixture.response.closeMode,
      ...(fixture.response.releaseAfterChunks === undefined
        ? {}
        : {
            releaseAfterChunks: fixture.response.releaseAfterChunks,
            release: () => {
              if (fixture.metadata?.timingPolicy !== "controlled-stream")
                throw new Error("仅 controlled-stream 允许显式释放");
              return context.holdStream(fixture.id, response);
            },
          }),
      headers: resolvedBody.headers,
      statusCode: fixture.response.statusCode,
      statusMessage: fixture.response.statusMessage ?? "OK",
    });
  }
  if (fixture.replay?.consumeOnce) {
    context.fixtures.splice(fixtureIndex, 1);
  }
  await context.writeArtifact();
}

function closeReplayResponseAfterHandlerError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[upstream-replay] request handler failed: ${message}`);
  if (response.writableEnded || response.destroyed) {
    return;
  }
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const body = JSON.stringify({
    error: { message: `Upstream E2E replay handler failed: ${message}` },
  });
  response.writeHead(500, "Replay Handler Failed", {
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function resolveFixtureResponseBody(
  response: UpstreamReplayFixture["response"],
  variables: ReplayVariables,
  streaming: boolean,
): { body: string; headers: Record<string, string> } {
  if (response.body !== undefined) {
    return {
      body: applyReplayVariablesToString(response.body, variables),
      headers: response.headers ?? {},
    };
  }

  // 修复原因：fixture 的 text/toolUse 简写过去一律渲染为 SSE。标题等 sidecar 请求
  // 不带 stream:true，真实协议返回 application/json；继续回 SSE 会被回放审计记为
  // titleResponseFormatErrors。按请求的 stream 属性决定响应格式。
  // chunks 是录制/受控流的原始字节，存在时必须保持流式，不能被请求属性改写。
  const streamBody = streaming || (response.chunks?.length ?? 0) > 0;
  const responseHeaders = streamBody
    ? withEventStreamHeaders(response.headers)
    : withJsonHeaders(response.headers);

  if (response.toolUses?.length) {
    const toolUses = response.toolUses.map((toolUse) => resolveReplayToolUse(toolUse, variables));
    return {
      body: streamBody ? buildToolUsesSseBody(toolUses) : buildToolUsesMessageBody(toolUses),
      headers: responseHeaders,
    };
  }

  if (response.toolUse) {
    const toolUse = resolveReplayToolUse(response.toolUse, variables);
    return {
      body: streamBody ? buildToolUseSseBody(toolUse) : buildToolUsesMessageBody([toolUse]),
      headers: responseHeaders,
    };
  }

  if (response.text !== undefined) {
    const text = resolveReplayText(response.text, variables);
    return {
      body: streamBody ? buildTextSseBody(text) : buildTextMessageBody(text),
      headers: responseHeaders,
    };
  }

  return {
    body: "",
    headers: response.headers ?? {},
  };
}

function isStreamingRequest(requestJson: unknown): boolean {
  return (
    typeof requestJson === "object" &&
    requestJson !== null &&
    (requestJson as { stream?: unknown }).stream === true
  );
}

function extractReplayVariables(requestText: string, requestJson: unknown): ReplayVariables {
  const requestContent = `${requestText}\n${JSON.stringify(requestJson ?? {})}`;
  const browserTabIds = readLatestBrowserTabIds(requestJson);
  return {
    appControlTargetRef: readAppControlTargetRef(requestContent, requestJson),
    appControlResults: readAppControlResults(requestJson),
    browserFixtureUrl: readBrowserFixtureUrl(requestContent),
    ...browserTabIds,
    latestAgentId: readLatestAgentId(requestContent),
    latestBashTaskId: readLatestBashTaskId(requestContent),
    memoryRoot: readMemoryRoot(requestContent),
    latestAutomationId: readLatestAutomationId(requestJson),
    // Workflow run ID 由真实工具生成；只取最新留白通知，不能把随机 ID 写死在夹具中。
    latestWorkflowRunId: [
      ...requestContent.matchAll(/<workflow-hole>[\s\S]*?<run-id>([^<]+)<\/run-id>/gu),
    ].at(-1)?.[1],
    // 升级问题 id（`dwfq-…`）同样由真实 run 生成；只取最新的 `<workflow-escalation>` 通知。
    latestWorkflowQuestionId: [
      ...requestContent.matchAll(
        /<workflow-escalation>[\s\S]*?<question-id>([^<]+)<\/question-id>/gu,
      ),
    ].at(-1)?.[1],
  };
}

/** SCT 生命周期只解析指定工具的结构化成功结果，不能从提示词拼造 ref 或 operation。 */
function readAppControlResults(request: unknown): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  const messages = (request as { messages?: Array<{ role?: string; content?: unknown }> })
    ?.messages;
  for (const message of messages ?? []) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block?.type !== "tool_result" ||
        block.is_error ||
        !/^toolu_sct\d+_/u.test(block.tool_use_id)
      )
        continue;
      const text =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((part: { type?: string }) => part?.type === "text")
                .map((part: { text: string }) => part.text)
                .join("\n")
            : "";
      try {
        results[block.tool_use_id] = JSON.parse(text);
      } catch {
        /* 不猜测非结构化结果。 */
      }
    }
  }
  return results;
}

/** SCT 用例只从真实工具结果取得完整 ref；用户 marker 仅选择 sessionId，不构造授权字段。 */
function readAppControlTargetRef(
  text: string,
  request: unknown,
): Record<string, unknown> | undefined {
  const sessionId = text.match(/E2E_SCT(?:03|07)_TARGET_SESSION_ID:([A-Za-z0-9_-]+)/u)?.[1];
  if (!sessionId || !request || typeof request !== "object") return;
  const messages = (request as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages)) return;
  let ref: Record<string, unknown> | undefined;
  const inspectResult = (value: unknown): void => {
    if (typeof value === "string") {
      try {
        inspectResult(JSON.parse(value));
      } catch {
        /* 非结构化结果不猜测引用。 */
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(inspectResult);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (
      node.kind === "app" &&
      node.sessionId === sessionId &&
      typeof node.workspacePath === "string" &&
      typeof node.sourceServerId === "string"
    )
      ref = node;
    for (const child of Object.values(node)) inspectResult(child);
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const row = message as { role?: string; content?: unknown };
    if (row.role === "tool") inspectResult(row.content);
    else if (Array.isArray(row.content)) {
      for (const block of row.content) {
        if (block && typeof block === "object" && block.type === "tool_result")
          inspectResult(block.content);
      }
    }
  }
  return ref;
}

function readLatestBrowserTabIds(
  value: unknown,
): Pick<ReplayVariables, "latestBrowserTabAId" | "latestBrowserTabBId" | "latestBrowserTabId"> {
  const ids = {
    e2eBrowserTabAId: [] as string[],
    e2eBrowserTabBId: [] as string[],
    e2eBrowserTabId: [] as string[],
  };
  const names = Object.keys(ids) as Array<keyof typeof ids>;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      // Bug 根因：真实 Node REPL tool_result 是 `=> { ... }\nStructured content:`，
      // 不是可直接 JSON.parse 的纯 JSON；只解析带 E2E 命名空间的显式字段，避免
      // 从任意 tab 文本猜 id，让 replay 真正模拟模型读取上一条工具结果。
      for (const name of names) {
        const pattern = new RegExp(`["']${name}["']\\s*:\\s*["']([^"']+)["']`, "gu");
        for (const match of candidate.matchAll(pattern)) {
          if (match[1]?.trim()) ids[name].push(match[1].trim());
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (names.includes(key as keyof typeof ids) && typeof child === "string" && child.trim()) {
        ids[key as keyof typeof ids].push(child.trim());
      }
      visit(child);
    }
  };

  visit(value);
  return {
    latestBrowserTabAId: ids.e2eBrowserTabAId.at(-1),
    latestBrowserTabBId: ids.e2eBrowserTabBId.at(-1),
    latestBrowserTabId: ids.e2eBrowserTabId.at(-1),
  };
}

function readBrowserFixtureUrl(value: string): string | undefined {
  // 修复原因：Browser Use E2E 的本地 HTTP server 使用随机端口，provider replay
  // 必须从用户 marker 回填真实 URL，不能依赖固定端口或公网页面制造并发/网络抖动。
  const match = value.match(
    /E2E_BROWSER_FIXTURE_URL:(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[^\s"'<>),]*)/u,
  );
  return match?.[1];
}

function readLatestAgentId(value: string): string | undefined {
  const matches = [...value.matchAll(/agentId:\s*(agent_[A-Za-z0-9_-]+)/gu)];
  return matches.at(-1)?.[1];
}

function readLatestBashTaskId(value: string): string | undefined {
  // Bash task ID 每次运行都不同；只从真实 launch result 回填，不能把 Agent ID 当作 Bash ID。
  const matches = [
    ...value.matchAll(/Command running in background with ID:\s*([A-Za-z0-9_-]+)\./gu),
  ];
  return matches.at(-1)?.[1];
}

function readMemoryRoot(value: string): string | undefined {
  // Memory root 由 Runtime 按 workspace 计算，fixture 不能硬编码本机绝对路径。
  // 只从已经进入 provider request 的既有 Memory prompt 提取路径并回填 tool input。
  const matches = [
    ...value.matchAll(/persistent(?:,\s*)? file-based memory(?: system)? at `([^`]+?)[/\\]`/giu),
  ];
  return matches.at(-1)?.[1];
}

function readLatestAutomationId(value: unknown): string | undefined {
  const ids: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed) as unknown);
          return;
        } catch {
          // tool_result 可能是带前后说明的文本，继续用正则提取其中的 JSON 字段。
        }
      }
      for (const match of candidate.matchAll(
        /["'](?:automationId|automation_id)["']\s*:\s*["']([^"']+)["']/gu,
      )) {
        if (match[1]?.trim()) ids.push(match[1].trim());
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (
        (key === "automationId" || key === "automation_id") &&
        typeof child === "string" &&
        child.trim()
      ) {
        ids.push(child.trim());
      }
      visit(child);
    }
  };

  visit(value);
  return ids.at(-1);
}

function resolveReplayToolUse(
  toolUse: UpstreamReplayToolUseResponse,
  variables: ReplayVariables,
): UpstreamReplayToolUseResponse {
  return {
    ...toolUse,
    id: toolUse.id === undefined ? undefined : applyReplayVariablesToString(toolUse.id, variables),
    input: applyReplayVariables(toolUse.input, variables) as Record<string, unknown>,
    messageId:
      toolUse.messageId === undefined
        ? undefined
        : applyReplayVariablesToString(toolUse.messageId, variables),
  };
}

function resolveReplayText(
  textResponse: UpstreamReplayTextResponse | string,
  variables: ReplayVariables,
): UpstreamReplayTextResponse | string {
  if (typeof textResponse === "string") {
    return applyReplayVariablesToString(textResponse, variables);
  }
  return {
    ...textResponse,
    id:
      textResponse.id === undefined
        ? undefined
        : applyReplayVariablesToString(textResponse.id, variables),
    text: applyReplayVariablesToString(textResponse.text, variables),
  };
}

function applyReplayVariables(value: unknown, variables: ReplayVariables): unknown {
  if (typeof value === "string") {
    // 只在既有工具参数替换点读取 SCT 回执的白名单字段，保留对象类型和完整身份。
    // session.sessionId 用于验证工具的会话 ID 写法：ID 仍取自真实结果，不由夹具拼装。
    const result = value.match(
      /^\{\{appControlResult:(toolu_sct\d+_[A-Za-z0-9_]+)\.(session(?:\.sessionId)?|operation(?:\.commandId)?|projects\.\d+\.project|messages\.(?:\d+|firstAssistant)\.id|nextCursor|summary\.executionId)\}\}$/u,
    );
    if (result) {
      let selected = variables.appControlResults?.[result[1]!];
      for (const key of result[2]!.split(".")) {
        // 历史含 model-only 用户消息，固定下标会误选 fork 点；仅从真实结果按角色取首个 assistant。
        if (key === "firstAssistant" && Array.isArray(selected)) {
          selected = selected.find((message) => message?.role === "assistant");
        } else {
          selected =
            selected && typeof selected === "object" && Object.hasOwn(selected, key)
              ? (selected as Record<string, unknown>)[key]
              : undefined;
        }
      }
      if (selected !== undefined) return selected;
    }
    if (value === "{{appControlTargetRef}}" && variables.appControlTargetRef)
      return variables.appControlTargetRef;
    // 规格 0.11：工具面只收 sessionId，所以目标也只取真实引用里的 ID，仍不允许按标题或路径拼装。
    if (
      value === "{{appControlTargetSessionId}}" &&
      typeof variables.appControlTargetRef?.sessionId === "string"
    )
      return variables.appControlTargetRef.sessionId;
    // SCT07 的显式项目过滤同样复用真实 list 返回的完整引用，不能按路径或标题拼装项目身份。
    if (value === "{{appControlTargetProjectRef}}" && variables.appControlTargetRef?.project)
      return variables.appControlTargetRef.project;
    return applyReplayVariablesToString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyReplayVariables(item, variables));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, applyReplayVariables(child, variables)]),
  );
}

function applyReplayVariablesToString(value: string, variables: ReplayVariables): string {
  let resolved = value;
  if (variables.latestBrowserTabId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabId);
  }
  if (variables.latestBrowserTabAId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_A_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabAId);
  }
  if (variables.latestBrowserTabBId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_B_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabBId);
  }
  if (variables.latestAgentId !== undefined) {
    resolved = resolved.split(LATEST_AGENT_ID_REPLAY_TOKEN).join(variables.latestAgentId);
  }
  if (variables.latestBashTaskId !== undefined) {
    resolved = resolved.split(LATEST_BASH_TASK_ID_REPLAY_TOKEN).join(variables.latestBashTaskId);
  }
  if (variables.memoryRoot !== undefined) {
    resolved = resolved.split(MEMORY_ROOT_REPLAY_TOKEN).join(variables.memoryRoot);
  }
  if (variables.latestAutomationId !== undefined) {
    resolved = resolved.split(LATEST_AUTOMATION_ID_REPLAY_TOKEN).join(variables.latestAutomationId);
  }
  if (variables.latestWorkflowRunId !== undefined) {
    resolved = resolved
      .split(LATEST_WORKFLOW_RUN_ID_REPLAY_TOKEN)
      .join(variables.latestWorkflowRunId);
  }
  if (variables.latestWorkflowQuestionId !== undefined) {
    resolved = resolved
      .split(LATEST_WORKFLOW_QUESTION_ID_REPLAY_TOKEN)
      .join(variables.latestWorkflowQuestionId);
  }
  if (variables.browserFixtureUrl !== undefined) {
    resolved = resolved.split(BROWSER_FIXTURE_URL_REPLAY_TOKEN).join(variables.browserFixtureUrl);
  }
  return resolved;
}

function withEventStreamHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
    ...headers,
  };
}

function withJsonHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  // 非流式响应的 content-type 必须是权威值；fixture 的 SSE headers 不能带进 JSON 响应。
  return {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  };
}

function buildToolUseSseBody(toolUse: UpstreamReplayToolUseResponse): string {
  return buildToolUsesSseBody([toolUse]);
}

function buildToolUsesSseBody(toolUses: UpstreamReplayToolUseResponse[]): string {
  const firstToolUse = toolUses[0];
  const messageId = firstToolUse?.messageId ?? `msg_${sanitizeSseId(firstToolUse?.name ?? "tool")}`;
  const inputTokens = firstToolUse?.inputTokens;
  const outputTokens = toolUses.reduce((sum, toolUse) => sum + (toolUse.outputTokens ?? 16), 0);
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: firstToolUse?.model ?? DEFAULT_REPLAY_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: replayUsage(inputTokens, 0),
      },
    }),
    ...toolUses.flatMap((toolUse, index) => buildToolUseContentBlockEvents(toolUse, index)),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: replayUsage(inputTokens, outputTokens),
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function buildToolUseContentBlockEvents(
  toolUse: UpstreamReplayToolUseResponse,
  index: number,
): string[] {
  const toolCallId = toolUse.id ?? `toolu_${sanitizeSseId(toolUse.name)}`;
  const inputJson = JSON.stringify(toolUse.input);
  return [
    sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolCallId,
        name: toolUse.name,
        input: {},
      },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: inputJson,
      },
    }),
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }),
  ];
}

function buildTextSseBody(textResponse: UpstreamReplayTextResponse | string): string {
  const text = typeof textResponse === "string" ? textResponse : textResponse.text;
  const id =
    typeof textResponse === "string"
      ? "msg_upstream_e2e_text"
      : (textResponse.id ?? "msg_upstream_e2e_text");
  const model =
    typeof textResponse === "string"
      ? DEFAULT_REPLAY_MODEL
      : (textResponse.model ?? DEFAULT_REPLAY_MODEL);
  const inputTokens = typeof textResponse === "string" ? undefined : textResponse.inputTokens;
  const outputTokens = typeof textResponse === "string" ? undefined : textResponse.outputTokens;

  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: replayUsage(inputTokens, 0),
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    }),
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: replayUsage(inputTokens, outputTokens ?? 12),
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function buildToolUsesMessageBody(toolUses: UpstreamReplayToolUseResponse[]): string {
  const firstToolUse = toolUses[0];
  const messageId = firstToolUse?.messageId ?? `msg_${sanitizeSseId(firstToolUse?.name ?? "tool")}`;
  const inputTokens = firstToolUse?.inputTokens;
  const outputTokens = toolUses.reduce((sum, toolUse) => sum + (toolUse.outputTokens ?? 16), 0);
  return JSON.stringify({
    id: messageId,
    type: "message",
    role: "assistant",
    model: firstToolUse?.model ?? DEFAULT_REPLAY_MODEL,
    content: toolUses.map((toolUse) => ({
      type: "tool_use",
      id: toolUse.id ?? `toolu_${sanitizeSseId(toolUse.name)}`,
      name: toolUse.name,
      input: toolUse.input,
    })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: replayUsage(inputTokens, outputTokens),
  });
}

function buildTextMessageBody(textResponse: UpstreamReplayTextResponse | string): string {
  const text = typeof textResponse === "string" ? textResponse : textResponse.text;
  const id =
    typeof textResponse === "string"
      ? "msg_upstream_e2e_text"
      : (textResponse.id ?? "msg_upstream_e2e_text");
  const model =
    typeof textResponse === "string"
      ? DEFAULT_REPLAY_MODEL
      : (textResponse.model ?? DEFAULT_REPLAY_MODEL);
  const inputTokens = typeof textResponse === "string" ? undefined : textResponse.inputTokens;
  const outputTokens = typeof textResponse === "string" ? undefined : textResponse.outputTokens;
  return JSON.stringify({
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: replayUsage(inputTokens, outputTokens ?? 12),
  });
}

function replayUsage(inputTokens = 128, outputTokens = 0) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: outputTokens,
    service_tier: "standard",
  };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sanitizeSseId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function writeResponse(
  response: ServerResponse,
  record: MutableCaptureRecord,
  fixtureResponse: {
    body: string;
    chunks?: UpstreamReplayResponseChunk[];
    closeMode?: UpstreamReplayCloseMode;
    releaseAfterChunks?: number | number[];
    release?: () => Promise<void>;
    headers: Record<string, string>;
    statusCode: number;
    statusMessage: string;
  },
) {
  const responseChunks = normalizeReplayChunks(fixtureResponse.chunks);
  const destroyStream = fixtureResponse.closeMode === "destroy";
  // 同时带 text/chunks 的 fixture 实际发送 chunks，证据也必须记录真正发出的字节。
  const responseBody =
    responseChunks.length > 0
      ? Buffer.concat(responseChunks.map((chunk) => chunk.body))
      : Buffer.from(fixtureResponse.body, "utf-8");
  const responseHeaders = sanitizeResponseHeaders(fixtureResponse.headers);
  if (responseChunks.length === 0 && !destroyStream) {
    responseHeaders["content-length"] = String(responseBody.length);
  } else {
    delete responseHeaders["content-length"];
  }
  response.writeHead(fixtureResponse.statusCode, fixtureResponse.statusMessage, responseHeaders);
  let actualOffsets: number[] | undefined;
  if (responseChunks.length > 0) {
    // 边界已在加载时统一校验；同一响应逐段创建 gate，释放前一段不预放行后一段。
    actualOffsets = await writeReplayChunks(response, responseChunks, fixtureResponse);
    if (!destroyStream) response.end();
  } else if (destroyStream) {
    await writeResponseChunk(response, responseBody);
  } else {
    response.end(responseBody);
  }

  record.status = destroyStream ? "error" : "complete";
  record.completedAt = new Date().toISOString();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  record.statusCode = fixtureResponse.statusCode;
  record.statusMessage = fixtureResponse.statusMessage;
  record.responseBodyBytes = responseBody.length;
  record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(responseHeaders);
  record.responseTextPreview = redactE2ENetworkCaptureJsonText(responseBody.toString("utf-8"));
  if (responseChunks.length > 0) {
    record.responseChunkTimeline = responseChunks.map((chunk, index) => ({
      base64: chunk.body.toString("base64"),
      byteLength: chunk.byteLength,
      offsetMs: fixtureResponse.release ? actualOffsets![index]! : chunk.offsetMs,
    }));
  }
  if (destroyStream) {
    // chunks/body 与 events 必须执行相同的故障合同；只在 artifact 标 destroy
    // 却正常 end 会把网络中断测试变成正常 EOF，并制造“产品假完成”的错误结论。
    record.error = "Replay fixture destroyed SSE response stream";
    response.destroy();
  }
}

async function writeReplayChunks(
  response: ServerResponse,
  chunks: NormalizedReplayChunk[],
  control?: { releaseAfterChunks?: number | number[]; release?: () => Promise<void> },
) {
  let previousOffsetMs = 0;
  const startedAt = Date.now();
  const actualOffsets: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const boundary = control?.releaseAfterChunks;
    if (
      (Array.isArray(boundary) ? boundary.includes(index) : index === boundary) &&
      control?.release
    ) {
      await control.release();
      // 只移除被释放的那段人为慢窗口，后续 chunk 间距及内容原样保留。
      previousOffsetMs = chunk.offsetMs;
    }
    const delayMs = Math.max(0, chunk.offsetMs - previousOffsetMs);
    if (delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    previousOffsetMs = chunk.offsetMs;
    actualOffsets.push(Date.now() - startedAt);
    // 等待写入完成后再进入下一帧/销毁连接，避免最后一帧只进用户态队列就被丢弃。
    await writeResponseChunk(response, chunk.body);
  }
  return actualOffsets;
}

interface NormalizedReplayChunk {
  body: Buffer;
  byteLength: number;
  offsetMs: number;
}

function normalizeReplayChunks(
  chunks: UpstreamReplayResponseChunk[] | undefined,
): NormalizedReplayChunk[] {
  return (
    chunks
      ?.map((chunk) => {
        const body =
          chunk.base64 !== undefined
            ? Buffer.from(chunk.base64, "base64")
            : Buffer.from(chunk.text ?? "", "utf-8");
        return {
          body,
          byteLength: chunk.byteLength ?? body.length,
          offsetMs: Math.max(0, Math.round(chunk.offsetMs)),
        };
      })
      .filter((chunk) => chunk.body.length > 0) ?? []
  );
}

async function writeEventStreamResponse(
  response: ServerResponse,
  record: MutableCaptureRecord,
  fixtureResponse: {
    closeMode: UpstreamReplayCloseMode;
    events: E2ENetworkCaptureResponseEvent[];
    headers: Record<string, string>;
    statusCode: number;
    statusMessage: string;
  },
) {
  const responseHeaders = sanitizeResponseHeaders(fixtureResponse.headers);
  delete responseHeaders["content-length"];
  response.writeHead(fixtureResponse.statusCode, fixtureResponse.statusMessage, responseHeaders);

  const startedAtMs = Date.now();
  const sortedEvents = [...fixtureResponse.events].sort(
    (left, right) => left.offsetMs - right.offsetMs || left.sequence - right.sequence,
  );
  const chunks: string[] = [];
  const replayedEvents: E2ENetworkCaptureResponseEvent[] = [];

  for (const event of sortedEvents) {
    const elapsedMs = Date.now() - startedAtMs;
    const waitMs = Math.max(0, event.offsetMs - elapsedMs);
    if (waitMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    }

    const text = event.text;
    await writeResponseChunk(response, text);
    chunks.push(text);
    replayedEvents.push({
      byteLength: Buffer.byteLength(text, "utf-8"),
      offsetMs: Math.max(0, Date.now() - startedAtMs),
      ...(event.partial ? { partial: true } : {}),
      sequence: replayedEvents.length,
      text,
    });
  }

  const body = chunks.join("");
  record.status = fixtureResponse.closeMode === "destroy" ? "error" : "complete";
  record.completedAt = new Date().toISOString();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  record.statusCode = fixtureResponse.statusCode;
  record.statusMessage = fixtureResponse.statusMessage;
  record.responseBodyBytes = Buffer.byteLength(body, "utf-8");
  record.responseEvents = replayedEvents;
  record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(responseHeaders);
  record.responseTextPreview = redactE2ENetworkCaptureJsonText(body);
  record.replay = {
    ...record.replay,
    closeMode: fixtureResponse.closeMode,
  };

  if (fixtureResponse.closeMode === "destroy") {
    // 修复原因：SSE fault case 需要区分“provider 正常 EOF 但内容不完整”和
    // “连接在流式响应中异常断开”。这里按 fixture 显式销毁 socket，artifact 也标记为 error，
    // 让后续 E2E 能稳定构造断流语义，而不是依赖真实网络抖动。
    record.error = "Replay fixture destroyed SSE response stream";
    response.destroy();
    return;
  }

  response.end();
}

function writeResponseChunk(response: ServerResponse, text: string | Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    response.write(text, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

function findFixtureIndex(
  fixtures: UpstreamReplayFixture[],
  record: E2ENetworkCaptureRecord,
  requestText: string,
  requestJson: unknown,
  fixtureMatchCounts: ReadonlyMap<string, number>,
) {
  return fixtures.findIndex((fixture) => {
    // 回放需要表达“同一类请求前 N 次失败、之后成功”的时序。
    // maxMatches 只影响测试 fixture 匹配，不进入产品协议。
    if (
      fixture.maxMatches !== undefined &&
      (fixtureMatchCounts.get(fixture.id) ?? 0) >= fixture.maxMatches
    ) {
      return false;
    }

    const expectedMethod = fixture.match.method?.toUpperCase();
    if (expectedMethod && expectedMethod !== record.method.toUpperCase()) {
      return false;
    }
    if (fixture.match.pathIncludes && !record.path.includes(fixture.match.pathIncludes)) {
      return false;
    }

    const latestUserMessageText =
      fixture.match.lastUserMessageIncludes || fixture.match.lastUserMessageExcludes
        ? readLatestUserMessageText(requestJson)
        : "";

    return (
      (fixture.match.bodyIncludes?.every(
        (text) => requestText.includes(text) || captureContainsText(requestJson, text),
      ) ??
        true) &&
      (fixture.match.bodyExcludes?.every(
        (text) => !requestText.includes(text) && !captureContainsText(requestJson, text),
      ) ??
        true) &&
      (fixture.match.lastUserMessageIncludes?.every((text) =>
        latestUserMessageText.includes(text),
      ) ??
        true) &&
      (fixture.match.lastUserMessageExcludes?.every(
        (text) => !latestUserMessageText.includes(text),
      ) ??
        true)
    );
  });
}

function readLatestUserMessageText(requestJson: unknown): string {
  if (!requestJson || typeof requestJson !== "object") {
    return "";
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: unknown }).role !== "user") {
      continue;
    }
    return readMessageContentText((message as { content?: unknown }).content);
  }
  return "";
}

function readMessageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      // 修复原因：Anthropic Messages continuation 把工具结果放在 user/tool_result.content，
      // 旧实现只读 text，导致 fixture 只能在整段 body 搜 marker；而 tool code 本身
      // 也包含成功 marker，会把真实失败结果误匹配成成功 continuation。
      if ((part as { type?: unknown }).type === "tool_result") {
        return readMessageContentText((part as { content?: unknown }).content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function loadFixtureFile(
  path: string,
  fixtureVariables: Readonly<Record<string, string>> = {},
): UpstreamReplayFixture[] {
  const resolvedPath = resolve(path);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf-8")) as
    | UpstreamReplayFixtureFile
    | E2ENetworkCaptureArtifact;
  if (isUpstreamReplayFixtureFile(parsed)) {
    return applyFixtureVariables(parsed.fixtures, fixtureVariables) as UpstreamReplayFixture[];
  }
  if (isNetworkCaptureArtifact(parsed)) {
    return applyFixtureVariables(
      convertCaptureArtifactToFixtures(parsed, resolvedPath),
      fixtureVariables,
    ) as UpstreamReplayFixture[];
  }
  throw new Error(`Invalid Upstream e2e replay fixture: ${path}`);
}

function applyFixtureVariables(
  value: unknown,
  variables: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") {
    return Object.entries(variables).reduce(
      (resolvedValue, [name, replacement]) => resolvedValue.split(`{{${name}}}`).join(replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyFixtureVariables(item, variables));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, applyFixtureVariables(child, variables)]),
  );
}

function isUpstreamReplayFixtureFile(
  value: UpstreamReplayFixtureFile | E2ENetworkCaptureArtifact,
): value is UpstreamReplayFixtureFile {
  return value.version === 1 && Array.isArray((value as UpstreamReplayFixtureFile).fixtures);
}

function isNetworkCaptureArtifact(
  value: UpstreamReplayFixtureFile | E2ENetworkCaptureArtifact,
): value is E2ENetworkCaptureArtifact {
  return value.version === 1 && Array.isArray((value as E2ENetworkCaptureArtifact).records);
}

function convertCaptureArtifactToFixtures(
  artifact: E2ENetworkCaptureArtifact,
  sourcePath: string,
): UpstreamReplayFixture[] {
  const fixtures = artifact.records
    .filter((record) => record.status === "complete" && record.statusCode)
    .filter(
      (record) =>
        record.responseTextPreview ||
        record.responseChunkTimeline?.length ||
        record.responseEvents?.length,
    )
    .map((record, index) => {
      const responseBody = resolveCapturedResponseBody(record);
      return {
        id: `capture-${String(index + 1).padStart(3, "0")}-${record.id}`,
        description: `Captured replay response from ${sourcePath}`,
        match: {
          method: record.method,
          pathIncludes: capturePathname(record),
        },
        replay: {
          consumeOnce: true,
        },
        captured: {
          capturedAt: record.completedAt ?? record.startedAt,
          requestBodyBytes: record.requestBodyBytes,
          responseBodyBytes: record.responseBodyBytes,
          statusCode: record.statusCode,
          url: record.url,
        },
        response: {
          body: responseBody,
          chunks: record.responseChunkTimeline?.map(captureChunkToReplayChunk),
          events: record.responseEvents,
          headers: record.responseHeaders,
          statusCode: record.statusCode ?? 200,
          statusMessage: record.statusMessage,
        },
      } satisfies UpstreamReplayFixture;
    });

  if (fixtures.length === 0) {
    throw new Error(`Upstream capture artifact has no replayable records: ${sourcePath}`);
  }
  return fixtures;
}

function resolveCapturedResponseBody(record: E2ENetworkCaptureRecord) {
  if (record.responseTextPreview && !record.responseBodyTruncated) {
    return record.responseTextPreview;
  }
  if (record.responseEvents?.length) {
    return record.responseEvents.map((event) => event.text).join("");
  }
  if (record.responseChunkTimeline?.length && !record.responseChunkTimelineTruncated) {
    return Buffer.concat(
      record.responseChunkTimeline.map((chunk) => Buffer.from(chunk.base64, "base64")),
    ).toString("utf-8");
  }
  return record.responseTextPreview ?? "";
}

function captureChunkToReplayChunk(chunk: E2ENetworkResponseChunk): UpstreamReplayResponseChunk {
  return {
    base64: chunk.base64,
    byteLength: chunk.byteLength,
    offsetMs: chunk.offsetMs,
  };
}

function capturePathname(record: E2ENetworkCaptureRecord) {
  try {
    return new URL(record.url).pathname;
  } catch {
    return record.path.split("?")[0] || record.path;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildRequestUrl(request: IncomingMessage, baseUrl: string): URL {
  const rawUrl = request.url ?? "/";
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(path, baseUrl);
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "connection" || normalizedName === "transfer-encoding") {
      continue;
    }
    sanitized[normalizedName] = value;
  }
  return sanitized;
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}

function serializeRecord(record: MutableCaptureRecord): E2ENetworkCaptureRecord {
  return record;
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

async function stopServer(
  server: Server,
  closeArtifactWrites: () => Promise<void>,
  writeArtifact: () => Promise<void>,
): Promise<void> {
  await closeServerListener(server);
  // 先停掉后台补写并等在途写入收口，再做最终写入；最终写入失败照常抛出。
  await closeArtifactWrites();
  await writeArtifact();
}

async function closeServerListener(server: Server): Promise<void> {
  await new Promise<void>((resolveStop, rejectStop) => {
    server.close((error) => {
      if (error) {
        rejectStop(error);
        return;
      }
      resolveStop();
    });
  });
}
