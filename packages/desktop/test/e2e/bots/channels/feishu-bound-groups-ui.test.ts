import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotsStateFile } from "@zcode/shared";
import {
  getE2EAppDataPaths,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { createFeishuConfig } from "#e2e/bots/helpers/bots-service-harness";

/** BOT-E2E-GR-UI-01：真实 Desktop → RPC → Bot repo；无平台凭据，不向真实群发消息。 */
describe("bound groups Desktop controls", () => {
  it("counts topics, persists a group switch and isolates other groups and bots", async () => {
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    const { appDataDir } = getE2EAppDataPaths();
    const config = createFeishuConfig("feishu", "groups-ui");
    // 保留绑定形状但不写任何密钥，避免页面自动启动飞书扫码注册。
    config.bots[0]!.credentialRef = "bot:groups-ui:isolated-missing";
    config.bots[0]!.name = "E2E Bound Groups";
    const state: BotsStateFile = { version: 3, bots: {} };
    const add = (botId: string, chatId: string, threadId?: string) => {
      state.bots[JSON.stringify([botId, chatId, ...(threadId ? [threadId] : [])])] = {
        botId,
        workspacePath: appDataDir,
        mode: "draft",
        activeTaskId: null,
        updatedAt: Date.now(),
        group: {
          chatId,
          threadId,
          name: `E2E ${chatId}`,
          ownerId: "ou_e2e_user",
          enabled: true,
          authorizationId: `auth-${chatId}`,
          taskIds: [],
          currentOptions: {},
        },
      };
    };
    add("groups-ui", "group-a");
    add("groups-ui", "group-a", "topic-1");
    add("groups-ui", "group-a", "topic-2");
    add("groups-ui", "group-b");
    add("other-bot", "group-c");
    await mkdir(appDataDir, { recursive: true });
    const stateFile = join(appDataDir, "bot-state.v3.json");
    await writeFile(join(appDataDir, "bot-config.v3.json"), JSON.stringify(config));
    await writeFile(stateFile, JSON.stringify(state));
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);
    const remote = await $('button[aria-label="移动端远程控制"]');
    await remote.waitForClickable({ timeout: 20000 });
    await remote.click();
    await $('[data-testid="web-remote-control-open-bots"]').click();
    const row = await $('[data-testid="bot-bound-groups"] [data-group-id="group-a"]');
    await row.waitForDisplayed({ timeout: 20000 });
    expect(await row.getText()).toMatch(/2/);
    expect(await $$('[data-testid="bot-bound-groups"] [data-group-id]')).toHaveLength(2);
    const toggle = await row.$('[role="switch"]');
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute("aria-checked")) === "false", {
      timeout: 15000,
    });
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as BotsStateFile;
    expect(persisted.bots[JSON.stringify(["groups-ui", "group-a"])]!.group!.enabled).toBe(false);
    expect(persisted.bots[JSON.stringify(["groups-ui", "group-b"])]).toEqual(
      state.bots[JSON.stringify(["groups-ui", "group-b"])],
    );
    expect(persisted.bots[JSON.stringify(["other-bot", "group-c"])]).toEqual(
      state.bots[JSON.stringify(["other-bot", "group-c"])],
    );
    // 保留话题记录；关闭授权不能把历史数量清空。
    expect(await row.getText()).toMatch(/2/);
    await row.scrollIntoView({ block: "center" });
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) await browser.saveScreenshot(join(artifactDir, "BOT-E2E-GR-UI-01.png"));
  });
});
