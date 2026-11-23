import { BufferReader, BufferWriter, VSBuffer, deserialize, serialize } from "@zcode/rpc";
import { join } from "node:path";
import { selectTaskById } from "#e2e/helpers/conversation-session";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  startNewV4Draft,
  sendV4Prompt,
  getV4Messages,
  sendV4PromptAndWaitAccepted,
  getLatestV4CommandAck,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

declare global {
  interface Window {
    __activitySendFault?: { bytes: number[]; port: MessagePort };
  }
}
const trigger = '[data-status-capsule="activity"]';
const panel = '[data-status-capsule-content="activity"]';

async function openActivity() {
  const button = await $(trigger);
  await button.waitForDisplayed({ timeout: 60000 });
  if (!(await $(panel).isDisplayed())) await button.click();
  await $(panel).waitForDisplayed({ timeout: 15000 });
}

// ACT01/05/06/09/10：工具实际执行，Provider 只决定工具输入，不注入投影。
describe("Activity retention desktop candidate", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("保留真实后台结果，下一轮收起明细，无目录时隐藏，刷新保持隐藏", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    // 系统语言可能为日/韩/俄文；先固定真实界面语言，避免正确状态文案被中英文正则误判。
    await pinE2ELocale("en-US");
    await ensureToolCrossProductFullAccessMode();
    for (const [state, result] of [
      ["DONE", "completed"],
      ["STOP", "stopped"],
      ["FAIL", "failed"],
    ] as const) {
      const marker = `E2E_ACTIVITY_${state}`;
      await sendV4PromptAndWaitAccepted(marker, marker, "真实用户输入没有接纳");
      await openActivity();
      if (state === "STOP") {
        await browser.keys("Escape");
        const runningInput = "E2E_ACTIVITY_WHILE_RUNNING";
        await sendV4PromptAndWaitAccepted(runningInput, runningInput, "运行中消息未接纳");
        await openActivity();
        expect((await $$(`${panel} [data-background-task-kind="bash"]`)).length).toBe(1);
        const stop = await $(`${panel} [data-testid^="v4-background-work-cancel-"]`);
        await stop.waitForDisplayed({ timeout: 30000 });
        await stop.click();
        await browser.waitUntil(
          async () => (await getLatestV4CommandAck("cancelBackgroundWork"))?.status === "accepted",
          {
            timeout: 30000,
            timeoutMsg: "停止命令未被接纳",
          },
        );
      }
      const ended = `${panel} [data-activity-result="${result}"]`;
      await $(ended).waitForDisplayed({ timeout: 60000 });
      expect(await $(trigger).isDisplayed()).toBe(true);
      // 成功／失败的主标签表示状态，次要位只显示对应数量；停止沿用原摘要。
      expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe(
        state === "STOP" ? "Stopped" : "1",
      );
      if (state !== "STOP") {
        expect(await $(trigger).getText()).toContain(state === "DONE" ? "Completed" : "Failed");
      }
      expect(await $(`${ended} [data-testid^="v4-background-work-cancel-"]`).isExisting()).toBe(
        false,
      );
      await waitForV4ConversationState((s) => s.state !== "streaming", "后台通知没有收口", 60000);
      const frozenText = await $(ended).getText();
      if (state === "DONE") expect(frozenText).toContain("E2E_ACTIVITY_REAL_OUTPUT");
      if (state === "FAIL") expect(frozenText).toContain("E2E_ACTIVITY_REAL_ERROR");
      await browser.refresh();
      await openActivity();
      await $(ended).waitForDisplayed({ timeout: 60000 });
      expect(await $(ended).getText()).toBe(frozenText);
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `activity-${state}.png`),
      );
      await browser.keys("Escape");
      if (state === "DONE") {
        const sessionId = (await getV4PaneSnapshot()).sessionId!;
        await startNewV4Draft();
        expect(await $(trigger).isExisting()).toBe(false);
        await selectTaskById(sessionId);
        await openActivity();
        await $(ended).waitForDisplayed({ timeout: 30000 });
        await browser.keys("Escape");
        // 仅在 RPC 发出前断开一次传输，不伪造 ACK、不写 store；Agent 不可能接纳此消息。
        await browser.execute(() => {
          const original = MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
            const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
            if (
              text.includes("sendConversationCommandV4") &&
              text.includes("E2E_ACTIVITY_SEND_REJECTED")
            ) {
              MessagePort.prototype.postMessage = original;
              window.__activitySendFault = { bytes: Array.from(message as Uint8Array), port: this };
              return;
            }
            return Reflect.apply(
              original,
              this,
              options === undefined ? [message] : [message, options],
            );
          };
        });
        await sendV4Prompt("E2E_ACTIVITY_SEND_REJECTED");
        const bytes = await browser.execute(() => window.__activitySendFault?.bytes);
        expect(bytes).toBeDefined();
        const header = deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes!)))) as [
          number,
          number,
        ];
        const writer = new BufferWriter();
        serialize(writer, [202, header[1]]);
        serialize(writer, {
          name: "Error",
          message: "E2E_ACTIVITY_SEND_REJECTED transport unavailable",
          stack: [],
        });
        await browser.execute((bytes) => {
          window.__activitySendFault!.port.dispatchEvent(
            new MessageEvent("message", { data: Uint8Array.from(bytes) }),
          );
          delete window.__activitySendFault;
        }, Array.from(writer.buffer.buffer));
        await browser.waitUntil(
          async () => (await getLatestV4CommandAck("sendText"))?.status === "transport-error",
          { timeout: 15000, timeoutMsg: "接纳前传输故障未触发" },
        );
        expect(
          (await getV4Messages("user")).some((row) =>
            row.text.includes("E2E_ACTIVITY_SEND_REJECTED"),
          ),
        ).toBe(false);
        const banner = $('[data-testid="chat-error-banner"]');
        await banner.waitForDisplayed({ timeout: 15000 });
        const buttons = await banner.$$("button");
        await buttons[(await buttons.length) - 1]!.click();
        await openActivity();
        await $(ended).waitForDisplayed({ timeout: 15000 });
        await browser.keys("Escape");
      }
      const next = `E2E_ACTIVITY_CLEAR_${state}`;
      await sendV4PromptAndWaitAccepted(next, next, "下一条消息未被接纳");
      await $(trigger).waitForExist({ reverse: true, timeout: 30000 });
      expect(await $(panel).isExisting()).toBe(false);
      await waitForV4ConversationState((s) => s.state !== "streaming", "清除消息未结束", 60000);
      await browser.refresh();
      await browser.waitUntil(
        async () => await $('[data-testid="v4-session-pane-workspace-main"]').isExisting(),
        { timeout: 30000 },
      );
      await waitForV4ConversationState((s) => s.state !== "streaming", "刷新快照未恢复", 30000);
      expect(await $(trigger).isExisting()).toBe(false);
    }
  });
});
