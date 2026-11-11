// 受管 worktree 任务（docs/git/worktree.md §12 WT-01 / WT-05 / WT-08 / WT-09 / WT-29 / WT-30 / WT-34 / WT-35）
// manual-review E2E。
// worktree 只是会话 cwd：workspace 始终是项目主目录，worktree 在发送后由 Host 创建。
// 只覆盖本地桌面主路径；Radix 菜单需要 pointerdown 手势才能打开，统一经 openRadixMenu。
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  TID_TASK_ROW_WORKTREE_ICON,
  TID_V4_FORK,
  TID_V4_FORK_HERE,
  TID_V4_FORK_TO_WORKTREE,
  TID_WORKSPACE_PATH,
  TID_WORKTREE_CREATED_MARKER,
  TID_WORKTREE_CREATION_CARD,
  TID_WORKTREE_TOGGLE,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { E2E_REPLY_TOKEN } from "#e2e/helpers/conversation-session";
import { openProjectMenuAction, startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const execGit = promisify(execFile);
const TEST_TIMEOUT_MS = 180_000;
// E2E 的 ZCODE_DATA_BASE_DIR 即 DEFAULT_WORKSPACE 的父目录；受管根目录与 Host 同一规则推导。
const MANAGED_ROOT = join(dirname(DEFAULT_WORKSPACE), ".zcode", "worktrees");
const BASELINE_FILE = join(".zcode-e2e", "managed-worktree", "baseline.md");
const WORKTREE_MENU_ACTION = "worktrees";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execGit("git", args, { cwd });
  return stdout.trim();
}

async function prepareSourceRepository(): Promise<string> {
  await mkdir(dirname(join(DEFAULT_WORKSPACE, BASELINE_FILE)), { recursive: true });
  await execGit("git", ["init", "-q", "-b", "main"], { cwd: DEFAULT_WORKSPACE });
  await git(DEFAULT_WORKSPACE, "config", "user.email", "zcode-e2e@example.invalid");
  await git(DEFAULT_WORKSPACE, "config", "user.name", "ZCode E2E");
  await writeFile(join(DEFAULT_WORKSPACE, BASELINE_FILE), "baseline\n", "utf8");
  await git(DEFAULT_WORKSPACE, "add", BASELINE_FILE);
  await git(DEFAULT_WORKSPACE, "commit", "-qm", "test: managed worktree baseline");
  return await git(DEFAULT_WORKSPACE, "rev-parse", "--abbrev-ref", "HEAD");
}

function isUnderManagedRoot(path: string | null | undefined): path is string {
  if (!path) return false;
  const rel = relative(MANAGED_ROOT, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== "..";
}

/** Radix DropdownMenu 只响应 pointerdown 手势；element.click() 不会打开 portal 菜单。 */
async function openRadixMenu(selector: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((target) => {
        const element = document.querySelector<HTMLElement>(target);
        if (!element || element.getAttribute("aria-disabled") === "true") return false;
        const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" } as const;
        element.dispatchEvent(new PointerEvent("pointerdown", init));
        element.dispatchEvent(new PointerEvent("pointerup", init));
        return true;
      }, selector),
    { timeout: 15_000, interval: 200, timeoutMsg },
  );
}

async function clickMenuItem(selector: string, timeoutMsg: string): Promise<void> {
  const item = $(selector);
  await item.waitForDisplayed({ timeout: 15_000, timeoutMsg });
  await browser.waitUntil(async () => (await item.getAttribute("data-disabled")) === null, {
    timeout: 15_000,
    timeoutMsg: `${timeoutMsg}（菜单项一直禁用）`,
  });
  await item.click();
}

/** 受管根目录下现有的 worktree 根目录（<受管根>/<bucket>/<仓库名>）。 */
async function listManagedWorktrees(): Promise<string[]> {
  const buckets = await readdir(MANAGED_ROOT, { withFileTypes: true }).catch(() => []);
  return buckets
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(MANAGED_ROOT, entry.name, basename(DEFAULT_WORKSPACE)));
}

/**
 * 等新的受管 worktree 检出完成：bucket 目录在分配时就出现，worktree 目录和 `.git` 文件要等
 * `git worktree add` 结束后才有，只看 bucket 会在检出完成前就去执行 git。
 */
