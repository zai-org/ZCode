import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  TID_WORKSPACE_HEADER,
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  createPluginLifecycleFixture,
  getPluginOverview,
  getPluginList,
  installMarketplacePluginThroughAgent,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  pluginStoragePath,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestToolNames,
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readSingleSSHWorkspaceRuntimeConfig,
  runSSHCommand,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  prepareV4ConversationE2E,
  approveV4Permission,
  hasV4PermissionDialog,
  getV4ConfigProjection,
  switchV4Mode,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_WPL_011_REMOTE_EXPLICIT_SYNC";
const RUNTIME_MARKER = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
const RUNTIME_PROMPT = `${CASE_MARKER}_RUNTIME_PROMPT`;
const RUNTIME_REPLY = "WPL_011_REMOTE_EXPLICIT_SYNC_REPLY";

async function selectFullAccessMode(): Promise<void> {
  // V4 菜单不使用旧 select-item/option；实际选择后等待当前 workspace 的配置投影。
  await switchV4Mode("yolo");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 完全访问模式没有写入当前草稿配置`,
  });
}

describe("WPL-011 remote Workspace Plugin explicit sync E2E", () => {
  let provider: SSHLifecycleProvider | null = null;
  let target: SSHConnectionConfig | null = null;
  let workspacePath = "";

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    if (target && workspacePath) {
      await cleanupRemoteWorkspace(target, workspacePath).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("does not copy a local package on connect, then materializes it only through Sync Plugin", async function () {
    this.timeout(45 * 60_000);

    const remote = readSingleSSHWorkspaceRuntimeConfig(CASE_MARKER);
    target = remote;
    workspacePath = remote.workspacePath;
    await seedRemoteWorkspace(target, workspacePath);

    await prepareV4ConversationE2E({ skipProvider: true });
    await selectFullAccessMode();

    const fixture = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    const localOverview = await getPluginOverview();
    expect(localOverview.installedPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: PLUGIN_LIFECYCLE_ID,
          scope: "user",
          version: "1.0.0",
        }),
      ]),
    );

    const localConfigPath = join(getE2EAppDataPaths().storageRoot, "cli", "config.json");
    const localInstalledPath = pluginStoragePath("installed_plugins.json");
    const localConfigBefore = await readFile(localConfigPath, "utf8");
    const localInstalledBefore = await readFile(localInstalledPath, "utf8");
    const workspaceConfigBefore = await readRemoteFile(
      target,
      posix.join(workspacePath, ".zcode", "config.json"),
    );

    provider = await createSSHLifecycleProvider(target, CASE_MARKER);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: target,
      label: "A",
      provider,
      workspacePath,
    });

    expect(
      await getUpstreamRequestToolNames({
        lastUserMessageIncludes: [task.firstPrompt],
      }),
    ).not.toContain(PLUGIN_LIFECYCLE_MCP_TOOL_NAME);
    expect(await readRemotePluginStorageState(target)).toEqual({
      cacheContainsPlugin: false,
      installedContainsPlugin: false,
      marketplaceContainsPlugin: false,
    });
    const missingRemotePlugin = (await getPluginList(workspacePath, task.identity)).plugins.find(
      (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
    );
    expect(missingRemotePlugin).toMatchObject({
      enabled: true,
      enabledSource: "workspace",
      id: PLUGIN_LIFECYCLE_ID,
      packageStatus: "missing",
      source: "missing",
    });
    expect(await readRemoteFile(target, posix.join(workspacePath, ".zcode", "config.json"))).toBe(
      workspaceConfigBefore,
    );

    // 票 14：Header「同步插件」打开数据同步弹窗，定位到当前 workspace 所在设备的插件分类。
    await openRemotePluginSyncDialog(workspacePath);
    await waitForDataSyncDialogOnPlugins();
    await waitForRemotePluginCandidate(PLUGIN_LIFECYCLE_ID.toLowerCase());
    await startRemotePluginSync();
    await waitForRemotePluginSyncComplete(PLUGIN_LIFECYCLE_ID.toLowerCase());

    await browser.waitUntil(
      async () => {
        const state = await readRemotePluginStorageState(target!);
        return (
          state.cacheContainsPlugin &&
          state.installedContainsPlugin &&
          state.marketplaceContainsPlugin
        );
      },
      {
        timeout: 180_000,
        timeoutMsg: `${CASE_MARKER}: 显式同步完成后 remote package/cache 没有物化`,
      },
    );
    expect(await readRemoteFile(target, posix.join(workspacePath, ".zcode", "config.json"))).toBe(
      workspaceConfigBefore,
    );
    expect(await readFile(localConfigPath, "utf8")).toBe(localConfigBefore);
    expect(await readFile(localInstalledPath, "utf8")).toBe(localInstalledBefore);

    await browser.waitUntil(
      async () =>
        (await getPluginList(workspacePath, task.identity)).plugins.some(
          (plugin) =>
            plugin.id === PLUGIN_LIFECYCLE_ID &&
            plugin.enabled &&
            plugin.enabledSource === "workspace",
        ),
      {
        timeout: 120_000,
        timeoutMsg: `${CASE_MARKER}: remote Plugin list 没有刷新为 Workspace enabled`,
      },
    );

    // 显式同步后的验证必须在同一远程项目创建新会话；全局新建会错误执行本机已安装的插件。
    // 同步完成保留结果弹窗；未关闭它时真实侧栏点击被遮罩拦截。
    const syncDialog = $('[data-testid="remote-sync-dialog"]');
    // 分类页没有底部「关闭」按钮，用弹窗右上角的关闭按钮。
    await syncDialog.$('[data-slot="dialog-close"]').click();
    await syncDialog.waitForExist({ reverse: true });
    await startDraftFromProject(workspacePath, { workspaceIdentity: task.identity });
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
      includePlainModelFallback: false,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    const requestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${RUNTIME_PROMPT}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} exactly once, then reply with exactly ${RUNTIME_REPLY}.`,
      RUNTIME_PROMPT,
      `${CASE_MARKER}: 显式同步后的 remote 新 Session prompt 没有被接受`,
    );
    await waitForUpstreamRequest(
      {
        includes: [RUNTIME_MARKER],
        lastUserMessageIncludes: [RUNTIME_PROMPT],
      },
      `${CASE_MARKER}: 显式同步后的 remote 新 Session 没有暴露 Plugin MCP`,
      120_000,
      { afterIndex: requestStart - 1 },
    );
    expect(
      await getUpstreamRequestToolNames({
        lastUserMessageIncludes: [RUNTIME_PROMPT],
      }),
    ).toContain(PLUGIN_LIFECYCLE_MCP_TOOL_NAME);
    await waitForToolCallBlockByToolName(PLUGIN_LIFECYCLE_MCP_TOOL_NAME, 120_000);
    // tool-call 已出现不代表工具已执行；远端默认模式可能随后才显示权限请求。
    // 持续观察到真实 tool_result，期间只响应一次当前请求，不把工具块当作完成屏障。
    let permissionApproved = false;
    await browser.waitUntil(
      async () => {
        if (!permissionApproved && (await hasV4PermissionDialog())) {
          expect(await approveV4Permission()).toBe(true);
          permissionApproved = true;
        }
        return (await getLatestUpstreamToolResultByToolCallId("call_wpl_011_plugin")) !== null;
      },
      { timeout: 120_000, timeoutMsg: `${CASE_MARKER}: Plugin MCP 没有返回真实 tool_result` },
    );
    await waitForV4AssistantMessageContaining(RUNTIME_REPLY, 120_000);
    const toolResult = await getLatestUpstreamToolResultByToolCallId("call_wpl_011_plugin");
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.content.trim()).toBe(RUNTIME_MARKER);
  });
});

