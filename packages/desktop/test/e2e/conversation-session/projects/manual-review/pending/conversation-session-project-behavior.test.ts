// 统一 runner 与旧手工入口均使用隔离 HOME；不能因 runId 前缀不同拒绝安全夹具。
import { DatabaseSync } from "node:sqlite";
import { join, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { loginWithApiKey } from "#e2e/helpers/v4-conversation";
import { TID_AUTOMATIONS_OPEN } from "@zcode/shared/test-ids";
import { ServiceChannels } from "@zcode/shared";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

const projectId = "e2e-project-behavior";
const name = "E2E_PROJECT_BEHAVIOR";
const rowSelector = `[data-project-id="${projectId}"]`;
const taskSelector = '[data-testid^="task-item-"]';
const indicatorSelector = '[data-testid="project-drop-indicator"]';

declare global {
  interface Window {
    __projectDeletionTrace?: { orders: string[][]; stop(): void };
  }
}

describe("虚拟项目旧产品体验", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const state = await browser.execute(() => ({
      body: document.body.innerText.slice(-3500),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((el) => el.textContent),
      projects: [...document.querySelectorAll("[data-project-id]")].map((el) => ({
        id: el.getAttribute("data-project-id"),
        text: el.textContent?.slice(0, 160),
      })),
      focused: document.activeElement?.outerHTML.slice(0, 300),
    }));
    await writeFile(
      join(
        process.env.ZCODE_E2E_ARTIFACT_DIR!,
        `project-behavior-${this.currentTest?.title.replace(/[^a-z0-9]+/gi, "-")}.json`,
      ),
      JSON.stringify(
        { state, navigation: await readNavigation().catch((error) => String(error)) },
        null,
        2,
      ),
    );
  });
  before(async function () {
    this.timeout(60_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const home = process.env.ZCODE_E2E_HOME_DIR;
    // 修复原因：转正后默认 formal 单跑使用 `.e2e-home`（无 runId 后缀），旧守卫只认
    // `.e2e-home-`，会让正式用例在隔离 HOME 下误报。两种目录名都只存在于 E2E runner。
    if (!home || !/^(?:zcode-project-behavior-e2e-|\.e2e-home(?:-|$))/u.test(basename(home)))
      throw new Error("isolated project behavior E2E HOME required");
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "project-behavior");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "E2E_TASK_FILES.txt"), "project root file");
    const taskRoot = join(root, "task-cwd");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "E2E_PINNED_TASK_FILES.txt"), "task cwd file");
    // 运行中写库不发布 Host 快照；非法 meta 还会让归档/置顶命令读不到任务。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        try {
          // 纯列表 fixture：只在隔离库准备已持久化的历史镜像，不声称覆盖模型/CLI 执行。
          db.prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,'local',?,0,1,1)",
          ).run(projectId, name);
          db.prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
          ).run(projectId, root);
          for (const [id, label, position] of [
            ["e2e-empty-a", "E2E_EMPTY_A", 1],
            ["e2e-empty-b", "E2E_EMPTY_B", 2],
          ] as const) {
            db.prepare(
              "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,'local',?,?,1,1)",
            ).run(id, label, position);
          }
          const insert = db.prepare(
            "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,pinned,unread_at,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?, 'glm',1,1,'local',?,?,?,?,?,'custom',?,?,'completed',0,?)",
          );
          const baselineTime = Date.now() - 100_000;
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setHours(12, 0, 0, 0);
          for (let i = 0; i < 30; i++) {
            const title = `E2E_BEHAVIOR_${String(i).padStart(2, "0")}`;
            const taskPath = i === 7 ? taskRoot : root;
            insert.run(
              taskPath,
              taskPath,
              `e2e-behavior-${i}`,
              title,
              taskPath,
              projectId,
              i >= 7 ? 1 : 0,
              i === 29 ? 10 : null,
              title,
              baselineTime + i + 1,
              i < 18 ? baselineTime + 100 - i : yesterday.getTime() - i,
              JSON.stringify({
                taskId: `e2e-behavior-${i}`,
                traceId: `e2e-behavior-${i}`,
                title,
                workspacePath: taskPath,
                createdAt: baselineTime + i + 1,
                updatedAt: i < 18 ? baselineTime + 100 - i : yesterday.getTime() - i,
                mode: "build",
                provider: "glm",
                status: "completed",
              }),
            );
          }
        } finally {
          db.close();
        }
      },
    });
    await $(rowSelector).waitForDisplayed({ timeout: 45_000 });
  });

  it("D3：快捷键菜单命令和左上角继承项目，任务分区显式未归类", async () => {
    const project = $(rowSelector);
    await project.$('[data-testid="virtual-project-create-task"]').click();
    await browser.waitUntil(async () => (await readNavigation()).project === projectId);
    const target = await readNavigation();
    await invokeNewTaskMenuShortcut();
    await browser.waitUntil(async () => {
      const state = await readNavigation();
      return state.project === projectId && state.task === null && state.focus > target.focus;
    });
    expect((await readNavigation()).path).toBe(target.path);
    const afterShortcut = await readNavigation();
    await $('[data-testid="task-new-button"]').click();
    await browser.waitUntil(async () => (await readNavigation()).focus > afterShortcut.focus);
    expect((await readNavigation()).project).toBe(projectId);
    expect((await readNavigation()).path).toBe(target.path);
    await $('[data-testid="virtual-project-new-task"]').click();
    await browser.waitUntil(async () => {
      const state = await readNavigation();
      return state.project === null && state.path !== target.path;
    });
    const unclassified = await readNavigation();
    await invokeNewTaskMenuShortcut();
    // 新草稿生命周期在首发接纳前复用未归类目录；重复新建只重新聚焦该草稿。
    await browser.waitUntil(async () => (await readNavigation()).focus > unclassified.focus);
    expect((await readNavigation()).path).toBe(unclassified.path);
    expect((await readNavigation()).project).toBeNull();
    expect((await readNavigation()).task).toBeNull();
  });

  it("VP24/31：全部项目收起展开不导航，刷新保持且新建按钮右侧对齐", async () => {
    const before = await readNavigation();
    const toggle = $('[data-testid="virtual-project-toggle-all"]');
    await toggle.click();
    const states = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="virtual-project-toggle"]')].map((node) =>
          node.getAttribute("aria-expanded"),
        ),
      );
    await browser.waitUntil(async () => (await states()).every((value) => value === "false"));
    expect(await readNavigation()).toEqual(before);
    await refreshProjectSidebar();
    await $(rowSelector).waitForDisplayed({ timeout: 45_000 });
    expect((await states()).every((value) => value === "false")).toBe(true);
    await $('[data-testid="virtual-project-toggle-all"]').click();
    await browser.waitUntil(async () => (await states()).every((value) => value === "true"));
    await captureLayouts(
      async () => {
        await browser.execute(() => {
          document.querySelector('[data-testid="project-section"]')!.scrollIntoView({
            block: "start",
            behavior: "instant",
          });
        });
        await $('[data-testid="project-section"] [data-testid="virtual-project-row"]').moveTo();
        await browser.execute(async () => {
          await Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => {})),
          );
        });
        const edges = await browser.execute(() => {
          const right = (id: string) =>
            document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().right;
          return {
            project: right("virtual-project-add"),
            task: right("virtual-project-new-task"),
            session: right("virtual-project-create-task"),
          };
        });
        expect(Math.abs(edges.project - edges.session)).toBeLessThanOrEqual(1);
        expect(Math.abs(edges.task - edges.session)).toBeLessThanOrEqual(1);
      },
      "sidebar-actions",
      false,
    );
  });

  for (const entry of ["menu", "editor"] as const) {
    it(`VP31：删除项目保持原位直到消失（${entry}）`, async () => {
      const targetId = "e2e-empty-a";
      const target = $(`[data-project-id="${targetId}"]`);
      const preferences = await browser.execute(() =>
        localStorage.getItem("zcode-project-sidebar-preferences"),
      );
      const activeWorkspace = (await readNavigation()).path;
      if (!activeWorkspace) throw new Error("缺少活动 workspace");
      try {
        await browser.electron.execute((electron) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.focus();
        });
        await browser.execute((id) => {
          document
            .querySelector(`[data-project-id="${id}"]`)!
            .scrollIntoView({ block: "center", behavior: "instant" });
          const orders: string[][] = [];
          const sample = () => {
            const order = [
              ...document.querySelectorAll(
                'aside [data-testid="project-section"] [data-project-id]',
              ),
            ].map((node) => node.getAttribute("data-project-id")!);
            if (JSON.stringify(order) !== JSON.stringify(orders.at(-1))) orders.push(order);
          };
          sample();
          const observer = new MutationObserver(sample);
          observer.observe(document.querySelector("aside")!, { childList: true, subtree: true });
          window.__projectDeletionTrace = { orders, stop: () => observer.disconnect() };
        }, targetId);
        await target.$('[data-testid="virtual-project-row"]').click({ button: "right" });
        if (entry === "editor") {
          await $('[data-testid="virtual-project-edit"]').click();
          await $('[data-testid="virtual-project-editor-delete"]').click();
        } else {
          await $('[data-testid="virtual-project-delete"]').click();
        }
        await target.waitForExist({ reverse: true });
        const orders = await browser.execute(() => {
          window.__projectDeletionTrace!.stop();
          return window.__projectDeletionTrace!.orders;
        });
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `project-deletion-${entry}.json`),
          JSON.stringify(orders, null, 2),
        );
        const before = orders[0]!;
        expect(before.indexOf(targetId)).toBeGreaterThan(0);
        expect(before.indexOf(targetId)).toBeLessThan(before.length - 1);
        expect(orders).toEqual([before, before.filter((id) => id !== targetId)]);
        await refreshProjectSidebar();
        await $(rowSelector).waitForDisplayed({ timeout: 45_000 });
        expect(await target.isExisting()).toBe(false);
      } finally {
        await browser.execute(() => window.__projectDeletionTrace?.stop());
        await browser.execute((saved) => {
          if (saved) localStorage.setItem("zcode-project-sidebar-preferences", saved);
          else localStorage.removeItem("zcode-project-sidebar-preferences");
        }, preferences);
        // 运行中的 Host 不发布直写库事件；等旧进程退出后恢复隔离项目，避免后项仍读删除态。
        await restartIntoWorkspacePreservingProfile(activeWorkspace, {
          afterElectronProcessExit: () => {
            const db = new DatabaseSync(
              join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
            );
            try {
              db.prepare("UPDATE projects SET deleted=0 WHERE project_id=?").run(targetId);
            } finally {
              db.close();
            }
          },
        });
        await $(rowSelector).waitForDisplayed({ timeout: 45_000 });
        await target.waitForDisplayed();
      }
    });
  }

  it("VP31：任务分区会话与项目内会话左侧留白一致", async () => {
    const setFixtureProject = async (id: string | null) => {
      // 前面的导航用例已切换到新目录；重启只恢复活动目录，不能等待无关的默认 workspace。
      const activeWorkspace = (await readNavigation()).path;
      if (!activeWorkspace) throw new Error("缺少活动 workspace");
      await restartIntoWorkspacePreservingProfile(activeWorkspace, {
        afterElectronProcessExit: () => {
          const db = new DatabaseSync(
            join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
          );
          try {
            db.prepare("UPDATE tasks SET project_id=? WHERE task_id='e2e-behavior-6'").run(id);
          } finally {
            db.close();
          }
        },
      });
    };
    const task = $('[data-testid="conversation-section"] [data-testid="task-item-e2e-behavior-6"]');
    const layouts: {
      width: number;
      theme: string;
      rowX: number;
      projectX: number;
      textX: number;
      projectTextX: number;
    }[] = [];
    try {
      // 热写 SQLite 不会发布 Host 快照；离线准备同一条历史后冷恢复，保留其他项目内任务用于比较。
      await setFixtureProject(null);
      await task.waitForExist({ timeout: 45_000 });
      await browser.electron.execute((electron) => {
        const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible());
        window?.focus();
      });
      await captureLayouts(
        async () => {
          await browser.waitUntil(() =>
            browser.execute(() => {
              const panel = document.querySelector("[data-workspace-sidebar-panel]")!;
              const style = getComputedStyle(panel);
              const target = Math.min(
                parseFloat(style.getPropertyValue("--workspace-sidebar-panel-width")),
                innerWidth / 2,
              );
              return (
                style.opacity === "1" && Math.abs(panel.getBoundingClientRect().width - target) < 1
              );
            }),
          );
          // 只滚动到可见位置，避免 WebDriver 的横向居中滚动改变内缩测量。
          await browser.execute(async () => {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await Promise.all(
              document
                .getAnimations()
                .filter(
                  (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
                )
                .map((animation) => animation.finished.catch(() => {})),
            );
            document
              .querySelector('[data-testid="task-item-e2e-behavior-6"]')!
              .scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
          });
          await task.moveTo();
          layouts.push(
            await browser.execute((projectSelector) => {
              const row = document.querySelector(
                '[data-testid="conversation-section"] [data-task-item-key]',
              )!;
              const projectRow = document.querySelector(`${projectSelector} [data-task-item-key]`)!;
              const sidebarX = document.querySelector("aside")!.getBoundingClientRect().x;
              const textX = (node: Element) =>
                node.querySelector('[data-task-title-copy="original"]')!.getBoundingClientRect().x -
                sidebarX;
              return {
                width: innerWidth,
                theme: document.documentElement.className,
                rowX: row.getBoundingClientRect().x - sidebarX,
                projectX: projectRow.getBoundingClientRect().x - sidebarX,
                textX: textX(row),
                projectTextX: textX(projectRow),
              };
            }, rowSelector),
          );
        },
        "task-section-inset",
        false,
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "task-section-inset.json"),
        JSON.stringify(layouts, null, 2),
      );
      for (const layout of layouts) {
        expect(layout.rowX).toBeCloseTo(8, 0);
        expect(layout.rowX).toBeCloseTo(layout.projectX, 0);
        expect(layout.textX).toBeCloseTo(layout.projectTextX, 0);
      }
    } finally {
      await setFixtureProject(projectId);
      await $(rowSelector).waitForDisplayed({ timeout: 45_000 });
    }
  });

  it("VP31：标题和置顶缩进、空态、排序动画及取消/刷新", async () => {
    const geometry = await browser.execute(() => {
      const pinned = document.querySelector('[data-testid="project-pinned-tasks"]')!;
      const title = pinned.firstElementChild!;
      const section = document.querySelector(
        '[data-testid="project-section"] button[data-slot="collapsible-trigger"] span',
      )!;
      const tasksTitle = document.querySelector(
        '[data-testid="conversation-section"] button[data-slot="collapsible-trigger"] span',
      )!;
      const text = pinned.querySelector('[data-task-title-copy="original"]')!;
      const sidebar = document.querySelector("aside")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(title);
      return {
        font: getComputedStyle(title).fontSize,
        sectionFont: getComputedStyle(section).fontSize,
        weight: getComputedStyle(title).fontWeight,
        titleX: range.getBoundingClientRect().x - sidebar.x,
        sectionX: section.getBoundingClientRect().x - sidebar.x,
        tasksX: tasksTitle.getBoundingClientRect().x - sidebar.x,
        taskX: text.getBoundingClientRect().x - sidebar.x,
      };
    });
    expect(geometry.font).toBe(geometry.sectionFont);
    expect(geometry.weight).toBe("500");
    expect(geometry.titleX).toBeCloseTo(18, 0);
    expect(geometry.sectionX).toBeCloseTo(geometry.titleX, 0);
    expect(geometry.tasksX).toBeCloseTo(geometry.titleX, 0);
    expect(geometry.taskX).toBeGreaterThanOrEqual(42);
    const a = $('[data-project-id="e2e-empty-a"]');
    const b = $('[data-project-id="e2e-empty-b"]');
    expect(await a.getText()).toMatch(/暂无任务|No tasks yet/);
    expect(await $('[data-testid="conversation-section"]').getText()).toMatch(
      /暂无任务|No tasks yet/,
    );
    // 先收起以在同屏采样真实指针拖动，避免展开高度改变命中位置。
    for (const node of [$(rowSelector), a, b])
      await node.$('[data-testid="virtual-project-toggle"]').click();
    await a.scrollIntoView({ block: "center" });
    const order = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-id]')].map(
          (e) => e.getAttribute("data-project-id"),
        ),
      );
    const before = await order();
    expect(await $(indicatorSelector).isExisting()).toBe(false);
    await a.$('[data-testid="virtual-project-toggle"]').click();
    await browser.keys("Space");
    await browser.keys("ArrowDown");
    await browser.keys("Escape");
    expect(await $(indicatorSelector).isExisting()).toBe(false);
    expect(await order()).toEqual(before);
    await a.$('[data-testid="virtual-project-toggle"]').click();
    // 折叠动画结束后才量拖拽坐标，不把前一段高度变化算进排序位移。
    await browser.execute(async () => {
      await Promise.all(
        [...document.querySelectorAll('[data-testid="virtual-project-tasks"]')]
          .flatMap((e) => e.getAnimations({ subtree: true }))
          .map((a) => a.finished.catch(() => {})),
      );
    });
    const coords = await browser.execute(() => {
      const rect = (id: string) =>
        document
          .querySelector(`[data-project-id="${id}"] [data-testid="virtual-project-toggle"]`)!
          .getBoundingClientRect();
      const a = rect("e2e-empty-a"),
        b = rect("e2e-empty-b");
      return {
        x: Math.round(a.x + 40),
        ay: Math.round(a.y + a.height / 2),
        by: Math.round(b.y + b.height / 2),
      };
    });
    await browser.performActions([
      {
        type: "pointer",
        id: "project-mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: coords.x, y: coords.ay },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: coords.x, y: coords.ay + 8 },
          { type: "pointerMove", duration: 200, x: coords.x, y: coords.by },
        ],
      },
    ]);
    await browser.waitUntil(() =>
      browser.execute(() => {
        const node = document.querySelector('[data-project-id="e2e-empty-b"]')!;
        const transform = getComputedStyle(node).transform;
        return transform !== "none" && Math.abs(new DOMMatrix(transform).m42) > 1;
      }),
    );
    const motion = await browser.execute(() =>
      [...document.querySelectorAll("[data-project-id]")].map((e) => ({
        id: e.getAttribute("data-project-id"),
        transform: getComputedStyle(e).transform,
        transition: getComputedStyle(e).transitionDuration,
        y:
          getComputedStyle(e).transform === "none"
            ? 0
            : new DOMMatrix(getComputedStyle(e).transform).m42,
      })),
    );
    expect(motion.some((e) => e.id === "e2e-empty-a" && e.transform !== "none")).toBe(true);
    expect(
      motion.some((e) => e.id === "e2e-empty-b" && Math.abs(e.y) > 1 && e.transition !== "0s"),
    ).toBe(true);
    await assertDropIndicator("e2e-empty-b", "after");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-insertion-pointer.png"),
    );
    await browser.performActions([
      {
        type: "pointer",
        id: "project-mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerUp", button: 0 }],
      },
    ]);
    await browser.releaseActions();
    expect(await $(indicatorSelector).isExisting()).toBe(false);
    await browser.waitUntil(
      async () => (await order()).indexOf("e2e-empty-a") > (await order()).indexOf("e2e-empty-b"),
    );
    const pointerOrder = await order();
    // 键盘复用同一排序通路，将 A 移回 B 上方，并验证持久化。
    await browser.execute(() =>
      document
        .querySelector<HTMLElement>(
          '[data-project-id="e2e-empty-a"] [data-testid="virtual-project-toggle"]',
        )!
        .focus(),
    );
    await browser.keys("Space");
    await browser.keys("ArrowUp");
    await assertDropIndicator("e2e-empty-b", "before");
    await browser.keys("Space");
    expect(await $(indicatorSelector).isExisting()).toBe(false);
    await browser.waitUntil(
      async () => (await order()).indexOf("e2e-empty-a") < (await order()).indexOf("e2e-empty-b"),
    );
    const after = await order();
    expect(after).toEqual(before);
    await refreshProjectSidebar();
    await a.waitForExist({ timeout: 45_000 });
    expect(await order()).toEqual(after);
    await $(rowSelector).$('[data-testid="virtual-project-toggle"]').click();
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-regression.json"),
      JSON.stringify({ geometry, motion, before, pointerOrder, after }, null, 2),
    );
  });

  it("VP31：插入线在明暗主题和窄屏可见，取消后清除", async () => {
    const projectToggle = $(rowSelector).$('[data-testid="virtual-project-toggle"]');
    // 主题截图只验证落点样式；收起历史项目，让相邻目标不受长列表滚动影响。
    await projectToggle.click();
    try {
      await captureLayouts(async () => {
        // 指针拖拽已由上一用例覆盖；主题/视口截图用键盘固定目标，避免缩放后的坐标漂移。
        await browser.execute(async () => {
          await Promise.all(
            [...document.querySelectorAll("[data-workspace-sidebar-panel], [data-project-id]")]
              .flatMap((node) => node.getAnimations({ subtree: true }))
              .map((animation) => animation.finished.catch(() => {})),
          );
          const toggle = document.querySelector<HTMLElement>(
            '[data-project-id="e2e-empty-b"] [data-testid="virtual-project-toggle"]',
          )!;
          toggle.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          toggle.focus();
        });
        expect(await $(indicatorSelector).isExisting()).toBe(false);
        await browser.keys("Space");
        await browser.keys("ArrowUp");
        await assertDropIndicator("e2e-empty-a", "before");
      });
    } finally {
      await projectToggle.click();
    }
    expect(await $(indicatorSelector).isExisting()).toBe(false);
  });

  it("VP23/SBV04：项目 5/+5，置顶 20/全部/更少，旧排序偏好不生效", async () => {
    const project = $(rowSelector);
    expect(await project.$$(taskSelector).length).toBe(5);
    await project.$('[data-task-list-show-more="true"]').click();
    expect(await project.$$(taskSelector).length).toBe(7);
    const pinned = $('[data-testid="project-pinned-tasks"]');
    expect(await pinned.getText()).toMatch(/已置顶|Pinned/);
    expect(await pinned.$$(taskSelector).length).toBe(20);
    await pinned.$('[data-task-list-show-more="true"]').click();
    expect(await pinned.$$(taskSelector).length).toBe(23);
    await pinned.$('[data-task-list-show-more="true"]').click();
    expect(await pinned.$$(taskSelector).length).toBe(20);
    await $('[data-testid="project-section"] button[data-slot="collapsible-trigger"]').click({
      button: "right",
    });
    expect(await $('[data-testid="project-task-sort-created"]').isExisting()).toBe(false);
    await browser.keys("Escape");
    await browser.execute(() => {
      localStorage.setItem("zcode-sidebar-task-preferences", JSON.stringify({ sortBy: "created" }));
      const key = "zcode-project-sidebar-preferences";
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), sort: "updated" }),
      );
    });
    await refreshProjectSidebar();
    await project.waitForDisplayed({ timeout: 45_000 });
    expect(await project.$(taskSelector).getText()).toContain("E2E_BEHAVIOR_00");
  });

  it("SBV01/02/03/05：搜索、最近更新混排及分页，切换保留导航与折叠", async () => {
    const before = await readNavigation();
    const toggle = $(rowSelector).$('[data-testid="virtual-project-toggle"]');
    await toggle.click();
    const search = $('[data-testid="sidebar-search-open"]');
    await search.click();
    await $('[role="dialog"] [cmdk-input]').waitForDisplayed();
    await browser.keys("Escape");
    const apple = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.platform));
    // 搜索入口已改为图标按钮，平台键帽由共享 tooltip 展示。
    await $('[role="dialog"]').waitForExist({ reverse: true });
    await $("main").moveTo();
    await search.moveTo();
    const tooltip = $('[data-slot="tooltip-content"]');
    await tooltip.waitForDisplayed();
    expect(await tooltip.getText()).toContain(apple ? "⌘ K" : "Ctrl+K");
    await browser.keys([apple ? "Meta" : "Control", "k"]);
    await $('[role="dialog"] [cmdk-input]').waitForDisplayed();
    await browser.keys("Escape");
    await $('[data-testid="sidebar-view-menu"]').click();
    // 视图单选包含未读，图标和勾选沿用同一菜单。
    expect(
      await $$('[role="menuitemradio"]').map((item) => item.getAttribute("data-testid")),
    ).toEqual([
      "sidebar-view-projects",
      "sidebar-view-grouped",
      "sidebar-view-timeline",
      "sidebar-view-unread",
    ]);
    expect(await $('[data-testid="sidebar-view-projects"] svg.lucide-folder').isDisplayed()).toBe(
      true,
    );
    expect(await $('[data-testid="sidebar-view-timeline"] svg.lucide-clock').isDisplayed()).toBe(
      true,
    );
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-view-icons.png"),
    );
    await $('[data-testid="sidebar-view-timeline"]').click();
    const timeline = $('[data-testid="project-timeline-tasks"]');
    await timeline.waitForDisplayed();
    expect(await $('[data-testid="project-pinned-tasks"]').isExisting()).toBe(false);
    expect(await $('[data-testid="project-section"]').isExisting()).toBe(false);
    expect(await timeline.$$(taskSelector).length).toBe(20);
    expect(await timeline.$(taskSelector).getText()).toContain("E2E_BEHAVIOR_00");
    const dateHeadings = await timeline
      .$$("[data-timeline-date-heading]")
      .map((row) => row.getText());
    expect(dateHeadings).toHaveLength(2);
    expect(dateHeadings[0]).toMatch(/^(Today|今天)$/);
    expect(dateHeadings[1]).toMatch(/^(Yesterday|昨天)$/);
    expect(await timeline.$("[data-task-workspace-label]").getText()).toBe("project-behavior");
    expect(await timeline.$('[data-idle-indicator="true"]').isExisting()).toBe(false);
    const rowLayout = await browser.execute(() => {
      const row = document.querySelector(
        '[data-testid="project-timeline-tasks"] [data-task-item-key]',
      )!;
      const title = row.querySelector('[data-task-title-copy="original"]')!.getBoundingClientRect();
      const label = row.querySelector("[data-task-workspace-label]")!.getBoundingClientRect();
      const time = row.querySelector("[data-task-row-metadata]")!.getBoundingClientRect();
      return { below: label.top >= title.bottom, aligned: Math.abs(label.top - time.top) < 3 };
    });
    expect(rowLayout).toEqual({ below: true, aligned: true });
    await timeline.$('[data-task-list-show-more="true"]').click();
    expect(await timeline.$$(taskSelector).length).toBe(30);
    expect(
      await timeline
        .$('[data-testid="task-item-e2e-behavior-29"] [data-unread-indicator="true"]')
        .isExisting(),
    ).toBe(true);
    expect(await timeline.$$("[data-timeline-date-heading]").length).toBe(2);
    const db = new DatabaseSync(
      join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
    );
    let expected: string[];
    try {
      expected = db
        .prepare(
          // Host 会先留下未物化草稿行；列表只展示有 CLI 历史且未删除的任务。
          "SELECT task_id FROM tasks WHERE project_id=? AND archived=0 AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,cli_created_at DESC,task_id DESC",
        )
        .all(projectId)
        .map((row) => String(row.task_id));
    } finally {
      db.close();
    }
    const actual = await timeline.$$(taskSelector).map((row) => row.getAttribute("data-testid"));
    expect(actual).toEqual(expected.map((id) => `task-item-${id}`));
    expect(new Set(actual).size).toBe(30);
    // 最近更新中的置顶只改变组织态；不从时间序列搬走。
    const pinned = $('[data-testid="task-item-e2e-behavior-7"]');
    await pinned.moveTo();
    await pinned.$('button[aria-label="取消置顶任务"], button[aria-label="Unpin task"]').click();
    await pinned.$('button[aria-label="置顶任务"], button[aria-label="Pin task"]').waitForExist();
    expect(await timeline.$$(taskSelector).map((row) => row.getAttribute("data-testid"))).toEqual(
      actual,
    );
    await pinned.$('button[aria-label="置顶任务"], button[aria-label="Pin task"]').click();
    await pinned
      .$('button[aria-label="取消置顶任务"], button[aria-label="Unpin task"]')
      .waitForExist();
    const archived = $('[data-testid="task-item-e2e-behavior-6"]');
    await archived.moveTo();
    await archived.$('button[data-testid^="task-archive-"]').click();
    await $('[data-archive-confirming-task-id="e2e-behavior-6"]').waitForExist();
    await archived.$('button[data-testid^="task-archive-"]').click();
    await archived.waitForExist({ reverse: true });
    expect(await timeline.$$(taskSelector).length).toBe(29);
    expect(await readNavigation()).toEqual(before);
    await refreshProjectSidebar('[data-testid="project-timeline-tasks"]');
    await timeline.waitForDisplayed({ timeout: 45_000 });
    expect(await timeline.$$(taskSelector).length).toBe(20);
    expect(await $('[data-testid="task-item-e2e-behavior-6"]').isExisting()).toBe(false);
    expect(await readNavigation()).toEqual(before);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-view.json"),
      JSON.stringify({ before, expected, actual }, null, 2),
    );
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-recent.png"));
    await captureLayouts(undefined, "sidebar-recent");
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-projects"]').click();
    await $(rowSelector).waitForDisplayed();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    expect(await $(rowSelector).$("[data-task-workspace-label]").isExisting()).toBe(false);
  });

  it("SBV07：按未读分页、重载、已读移除与空态，切换不改变导航", async () => {
    const before = await readNavigation();
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "project-behavior");
    const setUnread = (index: number, unread: boolean) =>
      callHandoffHost(ServiceChannels.WindowController, "mutateTask", [
        {
          address: {
            workspacePath: index === 7 ? join(root, "task-cwd") : root,
            taskId: `e2e-behavior-${index}`,
          },
          mutation: { kind: unread ? "mark-unread" : "mark-read" },
        },
      ]);
    await installHandoffRpcProbe();
    try {
      // 使用真实 Host 命令产生未读及失效事件，不修改 UI 投影。
      for (let index = 7; index < 30; index++) await setUnread(index, true);
      await $('[data-testid="sidebar-view-menu"]').click();
      const option = $('[data-testid="sidebar-view-unread"]');
      expect(await option.$("svg.lucide-bell").isDisplayed()).toBe(true);
      await option.click();
      const unread = $('[data-testid="project-unread-tasks"]');
      await unread.waitForDisplayed();
      expect(await unread.$$(taskSelector).length).toBe(20);
      expect(await unread.$(taskSelector).getText()).toContain("E2E_BEHAVIOR_07");
      expect(await $('[data-testid="project-pinned-tasks"]').isExisting()).toBe(false);
      await unread.$('[data-task-list-show-more="true"]').click();
      expect(await unread.$$(taskSelector).map((row) => row.getAttribute("data-testid"))).toEqual(
        Array.from({ length: 23 }, (_, index) => `task-item-e2e-behavior-${index + 7}`),
      );
      expect(await readNavigation()).toEqual(before);
      await captureLayouts(async () => {
        await unread.waitForDisplayed();
      }, "sidebar-unread");
      await refreshProjectSidebar('[data-testid="project-unread-tasks"]');
      expect(await unread.$$(taskSelector).length).toBe(20);
      await $('[data-testid="sidebar-view-menu"]').click();
      expect(await option.getAttribute("aria-checked")).toBe("true");
      await browser.keys("Escape");
      await installHandoffRpcProbe();
      for (let index = 7; index < 30; index++) await setUnread(index, false);
      await $('[data-testid="project-no-tasks"]').waitForDisplayed();
      expect(await $('[data-testid="project-no-tasks"]').getText()).toMatch(
        /暂无未读任务|No unread tasks/,
      );
      expect(await unread.isExisting()).toBe(false);
      expect(await readNavigation()).toEqual(before);
    } finally {
      await setUnread(29, true);
      await restoreHandoffProbes();
      await $('[data-testid="sidebar-view-menu"]').click();
      await $('[data-testid="sidebar-view-projects"]').click();
    }
  });

  it("VP24：收起项目显示置顶成员未读，刷新记住折叠，展开不切草稿", async () => {
    const project = $(rowSelector);
    const toggle = project.$('[data-testid="virtual-project-toggle"]');
    await toggle.click();
    await project.$('[data-testid="virtual-project-unread"]').waitForDisplayed();
    await refreshProjectSidebar();
    await project.waitForDisplayed({ timeout: 45_000 });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await project.$('[data-testid="virtual-project-unread"]').waitForDisplayed();
    const paneBefore = await readNavigation();
    await toggle.click();
    expect(await project.$('[data-testid="virtual-project-unread"]').isExisting()).toBe(false);
    expect(await readNavigation()).toEqual(paneBefore);
  });

  it("VP29：展开收起有高度和淡入淡出，快速反向点击不丢内容", async () => {
    const before = await readNavigation();
    const close = await sampleProjectMotion(false);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-collapse-close.json"),
      JSON.stringify(close, null, 2),
    );
    expect(close.some((frame) => frame.height > 1 && frame.height < close[0]!.height - 1)).toBe(
      true,
    );
    expect(close.some((frame) => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    expect(close.at(-1)!.height).toBe(0);
    const open = await sampleProjectMotion(false);
    const fullHeight = open.at(-1)!.height;
    expect(fullHeight).toBeGreaterThan(0);
    expect(open.some((frame) => frame.height > 1 && frame.height < fullHeight - 1)).toBe(true);
    expect(open.some((frame) => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    const reverse = await sampleProjectMotion(true);
    expect(reverse.at(-1)!.expanded).toBe("true");
    expect(reverse.at(-1)!.height).toBeGreaterThan(0);
    expect(await $(rowSelector).$$(taskSelector).length).toBe(5);
    expect(await readNavigation()).toEqual(before);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-collapse-motion.json"),
      JSON.stringify({ close, open, reverse }, null, 2),
    );
  });

  it("VP25/26/29：置顶任务恢复文件树，普通任务不显示；目录、置顶、窄屏与主题", async () => {
    const pinned = $('[data-testid="project-pinned-tasks"]');
    const first = pinned.$(taskSelector);
    await first.moveTo();
    const files = first.$('[data-testid="task-files-e2e-behavior-7"]');
    await files.waitForDisplayed();
    await files.click();
    // 文件入口已迁至右侧独立标签页；跨目录会导航 workspace，不能再查左栏“返回任务”。
    const fileTree = $(
      '[role="tabpanel"][data-state="active"] [data-file-manager-pane] [data-testid="workspace-file-tree-panel"]',
    );
    await fileTree.waitForDisplayed();
    await browser.waitUntil(async () =>
      (await fileTree.getText()).includes("E2E_PINNED_TASK_FILES.txt"),
    );
    expect(await fileTree.getText()).not.toContain("E2E_TASK_FILES.txt");
    expect((await readNavigation()).task).toBeNull();
    await $(rowSelector).waitForDisplayed();
    await closeActiveFileTab();
    const ordinary = $(rowSelector).$(taskSelector);
    await ordinary.moveTo();
    expect(await ordinary.$('[data-testid^="task-files-"]').isExisting()).toBe(false);
    expect(await ordinary.$('button[data-testid^="task-archive-"]').isExisting()).toBe(true);
    await $(rowSelector).moveTo();
    for (const action of ["menu", "files", "create-task"])
      expect(await $(rowSelector).$(`[data-testid="virtual-project-${action}"]`).isExisting()).toBe(
        true,
      );
    await $(rowSelector).$('[data-testid="virtual-project-files"]').click();
    await fileTree.waitForDisplayed();
    await browser.waitUntil(async () => (await fileTree.getText()).includes("E2E_TASK_FILES.txt"));
    expect((await readNavigation()).task).toBeNull();
    await closeActiveFileTab();
    // 更新时间倒序下首个置顶任务是 7；取消后仍在所属项目，可能位于第二页。
    expect(await first.getText()).toContain("E2E_BEHAVIOR_07");
    await first.moveTo();
    await first.$('button[aria-label="取消置顶任务"], button[aria-label="Unpin task"]').click();
    await $(rowSelector).$('[data-task-list-show-more="true"]').click();
    await $(rowSelector).$('[data-testid="task-item-e2e-behavior-7"]').waitForDisplayed();
    expect(await pinned.getText()).not.toContain("E2E_BEHAVIOR_07");
    await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).getAttribute("aria-pressed")) ===
        "true",
    );
    await $('[data-testid="plugin-store-sidebar-open"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="plugin-store-sidebar-open"]').getAttribute("aria-pressed")) ===
        "true",
    );
    expect(await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).getAttribute("aria-pressed")).toBe(
      "false",
    );
    await $(rowSelector).$('[data-testid="virtual-project-toggle"]').click();
    await $(rowSelector).$('[data-testid="virtual-project-unread"]').waitForDisplayed();
    await $(rowSelector).scrollIntoView({ block: "end" });
    await captureLayouts(
      async () => {
        const row = $('[data-testid="project-pinned-tasks"]').$(taskSelector);
        await row.scrollIntoView({ block: "center" });
        await row.moveTo();
        await row.$('[data-testid^="task-files-"]').waitForDisplayed();
      },
      "pinned-task-files",
      false,
    );
  });

  it("VP31：41 个项目拖拽启动保持响应，取消不改顺序", async () => {
    const home = process.env.ZCODE_E2E_HOME_DIR!;
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
    try {
      const insert = db.prepare(
        "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,'local',?,?,1,1)",
      );
      for (let i = 0; i < 38; i++) insert.run(`e2e-drag-scale-${i}`, `E2E_DRAG_SCALE_${i}`, i + 10);
    } finally {
      db.close();
    }
    await refreshProjectSidebar();
    await $('[data-project-id="e2e-drag-scale-37"]').waitForExist({ timeout: 45_000 });
    await browser.execute(async () => {
      for (const toggle of document.querySelectorAll<HTMLButtonElement>(
        '[data-project-id] [data-testid="virtual-project-toggle"][aria-expanded="true"]',
      ))
        toggle.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await Promise.all(
        [...document.querySelectorAll("[data-project-id]")]
          .flatMap((node) => node.getAnimations({ subtree: true }))
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const coords = await browser.execute(() => {
      const source = document.querySelector<HTMLElement>(
        '[data-project-id="e2e-empty-a"] [data-testid="virtual-project-toggle"]',
      )!;
      source.scrollIntoView({ block: "center", behavior: "instant" });
      const a = source.getBoundingClientRect();
      const b = document.querySelector('[data-project-id="e2e-empty-b"]')!.getBoundingClientRect();
      return {
        x: Math.round(a.x + 40),
        from: Math.round(a.y + a.height / 2),
        to: Math.round(b.y + b.height / 2),
        order: [
          ...document.querySelectorAll('[data-testid="project-section"] [data-project-id]'),
        ].map((node) => node.getAttribute("data-project-id")),
      };
    });
    expect(coords.order.length).toBeGreaterThanOrEqual(41);
    await browser.execute(() => {
      let previous = performance.now();
      let frame = 0;
      const gaps: number[] = [];
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ type: "longtask" });
      const tick = (now: number) => {
        gaps.push(now - previous);
        previous = now;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      (window as Window & { __finishProjectDragSample?: () => unknown }).__finishProjectDragSample =
        () => {
          cancelAnimationFrame(frame);
          longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
          observer.disconnect();
          return {
            gaps,
            longTasks,
            maxFrameGap: Math.max(0, ...gaps),
            maxLongTask: Math.max(0, ...longTasks),
          };
        };
    });
    try {
      await browser.performActions([
        {
          type: "pointer",
          id: "project-scale-mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, x: coords.x, y: coords.from },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 100, x: coords.x, y: coords.from + 8 },
            { type: "pointerMove", duration: 200, x: coords.x, y: coords.to },
          ],
        },
      ]);
      await assertDropIndicator("e2e-empty-b", "after");
      await browser.keys("Escape");
    } finally {
      await browser.releaseActions();
    }
    const sample = await browser.execute(() => {
      const bridge = window as Window & {
        __finishProjectDragSample?: () => {
          gaps: number[];
          longTasks: number[];
          maxFrameGap: number;
          maxLongTask: number;
        };
      };
      const sample = bridge.__finishProjectDragSample!();
      delete bridge.__finishProjectDragSample;
      return sample;
    });
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-drag-performance.json"),
      JSON.stringify({ projects: coords.order.length, ...sample }, null, 2),
    );
    expect(sample.gaps.length).toBeGreaterThan(5);
    expect(sample.maxFrameGap).toBeLessThan(100);
    expect(await $(indicatorSelector).isExisting()).toBe(false);
    expect(
      await browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-id]')].map(
          (node) => node.getAttribute("data-project-id"),
        ),
      ),
    ).toEqual(coords.order);
  });
});

