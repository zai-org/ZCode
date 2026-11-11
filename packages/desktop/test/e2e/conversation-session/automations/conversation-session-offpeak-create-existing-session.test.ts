import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { modelSelectionSchema, OFF_PEAK_PROVIDER_IDS, type ModelSelection } from "@zcode/shared";
import {
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CREATE_CARD,
  TID_OFFPEAK_CREATE_OPEN,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 与 fixtures/upstream/conversation-session/conversation-session-offpeak-create-existing-session.json 对齐。
const CASE_NAME = "conversation-session-offpeak-create-existing-session";
const WARMUP_MARKER = "E2E_OFFPEAK_EXISTING_WARMUP";
const WARMUP_REPLY = `${WARMUP_MARKER}_OK`;
const CREATE_MARKER = "E2E_OFFPEAK_EXISTING_CREATE";
const TASK_TITLE = "E2E_OFFPEAK_EXISTING_TASK";
const UPDATED_TASK_TITLE = "E2E_OFFPEAK_EXISTING_TASK_EDITED";
// 单模型白名单由当前隔离 Built-in 提供，不再从旧 client-config 读取。
const MOCK_ALLOWED_MODEL = "GLM-5.2";

/**
 * D49 在「已有对话」里创建闲时任务：
 * 先在新会话正常聊一轮并落盘 → 整机重启 Electron（进程退出屏障，Host/CLI 冷启动）→ 从侧栏
 * 重新打开旧会话（v4 subscribe 冷恢复，没有 per-request flag 通道）→ 在旧会话里说"建个闲时任务"
 * → OffPeakCreate 仍在工具面 → 审批 → 轮尾卡 → 直达编辑 → 改名回显。
 *
 * 回归边界：v4 冷恢复的工具面依赖 host 在 agent 就绪时同步的 workspace/updateOffPeakToolPolicy；
 * 若该同步缺失，本 case 会在「provider 请求含 OffPeakCreate 契约」处失败。
 */
describe("已有对话内 OffPeakCreate（冷恢复会话）E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OP-CHAT-02: 旧会话冷恢复后 prompt 创建闲时任务 → 轮尾卡 → 直达编辑", async function () {
    this.timeout(240000);

    // 1) 新会话先正常聊一轮，形成已持久化的历史。
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await sendV4Prompt(`${WARMUP_MARKER} 先帮我看一下这个工作区里有哪些 TODO 注释`);
    await waitForV4AssistantMessageContaining(WARMUP_REPLY);
    const warm = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "首轮对话没有完成",
      60000,
    );
    const sessionId = warm.sessionId!;
    const ordinarySelection = readPersistedSessionSelection(sessionId);

    // 2) 整机重启：旧 Electron/Host/CLI 进程全部退出，之后的打开必然是冷恢复。
    await reloadElectronSessionSafely(browser);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);

    // 修复原因：默认回放强制录屏会在无 ffmpeg 的 runner 上于业务通过后报 spawn ffmpeg ENOENT；
    // 仅人工审核需要视频，与 DCA-V1-06 一致按 ZCODE_E2E_MANUAL_REVIEW=1 启用。
    const recording =
      process.env.ZCODE_E2E_MANUAL_REVIEW === "1"
        ? await startElectronWindowRecording({
            frameIntervalMs: 200,
            outputPath: resolveArtifactPath(`${CASE_NAME}.webm`),
          })
        : null;
    try {
      // 3) 从侧栏重新打开旧会话，历史回显。
      await selectV4TaskById(sessionId);
      await waitForV4TimelineContaining(WARMUP_REPLY);
      await browser.pause(1200);

      // 4) 在旧会话里要求闲时执行。
      await sendV4Prompt(`${CREATE_MARKER} 把这些 TODO 的清理整理成闲时任务，写一份 TODO-PLAN.md`);
      await waitForV4TimelineContaining(CREATE_MARKER);
      const createRequest = { lastUserMessageIncludes: [CREATE_MARKER] };
      await waitForUpstreamRequest(
        createRequest,
        "没有捕获到冷恢复会话内 OffPeakCreate 的 provider 请求",
      );
      const contract = await getUpstreamRequestToolContract(createRequest, "OffPeakCreate");
      expect(contract).not.toBeNull();

      await approveV4Permission();
      await waitForV4Pane(
        (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
        "冷恢复会话内 OffPeakCreate 没有完成",
        90000,
      );

      // 5) 轮尾卡。
      await expandAssistantHistoriesWithContent();
      try {
        await waitForTestIdByDom(TID_OFFPEAK_CREATE_CARD, {
          timeout: 15000,
          timeoutMsg: "冷恢复会话内没有渲染 OffPeakCreate 闲时任务卡片",
        });
      } catch (error) {
        const diagnostics = await getToolCallDiagnostics({
          type: "toolName",
          value: "OffPeakCreate",
        });
        throw new Error(
          `冷恢复会话内没有渲染 OffPeakCreate 闲时任务卡片；diagnostics=${JSON.stringify(diagnostics)}`,
          { cause: error },
        );
      }
      await browser.waitUntil(
        async () => {
          const cardText = await readTestIdText(TID_OFFPEAK_CREATE_CARD);
          return cardText.includes(TASK_TITLE) && /in queue|排队第/u.test(cardText);
        },
        { timeout: 10000, timeoutMsg: "OffPeakCreate 卡片没有展示任务标题与位次快照" },
      );
      await browser.pause(1500);

      // 6) 落库缺省与绑定：任务归属当前 workspace，缺省 yolo / 白名单末位 / 最高档。
      const created = await waitForOffPeakRecordByTitle(TASK_TITLE);
      expect(created.permissionMode).toBe("yolo");
      expect(created.modelSelection.modelId).toBe(MOCK_ALLOWED_MODEL);
      expect(Object.values(OFF_PEAK_PROVIDER_IDS)).toContain(created.modelSelection.providerId);
      expect(created.modelSelection.options?.reasoningLevel).toEqual(expect.any(String));
      expect(created.sessionId).toBe(sessionId);
      expect(created.conversationId).toBeNull();
      expect(created.status).toBe("queued");

      // 7) 直达编辑表单 → 改名保存 → 列表回显。
      await clickTestIdByDom(TID_OFFPEAK_CREATE_OPEN, {
        timeoutMsg: "闲时卡片没有「去到闲时任务」按钮",
      });
      await waitForTestIdByDom(TID_OFFPEAK_EDIT_VIEW, {
        timeout: 15000,
        timeoutMsg: "点击卡片后没有进入闲时任务编辑视图",
      });
      await browser.waitUntil(
        async () => (await readTestIdValue(TID_OFFPEAK_FORM_TITLE)) === TASK_TITLE,
        { timeout: 10000, timeoutMsg: "编辑表单没有回显会话内创建的任务标题" },
      );
      await browser.pause(1500);
      await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, UPDATED_TASK_TITLE, {
        timeoutMsg: "闲时任务标题输入不可编辑",
      });
      await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, { timeoutMsg: "闲时任务保存按钮不可点击" });
      await ensureIdleTabSelected();
      await browser.waitUntil(
        async () =>
          (await readAllTestIdTexts(TID_OFFPEAK_CARD)).some((t) => t.includes(UPDATED_TASK_TITLE)),
        { timeout: 20000, timeoutMsg: `闲时任务列表没有回显修改后的标题：${UPDATED_TASK_TITLE}` },
      );
      const updated = await waitForOffPeakRecordByTitle(UPDATED_TASK_TITLE);
      expect(updated.offPeakTaskId).toBe(created.offPeakTaskId);
      // 真实 scheduler 复用已有 Session，不能把闲时本轮的模型覆盖普通持久选择。
      await browser.waitUntil(
        () => {
          const task = readOffPeakRecordByTitle(UPDATED_TASK_TITLE);
          if (task?.status === "failed" || task?.status === "cancelled") {
            throw new Error(`闲时任务异常终止：${JSON.stringify(task)}`);
          }
          return task?.status === "completed";
        },
        { timeout: 90000, timeoutMsg: "绑定会话的闲时任务没有执行完成" },
      );
      const completed = readOffPeakRecordByTitle(UPDATED_TASK_TITLE)!;
      expect(completed.sessionId).toBe(sessionId);
      expect(completed.conversationId).toBe(sessionId);
      expect(readPersistedSessionSelection(sessionId)).toEqual(ordinarySelection);
      const response = await fetch("http://127.0.0.1:45197/__e2e/off-peak/requests");
      expect(response.ok).toBe(true);
      const capture = (await response.json()) as {
        requests: Array<{ model?: string; ticketId: string; hasCodingPlanApiKey: boolean }>;
      };
      expect(capture.requests.length).toBeGreaterThan(0);
      for (const request of capture.requests) {
        expect(request.model).toBe(created.modelSelection.modelId);
        expect(request.ticketId).toBeTruthy();
        expect(request.hasCodingPlanApiKey).toBe(true);
      }
    } finally {
      if (recording) {
        const result = await recording.stop({ tailDurationMs: 500 });
        await writeRecordingManifest({
          frameCount: result.frameCount,
          videoPath: result.videoPath,
        });
      }
    }
  });
});

