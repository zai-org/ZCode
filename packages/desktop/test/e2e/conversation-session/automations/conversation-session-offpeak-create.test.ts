import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { modelSelectionSchema, OFF_PEAK_PROVIDER_IDS, type ModelSelection } from "@zcode/shared";
import {
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
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
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "#e2e/helpers/electron-window-recorder";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 与 fixtures/upstream/conversation-session/conversation-session-offpeak-create.json 对齐：
// prompt 里的 marker 触发回放的 OffPeakCreate 工具调用；title 是工具入参里固定的闲时任务标题。
const CASE_NAME = "conversation-session-offpeak-create";
const MARKER = "E2E_OFFPEAK_CHAT_CREATE";
const TASK_TITLE = "E2E_OFFPEAK_DIGEST";
const UPDATED_TASK_TITLE = "E2E_OFFPEAK_DIGEST_EDITED";
// wdio.conf startOffPeakE2EMock：spec 名含 offpeak → ZCODE_OFFPEAK_MOCK=1，
// 隔离 Built-in 单模型白名单 GLM-5.2，票据 60s 内保持 queued，位次为 1。
const MOCK_ALLOWED_MODEL = "GLM-5.2";

/**
 * D49 会话内创建闲时任务核心体验端到端：
 * prompt → OffPeakCreate 进入 provider 工具面 → 审批 → 轮尾卡（标题 + 位次快照）
 * → 落库缺省（yolo / 白名单末位 / 最高档）→ 点「去到闲时任务」直达编辑表单 → 改标题保存 → 列表回显。
 *
 * 模型响应走 upstream 回放；取号走进程内 mock 网关；创建与编辑真实落库，确定性。
 */
describe("会话内 OffPeakCreate 闲时任务卡片与直达编辑 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OP-CHAT-01: prompt 创建闲时任务 → 轮尾卡 → 直达编辑表单修改", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
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
      // 1) 用户用自然语言要求闲时执行；marker 命中 fixture 固定返回 OffPeakCreate tool_use。
      await sendV4Prompt(
        `${MARKER} 帮我建一个闲时任务：整理今天改动的文件并生成一份摘要写到 DIGEST.md`,
      );
      await waitForV4TimelineContaining(MARKER);

      // 2) 回归边界：OffPeakCreate 契约必须真实进入 provider request（工具面已按 D49-8 门禁下发）。
      const createRequest = { lastUserMessageIncludes: [MARKER] };
      await waitForUpstreamRequest(
        createRequest,
        "没有捕获到会话内 OffPeakCreate 的 provider 请求",
      );
      const contract = await getUpstreamRequestToolContract(createRequest, "OffPeakCreate");
      expect(contract).not.toBeNull();
      const serializedContract = JSON.stringify(contract);
      expect(serializedContract).toContain("OffPeakCreate has no clock");
      expect(serializedContract).toContain("full-automatic mode");

      // 3) needsApproval：审批停在 composer dock，显式批准后工具才真实取号并落库。
      await approveV4Permission();
      const donePane = await waitForV4Pane(
        (snapshot) =>
          snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
        "会话内 OffPeakCreate 没有完成",
        90000,
      );
      const creatingSessionId = donePane.sessionId!;

      // 4) 轮尾卡：月亮卡片展示任务标题 + 创建时位次快照。
      await expandAssistantHistoriesWithContent();
      try {
        await waitForTestIdByDom(TID_OFFPEAK_CREATE_CARD, {
          timeout: 15000,
          timeoutMsg: "会话内没有渲染 OffPeakCreate 闲时任务卡片",
        });
      } catch (error) {
        const diagnostics = await getToolCallDiagnostics({
          type: "toolName",
          value: "OffPeakCreate",
        });
        throw new Error(
          `会话内没有渲染 OffPeakCreate 闲时任务卡片；diagnostics=${JSON.stringify(diagnostics)}`,
          { cause: error },
        );
      }
      await browser.waitUntil(
        async () => {
          const cardText = await readTestIdText(TID_OFFPEAK_CREATE_CARD);
          return cardText.includes(TASK_TITLE) && /in queue|排队第/u.test(cardText);
        },
        {
          timeout: 10000,
          timeoutMsg: "OffPeakCreate 卡片没有展示任务标题与位次快照",
        },
      );

      // 验收录像：让卡片在画面上停留可辨的时长（不影响断言）。
      await browser.pause(1500);

      // 5) 落库缺省（D49-4）：yolo / 白名单末位模型 / 推理档非空；状态 queued。
      const created = await waitForOffPeakRecordByTitle(TASK_TITLE);
      expect(created.permissionMode).toBe("yolo");
      expect(created.modelSelection.modelId).toBe(MOCK_ALLOWED_MODEL);
      expect(Object.values(OFF_PEAK_PROVIDER_IDS)).toContain(created.modelSelection.providerId);
      expect(created.modelSelection.options?.reasoningLevel).toEqual(expect.any(String));
      expect(created.status).toBe("queued");
      // D50：会话内创建绑定当前会话（session_id 即创建会话），conversation_id 留空等首跑回填。
      expect(created.sessionId).toBe(creatingSessionId);
      expect(created.conversationId).toBeNull();

      // 6) 「去到闲时任务」→ Automations idle tab 直接落到该任务的编辑表单。
      await clickTestIdByDom(TID_OFFPEAK_CREATE_OPEN, {
        timeoutMsg: "闲时卡片没有「去到闲时任务」按钮",
      });
      try {
        await waitForTestIdByDom(TID_OFFPEAK_EDIT_VIEW, {
          timeout: 15000,
          timeoutMsg: "点击卡片后没有进入闲时任务编辑视图",
        });
      } catch (error) {
        // 诊断：区分「没跳转」「跳到列表但没进编辑」「toast 未找到」三种失败形态。
        const dom = await readDomDiagnostics();
        throw new Error(`点击卡片后没有进入闲时任务编辑视图；dom=${JSON.stringify(dom)}`, {
          cause: error,
        });
      }
      await browser.waitUntil(
        async () => (await readTestIdValue(TID_OFFPEAK_FORM_TITLE)) === TASK_TITLE,
        {
          timeout: 10000,
          timeoutMsg: "编辑表单没有回显会话内创建的任务标题",
        },
      );

      await browser.pause(1500);

      // 7) queued 可编辑：改标题保存，列表回显新标题，落库同步。
      await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, UPDATED_TASK_TITLE, {
        timeoutMsg: "闲时任务标题输入不可编辑",
      });
      await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
        timeoutMsg: "闲时任务保存按钮不可点击",
      });
      await ensureIdleTabSelected();
      await browser.waitUntil(
        async () =>
          (await readAllTestIdTexts(TID_OFFPEAK_CARD)).some((t) => t.includes(UPDATED_TASK_TITLE)),
        {
          timeout: 20000,
          timeoutMsg: `闲时任务列表没有回显修改后的标题：${UPDATED_TASK_TITLE}`,
        },
      );
      const updated = await waitForOffPeakRecordByTitle(UPDATED_TASK_TITLE);
      expect(updated.offPeakTaskId).toBe(created.offPeakTaskId);
      // D50：闲时卡片脚注露出绑定会话的当前标题（list 联查 tasks-index）。
      const boundSessionTitle = readTaskTitleById(creatingSessionId);
      expect(boundSessionTitle).toBeTruthy();
      await browser.waitUntil(
        async () =>
          (await readAllTestIdTexts(TID_OFFPEAK_CARD_SESSION)).some((t) =>
            t.includes(boundSessionTitle!),
          ),
        {
          timeout: 10000,
          timeoutMsg: `闲时卡片没有展示绑定会话标题：${boundSessionTitle}`,
        },
      );
      // 让录像尾部停留在列表回显画面，便于验收时看清最终态。
      await browser.pause(1500);
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
  status: string;
  sessionId: string | null;
  conversationId: string | null;
}

