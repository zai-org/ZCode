import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { access } from "node:fs/promises";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  clickOpenScopeMenuOption,
  readOpenScopeMenuOptions,
} from "#e2e/helpers/settings-scope-menu";
import {
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readHostProcesses,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  completeSSHProjectConnection,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E, startNewV4Draft } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_SETTINGS_SCOPES";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-settings-scopes",
);
const AGENT_NAME = "r3-remote-conversation-agent";
const AGENT_NAME_PROJECT = "r3-remote-project-agent";
const SUBAGENT_FORM_SELECTOR = `form:has(input[type="text"]):has([data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"])`;
const SECTIONS = ["skill", "mcp", "plugin", "hooks", "subagents", "memory", "general"] as const;

async function openSettingsSection(section: string): Promise<void> {
  const onSettings = await browser.execute(
    (pageId) => Boolean(document.querySelector(`[data-testid="${pageId}"]`)),
    TID_SETTINGS_PAGE,
  );
  if (!onSettings) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 没有设置入口`,
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有渲染`,
    });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有 ${section} 分区`,
  });
  const scopedSection = ["skill", "mcp", "plugin", "hooks", "subagents", "memory"].includes(
    section,
  );
  await browser.waitUntil(
    async () => (await $('[data-plugin-scope-trigger="true"]').isExisting()) === scopedSection,
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: ${section} 分区的 scope 入口未就绪` },
  );
}

/** 读取当前分区的 scope 选择器可选项（Source/项目/User 等），没有 scope 选择器时返回 null。 */
async function readScopeOptions(): Promise<{ current: string; options: string[] } | null> {
  const trigger = $('[data-plugin-scope-trigger="true"]');
  if (!(await trigger.isExisting())) return null;
  const current = (await trigger.getText()).trim();
  await trigger.click();
  await browser.waitUntil(
    () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length > 0),
    { timeout: 10_000, timeoutMsg: "scope-menu" },
  );
  // 项目在各设备的「项目」子菜单里，逐个打开后合并。
  const options = (await readOpenScopeMenuOptions()).map((option) => option.text);
  await browser.keys(["Escape"]);
  return { current, options };
}

