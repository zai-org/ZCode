import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { restartIntoWorkspacePreservingProfile as restartWithFixture } from "#e2e/helpers/model-provider-restart-runtime";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_MODEL_CONFIG,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  restartIntoWorkspacePreservingProfile,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import {
  CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
} from "#e2e/helpers/provider-readiness-history-fixture";
import {
  clickV4Send,
  getV4CompactMarkers,
  getV4ConfigProjection,
  selectV4TaskById,
  sendV4Prompt,
  V4_MAIN_PANE_ID,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID;
const MODEL_ID = CONTEXT_WINDOW_COLD_RESUME_MODEL_ID;
const CONTEXT_WINDOW = CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS;
const MAX_OUTPUT_TOKENS = CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS;
const HIGH_USAGE_INPUT_TOKENS = 157_762;
const TOOL_CALL_ID = "call_cw_pwd";
const CREATE_HISTORY_MARKER = "E2E_CW_CREATE_HISTORY";
const CREATE_HISTORY_REPLY = "cw-history-created-ok";
const PARKING_MARKER = "E2E_CW_PARKING";
const PARKING_REPLY = "cw-parking-ok";
const HIGH_USAGE_MARKER = "E2E_CW_HIGH_USAGE_TOOL";
const TOOL_FOLLOWUP_REPLY = "cw-tool-followup-ok";
const CONTINUE_REPLY = "cw-continue-ok";
const paths = getE2EAppDataPaths();

describe("上下文窗口与输出预算冷恢复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CW01-CW04: 1M/64K 会话冷恢复 limits 正确，compact 后重启保持压缩后水位", async function () {
    this.timeout(360_000);

    await waitForDefaultWorkspaceReady(30_000);
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);

    // 先通过真实 UI/协议创建并完成 1M 会话；再创建一个 parking 会话保持选中，
    // 这样重启后目标会话尚未 resume，可在点击前安装首投影记录器。
    // 启动夹具已经是目标目录的空草稿，直接首发，避免无意义地替换预热中的草稿。
    await sendV4Prompt(CREATE_HISTORY_MARKER);
    await waitForV4TimelineContaining(CREATE_HISTORY_REPLY);
    const targetSessionId = await waitForBoundSession("真实 1M 历史会话没有创建成功");

    // 冷恢复夹具固定在项目目录；全局新建会创建独立 cwd，不能复用该目录的记录器。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await sendV4Prompt(PARKING_MARKER);
    await waitForV4TimelineContaining(PARKING_REPLY);
    const parkingSessionId = await waitForBoundSession("parking 会话没有创建成功");
    expect(parkingSessionId).not.toBe(targetSessionId);

    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== targetSessionId,
      "重启后目标会话在记录器安装前已被提前打开",
    );
    await installContextWindowProjectionRecorder(paths.workspace, targetSessionId);
    await selectV4TaskById(targetSessionId);
    await waitForV4TimelineContaining(CREATE_HISTORY_MARKER);
    await waitForV4TimelineContaining(CREATE_HISTORY_REPLY);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId,
      "1M 历史 session 没有完成冷恢复",
    );

    const coldProjection = await waitForConfigProjection(
      (projection) => projection.usageUsed > 0 && projection.usageMax === CONTEXT_WINDOW,
      "已配置 1M provider 的历史 session 首投影没有使用 1M",
    );
    expect(coldProjection.usageMax).toBe(CONTEXT_WINDOW);
    const observedContextWindows = await readContextWindowProjectionRecorder();
    const nonZeroContextWindows = observedContextWindows.filter((value) => value > 0);
    // Bug 根因：旧 E2E 直接伪造 sqlite 历史，没有走真实 create/request/restart；
    // 这里从点击冷会话之前记录 Zustand + DOM，锁住用户能看到的第一份投影。
    expect(observedContextWindows).not.toContain(200_000);
    expect(nonZeroContextWindows[0]).toBe(CONTEXT_WINDOW);
    expect(new Set(nonZeroContextWindows)).toEqual(new Set([CONTEXT_WINDOW]));

    const highUsagePrompt =
      `${HIGH_USAGE_MARKER}: run readonly Bash pwd, then reply with ` + `"${TOOL_FOLLOWUP_REPLY}".`;
    await sendV4Prompt(highUsagePrompt);
    await waitForV4TimelineContaining(TOOL_FOLLOWUP_REPLY);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId && !snapshot.canStop,
      "高 usage 工具续轮没有完成",
      90_000,
    );

    const highUsageProjection = await waitForConfigProjection(
      (projection) =>
        projection.usageMax === CONTEXT_WINDOW && projection.usageUsed >= HIGH_USAGE_INPUT_TOKENS,
      "provider usage 没有更新到同一 1M session 的状态投影",
    );
    expect(highUsageProjection.usageUsed).toBeGreaterThanOrEqual(HIGH_USAGE_INPUT_TOKENS);

    const afterTool = await waitForModelIoSequence(targetSessionId, 3);
    expect(afterTool.filter((record) => record.querySource === "compact")).toHaveLength(0);
    const afterToolMainTurns = afterTool.filter((record) => record.querySource === "main_turn");
    expect(afterToolMainTurns).toHaveLength(3);
    expect(
      afterToolMainTurns.every((record) => record.body.max_completion_tokens === MAX_OUTPUT_TOKENS),
    ).toBe(true);
    // 修复原因：compact.auto.skipped 是异步落盘的 debug 诊断事件，不能作为 formal gate；
    // 这里用真实 provider 请求序列和 fail-closed fixture 证明 1M 会话没有误发 compact。
    expect(afterTool.every((record) => record.modelId === MODEL_ID)).toBe(true);
    expect(JSON.stringify(afterToolMainTurns[2]?.body)).toContain(TOOL_CALL_ID);
    expect(await getV4CompactMarkers()).toHaveLength(0);

    await sendV4Prompt("继续");
    await waitForV4TimelineContaining(CONTINUE_REPLY);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId && !snapshot.canStop,
      "“继续”轮没有完成",
      90_000,
    );

    const finalRequests = await waitForModelIoSequence(targetSessionId, 4);
    expect(finalRequests.filter((record) => record.querySource === "compact")).toHaveLength(0);
    const finalMainTurns = finalRequests.filter((record) => record.querySource === "main_turn");
    expect(finalMainTurns).toHaveLength(4);
    expect(
      finalMainTurns.every((record) => record.body.max_completion_tokens === MAX_OUTPUT_TOKENS),
    ).toBe(true);
    expect(finalRequests.every((record) => record.modelId === MODEL_ID)).toBe(true);
    expect(JSON.stringify(finalMainTurns[3]?.body)).toContain("继续");
    expect(await getV4CompactMarkers()).toHaveLength(0);
    expect((await getV4ConfigProjection()).usageMax).toBe(CONTEXT_WINDOW);

    const preCompactProjection = await getV4ConfigProjection();
    expect(preCompactProjection.usageUsed).toBeGreaterThanOrEqual(HIGH_USAGE_INPUT_TOKENS);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "CW04 手动 compact 前 composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId && !snapshot.canStop,
      "CW04 手动 compact 完成后没有回到 idle",
      90_000,
    );
    const postCompactProjection = await waitForConfigProjection(
      (projection) =>
        projection.usageMax === CONTEXT_WINDOW &&
        projection.usageUsed > 0 &&
        projection.usageUsed < preCompactProjection.usageUsed,
      "CW04 热态 meter 没有下降到 post-compact 水位",
    );

    // Bug 根因：compact 后水位持久化在 user summary boundary；冷恢复如果继续只看
    // assistant tokens，会越过 boundary 并把 meter 恢复到 compact 前的旧值。
    await selectV4TaskById(parkingSessionId);
    // Bug 根因：只等 pane sessionId 会早于 parking 会话的 initial snapshot；此时立即
    // 重启会中断在途 subscribe，让旧窗口短暂显示“重新连接”错误页。
    await waitForV4TimelineContaining(PARKING_REPLY);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === parkingSessionId && !snapshot.canStop,
      "CW04 重启前没有切回 parking session",
    );
    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== targetSessionId,
      "CW04 第二次重启后目标 session 被提前打开",
    );
    await selectV4TaskById(targetSessionId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId && !snapshot.canStop,
      "CW04 compact 历史 session 没有完成冷恢复",
      90_000,
    );
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);

    const coldPostCompactProjection = await waitForConfigProjection(
      (projection) => projection.usageMax === CONTEXT_WINDOW && projection.usageUsed > 0,
      "CW04 冷恢复后没有发布 context usage",
    );
    expect(coldPostCompactProjection.usageUsed).toBe(postCompactProjection.usageUsed);
    expect(coldPostCompactProjection.usageUsed).toBeLessThan(preCompactProjection.usageUsed);

    // Todo123：只在隔离 E2E 进程退出屏障后改这条真实创建的会话，模拟旧选择缺档位。
    // transcript、compact 水位和旧字段均不改；不构造假的聊天正文来替代恢复。
    await selectV4TaskById(parkingSessionId);
    await restartWithFixture(paths.workspace, {
      afterElectronProcessExit: () => patchFixtureSelection(targetSessionId, false),
    });
    await installContextWindowProjectionRecorder(paths.workspace, targetSessionId);
    await selectV4TaskById(targetSessionId);
    await waitForV4TimelineContaining(CREATE_HISTORY_REPLY);
    const missingReasoning = await waitForConfigProjection(
      (projection) => projection.usageMax === CONTEXT_WINDOW && projection.usageUsed > 0,
      "CW05 缺档位历史选择未保留真实容量与用量",
    );
    expect(missingReasoning.usageUsed).toBe(coldPostCompactProjection.usageUsed);
    expect(await readContextWindowProjectionRecorder()).not.toContain(200_000);

    await selectV4TaskById(parkingSessionId);
    await restartWithFixture(paths.workspace, {
      afterElectronProcessExit: () => patchFixtureSelection(targetSessionId, true),
    });
    await selectV4TaskById(targetSessionId);
    await waitForV4TimelineContaining(CREATE_HISTORY_REPLY);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetSessionId && !snapshot.canStop,
      "CW06 未知模型会话应可打开",
    );
    await waitForConfigProjection(
      (projection) => projection.usageMax === 0,
      "CW06 未知模型不应显示伪造容量",
    );
  });
});

