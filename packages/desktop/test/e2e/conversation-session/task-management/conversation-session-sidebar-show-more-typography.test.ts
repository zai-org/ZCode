import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIsolatedE2EHomeDir } from "#e2e/helpers/e2e-runtime-paths";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const projectId = "E2E_SHOW_MORE";
const project = `[data-project-id="${projectId}"]`;
const more = `${project} [data-task-list-show-more]`;
const empty = `[data-project-id="${projectId}_EMPTY"] [data-testid="project-no-tasks"]`;
const title = `${project} [data-task-title-copy="original"]`;

// 合成 Host 索引仅用于样式和分页，不恢复任务或请求模型；node:sqlite 仅提供同步 API。
async function seedRows() {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  // 原因：runner 的隔离 HOME 可能是 .e2e-home、.e2e-home-<runId> 或显式根下的 shard 目录。
  if (!isIsolatedE2EHomeDir(home)) throw new Error("需要本 case 的隔离 HOME");
  const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "show-more");
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
  try {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    for (const [index, id] of [projectId, `${projectId}_EMPTY`].entries()) {
      db.prepare(
        "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,'local',?,?,?,?)",
      ).run(id, id, index - 2, now, now);
      db.prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
      ).run(id, root);
    }
    const insert = db.prepare(
      `INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at,provider,host_id,root_path,project_id,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,handoff_pending,meta_json)
       VALUES(?,?,?,?,?,?,'glm','local',?,?,?,'custom',?,?,'completed',0,8,?)`,
    );
    for (let index = 0; index < 6; index++) {
      const id = `${projectId}_${index}`;
      const text = `任务标题 ${index}`;
      insert.run(
        root,
        root,
        id,
        text,
        now,
        now,
        root,
        projectId,
        text,
        now,
        now,
        JSON.stringify({
          taskId: id,
          traceId: id,
          title: text,
          workspacePath: root,
          createdAt: now,
          updatedAt: now,
          mode: "build",
          status: "completed",
        }),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

async function sample() {
  return browser.execute(
    (more, empty, title) => {
      const button = document.querySelector<HTMLElement>(more)!;
      const style = getComputedStyle(button);
      const placeholder = getComputedStyle(document.querySelector(empty)!);
      const task = getComputedStyle(document.querySelector(title)!);
      return {
        fontSize: style.fontSize,
        color: style.color,
        background: style.backgroundColor,
        emptyFontSize: placeholder.fontSize,
        emptyColor: placeholder.color,
        titleFontSize: task.fontSize,
        titleColor: task.color,
        focusVisible: button.matches(":focus-visible"),
      };
    },
    more,
    empty,
    title,
  );
}

describe("侧栏显示更多文字", () => {
  it("VP-MORE-01：与标题/空态同字号、空态同色，hover/focus 提亮且分页可用", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    // 旧夹具未写 provider，被 readTree 的 glm 过滤排除；补齐元数据并在停机后播种。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: seedRows,
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    for (const id of [projectId, `${projectId}_EMPTY`]) {
      const trigger = $(`[data-project-id="${id}"] [data-testid="virtual-project-toggle"]`);
      await trigger.waitForDisplayed();
      if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
    }
    await $(more).waitForDisplayed();
    await $(empty).waitForDisplayed();
    expect(await $$(`${project} [data-task-item-key]`).length).toBe(5);
    const evidence = [];
    for (const width of [1200, 390]) {
      await browser.electron.execute(async (electron, width) => {
        const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())!;
        if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
        await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      if (width === 390) {
        await browser.waitUntil(
          async () => (await $("aside").getAttribute("aria-hidden")) === "true",
        );
        await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
      }
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute((value) => {
          (
            window as Window & { __testActions?: { setTheme(theme: string): void } }
          ).__testActions!.setTheme(value);
        }, theme);
        await browser.waitUntil(() =>
          browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            theme,
          ),
        );
        for (const fontSize of ["14px", "18px"]) {
          // 界面设置只改变此变量，不改变根字号；比较真实共享组件的 computed style。
          await browser.execute(
            (value) => document.documentElement.style.setProperty("--ui-font-size", value),
            fontSize,
          );
          await $(empty).moveTo();
          await browser.execute(() => (document.activeElement as HTMLElement)?.blur());
          await browser.waitUntil(async () => (await sample()).titleFontSize === fontSize);
          // 等待上一轮 hover/focus 的颜色过渡结束，避免把过渡帧当成默认颜色。
          await browser.waitUntil(() =>
            browser.execute(
              (selector) => document.querySelector(selector)!.getAnimations().length === 0,
              more,
            ),
          );
          const normal = await sample();
          evidence.push({ width, theme, fontSize, normal });
          await writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "show-more-styles.json"),
            JSON.stringify(evidence, null, 2),
          );
          await browser.saveScreenshot(
            join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              `show-more-${width}-${theme}-${fontSize}.png`,
            ),
          );
          expect(normal.fontSize).toBe(normal.titleFontSize);
          expect(normal.fontSize).toBe(normal.emptyFontSize);
          expect(normal.color).toBe(normal.emptyColor);
          expect(normal.background).toBe("rgba(0, 0, 0, 0)");
          await $(more).moveTo();
          await browser.waitUntil(async () => (await sample()).color === normal.titleColor);
          await $(empty).moveTo();
          await browser.keys("Tab");
          await browser.execute(
            (selector) => document.querySelector<HTMLElement>(selector)!.focus(),
            more,
          );
          await browser.waitUntil(async () => {
            const focused = await sample();
            return focused.focusVisible && focused.color === normal.titleColor;
          });
        }
      }
    }
    await $(more).click();
    await browser.waitUntil(async () => (await $$(`${project} [data-task-item-key]`).length) === 6);
    expect(await $(more).isExisting()).toBe(false);
  });
});
