import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  capturePluginManualReview,
  openPluginManagementSettings,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

// 内置插件默认已安装，只需在 Workspace 配置里显式启用即可得到 enabledSource=workspace，
// 让详情页出现「恢复 User 默认」操作，不依赖额外 Marketplace fixture。
const BUILTIN_ID = "skill-creator@zcode-plugins-official";
const MENU_LAYOUT_TIMEOUT_MS = 240000;
const RESTORE_USER_DEFAULT_PATTERN = /恢复 User 默认|Restore User default/u;

interface MenuItemLayout {
  text: string;
  textLineCount: number;
  height: number;
}

describe("PLM-LC-017 已安装列表行内菜单布局 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Workspace 覆盖下开关外显、菜单只含卸载且保持单行", async function () {
    this.timeout(MENU_LAYOUT_TIMEOUT_MS);
    requirePluginManualReview();

    await seedWorkspacePluginOverride();
    // Agent 在 workspace 打开时读取配置；先写文件再重启，确保列表带上 workspace 归属。
    await restartPluginLifecycleApp();
    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: BUILTIN_ID }, 60000);
    await browser.waitUntil(
      () =>
        browser.execute((pluginId) => {
          const row = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
          ).find((candidate) => candidate.dataset.pluginId === pluginId);
          return (
            Boolean(
              row?.querySelector(
                '[data-testid="plugin-settings-enabled-switch"][data-state="checked"]',
              ),
            ) && !row?.querySelector("[data-settings-scope]")
          );
        }, BUILTIN_ID),
      { timeout: 30000, timeoutMsg: "已安装列表未展示启用开关或仍显示配置来源标签" },
    );

    await browser.execute((pluginId) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
      ).find((candidate) => candidate.dataset.pluginId === pluginId);
      const trigger = row?.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
      if (!trigger) throw new Error("已安装列表行内没有「…」菜单触发器");
      // 内置插件行位于列表下方，先滚到视口中央，人工审核截图才能同时看到行与展开的菜单。
      row?.scrollIntoView({ block: "center" });
      // Radix DropdownMenu 在 pointerdown 上切换 open；仅 click 不会打开菜单。
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
    }, BUILTIN_ID);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll(
              '[data-slot="dropdown-menu-content"][data-state="open"] [role="menuitem"]',
            ).length === 1,
        ),
      { timeout: 15000, timeoutMsg: "行内「…」菜单没有展开" },
    );

    const items = await browser.execute((): MenuItemLayout[] => {
      const content = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-content"][data-state="open"]',
      );
      if (!content) return [];
      return Array.from(content.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => {
        // 只统计文本节点的行框：菜单项是 flex 行，文本节点会成为匿名 flex item，
        // 折行时 Range 会返回多个非空 rect。
        let textLineCount = 0;
        for (const node of Array.from(item.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          textLineCount += Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          ).length;
        }
        return {
          text: item.innerText.trim(),
          textLineCount,
          height: item.getBoundingClientRect().height,
        };
      });
    });
    await capturePluginManualReview("PLM-LC-017", "installed-row-menu-workspace-override");

    const restoreItem = items.find((item) => RESTORE_USER_DEFAULT_PATTERN.test(item.text));
    expect(restoreItem).toBeUndefined();
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toMatch(/卸载|Uninstall/u);
    const wrapped = items.filter((item) => item.textLineCount !== 1);
    if (wrapped.length > 0) {
      throw new Error(`菜单项折行：${JSON.stringify(wrapped)}`);
    }
    // 所有菜单项等高，进一步排除折行把某一行撑高。
    const heights = new Set(items.map((item) => Math.round(item.height)));
    if (heights.size !== 1) {
      throw new Error(`菜单项高度不一致：${JSON.stringify(items)}`);
    }
  });
});

async function seedWorkspacePluginOverride(): Promise<void> {
  const { workspace } = getE2EAppDataPaths();
  const configPath = join(workspace, ".zcode", "config.json");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  const existing = existsSync(configPath)
    ? (JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>)
    : {};
  const plugins = isRecord(existing.plugins) ? existing.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...existing,
        plugins: { ...plugins, enabledPlugins: { ...enabledPlugins, [BUILTIN_ID]: true } },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
