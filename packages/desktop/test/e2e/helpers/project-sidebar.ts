import { basename as posixBasename } from "node:path/posix";
import { basename as win32Basename } from "node:path/win32";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  TID_VIRTUAL_PROJECT_FILES,
  TID_VIRTUAL_PROJECT_MENU,
  TID_VIRTUAL_PROJECT_ROW,
  TID_VIRTUAL_PROJECT_TOGGLE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  testId,
  virtualProjectActionTestId,
} from "@zcode/shared/test-ids";

/** 开始真实项目拖拽；调用方继续验证并通过 Escape / releaseActions 取消。 */
export async function startProjectPointerDrag(selector: string) {
  await browser.releaseActions();
  const position = await browser.execute((query) => {
    const rect = document.querySelector(query)!.getBoundingClientRect();
    return {
      x: Math.round(rect.left + 14),
      y: Math.round(rect.top + rect.height / 2),
      top: rect.top,
    };
  }, selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: position.x, y: position.y, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: position.x, y: position.y + 8, duration: 0 },
      ],
    },
  ]);
  // 跨阈值的事件只负责激活 sensor；等待该 owner 的状态，再发第二次位移，避免事件合并造成零位移。
  await browser.waitUntil(async () => (await $(selector).getAttribute("aria-pressed")) === "true", {
    timeout: 5000,
    timeoutMsg: "项目拖拽未激活",
  });
  await browser.performActions([
    {
      type: "pointer",
      id: "project-drag",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: position.x, y: position.y + 24, duration: 0 }],
    },
  ]);
  return position;
}

/**
 * 项目侧栏 E2E 定位 helper。
 *
 * 2026-09 虚拟项目重构后侧栏不再渲染真实目录节点（旧 TID_WORKSPACE_ITEM），
 * 老 workspace 首次迁移成「同名单 root 项目」：项目名 = 目录 basename
 * （与 packages/services/src/project-storage/migrate-projects.ts 同规则），
 * 项目 `<section>` 带 data-project-id / data-project-name。这里统一按项目名定位，
 * E2E 夹具的 workspace basename 彼此唯一（ZCodeProject、PassiveWorkspace-01…）。
 */
export function projectNameForWorkspace(workspacePath: string): string {
  return (
    (workspacePath.includes("\\") ? win32Basename(workspacePath) : posixBasename(workspacePath)) ||
    workspacePath
  );
}

export function projectSectionSelector(workspacePath: string): string {
  return `[data-project-id][data-project-name=${JSON.stringify(projectNameForWorkspace(workspacePath))}]`;
}

export function projectRowSelector(workspacePath: string): string {
  return `${projectSectionSelector(workspacePath)} [data-testid="${TID_VIRTUAL_PROJECT_ROW}"]`;
}

interface WaitOptions {
  timeout?: number;
  timeoutMsg?: string;
}

async function projectRowExists(workspacePath: string): Promise<boolean> {
  try {
    return await browser.execute(
      (selector) => Boolean(document.querySelector(selector)),
      projectRowSelector(workspacePath),
    );
  } catch {
    // renderer reload 期间 WebDriver 会短暂失去执行上下文，按未就绪处理。
    return false;
  }
}

