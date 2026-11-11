import { writeFile } from "node:fs/promises";
import { startProjectPointerDrag } from "#e2e/helpers/project-sidebar";
import { join } from "node:path";
import { isIsolatedE2EHomeDir } from "#e2e/helpers/e2e-runtime-paths";
import { DatabaseSync } from "node:sqlite";
import {
  loginWithApiKey,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4PaneSnapshot,
  setV4ComposerText,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { installHandoffRpcProbe, callHandoffHost } from "#e2e/helpers/remote-project-handoff-probe";
import { ServiceChannels, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";

declare global {
  interface Window {
    __groupPlacementBarrier?: { held: number; release(): void; restore(): void };
  }
}

async function reloadGroupWorkspace() {
  await browser.refresh();
  const login = $('[data-testid="login-use-api-key-button"]');
  await browser.waitUntil(
    async () =>
      (await login.isDisplayed()) || (await $('[data-testid="sidebar-view-menu"]').isDisplayed()),
    { timeout: 45_000 },
  );
  if (await login.isDisplayed()) await loginWithApiKey();
  await $('[data-testid="sidebar-view-menu"]').waitForDisplayed({ timeout: 30_000 });
}
async function waitForGroupedLayout() {
  // 颜色菜单在 Portal 中退场；只等列表动画会让指针按在尚未卸载的菜单上。
  await $('[data-testid="task-group-color-gray"]').waitForExist({ reverse: true });
  await browser.waitUntil(() =>
    browser.execute(
      () =>
        !document
          .querySelector('[data-testid="task-grouped-view"]')
          ?.getAnimations({ subtree: true })
          .some(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getComputedTiming().endTime !== Infinity,
          ),
    ),
  );
}
async function fillGroupTitle(value: string) {
  const input = $('[data-testid="task-group-title-input"]');
  await input.waitForDisplayed();
  await input.click();
  // WebDriver clear 会先 blur 并提交内联编辑；模拟真实用户全选输入。
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await input.addValue(value);
}
describe("任务分组独立视图", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const failureName = `task-groups-failure-${this.currentTest?.title.split("：")[0]?.replaceAll("/", "_")}`;
      await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${failureName}.png`));
      const layout = await browser.execute(() => {
        const root = document.querySelector('[data-testid="task-grouped-view"]');
        const viewport = root?.closest("[data-scroll-mask]");
        const groups = [...document.querySelectorAll("[data-grouped-group-item-id]")].map(
          (group) => ({
            id: group.getAttribute("data-grouped-group-item-id"),
            collapsed: group.getAttribute("data-group-collapsed"),
            rect: group.getBoundingClientRect().toJSON(),
            header: group
              .querySelector("[data-grouped-group-header-id]")
              ?.getBoundingClientRect()
              .toJSON(),
          }),
        );
        return {
          root: root?.getBoundingClientRect().toJSON(),
          viewport: viewport?.getBoundingClientRect().toJSON(),
          scrollTop: viewport?.scrollTop,
          scrollHeight: viewport?.scrollHeight,
          groups,
          bodyCursor: document.body.style.cursor,
          sticky: document.querySelector("[data-grouped-sticky-header]")?.outerHTML,
        };
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${failureName}.json`),
        JSON.stringify(layout, null, 2),
      );
      process.stderr.write(
        `GRP failure UI: ${await browser.execute(() => document.body.innerText.slice(0, 3500))}\n`,
      );
    }
  });
  before(async () => {
    await prepareV4ConversationE2E();
    await installHandoffRpcProbe();
  });
  it("GRP02：旧分组偏好迁移，新选择在重载后优先", async function () {
    this.timeout(60_000);
    await browser.execute(() => {
      localStorage.removeItem("zcode-project-sidebar-preferences");
      localStorage.setItem(
        "zcode-sidebar-task-preferences",
        JSON.stringify({ organizeBy: "grouped", sortBy: "updated" }),
      );
    });
    await reloadGroupWorkspace();
    await $('[data-testid="task-group-add"]').waitForDisplayed({ timeout: 30_000 });
    await $('[data-testid="sidebar-view-menu"]').click();
    expect(await $('[data-testid="sidebar-view-grouped"]').getAttribute("data-state")).toBe(
      "checked",
    );
    // 恢复必须沿用旧 Hash 入口；不是重新画一套分组控件。
    expect(await $('[data-testid="sidebar-view-grouped"] svg.lucide-hash').isExisting()).toBe(true);
    await $('[data-testid="sidebar-view-timeline"]').click();
    await reloadGroupWorkspace();
    await $('[data-testid="sidebar-view-menu"]').waitForClickable();
    await $('[data-testid="sidebar-view-menu"]').click();
    expect(await $('[data-testid="sidebar-view-timeline"]').getAttribute("data-state")).toBe(
      "checked",
    );
    await browser.keys("Escape");
    await $('[data-testid="sidebar-view-timeline"]').waitForExist({ reverse: true });
    await installHandoffRpcProbe();
  });
  it("GRP02/03/11：三视图、创建改色改名、重载与取消空组", async function () {
    this.timeout(90_000);
    await $('[data-testid="sidebar-view-menu"]').click();
    for (const view of ["projects", "grouped", "timeline"])
      await $(`[data-testid="sidebar-view-${view}"]`).waitForDisplayed();
    await $('[data-testid="sidebar-view-grouped"]').click();
    await $('[data-testid="task-group-add"]').waitForClickable();
    await $('[data-testid="task-group-add"]').click();
    const input = $('[data-testid="task-group-title-input"]');
    await input.waitForDisplayed();
    await fillGroupTitle("E2E_GROUP");
    await browser.keys("Enter");
    const row = $('[data-task-group-title="E2E_GROUP"]');
    await row.waitForDisplayed();
    await $('[data-testid="task-group-color-blue"]').click();
    const before = await callHandoffHost<{
      groups: Array<{ id: string; title: string; color: string }>;
    }>(ServiceChannels.TaskGroups, "read");
    const group = before.groups.find((group) => group.title === "E2E_GROUP");
    expect(group?.color).toBe("blue");
    await reloadGroupWorkspace();
    await row.waitForDisplayed();
    await installHandoffRpcProbe();
    await row.$('[data-testid="task-group-menu"]').click({ button: "right" });
    await $('[data-testid="task-group-rename"]').click();
    await fillGroupTitle("E2E_RENAMED");
    await browser.keys("Enter");
    const renamed = $('[data-task-group-title="E2E_RENAMED"]');
    await renamed.waitForDisplayed();
    // GRP11：旧版颜色圆标、标题折叠、可点击空态、草稿关闭，不能退回新画的拖拽把手。
    expect(await renamed.$("svg.lucide-hash").isExisting()).toBe(true);
    expect(await $$('[data-testid="task-group-drag-handle"]')).toHaveLength(0);
    await renamed.$("[data-grouped-group-header-id]").click();
    expect(await renamed.getAttribute("data-group-collapsed")).toBe("true");
    await renamed.$("[data-grouped-group-header-id]").click();
    await renamed.$("[data-grouped-empty-drop-zone-id]").click();
    const draft = renamed.$('[data-testid="grouped-draft-task"]');
    await draft.waitForDisplayed();
    await setV4ComposerText("PD12_GROUP_DRAFT_KEEP");
    await draft.moveTo();
    await draft.$("button").click();
    await draft.waitForExist({ reverse: true });
    await renamed.$("[data-grouped-empty-drop-zone-id]").waitForDisplayed();
    // 关闭分组行只撤销组织意图；刷新仍保留正文，不能从旧目录 key 复活分组行。
    await reloadGroupWorkspace();
    await installHandoffRpcProbe();
    await waitForV4ComposerText("PD12_GROUP_DRAFT_KEEP", "关闭分组草稿丢失正文");
    expect(await renamed.$('[data-testid="grouped-draft-task"]').isExisting()).toBe(false);
    await setV4ComposerText("");
    for (const [theme, locale] of [
      ["zai-light", "zh-CN"],
      ["zai-dark", "en-US"],
    ]) {
      await browser.execute(
        ([theme, locale]) => {
          const actions = (
            window as Window & {
              __testActions?: { setTheme(value: string): void; setLocale(value: string): void };
            }
          ).__testActions!;
          actions.setTheme(theme!);
          actions.setLocale(locale!);
        },
        [theme, locale],
      );
      await browser.waitUntil(() =>
        browser.execute(
          (value) => document.documentElement.classList.contains(`theme-${value}`),
          theme,
        ),
      );
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="task-group-add"]').getAttribute("aria-label")) ===
          (locale === "zh-CN" ? "新建分组" : "New group"),
      );
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `task-groups-${theme}.png`),
      );
    }
    await renamed.$('[data-testid="task-group-menu"]').click({ button: "right" });
    await $('[data-testid="task-group-ungroup"]').click();
    await renamed.waitForExist({ reverse: true });
    const after = await callHandoffHost<{ groups: Array<{ id: string }> }>(
      ServiceChannels.TaskGroups,
      "read",
    );
    expect(after.groups.some((item) => item.id === group!.id)).toBe(false);
  });
  it("GRP04/05/06：组内首发、三视图菜单、置顶/归档和恢复保持成员", async function () {
    this.timeout(180_000);
    await $('[data-testid="task-group-add"]').click();
    await fillGroupTitle("E2E_GROUP_MEMBERS");
    await browser.keys("Enter");
    await browser.keys("Escape");
    const groupRow = $('[data-task-group-title="E2E_GROUP_MEMBERS"]');
    await groupRow.waitForDisplayed();
    const groupId = await groupRow.getAttribute("data-task-group-id");
    await groupRow.$('[data-testid="task-group-new-task"]').click();
    await sendV4Prompt("E2E_GROUP_TASK 请回复 E2E_GROUP_READY。");
    await waitForV4AssistantMessageContaining("E2E_GROUP_READY");
    await groupRow.$('[data-testid="grouped-draft-task"]').waitForExist({ reverse: true });
    const taskId = (await getV4PaneSnapshot()).sessionId!;
    const read = () =>
      callHandoffHost<{
        members: Array<{ groupId: string; taskId: string; workspaceKey: string }>;
      }>(ServiceChannels.TaskGroups, "read");
    await browser.waitUntil(async () =>
      (await read()).members.some((m) => m.taskId === taskId && m.groupId === groupId),
    );
    const tree = await callHandoffHost<{
      tasks: Array<{ taskId: string; workspacePath: string; projectId: string | null }>;
    }>(ServiceChannels.Project, "readTree");
    const task = tree.tasks.find((t) => t.taskId === taskId)!;
    expect(task.projectId).toBeNull();
    const target = { taskId, workspacePath: task.workspacePath };
    const selector = `[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`;
    for (const view of ["projects", "timeline", "grouped"]) {
      await $('[data-testid="sidebar-view-menu"]').click();
      await $(`[data-testid="sidebar-view-${view}"]`).click();
      await $(selector).waitForDisplayed();
      await $(selector).click({ button: "right" });
      await $('[data-testid="task-group-move-menu"]').waitForDisplayed();
      await browser.keys("Escape");
      await $('[data-testid="task-group-move-menu"]').waitForExist({ reverse: true });
    }
    await callHandoffHost(ServiceChannels.ZCodeTask, "setTaskPinned", [
      { ...target, pinned: true },
    ]);
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await $('[data-testid="project-pinned-tasks"]').$(selector).waitForDisplayed();
    expect(await $$(`[data-testid="task-grouped-view"] ${selector}`)).toHaveLength(0);
    await callHandoffHost(ServiceChannels.ZCodeTask, "setTaskPinned", [
      { ...target, pinned: false },
    ]);
    await callHandoffHost(ServiceChannels.ZCodeTask, "archiveTask", [target]);
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await $(selector).waitForExist({ reverse: true });
    expect((await read()).members.some((m) => m.taskId === taskId && m.groupId === groupId)).toBe(
      true,
    );
    await callHandoffHost(ServiceChannels.ZCodeTask, "unarchiveTask", [target]);
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await $(selector).waitForDisplayed();
    await $('[data-testid="task-group-add"]').click();
    await fillGroupTitle("E2E_DROP_TARGET");
    await browser.keys("Enter");
    await browser.keys("Escape");
    const dropTarget = $('[data-task-group-title="E2E_DROP_TARGET"]');
    await dropTarget.waitForDisplayed();
    const targetGroupId = await dropTarget.getAttribute("data-task-group-id");
    await waitForGroupedLayout();
    await startProjectPointerDrag(selector);
    const dropPoint = await browser.execute(() => {
      const rect = document
        .querySelector(
          '[data-task-group-title="E2E_DROP_TARGET"] [data-grouped-empty-drop-zone-id]',
        )!
        .getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    });
    await browser.performActions([
      {
        type: "pointer",
        id: "project-drag",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", ...dropPoint, duration: 200 }],
      },
    ]);
    await browser.waitUntil(async () => await dropTarget.$(selector).isExisting());
    await browser.performActions([
      {
        type: "pointer",
        id: "project-drag",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () =>
      (await read()).members.some((m) => m.taskId === taskId && m.groupId === targetGroupId),
    );
    await waitForGroupedLayout();
    await $(selector).click({ button: "right" });
    await $('[data-testid="task-group-move-menu"]').waitForDisplayed();
    await $('[data-testid="task-group-move-menu"]').moveTo();
    await $('[data-testid="task-group-remove"]').waitForDisplayed();
    await $('[data-testid="task-group-remove"]').click();
    await browser.waitUntil(async () => !(await read()).members.some((m) => m.taskId === taskId));
    expect(
      (
        await callHandoffHost<{
          tasks: Array<{ taskId: string; workspacePath: string; projectId: string | null }>;
        }>(ServiceChannels.Project, "readTree")
      ).tasks.find((t) => t.taskId === taskId),
    ).toMatchObject({ taskId, workspacePath: task.workspacePath, projectId: task.projectId });
  });
  it("GRP06/CR-01：组织登记挂起时取消首发仍可刷新目录，释放后只入组一次", async function () {
    this.timeout(90_000);
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-grouped"]').click();
    await $('[data-testid="task-group-add"]').click();
    await fillGroupTitle("E2E_GROUP_PENDING");
    await browser.keys("Enter");
    await browser.keys("Escape");
    const row = $('[data-task-group-title="E2E_GROUP_PENDING"]');
    await row.waitForDisplayed();
    const groupId = await row.getAttribute("data-task-group-id");
    if (!groupId) throw new Error("CR-01: group identity unavailable");
    const readTree = () =>
      callHandoffHost<{ tasks: Array<{ taskId: string }> }>(ServiceChannels.Project, "readTree");
    const before = new Set((await readTree()).tasks.map((task) => task.taskId));
    // 挂住真实 UI 的 placement RPC，普通目录、分组读取和无 placement 登记继续通行。
    // 只控制故障边界，不替换创建 ACK、权威目录或分组服务。
    await browser.execute((groupId) => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<{ port: MessagePort; args: unknown[] }> = [];
      const probe = {
        held: 0,
        release() {
          for (const { port, args } of held.splice(0)) Reflect.apply(original, port, args);
        },
        restore() {
          this.release();
          MessagePort.prototype.postMessage = original;
          delete window.__groupPlacementBarrier;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
        const args = options === undefined ? [message] : [message, options];
        if (
          text.includes("task-groups") &&
          text.includes("admit") &&
          text.includes("placement") &&
          text.includes(groupId)
        ) {
          held.push({ port: this, args });
          probe.held++;
          return;
        }
        Reflect.apply(original, this, args);
      };
      window.__groupPlacementBarrier = probe;
    }, groupId);
    try {
      await row.$('[data-testid="task-group-new-task"]').click();
      await sendV4Prompt("E2E_GROUP_PENDING 请回复 E2E_GROUP_PENDING_READY。");
      await browser.waitUntil(() =>
        browser.execute(() => window.__groupPlacementBarrier?.held === 1),
      );
      const created = (await readTree()).tasks.filter((task) => !before.has(task.taskId));
      expect(created).toHaveLength(1);
      const taskId = created[0]!.taskId;
      // 在组织请求未返回时离开首发 pane；新的目录事实必须仍可进入共享列表。
      await row.$('[data-testid="task-group-new-task"]').click();
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        { name: "E2E_CR01_REFRESH", roots: [] },
      ]);
      await $('[data-testid="sidebar-view-menu"]').click();
      await $('[data-testid="sidebar-view-projects"]').click();
      await $('[data-project-name="E2E_CR01_REFRESH"]').waitForDisplayed({ timeout: 10_000 });
      expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
      expect(await browser.execute(() => window.__groupPlacementBarrier?.held)).toBe(1);
      await browser.execute(() => window.__groupPlacementBarrier?.release());
      await browser.waitUntil(async () => {
        const groups = await callHandoffHost<{
          members: Array<{ taskId: string; groupId: string }>;
        }>(ServiceChannels.TaskGroups, "read");
        return (
          groups.members.filter((member) => member.taskId === taskId && member.groupId === groupId)
            .length === 1
        );
      });
      expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
      expect((await readTree()).tasks.filter((task) => !before.has(task.taskId))).toHaveLength(1);
      process.stderr.write(
        "CR-01: held placement, navigation cancellation, directory refresh and late group admission passed\n",
      );
    } finally {
      await browser.execute(() => window.__groupPlacementBarrier?.restore());
    }
  });
  it("GRP11：整组拖拽取消恢复展开，释放只调整顶层顺序", async function () {
    this.timeout(45_000);
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-grouped"]').click();
    await installHandoffRpcProbe();
    const first = await callHandoffHost<{ id: string }>(ServiceChannels.TaskGroups, "save", [
      { title: "E2E_ORDER_A" },
    ]);
    const second = await callHandoffHost<{ id: string }>(ServiceChannels.TaskGroups, "save", [
      { title: "E2E_ORDER_B" },
    ]);
    const readOrder = async () =>
      (await callHandoffHost<{ order: unknown[] }>(ServiceChannels.TaskGroups, "read")).order;
    const original = await readOrder();
    const source = `[data-grouped-group-header-id="${first.id}"]`;
    const target = `[data-grouped-group-header-id="${second.id}"]`;
    await $(source).waitForDisplayed();
    const start = async () => {
      await waitForGroupedLayout();
      const point = await browser.execute((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { x: Math.round(rect.left + 80), y: Math.round(rect.top + rect.height / 2) };
      }, source);
      await browser.performActions([
        {
          type: "pointer",
          id: "group-drag",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", ...point, duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", x: point.x, y: point.y + 8, duration: 0 },
          ],
        },
      ]);
      await browser.waitUntil(
        async () => (await $(source).getAttribute("aria-pressed")) === "true",
      );
      const over = await browser.execute((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { x: Math.round(rect.left + 80), y: Math.round(rect.top + rect.height / 2) };
      }, target);
      await browser.performActions([
        {
          type: "pointer",
          id: "group-drag",
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerMove", ...over, duration: 250 }],
        },
      ]);
      expect(await $(source).getAttribute("aria-expanded")).toBe("false");
    };
    await start();
    await browser.keys("Escape");
    await browser.releaseActions();
    await browser.waitUntil(async () => (await $(source).getAttribute("aria-expanded")) === "true");
    expect(await readOrder()).toEqual(original);
    await start();
    await browser.performActions([
      {
        type: "pointer",
        id: "group-drag",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(
      async () => JSON.stringify(await readOrder()) !== JSON.stringify(original),
    );
    expect(await $(source).getAttribute("aria-expanded")).toBe("true");
  });
  it("GRP10：千行分组虚拟滚动、吸顶和折叠重载", async function () {
    this.timeout(90_000);
    await installHandoffRpcProbe();
    const group = await callHandoffHost<{ id: string }>(ServiceChannels.TaskGroups, "save", [
      { title: "E2E_LARGE_GROUP" },
    ]);
    const tree = await callHandoffHost<{ tasks: Array<{ workspacePath: string }> }>(
      ServiceChannels.Project,
      "readTree",
    );
    const cwd = tree.tasks[0]?.workspacePath;
    const home = process.env.ZCODE_E2E_HOME_DIR;
    // 批量 runner 的 HOME 可能是 .e2e-home、带 runId 或显式根下的 shard 目录；仍只允许写入隔离 E2E HOME。
    if (!isIsolatedE2EHomeDir(home) || !cwd) throw new Error("隔离 HOME 和真实任务目录 required");
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      const task = db.prepare(
        `INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at,host_id,root_path,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,handoff_pending,provider) VALUES(?,?,?,?,?,?,'local',?,?,'custom',?,?,'completed',0,8,?)`,
      );
      const member = db.prepare(
        `INSERT INTO task_group_members(group_id,workspace_key,workspace_path,task_id,sort_order,added_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      );
      const now = Date.now();
      for (let i = 0; i < 1000; i++) {
        const id = `E2E_LARGE_${i}`;
        // 项目树现在只展示当前执行后端；列表夹具必须声明与真实任务一致的 provider。
        task.run(
          cwd,
          cwd,
          id,
          id,
          now + i,
          now + i,
          cwd,
          id,
          now + i,
          now + i,
          ZCODE_AGENT_PROVIDER,
        );
        member.run(group.id, cwd, cwd, id, i, now, now, now);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await reloadGroupWorkspace();
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-grouped"]').click();
    await $('[data-task-group-title="E2E_LARGE_GROUP"]').waitForDisplayed();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.querySelectorAll('[data-testid="task-grouped-view"] [data-task-item-key]')
            .length > 5,
      ),
    );
    const scroll = async (bottom: boolean) =>
      browser.execute((bottom) => {
        const list = document.querySelector('[data-testid="task-grouped-view"]')!;
        const viewport = list.closest("[data-scroll-mask]")!;
        viewport.scrollTop = bottom ? viewport.scrollHeight : 0;
        viewport.dispatchEvent(new Event("scroll"));
      }, bottom);
    await scroll(true);
    await $(`[data-testid="${testId(TID_TASK_ITEM, "E2E_LARGE_999")}"]`).waitForDisplayed();
    expect(
      (await $('[data-testid="task-grouped-view"]').$$("[data-task-item-key]")).length,
    ).toBeLessThan(80);
    // 大组后还有其他组；滚动到底并不代表仍在大组内，必须核对该组中段的吸顶身份。
    await browser.execute(() => {
      const group = document.querySelector('[data-task-group-title="E2E_LARGE_GROUP"]')!;
      const viewport = group.closest("[data-scroll-mask]")!;
      viewport.scrollTop +=
        group.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 1000;
    });
    await $(`[data-grouped-sticky-header="${group.id}"]`).waitForDisplayed();
    const geometry = await browser.execute(() => {
      const header = document.querySelector("[data-grouped-sticky-header]")!;
      const viewport = document
        .querySelector('[data-testid="task-grouped-view"]')!
        .closest("[data-scroll-mask]")!;
      return {
        header: header.getBoundingClientRect().top,
        top: viewport.getBoundingClientRect().top,
      };
    });
    expect(Math.abs(geometry.header - geometry.top)).toBeLessThan(40);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "task-groups-long-list.png"),
    );
    await scroll(false);
    const header = $('[data-task-group-title="E2E_LARGE_GROUP"]');
    await header.$("[data-grouped-group-header-id]").click();
    await $(`[data-testid="${testId(TID_TASK_ITEM, "E2E_LARGE_0")}"]`).waitForExist({
      reverse: true,
    });
    await reloadGroupWorkspace();
    expect(await header.$("[data-grouped-group-header-id]").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await header.$("[data-grouped-group-header-id]").click();
    await $(`[data-testid="${testId(TID_TASK_ITEM, "E2E_LARGE_0")}"]`).waitForDisplayed();
  });
});
