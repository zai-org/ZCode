/* eslint-disable max-lines -- 最终出口捕获、按 case 增量切片与 artifact 写入必须共享同一 offset，集中实现避免两套捕获口径漂移。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CONVERSATION_REPORT_EVENT_NAMES = [
  "send_btn",
  "agent_step",
  "message_completion",
  "context_compaction",
  "assistant_message_feedback",
] as const;

export const CONVERSATION_ARMS_EVENT_NAMES = [
  "plan_request",
  "plan_ttft",
  "perf_ui_first_token",
  "perf_ui_message_complete",
  "perf_ui_turn_breakdown",
  "perf_ui_stream_stall",
  "perf_ui_tool_call_detail",
  "chat_error_banner",
] as const;

type JsonRecord = Record<string, unknown>;
type FinalArmsCaptureMode = "bridge" | "legacy-file";

export type ConversationTelemetryReport = JsonRecord;

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

export interface ConversationTelemetryParityCapture {
  version: 1;
  caseId: string;
  eventReport: JsonRecord[];
  armsRenderer?: ArmsCustomEventPayload[];
  armsFinal: JsonRecord[];
  proof?: string[];
  captureStages: {
    eventReport: "http-final";
    armsRenderer?: "renderer-pre-ipc";
    armsFinal: "main-send-custom";
  };
}

/** Main 进程 net.fetch 的调用记录；只保留 URL 与字符串 body，足够解析 /event/report。 */
export interface TelemetryFetchRecorder {
  mock: { calls: Array<[string, { body?: string }]> };
  update(): Promise<void>;
  mockClear(): Promise<void>;
}

export interface ConversationTelemetryCaptureHandle {
  telemetryFetch: TelemetryFetchRecorder;
  finalArmsCaptureMode: FinalArmsCaptureMode;
  reportOffset: number;
  rendererArmsOffset: number;
  finalArmsOffset: number;
}

/**
 * 在当前 Main 进程安装 net.fetch 记录器，并清空旧记录。
 *
 * Bug 根因：wdio-electron-service 的 mock 登记在 worker 进程，Main 重启（restartInto* /
 * reloadSession）后新进程里的 net.fetch 已是真函数，但 `browser.electron.mock("net", "fetch")`
 * 仍返回旧登记；其 mockReset / mockResolvedValue 经 CDP 在新进程抛错，被 wdio 静默吞掉，
 * 之后真实请求直接出网、一条都记不到（background 的 4 个 case 增量恒为 `{}`）。
 * 修法：记录器直接装在当前 Main 进程，每次 begin 都按当前进程重装/清空，不依赖 wdio mock 登记。
 */
async function installTelemetryFetchRecorder(): Promise<TelemetryFetchRecorder> {
  await browser.electron.execute((electron) => {
    type Recorded = [string, { body?: string }];
    type RecordingFetch = ((input: unknown, init?: { body?: unknown }) => Promise<unknown>) & {
      __zcodeTelemetryRecorder?: true;
    };
    const host = globalThis as typeof globalThis & {
      __zcodeTelemetryFetchE2E?: { calls: Recorded[] };
    };
    const recorder = (host.__zcodeTelemetryFetchE2E ??= { calls: [] });
    recorder.calls.length = 0;
    const net = electron.net as unknown as { fetch: RecordingFetch };
    if (net.fetch.__zcodeTelemetryRecorder) return;
    const recording: RecordingFetch = (input, init) => {
      recorder.calls.push([
        String(input),
        typeof init?.body === "string" ? { body: init.body } : {},
      ]);
      return Promise.resolve({ ok: true, status: 204 });
    };
    recording.__zcodeTelemetryRecorder = true;
    net.fetch = recording;
  });
  const recorder: TelemetryFetchRecorder = {
    mock: { calls: [] },
    async update() {
      recorder.mock.calls = await browser.electron.execute(
        () =>
          (
            globalThis as typeof globalThis & {
              __zcodeTelemetryFetchE2E?: { calls: Array<[string, { body?: string }]> };
            }
          ).__zcodeTelemetryFetchE2E?.calls ?? [],
      );
    },
    async mockClear() {
      await browser.electron.execute(() => {
        const host = globalThis as typeof globalThis & {
          __zcodeTelemetryFetchE2E?: { calls: unknown[] };
        };
        if (host.__zcodeTelemetryFetchE2E) host.__zcodeTelemetryFetchE2E.calls.length = 0;
      });
      recorder.mock.calls = [];
    },
  };
  return recorder;
}

export async function beginConversationTelemetryCapture(): Promise<ConversationTelemetryCaptureHandle> {
  const telemetryFetch = await installTelemetryFetchRecorder();
  const finalArmsCaptureMode = await prepareArmsCapture();
  return {
    telemetryFetch,
    finalArmsCaptureMode,
    reportOffset: 0,
    rendererArmsOffset: 0,
    finalArmsOffset: 0,
  };
}