// 本 case 会 rm -rf 远端 workspace，所以只允许重置一个约定路径，不接受任意路径。默认值
// /root/workspace 是历史上唯一跑过的 root 目标；Linux e2e 服务器用 dev 用户，通过
// ZCODE_E2E_WPL011_WORKSPACE 指定该机的专用目录（不能指向共享 workspace 根）。
const ALLOWED_REMOTE_WORKSPACE =
  process.env.ZCODE_E2E_WPL011_WORKSPACE?.trim() || "/root/workspace";

async function seedRemoteWorkspace(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<void> {
  if (workspacePath !== ALLOWED_REMOTE_WORKSPACE) {
    throw new Error(`${CASE_MARKER}: refusing to reset unexpected remote path ${workspacePath}`);
  }
  const config = {
    plugins: {
      enabledPlugins: {
        [PLUGIN_LIFECYCLE_ID]: true,
      },
    },
  };
  const command = [
    "set -eu",
    // 远端用户不一定是 root（服务器上是 dev），配置目录一律走 $HOME 展开。
    `rm -rf -- "$HOME/.zcode" ${quoteShell(workspacePath)}`,
    `mkdir -p -- ${quoteShell(posix.join(workspacePath, ".zcode"))}`,
    writeBase64Command(
      posix.join(workspacePath, ".zcode", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    ),
  ].join(" && ");
  const result = await runSSHCommand(target, command);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
}

async function cleanupRemoteWorkspace(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<void> {
  if (workspacePath !== ALLOWED_REMOTE_WORKSPACE) {
    throw new Error(`${CASE_MARKER}: refusing to clean unexpected remote path ${workspacePath}`);
  }
  await runSSHCommand(target, `rm -rf -- ${quoteShell(workspacePath)}`);
}

async function readRemotePluginStorageState(target: SSHConnectionConfig): Promise<{
  cacheContainsPlugin: boolean;
  installedContainsPlugin: boolean;
  marketplaceContainsPlugin: boolean;
}> {
  const command = [
    "installed=false",
    `if test -f "$HOME/.zcode/cli/plugins/installed_plugins.json" && grep -Fq -- ${quoteShell(PLUGIN_LIFECYCLE_ID)} "$HOME/.zcode/cli/plugins/installed_plugins.json"; then installed=true; fi`,
    "cached=false",
    `if test -d "$HOME/.zcode/cli/plugins/cache" && find "$HOME/.zcode/cli/plugins/cache" -path ${quoteShell(`*${PLUGIN_LIFECYCLE_NAME}*`)} -print -quit | grep -q .; then cached=true; fi`,
    "marketplace=false",
    `if test -f "$HOME/.zcode/cli/plugins/known_marketplaces.json" && grep -Fq -- ${quoteShell(PLUGIN_LIFECYCLE_MARKETPLACE_ID)} "$HOME/.zcode/cli/plugins/known_marketplaces.json"; then marketplace=true; fi`,
    "printf '%s\\n' \"$installed $cached $marketplace\"",
  ].join("; ");
  const result = await runSSHCommand(target, command);
  expect(result.code).toBe(0);
  const [installed, cached, marketplace] = result.stdout.trim().split(/\s+/u);
  return {
    cacheContainsPlugin: cached === "true",
    installedContainsPlugin: installed === "true",
    marketplaceContainsPlugin: marketplace === "true",
  };
}

async function readRemoteFile(target: SSHConnectionConfig, path: string): Promise<string> {
  const result = await runSSHCommand(target, `cat -- ${quoteShell(path)}`);
  expect(result.code).toBe(0);
  return result.stdout;
}

async function openRemotePluginSyncDialog(workspacePath: string): Promise<void> {
  // 这一步串联「找到目标 workspace 的 header」→「打开更多菜单」→「点同步 Plugin」，
  // 三个环节任一不成立以前都只报一句超时。两条经验教训写进实现：
  // 1. timeoutMsg 是模板字符串，在 waitUntil 调用时就求值，之前打印的 visible=[] 是
  //    探测前的初始值，不是现场事实——诊断必须在超时之后收集。
  // 2. 菜单只在第一轮点一次的话，一旦那次点击没生效（Radix trigger 是 toggle 语义）
  //    后面 30 秒都在等一个不会出现的菜单。每轮按需重点，让它能自愈。
  type MenuProbe = {
    stage:
      | "header-missing"
      | "more-missing"
      | "more-disabled"
      | "menu-closed"
      | "item-missing"
      | "clicked";
    headers: Array<{ visible: boolean; pathAbs: string | null; hasMoreButton: boolean }>;
    moreState: string | null;
    menuCount: number;
    visibleItems: string[];
  };
  let probe: MenuProbe = {
    stage: "header-missing",
    headers: [],
    moreState: null,
    menuCount: 0,
    visibleItems: [],
  };
  await browser
    .waitUntil(
      async () => {
        probe = await browser.execute(
          (headerTestId, moreTestId, pathTestId, expectedPath) => {
            const headers = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid="${headerTestId}"]`),
            );
            const facts = headers.map((candidate) => {
              const path = candidate.querySelector<HTMLElement>(`[data-testid="${pathTestId}"]`);
              return {
                visible: candidate.getClientRects().length > 0,
                pathAbs: path?.dataset.workspaceAbsPath ?? null,
                hasMoreButton: Boolean(
                  candidate.querySelector<HTMLButtonElement>(`[data-testid="${moreTestId}"]`),
                ),
              };
            });
            const menus = Array.from(
              document.querySelectorAll<HTMLElement>('[role="menu"]'),
            ).filter((menu) => menu.getClientRects().length > 0);
            const visibleItems = Array.from(
              document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
            )
              .filter((candidate) => candidate.getClientRects().length > 0)
              .map((candidate) => candidate.innerText.trim());
            const header = headers.find((candidate) => {
              if (candidate.getClientRects().length === 0) return false;
              const path = candidate.querySelector<HTMLElement>(`[data-testid="${pathTestId}"]`);
              // 修复原因：header 上下文改到 tooltip 承载后按钮没有 DOM title，
              // 只有 data-workspace-abs-path 还稳定携带工作区绝对路径。
              return path?.dataset.workspaceAbsPath?.startsWith(expectedPath) ?? false;
            });
            const base = { headers: facts, menuCount: menus.length, visibleItems };
            if (!header) return { ...base, stage: "header-missing" as const, moreState: null };
            const button = header.querySelector<HTMLButtonElement>(`[data-testid="${moreTestId}"]`);
            if (!button) return { ...base, stage: "more-missing" as const, moreState: null };
            const moreState = button.dataset.state ?? button.getAttribute("aria-expanded") ?? null;
            if (button.disabled) return { ...base, stage: "more-disabled" as const, moreState };
            if (menus.length === 0) {
              // Radix DropdownMenuTrigger 靠 pointerdown 打开；click 单独派发不够。
              button.dispatchEvent(
                new PointerEvent("pointerdown", {
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  pointerId: 1,
                  pointerType: "mouse",
                }),
              );
              button.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
              );
              button.click();
              return { ...base, stage: "menu-closed" as const, moreState };
            }
            const item = Array.from(
              document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
            ).find(
              (candidate) =>
                candidate.getClientRects().length > 0 &&
                candidate.dataset.testid === "data-sync-entry-plugins" &&
                candidate.getAttribute("aria-disabled") !== "true",
            );
            if (!item) return { ...base, stage: "item-missing" as const, moreState };
            item.click();
            return { ...base, stage: "clicked" as const, moreState };
          },
          TID_WORKSPACE_HEADER,
          TID_WORKSPACE_MORE_BUTTON,
          TID_WORKSPACE_PATH,
          workspacePath,
        );
        return probe.stage === "clicked";
      },
      { timeout: 60_000, interval: 500 },
    )
    .catch((error: unknown) => {
      throw new Error(
        `${CASE_MARKER}: 没能从 remote task header 打开“同步 Plugin”（expected=${workspacePath}）；现场: ${JSON.stringify(probe)}`,
        { cause: error },
      );
    });
}

async function waitForDataSyncDialogOnPlugins(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector('[data-testid="remote-sync-dialog"]');
        const tab = document.querySelector('[data-testid="remote-sync-tab-plugins"]');
        const device = document.querySelector('[data-testid="remote-sync-dialog-device"]');
        return Boolean(
          dialog && device?.textContent?.trim() && tab?.getAttribute("aria-current") === "page",
        );
      }),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: Header「同步插件」没有打开数据同步弹窗的插件分类`,
    },
  );
}

async function readRemotePluginRow(rowKey: string) {
  return await browser.execute((rowTestId) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`);
    return row
      ? { status: row.dataset.syncStatus ?? null, checked: row.getAttribute("aria-checked") }
      : null;
  }, `remote-sync-row-${rowKey}`);
}

async function waitForRemotePluginCandidate(rowKey: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const row = await readRemotePluginRow(rowKey);
      return row?.status === "push" && row.checked === "true";
    },
    {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 数据同步弹窗没有把 ${rowKey} 显示为默认勾选的「推送」`,
    },
  );
}

async function startRemotePluginSync(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="remote-sync-push"]',
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 插件分类的推送按钮不可点击`,
    },
  );
}

async function waitForRemotePluginSyncComplete(rowKey: string): Promise<void> {
  await browser.waitUntil(async () => (await readRemotePluginRow(rowKey))?.status === "synced", {
    timeout: 240_000,
    timeoutMsg: `${CASE_MARKER}: 推送后 ${rowKey} 没有变为「已同步」`,
  });
  const failed = await browser.execute(() =>
    Boolean(document.querySelector('[data-testid^="remote-sync-row-error-"]')),
  );
  expect(failed).toBe(false);
}

function writeBase64Command(path: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return `printf '%s' ${quoteShell(encoded)} | base64 -d > ${quoteShell(path)}`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
