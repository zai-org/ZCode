import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  startNewV4Draft,
} from "#e2e/helpers/v4-conversation";

const MOBILE_PUSH_SWITCH = "settings-mobile-push-switch";

interface PushEvidence {
  queries: number;
  notifications: Array<{
    device_sid: string;
    event: { kind: string; run_id: string; event_id: string };
  }>;
}
/** E2E 的 Main 日志有独立目录，不能用生产配置目录推测测试日志位置。 */
async function readPushLogLines(): Promise<
  Array<{ line: string; fields: Record<string, string> }>
> {
  const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!logDir) throw new Error("missing E2E runtime log directory");
  const logFiles = (await readdir(logDir)).filter((name) => name.endsWith(".log"));
  const logs = (
    await Promise.all(logFiles.map((name) => readFile(join(logDir, name), "utf8")))
  ).join("\n");
  return logs
    .split("\n")
    .filter((line) => line.includes("[mobile-push]"))
    .map((line) => {
      const json = line.slice(line.indexOf("{"));
      try {
        return { line, fields: JSON.parse(json) as Record<string, string> };
      } catch {
        return { line, fields: {} };
      }
    });
}
/** 真实设置页切换开关；返回切换后设置文件里的值，证明写入的是唯一数据源。 */
async function setMobilePushSwitch(enabled: boolean) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15_000 });
  const toggle = $(`[data-testid="${MOBILE_PUSH_SWITCH}"]`);
  await toggle.waitForDisplayed({ timeout: 15_000 });
  const target = enabled ? "checked" : "unchecked";
  if ((await toggle.getAttribute("data-state")) !== target)
    await clickTestIdByDom(MOBILE_PUSH_SWITCH, { timeout: 15_000 });
  await browser.waitUntil(async () => (await toggle.getAttribute("data-state")) === target, {
    timeout: 15_000,
    timeoutMsg: `手机推送开关没有切到 ${target}`,
  });
  await browser.waitUntil(async () => (await readSettings()).mobilePushEnabled === enabled, {
    timeout: 15_000,
    timeoutMsg: `设置文件没有写入 mobilePushEnabled=${enabled}`,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
}
/** 发送一条 prompt 并等待该轮完成；回复文本固定，标识当前轮已落到 timeline。 */
async function sendAndWaitComplete(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4Pane(
    (pane) =>
      pane.sessionId !== "draft" && !pane.canStop && pane.timelineText.includes("mobile-push-ok"),
    `该轮没有完成: ${prompt}`,
    60_000,
  );
}

/** MP01/MP02：真实 Electron Main/凭据/HTTP/WS，只替换外部 server。MP13：本机推送开关。 */
describe("移动端事件通知连接", () => {
  it("自动 HTTP 资格查询不连接远控，关闭远控后释放连接且仍有通知资格", async function () {
    this.timeout(120_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL,
      artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("missing mobile push fixture");
    const evidence = async () =>
      (await (await fetch(`${origin}/__e2e/push`)).json()) as {
        queries: number;
        messages: Array<{
          message: { type: string; device_sid?: string };
        }>;
      };
    const devices = async () =>
      (
        await (
          await fetch(`${origin}/api/v1/remote/device`, {
            headers: { Authorization: "Bearer mock-token" },
          })
        ).json()
      ).data as Array<{ device_sid: string; online: boolean }>;
    await browser.waitUntil(async () => (await evidence()).queries > 0, {
      timeout: 45_000,
      timeoutMsg: "未查询 HTTP 通知资格",
    });
    expect((await devices()).filter((d) => d.online)).toHaveLength(0);
    expect((await evidence()).messages.some((m) => m.message.type === "auth_init")).toBe(false);
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
        for (const button of await $$(
          'button[aria-label="Mobile remote control"],button[aria-label="移动端远程控制"]',
        ))
          if (await button.isDisplayed()) {
            await button.click();
            return true;
          }
        return false;
      },
      { timeout: 60_000 },
    );
    // 由真实远控弹窗启用控制，不直接调用内部 manager。
    const card = $('[data-testid="web-remote-control-connection-card"]');
    await card.waitForDisplayed({ timeout: 40_000 });
    await browser.waitUntil(async () => (await devices()).some((d) => d.online), {
      timeout: 40_000,
    });
    expect((await devices()).filter((d) => d.online)).toHaveLength(1);
    await card.$("button").waitForEnabled({ timeout: 40_000 });
    await card.$("button").click();
    await browser.waitUntil(async () => (await devices()).every((d) => !d.online), {
      timeout: 10_000,
    });
    const pushLogs = (await readPushLogLines()).map((entry) => entry.line).join("\n");
    expect(pushLogs).toContain("eligibility");
    expect(pushLogs).toContain('"status":"available"');
    expect(pushLogs).not.toContain("mock-token");
    expect(pushLogs).not.toContain("x-auth-sign");
    await writeFile(join(artifacts, "mobile-push-logs.txt"), pushLogs);
    await writeFile(
      join(artifacts, "mobile-push-connection.json"),
      JSON.stringify(await evidence(), null, 2),
    );
  });

  it("MP13 关闭手机推送通知后不上报，重新打开后只上报新事件", async function () {
    this.timeout(240_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL,
      artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("missing mobile push fixture");
    const evidence = async () =>
      (await (await fetch(`${origin}/__e2e/push`)).json()) as PushEvidence;
    // MP01 末尾可能还停在远控弹窗；先关闭，再回到可发送的会话。
    await browser.keys("Escape");
    await prepareV4ConversationE2E();
    // 资格已在 MP01 确认；这里再确认一次，避免单独运行本例时事件早于资格。
    await browser.waitUntil(async () => (await evidence()).queries > 0, {
      timeout: 45_000,
      timeoutMsg: "未查询 HTTP 通知资格",
    });

    await setMobilePushSwitch(false);
    await startNewV4Draft();
    await sendAndWaitComplete("E2E_MOBILE_PUSH_DISABLED");
    // 关闭期间的事件由 Main 在读取设置后跳过；跳过日志是这轮事件已处理完的唯一信号。
    let disabledLine: Record<string, string> | undefined;
    await browser.waitUntil(
      async () => {
        disabledLine = (await readPushLogLines()).find(
          ({ fields }) =>
            fields.reason === "user_disabled" &&
            fields.result === "skipped" &&
            fields.kind === "task_completed",
        )?.fields;
        return Boolean(disabledLine);
      },
      { timeout: 30_000, timeoutMsg: "关闭期间没有 user_disabled 的 task_completed 日志" },
    );
    const afterDisabled = await evidence();
    expect(afterDisabled.notifications).toHaveLength(0);

    await setMobilePushSwitch(true);
    await sendAndWaitComplete("E2E_MOBILE_PUSH_ENABLED");
    await browser.waitUntil(async () => (await evidence()).notifications.length > 0, {
      timeout: 30_000,
      timeoutMsg: "重新打开后没有上报新事件",
    });
    const afterEnabled = await evidence();
    expect(afterEnabled.notifications).toHaveLength(1);
    const posted = afterEnabled.notifications[0]!;
    expect(posted.event.kind).toBe("task_completed");
    const started = (await readPushLogLines()).filter(
      ({ fields }) => fields.result === "http_started" && fields.kind === "task_completed",
    );
    // 第一轮（关闭）与第二轮（打开）各有一次 http_started；上报的必须是第二轮，且不补发第一轮。
    expect(started).toHaveLength(2);
    expect(started[0]!.fields.run_id).toBe(disabledLine!.run_id);
    expect(posted.event.run_id).toBe(started[1]!.fields.run_id);
    expect(posted.event.run_id).not.toBe(disabledLine!.run_id);
    expect(posted.event.event_id).not.toBe(disabledLine!.event_id);
    const logs = (await readPushLogLines()).map((entry) => entry.line).join("\n");
    expect(logs).not.toContain("mock-token");
    await writeFile(join(artifacts, "mobile-push-switch-logs.txt"), logs);
    await writeFile(
      join(artifacts, "mobile-push-switch-evidence.json"),
      JSON.stringify({ afterDisabled, afterEnabled }, null, 2),
    );
  });
});
