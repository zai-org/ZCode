// ZCT-2098314627607224320：首发迁移 Root 后，再新建任务必须继承最近接纳的权限。
// 新建草稿按项目隔离；未归类任务仅在首发接纳后分配下一工作区。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_CHAT_MODE_SELECT_TRIGGER, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { ServiceChannels } from "@zcode/shared";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  UPSTREAM_PROVIDER_ID,
  ensureUpstreamProviderForE2E,
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
} from "#e2e/helpers/upstream-provider";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { leaveProjectRowHover, startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { getV4ComposerDraftScopeSnapshot } from "#e2e/helpers/conversation-session-store";
import {
  getV4ModelConfig,
  getV4PaneSnapshot,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted as sendPrompt,
  switchV4Mode,
  switchV4Model,
  setV4ComposerText,
  waitForV4ComposerSelectionReady,
  waitForV4TimelineContaining,
  waitForV4ComposerText,
  sendV4Prompt,
} from "#e2e/helpers/v4-conversation";

declare global {
  interface Window {
    __pdSendGate?: { count: number; release(): void; restore(): void };
  }
}

async function sendV4PromptAndWaitAccepted(prompt: string, marker: string, message: string) {
  try {
    await sendPrompt(prompt, marker, message);
  } catch (error) {
    const details = $('[data-testid="chat-error-details-button"]');
    if (await details.isExisting()) {
      await details.click();
      const content = $('[role="dialog"] pre');
      await content.waitForDisplayed();
      throw new Error(`${message}: ${await content.getText()}`, { cause: error });
    }
    throw error;
  }
}

const CASE_NAME = "conversation-session-composer-recent-mode";
const CASE_DIR = resolveE2ERuntimePath(CASE_NAME);
const OUTPUT_PATH = resolveE2EToolPath(CASE_NAME, "result.txt");
const EVIDENCE_DIR = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);

async function captureState(step: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const permissionTrigger = $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
  await permissionTrigger.waitForDisplayed();
  const state = {
    pane: await getV4PaneSnapshot(),
    composer: await getV4ModelConfig(),
    rootDraft: await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null),
    permissionLabel: await permissionTrigger.getText(),
    persisted: await browser.execute(() => ({
      entries: Object.entries(localStorage).filter(
        ([key]) => key.includes("composer-") || key.includes("pending-command"),
      ),
      navigation: (
        window as unknown as { __zcodeTabStoreE2E: { getState(): unknown } }
      ).__zcodeTabStoreE2E.getState(),
    })),
  };
  await writeFile(join(EVIDENCE_DIR, `${step}.json`), JSON.stringify(state, null, 2));
  await browser.saveScreenshot(join(EVIDENCE_DIR, `${step}.png`));
  return state;
}

async function expectMode(mode: string) {
  await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).waitForDisplayed();
  await waitForV4ComposerSelectionReady();
  expect((await getV4ModelConfig()).mode).toBe(mode);
}

