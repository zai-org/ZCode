import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { openProjectMenuAction } from "#e2e/helpers/project-sidebar";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-14：旧同步入口统一打开数据同步弹窗（docs/remote/data-sync.md「旧入口」）。
// 侧栏远端项目菜单、技能 / MCP / 插件设置页的同步按钮，都打开同一个弹窗，定位到当前设备与所选分类。
// Header 更多菜单入口由 WPL-011（同一远端设备推送 marketplace 插件）覆盖。
const CASE_MARKER = "E2E_DSYNC_14_LEGACY_ENTRIES";

type DataSyncCategory = "skills" | "mcp" | "plugins";

interface DialogFacts {
  open: boolean;
  activeTab: string | null;
  device: string;
}

async function readDialogFacts(): Promise<DialogFacts> {
  return await browser.execute(() => {
    const dialog = document.querySelector('[data-testid="remote-sync-dialog"]');
    const active = document.querySelector('[data-testid^="remote-sync-tab-"][aria-current="page"]');
    return {
      open: Boolean(dialog),
      activeTab: active?.getAttribute("data-testid")?.replace("remote-sync-tab-", "") ?? null,
      device:
        document.querySelector('[data-testid="remote-sync-dialog-device"]')?.textContent?.trim() ??
        "",
    };
  });
}

/** 断言打开的是数据同步弹窗、定位到所选分类和当前 SSH 设备，然后关闭它。 */
async function expectDataSyncDialogAndClose(
  entry: string,
  category: DataSyncCategory,
  host: string,
): Promise<void> {
  let facts: DialogFacts = { open: false, activeTab: null, device: "" };
  await browser
    .waitUntil(
      async () => {
        facts = await readDialogFacts();
        return facts.open && facts.activeTab === category && facts.device.includes(host);
      },
      { timeout: 30_000, interval: 300 },
    )
    .catch((error: unknown) => {
      throw new Error(
        `${CASE_MARKER}: ${entry} 没有打开数据同步弹窗的 ${category} 分类；现场: ${JSON.stringify(facts)}`,
        { cause: error },
      );
    });
  expect(facts.device).toContain("SSH");
  // 分类页没有底部「关闭」按钮，用弹窗右上角的关闭按钮。
  await $('[data-testid="remote-sync-dialog"] [data-slot="dialog-close"]').click();
  await browser.waitUntil(async () => !(await readDialogFacts()).open, {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: ${entry} 打开的数据同步弹窗没有关闭`,
  });
}

/** 设置页三个分区共用插件容器且 forceMount；只点当前可见的同步按钮。 */
async function clickVisibleEnabledTestId(id: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((target) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`[data-testid="${target}"]`),
        ).find((element) => element.getClientRects().length > 0);
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, id),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}` },
  );
}

describe(`${CASE_MARKER}: 旧同步入口打开数据同步弹窗`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-14-01 侧栏项目菜单、技能 / MCP / 插件设置页入口都打开数据同步弹窗并定位到设备和分类", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 连接向导的目录步骤（「一键同步」所在页）只在非设备管理的连接完成后出现；现有项目、设置、输入框入口
    // 都以设备管理或项目编辑器完成连接，E2E 无法经正常流程到达。原 UI 单测已退役，
    // 连接向导目录步骤仍是覆盖缺口，不计入本用例。
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });

    // ① 侧栏远端项目菜单 → 同步插件。
    await openProjectMenuAction(workspacePath, "sync-plugins-0");
    await expectDataSyncDialogAndClose("侧栏项目菜单", "plugins", config.host);

    // ② 设置页：技能、MCP、插件三个分区的同步按钮各自定位到对应分类。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
    for (const [section, category] of [
      ["skill", "skills"],
      ["mcp", "mcp"],
      ["plugin", "plugins"],
    ] as const) {
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section), {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 设置页没有 ${section} 分区`,
      });
      await clickVisibleEnabledTestId(
        `data-sync-entry-${category}`,
        `${section} 设置页没有可用的同步按钮`,
      );
      await expectDataSyncDialogAndClose(`${section} 设置页同步按钮`, category, config.host);
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  });
});