/** 打开 scope 菜单（等待上一次菜单完全关闭，最多重试 3 次）。 */
async function openScopeMenu(): Promise<void> {
  const trigger = $('[data-plugin-scope-trigger="true"]');
  await trigger.waitForClickable({ timeout: 15_000 });
  await browser
    .waitUntil(
      () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length === 0),
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 旧 scope 菜单没有关闭` },
    )
    .catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await trigger.click();
    const opened = await browser
      .waitUntil(
        () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length > 0),
        { timeout: 5_000, timeoutMsg: "scope-menu-open" },
      )
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    await browser.pause(500);
  }
  throw new Error(`${CASE_MARKER}: scope 菜单打不开`);
}

async function createSubagent(name: string, providerId: string, modelId: string): Promise<void> {
  const newButton = $('button[aria-label="新建"], button[aria-label="New"]');
  await newButton.waitForClickable({ timeout: 15_000 });
  await newButton.click();
  const form = $(SUBAGENT_FORM_SELECTOR);
  await form.waitForDisplayed({ timeout: 15_000 });
  const inputs = await form.$$('input[type="text"]');
  await inputs[0]!.setValue(name);
  await inputs[1]!.setValue(`${CASE_MARKER} description`);
  await form.$("textarea").setValue(`${CASE_MARKER} system prompt for ${name}`);
  // 模型：与 settings-subagent E2E 同一路径（provider 分组 → 模型项），值为 encodeCustomModelValue。
  const model = encodeCustomModelValue(providerId, modelId);
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, model);
  const groupTestId = testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${providerId}`);
  const trigger = form.$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
  await trigger.waitForClickable({ timeout: 15_000 });
  await trigger.click();
  await browser.waitUntil(
    () =>
      browser.execute(
        (item, group) =>
          Boolean(
            document.querySelector(`[data-testid="${item}"]`) ||
            document.querySelector(`[data-testid="${group}"]`),
          ),
        itemTestId,
        groupTestId,
      ),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: Subagent 表单模型菜单没有 ${providerId}` },
  );
  await browser.execute(
    (item, group) => {
      if (document.querySelector(`[data-testid="${item}"]`)) return;
      const node = document.querySelector<HTMLElement>(`[data-testid="${group}"]`);
      if (!node) return;
      node.focus();
      for (const eventName of ["pointerenter", "mouseenter", "mousemove"])
        node.dispatchEvent(
          new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }),
        );
      node.click();
    },
    itemTestId,
    groupTestId,
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (item) => Boolean(document.querySelector(`[data-testid="${item}"]`)),
        itemTestId,
      ),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 模型菜单没有出现 ${model}` },
  );
  await browser.execute(
    (item) => document.querySelector<HTMLElement>(`[data-testid="${item}"]`)?.click(),
    itemTestId,
  );
  await browser.waitUntil(
    async () => (await trigger.getAttribute("data-model-current-value")) === model,
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 模型控件没有切换到 ${model}` },
  );
  // 思考档位可选：产品 canSave 只校验"填了必须有效"（SubagentsSection
  // thoughtLevelInvalid），不要求非空。经 UI 流程种的自定义 openai 模型没有
  // reasoning 元数据（ProviderModelMetadataDialog 无该字段，与 store 直写版
  // seed 的 reasoningLevel:disabled 不同），档位控件可能不渲染或菜单无
  // disabled 项——均跳过，不影响提交；模型带档位时仍优先选 disabled。
  let levelSelected = false;
  const levelTrigger = form.$(`[data-testid="${TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}"]`);
  const levelTriggerClickable = await levelTrigger.waitForClickable({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  for (let attempt = 0; attempt < 3 && levelTriggerClickable && !levelSelected; attempt += 1) {
    await levelTrigger.click();
    try {
      const item = $(`[data-testid="${testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, "disabled")}"]`);
      await item.waitForClickable({ timeout: 3_000 });
      await item.click();
      levelSelected = true;
    } catch {
      await browser.keys(["Escape"]);
    }
  }
  // 等下拉菜单完全关闭再提交；提交后 8s 未关闭则再点一次（Radix 菜单退场期间的点击会被吞）。
  await browser
    .waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector('[role="menu"][data-state="open"], [role="listbox"]'),
        ),
      { timeout: 5_000, timeoutMsg: "menus-closed" },
    )
    .catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 先经 DOM requestSubmit 触发 onSubmit（不依赖按钮命中），再退回真实点击。
    const submitted = await browser.execute(
      (selector, attemptIndex) => {
        const formNode = document.querySelector<HTMLFormElement>(selector);
        if (!formNode) return "no-form";
        const button = formNode.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button?.disabled) return "disabled";
        if (attemptIndex === 0) {
          formNode.requestSubmit(button ?? undefined);
          return "requestSubmit";
        }
        button?.click();
        return "click";
      },
      SUBAGENT_FORM_SELECTOR,
      attempt,
    );
    void submitted;
    const closed = await browser
      .waitUntil(async () => !(await $(SUBAGENT_FORM_SELECTOR).isExisting()), {
        timeout: 20_000,
        timeoutMsg: "form-close",
      })
      .then(() => true)
      .catch(() => false);
    if (closed) break;
  }
  await browser
    .waitUntil(async () => !(await $(SUBAGENT_FORM_SELECTOR).isExisting()), {
      timeout: 5_000,
      timeoutMsg: `${CASE_MARKER}: Subagent 保存后表单没有关闭`,
    })
    .catch(async (error) => {
      const diagnostics = await browser.execute((selector) => {
        const formNode = document.querySelector<HTMLElement>(selector);
        const alerts = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="alert"], [role="status"], [data-sonner-toast]',
          ),
        )
          .map((n) => (n.innerText ?? "").trim())
          .filter(Boolean);
        return {
          formText: (formNode?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 600),
          alerts: alerts.slice(0, 5),
          submitDisabled:
            formNode?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled ?? null,
        };
      }, SUBAGENT_FORM_SELECTOR);
      throw new Error(`${String(error)}; diagnostics=${JSON.stringify(diagnostics)}`);
    });
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, name), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: Subagent 行没有出现: ${name}`,
  });
}

/** 同名 default 工作区必须按 identity 选择，不能用位置推断归属。 */
async function selectScopeKey(key: string): Promise<void> {
  await openScopeMenu();
  await clickOpenScopeMenuOption(key, { timeoutMsg: `${CASE_MARKER}: scope 菜单没有 ${key}` });
  await browser.waitUntil(
    async () =>
      (await $('[data-plugin-scope-trigger="true"]').getAttribute("data-plugin-scope-key")) === key,
    { timeout: 15_000, timeoutMsg: CASE_MARKER + ": scope identity 未切换" },
  );
}

