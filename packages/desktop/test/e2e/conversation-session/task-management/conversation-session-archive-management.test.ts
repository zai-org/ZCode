import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { seedArchiveAutomations } from "#e2e/helpers/archive-automations";

const row = (id: string) => $(`[data-testid="archive-task"][data-task-id="${id}"]`);
const home = process.env.ZCODE_E2E_HOME_DIR!;
const ids = ["arm-alpha", "arm-beta", "arm-scheduled", "arm-loose", "arm-removed"];
function readRow(id: string) {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT archived,cli_deleted,project_id FROM tasks WHERE task_id=?")
      .get(id) as { archived: number; cli_deleted: number; project_id: string | null };
  } finally {
    db.close();
  }
}
async function clearSearch() {
  await $('[data-testid="archive-search"]').click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
}
async function setArchiveGroupsOpen(open: boolean) {
  await waitForArchiveAnimations();
  for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) !== String(open)) {
      // 上一组高度动画会移动下一组的点击位置，等布局稳定再继续逐组操作。
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", String(open));
      await waitForArchiveAnimations();
    }
  }
}
async function waitForArchiveAnimations() {
  await browser.waitUntil(() =>
    browser.execute(() =>
      document
        .querySelector('[data-testid="archive-management"]')!
        .getAnimations({ subtree: true })
        .every((animation) => animation.playState !== "running"),
    ),
  );
}
describe("归档管理", () => {
  before(async function () {
    this.timeout(60000);
    // 原因：批量 runner 使用 runId 隔离 HOME，不能只接受早期手工回放的目录名。
    if (!home || !/^(?:zcode-archive-e2e-|\.e2e-home-)/u.test(basename(home)))
      throw new Error("isolated archive HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 旧夹具在运行中的 Host 下写库且缺少必填 meta，列表可见不代表任务命令能读取它。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
        try {
          for (const [i, name] of [
            "E2E 虚拟项目甲",
            "E2E 虚拟项目乙",
            "E2E 已移除项目",
          ].entries()) {
            db.prepare(
              "INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at) VALUES(?,'local',?,?,?,1,1)",
            ).run(`arm-project-${i}`, name, i, i === 2 ? 1 : 0);
            db.prepare(
              "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
            ).run(`arm-project-${i}`, DEFAULT_WORKSPACE);
          }
          const baseTime = Date.now() - 100000;
          for (const [i, id] of ids.entries()) {
            const title = [
              "E2E Alpha " + "long title ".repeat(20),
              "E2E Beta",
              "E2E Scheduled",
              "E2E Unclassified",
              "E2E Removed",
            ][i]!;
            const now = baseTime + i;
            const updated = baseTime + 100 - i;
            // 真实历史 fixture 同时提供 CLI 存在性与 Host 归档组织态；永久删除必须实际清除 CLI 行。
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
              )
              .run(id, "arm-cli-scope", id, DEFAULT_WORKSPACE, title, now, updated);
            db.prepare(
              "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,1,?,'custom',?,?,'completed',0,?)",
            ).run(
              DEFAULT_WORKSPACE,
              DEFAULT_WORKSPACE,
              id,
              title,
              now,
              updated,
              DEFAULT_WORKSPACE,
              i === 3 ? null : `arm-project-${i === 4 ? 2 : i === 1 ? 1 : 0}`,
              title,
              now,
              updated,
              JSON.stringify({
                taskId: id,
                traceId: id,
                title,
                workspacePath: DEFAULT_WORKSPACE,
                createdAt: now,
                updatedAt: updated,
                mode: "default",
                archived: true,
                ...(i === 2 ? { cronAutomationId: "arm-cron" } : {}),
              }),
            );
          }
          for (const [id, type] of [
            ["arm-child", "subagent_child"],
            ["arm-fork", "interactive"],
          ] as const) {
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,parent_id,task_type) VALUES(?,'arm-cli-scope',?,?,?,'1',1,1,'arm-beta',?)",
              )
              .run(id, id, DEFAULT_WORKSPACE, id, type);
          }
          cli
            .prepare(
              "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('arm-fork-msg','arm-fork',1,1,?)",
            )
            .run(JSON.stringify({ role: "user" }));
          cli
            .prepare(
              "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('arm-fork-part','arm-fork-msg','arm-fork',1,1,?)",
            )
            .run(JSON.stringify({ type: "file", url: "zcode-artifact://arm-beta/shared" }));
          const artifactDir = join(home, ".zcode/cli/artifacts/arm-beta");
          await mkdir(artifactDir, { recursive: true });
          await writeFile(join(artifactDir, "shared.png"), "retained shared attachment");
          await writeFile(join(artifactDir, "private.png"), "private attachment");
        } finally {
          db.close();
          cli.close();
        }
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await browser.execute(() => {
      (
        window as typeof window & { __testActions: { setLocale(value: string): void } }
      ).__testActions.setLocale("zh-CN");
    });
    // 通过已存在的设置导航入口打开，再点新分区。
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
  });
  it("APD04/11：先弹框再预检，取消停发且迟到结果不污染新弹窗", async () => {
    await setArchiveGroupsOpen(true);
    // 只暂停真实 RPC 的发送，不替换预检结果或删除实现；释放后仍由 Host/CLI 查询隔离库。
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      const ports = new Set<MessagePort>();
      const receive = (event: MessageEvent) => {
        if (!(event.data instanceof Uint8Array)) return;
        const payload = new TextDecoder().decode(event.data);
        if (payload.includes('"revision"') && payload.includes('"retainedArtifacts"'))
          probe.responses++;
      };
      const probe = {
        calls: 0,
        responses: 0,
        openedBeforeRequest: true,
        release: () => held.shift()?.(),
        restore: () => {
          MessagePort.prototype.postMessage = original;
          for (const port of ports) port.removeEventListener("message", receive);
          for (const send of held.splice(0)) send();
          delete (window as typeof window & { __apdPreflight?: unknown }).__apdPreflight;
        },
      };
      (window as typeof window & { __apdPreflight?: typeof probe }).__apdPreflight = probe;
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const args = options === undefined ? [message] : [message, options];
        if (
          message instanceof Uint8Array &&
          new TextDecoder().decode(message).includes("previewArchivedTaskDeletion")
        ) {
          probe.calls++;
          probe.openedBeforeRequest &&= Boolean(
            document.querySelector('[data-confirm-intent="archive-management-delete"]'),
          );
          if (!ports.has(this)) {
            ports.add(this);
            this.addEventListener("message", receive);
          }
          held.push(() => Reflect.apply(original, this, args));
          return;
        }
        Reflect.apply(original, this, args);
      };
    });
    const state = () =>
      browser.execute(() => {
        const probe = (
          window as typeof window & {
            __apdPreflight: { calls: number; responses: number; openedBeforeRequest: boolean };
          }
        ).__apdPreflight;
        return {
          calls: probe.calls,
          responses: probe.responses,
          openedBeforeRequest: probe.openedBeforeRequest,
        };
      });
    const release = () =>
      browser.execute(() =>
        (
          window as typeof window & { __apdPreflight: { release(): void } }
        ).__apdPreflight.release(),
      );
    const dialog = $('[data-confirm-intent="archive-management-delete"]');
    try {
      await $('[data-testid="archive-delete-all"]').click();
      await expect(dialog).toHaveText(expect.stringContaining("正在检查 0/5 个会话"));
      await expect($('[data-testid="confirm-dialog-confirm"]')).toBeDisabled();
      await browser.waitUntil(async () => (await state()).calls === 1);
      expect((await state()).openedBeforeRequest).toBe(true);
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "apd-preflight-pending.png"),
      );
      await browser.keys("Escape");
      await dialog.waitForExist({ reverse: true });
      await expect($('[data-testid="archive-delete-all"]')).toBeEnabled();
      await row("arm-beta").$('[data-testid="archive-delete"]').click();
      await expect(dialog).toHaveText(expect.stringContaining("正在检查 0/1 个会话"));
      await browser.waitUntil(async () => (await state()).calls === 2);
      await release();
      await browser.waitUntil(async () => (await state()).responses === 1);
      // 旧 RPC 已真实返回，但新弹窗仍停在自己的检查中；旧批次不得继续发第二项。
      expect((await state()).calls).toBe(2);
      await expect(dialog).toHaveText(expect.stringContaining("正在检查 0/1 个会话"));
      await expect($('[data-testid="confirm-dialog-confirm"]')).toBeDisabled();
      await release();
      await expect($('[data-testid="confirm-dialog-confirm"]')).toBeEnabled();
      await expect(dialog).toHaveText(expect.stringContaining("shared.png"));
      await expect($('[data-testid="confirm-dialog-confirm"]')).toHaveText("永久删除 1 个会话");
      await browser.keys("Escape");
      await dialog.waitForExist({ reverse: true });
      await $('[data-project-id="arm-project-0"] [data-testid="archive-group-menu"]').click();
      await $('[data-testid="archive-group-delete"]').click();
      await expect(dialog).toHaveText(expect.stringContaining("正在检查 0/2 个会话"));
      await expect($('[data-testid="confirm-dialog-confirm"]')).toBeDisabled();
      await browser.waitUntil(async () => (await state()).calls === 3);
      await dialog.$("button*=取消").click();
      await dialog.waitForExist({ reverse: true });
      await release();
      await browser.waitUntil(async () => (await state()).responses === 3);
      expect((await state()).calls).toBe(3);
      for (const id of ids) expect(readRow(id).archived).toBe(1);
    } finally {
      if (await dialog.isDisplayed()) await browser.keys("Escape");
      await browser.execute(() =>
        (
          window as typeof window & { __apdPreflight?: { restore(): void } }
        ).__apdPreflight?.restore(),
      );
      await setArchiveGroupsOpen(false);
    }
  });
  it("ARM08：页面标题与固定文案统一为会话", async () => {
    const heading = $("h2=归档管理");
    await expect(heading).toBeDisplayed();
    await expect($('[data-testid="archive-management"] h2')).toHaveText("已归档的会话");
    await expect($('[data-testid="archive-search"]')).toHaveAttribute(
      "placeholder",
      "搜索已归档会话",
    );
    await expect($('[data-testid="archive-auto-archive-switch"]')).toHaveAttribute(
      "aria-label",
      "自动归档旧会话",
    );
    const main = $('main:has([data-testid="archive-management"])');
    expect(await main.getText()).not.toMatch(/任务|对话|聊天/);
    expect(await main.getText()).toContain("2 个会话");
    const titleAboveSettings = await browser.execute(() => {
      const title = [...document.querySelectorAll("main h2")].find(
        (el) => el.textContent === "归档管理",
      )!;
      const settings = document.querySelector('[data-testid="archive-auto-archive-switch"]')!;
      return title.getBoundingClientRect().bottom < settings.getBoundingClientRect().top;
    });
    expect(titleAboveSettings).toBe(true);
    await $('[data-testid="archive-search"]').setValue("E2E_NO_ARCHIVE_MATCH");
    await expect($('[data-testid="archive-management"]')).toHaveText(
      expect.stringContaining("没有匹配的归档会话"),
    );
    await clearSearch();
    await $('[data-testid="archive-delete-all"]').click();
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("删除这 5 个归档会话？"));
    await expect(confirmation).toHaveText(
      expect.stringContaining("会话记录将从当前设备或所属远端永久删除"),
    );
    await browser.keys("Escape");
  });
  it("ARM07：默认 30 天，关闭时可先保存时长，开启与刷新保留选择", async () => {
    await $('[data-testid="settings-section-nav-general"]').click();
    expect(await $('//*[normalize-space(text())="自动归档旧会话"]').isExisting()).toBe(false);
    expect(await $('//*[normalize-space(text())="归档保留时长"]').isExisting()).toBe(false);
    await $('[data-testid="settings-section-nav-archives"]').click();
    const toggle = $('[data-testid="archive-auto-archive-switch"]');
    const days = $('[data-testid="archive-auto-archive-days"]');
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("30 天后归档");
    const placement = await browser.execute(() => ({
      settingsBottom: document
        .querySelector('[data-testid="archive-auto-archive-days"]')!
        .getBoundingClientRect().bottom,
      listTop: document.querySelector('[data-testid="archive-management"]')!.getBoundingClientRect()
        .top,
    }));
    expect(placement.settingsBottom).toBeLessThan(placement.listTop);
    // 先保存时长再开启，避免开关一开就按旧阈值归档。
    await days.click();
    await $('[role="option"]*=7 天后归档').click();
    await expect(days).toHaveText("7 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === false && settings.taskAutoArchiveOlderThanDays === 7
      );
    });
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("7 天后归档");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"))).toMatchObject({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 7,
    });
    await days.click();
    await $('[role="option"]*=14 天后归档').click();
    await expect(days).toHaveText("14 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === true && settings.taskAutoArchiveOlderThanDays === 14
      );
    });
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(days).toHaveText("14 天后归档");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(days).toBeEnabled();
    await expect(days).toHaveText("14 天后归档");
    await days.click();
    await $('[role="option"]*=30 天后归档').click();
    await expect(days).toHaveText("30 天后归档");
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"));
      return (
        settings.taskAutoArchiveEnabled === false && settings.taskAutoArchiveOlderThanDays === 30
      );
    });
    expect(ids.map((id) => readRow(id).archived)).toEqual(ids.map(() => 1));
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "ARM07-disabled-30-days.png"),
    );
  });
  it("ARM01/05/06：分组折叠、搜索、时间排序和项目选择", async () => {
    expect(await $$('[data-testid="archive-group"]').length).toBe(4);
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    const firstGroup = $('[data-testid="archive-group"][data-project-id="arm-project-0"]');
    const toggle = firstGroup.$('[data-testid="archive-group-toggle"]');
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await firstGroup.getText()).toContain("2");
    await toggle.click();
    await row("arm-alpha").waitForDisplayed();
    // 展开只挂载当前组；键盘收起后必须真正移除行，不只是 CSS 隐藏。
    expect(await $$('[data-testid="archive-task"]').length).toBe(2);
    await browser.keys("Enter");
    await row("arm-alpha").waitForExist({ reverse: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    await firstGroup.$('[data-testid="archive-group-menu"]').click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    await browser.keys("Escape");
    await setArchiveGroupsOpen(true);
    expect(await $$('[data-testid="archive-task"]').length).toBe(5);
    expect(await $('[data-testid="archive-management"]').getText()).toContain("E2E 虚拟项目甲");
    // 防止将静态标签和业务图标再次塞进触发框，扩大下拉点击区域。
    expect(await $('[data-testid="archive-sort"]').getText()).toBe("更新时间");
    expect(await $('[data-testid="archive-project-filter"]').getText()).toBe("所有项目");
    // 筛选栏只保留搜索图标和两个下拉箭头，不再显示排序/项目装饰图标。
    expect(await $('[data-testid="archive-filters"]').$$("svg").length).toBe(3);
    for (const testId of ["archive-sort", "archive-project-filter"]) {
      expect(await $(`[data-testid="${testId}"]`).$$("svg").length).toBe(1);
    }
    const sortLabel = await browser.execute(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="archive-sort"]')!;
      const label = trigger.labels?.[0];
      return { text: label?.textContent, outside: Boolean(label && !trigger.contains(label)) };
    });
    expect(sortLabel).toEqual({ text: "排序方式", outside: true });
    await $('[data-testid="archive-project-filter"]').click();
    const options = await $$('[role="option"]');
    expect((await options.map((o) => o.getText())).join("\n")).toContain("E2E 虚拟项目乙");
    expect((await options.map((o) => o.getText())).join("\n")).not.toContain(DEFAULT_WORKSPACE);
    await $('[data-testid="archive-project-option-arm-project-1"]').click();
    expect(await $$('[data-testid="archive-task"]').length).toBe(1);
    expect(await row("arm-beta").isDisplayed()).toBe(true);
    await $('[data-testid="archive-project-filter"]').click();
    await $('[data-testid="archive-project-all"]').click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-1"]')
        .$('[data-testid="archive-group-toggle"]')
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await setArchiveGroupsOpen(true);
    await $('[data-testid="archive-sort"]').click();
    // Radix 异步移动选项焦点；确认焦点后再回车，避免同批按键选中旧项。
    await browser.keys("End");
    await expect($('[data-testid="archive-sort-created"]')).toBeFocused();
    await browser.keys("Enter");
    await expect($('[data-testid="archive-sort"]')).toHaveText("创建时间");
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-0"]')
        .$$('[data-testid="archive-task"]')
        .map((r) => r.getAttribute("data-task-id")),
    ).toEqual(["arm-scheduled", "arm-alpha"]);
    expect(await $('[data-testid="archive-sort"]').getAttribute("aria-label")).toBeTruthy();
    await $('[data-testid="archive-sort"]').click();
    await $('[data-testid="archive-sort-updated"]').click();
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-0"]')
        .$$('[data-testid="archive-task"]')
        .map((r) => r.getAttribute("data-task-id")),
    ).toEqual(["arm-alpha", "arm-scheduled"]);
    await $('[data-testid="archive-search"]').setValue("alpha");
    expect(await $$('[data-testid="archive-task"]').length).toBe(1);
    await clearSearch();
    await captureArchiveLayouts();
    await setArchiveGroupsOpen(true);
  });
  it("ARM02：取消归档、取消删除与确认删除后刷新不复活", async () => {
    await row("arm-alpha").$('[data-testid="archive-unarchive"]').click();
    await row("arm-alpha").waitForExist({ reverse: true });
    expect(readRow("arm-alpha").archived).toBe(0);
    await row("arm-beta").$('[data-testid="archive-delete"]').click();
    // 永久删除先异步预检；必须等确认框打开后再取消，不能把 Escape 发给页面。
    await $('[data-confirm-intent="archive-management-delete"]').waitForDisplayed();
    await browser.keys("Escape");
    await $('[data-confirm-intent="archive-management-delete"]').waitForExist({ reverse: true });
    expect(readRow("arm-beta").cli_deleted).toBe(0);
    await browser.execute(
      (path) =>
        localStorage.setItem(
          `zcode-v4-composer-drafts:v1:${encodeURIComponent(path)}`,
          JSON.stringify({
            version: 1,
            scopes: { "arm-beta": { text: "E2E_PRIVATE_DRAFT", updatedAt: 1 } },
          }),
        ),
      DEFAULT_WORKSPACE,
    );
    await row("arm-beta").$('[data-testid="archive-delete"]').click();
    await expect($('[data-testid="confirm-dialog-confirm"]')).toHaveText("永久删除 1 个会话");
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("将删除"));
    await expect(confirmation).toHaveText(expect.stringContaining("将保留"));
    await expect(confirmation).toHaveText(expect.stringContaining("链接仍可访问"));
    await expect(confirmation).toHaveText(expect.stringContaining("shared.png"));
    await expect(confirmation).toHaveText(expect.stringContaining("arm-fork"));
    // 确认后内容变化必须拒绝旧 revision，不能扩大用户确认范围。
    const changed = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      changed.prepare("UPDATE session SET time_updated=time_updated+1 WHERE id='arm-beta'").run();
    } finally {
      changed.close();
    }
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await expect($('[data-testid="archive-management"]')).toHaveText(
      expect.stringContaining("删除范围已变化"),
    );
    expect(readRow("arm-beta")).toBeDefined();
    await row("arm-beta").$('[data-testid="archive-delete"]').click();
    await expect($('[data-testid="confirm-dialog-confirm"]')).toBeEnabled();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await row("arm-beta").waitForExist({ reverse: true });
    await expect($('[data-testid="archive-management"]')).toHaveText(
      expect.stringContaining("已永久删除"),
    );
    expect(readRow("arm-beta")).toBeUndefined();
    expect(
      await browser.execute(
        (path) =>
          localStorage.getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(path)}`) ?? "",
        DEFAULT_WORKSPACE,
      ),
    ).not.toContain("E2E_PRIVATE_DRAFT");
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
    try {
      expect(cli.prepare("SELECT id FROM session WHERE id=?").get("arm-beta")).toBeUndefined();
      expect(cli.prepare("SELECT id FROM session WHERE id='arm-child'").get()).toBeUndefined();
      expect(cli.prepare("SELECT id FROM session WHERE id='arm-fork'").get()).toBeDefined();
      expect(cli.prepare("SELECT data FROM part WHERE id='arm-fork-part'").get()).toBeDefined();
      expect(
        cli.prepare("SELECT state FROM session_purge WHERE session_id='arm-beta'").get()?.state,
      ).toBe("deleted");
      await expect(
        access(join(home, ".zcode/cli/artifacts/arm-beta/shared.png")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(home, ".zcode/cli/artifacts/arm-beta/private.png")),
      ).rejects.toThrow();
    } finally {
      cli.close();
    }
    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 刷新按既有行为回工作区，重新打开设置才能核对持久化后的列表。
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    expect(
      await $('[data-testid="archive-group"][data-project-id="arm-project-1"]').isExisting(),
    ).toBe(false);
    expect(await row("arm-beta").isExisting()).toBe(false);
  });
  it("ARM03：全部删除仅作用于当前筛选，分组更多取消归档", async () => {
    await $('[data-testid="archive-search"]').setValue("Unclassified");
    await $('[data-testid="archive-delete-all"]').click();
    expect(await $('[data-confirm-intent="archive-management-delete"]').getText()).toContain("1");
    await expect($('[data-testid="confirm-dialog-confirm"]')).toBeEnabled();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    // 折叠组没有行 DOM，等整个分组消失并核对落库，避免把未渲染误当成已删除。
    await $('[data-testid="archive-group"][data-project-id=""]').waitForExist({ reverse: true });
    expect(readRow("arm-loose")).toBeUndefined();
    expect(readRow("arm-scheduled").cli_deleted).toBe(0);
    expect(readRow("arm-removed").cli_deleted).toBe(0);
    await clearSearch();
    const group = $('[data-testid="archive-group"][data-project-id="arm-project-0"]');
    expect(
      await group.$('[data-testid="archive-group-toggle"]').getAttribute("aria-expanded"),
    ).toBe("false");
    await group.$('[data-testid="archive-group-menu"]').click();
    await $('[data-testid="archive-group-unarchive"]').click();
    await group.waitForExist({ reverse: true });
    expect(readRow("arm-scheduled").archived).toBe(0);
  });
  it("APD03/11：待处理输入逐项显示原因，零项可删时禁止确认", async () => {
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      cli
        .prepare(
          "INSERT INTO session_input(id,session_id,kind,delivery,payload,admitted_sequence,status,time_created,time_updated) VALUES('apd-queued','arm-removed','prompt','queue','{}',1,'admitted',1,1)",
        )
        .run();
    } finally {
      cli.close();
    }
    await $('[data-testid="archive-delete-all"]').click();
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("任务仍在运行或有待处理输入"));
    await expect($('[data-testid="confirm-dialog-confirm"]')).toBeDisabled();
    await browser.keys("Enter");
    // destructive 默认焦点为取消，Enter 可以取消，但不能触发删除。
    if (await confirmation.isDisplayed()) await browser.keys("Escape");
    await confirmation.waitForExist({ reverse: true });
    expect(readRow("arm-removed")).toBeDefined();
    const stopped = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      stopped.prepare("UPDATE session_input SET status='cancelled' WHERE id='apd-queued'").run();
    } finally {
      stopped.close();
    }
  });
  it("APD11：手机真实配对后永久删除，桌面刷新与两库同步移除", async function () {
    this.timeout(150000);
    await $('[data-testid="settings-back-button"]').click();
    let receive!: (url: string) => void;
    const pairing = new Promise<string>((resolve) => {
      receive = resolve;
    });
    const server = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        response.end();
        return;
      }
      let value = "";
      for await (const chunk of request) value += String(chunk);
      receive(value);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("pair receiver unavailable");
    const mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    try {
      await browser.execute((port) => {
        const target = window as Window & { __apdRestoreClipboard?: () => void };
        const previous = navigator.clipboard.writeText.bind(navigator.clipboard);
        target.__apdRestoreClipboard = () => {
          navigator.clipboard.writeText = previous;
        };
        navigator.clipboard.writeText = async (text) => {
          await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: text });
        };
      }, address.port);
      const triggerSelector =
        'button[aria-label="移动端远程控制"],button[aria-label="Mobile remote control"]';
      // 窄屏验收会折起工作区侧栏；恢复真实用户可点击入口，不能点击仍挂载但被主区遮住的按钮。
      if (!(await $(triggerSelector).isClickable()))
        await $('[data-testid="desktop-top-logo-sidebar-toggle"]').click();
      await browser.waitUntil(
        async () => {
          for (const trigger of await $$(triggerSelector)) {
            if (await trigger.isClickable()) {
              await trigger.click();
              return true;
            }
          }
          return false;
        },
        { timeout: 10000 },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="web-remote-control-dialog-scroll"] button',
              ),
            ).find(
              (node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 60000 },
      );
      const context = await mobile.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await openMobilePairingPage(page, await pairing, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
        caseMarker: "APD11",
        phase: "pairing",
        readySelector: '[data-testid="task-settings-button"]',
      });
      await page.getByTestId("task-settings-button").tap();
      await page.getByTestId("settings-section-nav-archives").tap();
      await page.getByTestId("archive-management").waitFor();
      const automations = await seedArchiveAutomations({
        workspacePath: DEFAULT_WORKSPACE,
        taskId: "arm-removed",
      });
      // AAP04：通过真实手机 attachment 取消归档再归档，验证暂停落在同一个 Host。
      for (const toggle of await page.getByTestId("archive-group-toggle").all()) {
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
      }
      await page.locator('[data-task-id="arm-removed"] [data-testid="archive-unarchive"]').tap();
      await page
        .locator('[data-testid="archive-task"][data-task-id="arm-removed"]')
        .waitFor({ state: "detached" });
      await page.getByTestId("settings-back-button").tap();
      await page.getByTestId("sidebar-view-menu").tap();
      await page.getByTestId("sidebar-view-timeline").tap();
      const restored = page.getByTestId("task-item-arm-removed");
      await restored.waitFor();
      await restored.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^(归档任务|Archive task)$/ }).click();
      await restored.waitFor({ state: "detached" });
      await automations.assertPaused();
      await page.getByTestId("task-settings-button").tap();
      await page.getByTestId("settings-section-nav-archives").tap();
      await page.getByTestId("archive-management").waitFor();
      await page.getByTestId("archive-delete-all").tap();
      const dialog = page.locator('[data-confirm-intent="archive-management-delete"]');
      await dialog.waitFor();
      await page.getByRole("button", { name: /^(取消|Cancel)/ }).tap();
      await dialog.waitFor({ state: "detached" });
      expect(readRow("arm-removed")).toBeDefined();
      await page.getByTestId("archive-delete-all").tap();
      await dialog.waitFor();
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="confirm-dialog-confirm"]',
        );
        return button && !button.disabled;
      });
      expect(await dialog.innerText()).toContain("E2E Removed");
      expect(await dialog.innerText()).toContain("将保留");
      await page.waitForFunction(() =>
        document
          .querySelector('[data-confirm-intent="archive-management-delete"]')!
          .getAnimations({ subtree: true })
          .every((animation) => animation.playState !== "running"),
      );
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({
        path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "apd-mobile-confirmation.png"),
      });
      await page.getByTestId("confirm-dialog-confirm").tap();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="archive-delete-all"]')?.hasAttribute("disabled"),
      );
      await browser.waitUntil(() => readRow("arm-removed") === undefined);
      const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
      try {
        expect(cli.prepare("SELECT 1 FROM session WHERE id='arm-removed'").get()).toBeUndefined();
      } finally {
        cli.close();
      }
      // 手机离线期间可能保留旧草稿；新 attachment 必须从持久删除凭据补清，不能只依赖实时事件。
      await page.evaluate(
        (path) =>
          localStorage.setItem(
            `zcode-v4-composer-drafts:v1:${encodeURIComponent(path)}`,
            JSON.stringify({
              version: 1,
              scopes: { "arm-removed": { text: "E2E_OFFLINE_DRAFT", updatedAt: 1 } },
            }),
          ),
        DEFAULT_WORKSPACE,
      );
      await page.reload();
      await page.waitForFunction(
        (path) =>
          !localStorage
            .getItem(`zcode-v4-composer-drafts:v1:${encodeURIComponent(path)}`)
            ?.includes("E2E_OFFLINE_DRAFT"),
        DEFAULT_WORKSPACE,
      );
    } finally {
      await mobile.close();
      server.close();
      await browser.execute(() => {
        const target = window as Window & { __apdRestoreClipboard?: () => void };
        target.__apdRestoreClipboard?.();
        delete target.__apdRestoreClipboard;
      });
    }
  });
});

async function captureArchiveLayouts() {
  const original = await browser.execute(() =>
    (window as typeof window & { __testActions: { getTheme(): string } }).__testActions.getTheme(),
  );
  try {
    for (const width of [1200, 390]) {
      await browser.electron.execute(async (electron, width) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !w.isDestroyed(),
        )!;
        if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
        await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      for (const [locale, theme] of [
        ["zh-CN", "zai-light"],
        ["zh-CN", "zai-dark"],
        ["en-US", "zai-light"],
        ["en-US", "zai-dark"],
      ] as const) {
        await browser.execute(
          ({ locale, theme }) => {
            const actions = (
              window as typeof window & {
                __testActions: { setTheme(value: string): void; setLocale(value: string): void };
              }
            ).__testActions;
            actions.setTheme(theme);
            actions.setLocale(locale);
          },
          { locale, theme },
        );
        await browser.waitUntil(() =>
          browser.execute(
            (theme) => document.documentElement.classList.contains(`theme-${theme}`),
            theme,
          ),
        );
        await expect($('[data-testid="archive-sort"]')).toHaveText(
          locale === "zh-CN" ? "更新时间" : "Updated time",
        );
        await setArchiveGroupsOpen(false);
        expect(await $$('[data-testid="archive-task"]').length).toBe(0);
        await waitForArchiveAnimations();
        const dimensions = await browser.execute(() => {
          const page = document.querySelector<HTMLElement>('[data-testid="archive-management"]')!;
          const box = page.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            width: innerWidth,
            scrollWidth: page.scrollWidth,
            clientWidth: page.clientWidth,
            filters: ["archive-sort", "archive-project-filter"].map((id) => {
              const trigger = page.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
              return {
                left: trigger.getBoundingClientRect().left,
                labelRight: trigger.labels?.[0]?.getBoundingClientRect().right ?? null,
              };
            }),
          };
        });
        expect(dimensions.right).toBeLessThanOrEqual(dimensions.width);
        expect(dimensions.left).toBeGreaterThanOrEqual(0);
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
        const heading = $(`h2=${locale === "zh-CN" ? "归档管理" : "Archive management"}`);
        await heading.scrollIntoView();
        await expect(heading).toBeDisplayed();
        await expect($('[data-testid="archive-management"] h2')).toHaveText(
          locale === "zh-CN" ? "已归档的会话" : "Archived sessions",
        );
        const autoArchive = $('[data-testid="archive-auto-archive-switch"]');
        await autoArchive.scrollIntoView();
        await expect(autoArchive).toHaveAttribute(
          "aria-label",
          locale === "zh-CN" ? "自动归档旧会话" : "Auto-archive old sessions",
        );
        const controlBounds = await browser.execute(() =>
          ["archive-auto-archive-switch", "archive-auto-archive-days"].map((id) => {
            const box = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth;
          }),
        );
        expect(controlBounds).toEqual([true, true]);
        for (const filter of dimensions.filters) {
          if (filter.labelRight !== null) expect(filter.labelRight).toBeLessThan(filter.left);
        }
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `archive-${width}-${locale}-${theme}-collapsed.png`,
          ),
        );
        await $('[data-testid="archive-group-toggle"]').click();
        await $('[data-testid="archive-task"]').waitForDisplayed();
        await waitForArchiveAnimations();
        expect(
          await browser.execute(() => {
            const page = document.querySelector<HTMLElement>('[data-testid="archive-management"]')!;
            return page.scrollWidth <= page.clientWidth + 1;
          }),
        ).toBe(true);
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `archive-${width}-${locale}-${theme}-expanded.png`,
          ),
        );
      }
    }
  } finally {
    await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (w) => w.isVisible() && !w.isDestroyed(),
      )!;
      await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    });
    await browser.execute((value) => {
      const actions = (
        window as typeof window & {
          __testActions: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      actions.setTheme(value);
      actions.setLocale("zh-CN");
    }, original);
  }
}