/**
 * 同一个 Electron 实例中按 case 截取最终出口增量。预期为零的 case 也会等待稳定窗口后保存空数组，
 * 避免“整场 inventory 一样”掩盖 background/reload/recovery 意外补报。
 */
export async function checkpointConversationTelemetryCase(
  handle: ConversationTelemetryCaptureHandle,
  options: {
    caseId: string;
    minimumArmsInventory: Record<string, number>;
    minimumReportInventory: Record<string, number>;
    proof: string[];
  },
): Promise<ConversationTelemetryParityCapture> {
  const eventReport = await waitForReportDelta(handle, options.minimumReportInventory);
  const armsRenderer =
    handle.finalArmsCaptureMode === "bridge"
      ? await waitForRendererArmsDelta(handle, options.minimumArmsInventory)
      : undefined;
  const expectedFinalInventory = armsRenderer
    ? inventory(armsRenderer, "name")
    : options.minimumArmsInventory;
  const armsFinal = await waitForFinalArmsDelta(handle, expectedFinalInventory);
  const artifact: ConversationTelemetryParityCapture = {
    version: 1,
    caseId: options.caseId,
    eventReport,
    ...(armsRenderer ? { armsRenderer } : {}),
    armsFinal,
    proof: options.proof,
    captureStages: {
      eventReport: "http-final",
      ...(armsRenderer ? { armsRenderer: "renderer-pre-ipc" as const } : {}),
      armsFinal: "main-send-custom",
    },
  };
  await writeParityCaseArtifact(artifact);
  return artifact;
}

export async function finishConversationTelemetryCapture(
  handle: ConversationTelemetryCaptureHandle,
  options: {
    caseId: string;
    minimumArmsInventory: Record<string, number>;
    minimumReportInventory: Record<string, number>;
  },
): Promise<ConversationTelemetryParityCapture> {
  const eventReport = await waitForTargetReportRequests(
    handle.telemetryFetch,
    options.minimumReportInventory,
  );
  const armsRenderer =
    handle.finalArmsCaptureMode === "bridge"
      ? await waitForTargetRendererArms(options.minimumArmsInventory)
      : undefined;
  const expectedFinalInventory = armsRenderer
    ? inventory(armsRenderer, "name")
    : options.minimumArmsInventory;
  const armsFinal = await waitForTargetFinalArms(
    handle.finalArmsCaptureMode,
    expectedFinalInventory,
  );
  const artifact: ConversationTelemetryParityCapture = {
    version: 1,
    caseId: options.caseId,
    eventReport,
    ...(armsRenderer ? { armsRenderer } : {}),
    armsFinal,
    captureStages: {
      eventReport: "http-final",
      ...(armsRenderer ? { armsRenderer: "renderer-pre-ipc" as const } : {}),
      armsFinal: "main-send-custom",
    },
  };
  await writeParityArtifact(artifact);
  return artifact;
}

export async function waitForConversationReportInventory(
  handle: ConversationTelemetryCaptureHandle,
  minimumInventory: Record<string, number>,
): Promise<JsonRecord[]> {
  return waitForTargetReportRequests(handle.telemetryFetch, minimumInventory);
}

export async function waitForConversationReportDelta(
  handle: ConversationTelemetryCaptureHandle,
  minimumInventory: Record<string, number>,
): Promise<ConversationTelemetryReport[]> {
  return waitForReportDelta(handle, minimumInventory);
}

export async function readConversationReportRequests(
  handle: ConversationTelemetryCaptureHandle,
): Promise<ConversationTelemetryReport[]> {
  return readTargetReportRequests(handle.telemetryFetch);
}

/** 当前已发出的全部 /event/report 请求，不按对话 parity 事件名过滤（含 conversation_rewind 等新事件）。 */
export async function readAllEventReportRequests(
  handle: ConversationTelemetryCaptureHandle,
): Promise<ConversationTelemetryReport[]> {
  await handle.telemetryFetch.update();
  return handle.telemetryFetch.mock.calls
    .map((call) => parseTelemetryRequest(call))
    .filter((request): request is JsonRecord => request !== null);
}

async function prepareArmsCapture(): Promise<FinalArmsCaptureMode> {
  const hasFinalBridge = await browser.execute(
    async (targetArmsEvents) => {
      type DebugWindow = Window & {
        __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
        __zcodeFinalArmsCustomEventsE2E?: {
          clear(): Promise<void>;
          configure(request: { suppressedEventNames: string[] }): Promise<void>;
        };
      };
      const host = window as DebugWindow;
      host.__zcodeArmsCustomEventsE2E = [];
      const finalBridge = host.__zcodeFinalArmsCustomEventsE2E;
      if (!finalBridge) return false;
      await finalBridge.clear();
      await finalBridge.configure({ suppressedEventNames: [...targetArmsEvents] });
      return true;
    },
    [...CONVERSATION_ARMS_EVENT_NAMES],
  );
  if (hasFinalBridge) return "bridge";
  if (!process.env.ZCODE_TELEMETRY_PARITY_LEGACY_ARMS_PATH?.trim()) {
    throw new Error("旧版缺少 main sendCustom 临时捕获路径，已在发送前停止");
  }
  return "legacy-file";
}