async function waitForNewWorktree(known: readonly string[]): Promise<string> {
  let created: string | undefined;
  await browser.waitUntil(
    async () => {
      for (const path of await listManagedWorktrees()) {
        if (known.includes(path)) continue;
        const dotGit = await stat(join(path, ".git")).catch(() => null);
        if (dotGit?.isFile()) {
          created = path;
          return true;
        }
      }
      return false;
    },
    { timeout: 60_000, interval: 250, timeoutMsg: "受管根目录下没有出现新的 worktree" },
  );
  return created!;
}

/** 头部项目胶囊的名称为 `<仓库名> · <bucket>`（§3.7），工作区路径仍是项目主目录。 */
async function waitForHeaderWorktree(worktreeRoot: string): Promise<void> {
  const bucket = basename(dirname(worktreeRoot));
  let last = "";
  await browser
    .waitUntil(
      async () => {
        const badge = $(`[data-testid="${TID_WORKSPACE_PATH}"]`);
        if (!(await badge.isExisting())) return false;
        const path = await badge.getAttribute("data-workspace-abs-path");
        const label = (await badge.getAttribute("aria-label")) ?? "";
        last = `path=${path} label=${label}`;
        return path === DEFAULT_WORKSPACE && label.includes(`· ${bucket}`);
      },
      { timeout: 30_000, interval: 250 },
    )
    .catch(() => {
      throw new Error(`头部没有显示 worktree ${bucket}（最后一次：${last}）`);
    });
}