function patchFixtureSelection(sessionId: string, unknownModel: boolean): void {
  // node:sqlite 仅有同步 API；这里只写测试专属库中指定 session 的新字段。
  const database = new DatabaseSync(join(paths.homeDir, ".zcode", "cli", "db", "db.sqlite"));
  try {
    const result = database
      .prepare(`UPDATE session_entry
      SET data=json_set(data, '$.modelSelection', json(?))
      WHERE session_id=? AND type='runtime/model_selection'`)
      .run(
        JSON.stringify({
          providerId: PROVIDER_ID,
          modelId: unknownModel ? "missing-cw-model" : MODEL_ID,
        }),
        sessionId,
      );
    expect(Number(result.changes)).toBeGreaterThan(0);
  } finally {
    database.close();
  }
}

async function waitForBoundSession(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft" && !current.canStop),
    timeoutMsg,
    90_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}; sessionId=${snapshot.sessionId}`);
  }
  return snapshot.sessionId;
}

interface ConfigProjection {
  mode: string | null;
  usageMax: number;
  usageUsed: number;
}

async function waitForConfigProjection(
  predicate: (projection: ConfigProjection) => boolean,
  timeoutMsg: string,
): Promise<ConfigProjection> {
  let latest: ConfigProjection = await getV4ConfigProjection();
  await browser.waitUntil(
    async () => {
      latest = await getV4ConfigProjection();
      return predicate(latest);
    },
    {
      interval: 100,
      timeout: 30_000,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

interface ContextWindowProjectionRecorder {
  dom: number[];
  store: number[];
}

async function installContextWindowProjectionRecorder(
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  const paneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  await browser.execute(
    (targetWorkspacePath, targetSessionId, targetPaneTestId, modelConfigTestId) => {
      interface SessionStoreState {
        getWorkspaceState: (workspace: string) => {
          taskRuntimeByTaskId: Record<
            string,
            {
              contextWindow?: number | null;
              usage?: { size?: number } | null;
            }
          >;
        };
      }
      interface SessionStoreBridge {
        getState: () => SessionStoreState;
        subscribe: (listener: (state: SessionStoreState) => void) => () => void;
      }
      interface RecorderHost {
        __zcodeContextWindowColdResumeE2E?: {
          dom: number[];
          observer: MutationObserver;
          store: number[];
          unsubscribe: () => void;
        };
        __zcodeSessionStoreE2E?: SessionStoreBridge;
      }
      const host = window as unknown as RecorderHost;
      host.__zcodeContextWindowColdResumeE2E?.observer.disconnect();
      host.__zcodeContextWindowColdResumeE2E?.unsubscribe();

      const dom: number[] = [];
      const store: number[] = [];
      const append = (target: number[], value: unknown) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && target[target.length - 1] !== numeric) {
          target.push(numeric);
        }
      };
      const recordDom = () => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${targetPaneTestId}"]`);
        if (pane?.getAttribute("data-session-id") !== targetSessionId) {
          return;
        }
        const modelConfig = pane.querySelector<HTMLElement>(`[data-testid="${modelConfigTestId}"]`);
        append(dom, modelConfig?.getAttribute("data-usage-max"));
      };
      const observer = new MutationObserver(recordDom);
      observer.observe(document.body, {
        attributeFilter: ["data-session-id", "data-usage-max"],
        attributes: true,
        childList: true,
        subtree: true,
      });

      const bridge = host.__zcodeSessionStoreE2E;
      if (!bridge) {
        throw new Error("ZCode session E2E store bridge 未注册");
      }
      const recordStore = (state: SessionStoreState) => {
        const runtime =
          state.getWorkspaceState(targetWorkspacePath).taskRuntimeByTaskId[targetSessionId];
        append(store, runtime?.usage?.size ?? runtime?.contextWindow);
      };
      const unsubscribe = bridge.subscribe(recordStore);
      recordStore(bridge.getState());
      recordDom();
      host.__zcodeContextWindowColdResumeE2E = {
        dom,
        observer,
        store,
        unsubscribe,
      };
    },
    workspacePath,
    sessionId,
    paneTestId,
    TID_V4_MODEL_CONFIG,
  );
}

