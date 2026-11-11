import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const projectId = "E2E_SIDEBAR_WIDTH";
const projectSelector = `[data-project-id="${projectId}"]`;
const moreSelector = './/button[normalize-space(.)="显示更多" or normalize-space(.)="Show more"]';

// 合成索引仅准备分页/长标题布局，不恢复这些任务，也不请求模型。
async function seedTaskRows() {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  // 原因：批量 runner 使用 runId 隔离 HOME，不能要求旧手工执行的固定目录名。
  if (!home || !/^(?:zcode-sidebar-width-|\.e2e-home-)/u.test(basename(home)))
    throw new Error("隔离 HOME required");
  const root = join(home, "E2E_SIDEBAR_WIDTH_ROOT");
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
  try {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES(?,'local',?,-1,?,?)",
    ).run(projectId, projectId, now, now);
    db.prepare(
      "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
    ).run(projectId, root);
    const insert =
      db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at,provider,host_id,root_path,project_id,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,handoff_pending)
      VALUES(?,?,?,?,?,?,'glm','local',?,?,?,'custom',?,?,'completed',0,8)`);
    for (const group of [projectId, null]) {
      for (let index = 0; index < 25; index++) {
        const id = `E2E_WIDTH_${group ?? "TASKS"}_${index}`;
        const title =
          index % 3 === 0 ? `E2E_LONG_${"W".repeat(55)}_${index}` : `E2E_SHORT_${index}`;
        insert.run(root, root, id, title, now, now, root, group, title, now, now);
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

async function sampleWidths() {
  return browser.executeAsync(
    (
      done: (value: Array<{ grid: number; section: number; width: number; left: number }>) => void,
    ) => {
      const samples: Array<{ grid: number; section: number; width: number; left: number }> = [];
      const start = performance.now();
      const tick = () => {
        const grid = document.querySelector('[data-purpose-section-list="true"]')!;
        for (const button of Array.from(grid.querySelectorAll("button")).filter((node) =>
          /^(显示更多|Show more)$/.test(node.textContent?.trim() ?? ""),
        )) {
          const rect = button.getBoundingClientRect();
          samples.push({
            grid: grid.getBoundingClientRect().width,
            section: button
              .closest('[data-testid="project-section"], [data-testid="conversation-section"]')!
              .getBoundingClientRect().width,
            width: rect.width,
            left: rect.left,
          });
        }
        if (performance.now() - start >= 1200) done(samples);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  );
}

describe("项目侧栏长标题宽度", () => {
  it("VP-WIDTH-01：静止时分区/显示更多不跳动，缩进稳定且分页正常", async function () {
    this.timeout(90_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    // 旧夹具缺少 provider 而被列表过滤；停机播种，避免 Host 快照读到旧数据。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: seedTaskRows,
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const project = $(projectSelector);
    await project.waitForDisplayed();
    const tasks = $('[data-testid="conversation-section"]');
    for (const section of [project, tasks]) {
      await section.$(moreSelector).waitForExist();
      expect(await section.$$("[data-task-item-key]").length).toBe(5);
    }
    // 停在会话区，排除标题 hover 动画；连续观察真实 ResizeObserver 循环。
    await $('[data-workspace-conversation-frame="true"]').moveTo();
    const evidence = [];
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute((value) => {
        const actions = (
          window as typeof window & { __testActions?: { setTheme(theme: string): void } }
        ).__testActions;
        if (!actions) throw new Error("缺少主题入口");
        actions.setTheme(value);
      }, theme);
      await browser.waitUntil(() =>
        browser.execute(
          (value) => document.documentElement.classList.contains(`theme-${value}`),
          theme,
        ),
      );
      for (const maxWidth of ["240px", "none"]) {
        // 只改变共享组件的容器约束，不绕过布局或修改标题状态；窄容器代表手机侧栏。
        await browser.execute((value) => {
          (
            document.querySelector('[data-purpose-section-list="true"]') as HTMLElement
          ).style.maxWidth = value;
        }, maxWidth);
        const samples = await sampleWidths();
        evidence.push({ theme, maxWidth, samples });
        expect(samples.length).toBeGreaterThan(10);
        expect(
          Math.max(...samples.map((sample) => sample.section - sample.grid)),
        ).toBeLessThanOrEqual(1);
        // 后续分页文字规格保留缩进；分别验证两区的位置稳定，不再强制旧版居中。
        for (const parity of [0, 1]) {
          const positions = samples
            .filter((_, index) => index % 2 === parity)
            .map((sample) => sample.left);
          expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
        }
        const projectWidths = samples
          .filter((_, index) => index % 2 === 0)
          .map((sample) => sample.width);
        expect(Math.max(...projectWidths) - Math.min(...projectWidths)).toBeLessThanOrEqual(1);
      }
    }
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-width-samples.json"),
      JSON.stringify(evidence),
    );
    for (const section of [project, tasks]) {
      const more = section.$(moreSelector);
      for (const count of [10, 15, 20, 25]) {
        await more.scrollIntoView();
        await more.click();
        await browser.waitUntil(
          async () => (await section.$$("[data-task-item-key]").length) === count,
        );
      }
      expect(await section.$(moreSelector).isExisting()).toBe(false);
    }
    await project.scrollIntoView();
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "sidebar-width-stable.png"),
    );
  });
});
