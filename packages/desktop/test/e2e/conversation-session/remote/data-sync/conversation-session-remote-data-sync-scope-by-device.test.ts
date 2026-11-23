import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  bringRemoteDeviceOnline,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  remoteContainerPathExists,
  takeRemoteDeviceOffline,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openScopeProjectSubmenu } from "#e2e/helpers/settings-scope-menu";

// DSYNC-15：设置页 Scope 菜单按设备分组（docs/remote/data-sync.md「Scope 菜单按设备分组」）。
// 远端「用户」经该设备的 source-settings attachment 读写，不要求打开项目；远端断言用 docker exec。
const CASE_MARKER = "E2E_DSYNC_15_SCOPE_BY_DEVICE";
const REMOTE_AGENT = "e2e-dsync15-remote-agent";
// 带显式模型与推理档位的远端子智能体（例如从本机同步过来的）；远端「用户」没有模型目录。
const REMOTE_MODEL_AGENT = "e2e-dsync15-remote-model-agent";
const REMOTE_MODEL_AGENT_MODEL = "e2e-provider/e2e-model";
const REMOTE_MODEL_AGENT_THOUGHT_LEVEL = "high";
const LOCAL_AGENT = "e2e-dsync15-local-agent";
const REMOTE_COMMAND = "e2e-dsync15-remote-command";
const REMOTE_MCP = "e2e-dsync15-remote-mcp";
const LOCAL_MCP = "e2e-dsync15-local-mcp";
const LOCAL_HOOK_MARKER = "E2E_DSYNC_15_LOCAL_HOOK";
const REMOTE_HOOK_MARKER = "E2E_DSYNC_15_REMOTE_HOOK";
const HOOK_FORM = '[data-testid="hooks-form"]';
const REMOTE_HOME = "/home/dev";
const SCOPE_TRIGGER = '[data-plugin-scope-trigger="true"]';

async function openSettingsSection(section: string): Promise<void> {
  const onSettings = await browser.execute(
    (pageId) => Boolean(document.querySelector(`[data-testid="${pageId}"]`)),
    TID_SETTINGS_PAGE,
  );
  if (!onSettings) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有 ${section} 分区`,
  });
}

async function readVisibleTriggerKey(): Promise<string | null> {
  return await browser.execute((selector) => {
    const trigger = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.getClientRects().length > 0,
    );
    return trigger?.dataset.pluginScopeKey ?? null;
  }, SCOPE_TRIGGER);
}

async function waitForScopeKey(key: string, timeoutMsg: string): Promise<void> {
  let current: string | null = null;
  await browser
    .waitUntil(
      async () => {
        current = await readVisibleTriggerKey();
        return current === key;
      },
      { timeout: 60_000, interval: 300 },
    )
    .catch((error: unknown) => {
      throw new Error(`${CASE_MARKER}: ${timeoutMsg}；当前 scope=${current}`, { cause: error });
    });
}

/** Radix 菜单需要 pointerdown 打开；只操作当前可见的触发器（插件容器 forceMount 多个分区）。 */
async function openScopeMenu(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((selector) => {
        if (document.querySelector('[role="menuitemradio"]')) return true;
        const trigger = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          (element) => element.getClientRects().length > 0,
        );
        trigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
        );
        return false;
      }, SCOPE_TRIGGER),
    { timeout: 15_000, interval: 500, timeoutMsg: `${CASE_MARKER}: scope 菜单打不开` },
  );
}

/** 读取菜单：第一层的标题、选项和「项目」入口所属设备，以及打开 `projectsDevice` 子菜单后的项目。 */
async function readScopeMenu(projectsDevice: string) {
  await openScopeMenu();
  const menu = await browser.execute(() => ({
    headings: Array.from(
      document.querySelectorAll<HTMLElement>('[data-scope-device-heading="true"]'),
    ).map((heading) => heading.innerText.trim()),
    keys: Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).map(
      (item) => item.dataset.pluginScopeKey ?? "",
    ),
    projectsDevices: Array.from(
      document.querySelectorAll<HTMLElement>('[data-scope-projects-trigger="true"]'),
    ).map((trigger) => trigger.dataset.scopeDevice ?? ""),
    lines: (document.querySelector<HTMLElement>('[role="menu"]')?.innerText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  }));
  await openScopeProjectSubmenu(projectsDevice);
  const projectKeys = await browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-sub-content"] [role="menuitemradio"]',
      ),
    ).map((item) => item.dataset.pluginScopeKey ?? ""),
  );
  await browser.keys(["Escape"]);
  return { ...menu, projectKeys };
}

async function selectScopeKey(key: string): Promise<void> {
  await openScopeMenu();
  const clicked = await browser.execute((expected) => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find(
      (candidate) => candidate.dataset.pluginScopeKey === expected,
    );
    item?.click();
    return Boolean(item);
  }, key);
  if (!clicked) throw new Error(`${CASE_MARKER}: scope 菜单没有 ${key}`);
  await waitForScopeKey(key, `scope 没有切到 ${key}`);
}

async function clickVisibleNewButton(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            'button[aria-label="新建"], button[aria-label="New"]',
          ),
        ).find((element) => element.getClientRects().length > 0 && !element.disabled);
        button?.click();
        return Boolean(button);
      }),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 没有可用的「新建」按钮` },
  );
}

