import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditTelemetryFields } from "#e2e/helpers/conversation-telemetry-parity";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ID = "TDP02";
const FIRST_MARKER = "E2E_AGENT_STEP_MESSAGE_SCOPE_FIRST_";
const SECOND_MARKER = "E2E_AGENT_STEP_MESSAGE_SCOPE_SECOND_";
const FIRST_REPLY = "agent-step-scope-first-ok";
const SECOND_REPLY = "agent-step-scope-second-ok";
const TELEMETRY_REPORT_PATH = "/api/v1/event/report";
const TARGET_REPORT_EVENTS = ["send_btn", "agent_step", "message_completion"] as const;
const TARGET_ARMS_EVENTS = [
  "plan_request",
  "plan_ttft",
  "perf_ui_first_token",
  "perf_ui_message_complete",
  "perf_ui_turn_breakdown",
] as const;

const REPORT_BODY_KEYS = [
  "app_version",
  "client_language",
  "client_timezone",
  "device_mid",
  "device_os_category",
  "device_os_version",
  "element_name",
  "event_extra_detail",
  "event_id",
  "event_region",
  "event_text",
  "event_type",
  "mac_id",
  "marketing_params",
  "message_id",
  "screen_resolution",
  "talk_id",
  "user_id",
] as const;

type JsonRecord = Record<string, unknown>;
type FinalArmsCaptureMode = "bridge" | "legacy-file";

interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

interface TelemetryParityArtifact {
  version: 1;
  caseId: "TDP02";
  eventReport: JsonRecord[];
  armsRenderer?: ArmsCustomEventPayload[];
  armsFinal?: JsonRecord[];
  captureStages: {
    eventReport: "http-final";
    armsRenderer?: "renderer-pre-ipc";
    armsFinal?: "main-send-custom";
  };
}

describe("会话区 Agent Step Message Scope E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("同一 session 两轮完整埋点保持 message 级隔离", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();
    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
    const finalArmsCaptureMode = await prepareArmsCapture();

    const runId = Date.now();
    const firstPrompt = `${FIRST_MARKER}${runId}: Reply with exactly "${FIRST_REPLY}" and no other text.`;
    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "agent step scope 首轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(firstPrompt);
    await waitForUpstreamNetworkCapture(`${FIRST_MARKER}${runId}`);
    await waitForV4AssistantMessageContaining(FIRST_REPLY);
    const firstSnapshot = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "agent step scope 首轮没有完成",
      90000,
    );

    const secondPrompt = `${SECOND_MARKER}${runId}: Reply with exactly "${SECOND_REPLY}" and no other text.`;
    await sendV4Prompt(secondPrompt);
    await waitForV4ComposerText("", "agent step scope 第二轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(secondPrompt);
    await waitForUpstreamNetworkCapture(`${SECOND_MARKER}${runId}`);
    await waitForV4AssistantMessageContaining(SECOND_REPLY);
    const secondSnapshot = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "agent step scope 第二轮没有完成",
      90000,
    );

    expect(secondSnapshot.sessionId || secondSnapshot.taskId).toBe(
      firstSnapshot.sessionId || firstSnapshot.taskId,
    );

    const eventReport = await waitForTargetReportRequests(telemetryFetch);
    const armsRenderer =
      finalArmsCaptureMode === "bridge" ? await waitForTargetRendererArms() : undefined;
    const armsFinal = await waitForTargetFinalArms(finalArmsCaptureMode, armsRenderer);
    await writeParityArtifact({ eventReport, armsRenderer, armsFinal });

    assertCompleteReportInventory(eventReport);
    assertReportMessageRelations(eventReport);
    if (armsRenderer) {
      assertArmsInventoryAndRelations(armsRenderer, eventReport);
      expect(inventory(armsFinal, "name")).toEqual(inventory(armsRenderer, "name"));
    }
    assertArmsInventoryAndRelations(armsFinal as unknown as ArmsCustomEventPayload[], eventReport);
    assertFinalArmsShape(armsFinal);

    // 所有业务断言先通过，再归并有实现与 spec 依据的扩展字段，避免失败样本污染合同。
    const fieldAudit = await auditTelemetryFields({ records: eventReport });
    expect(fieldAudit.errors).toEqual([]);
  });
});

async function prepareArmsCapture(): Promise<FinalArmsCaptureMode> {
  const hasFinalBridge = await browser.execute(
    async (targetArmsEvents) => {
      type DebugWindow = Window & {
        __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
        __zcodeFinalArmsCustomEventsE2E?: {
          clear(): Promise<void>;
          configure(request: { suppressedEventNames: string[] }): Promise<void>;
        };
        zcode?: {
          reportArmsCustomEvent?: (payload: ArmsCustomEventPayload) => Promise<unknown>;
        };
      };
      const host = window as DebugWindow;
      host.__zcodeArmsCustomEventsE2E = [];

      const finalBridge = host.__zcodeFinalArmsCustomEventsE2E;
      if (finalBridge) {
        await finalBridge.clear();
        await finalBridge.configure({ suppressedEventNames: [...targetArmsEvents] });
        return true;
      }
      return false;
    },
    [...TARGET_ARMS_EVENTS],
  );
  if (hasFinalBridge) return "bridge";

  if (!process.env.ZCODE_TELEMETRY_PARITY_LEGACY_ARMS_PATH?.trim()) {
    throw new Error("旧版缺少 main sendCustom 临时捕获路径，已在发送前停止");
  }
  return "legacy-file";
}