async function sampleProjectMotion(reverse: boolean) {
  return browser.execute(
    async (selector, reverse) => {
      const project = document.querySelector(selector)!;
      const toggle = project.querySelector<HTMLButtonElement>(
        '[data-testid="virtual-project-toggle"]',
      )!;
      const frames: {
        height: number;
        opacity: number;
        expanded: string | null;
        animation: string;
      }[] = [];
      // 上一个用例刚展开列表；必须等真实动画结束，不能把上一段淡入当作收起证据。
      const previousContent = project.querySelector<HTMLElement>(
        '[data-testid="virtual-project-tasks"]',
      )!;
      await Promise.all(
        [
          ...previousContent.getAnimations(),
          ...(previousContent.firstElementChild?.getAnimations() ?? []),
        ].map((animation) => animation.finished.catch(() => {})),
      );
      const sample = () => {
        const content = project.querySelector<HTMLElement>('[data-testid="virtual-project-tasks"]');
        frames.push({
          height: content?.getBoundingClientRect().height ?? 0,
          opacity: content?.firstElementChild
            ? Number(getComputedStyle(content.firstElementChild).opacity)
            : 0,
          expanded: toggle.getAttribute("aria-expanded"),
          animation: content?.firstElementChild
            ? getComputedStyle(content.firstElementChild).animationName
            : "none",
        });
      };
      sample();
      toggle.click();
      const start = performance.now();
      let reversed = false;
      await new Promise<void>((resolve) => {
        const tick = (now: number) => {
          sample();
          if (reverse && !reversed && now - start >= 90) {
            toggle.click();
            reversed = true;
          }
          if (now - start < 600) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return frames;
    },
    rowSelector,
    reverse,
  );
}

async function readNavigation() {
  return browser.execute(() => {
    const bridge = window as Window & {
      __zcodeTabStoreE2E?: {
        getState(): { activeWorkspacePath: string | null; activeWorkspaceIdentity?: string | null };
      };
      __zcodeSessionStoreE2E?: {
        getState(): {
          getWorkspaceState(
            path: string,
            identity?: string,
          ): {
            activeTaskId: string | null;
            draftProjectId?: string | null;
            draftFocusVersion: number;
          };
        };
      };
    };
    const tabs = bridge.__zcodeTabStoreE2E?.getState();
    const sessions = bridge.__zcodeSessionStoreE2E?.getState();
    if (!tabs || !sessions || !tabs.activeWorkspacePath)
      throw new Error("missing E2E navigation bridge");
    const state = sessions.getWorkspaceState(
      tabs.activeWorkspacePath,
      tabs.activeWorkspaceIdentity ?? undefined,
    );
    return {
      path: tabs.activeWorkspacePath,
      identity: tabs.activeWorkspaceIdentity,
      task: state.activeTaskId,
      project: state.draftProjectId,
      focus: state.draftFocusVersion,
    };
  });
}

async function closeActiveFileTab() {
  const tab = $('[data-side-pane-tab-id][data-state="active"]');
  const id = await tab.getAttribute("data-side-pane-tab-id");
  await tab.$("button").click();
  await $(`[data-side-pane-tab-id="${id}"]`).waitForExist({ reverse: true });
}

async function assertDropIndicator(project: string, edge: "before" | "after") {
  await browser.execute(async () => {
    await Promise.all(
      [...document.querySelectorAll("[data-project-id]")]
        .flatMap((node) => node.getAnimations({ subtree: true }))
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await writeFile(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "insertion-diagnostics.json"),
    JSON.stringify(
      await browser.execute(() => ({
        width: innerWidth,
        theme: document.documentElement.className,
        focus: document.activeElement?.outerHTML,
        nodes: [...document.querySelectorAll("[data-project-id]")].map((node) => ({
          id: node.getAttribute("data-project-id"),
          rect: node.getBoundingClientRect().toJSON(),
          visible: node.checkVisibility(),
          style: node.getAttribute("style"),
        })),
        indicator: document.querySelector('[data-testid="project-drop-indicator"]')?.outerHTML,
      })),
      null,
      2,
    ),
  );
  await $(indicatorSelector).waitForDisplayed();
  expect(await $$(indicatorSelector).length).toBe(1);
  const appearance = await browser.execute((selector) => {
    const line = document.querySelector(selector)!;
    const node = line.closest("[data-project-id]")!;
    const rect = line.getBoundingClientRect();
    const target = node.getBoundingClientRect();
    const circle = line.firstElementChild!;
    return {
      project: node.getAttribute("data-project-id"),
      edge: line.getAttribute("data-drop-position"),
      height: rect.height,
      width: rect.width,
      within: rect.left >= target.left && rect.right <= target.right,
      edgeOffset: Math.min(
        Math.abs(rect.top + rect.height / 2 - target.top),
        Math.abs(rect.top + rect.height / 2 - target.bottom),
      ),
      color: getComputedStyle(line).backgroundColor,
      circleColor: getComputedStyle(circle).borderTopColor,
      circleSize: circle.getBoundingClientRect().width,
      pointerEvents: getComputedStyle(line).pointerEvents,
      hidden: line.getAttribute("aria-hidden"),
    };
  }, indicatorSelector);
  expect(appearance.project).toBe(project);
  expect(appearance.edge).toBe(edge);
  expect(appearance.height).toBe(2);
  expect(appearance.width).toBeGreaterThan(100);
  expect(appearance.within).toBe(true);
  expect(appearance.edgeOffset).toBeLessThanOrEqual(1);
  expect(appearance.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(appearance.color).toBe(appearance.circleColor);
  expect(appearance.circleSize).toBe(8);
  expect(appearance.pointerEvents).toBe("none");
  expect(appearance.hidden).toBe("true");
}

async function captureLayouts(
  beforeCapture?: () => Promise<void>,
  prefix?: string,
  clearDrag = true,
) {
  const sidebarWasOpen = (await $("aside").getAttribute("aria-hidden")) === "false";
  const original = await browser.execute(() => {
    const actions = (window as Window & { __testActions?: { getTheme(): string } }).__testActions;
    if (!actions) throw new Error("missing E2E theme bridge");
    return actions.getTheme();
  });
  const setTheme = async (theme: string) => {
    await browser.execute((value) => {
      const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
        .__testActions;
      if (!actions) throw new Error("missing E2E theme bridge");
      actions.setTheme(value);
    }, theme);
    await browser.waitUntil(() =>
      browser.execute(
        (value) => document.documentElement.classList.contains(`theme-${value}`),
        theme,
      ),
    );
  };
  const emulate = (width?: number) =>
    browser.electron.execute(async (electron, width) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (item) => !item.isDestroyed() && item.isVisible(),
      );
      if (!window) throw new Error("missing renderer");
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
        width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
      );
    }, width);
  try {
    for (const width of [1200, 390]) {
      await emulate(width);
      await browser.waitUntil(() => browser.execute((value) => innerWidth === value, width));
      if ((beforeCapture || prefix === "sidebar-recent") && width === 390) {
        // 只有聊天视图会在 resize 后自动收起侧栏；商店/定时任务页没有这条策略。
        // 聊天先等待真实收起结束，避免迟到的收起打断键盘拖拽。
        const isChat = await $('[data-testid="v4-composer-input"]').isDisplayed();
        if (isChat) {
          await browser.waitUntil(
            async () => (await $("aside").getAttribute("aria-hidden")) === "true",
          );
        }
        // 用真实按钮展开已收起的侧栏，再验证窄屏布局。
        if ((await $("aside").getAttribute("aria-hidden")) === "true") {
          await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
        }
        await browser.waitUntil(
          async () => (await $("aside").getAttribute("aria-hidden")) === "false",
        );
      }
      for (const theme of ["zai-light", "zai-dark"]) {
        await setTheme(theme);
        await beforeCapture?.();
        const bounds = await browser.execute(() => {
          const node = document.querySelector('[data-testid="sidebar"]');
          if (!node) throw new Error("missing sidebar");
          const rect = node.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            width: innerWidth,
            overflow: node.scrollWidth - node.clientWidth,
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width);
        expect(bounds.overflow).toBeLessThanOrEqual(1);
        const toolbar = await browser.execute(() => {
          const search = document.querySelector('[data-testid="sidebar-search-open"]')!;
          const filter = document.querySelector('[data-testid="sidebar-view-menu"]')!;
          const store = document.querySelector('[data-testid="plugin-store-sidebar-open"]')!;
          const a = search.getBoundingClientRect(),
            b = filter.getBoundingClientRect();
          return {
            height: a.height,
            filterHeight: b.height,
            radius: getComputedStyle(search).borderTopLeftRadius,
            background: getComputedStyle(search).backgroundColor,
            border: getComputedStyle(search).borderTopColor,
            belowStore: a.top >= store.getBoundingClientRect().bottom,
            inside: a.left >= 0 && b.right <= innerWidth,
          };
        });
        expect(toolbar.height).toBe(24);
        expect(toolbar.filterHeight).toBe(24);
        expect(toolbar.background).toBe("rgba(0, 0, 0, 0)");
        expect(toolbar.border).toBe("rgba(0, 0, 0, 0)");
        expect(toolbar.belowStore).toBe(true);
        expect(toolbar.inside).toBe(true);
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `${prefix ?? (beforeCapture ? "project-insertion" : "project-behavior")}-${width}-${theme}.png`,
          ),
        );
        // 留白验证没有拖拽；额外 Escape 会收起侧栏并污染下一组布局。
        if (beforeCapture && clearDrag) {
          await browser.keys("Escape");
          await browser.releaseActions();
          expect(await $(indicatorSelector).isExisting()).toBe(false);
        }
      }
    }
  } finally {
    // 循环已取消拖拽；多余 Escape 会关闭手机侧栏，导致后续合法元素不可交互。
    if (beforeCapture && clearDrag && (await $(indicatorSelector).isExisting())) {
      await browser.keys("Escape");
      await browser.releaseActions();
    }
    await emulate();
    await setTheme(original);
    if (sidebarWasOpen && (await $("aside").getAttribute("aria-hidden")) === "true") {
      await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
      await browser.waitUntil(
        async () => (await $("aside").getAttribute("aria-hidden")) === "false",
      );
    }
  }
}

async function invokeNewTaskMenuShortcut() {
  const url = await browser.getUrl();
  await browser.electron.execute((electron, targetUrl) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (item) => item.webContents.getURL() === targetUrl,
    );
    if (!window) throw new Error("missing E2E shortcut target");
    window.focus();
    const item = electron.Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((menu) => menu.accelerator === "CmdOrCtrl+N");
    if (!item) throw new Error("missing native new task accelerator");
    // WebDriver 的 DOM 按键不经过原生菜单；验证真实菜单绑定并执行其现有命令入口。
    item.click(undefined as never, window, undefined as never);
  }, url);
}

async function refreshProjectSidebar(expectedSelector = '[data-testid="project-section"]') {
  await browser.refresh();
  // API key 夹具的 renderer 登录态可能随刷新清空；先恢复登录，再验证原项目与排序。
  const login = $('[data-testid="login-use-api-key-button"]');
  // 时间线视图不渲染项目分区；等待调用方原视图，不能把正确恢复误判成加载失败。
  const projects = $(expectedSelector);
  await browser.waitUntil(
    async () => (await login.isDisplayed()) || (await projects.isDisplayed()),
    {
      timeout: 45_000,
    },
  );
  if (await login.isDisplayed()) await loginWithApiKey();
  await projects.waitForDisplayed({ timeout: 30_000 });
}