export async function waitForProjectRow(
  workspacePath: string,
  { timeout = 30_000, timeoutMsg = `侧栏没有显示项目: ${workspacePath}` }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(() => projectRowExists(workspacePath), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

export async function waitForProjectRowGone(
  workspacePath: string,
  { timeout = 30_000, timeoutMsg = `项目移除后仍在侧栏: ${workspacePath}` }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(async () => !(await projectRowExists(workspacePath)), {
    timeout,
    interval: 100,
    timeoutMsg,
  });
}

/** 等待一组 workspace 对应的项目行全部出现在侧栏（启动恢复 / 首次迁移完成）。 */
export async function waitForRestoredProjects(
  workspacePaths: string[],
  timeout = 30_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const workspacePath of workspacePaths) {
        if (!(await projectRowExists(workspacePath))) return false;
      }
      return true;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${workspacePaths.length} 个恢复 workspace 没有全部出现在项目侧栏`,
    },
  );
}

async function readProjectExpanded(workspacePath: string): Promise<boolean> {
  return browser.execute(
    (selector, toggleTestId) =>
      document
        .querySelector(selector)
        ?.querySelector(`[data-testid="${toggleTestId}"]`)
        ?.getAttribute("aria-expanded") === "true",
    projectSectionSelector(workspacePath),
    TID_VIRTUAL_PROJECT_TOGGLE,
  );
}

/** 确保项目行已展开（任务列表可见）；对应旧 ensureWorkspaceItemExpanded。 */
export async function ensureProjectExpanded(
  workspacePath: string,
  timeout = 30_000,
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout });
  if (!(await readProjectExpanded(workspacePath))) {
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_TOGGLE, {
      timeout: 15_000,
      timeoutMsg: `侧栏项目不可展开: ${workspacePath}`,
    });
  }
  // Bug 根因：慢渲染环境下 DOM click 成功只代表事件已经派发，项目树的 React
  // 展开提交仍可能在后续帧；统一等待 aria 终态，避免各 case 提前查找 task。
  await browser.waitUntil(() => readProjectExpanded(workspacePath), {
    timeout: 15_000,
    timeoutMsg: `侧栏项目没有完成展开: ${workspacePath}`,
  });
}

/**
 * 把指针移出项目行，关闭项目详情 hover card。
 *
 * 修复原因：738c1488f1 起本地项目也有目录详情 hover card。项目行操作走 DOM 点击，
 * WebDriver 指针仍停在项目行上，卡片保持打开并盖住右侧对话区（如 Composer 模式选择器），
 * 后续 waitForClickable 一直失败。真实用户点完会移开鼠标；这里把指针移到视口左上角空白处。
 */
export async function leaveProjectRowHover(): Promise<void> {
  await browser.performActions([
    {
      type: "pointer",
      id: "project-hover-leave",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", origin: "viewport", x: 1, y: 1, duration: 0 }],
    },
  ]);
  await browser.releaseActions();
}

/** 真实 hover 项目行；hover 操作区（文件树 / 新建任务 / 更多）按 hover 挂载透明度。 */
export async function hoverProjectRow(workspacePath: string, timeout = 15_000): Promise<void> {
  const row = $(projectRowSelector(workspacePath));
  await row.waitForDisplayed({ timeout, timeoutMsg: `侧栏没有可悬停的项目行: ${workspacePath}` });
  await row.moveTo();
}

/** DOM 点击项目 section 内某个 data-testid（toggle / files / create-task / menu…）。 */
export async function clickProjectAction(
  workspacePath: string,
  actionTestId: string,
  {
    timeout = 15_000,
    timeoutMsg = `项目 ${workspacePath} 没有可点击的 ${actionTestId}`,
  }: WaitOptions = {},
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, targetTestId) => {
          const target = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${targetTestId}"]`);
          if (!target || target.disabled) return false;
          target.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        actionTestId,
      ),
    { timeout, interval: 100, timeoutMsg },
  );
}

/** 打开项目主要目录的文件树面板；对应旧「hover workspace 行 → 文件树按钮」。 */
export async function openProjectFileTree(
  workspacePath: string,
  { timeout = 15_000, timeoutMsg = "没有找到项目文件树入口" }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_FILES, { timeout, timeoutMsg });
  await leaveProjectRowHover();
  await browser.waitUntil(
    () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_WORKSPACE_FILE_TREE_PANEL,
      ),
    { timeout, timeoutMsg: "文件树面板没有打开" },
  );
}