async function waitForTargetReportRequests(
  telemetryFetch: Awaited<ReturnType<typeof browser.electron.mock>>,
): Promise<JsonRecord[]> {
  let latest: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      await telemetryFetch.update();
      latest = telemetryFetch.mock.calls
        .map((call) => parseTelemetryRequest(call))
        .filter((request): request is JsonRecord => request !== null)
        .filter((request) => TARGET_REPORT_EVENTS.includes(String(request.element_name) as never));
      return TARGET_REPORT_EVENTS.every(
        (eventName) => latest.filter((request) => request.element_name === eventName).length >= 2,
      );
    },
    {
      timeout: 30000,
      timeoutMsg: "没有捕获到两轮 send_btn / agent_step / message_completion telemetry 请求",
    },
  );
  return latest;
}

async function waitForTargetRendererArms(): Promise<ArmsCustomEventPayload[]> {
  let latest: ArmsCustomEventPayload[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readTargetRendererArms();
      return (
        countByName(latest, "perf_ui_message_complete") >= 2 &&
        countByName(latest, "perf_ui_turn_breakdown") >= 2
      );
    },
    {
      timeout: 30000,
      timeoutMsg: "没有捕获到两轮 renderer ARMS completion / breakdown payload",
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
    [...TARGET_ARMS_EVENTS],
  );
}

async function waitForTargetFinalArms(
  mode: FinalArmsCaptureMode,
  armsRenderer?: ArmsCustomEventPayload[],
): Promise<JsonRecord[]> {
  const expectedInventory = armsRenderer
    ? inventory(armsRenderer, "name")
    : {
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
        plan_request: 4,
        plan_ttft: 2,
      };
  let latest: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readTargetFinalArms(mode);
      const actualInventory = inventory(latest, "name");
      return Object.entries(expectedInventory).every(
        ([name, count]) => actualInventory[name] === count,
      );
    },
    {
      timeout: 10000,
      timeoutMsg: "main sendCustom final ARMS inventory 没有追平 renderer pre-IPC inventory",
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
        .filter(
          (payload): payload is JsonRecord =>
            isRecord(payload) &&
            TARGET_ARMS_EVENTS.includes(String(payload.name) as never) &&
            (payload.name !== "plan_request" ||
              (payload.properties as JsonRecord | undefined)?.ask_mode === "main_turn"),
        );
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
    [...TARGET_ARMS_EVENTS],
  );
}