function readTaskTitleById(taskId: string): string | null {
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database.prepare(`SELECT title FROM tasks WHERE task_id = ?`).get(taskId) as
      | { title: string }
      | undefined;
    return row?.title?.trim() || null;
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
  // off_peak_tasks 与 tasks 同库；E2E 每次只做一行只读查询并立即关闭。
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
        `SELECT off_peak_task_id, permission_mode, model_selection, status, session_id, conversation_id
         FROM off_peak_tasks WHERE title = ?`,
      )
      .get(title) as
      | {
          off_peak_task_id: string;
          permission_mode: string;
          model_selection: string;
          status: string;
          session_id: string | null;
          conversation_id: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      offPeakTaskId: row.off_peak_task_id,
      permissionMode: row.permission_mode,
      modelSelection: modelSelectionSchema.parse(JSON.parse(row.model_selection)),
      status: row.status,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
    };
  } finally {
    database.close();
  }
}

/** 保存后若回到列表默认 tab，切到闲时任务 tab；已在闲时 tab 时按钮可能不存在，忽略。 */
async function ensureIdleTabSelected(): Promise<void> {
  try {
    await clickTestIdByDom(TID_OFFPEAK_TAB, { timeout: 5000, timeoutMsg: "" });
  } catch {
    // 已在闲时 tab 或 tab 栏未渲染；后续列表断言会给出真实失败原因。
  }
}

async function readDomDiagnostics(): Promise<{
  testIds: string[];
  toasts: string[];
  bodyText: string;
}> {
  return browser.execute(() => {
    const testIds = Array.from(
      new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((el) => el.dataset.testid ?? "")
          .filter((id) => /offpeak|automation|settings|toast/iu.test(id)),
      ),
    );
    const toasts = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="status"],[data-sonner-toast],[data-radix-toast-viewport] *',
      ),
    )
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 5);
    return { testIds, toasts, bodyText: (document.body.innerText ?? "").slice(0, 1500) };
  });
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