/** 当前最后一个 assistant 行的分叉按钮 testid 后缀。 */
async function lastForkRowSuffix(): Promise<string> {
  const forkTrigger = await browser.execute((prefix) => {
    const triggers = document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`);
    return triggers.length > 0 ? triggers[triggers.length - 1]!.getAttribute("data-testid") : null;
  }, TID_V4_FORK);
  if (!forkTrigger) throw new Error("没有可分叉的 assistant 行");
  await openRadixMenu(`[data-testid="${forkTrigger}"]`, "分叉目的地菜单没有打开");
  return forkTrigger.slice(`${TID_V4_FORK}-`.length);
}

/** composer 头部与输入框的几何位置，用于检查勾选复选框不引起布局位移（WT-34）。 */
async function readComposerGeometry(): Promise<string> {
  return await browser.execute((toggleId) => {
    const label = document.querySelector(`[data-testid="${toggleId}"]`)?.closest("label");
    const header = label?.parentElement;
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    const rect = (el: Element | null | undefined) => {
      if (!el) return "missing";
      const r = el.getBoundingClientRect();
      return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    return `toggle=${rect(label)} header=${rect(header)} input=${rect(input)}`;
  }, TID_WORKTREE_TOGGLE);
}

/**
 * 逐帧记录主区：创建卡片是否存在、主 pane 绑定的会话与时间线行数（WT-35）。
 * 返回停止函数，结果中"已绑定真实会话、时间线为空且没有创建卡片"的帧就是空白帧。
 */
async function startBlankFrameSampler(): Promise<() => Promise<string[]>> {
  await browser.execute((cardId) => {
    const w = window as unknown as { __wtFrames: string[]; __wtStop: boolean };
    w.__wtFrames = [];
    w.__wtStop = false;
    const tick = () => {
      if (w.__wtStop) return;
      const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
      const session = pane?.getAttribute("data-session-id") ?? null;
      const rows = pane?.querySelectorAll('[data-testid="v4-timeline"] [data-row-id]').length ?? 0;
      const card = Boolean(document.querySelector(`[data-testid="${cardId}"]`));
      if (!card && session && session !== "draft" && rows === 0)
        w.__wtFrames.push(`session=${session} rows=0 card=false`);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, TID_WORKTREE_CREATION_CARD);
  return async () =>
    await browser.execute(() => {
      const w = window as unknown as { __wtFrames: string[]; __wtStop: boolean };
      w.__wtStop = true;
      return w.__wtFrames;
    });
}

async function sendAndWaitCompleted(marker: string): Promise<void> {
  // 不用只读工具 prompt：它的读取目标在源仓库内，回放续段 fixture 只登记在各 conversation 用例中；
  // 回复 token 出现在 prompt 本身，必须等 assistant 消息而不是时间线文本，否则会提前通过。
  await sendV4Prompt(`${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
  await waitForV4TimelineContaining(marker);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 90_000);
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
    `${marker} 的 v4 会话没有完成`,
    90_000,
  );
}

describe("受管 worktree 任务 manual-review E2E", () => {
  let sourceBranch = "";
  let firstWorktree = "";
  let forkWorktree = "";

  before(async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    sourceBranch = await prepareSourceRepository();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await rm(MANAGED_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("WT-01: 勾选 worktree 后发送，发送后才创建 worktree，任务在 detached 的 worktree 中运行", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const toggle = $(`[data-testid="${TID_WORKTREE_TOGGLE}"]`);
    await toggle.waitForDisplayed({ timeout: 30_000, timeoutMsg: "worktree 复选框没有出现" });
    await browser.waitUntil(async () => (await toggle.getAttribute("disabled")) === null, {
      timeout: 30_000,
      timeoutMsg: "worktree 复选框一直禁用（CLI 未声明 worktreeCwd）",
    });
    const geometryBefore = await readComposerGeometry();
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute("data-state")) === "checked", {
      timeout: 10_000,
      timeoutMsg: "worktree 复选框没有勾选",
    });
    // WT-34：分支胶囊切换后 composer 头部高度与控件位置不变。
    expect(await readComposerGeometry()).toBe(geometryBefore);
    // 选择阶段不创建任何东西（§3.2）。
    expect(await listManagedWorktrees()).toEqual([]);

    const stopSampler = await startBlankFrameSampler();
    await sendAndWaitCompleted(`E2E_MANAGED_WORKTREE_CREATE_${Date.now()}`);
    // WT-35：创建视图保留到时间线出现第一轮，中间没有空白帧。
    expect(await stopSampler()).toEqual([]);
    firstWorktree = await waitForNewWorktree([]);

    expect(await git(firstWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(DEFAULT_WORKSPACE, "rev-parse", "--abbrev-ref", "HEAD")).toBe(sourceBranch);
    await $(`[data-testid="${TID_WORKTREE_CREATED_MARKER}"]`).waitForExist({
      timeout: 30_000,
      timeoutMsg: '会话历史中没有"已创建 worktree"',
    });
    await $(`[data-testid="${TID_TASK_ROW_WORKTREE_ICON}"]`).waitForExist({
      timeout: 30_000,
      timeoutMsg: "侧栏任务行没有显示 worktree 图标",
    });
    await waitForHeaderWorktree(firstWorktree);
  });

  it("WT-05 / WT-29: 在新 worktree 中分叉，子任务 cwd 是另一个 worktree，并带上父任务的未提交改动", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    if (!isUnderManagedRoot(firstWorktree)) throw new Error("WT-01 没有产出受管 worktree 路径");
    // 父任务 cwd 中准备三类改动：已暂存、未暂存、未跟踪。
    await writeFile(join(firstWorktree, "e2e-staged.txt"), "staged\n", "utf8");
    await git(firstWorktree, "add", "e2e-staged.txt");
    await writeFile(join(firstWorktree, BASELINE_FILE), "baseline\nunstaged\n", "utf8");
    await writeFile(join(firstWorktree, "e2e-untracked.txt"), "untracked\n", "utf8");
    const parentStatus = await git(firstWorktree, "status", "--porcelain");
    const rowSuffix = await lastForkRowSuffix();
    await clickMenuItem(
      `[data-testid="${TID_V4_FORK_TO_WORKTREE}-${rowSuffix}"]`,
      "分叉菜单没有在新 worktree 中分叉的选项",
    );

    forkWorktree = await waitForNewWorktree([firstWorktree]);
    expect(await git(forkWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 60_000);
    await $(`[data-testid="${TID_WORKTREE_CREATED_MARKER}"]`).waitForExist({
      timeout: 30_000,
      timeoutMsg: '子任务历史中没有"已创建 worktree"',
    });
    await waitForHeaderWorktree(forkWorktree);
    // WT-29：子任务打开说明创建（含带入改动）已完成。暂存区划分保持不变，未跟踪文件被复制；
    // 父目录的 git 状态不变。
    expect(await git(forkWorktree, "diff", "--cached", "--name-only")).toBe("e2e-staged.txt");
    expect(await git(forkWorktree, "diff", "--name-only")).toBe(BASELINE_FILE.split(sep).join("/"));
    expect(await git(forkWorktree, "ls-files", "--others", "--exclude-standard")).toBe(
      "e2e-untracked.txt",
    );
    expect(await git(firstWorktree, "status", "--porcelain")).toBe(parentStatus);
    // 恢复父 worktree，WT-08 要删除一个干净的 worktree。
    await git(firstWorktree, "reset", "--hard", "-q");
    await git(firstWorktree, "clean", "-fdq");
  });

  it('WT-30: 在 worktree 任务中"在当前 worktree 中分叉"，子任务共用同一个 worktree', async function () {
    this.timeout(TEST_TIMEOUT_MS);
    if (!isUnderManagedRoot(forkWorktree)) throw new Error("WT-05 没有产出受管 worktree 路径");
    const iconsBefore = await $$(`[data-testid="${TID_TASK_ROW_WORKTREE_ICON}"]`).length;
    const parentSession = await $(`[data-testid="v4-session-pane-workspace-main"]`).getAttribute(
      "data-session-id",
    );
    const rowSuffix = await lastForkRowSuffix();
    const here = $(`[data-testid="${TID_V4_FORK_HERE}-${rowSuffix}"]`);
    await here.waitForDisplayed({ timeout: 15_000, timeoutMsg: "分叉菜单没有第一项" });
    expect((await here.getText()).toLowerCase()).toContain("worktree");
    const known = await listManagedWorktrees();
    await here.click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="v4-session-pane-workspace-main"]`).getAttribute(
          "data-session-id",
        )) !== parentSession,
      { timeout: 30_000, timeoutMsg: "没有打开分叉出的子任务" },
    );
    await waitForHeaderWorktree(forkWorktree);
    await browser.waitUntil(
      async () => (await $$(`[data-testid="${TID_TASK_ROW_WORKTREE_ICON}"]`).length) > iconsBefore,
      { timeout: 30_000, timeoutMsg: "子任务行没有显示 worktree 图标" },
    );
    // 共用父任务的 worktree，不创建新的。
    expect(await listManagedWorktrees()).toEqual(known);
  });

  it("WT-08/WT-09: 管理弹窗中有改动的 worktree 不可删除，干净的 worktree 删除后目录消失", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    // 依赖 WT-01/WT-05 产出的路径；缺失时直接失败，避免把脏文件写到进程 cwd。
    if (!isUnderManagedRoot(firstWorktree) || !isUnderManagedRoot(forkWorktree))
      throw new Error("前置用例没有产出受管 worktree 路径");
    const dirtyFile = join(forkWorktree, "e2e-dirty.txt");
    await writeFile(dirtyFile, "dirty\n", "utf8");
    await openProjectMenuAction(DEFAULT_WORKSPACE, WORKTREE_MENU_ACTION);
    await $(`[data-testid="managed-worktrees-dialog"]`).waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "Worktrees 管理弹窗没有打开",
    });
    const rowSelector = (path: string) =>
      `[data-testid="managed-worktree-row"][data-path=${JSON.stringify(path)}]`;
    await $(rowSelector(firstWorktree)).waitForDisplayed({ timeout: 30_000 });
    await $(rowSelector(forkWorktree)).waitForDisplayed({ timeout: 30_000 });

    const dirtyDelete = $(`${rowSelector(forkWorktree)} [data-testid="managed-worktree-delete"]`);
    expect(await dirtyDelete.getAttribute("aria-disabled")).toBe("true");

    await $(`${rowSelector(firstWorktree)} [data-testid="managed-worktree-delete"]`).click();
    const confirm = $(`[data-testid="managed-worktree-delete-confirm-action"]`);
    await confirm.waitForDisplayed({ timeout: 15_000, timeoutMsg: "删除确认框没有出现" });
    await confirm.click();
    await $(rowSelector(firstWorktree)).waitForExist({
      reverse: true,
      timeout: 60_000,
      timeoutMsg: "删除后 worktree 行仍在列表中",
    });
    const removed = await stat(firstWorktree).then(
      () => false,
      () => true,
    );
    expect(removed).toBe(true);
    await rm(dirtyFile, { force: true });
  });
});
