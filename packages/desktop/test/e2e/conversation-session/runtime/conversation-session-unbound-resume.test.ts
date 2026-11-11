import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  TID_V4_MODEL_CONFIG,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  selectRegistryProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";

const CASE_NAME = "conversation-session-unbound-resume";
let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;

describe("Todo 70：模型选择残缺不阻止历史打开", () => {
  before(async () => {
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replay?.stop();
  });

  it("DB109：启动迁移/回滚缺字段及残缺选择不阻止历史，重选后继续原会话", async function () {
    this.timeout(480000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      // 残缺历史恢复需要合法 high/max 目标；通用 seed 默认仅 disabled，不能用它验证重选。
      models: [
        {
          id: UPSTREAM_MODEL,
          reasoningLevel: {
            values: ["high", "max"],
            map: '{"chat_template_kwargs":{"reasoning_effort":reasoningLevel}}',
          },
        },
      ],
      name: UPSTREAM_PROVIDER_NAME,
    });
    // Replay 地址是在 worker 启动后生成的；完整重启让 Host/Agent 从正式
    // Personal Provider 配置读取同一个地址，避免测试进程与 Agent 各连一台服务。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await prepareV4ConversationE2E({ skipProvider: true });
    const selectModel = () =>
      selectRegistryProviderModelById(UPSTREAM_MODEL, {
        providerId: UPSTREAM_PROVIDER_ID,
        providerName: UPSTREAM_PROVIDER_NAME,
        includePlainModelFallback: false,
      });
    await selectModel();
    await sendV4Prompt("E2E_UNBOUND_RESUME_HISTORY: Reply unbound-history-ok.");
    const firstRequest = await waitForUpstreamNetworkCapture("E2E_UNBOUND_RESUME_HISTORY").catch(
      async (error: unknown) => {
        // 失败时展开真实业务错误，避免只记录“没有网络请求”而丢掉发送前失败的根因。
        await browser.execute(() => {
          const details = [...document.querySelectorAll("button")].find((button) =>
            /展开详情|Show details/i.test(button.textContent ?? ""),
          );
          details?.click();
        });
        await browser.saveScreenshot(".e2e-artifacts/todo70-first-send-failure.png");
        const diagnostic = await browser.execute(() => ({
          text: document.body.innerText.slice(-7000),
          config: document.querySelector('[data-testid="v4-model-config"]')?.outerHTML,
        }));
        throw new Error(`${String(error)}; ${JSON.stringify(diagnostic)}`, { cause: error });
      },
    );
    expect(firstRequest.statusCode).toBe(200);
    await waitForV4TimelineContaining("unbound-history-ok");
    const created = await waitForV4Pane(
      (state) => Boolean(state.sessionId) && state.sessionId !== "draft" && !state.canStop,
      "历史首轮未完成",
      60000,
    );
    const sessionId = created.sessionId!;
    const choices = [
      { providerId: UPSTREAM_PROVIDER_ID, modelId: UPSTREAM_MODEL },
      {
        providerId: UPSTREAM_PROVIDER_ID,
        modelId: UPSTREAM_MODEL,
        options: { reasoningLevel: "removed" },
      },
      {
        providerId: "removed-provider",
        modelId: UPSTREAM_MODEL,
        options: { reasoningLevel: "high" },
      },
      undefined,
    ];
    let migrationLedger: unknown;
    for (const [index, selection] of choices.entries()) {
      // 真正旧会话没有 Todo 71 的 Composer 意图。只改 Session DB 会继续显示
      // 首轮发送已保存的合法 max，测到的是“已有草稿优先”而不是历史残缺恢复。
      await browser.execute(
        (workspacePath, targetSessionId) => {
          const key = `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspacePath)}`;
          const raw = localStorage.getItem(key);
          if (!raw) return;
          const file = JSON.parse(raw);
          delete file.scopes[targetSessionId];
          localStorage.setItem(key, JSON.stringify(file));
        },
        DEFAULT_WORKSPACE,
        sessionId,
      );
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
        afterElectronProcessExit: () => {
          // 仅篡改本 case 的隔离会话，且等旧 Agent 退出，避免迟到写盘覆盖 fixture。
          const db = new DatabaseSync(
            join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
          );
          try {
            if (index === 0) {
              // DB109：只在测试隔离库撤销本迁移标记，模拟首次升级；旧消息正文不动。
              db.prepare(
                "DELETE FROM schema_migration WHERE id='0020_provider_model_selection'",
              ).run();
              // 复审回归：旧 User 的空 model 经 0020 转成 null，不能穿透为协议异常。
              db.prepare(
                "UPDATE message SET data=json_set(json_remove(data,'$.modelSelection'),'$.model',json('{}')) WHERE session_id=? AND json_extract(data,'$.role')='user'",
              ).run(sessionId);
            }
            if (index === 3) {
              migrationLedger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
              db.prepare(
                "UPDATE message SET data=json_remove(data,'$.modelSelection') WHERE session_id=? AND json_extract(data,'$.role')='user'",
              ).run(sessionId);
            }
            const persisted =
              index === 0 || index === 3
                ? { providerId: UPSTREAM_PROVIDER_ID, modelId: UPSTREAM_MODEL }
                : { modelSelection: selection };
            const result = db
              .prepare(
                "update session_entry set data = ? where session_id = ? and type = 'runtime/model_selection'",
              )
              .run(JSON.stringify(persisted), sessionId);
            if (!Number(result.changes))
              throw new Error(
                JSON.stringify({
                  sessionId,
                  entries: db.prepare("select session_id,type from session_entry limit 15").all(),
                  sessions: db.prepare("select id,title from session limit 10").all(),
                }),
              );
          } finally {
            db.close();
          }
        },
      });
      await selectV4TaskById(sessionId, 30000);
      await waitForV4TimelineContaining("unbound-history-ok");
      await waitForV4TimelineContaining("E2E_UNBOUND_RESUME_HISTORY");
      const visibleText = await browser.execute(() => document.body.innerText);
      expect(visibleText).not.toMatch(
        /ZodError|invalid_type|Expected object|Invalid input|读取失败|加载失败/,
      );
      const db = new DatabaseSync(
        join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
        { readOnly: true },
      );
      try {
        const row = db
          .prepare(
            "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection'",
          )
          .get(sessionId)!;
        const data = JSON.parse(String(row.data));
        if (index === 0) {
          expect(data).toEqual({
            providerId: UPSTREAM_PROVIDER_ID,
            modelId: UPSTREAM_MODEL,
            modelSelection: choices[0],
          });
          expect(
            db
              .prepare("SELECT id FROM schema_migration WHERE id='0020_provider_model_selection'")
              .get(),
          ).toBeDefined();
        }
        if (index === 3) {
          expect(data).not.toHaveProperty("modelSelection");
          expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(
            migrationLedger,
          );
        }
      } finally {
        db.close();
      }
      // 历史正文和模型目录分别水合；记录真实配置，不用“正文出现”冒充选择已恢复。
      if (index < 2) {
        await browser
          .waitUntil(
            () =>
              browser.execute(
                (tid, expected) =>
                  document.querySelector<HTMLElement>(`[data-testid="${tid}"]`)?.dataset.model ===
                  expected,
                TID_V4_MODEL_CONFIG,
                UPSTREAM_MODEL,
              ),
            { timeout: 15000, timeoutMsg: `DB109 第 ${index} 组模型身份没有恢复` },
          )
          .catch(async (error: unknown) => {
            const diagnostic = await browser.execute(() => ({
              text: document.body.innerText,
              config: document.querySelector('[data-testid="v4-model-config"]')?.outerHTML,
              drafts: Object.fromEntries(
                Object.entries(localStorage).filter(([key]) => key.startsWith("zcode-v4-composer")),
              ),
            }));
            await writeFile(
              join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `unbound-resume-${index}.json`),
              JSON.stringify({ index, selection, diagnostic }, null, 2),
            );
            throw error;
          });
      }
      const config = await browser.execute((tid) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${tid}"]`);
        return { model: el?.dataset.model ?? "", thought: el?.dataset.thought ?? "" };
      }, TID_V4_MODEL_CONFIG);
      expect(config.thought).toBe("");
      if (index >= 2) expect(config.model).toBe("");
      else {
        expect(config.model).toBe(UPSTREAM_MODEL);
        // 模型与思考已合并为同一入口；缺档位显示横线，不能伪装成第一档“关闭”。
        const modelTrigger = await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
        expect(await modelTrigger.getAttribute("aria-label")).not.toMatch(/关闭|Disabled|Off/u);
        expect(await modelTrigger.$("[data-composer-thought-label]").getText()).toBe("—");
      }
      await browser.saveScreenshot(`.e2e-artifacts/todo70-unbound-${index}.png`);
      await selectModel();
      // 通用选择 helper 对同模型直接返回；此处测试残缺配置恢复，必须真实重选该模型。
      const modelTrigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
      if ((await modelTrigger.getAttribute("aria-expanded")) !== "true") await modelTrigger.click();
      const sameModel = $(
        `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, `custom:${UPSTREAM_PROVIDER_ID}:${UPSTREAM_MODEL}`)}"]`,
      );
      await sameModel.waitForClickable({ timeout: 15000 });
      await sameModel.click();
      await browser.keys("Escape");
      await selectUpstreamThoughtLevelValue("high");
      const marker = `E2E_UNBOUND_RESUME_CONTINUE_${index}`;
      await sendV4Prompt(`${marker}: Reply unbound-continue-${index}-ok.`);
      await waitForV4TimelineContaining(`unbound-continue-${index}-ok`);
      const resumed = await waitForV4Pane(
        (state) => state.sessionId === sessionId && !state.canStop,
        "重选后未完成",
        60000,
      );
      expect(resumed.sessionId).toBe(sessionId);
      const request = await waitForUpstreamNetworkCapture(marker);
      expect(request.statusCode).toBe(200);
      expect(request.requestJson).toMatchObject({ model: UPSTREAM_MODEL });
    }
  });
});
