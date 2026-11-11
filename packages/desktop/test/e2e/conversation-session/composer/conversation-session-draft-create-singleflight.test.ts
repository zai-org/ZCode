import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { TID_V4_COMPOSER_SEND, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  V4_MAIN_PANE_ID,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";

interface CreateGate {
  commands: Array<{ type: string; sessionId: string | null }>;
  release(): void;
  restore(): void;
}

declare global {
  interface Window {
    __draftCreateGate?: CreateGate;
  }
}

describe("A01 草稿首发与预热共享一次创建", () => {
  afterEach(async () => {
    await browser.execute(() => window.__draftCreateGate?.restore());
  });

  it("预热创建在途点击发送，最终只提升同一会话", async function () {
    this.timeout(150_000);
    await prepareV4ConversationE2E();
    // 先进入已完成任务，再从真实新任务入口进入新草稿，避免复用前置草稿的预热。
    await sendV4Prompt("E2E_DRAFT_SINGLEFLIGHT_SETUP reply briefly");
    await waitForV4TimelineContaining("draft-singleflight-ok", 45_000);
    await waitForV4Pane((pane) => !pane.canStop && pane.sessionId !== "draft", "前置任务未完成");

    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      let holding = true;
      const gate: CreateGate = {
        commands: [],
        release() {
          holding = false;
          held.splice(0).forEach((send) => send());
        },
        restore() {
          gate.release();
          MessagePort.prototype.postMessage = original;
          delete window.__draftCreateGate;
        },
      };
      // 只暂停真实 RPC 的上行时序，不伪造 createSession/模型结果，也不增加产品测试分支。
      MessagePort.prototype.postMessage = function (
        this: MessagePort,
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        const forward = () => Reflect.apply(original, this, args);
        const data: unknown = args[0];
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        const wire = bytes ? new TextDecoder().decode(bytes) : "";
        const type = wire.match(/"type":"(createSession|sendText)"/)?.[1];
        if (wire.includes("sendConversationCommandV4") && type) {
          // 信封目标可以是 null；不能跳过它而误读 payload 中预分配的新会话 ID。
          const sessionId = wire.match(/"sessionId":(?:null|"([^"]+)")/)?.[1] ?? null;
          gate.commands.push({ type, sessionId });
          if (type === "createSession" && holding) {
            held.push(forward);
            return;
          }
        }
        forward();
      };
      window.__draftCreateGate = gate;
    });
    await startNewV4Draft();
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__draftCreateGate?.commands.length)),
      { timeout: 15_000, timeoutMsg: "未截获草稿预热 createSession" },
    );
    await sendV4Prompt("E2E_DRAFT_SINGLEFLIGHT_FIRST reply briefly");
    const pending = await browser.execute(
      (paneId, sendId) => ({
        commands: window.__draftCreateGate!.commands,
        sending: document.querySelector<HTMLButtonElement>(
          `[data-testid="${paneId}"] [data-testid="${sendId}"]`,
        )?.disabled,
      }),
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
      TID_V4_COMPOSER_SEND,
    );
    expect(pending.sending).toBe(true);
    expect(pending.commands).toEqual([{ type: "createSession", sessionId: null }]);
    expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
    // PD08：首发在途继续输入，接纳交接必须保留下一条正文。
    await setV4ComposerText("E2E_PD08_NEXT_INPUT");

    await browser.execute(() => window.__draftCreateGate!.release());
    await waitForV4TimelineContaining("draft-singleflight-ok", 45_000);
    const pane = await waitForV4Pane(
      (value) => value.sessionId !== "draft" && value.sessionId !== null && !value.canStop,
      "首发没有进入已完成详情页",
    );
    const commands = await browser.execute(() => window.__draftCreateGate!.commands);
    expect(commands).toEqual([
      { type: "createSession", sessionId: null },
      { type: "sendText", sessionId: pane.sessionId },
    ]);
    expect(pane.timelineText).toContain("E2E_DRAFT_SINGLEFLIGHT_FIRST");
    await waitForV4ComposerText("E2E_PD08_NEXT_INPUT", "首发交接丢失下一条正文");
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "draft-create-commands.json"),
      JSON.stringify({ pending, commands, pane }, null, 2),
    );
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "draft-first-send.png"));
  });
});