async function waitForTargetReportRequests(
  telemetryFetch: ConversationTelemetryCaptureHandle["telemetryFetch"],
  minimumInventory: Record<string, number>,
): Promise<JsonRecord[]> {
  let latest: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      await telemetryFetch.update();
      latest = telemetryFetch.mock.calls
        .map((call) => parseTelemetryRequest(call))
        .filter((request): request is JsonRecord => request !== null)
        .filter((request) =>
          CONVERSATION_REPORT_EVENT_NAMES.includes(String(request.element_name) as never),
        );
      return inventoryContains(inventory(latest, "element_name"), minimumInventory);
    },
    {
      timeout: 30000,
      timeoutMsg: `最终 /event/report 没有达到最低事件集合 ${JSON.stringify(minimumInventory)}`,
    },
  );
  // 旧版 terminal 的 agent_step/completion 是两个 fire-and-forget 请求；最低集合刚满足时
  // 仍可能有同一轮的另一请求在途，短暂等待后再取最终快照，避免把调度差异当成口径差异。
  await browser.pause(1000);
  await telemetryFetch.update();
  return telemetryFetch.mock.calls
    .map((call) => parseTelemetryRequest(call))
    .filter((request): request is JsonRecord => request !== null)
    .filter((request) =>
      CONVERSATION_REPORT_EVENT_NAMES.includes(String(request.element_name) as never),
    );
}

async function waitForTargetRendererArms(
  minimumInventory: Record<string, number>,
): Promise<ArmsCustomEventPayload[]> {
  let latest: ArmsCustomEventPayload[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readTargetRendererArms();
      return inventoryContains(inventory(latest, "name"), minimumInventory);
    },
    {
      timeout: 30000,
      timeoutMsg: `renderer ARMS 没有达到最低事件集合 ${JSON.stringify(minimumInventory)}`,
    },
  );
  return latest;
}

async function readTargetRendererArms(): Promise<ArmsCustomEventPayload[]> {
  return browser.execute(
    (targetArmsEvents) => {
      const buffer =
        (
          window as Window & {
            __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
          }
        ).__zcodeArmsCustomEventsE2E ?? [];
      return buffer
        .filter(
          (entry) =>
            (targetArmsEvents as readonly string[]).includes(entry.name) &&
            (entry.name !== "plan_request" || entry.properties?.ask_mode === "main_turn"),
        )
        .map(({ recordedAt: _recordedAt, ...payload }) => payload);
    },
    [...CONVERSATION_ARMS_EVENT_NAMES],
  );
}

async function waitForReportDelta(
  handle: ConversationTelemetryCaptureHandle,
  minimumInventory: Record<string, number>,
): Promise<JsonRecord[]> {
  let all: JsonRecord[] = [];
  try {
    await browser.waitUntil(
      async () => {
        all = await readTargetReportRequests(handle.telemetryFetch);
        return inventoryContains(
          inventory(all.slice(handle.reportOffset), "element_name"),
          minimumInventory,
        );
      },
      {
        timeout: 15000,
        timeoutMsg: `case /event/report 增量没有达到 ${JSON.stringify(minimumInventory)}`,
      },
    );
  } catch (error) {
    all = await readTargetReportRequests(handle.telemetryFetch);
    const actual = inventory(all.slice(handle.reportOffset), "element_name");
    throw new Error(
      `case /event/report 增量没有达到 ${JSON.stringify(minimumInventory)}，实际为 ${JSON.stringify(actual)}`,
      { cause: error },
    );
  }
  await browser.pause(300);
  all = await readTargetReportRequests(handle.telemetryFetch);
  const delta = all.slice(handle.reportOffset);
  handle.reportOffset = all.length;
  return delta;
}

async function readTargetReportRequests(
  telemetryFetch: ConversationTelemetryCaptureHandle["telemetryFetch"],
): Promise<JsonRecord[]> {
  await telemetryFetch.update();
  return telemetryFetch.mock.calls
    .map((call) => parseTelemetryRequest(call))
    .filter((request): request is JsonRecord => request !== null)
    .filter((request) =>
      CONVERSATION_REPORT_EVENT_NAMES.includes(String(request.element_name) as never),
    );
}