describe("Composer Recent 权限继承", () => {
  it("PD01/02: 任务草稿复用执行目录，接纳后新任务换目录并继承模型权限", async () => {
    await skipOccupationOnboardingIfPresent();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    const startTask = async () => {
      const button = $('[data-testid="virtual-project-new-task"]');
      await $('[data-testid="conversation-section"]').moveTo();
      await button.waitForDisplayed();
      await button.click();
      await browser.waitUntil(
        async () =>
          (await getV4PaneSnapshot()).sessionId === "draft" &&
          (await browser.execute(() => {
            const w = window as unknown as {
              __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
            };
            const pending = JSON.parse(
              localStorage.getItem('zcode-pending-task-draft:v1:["desktop","local",null]') ??
                "null",
            );
            return Boolean(
              pending?.workspacePath &&
              pending.workspacePath === w.__zcodeTabStoreE2E.getState().activeWorkspacePath,
            );
          })),
      );
    };
    const activePath = () =>
      browser.execute(
        () =>
          (
            window as unknown as {
              __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
            }
          ).__zcodeTabStoreE2E.getState().activeWorkspacePath,
      );
    await startTask();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "");
    await switchV4Mode("yolo");
    await setV4ComposerText("E2E_PD01_UNSENT");
    const firstPath = await activePath();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await startTask();
    await waitForV4ComposerText("E2E_PD01_UNSENT", "任务草稿未恢复");
    expect(await activePath()).toBe(firstPath);
    await expectMode("yolo");
    const selected = await getV4ModelConfig();
    await sendV4PromptAndWaitAccepted(
      "E2E_COMPOSER_RECENT_MODE_SEED 请回复测试标记。",
      "E2E_COMPOSER_RECENT_MODE_SEED",
      "任务首发未接纳",
    );
    await startTask();
    await waitForV4ComposerText("", "新任务不应复制已发送正文");
    expect(await activePath()).not.toBe(firstPath);
    await expectMode("yolo");
    expect(await getV4ModelConfig()).toMatchObject({
      provider: selected.provider,
      model: selected.model,
    });
  });

  it("PD03/04/09: 同目录项目独立保存草稿和默认配置，修改主要目录保留项目草稿", async () => {
    await installHandoffRpcProbe();
    try {
      const p = await callHandoffHost<{ id: string }>(ServiceChannels.Project, "saveProject", [
        { name: "E2E_PD_P", roots: [DEFAULT_WORKSPACE], primaryRoot: DEFAULT_WORKSPACE },
      ]);
      const q = await callHandoffHost<{ id: string }>(ServiceChannels.Project, "saveProject", [
        { name: "E2E_PD_Q", roots: [DEFAULT_WORKSPACE], primaryRoot: DEFAULT_WORKSPACE },
      ]);
      const start = async (id: string) => {
        const section = $(`[data-project-id="${id}"]`);
        await section.waitForDisplayed();
        await section.moveTo();
        await section.$('[data-testid="virtual-project-create-task"]').click();
        // 项目详情 hover card 会盖住 Composer 模式选择器，点完先移开指针。
        await leaveProjectRowHover();
      };
      await start(p.id);
      await setV4ComposerText("E2E_PD_PROJECT_P");
      await switchV4Mode("yolo");
      await start(q.id);
      await waitForV4ComposerText("", "Q 错读 P 的草稿");
      await setV4ComposerText("E2E_PD_PROJECT_Q");
      await switchV4Mode("build");
      await start(p.id);
      await waitForV4ComposerText("E2E_PD_PROJECT_P", "P 草稿被覆盖");
      await expectMode("yolo");
      await start(q.id);
      await waitForV4ComposerText("E2E_PD_PROJECT_Q", "Q 草稿被覆盖");
      await expectMode("build");
      await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "");
      await sendV4PromptAndWaitAccepted(
        "E2E_COMPOSER_RECENT_MODE_SECOND Q",
        "E2E_COMPOSER_RECENT_MODE_SECOND",
        "Q 首发未接纳",
      );
      await waitForV4TimelineContaining("RECENT_MODE_SECOND_DONE");
      await start(p.id);
      await waitForV4ComposerText("E2E_PD_PROJECT_P", "Q 接纳污染 P 草稿");
      await expectMode("yolo");
      await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "");
      await sendV4PromptAndWaitAccepted(
        "E2E_COMPOSER_RECENT_MODE_SECOND P",
        "E2E_COMPOSER_RECENT_MODE_SECOND",
        "P 首发未接纳",
      );
      await waitForV4TimelineContaining("RECENT_MODE_SECOND_DONE");
      const pSession = (await getV4PaneSnapshot()).sessionId;
      await start(q.id);
      await waitForV4ComposerText("", "Q 已发送正文复活");
      await expectMode("build");
      expect((await getV4ModelConfig()).model).toBe(UPSTREAM_SECONDARY_MODEL);
      await start(p.id);
      await expectMode("yolo");
      expect((await getV4ModelConfig()).model).toBe(UPSTREAM_MODEL);
      await setV4ComposerText("E2E_PD_PROJECT_MOVED_ROOT");
      const nextRoot = join(CASE_DIR, "new-primary");
      await mkdir(nextRoot, { recursive: true });
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        {
          id: p.id,
          name: "E2E_PD_P_RENAMED",
          roots: [DEFAULT_WORKSPACE, nextRoot],
          primaryRoot: nextRoot,
        },
      ]);
      await start(p.id);
      await waitForV4ComposerText("E2E_PD_PROJECT_MOVED_ROOT", "项目换主要目录丢失草稿");
      await expectMode("yolo");
      const directories = await callHandoffHost<{ workspacePath: string }>(
        ServiceChannels.Project,
        "resolveSessionDirectories",
        [{ workspacePath: DEFAULT_WORKSPACE, taskId: pSession }],
      );
      expect(directories.workspacePath).toBe(DEFAULT_WORKSPACE);
    } finally {
      await restoreHandoffProbes();
    }
  });
  it("PD06/07: 首发在途切走再返回保留目录，迟到接纳完成原任务交接", async () => {
    const startTask = async () => {
      await $('[data-testid="conversation-section"]').moveTo();
      await $('[data-testid="virtual-project-new-task"]').click();
      await browser.waitUntil(
        async () =>
          (await getV4PaneSnapshot()).sessionId === "draft" &&
          (await browser.execute(() => {
            const w = window as unknown as {
              __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
            };
            const pending = JSON.parse(
              localStorage.getItem('zcode-pending-task-draft:v1:["desktop","local",null]') ??
                "null",
            );
            return Boolean(
              pending?.workspacePath &&
              pending.workspacePath === w.__zcodeTabStoreE2E.getState().activeWorkspacePath,
            );
          })),
      );
    };
    const path = () =>
      browser.execute(
        () =>
          (
            window as unknown as {
              __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
            }
          ).__zcodeTabStoreE2E.getState().activeWorkspacePath,
      );
    await startTask();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "");
    await switchV4Mode("yolo");
    const pendingPath = await path();
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      let holding = true;
      const gate = {
        count: 0,
        release() {
          holding = false;
          held.splice(0).forEach((send) => send());
        },
        restore() {
          gate.release();
          MessagePort.prototype.postMessage = original;
          delete window.__pdSendGate;
        },
      };
      MessagePort.prototype.postMessage = function (
        this: MessagePort,
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        const data = args[0];
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        const wire = bytes ? new TextDecoder().decode(bytes) : "";
        const forward = () => Reflect.apply(original, this, args);
        if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"')) {
          gate.count += 1;
          if (holding) {
            held.push(forward);
            return;
          }
        }
        forward();
      };
      window.__pdSendGate = gate;
    });
    try {
      await sendV4Prompt("E2E_COMPOSER_RECENT_MODE_SECOND LATE_ACK");
      await browser.waitUntil(() => browser.execute(() => window.__pdSendGate?.count === 1));
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await startTask();
      expect(await path()).toBe(pendingPath);
      expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
      await browser.execute(() => window.__pdSendGate!.release());
      await waitForV4TimelineContaining("RECENT_MODE_SECOND_DONE");
      expect(await browser.execute(() => window.__pdSendGate!.count)).toBe(1);
      expect((await getV4PaneSnapshot()).sessionId).not.toBe("draft");
      await startTask();
      expect(await path()).not.toBe(pendingPath);
      await waitForV4ComposerText("", "迟到接纳污染下一份任务草稿");
      await expectMode("yolo");
    } finally {
      await browser.execute(() => window.__pdSendGate?.restore());
    }
  });
  // CASE_DIR 位于隔离 HOME 内，由 runner 在进程退出后统一删除；Host 仍监听项目目录时
  // 提前删除会在 Windows 上 EBUSY。
  after(async () => {
    await clearAppData();
  });

  it("TD01/03/04: 空白不保存，文字刷新恢复，删空后 New Task 重新取默认", async () => {
    await skipOccupationOnboardingIfPresent();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "");
    await switchV4Mode("yolo");
    expect((await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).exists).toBe(false);
    await setV4ComposerText("unsent text persistence");
    await browser.waitUntil(
      async () =>
        (await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).text ===
        "unsent text persistence",
    );
    await browser.refresh();
    try {
      await waitForV4ComposerText("unsent text persistence", "刷新没有恢复文字草稿");
    } catch (error) {
      const diagnosis = await browser.executeAsync(async (done) => {
        const script = document.querySelector<HTMLScriptElement>('script[type="module"]');
        let moduleError = "";
        try {
          if (script?.src) await import(script.src);
        } catch (cause) {
          moduleError = String(cause);
        }
        done({
          body: document.body.innerText,
          moduleError,
          url: location.href,
          storage: Object.entries(localStorage).filter(([key]) => key.includes("composer-")),
        });
      });
      await mkdir(EVIDENCE_DIR, { recursive: true });
      await writeFile(
        join(EVIDENCE_DIR, "refresh-failure.json"),
        JSON.stringify(diagnosis, null, 2),
      );
      throw error;
    }
    await expectMode("yolo");
    await setV4ComposerText(" ");
    await browser.waitUntil(
      async () => !(await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).exists,
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("build");
    await switchV4Mode("yolo");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("build");
    expect((await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).exists).toBe(false);
    await captureState("00-text-only-draft");
  });

  it("I74/I75: 完全访问首发后 New Task 保留权限，已有草稿与 Session 选择仍各自独立", async () => {
    // 修复原因：PD03 已把 CASE_DIR/new-primary 存为项目主要目录，Host 仍在监听该目录；
    // Windows 上删除被监听目录会 EBUSY。本用例只需清掉自己断言的写入结果。
    await mkdir(CASE_DIR, { recursive: true });
    await rm(join(CASE_DIR, "result.txt"), { force: true });
    await skipOccupationOnboardingIfPresent();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    // 本用例验证模型身份和权限，不强制当前模型目录未提供的思考档位。
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "");
    await expectMode("build");
    await switchV4Mode("yolo");
    await expectMode("yolo");
    const selected = await getV4ModelConfig();
    await sendV4PromptAndWaitAccepted(
      "E2E_COMPOSER_RECENT_MODE_SEED 请回复测试标记。",
      "E2E_COMPOSER_RECENT_MODE_SEED",
      "第一次输入未被接纳",
    );
    await waitForV4TimelineContaining("RECENT_MODE_STREAMING");
    const firstSession = (await getV4PaneSnapshot()).sessionId!;
    const first = await captureState("01-accepted-yolo");
    expect(first.composer.mode).toBe("yolo");
    expect(first.pane.canStop).toBe(true);

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4ComposerSelectionReady();
    const next = await captureState("02-new-task-mode");
    // 修复前这里稳定取得 actual=build，证明是新 Root 初始化回退。
    expect(next.composer.mode).toBe("yolo");
    expect(next.rootDraft.exists).toBe(false);
    expect(next.composer).toMatchObject({ provider: selected.provider, model: selected.model });
    await sendV4PromptAndWaitAccepted(
      `E2E_COMPOSER_RECENT_MODE_WRITE 请写入 ${OUTPUT_PATH}`,
      "E2E_COMPOSER_RECENT_MODE_WRITE",
      "继承权限后的输入未被接纳",
    );
    await waitForV4TimelineContaining("RECENT_MODE_DONE", 60_000);
    const secondSession = (await getV4PaneSnapshot()).sessionId!;
    expect(secondSession).not.toBe(firstSession);
    expect(await readFile(join(CASE_DIR, "result.txt"), "utf8")).toBe("RECENT_MODE_WRITE_OK\n");
    expect(
      (await getLatestUpstreamToolResultByToolCallId("toolu_recent_mode_write"))?.isError,
    ).toBe(false);
    await captureState("03-inherited-mode-executed");

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("yolo");
    // TD02：先打开空白页，再回原 Session 改选 B 并发送，旧空白页不能覆盖 Recent。
    await selectV4TaskById(secondSession);
    await switchV4Mode("build");
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "");
    await sendV4PromptAndWaitAccepted(
      "E2E_COMPOSER_RECENT_MODE_SECOND 回复标记。",
      "E2E_COMPOSER_RECENT_MODE_SECOND",
      "第二次选择未被接纳",
    );
    await waitForV4TimelineContaining("RECENT_MODE_SECOND_DONE");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("build");
    const updated = await captureState("04-new-task-model-b");
    expect(updated.composer.model).toBe(UPSTREAM_SECONDARY_MODEL);
    expect(updated.rootDraft.exists).toBe(false);
    // TD04：同一个空白页面再次 New Task，丢弃未提交配置；删空文字后也不留记录。
    await switchV4Mode("yolo");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("build");
    await setV4ComposerText("temporary draft");
    await browser.waitUntil(
      async () =>
        (await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).text === "temporary draft",
    );
    await setV4ComposerText("");
    await browser.waitUntil(
      async () => !(await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).exists,
    );
    await setV4ComposerText("unsent root draft");
    await switchV4Mode("plan");
    await selectV4TaskById(firstSession);
    await expectMode("yolo");
    await setV4ComposerText("unsent session draft");
    await switchV4Mode("build");
    await selectV4TaskById(secondSession);
    await expectMode("build");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await expectMode("build");
    await $('[data-testid="v4-composer-plan-marker"]').waitForDisplayed();
    await browser.refresh();
    await expectMode("build");
    await $('[data-testid="v4-composer-plan-marker"]').waitForDisplayed();
    await selectV4TaskById(firstSession);
    // 刷新后的缓存草稿可先于历史投影就绪；必须等旧 Snapshot 恢复后再断言不被覆盖。
    await waitForV4TimelineContaining("RECENT_MODE_STREAMING");
    // 正式会话重开恢复文字，权限取最新 Snapshot；未发送的菜单选择不替代运行事实。
    await expectMode("yolo");
    await waitForV4ComposerText("unsent session draft", "正式会话的文字草稿未恢复");
    await captureState("05-session-draft-isolation");
  });
});
