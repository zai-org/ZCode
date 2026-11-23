import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const home = process.env.ZCODE_E2E_HOME_DIR!;
const prefix = "e2e-bulk-archive-";
const control = `${prefix}active`;
// prefix0 的附件被保留的普通任务引用；prefix24 有待处理输入，本次无法删除。
const sharedOwner = `${prefix}0`;
const pendingTask = `${prefix}24`;
const artifactDir = join(home, ".zcode/cli/artifacts", sharedOwner);

describe("TSL39：一键删除全部归档任务", () => {
  after(async () => {
    await clearAppData();
  });
  it("按批预检 25 条折叠归档：取消不写入，确认后删除可删项并保留被引用附件与普通任务", async function () {
    this.timeout(240000);
    // 修复原因：直接运行 wdio 时默认 HOME 是 `.e2e-home`（无 runId 后缀），旧守卫只认
    // `.e2e-home-*`，在 CI/本地单跑时误报；两种隔离目录名都只存在于 E2E runner。
    if (!home || !/^\.e2e-home(?:-|$)/u.test(basename(home)))
      throw new Error("isolated E2E HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 旧夹具依赖已移除的 runner 开关，且只有 Host 摘要，无法验证当前 CLI 删除命令。
    // 在进程退出后准备两库完整历史，冷启读取；执行阶段只经真实 UI 发送删除。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
        try {
          const project = db
            .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
            .get(DEFAULT_WORKSPACE) as { project_id: string };
          const now = Date.now();
          for (let i = 0; i < 26; i++) {
            const id = i === 25 ? control : `${prefix}${i}`;
            const title = `E2E_BULK_ARCHIVE_${i}`,
              archived = i === 25 ? 0 : 1;
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
              )
              .run(id, "e2e-bulk-cli-scope", id, DEFAULT_WORKSPACE, title, now, now);
            db.prepare(
              "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,?,?, 'custom',?,?,'completed',0,?)",
            ).run(
              DEFAULT_WORKSPACE,
              DEFAULT_WORKSPACE,
              id,
              title,
              now,
              now,
              DEFAULT_WORKSPACE,
              project.project_id,
              archived,
              title,
              now,
              now,
              JSON.stringify({
                taskId: id,
                traceId: id,
                title,
                workspacePath: DEFAULT_WORKSPACE,
                createdAt: now,
                updatedAt: now,
                mode: "build",
                archived: Boolean(archived),
              }),
            );
          }
          // 普通任务引用 prefix0 的附件：预检须列出保留附件，删除后文件仍在。
          cli
            .prepare(
              "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('e2e-bulk-ref-msg',?,1,1,?)",
            )
            .run(control, JSON.stringify({ role: "user" }));
          cli
            .prepare(
              "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('e2e-bulk-ref-part','e2e-bulk-ref-msg',?,1,1,?)",
            )
            .run(
              control,
              JSON.stringify({ type: "file", url: `zcode-artifact://${sharedOwner}/shared` }),
            );
          await mkdir(artifactDir, { recursive: true });
          await writeFile(join(artifactDir, "shared.png"), "E2E_BULK_SHARED_ATTACHMENT");
          await writeFile(join(artifactDir, "private.txt"), "E2E_BULK_PRIVATE_ATTACHMENT");
        } finally {
          db.close();
          cli.close();
        }
      },
    });
    await browser.execute(() => {
      (
        window as typeof window & { __testActions: { setLocale(value: string): void } }
      ).__testActions.setLocale("zh-CN");
    });
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    const removedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", `${prefix}0`])}`;
    const retainedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", control])}`;
    await browser.execute(
      (keys) => {
        const visit = JSON.stringify([
          {
            url: "https://example.test/browser-history",
            title: "Browser history",
            faviconUrl: null,
            lastVisitedAt: Date.now(),
          },
        ]);
        localStorage.setItem(keys.removed, visit);
        localStorage.setItem(keys.retained, visit);
      },
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    // 第二批（第 20 项之后）里的一项有待处理输入，预检必须逐项列为无法删除。
    const pendingDb = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      pendingDb
        .prepare(
          "INSERT INTO session_input(id,session_id,kind,delivery,payload,admitted_sequence,status,time_created,time_updated) VALUES('e2e-bulk-queued',?,'prompt','queue','{}',1,'admitted',1,1)",
        )
        .run(pendingTask);
    } finally {
      pendingDb.close();
    }
    // 只观察不拦截：记录批量预检 RPC 次数与弹窗出现过的进度，证明按批（20+5）推进而非逐项。
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const probe = { calls: 0, progress: [] as string[] };
      (window as typeof window & { __tsl39Preflight?: typeof probe }).__tsl39Preflight = probe;
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (
          message instanceof Uint8Array &&
          new TextDecoder().decode(message).includes("previewArchivedTaskDeletions")
        )
          probe.calls++;
        return Reflect.apply(
          original,
          this,
          options === undefined ? [message] : [message, options],
        );
      };
      new MutationObserver(() => {
        const text = document.querySelector(
          '[data-confirm-intent="archive-management-delete"]',
        )?.textContent;
        const value = text?.match(/正在检查 (\d+\/\d+) 个会话/u)?.[1];
        if (value && probe.progress.at(-1) !== value) probe.progress.push(value);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const preflight = () =>
      browser.execute(
        () =>
          (
            window as typeof window & {
              __tsl39Preflight: { calls: number; progress: string[] };
            }
          ).__tsl39Preflight,
      );
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
    // 分组收起没有行 DOM；批量目标必须来自完整权威集合，不能只删除已渲染行。
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    const removeAll = $('[data-testid="archive-delete-all"]');
    await removeAll.click();
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("25"));
    await browser.keys("Escape");
    await confirmation.waitForExist({ reverse: true });
    const historyAfterCancel = await browser.execute(
      (key) => localStorage.getItem(key),
      removedVisitKey,
    );
    expect(historyAfterCancel).not.toBeNull();
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    const callsBeforeConfirm = (await preflight()).calls;
    await browser.execute(() => {
      (
        window as typeof window & { __tsl39Preflight: { progress: string[] } }
      ).__tsl39Preflight.progress = [];
    });
    await removeAll.click();
    await expect(confirmation).toHaveText(expect.stringContaining("25"));
    const confirmButton = $('[data-testid="confirm-dialog-confirm"]');
    await expect(confirmButton).toHaveText("永久删除 24 个会话", { wait: 60000 });
    await expect(confirmButton).toBeEnabled();
    // 25 项分两批：只发 2 次批量预检，进度从 0 跳到 20 再完成，不逐项前进。
    const checked = await preflight();
    expect(checked.calls - callsBeforeConfirm).toBe(2);
    // 最后一批的 25/25 与结果清单在同一轮提交，可能不单独渲染，故不计入比较。
    expect(checked.progress.filter((value) => value !== "25/25")).toEqual(["0/25", "20/25"]);
    await expect(confirmation).toHaveText(
      expect.stringContaining("附件 shared.png：被 E2E_BULK_ARCHIVE_25 引用，保留文件"),
    );
    await expect(confirmation).toHaveText(
      expect.stringMatching(/本次无法删除\s*• E2E_BULK_ARCHIVE_24 · .*任务仍在运行或有待处理输入/u),
    );
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "delete-all-archived-tasks-preflight.png"),
    );
    await confirmButton.click();
    // 永久删除走存储控制面，无需冷恢复 24 个 Agent runtime。
    await browser.waitUntil(() => readCounts().cliRows === 2, { timeout: 120000 });
    expect(readCounts()).toEqual({
      archived: 1,
      deleted: 0,
      active: 1,
      cliRows: 2,
      cliDeleted: 0,
    });
    // 被保留会话引用的附件留下，同一会话的独占附件删除。
    await access(join(artifactDir, "shared.png"));
    await expect(access(join(artifactDir, "private.txt"))).rejects.toThrow();
    await expect(removeAll).toBeEnabled();
    const visitsAfterDelete = await browser.execute(
      (keys) => ({
        removed: localStorage.getItem(keys.removed),
        retained: localStorage.getItem(keys.retained),
      }),
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    expect(visitsAfterDelete.removed).toBeNull();
    expect(visitsAfterDelete.retained).not.toBeNull();
    expect(await $$('[data-testid="archive-group"]').length).toBe(1);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "delete-all-archived-tasks.png"),
    );
  });
});

function readCounts() {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
  try {
    return {
      ...(db
        .prepare(
          "SELECT sum(archived=1 AND cli_deleted=0) AS archived, sum(cli_deleted=1) AS deleted, sum(task_id=? AND archived=0 AND cli_deleted=0) AS active FROM tasks WHERE task_id LIKE ?",
        )
        .get(control, `${prefix}%`) as { archived: number; deleted: number; active: number }),
      ...(cli
        .prepare(
          "SELECT count(*) AS cliRows, sum(time_deleted IS NOT NULL) AS cliDeleted FROM session WHERE id LIKE ?",
        )
        .get(`${prefix}%`) as { cliRows: number; cliDeleted: number }),
    };
  } finally {
    db.close();
    cli.close();
  }
}