/** 按 placeholder 填写当前表单的输入框（React 受控组件需要原生 setter + input 事件）。 */
async function fillByPlaceholder(placeholder: string, value: string): Promise<void> {
  const filled = await browser.execute(
    (expected, nextValue) => {
      const field = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
      ).find((element) => element.placeholder === expected && element.getClientRects().length > 0);
      if (!field) return false;
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, nextValue);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    placeholder,
    value,
  );
  if (!filled) throw new Error(`${CASE_MARKER}: 表单没有输入框 ${placeholder}`);
}

/** 提交含指定输入框的表单（页面上还有搜索等其他 form，不能取第一个可见 form）。 */
async function submitFormOf(placeholder: string): Promise<void> {
  let state = "";
  await browser
    .waitUntil(
      async () => {
        state = await browser.execute((expected) => {
          const field = Array.from(
            document.querySelectorAll<HTMLInputElement>("input, textarea"),
          ).find((element) => element.placeholder === expected);
          const form = field?.closest("form");
          const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
          if (!form || !submit) return "no-form";
          if (submit.disabled) return "disabled";
          form.requestSubmit(submit);
          return "submitted";
        }, placeholder);
        return state === "submitted";
      },
      { timeout: 15_000, interval: 300 },
    )
    .catch((error: unknown) => {
      throw new Error(`${CASE_MARKER}: 表单不能保存（${state}）`, { cause: error });
    });
  await browser.waitUntil(
    () =>
      browser.execute(
        (expected) =>
          !Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
            (element) => element.placeholder === expected,
          ),
        placeholder,
      ),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 保存后表单没有关闭` },
  );
}

async function createSubagent(name: string): Promise<void> {
  await clickVisibleNewButton();
  await fillByPlaceholder("code-reviewer", name);
  await fillByPlaceholder("展示给模型的简短说明", `${CASE_MARKER} description`);
  await fillByPlaceholder("描述这个子智能体的角色、边界和规则...", `${CASE_MARKER} prompt`);
  await submitFormOf("code-reviewer");
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, name), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 子智能体行没有出现 ${name}`,
  });
}

/** 子智能体表单名称输入框的值；没有表单时返回 null。 */
async function readSubagentFormName(): Promise<string | null> {
  return await browser.execute(() => {
    const field = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
      (element) => element.placeholder === "code-reviewer" && element.getClientRects().length > 0,
    );
    return field ? field.value : null;
  });
}

async function localPathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

/** 打开 MCP 新建表单：有已安装项时是分组标题里的「+」，列表为空时是空状态按钮。 */
async function openNewMcpForm(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) =>
            element.getClientRects().length > 0 &&
            !element.disabled &&
            (element.dataset.settingsCreateAction === "settings.mcp.create.open" ||
              element.innerText.trim() === "新建 MCP 服务器"),
        );
        button?.click();
        return Boolean(button);
      }),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 没有可用的「新建 MCP 服务器」` },
  );
}

async function clickVisibleButtonText(text: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) =>
            element.getClientRects().length > 0 &&
            !element.disabled &&
            element.innerText.trim() === expected,
        );
        button?.click();
        return Boolean(button);
      }, text),
    { timeout: 15_000, interval: 300, timeoutMsg: `${CASE_MARKER}: 没有可用的「${text}」按钮` },
  );
}

/** 新建一个 stdio MCP；只断言配置落盘位置，不要求它能连接。 */
async function createMcpServer(name: string): Promise<void> {
  await openNewMcpForm();
  await fillByPlaceholder("my-mcp-server", name);
  await fillByPlaceholder("npx", "node");
  await fillByPlaceholder("-y @modelcontextprotocol/server-memory", `${name}.mjs`);
  await clickVisibleButtonText("保存");
  await waitForTestIdByDom(testId(TID_MCP_SERVER_ROW, name), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: MCP 行没有出现 ${name}`,
  });
}

