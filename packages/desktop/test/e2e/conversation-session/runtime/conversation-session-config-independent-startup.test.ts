import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  testId,
  TID_V4_SESSION_PANE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4AssistantMessageContaining,
  waitForV4UserMessageContaining,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-config-independent-startup";
const CONFIG_REQUEST_TIMEOUT_MS = 15_000;
const markers = ["E2E_SCB_COLD", "E2E_SCB_WARM", "E2E_SCB_RESUME"];
interface Timing {
  enterAt: number;
  boundAt?: number;
  userVisibleAt?: number;
}

// SCB01/02：配置网关在 beforeSession 就保持 pending，不启用 ZCODE_OFFPEAK_MOCK。
// 必须在网关一个配置响应都没返回的条件下证明真实 Enter -> 接纳投影 -> HTTP dispatch。
describe("配置等待与普通聊天隔离", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SCB01/02: 冷 draft、续发与重启冷恢复都能在配置 pending 时发送", async function () {
    this.timeout(240_000);
    expect(process.env.ZCODE_OFFPEAK_MOCK).not.toBe("1");
    await prepareV4ConversationE2E();
    const evidence: unknown[] = [];
    let sessionId = "";
    try {
      for (const [index, marker] of markers.entries()) {
        if (index === 2) {
          await reloadElectronSessionSafely(browser);
          await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
          await selectV4TaskById(sessionId);
          await waitForV4AssistantMessageContaining("scb-warm-ok");
        }
        const before = await configStatus();
        expect(before.blocked).toBe(true);
        expect(before.configResponses).toBe(0);
        await enterPrompt(marker);
        await waitForV4UserMessageContaining(marker);
        await waitForUpstreamRequest(
          { lastUserMessageIncludes: [marker] },
          "配置 pending 阻塞了模型请求",
          15_000,
        );
        const query = { lastUserMessageIncludes: [marker] };
        const tools = await getUpstreamRequestToolNames(query);
        await waitForV4AssistantMessageContaining(
          ["scb-cold-ok", "scb-warm-ok", "scb-resume-ok"][index]!,
        );
        const pane = await waitForV4Pane(
          (value) => Boolean(value.sessionId && value.sessionId !== "draft" && !value.canStop),
          "会话未完成",
        );
        if (index === 0) sessionId = pane.sessionId!;
        else expect(pane.sessionId).toBe(sessionId);
        const timing = await browser.execute(() => {
          document.dispatchEvent(new Event("scb-timing-done"));
          return (window as unknown as { __scbTiming: Timing }).__scbTiming;
        });
        const [request] = await getUpstreamRequestEvidence(query);
        if (!request) throw new Error("缺少 provider request evidence");
        const after = await configStatus();
        expect(after.configResponses).toBe(0);
        expect(timing.enterAt).toBeGreaterThan(0);
        expect(timing.userVisibleAt).toBeGreaterThanOrEqual(timing.enterAt);
        evidence.push({
          marker,
          sessionId,
          ...timing,
          enterToBindingMs: timing.boundAt === undefined ? null : timing.boundAt - timing.enterAt,
          enterToUserVisibleMs:
            timing.userVisibleAt === undefined ? null : timing.userVisibleAt - timing.enterAt,
          enterToDispatchMs: Date.parse(request.startedAt) - timing.enterAt,
          config: after,
        });
        // 不能只断言最终成功：等待整个配置超时后发送仍然是本次要捕获的退化。
        expect(Date.parse(request.startedAt) - timing.enterAt).toBeLessThan(
          CONFIG_REQUEST_TIMEOUT_MS,
        );
        expect(request.status).toBe("complete");
        expect(tools).toContain("OffPeakCreate");
        expect(tools).toContain("OffPeakList");
      }
    } finally {
      const root = join(getE2EAppDataPaths().homeDir, "ZCodeProject", ".zcode-e2e", CASE_NAME);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "timing.json"), JSON.stringify(evidence, null, 2));
      console.log("SCB_TIMING", JSON.stringify(evidence));
    }
  });
});

async function configStatus(): Promise<{
  blocked: boolean;
  configRequests: number;
  configResponses: number;
}> {
  const origin = process.env.ZCODE_TEST_BASE_URL;
  if (!origin) throw new Error("缺少 case-local 配置网关");
  return await (await fetch(new URL("/__scb/status", origin))).json();
}

async function enterPrompt(marker: string) {
  await setV4ComposerText(`${marker}: Reply briefly.`);
  const paneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  // DOM 写入完成后需等 React 提交可发送状态；否则紧随其后的 Enter 会被旧状态忽略。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneId, buttonId) => {
          const button = document.querySelector<HTMLButtonElement>(
            `[data-testid="${paneId}"] [data-testid="${buttonId}"]`,
          );
          return Boolean(button && !button.disabled);
        },
        paneTestId,
        TID_V4_COMPOSER_SEND,
      ),
    { timeout: CONFIG_REQUEST_TIMEOUT_MS, timeoutMsg: "配置 pending 时发送按钮未就绪" },
  );
  await browser.execute(
    (paneId, promptMarker) => {
      const state: Timing = { enterAt: 0 };
      (window as unknown as { __scbTiming: Timing }).__scbTiming = state;
      const observe = () => {
        if (!state.enterAt) return;
        const pane = document.querySelector(`[data-testid="${paneId}"]`);
        const id = pane?.getAttribute("data-session-id");
        if (id && id !== "draft" && state.boundAt === undefined) state.boundAt = Date.now();
        if (
          Array.from(pane?.querySelectorAll("[data-row-id]") ?? []).some(
            (row) =>
              row.classList.contains("group/user-row") && row.textContent?.includes(promptMarker),
          ) &&
          state.userVisibleAt === undefined
        )
          state.userVisibleAt = Date.now();
      };
      const observer = new MutationObserver(observe);
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Enter") return;
          state.enterAt = Date.now();
          observe();
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        },
        { once: true, capture: true },
      );
      // 只记录本次提交；收尾用一次性自定义事件释放 observer。
      document.addEventListener("scb-timing-done", () => observer.disconnect(), { once: true });
    },
    paneTestId,
    marker,
  );
  const input = await browser.$(
    `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`,
  );
  await input.click();
  await browser.keys("Enter");
}