async function writeParityArtifact(params: {
  eventReport: JsonRecord[];
  armsRenderer?: ArmsCustomEventPayload[];
  armsFinal?: JsonRecord[];
}): Promise<void> {
  const artifactPath = process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH?.trim();
  if (!artifactPath) return;
  const artifact: TelemetryParityArtifact = {
    version: 1,
    caseId: CASE_ID,
    eventReport: params.eventReport,
    ...(params.armsRenderer ? { armsRenderer: params.armsRenderer } : {}),
    ...(params.armsFinal ? { armsFinal: params.armsFinal } : {}),
    captureStages: {
      eventReport: "http-final",
      ...(params.armsRenderer ? { armsRenderer: "renderer-pre-ipc" as const } : {}),
      ...(params.armsFinal ? { armsFinal: "main-send-custom" } : {}),
    },
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function assertCompleteReportInventory(eventReport: JsonRecord[]): void {
  expect(inventory(eventReport, "element_name")).toEqual({
    agent_step: 2,
    message_completion: 2,
    send_btn: 2,
  });
  expect(new Set(eventReport.map((request) => request.event_id)).size).toBe(eventReport.length);

  for (const request of eventReport) {
    expect(Object.keys(request).sort()).toEqual([...REPORT_BODY_KEYS].sort());
    expect(request.event_region).toBe("app");
    expect(request.event_text).toBe("");
    expect(request.event_type).toBe(request.element_name === "send_btn" ? "ck" : "agent_trace");
    expectAllStringFields(
      request,
      REPORT_BODY_KEYS.filter((key) => key !== "event_extra_detail"),
    );
    expect(isRecord(request.event_extra_detail)).toBe(true);
    const detail = request.event_extra_detail as JsonRecord;
    expect(Object.values(detail).every((value) => typeof value === "string")).toBe(true);
  }
}

function assertReportMessageRelations(eventReport: JsonRecord[]): void {
  const sends = byElementName(eventReport, "send_btn");
  const steps = byElementName(eventReport, "agent_step");
  const completions = byElementName(eventReport, "message_completion");
  const talkIds = new Set(eventReport.map((request) => request.talk_id));
  expect(talkIds.size).toBe(1);
  expect([...talkIds][0]).toBeTruthy();

  const completionMessageIds = completions.map((request) => request.message_id);
  expect(new Set(completionMessageIds).size).toBe(2);
  expect(new Set(sends.map((request) => request.message_id))).toEqual(
    new Set(completionMessageIds),
  );

  for (const completion of completions) {
    const messageId = completion.message_id;
    const messageSteps = steps.filter((step) => step.message_id === messageId);
    expect(messageSteps).toHaveLength(1);
    expect(messageSteps[0]?.event_extra_detail as JsonRecord | undefined).toMatchObject({
      is_tool_call: "0",
      loop_index: "1",
      status: "success",
      step_type: "generation",
      workspace_kind: "local",
      remote_kind: "",
    });
    expect(completion.event_extra_detail as JsonRecord).toMatchObject({
      agent_step_cnt: String(messageSteps.length),
      workspace_kind: "local",
      remote_kind: "",
    });
  }
}

function assertArmsInventoryAndRelations(
  arms: ArmsCustomEventPayload[],
  eventReport: JsonRecord[],
): void {
  const completions = byElementName(eventReport, "message_completion");
  const messageIds = new Set(completions.map((request) => String(request.message_id)));
  const talkId = String(completions[0]?.talk_id);
  const planRequests = arms.filter(
    (payload) => payload.name === "plan_request" && payload.properties?.ask_mode === "main_turn",
  );

  expect(inventory(arms, "name")).toEqual({
    perf_ui_first_token: 2,
    perf_ui_message_complete: 2,
    perf_ui_turn_breakdown: 2,
    plan_request: 4,
    plan_ttft: 2,
  });
  expect(inventory(planRequests, "name")).toEqual({ plan_request: 4 });
  expect(
    inventory(
      planRequests.map((payload) => payload.properties ?? {}),
      "request_status",
    ),
  ).toEqual({ completed: 2, started: 2 });
  expect(new Set(planRequests.map((payload) => payload.properties?.task_id))).toEqual(
    new Set([talkId]),
  );
  const requestIds = new Set(planRequests.map((payload) => payload.properties?.request_id));
  expect(requestIds.size).toBe(2);
  for (const requestId of requestIds) {
    const pair = planRequests.filter((payload) => payload.properties?.request_id === requestId);
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((payload) => payload.properties?.input_id)).size).toBe(1);
    expect(new Set(pair.map((payload) => payload.properties?.query_id)).size).toBe(1);
  }
  expect(countByName(arms, "plan_ttft")).toBe(2);

  for (const eventName of [
    "perf_ui_first_token",
    "perf_ui_message_complete",
    "perf_ui_turn_breakdown",
  ]) {
    const payloads = arms.filter((payload) => payload.name === eventName);
    expect(payloads).toHaveLength(2);
    expect(new Set(payloads.map((payload) => payload.properties?.message_id))).toEqual(messageIds);
    expect(new Set(payloads.map((payload) => payload.properties?.talk_id))).toEqual(
      new Set([talkId]),
    );
  }

  for (const payload of arms) {
    expect(TARGET_ARMS_EVENTS).toContain(payload.name);
    expect(typeof payload.group).toBe("string");
    expect(typeof payload.value).toBe("number");
    expect(isRecord(payload.properties)).toBe(true);
  }
}

function assertFinalArmsShape(armsFinal: JsonRecord[]): void {
  for (const payload of armsFinal) {
    expect(Object.keys(payload).sort()).toEqual(
      ["group", "name", "properties", "type", "value"].sort(),
    );
    expect(payload.type).toBe("custom");
    expect(typeof payload.value).toBe("number");
    expect(isRecord(payload.properties)).toBe(true);
    const properties = payload.properties as JsonRecord;
    for (const key of [
      "app_version",
      "arms_env",
      "device_mid",
      "event_name",
      "metric_value",
      "platform",
      "renderer_id",
    ]) {
      expect(typeof properties[key]).toBe("string");
    }
  }
}

function parseTelemetryRequest(call: unknown[]): JsonRecord | null {
  const [input, init] = call;
  if (!String(input ?? "").includes(TELEMETRY_REPORT_PATH) || !isRecord(init)) return null;
  if (typeof init.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function byElementName(eventReport: JsonRecord[], elementName: string): JsonRecord[] {
  return eventReport.filter((request) => request.element_name === elementName);
}

function countByName(payloads: ArmsCustomEventPayload[], eventName: string): number {
  return payloads.filter((payload) => payload.name === eventName).length;
}

function inventory(records: JsonRecord[], key: string): Record<string, number>;
function inventory(records: ArmsCustomEventPayload[], key: "name"): Record<string, number>;
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

function expectAllStringFields(record: JsonRecord, keys: readonly string[]): void {
  for (const key of keys) {
    expect(typeof record[key]).toBe("string");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
