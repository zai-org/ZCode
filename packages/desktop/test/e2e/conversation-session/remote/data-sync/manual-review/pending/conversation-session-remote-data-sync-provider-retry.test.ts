import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { createAndConfigurePersonalProvider } from "#e2e/helpers/personal-provider-settings";
import {
  chmodRemoteContainerPath,
  readRemoteContainerFile,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-13：数据同步页「模型提供商」只读分类与失败重试（docs/remote/data-sync.md「模型提供商（只读）」）。
// 事件顺序：打开该设备上的项目（lane 注册，首次下发成功）→ 容器内 ~/.zcode/v2 设为只读
// → 本机保存一次模型配置（personal-config 下发失败，lane 记录失败）→ 分类显示失败与「重试」
// → 恢复可写 → 点「重试」（同一条 lane，trigger user-retry）→ 状态变为成功，容器内配置已更新。
const CASE_MARKER = "E2E_DSYNC_13_PROVIDER_RETRY";
const PROVIDER_NAME = "E2E DSYNC 13 Provider";
const PROVIDER_BASE_URL = "https://dsync13.example.com/v1";
const PROVIDER_API_KEY = "sk-e2e-dsync13-0123456789abcd";
const REMOTE_PROVIDER_DIR = "/home/dev/.zcode/v2";
const REMOTE_PROVIDER_CONFIG = `${REMOTE_PROVIDER_DIR}/provider_config.json`;
const SYNC_TIMEOUT_MS = 120_000;

async function readProvisioningState(): Promise<{ state: string | null; text: string } | null> {
  return await browser.execute(() => {
    const status = document.querySelector<HTMLElement>(
      '[data-testid="remote-sync-providers-status"]',
    );
    return status
      ? { state: status.dataset.provisioningState ?? null, text: status.textContent ?? "" }
      : null;
  });
}

async function waitForProvisioningState(state: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readProvisioningState())?.state === state, {
    timeout: SYNC_TIMEOUT_MS,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}（当前 ${JSON.stringify(await readProvisioningState())}）`,
  });
  return (await readProvisioningState())!;
}

async function readRemoteProviderConfig(container: string): Promise<string> {
  try {
    return await readRemoteContainerFile(container, REMOTE_PROVIDER_CONFIG);
  } catch {
    return "";
  }
}

describe(`${CASE_MARKER}: 数据同步页模型提供商失败重试`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-13-01 远端写入失败后分类显示失败原因与重试，恢复可写后重试成功并更新远端配置", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 打开该设备上的项目：lane 在这里注册，首次下发是连接发布屏障，成功后才进入项目。
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    expect(await readRemoteProviderConfig(container)).not.toContain(PROVIDER_NAME);

    // 以 dev 身份执行才对远端 server 生效（root 无视权限位）；用例结束前一定恢复。
    await chmodRemoteContainerPath(container, "a-w", REMOTE_PROVIDER_DIR);
    let restored = false;
    try {
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
      await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 设置页没有模型供应商分区`,
      });
      await createAndConfigurePersonalProvider({
        apiKey: PROVIDER_API_KEY,
        baseURL: PROVIDER_BASE_URL,
        providerName: PROVIDER_NAME,
      });

      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
      });
      await waitForTestIdByDom("remote-sync-device-list", {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
      });
      await clickTestIdByDom("remote-sync-device-action");
      await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });

      // 概览行不可勾选；最近一次失败时显示「同步失败」。
      await waitForTestIdByDom("remote-sync-overview-providers", { timeout: 30_000 });
      expect(
        await $('[data-testid="remote-sync-overview-checkbox-providers"]').getAttribute("disabled"),
      ).not.toBeNull();
      await clickTestIdByDom("remote-sync-tab-providers");
      const failed = await waitForProvisioningState("failed", "保存模型配置后没有显示下发失败");
      expect(failed.text).toContain("自动同步失败");
      await waitForTestIdByDom("remote-sync-providers-retry", { timeout: 10_000 });

      // 列表只读，API Key 只显示掩码。
      const listText = await browser.execute(
        () =>
          document.querySelector('[data-testid="remote-sync-resource-list"]')?.textContent ?? "",
      );
      expect(listText).toContain(PROVIDER_NAME);
      expect(listText).toContain(PROVIDER_BASE_URL);
      expect(listText).toContain("abcd");
      expect(listText).not.toContain(PROVIDER_API_KEY);
      const overview = await browser.execute(
        () => document.querySelector('[data-testid="remote-sync-dialog"]')?.textContent ?? "",
      );
      expect(overview).not.toContain(PROVIDER_API_KEY);

      await chmodRemoteContainerPath(container, "u+w", REMOTE_PROVIDER_DIR);
      restored = true;
      await clickTestIdByDom("remote-sync-providers-retry");
      const success = await waitForProvisioningState("success", "重试后状态没有变为成功");
      expect(success.text).toContain("已自动同步");
      expect(await $('[data-testid="remote-sync-providers-retry"]').isExisting()).toBe(false);

      const remoteConfig = await readRemoteProviderConfig(container);
      expect(remoteConfig).toContain(PROVIDER_NAME);
      expect(remoteConfig).toContain(PROVIDER_BASE_URL);
    } finally {
      if (!restored) await chmodRemoteContainerPath(container, "u+w", REMOTE_PROVIDER_DIR);
    }
  });
});