async function readContextWindowProjectionRecorder(): Promise<number[]> {
  const recorder = await browser.execute(() => {
    const value = (
      window as unknown as {
        __zcodeContextWindowColdResumeE2E?: ContextWindowProjectionRecorder;
      }
    ).__zcodeContextWindowColdResumeE2E;
    return value ? { dom: [...value.dom], store: [...value.store] } : null;
  });
  if (!recorder) {
    throw new Error("1M context 冷恢复投影记录器意外丢失");
  }
  return [...recorder.store, ...recorder.dom];
}

interface ModelIoRecord {
  error?: unknown;
  model?: { modelId?: string };
  querySource?: string;
  request?: { body?: unknown };
  response?: unknown;
  sessionId?: string;
}

interface ModelIoMatch {
  body: Record<string, unknown>;
  modelId: string | undefined;
  querySource: string;
}

async function waitForModelIoSequence(
  sessionId: string,
  expectedMainTurnCount: number,
): Promise<ModelIoMatch[]> {
  let matched: ModelIoMatch[] = [];
  await browser.waitUntil(
    async () => {
      matched = await readSuccessfulModelIo(sessionId);
      return (
        matched.filter((record) => record.querySource === "main_turn").length >=
        expectedMainTurnCount
      );
    },
    {
      interval: 100,
      timeout: 30_000,
      timeoutMsg:
        `model-io 没有达到 ${expectedMainTurnCount} 个 main_turn; ` +
        `latest=${JSON.stringify(matched.map((record) => record.querySource))}`,
    },
  );
  return matched;
}

async function readSuccessfulModelIo(sessionId: string): Promise<ModelIoMatch[]> {
  const debugDir = join(paths.homeDir, ".zcode", "cli", "debug");
  const files = (await readdir(debugDir).catch(() => []))
    .filter((name) => name.startsWith("model-io-") && name.endsWith(".jsonl"))
    .sort();
  const matched: ModelIoMatch[] = [];
  for (const file of files) {
    const content = await readFile(join(debugDir, file), "utf-8").catch(() => "");
    for (const line of content.split("\n")) {
      const record = parseJsonObject(line) as ModelIoRecord | null;
      if (
        !record ||
        record.error !== undefined ||
        record.response === undefined ||
        record.sessionId !== sessionId ||
        typeof record.querySource !== "string"
      ) {
        continue;
      }
      const body = parseJsonObject(record.request?.body);
      if (!body || body.bodySource === "ai_sdk_options") {
        continue;
      }
      matched.push({
        body,
        modelId: record.model?.modelId,
        querySource: record.querySource,
      });
    }
  }
  return matched;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