async function waitForRendererArmsDelta(
  handle: ConversationTelemetryCaptureHandle,
  minimumInventory: Record<string, number>,
): Promise<ArmsCustomEventPayload[]> {
  let all: ArmsCustomEventPayload[] = [];
  await browser.waitUntil(
    async () => {
      all = await readTargetRendererArms();
      return inventoryContains(
        inventory(all.slice(handle.rendererArmsOffset), "name"),
        minimumInventory,
      );
    },
    {
      timeout: 15000,
      timeoutMsg: `case renderer ARMS 增量没有达到 ${JSON.stringify(minimumInventory)}`,
    },
  );
  await browser.pause(100);
  all = await readTargetRendererArms();
  const delta = all.slice(handle.rendererArmsOffset);
  handle.rendererArmsOffset = all.length;
  return delta;
}

async function waitForFinalArmsDelta(
  handle: ConversationTelemetryCaptureHandle,
  minimumInventory: Record<string, number>,
): Promise<JsonRecord[]> {
  let all: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      all = await readTargetFinalArms(handle.finalArmsCaptureMode);
      return inventoryContains(
        inventory(all.slice(handle.finalArmsOffset), "name"),
        minimumInventory,
      );
    },
    {
      timeout: 15000,
      timeoutMsg: `case final ARMS 增量没有达到 ${JSON.stringify(minimumInventory)}`,
    },
  );
  await browser.pause(100);
  all = await readTargetFinalArms(handle.finalArmsCaptureMode);
  const delta = all.slice(handle.finalArmsOffset);
  handle.finalArmsOffset = all.length;
  return delta;
}

async function waitForTargetFinalArms(
  mode: FinalArmsCaptureMode,
  minimumInventory: Record<string, number>,
): Promise<JsonRecord[]> {
  let latest: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readTargetFinalArms(mode);
      return inventoryContains(inventory(latest, "name"), minimumInventory);
    },
    {
      timeout: 15000,
      timeoutMsg: `main sendCustom final ARMS 没有达到事件集合 ${JSON.stringify(minimumInventory)}`,
    },
  );
  return latest;
}

async function readTargetFinalArms(mode: FinalArmsCaptureMode): Promise<JsonRecord[]> {
  if (mode === "legacy-file") {
    const capturePath = process.env.ZCODE_TELEMETRY_PARITY_LEGACY_ARMS_PATH?.trim();
    if (!capturePath) return [];
    try {
      const contents = await readFile(capturePath, "utf8");
      return contents
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .filter(isTargetFinalArmsPayload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  return browser.execute(
    async (targetArmsEvents) => {
      const bridge = (
        window as Window & {
          __zcodeFinalArmsCustomEventsE2E?: {
            read(): Promise<Array<{ payload: JsonRecord }>>;
          };
        }
      ).__zcodeFinalArmsCustomEventsE2E;
      if (!bridge) return [];
      const entries = await bridge.read();
      return entries
        .map((entry) => entry.payload)
        .filter(
          (payload) =>
            (targetArmsEvents as readonly string[]).includes(String(payload.name)) &&
            (payload.name !== "plan_request" ||
              (payload.properties as JsonRecord | undefined)?.ask_mode === "main_turn"),
        );
    },
    [...CONVERSATION_ARMS_EVENT_NAMES],
  );
}

function isTargetFinalArmsPayload(payload: unknown): payload is JsonRecord {
  return (
    isRecord(payload) &&
    CONVERSATION_ARMS_EVENT_NAMES.includes(String(payload.name) as never) &&
    (payload.name !== "plan_request" ||
      (payload.properties as JsonRecord | undefined)?.ask_mode === "main_turn")
  );
}

async function writeParityArtifact(artifact: ConversationTelemetryParityCapture): Promise<void> {
  const artifactPath = process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH?.trim();
  if (!artifactPath) return;
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function writeParityCaseArtifact(
  artifact: ConversationTelemetryParityCapture,
): Promise<void> {
  const captureDir = process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_DIR?.trim();
  if (!captureDir) {
    await writeParityArtifact(artifact);
    return;
  }
  const artifactPath = resolve(captureDir, `${artifact.caseId}.capture.raw.json`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function parseTelemetryRequest(call: unknown[]): JsonRecord | null {
  const [input, init] = call;
  if (!String(input ?? "").includes("/api/v1/event/report") || !isRecord(init)) return null;
  if (typeof init.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function telemetryInventory(
  records: Array<JsonRecord | ArmsCustomEventPayload>,
  key: "element_name" | "name",
): Record<string, number> {
  return inventory(records, key);
}

function inventory(
  records: Array<JsonRecord | ArmsCustomEventPayload>,
  key: string,
): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    const value = String((record as JsonRecord)[key]);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function inventoryContains(actual: Record<string, number>, expected: Record<string, number>) {
  return Object.entries(expected).every(([name, count]) => (actual[name] ?? 0) >= count);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