interface OffPeakRecord {
  offPeakTaskId: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  sessionId: string | null;
  conversationId: string | null;
  status: string;
  failureReason: string | null;
}

function readPersistedSessionSelection(sessionId: string): ModelSelection {
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        "SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection'",
      )
      .get(sessionId) as { data: string } | undefined;
    if (!row) throw new Error(`Session ${sessionId} 没有持久模型选择`);
    return modelSelectionSchema.parse(JSON.parse(row.data).modelSelection);
  } finally {
    database.close();
  }
}

async function waitForOffPeakRecordByTitle(title: string): Promise<OffPeakRecord> {
  let record: OffPeakRecord | null = null;
  await browser.waitUntil(
    async () => {
      record = readOffPeakRecordByTitle(title);
      return record !== null;
    },
    { timeout: 10000, timeoutMsg: `没有在 off_peak_tasks 中找到 ${title}` },
  );
  if (!record) throw new Error(`off_peak_tasks 记录为空：${title}`);
  return record;
}

function readOffPeakRecordByTitle(title: string): OffPeakRecord | null {
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
  try {
    const hasTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasTable) return null;
    const row = database
      .prepare(
        `SELECT off_peak_task_id, permission_mode, model_selection, status, session_id, conversation_id, failure_reason
         FROM off_peak_tasks WHERE title = ?`,
      )
      .get(title) as
      | {
          off_peak_task_id: string;
          permission_mode: string;
          model_selection: string;
          session_id: string | null;
          conversation_id: string | null;
          status: string;
          failure_reason: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      offPeakTaskId: row.off_peak_task_id,
      permissionMode: row.permission_mode,
      modelSelection: modelSelectionSchema.parse(JSON.parse(row.model_selection)),
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      status: row.status,
      failureReason: row.failure_reason,
    };
  } finally {
    database.close();
  }
}