/** 从项目行发起新建任务草稿（cwd = 项目主要目录）。 */
export async function startDraftFromProject(
  workspacePath: string,
  options: { workspaceIdentity?: string } = {},
): Promise<void> {
  let workspaceIdentity = options.workspaceIdentity?.trim();
  if (!workspaceIdentity) {
    const project = $(projectSectionSelector(workspacePath));
    await project.waitForDisplayed({ timeout: 30_000 });
    workspaceIdentity =
      (await project.getAttribute("data-project-workspace-identity")) || undefined;
  }
  // 远端草稿按 Source identity 存储；只传目录时也从目标项目读取身份，不能一直等待不存在的路径键。
  const draftKey = workspaceIdentity || workspacePath;
  const previousDraftVersion = await browser.execute((key) => {
    const bridge = (
      window as unknown as {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
        };
      }
    ).__zcodeSessionStoreE2E;
    return bridge?.getState().workspaces[key]?.draftFocusVersion ?? 0;
  }, draftKey);
  if (workspaceIdentity) {
    // 跨 Source 可以有同名同路径项目；显式 identity 时不能落到名称匹配的第一行。
    const project = $(`[data-project-workspace-identity=${JSON.stringify(workspaceIdentity)}]`);
    await project.waitForDisplayed({ timeout: 30_000 });
    await project.moveTo();
    await project.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
  } else {
    await hoverProjectRow(workspacePath);
    await clickProjectAction(workspacePath, TID_VIRTUAL_PROJECT_CREATE_TASK, {
      timeoutMsg: `项目 ${workspacePath} 没有可用的新建任务入口`,
    });
  }
  await leaveProjectRowHover();
  // 合并适配：切换项目时退场动画会短暂保留旧输入框；只等导航路径会向旧会话发送。
  // 只统计主 pane；side chat 合法保留自己的输入框，不能要求整个页面只剩一个输入框。
  // 等主 pane 旧输入框移除，再确认目标项目的空草稿，防止向退场会话发送。
  await browser.waitUntil(
    () =>
      browser.execute(
        (inputId, panePrefix, workspaceTriggerId, projectName, identity, key, previousVersion) => {
          const inputs = document.querySelectorAll(
            `[data-testid="${panePrefix}-workspace-main"] [data-testid="${inputId}"]`,
          );
          const pane = inputs[0]?.closest<HTMLElement>(`[data-testid^="${panePrefix}-"]`);
          const trigger = document.querySelector<HTMLElement>(
            `[data-testid="${workspaceTriggerId}"]`,
          );
          const activeIdentity = identity
            ? (
                window as Window & {
                  __zcodeTabStoreE2E?: {
                    getState(): { activeWorkspaceIdentity?: string | null };
                  };
                }
              ).__zcodeTabStoreE2E?.getState().activeWorkspaceIdentity
            : undefined;
          return (
            // 目录准备是异步的；同项目已经显示草稿时，旧 DOM 不能证明本次新建已提交。
            ((
              window as unknown as {
                __zcodeSessionStoreE2E?: {
                  getState(): { workspaces: Record<string, { draftFocusVersion?: number }> };
                };
              }
            ).__zcodeSessionStoreE2E?.getState().workspaces[key]?.draftFocusVersion ?? 0) >
              previousVersion &&
            (!identity || activeIdentity === identity) &&
            inputs.length === 1 &&
            pane?.dataset.sessionId === "draft" &&
            trigger?.innerText.trim() === projectName
          );
        },
        TID_V4_COMPOSER_INPUT,
        TID_V4_SESSION_PANE,
        TID_COMPOSER_WORKSPACE_TRIGGER,
        projectNameForWorkspace(workspacePath),
        workspaceIdentity,
        draftKey,
        previousDraftVersion,
      ),
    { timeout: 30_000, timeoutMsg: `项目 ${workspacePath} 的新任务输入框尚未就绪` },
  );
}

/** 打开项目行更多菜单并选择动作（edit / pin / delete / remove-entry）。 */
export async function openProjectMenuAction(
  workspacePath: string,
  actionId: string,
  { timeout = 30_000 }: WaitOptions = {},
): Promise<void> {
  await hoverProjectRow(workspacePath, timeout);
  // Bug 根因：Radix DropdownMenu trigger 依赖 pointerdown 手势，element.click() 只派发
  // click 时 portal 菜单不会打开；这里补齐指针链。
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, menuTestId) => {
          const trigger = document
            .querySelector(selector)
            ?.querySelector<HTMLButtonElement>(`[data-testid="${menuTestId}"]`);
          if (!trigger || trigger.disabled) return false;
          trigger.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          trigger.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
          );
          trigger.click();
          return true;
        },
        projectSectionSelector(workspacePath),
        TID_VIRTUAL_PROJECT_MENU,
      ),
    { timeout, timeoutMsg: `项目 ${workspacePath} 没有显示更多菜单入口` },
  );
  const itemTestId = virtualProjectActionTestId(actionId);
  await browser.waitUntil(
    () =>
      browser.execute((targetTestId) => {
        const item = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
        if (!item || item.getAttribute("aria-disabled") === "true") return false;
        item.click();
        return true;
      }, itemTestId),
    { timeout: 15_000, timeoutMsg: `项目 ${workspacePath} 菜单没有 ${actionId} 动作` },
  );
}

export interface ProjectTaskRowState {
  active: boolean;
  error: boolean;
  exists: boolean;
  inProject: boolean;
  running: boolean;
}