async function toggleMcpServer(name: string): Promise<void> {
  const clicked = await browser.execute(
    (rowId) => {
      const toggle = document.querySelector<HTMLElement>(
        `[data-testid="${rowId}"] [role="switch"]`,
      );
      toggle?.click();
      return Boolean(toggle);
    },
    testId(TID_MCP_SERVER_ROW, name),
  );
  if (!clicked) throw new Error(`${CASE_MARKER}: MCP 行没有开关 ${name}`);
}

type McpServerEntries = Record<string, { enabled?: boolean } | undefined>;

function readMcpServerEntries(raw: string): McpServerEntries {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as { mcp?: { servers?: McpServerEntries } };
  return parsed.mcp?.servers ?? {};
}

async function readLocalMcpServers(): Promise<McpServerEntries> {
  const raw = await readFile(join(resolveE2EStorageRoot(), "cli", "config.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return readMcpServerEntries(raw);
}

async function readRemoteMcpServers(container: string): Promise<McpServerEntries> {
  const path = `${REMOTE_HOME}/.zcode/cli/config.json`;
  if (!(await remoteContainerPathExists(container, path))) return {};
  return readMcpServerEntries(await readRemoteContainerFile(container, path));
}

async function waitForMcpEntry(
  read: () => Promise<McpServerEntries>,
  name: string,
  matches: (entry: { enabled?: boolean }) => boolean,
  timeoutMsg: string,
): Promise<void> {
  let latest: McpServerEntries = {};
  await browser
    .waitUntil(
      async () => {
        latest = await read();
        const entry = latest[name];
        return Boolean(entry && matches(entry));
      },
      { timeout: 30_000, interval: 500 },
    )
    .catch((error: unknown) => {
      throw new Error(`${CASE_MARKER}: ${timeoutMsg}；当前 ${JSON.stringify(latest)}`, {
        cause: error,
      });
    });
}

/** 当前钩子表单 #args 的值；没有表单时返回 null。 */
async function readHookFormArgs(): Promise<string | null> {
  return await browser.execute((selector) => {
    const form = document.querySelector<HTMLElement>(selector);
    return form?.querySelector<HTMLTextAreaElement>("#args")?.value ?? (form ? "" : null);
  }, HOOK_FORM);
}

/** 按 id 填写钩子表单的输入框（React 受控组件需要原生 setter + input 事件）。 */
async function fillHookField(id: string, value: string): Promise<void> {
  const filled = await browser.execute(
    (selector, fieldId, nextValue) => {
      const field = document
        .querySelector<HTMLElement>(selector)
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${fieldId}`);
      if (!field) return false;
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, nextValue);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    HOOK_FORM,
    id,
    value,
  );
  if (!filled) throw new Error(`${CASE_MARKER}: 钩子表单没有输入框 #${id}`);
}

/** 新建一个只在不存在的 matcher 上触发的 process 钩子（本用例不信任、不执行它）。 */
async function createUserHook(marker: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-settings-create-action="settings.hooks.add"]',
          ),
        ).find((element) => element.getClientRects().length > 0 && !element.disabled);
        button?.click();
        return Boolean(button);
      }),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 没有可用的「新建钩子」` },
  );
  await $(HOOK_FORM).waitForDisplayed({ timeout: 15_000 });
  await fillHookField("matcher", `${marker}_MATCHER_NEVER`);
  await fillHookField("command", "/usr/bin/printf");
  await fillHookField("args", marker);
  await browser.waitUntil(
    () =>
      browser.execute((selector) => {
        const button = Array.from(
          document
            .querySelector<HTMLElement>(selector)
            ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((item) => /^(保存|Save)$/iu.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      }, HOOK_FORM),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 钩子表单没有可用的保存按钮` },
  );
  await browser.waitUntil(async () => !(await $(HOOK_FORM).isExisting()), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 保存后钩子表单没有关闭`,
  });
}

/** 当前列表中命令文本含 marker 的钩子行是否可见。 */
async function isHookRowVisible(marker: string): Promise<boolean> {
  return await browser.execute(
    (expected) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="configured-hook-row"]'),
      ).some((row) => row.getClientRects().length > 0 && row.innerText.includes(expected)),
    marker,
  );
}

async function clickHookRow(marker: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const row = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="configured-hook-row"]'),
        ).find((item) => item.getClientRects().length > 0 && item.innerText.includes(expected));
        row?.click();
        return Boolean(row);
      }, marker),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 列表里没有钩子 ${marker}` },
  );
}