async function localFileExists(path: string, waitMs = 0): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await access(path);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await browser.pause(500);
    }
  }
}

describe(`${CASE_MARKER}: 远端 Source 在线时设置 scope 与子智能体落盘位置`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "settings-scopes.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-06 远程项目 B 激活时默认选中该设备「用户」；「本机 · 用户」新建只落本机；项目 A/B scope 按 identity 分别落盘", async function () {
    this.timeout(30 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const [workspaceA, workspaceB] = config.workspacePaths;
    // 冷启动先等待并关闭引导页，再进入工作区；否则测试停在 onboarding，尚未触达设置。
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    provider = await createSSHLifecycleProvider(config, CASE_MARKER, { tunnelUsername: "tunnel" });
    await runSSHCommand(
      config,
      `rm -f "$HOME/.zcode/agents/${AGENT_NAME}.md" "${workspaceA}/.zcode/agents/${AGENT_NAME_PROJECT}.md"`,
    );

    // Source 在线，先激活远程项目 B；远程无项目入口已退役。
    await startNewV4Draft();
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // 全新容器首连必须经过“安装并继续”确认（inline 在 connecting 步）；缺这一步
    // 安装确认悬挂，conversation 永不打开（0910 实锤：auth 成功 → probe INSTALLED=0
    // → 无后续 channel 活动，keepalive 吊 2min 至超时）。与 entry-attribution 同款。
    const conversation = await completeSSHProjectConnection(
      { ...config, workspacePaths: [workspaceB, workspaceA] },
      CASE_MARKER,
    );
    const sourceId =
      parseRemoteWorkspaceIdentity(conversation.workspaceIdentity!)?.sourceServerId ?? "";
    expect(sourceId).toBeTruthy();

    // 各分区都必须实际打开；可选项不能仅记录或吞掉失败。
    const scopesProjectB: Record<string, unknown> = {};
    for (const section of SECTIONS) {
      await openSettingsSection(section);
      const scopes = await readScopeOptions();
      scopesProjectB[section] = scopes;
      if (section === "general") {
        expect(scopes).toBeNull();
      } else if (section === "memory") {
        // 记忆按设备保存，只提供两端的用户开关，不伪造项目级开关。
        expect(scopes?.options).toHaveLength(2);
        expect(scopes?.options.every((option) => option.includes("用户"))).toBe(true);
      } else {
        expect(scopes?.options).toEqual(
          expect.arrayContaining([
            expect.stringContaining("用户"),
            expect.stringContaining(basename(workspaceB)),
          ]),
        );
        expect(scopes?.options).not.toContain(basename(workspaceA));
      }
    }
    facts.scopeOptionsForProjectB = scopesProjectB;

    // DEV-06（2026-10 数据同步票 15 修订）：Scope 菜单按设备分组，远程 tab 默认选中该设备的「用户」；
    // 显式选「本机 · 用户」后新建只落本机。
    await openSettingsSection("subagents");
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), { timeout: 30_000 });
    const subagentScopes = await readScopeOptions();
    facts.subagentScopesForProjectB = subagentScopes;
    expect(
      await $('[data-plugin-scope-trigger="true"]').getAttribute("data-plugin-scope-key"),
    ).toBe(`source-user:${sourceId}`);
    // 对照组：本机“用户”scope 新建 → 落本机 storage/agents（证明表单与模型选择路径正常）。
    await selectScopeKey("user");
    const localControlName = "r3-local-user-agent";
    await createSubagent(localControlName, provider.id, SSH_LIFECYCLE_MODEL_ID);
    facts.localControlFileExists = await localFileExists(
      join(resolveE2EStorageRoot(), "agents", `${localControlName}.md`),
      15_000,
    );
    expect(facts.localControlFileExists).toBe(true);

    const remoteControlFile = await runSSHCommand(
      config,
      'find "$HOME" -name "r3-local-user-agent.md" -print',
    );
    facts.remoteControlFiles = remoteControlFile.stdout.trim();
    expect(remoteControlFile.stdout.trim()).toBe("");

    // 项目 B 的 scope 必须落在自己的 workspace，不能冒充 Source User。
    await selectScopeKey(conversation.workspaceIdentity!);
    await createSubagent(AGENT_NAME, provider.id, SSH_LIFECYCLE_MODEL_ID);
    const remoteConversationFile = await runSSHCommand(
      config,
      `test -f "${conversation.workspacePath}/.zcode/agents/${AGENT_NAME}.md" && echo FOUND; test ! -f "$HOME/.zcode/agents/${AGENT_NAME}.md" && echo USER_UNCHANGED`,
    );
    facts.remoteConversationFile = remoteConversationFile.stdout.trim();
    expect(remoteConversationFile.stdout).toContain("FOUND");
    expect(remoteConversationFile.stdout).toContain("USER_UNCHANGED");
    expect(await localFileExists(join(resolveE2EStorageRoot(), "agents", AGENT_NAME + ".md"))).toBe(
      false,
    );
    facts.sourceUserCoverage = "未覆盖：显式 Source User 与 conversation workspace 分别验收";
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页返回按钮没有出现`,
    });

    // 打开远端 project a → Subagents 选中项目 scope 新建 → 远端项目 .zcode/agents。
    await openSSHSourceDirectory(config, CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    await selectSSHRemoteDirectory(workspaceA, CASE_MARKER);
    const project = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspaceA,
      timeoutMs: 120_000,
    });
    await openSettingsSection("subagents");
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), { timeout: 30_000 });
    const subagentScopesWithProject = await readScopeOptions();
    facts.subagentScopesWithProject = subagentScopesWithProject;
    const projectScope =
      subagentScopesWithProject?.options.find((option) => option.includes(basename(workspaceA))) ??
      null;
    facts.projectScopeLabel = projectScope;
    expect(projectScope).toBeTruthy();
    await selectScopeKey(project.workspaceIdentity!);
    let projectScopeSaveError: string | null = null;
    await createSubagent(AGENT_NAME_PROJECT, provider.id, SSH_LIFECYCLE_MODEL_ID).catch(
      async (error) => {
        projectScopeSaveError = String(error).slice(0, 600);
        await browser.execute(() => {
          const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (b) => b.innerText.trim() === "取消" && b.getClientRects().length,
          );
          cancel?.click();
        });
        await browser.pause(500);
      },
    );
    facts.remoteProjectScopeSaveError = projectScopeSaveError;
    await browser.pause(3_000);
    const remoteProjectFile = await runSSHCommand(
      config,
      `test -f "${workspaceA}/.zcode/agents/${AGENT_NAME_PROJECT}.md" && echo FOUND || echo MISSING; find "$HOME/.zcode" "${workspaceA}" -name "${AGENT_NAME_PROJECT}.md" 2>/dev/null`,
    );
    facts.remoteProjectAgentFile = remoteProjectFile.stdout.trim().split("\n");
    facts.localProjectAgentFileExists = await localFileExists(
      join(DEFAULT_WORKSPACE, ".zcode", "agents", `${AGENT_NAME_PROJECT}.md`),
    );
    facts.localStorageProjectAgentFileExists = await localFileExists(
      join(resolveE2EStorageRoot(), "agents", `${AGENT_NAME_PROJECT}.md`),
    );
    expect(facts.localProjectAgentFileExists).toBe(false);

    // 其余分区在选中远端 project 时的 scope 选项。
    const scopesWithProject: Record<string, unknown> = {};
    for (const section of SECTIONS) {
      if (section === "subagents") continue;
      await openSettingsSection(section);
      const scopes = await readScopeOptions();
      scopesWithProject[section] = scopes;
      if (section === "general") {
        expect(scopes).toBeNull();
      } else if (section === "memory") {
        expect(scopes?.options).toHaveLength(2);
        expect(scopes?.options.every((option) => option.includes("用户"))).toBe(true);
      } else {
        expect(scopes?.options).toEqual(
          expect.arrayContaining([
            expect.stringContaining("用户"),
            expect.stringContaining(basename(workspaceA)),
            expect.stringContaining(basename(workspaceB)),
          ]),
        );
      }
    }
    facts.scopeOptionsWithProject = scopesWithProject;
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页返回按钮没有出现`,
    });
    expect(await readHostProcesses()).toEqual(initialHosts);
    expect(facts.localStorageProjectAgentFileExists).toBe(false);
    expect(projectScopeSaveError).toBeNull();
    expect(remoteProjectFile.stdout).toContain("FOUND");
  });
});