/** 读取任务行是否存在于目标项目 section 内及其展示状态。 */
export async function readProjectTaskRowState(
  taskId: string,
  workspacePath: string,
  workspaceIdentity?: string,
): Promise<ProjectTaskRowState> {
  return browser.execute(
    (taskTestId, sectionSelector) => {
      const taskRow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === taskTestId,
      );
      const section = document.querySelector(sectionSelector);
      return {
        active: taskRow?.classList.contains("bg-selected") ?? false,
        error: Boolean(taskRow?.querySelector('[data-error-indicator="true"]')),
        exists: Boolean(taskRow),
        inProject: Boolean(taskRow && section?.contains(taskRow)),
        running: Boolean(taskRow?.querySelector(".animate-spin")),
      };
    },
    testId(TID_TASK_ITEM, taskId),
    // 远端项目显示名可以包含设备信息，不能用目录 basename 推断归属；优先匹配稳定 identity。
    workspaceIdentity
      ? `[data-project-id][data-project-workspace-identity=${JSON.stringify(workspaceIdentity)}]`
      : projectSectionSelector(workspacePath),
  );
}

export async function waitForTaskRowInProject(
  taskId: string,
  workspacePath: string,
  {
    timeout = 30_000,
    timeoutMsg = `task ${taskId} 没有出现在项目 ${workspacePath} 下`,
  }: WaitOptions = {},
): Promise<void> {
  await waitForProjectRow(workspacePath, { timeout });
  await browser.waitUntil(
    async () => {
      // 远端项目在离线态下 toggle 被禁用、任务列表不渲染；这里只做尽力展开，
      // 由 task 行本身的出现作为 host 恢复在线且任务归位的判据。
      if (!(await readProjectExpanded(workspacePath))) {
        await browser.execute(
          (selector, toggleTestId) => {
            const toggle = document
              .querySelector(selector)
              ?.querySelector<HTMLButtonElement>(`[data-testid="${toggleTestId}"]`);
            if (toggle && !toggle.disabled) toggle.click();
          },
          projectSectionSelector(workspacePath),
          TID_VIRTUAL_PROJECT_TOGGLE,
        );
      }
      const state = await readProjectTaskRowState(taskId, workspacePath);
      return state.exists && state.inProject && !state.error;
    },
    { timeout, interval: 250, timeoutMsg },
  );
}

/** 远端身份来自项目行，不再存在 Host 包装层。 */
export async function readRemoteHostIdForProject(workspacePath: string): Promise<string | null> {
  return browser.execute(
    (selector) => document.querySelector(selector)?.getAttribute("data-project-host") ?? null,
    projectSectionSelector(workspacePath),
  );
}

/** 设备连接操作位于项目行菜单，仍交给同一个 Host 连接端口。 */
export async function clickRemoteHostConnect(
  workspacePath: string,
  options: WaitOptions = {},
): Promise<void> {
  await openProjectMenuAction(workspacePath, "connect", options);
}

/** 仅替代系统弹窗的用户选择，保留 renderer → preload → main 的真实多目录链路。 */
export async function selectNativeProjectDirectories(paths: string[]) {
  const picker = await browser.electron.mock("dialog", "showOpenDialog");
  try {
    await picker.mockResolvedValueOnce({ canceled: paths.length === 0, filePaths: paths });
    await $('[data-testid="virtual-project-browse"]').click();
    await expect(picker).toHaveBeenCalledWith({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    await $('[data-testid="virtual-project-save"]').waitForEnabled();
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    for (const path of paths) {
      await $(
        `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
      ).waitForDisplayed();
    }
  } finally {
    await picker.mockRestore();
  }
}

/** 远程目录由所属 Host 浏览，不借本机系统文件选择器。 */
export async function selectRemoteProjectDirectory(path: string) {
  if (!(await $('[data-testid="virtual-project-directory-browser"]').isDisplayed()))
    await $('[data-testid="virtual-project-browse"]').click();
  const picker = $('[data-testid="virtual-project-directory-browser"]');
  const input = picker.$('input[type="text"]');
  await input.waitForDisplayed();
  await browser.waitUntil(async () => Boolean(await input.getValue()));
  await browser.execute((value) => {
    const element = document.querySelector<HTMLInputElement>(
      '[data-testid="virtual-project-directory-browser"] input[type="text"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, path);
  await input.click();
  await browser.keys("Enter");
  const select = picker.$(
    './/button[normalize-space(.)="选择文件夹" or normalize-space(.)="Choose folder"]',
  );
  await select.waitForEnabled();
  await select.click();
  await picker.waitForExist({ reverse: true });
  await $(
    `[data-testid="virtual-project-root-name"][title=${JSON.stringify(path)}]`,
  ).waitForDisplayed();
}