async function ensureIdleTabSelected(): Promise<void> {
  try {
    await clickTestIdByDom(TID_OFFPEAK_TAB, { timeout: 5000, timeoutMsg: "" });
  } catch {
    // 已在闲时 tab 或 tab 栏未渲染；后续列表断言会给出真实失败原因。
  }
}

async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
}

async function readAllTestIdTexts(currentTestId: string): Promise<string[]> {
  return browser.execute((tid) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((item) => item.dataset.testid === tid)
      .map((item) => item.textContent?.trim() ?? "");
  }, currentTestId);
}

async function readTestIdValue(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${tid}"]`,
    );
    return element?.value ?? "";
  }, currentTestId);
}

function resolveArtifactPath(fileName: string) {
  return resolve(
    process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() ||
      process.env.CODEX_E2E_ARTIFACT_DIR?.trim() ||
      join(process.cwd(), ".e2e-artifacts", CASE_NAME),
    fileName,
  );
}

async function writeRecordingManifest(input: { frameCount: number; videoPath: string }) {
  const manifestPath = resolveArtifactPath(`${CASE_NAME}.recording.json`);
  await mkdir(resolve(manifestPath, ".."), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        case: CASE_NAME,
        video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
        video_path: input.videoPath,
        frame_count: input.frameCount,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