/** 用户级钩子在 `<home>/.zcode/cli/config.json` 的 hooks 字段。 */
function readHooksConfig(raw: string): unknown {
  if (!raw.trim()) return null;
  return (JSON.parse(raw) as { hooks?: unknown }).hooks ?? null;
}

async function readLocalUserConfigRaw(): Promise<string> {
  return await readFile(join(resolveE2EStorageRoot(), "cli", "config.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
}

async function waitForRemotePath(container: string, path: string): Promise<void> {
  await browser.waitUntil(async () => await remoteContainerPathExists(container, path), {
    timeout: 30_000,
    interval: 500,
    timeoutMsg: `${CASE_MARKER}: 远端没有写入 ${path}`,
  });
}

describe(`${CASE_MARKER}: 设置页 Scope 菜单按设备分组`, () => {
  let sourceServerId = "";
  let container = "";
  let remoteWorkspacePath = "";
  let remoteWorkspaceIdentity = "";
  let offlineTarget: { host: string; port: number } | null = null;

  after(async () => {
    // DSYNC-15-04 / 15-05 中途失败时恢复容器，避免影响同一 runner 的后续 spec。
    if (offlineTarget)
      await bringRemoteDeviceOnline(container, offlineTarget).catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-15-01 远程 tab 默认「该设备 · 用户」，新建子智能体写入远端；切到「本机 · 用户」写入本机", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const remoteTab = await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    sourceServerId =
      parseRemoteWorkspaceIdentity(remoteTab.workspaceIdentity ?? "")?.sourceServerId ?? "";
    expect(sourceServerId).toBeTruthy();
    remoteWorkspacePath = workspacePath;
    remoteWorkspaceIdentity = remoteTab.workspaceIdentity ?? "";
    const remoteUserKey = `source-user:${sourceServerId}`;
    const remoteModelAgentPath = `${REMOTE_HOME}/.zcode/agents/${REMOTE_MODEL_AGENT}.md`;
    await writeRemoteContainerFile(
      container,
      remoteModelAgentPath,
      [
        "---",
        `name: "${REMOTE_MODEL_AGENT}"`,
        `description: "${CASE_MARKER} model agent"`,
        `model: "${REMOTE_MODEL_AGENT_MODEL}"`,
        `thoughtLevel: "${REMOTE_MODEL_AGENT_THOUGHT_LEVEL}"`,
        "---",
        `${CASE_MARKER} model agent prompt`,
        "",
      ].join("\n"),
    );

    await openSettingsSection("subagents");
    await waitForScopeKey(remoteUserKey, "远程 tab 下子智能体页没有默认选中该设备的「用户」");
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), { timeout: 60_000 });

    // 菜单：本机在前，远端设备一组；第一层只有各设备的「用户」和「项目」入口，项目在子菜单里
    // （19 号票），没有「工作区」小标题。
    const menu = await readScopeMenu(sourceServerId);
    expect(menu.headings).toHaveLength(2);
    expect(menu.headings[0]).toBe("本机");
    expect(menu.keys).toEqual(["user", remoteUserKey]);
    // 本机是否有项目取决于 E2E 存储，只断言远端设备有「项目」入口。
    expect(menu.projectsDevices).toContain(sourceServerId);
    expect(menu.projectKeys).toContain(remoteTab.workspaceIdentity!);
    expect(menu.lines).not.toContain("工作区");
    // 触发器设备名在前：「<设备> · 用户」。
    const triggerText = await browser.execute((selector) => {
      const trigger = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (element) => element.getClientRects().length > 0,
      );
      return trigger?.innerText.replace(/\s+/gu, "") ?? "";
    }, SCOPE_TRIGGER);
    expect(triggerText).toBe(`${menu.headings[1]!.replace(/\s+/gu, "")}·用户`);

    // 远端「用户」：新建写入远端 ~/.zcode/agents，本机不变。
    await createSubagent(REMOTE_AGENT);
    await waitForRemotePath(container, `${REMOTE_HOME}/.zcode/agents/${REMOTE_AGENT}.md`);
    expect(
      await localPathExists(join(resolveE2EStorageRoot(), "agents", `${REMOTE_AGENT}.md`)),
    ).toBe(false);
    // source-settings attachment 不暴露 model-selection：页面不读模型目录，也不显示加载失败。
    // 旧实现约 1s 后就会显示该提示；此时已完成新建与远端写入，足以观察到它。
    expect(await browser.execute(() => document.body.innerText.includes("模型列表加载失败"))).toBe(
      false,
    );

    // 已存显式模型的子智能体：没有模型目录，推理档位显示「推理档位暂不可用」，不能一直加载中；
    // 保存后 model / thoughtLevel 保持原值。
    await clickTestIdByDom(testId(TID_SUBAGENT_ROW, REMOTE_MODEL_AGENT), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 远端「用户」没有子智能体 ${REMOTE_MODEL_AGENT}`,
    });
    await browser.waitUntil(async () => (await readSubagentFormName()) === REMOTE_MODEL_AGENT, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 没有打开 ${REMOTE_MODEL_AGENT} 的编辑表单`,
    });
    let reasoning = { loading: false, unavailable: false };
    await browser
      .waitUntil(
        async () => {
          reasoning = await browser.execute(() => ({
            loading: Boolean(
              document.querySelector('[data-subagent-thought-level-loading="true"]'),
            ),
            unavailable: Boolean(
              document.querySelector('[data-subagent-thought-level-unavailable="true"]'),
            ),
          }));
          return reasoning.unavailable;
        },
        { timeout: 15_000, interval: 300 },
      )
      .catch((error: unknown) => {
        throw new Error(
          `${CASE_MARKER}: 推理档位没有显示「暂不可用」（${JSON.stringify(reasoning)}）`,
          { cause: error },
        );
      });
    expect(reasoning.loading).toBe(false);
    await submitFormOf("code-reviewer");
    const savedModelAgent = await readRemoteContainerFile(container, remoteModelAgentPath);
    // 保存按 YAML plain scalar 写回（不带引号）。
    expect(savedModelAgent).toContain(`\nmodel: ${REMOTE_MODEL_AGENT_MODEL}\n`);
    expect(savedModelAgent).toContain(`\nthoughtLevel: ${REMOTE_MODEL_AGENT_THOUGHT_LEVEL}\n`);

    // 「本机 · 用户」：新建写入本机，远端不变。
    await selectScopeKey("user");
    await createSubagent(LOCAL_AGENT);
    await browser.waitUntil(
      async () =>
        await localPathExists(join(resolveE2EStorageRoot(), "agents", `${LOCAL_AGENT}.md`)),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 本机没有写入 ${LOCAL_AGENT}` },
    );
    expect(
      await remoteContainerPathExists(container, `${REMOTE_HOME}/.zcode/agents/${LOCAL_AGENT}.md`),
    ).toBe(false);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  });

  it("DSYNC-15-02 本地 tab 默认「本机 · 用户」；选择远端设备「用户」新建命令写入远端", async function () {
    this.timeout(10 * 60_000);
    expect(sourceServerId).toBeTruthy();
    const remoteUserKey = `source-user:${sourceServerId}`;
    const { homeDir } = getE2EAppDataPaths();

    // 切到本机项目的 tab：远端设备仍在线，但不是当前 workspace 所在设备。
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting()) {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    }
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await openSettingsSection("commands");
    await waitForScopeKey("user", "本地 tab 下命令页没有默认选中「本机 · 用户」");

    // 不打开远程项目，直接选择远端设备的「用户」编辑命令。
    await selectScopeKey(remoteUserKey);
    await clickVisibleNewButton();
    await fillByPlaceholder("my-command", REMOTE_COMMAND);
    await fillByPlaceholder("在命令选择器中显示的简短描述", `${CASE_MARKER} description`);
    await fillByPlaceholder("填写调用该命令时发送的提示词...", `${CASE_MARKER} prompt`);
    await submitFormOf("my-command");

    const remotePath = `${REMOTE_HOME}/.zcode/commands/${REMOTE_COMMAND}.md`;
    await waitForRemotePath(container, remotePath);
    expect(await readRemoteContainerFile(container, remotePath)).toContain(`${CASE_MARKER} prompt`);
    expect(await localPathExists(join(homeDir, ".zcode", "commands", `${REMOTE_COMMAND}.md`))).toBe(
      false,
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  });
  it("DSYNC-15-03 MCP 只按 Scope 目标读写：本机 tab 选远端「用户」新增、开关写容器；远程 tab 选「本机 · 用户」新增写本机", async function () {
    this.timeout(15 * 60_000);
    expect(sourceServerId).toBeTruthy();
    expect(remoteWorkspaceIdentity).toBeTruthy();
    const remoteUserKey = `source-user:${sourceServerId}`;

    // 本机 tab（DSYNC-15-02 已切到本机项目）：选远端设备「用户」，新增与开关都写进容器，本机不变。
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting()) {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    }
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await openSettingsSection("mcp");
    await waitForScopeKey("user", "本地 tab 下 MCP 页没有默认选中「本机 · 用户」");
    await selectScopeKey(remoteUserKey);
    await createMcpServer(REMOTE_MCP);
    await waitForMcpEntry(
      () => readRemoteMcpServers(container),
      REMOTE_MCP,
      (entry) => entry.enabled !== false,
      "远端「用户」新增的 MCP 没有写进容器",
    );
    await toggleMcpServer(REMOTE_MCP);
    await waitForMcpEntry(
      () => readRemoteMcpServers(container),
      REMOTE_MCP,
      (entry) => entry.enabled === false,
      "远端「用户」关闭 MCP 没有写进容器",
    );
    expect((await readLocalMcpServers())[REMOTE_MCP]).toBeUndefined();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });

    // 远程 tab：默认「该设备 · 用户」，显式选「本机 · 用户」后新增只写本机，容器不变。
    await startDraftFromProject(remoteWorkspacePath, {
      workspaceIdentity: remoteWorkspaceIdentity,
    });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: remoteWorkspaceIdentity,
      expectedPath: remoteWorkspacePath,
    });
    await openSettingsSection("mcp");
    await waitForScopeKey(remoteUserKey, "远程 tab 下 MCP 页没有默认选中该设备的「用户」");
    await selectScopeKey("user");
    await createMcpServer(LOCAL_MCP);
    await waitForMcpEntry(
      readLocalMcpServers,
      LOCAL_MCP,
      () => true,
      "「本机 · 用户」新增的 MCP 没有写进本机",
    );
    expect((await readRemoteMcpServers(container))[LOCAL_MCP]).toBeUndefined();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  });

  it("DSYNC-15-04 远端「用户」编辑子智能体时设备离线，切到「本机 · 用户」不显示旧表单、本机不写入", async function () {
    this.timeout(15 * 60_000);
    expect(sourceServerId).toBeTruthy();
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const remoteUserKey = `source-user:${sourceServerId}`;
    const localAgentFile = join(resolveE2EStorageRoot(), "agents", `${REMOTE_AGENT}.md`);

    // 远端「用户」打开 15-01 新建的子智能体的编辑表单。
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting()) {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    }
    await openSettingsSection("subagents");
    await selectScopeKey(remoteUserKey);
    await clickTestIdByDom(testId(TID_SUBAGENT_ROW, REMOTE_AGENT), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 远端「用户」没有子智能体 ${REMOTE_AGENT}`,
    });
    await browser.waitUntil(async () => (await readSubagentFormName()) === REMOTE_AGENT, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 没有打开 ${REMOTE_AGENT} 的编辑表单`,
    });

    // 设备离线：表单隐藏，只显示离线提示（管理快照判定离线可能要几分钟）。
    offlineTarget = { host: config.host, port: config.port };
    await takeRemoteDeviceOffline(container);
    await browser.waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector('[data-scope-blocked="offline"]'))),
      {
        timeout: 5 * 60_000,
        interval: 1_000,
        timeoutMsg: `${CASE_MARKER}: 设备离线后没有离线提示`,
      },
    );
    expect(await readSubagentFormName()).toBeNull();

    // 列表页切到「本机 · 用户」：显示本机列表，旧表单不出现，本机不写入远端子智能体。
    await selectScopeKey("user");
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, LOCAL_AGENT), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 切到「本机 · 用户」后没有显示本机列表`,
    });
    expect(await readSubagentFormName()).toBeNull();
    expect(await localPathExists(localAgentFile)).toBe(false);

    await bringRemoteDeviceOnline(container, offlineTarget);
    offlineTarget = null;
    // 本例验证离线表单归属；恢复连接是下一例的前置。tab 的旧 identity/session 不代表在线。
    await openSettingsSection("remoteDevices");
    await browser.waitUntil(
      () =>
        browser.execute((sourceId) => {
          const card = document.querySelector(`[data-source-server-card="${sourceId}"]`);
          if (card?.querySelector('[data-remote-connection-status="online"]')) return true;
          const connect = [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
            (button) => !button.disabled && ["连接", "Connect"].includes(button.innerText.trim()),
          );
          connect?.click();
          return Boolean(connect);
        }, sourceServerId),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设备没有恢复在线，也没有可用连接入口` },
    );
    await $(
      `[data-source-server-card="${sourceServerId}"] [data-remote-connection-status="online"]`,
    ).waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: sshd 恢复后，设备管理快照仍未在线`,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: remoteWorkspaceIdentity,
      expectedPath: remoteWorkspacePath,
    });
  });

  it("DSYNC-15-05 远端「用户」编辑钩子时设备离线，切到「本机 · 用户」不显示旧表单、本机钩子不变", async function () {
    this.timeout(15 * 60_000);
    expect(sourceServerId).toBeTruthy();
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const remoteUserKey = `source-user:${sourceServerId}`;
    const remoteConfigPath = `${REMOTE_HOME}/.zcode/cli/config.json`;

    // 两台设备各有一个用户钩子：两边的 hook ID 都从 hook-zcode-user-0 编号，旧表单带到本机保存会覆盖本机这条。
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting()) {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    }
    await openSettingsSection("hooks");
    await selectScopeKey("user");
    await createUserHook(LOCAL_HOOK_MARKER);
    await browser.waitUntil(
      async () => (await readLocalUserConfigRaw()).includes(LOCAL_HOOK_MARKER),
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 本机没有写入钩子 ${LOCAL_HOOK_MARKER}`,
      },
    );
    await selectScopeKey(remoteUserKey);
    await createUserHook(REMOTE_HOOK_MARKER);
    await browser.waitUntil(
      async () =>
        (await remoteContainerPathExists(container, remoteConfigPath)) &&
        (await readRemoteContainerFile(container, remoteConfigPath)).includes(REMOTE_HOOK_MARKER),
      { timeout: 30_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 远端没有写入钩子` },
    );
    const localHooksBefore = readHooksConfig(await readLocalUserConfigRaw());
    expect(JSON.stringify(localHooksBefore)).not.toContain(REMOTE_HOOK_MARKER);

    // 远端「用户」打开该钩子的编辑表单。
    await clickHookRow(REMOTE_HOOK_MARKER);
    await browser.waitUntil(async () => (await readHookFormArgs()) === REMOTE_HOOK_MARKER, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 没有打开远端钩子的编辑表单`,
    });

    // 设备离线：表单隐藏，只显示离线提示（管理快照判定离线可能要几分钟）。
    offlineTarget = { host: config.host, port: config.port };
    await takeRemoteDeviceOffline(container);
    await browser.waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector('[data-scope-blocked="offline"]'))),
      {
        timeout: 5 * 60_000,
        interval: 1_000,
        timeoutMsg: `${CASE_MARKER}: 设备离线后没有离线提示`,
      },
    );
    expect(await readHookFormArgs()).toBeNull();

    // 列表页切到「本机 · 用户」：显示本机列表，旧表单不出现，本机钩子不变。
    await selectScopeKey("user");
    await browser.waitUntil(
      async () =>
        (await readHookFormArgs()) !== null || (await isHookRowVisible(LOCAL_HOOK_MARKER)),
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: `${CASE_MARKER}: 切到「本机 · 用户」后既没有本机列表也没有表单`,
      },
    );
    expect(await readHookFormArgs()).toBeNull();
    expect(await isHookRowVisible(LOCAL_HOOK_MARKER)).toBe(true);
    await browser.pause(1_000);
    expect(await readHookFormArgs()).toBeNull();
    expect(readHooksConfig(await readLocalUserConfigRaw())).toEqual(localHooksBefore);

    await bringRemoteDeviceOnline(container, offlineTarget);
    offlineTarget = null;
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  });
});
