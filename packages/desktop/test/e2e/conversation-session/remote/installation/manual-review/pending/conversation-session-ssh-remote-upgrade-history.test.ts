import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildRemoteWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_REMOTE_KIND_SSH,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { stageE2EAppOutput } from "#e2e/helpers/e2e-app-output-stage";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openRemoteProjectSelection,
  openSSHSourceDirectory,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  uploadSSHFixtureFile,
  prepareSSHHistoryFixtureNode,
} from "#e2e/helpers/ssh-version-policy-fixture";
import {
  prepareSSHLifecycle,
  sendSSHFollowTurn,
  SSH_LIFECYCLE_MODEL_ID,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  getV4Messages,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_UPGRADE_HISTORY";
const STAGING_COMMIT = "7a6e2eb3f1946aba9155155178e86cd947cee655";
const scenario = process.env.R3_HISTORY_CASE ?? "single";
// conflict：canonical 与 source 的身份冲突；conflict-sources：canonical 不含该任务，两个 source 之间冲突。
const conflictScenario = scenario === "conflict" || scenario === "conflict-sources";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-upgrade-history",
);

async function replaceRunApplication(base: string) {
  const desktopRoot = resolve(import.meta.dirname, "../../../../../../..");
  const runId = process.env.ZCODE_E2E_RUN_ID;
  if (!runId) throw new Error("缺少隔离应用路径");
  const cache = join(desktopRoot, ".e2e-cache", runId);
  const copies: Array<[string, string]> = [
    [join(base, "packages/desktop/out"), join(cache, "app")],
    [join(base, "packages/desktop/mock-cdn"), join(cache, "mock-cdn")],
  ];
  for (const [source, destination] of copies) {
    await rm(destination, { recursive: true, force: true });
    await stageE2EAppOutput(source, destination);
  }
}

async function openStagingDirectory(config: SSHConnectionConfig, workspacePath: string) {
  // staging 的旧向导在选择 SSH 后还有一步“下一步”；不把当前三屏向导的操作量套给旧版本。
  await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
  await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION);
  await clickTestIdByWebDriver(TID_REMOTE_KIND_SSH);
  await clickLastEnabledSSHDialogButton(MARKER);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(MARKER);
  await waitForSSHDirectoryStep(MARKER);
  // 历史夹具固定在 7a6e2eb3：没有新版目录摘要和项目编辑器，不能复用当前 UI helper。
  const path = workspacePath.replace(/\/+$/, "");
  const split = path.lastIndexOf("/");
  const parent = path.slice(0, split) || "/";
  const name = path.slice(split + 1);
  const input = $('[data-testid="ssh-success"] input[type="text"]');
  await input.waitForDisplayed();
  await browser.waitUntil(async () => Boolean(await input.getValue()));
  // 旧版也使用受控 input；等待 home 预填后覆盖，避免 WebDriver clear 被 React 还原再追加路径。
  await browser.execute((value) => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="ssh-success"] input[type="text"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, parent);
  await input.click();
  await browser.keys("Enter");
  await browser.waitUntil(
    () =>
      browser.execute((name) => {
        const entry = [
          ...document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-success"] button'),
        ].find((button) => button.innerText.trim() === name);
        entry?.click();
        return Boolean(entry);
      }, name),
    { timeout: 30_000, timeoutMsg: "旧版目录列表未加载目标目录" },
  );
  await browser.waitUntil(async () => (await input.getValue()) === path, {
    timeout: 30_000,
    timeoutMsg: "旧版目录未进入目标路径",
  });
  await clickLastEnabledSSHDialogButton(MARKER);
  await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true, timeout: 120_000 });
}

async function createStagingHistory(
  config: SSHConnectionConfig,
  provider: SSHLifecycleProvider,
  label: "A" | "B",
  workspacePath: string,
): Promise<SSHLifecycleTask> {
  await startNewV4Draft();
  await openStagingDirectory(config, workspacePath);
  const tab = await waitForRemoteTab({
    caseMarker: MARKER,
    expectedIdentity: buildRemoteWorkspaceIdentity(workspacePath, {
      kind: "ssh",
      host: config.host,
      port: config.port,
      username: config.username,
    }),
    expectedPath: workspacePath,
  });
  await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
    providerId: provider.id,
    providerName: provider.name,
    includePlainModelFallback: false,
  });
  await selectUpstreamThoughtLevelValue("disabled");
  await startNewV4Draft();
  const firstPrompt = `${MARKER}_${label}_FIRST_PROMPT`;
  const firstReply = "SSH_UPGRADE_HISTORY_REPLY";
  await sendV4PromptAndWaitAccepted(
    `${firstPrompt}: 只回复 ${firstReply}`,
    firstPrompt,
    "staging 首发未被接受",
  );
  await waitForV4AssistantMessageContaining(firstReply);
  const state = await waitForV4ConversationState(
    (state) => Boolean(state.taskId && state.taskId !== "draft") && state.state === "idle",
    "staging 历史未完成",
  );
  return {
    firstPrompt,
    firstReply,
    followPrompt: `${MARKER}_${label}_FOLLOW_PROMPT`,
    followReply: firstReply,
    identity: tab.workspaceIdentity!,
    label,
    remoteSessionId: tab.remoteSessionId!,
    taskId: state.taskId!,
    workspacePath,
  };
}

async function readHistoryStore(
  config: SSHConnectionConfig,
  mode = "inspect",
  firstId = "",
  secondId = "",
) {
  const script = join(artifactDir, "history-store.mjs");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    script,
    `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.HOME+'/.zcode/v2/tasks-index.sqlite');
db.exec('PRAGMA busy_timeout=5000');
if(process.argv[2]==='conflict') {
 const first=db.prepare('SELECT * FROM tasks WHERE task_id=?').get(process.argv[3]);
 const second=db.prepare('SELECT * FROM tasks WHERE task_id=?').get(process.argv[4]);
 if(!first||!second||first.workspace_key===second.workspace_key)throw new Error('旧程序没有生成独立线路历史');
 db.prepare('UPDATE tasks SET meta_json=? WHERE workspace_key=? AND task_id=?').run(JSON.stringify({...JSON.parse(first.meta_json),cronAutomationId:'guide-conflict-a'}),first.workspace_key,first.task_id);
 const copy={...first,workspace_key:second.workspace_key,workspace_identity:second.workspace_identity,meta_json:JSON.stringify({...JSON.parse(first.meta_json),cronAutomationId:'guide-conflict-b'})};
 const columns=Object.keys(copy);
 db.prepare('INSERT INTO tasks('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>copy[key]));
}
let injected=null;
if(process.argv[2]==='conflict-sources') {
 // 第二条线路更活跃，成为不含该任务的 canonical；第一条线路与合成第三条线路的同一任务身份矛盾。
 const first=db.prepare('SELECT * FROM tasks WHERE task_id=?').get(process.argv[3]);
 const second=db.prepare('SELECT * FROM tasks WHERE task_id=?').get(process.argv[4]);
 if(!first||!second||first.workspace_key===second.workspace_key)throw new Error('旧程序没有生成独立线路历史');
 if(second.updated_at<=first.updated_at)throw new Error('第二条线路必须更活跃才会被选为 canonical');
 const sourceKey=first.workspace_key.replace(/^remote:ssh:[^:]+:/,'remote:ssh:history-route-c.example:');
 const meta=JSON.parse(first.meta_json);
 db.prepare('UPDATE tasks SET meta_json=? WHERE workspace_key=? AND task_id=?').run(JSON.stringify({...meta,cronAutomationId:'guide-conflict-a'}),first.workspace_key,first.task_id);
 const copy={...first,workspace_key:sourceKey,workspace_identity:sourceKey,meta_json:JSON.stringify({...meta,...('workspaceIdentity' in meta?{workspaceIdentity:sourceKey}:{}),cronAutomationId:'guide-conflict-c'})};
 const columns=Object.keys(copy);
 db.prepare('INSERT INTO tasks('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>copy[key]));
 injected={canonicalKey:second.workspace_key,sourceKeys:[first.workspace_key,sourceKey].sort()};
}
const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
const hasProject= db.prepare('PRAGMA table_info(tasks)').all().some(row=>row.name==='project_id');
const result={injected,tasks:db.prepare('SELECT task_id,workspace_key,'+(hasProject?'project_id':'NULL AS project_id')+' FROM tasks').all(),projects:tables.has('projects')?db.prepare('SELECT project_id,name FROM projects WHERE deleted=0').all():[],roots:tables.has('project_roots')?db.prepare('SELECT project_id,root_path FROM project_roots').all():[],aliases:tables.has('workspace_alias')?db.prepare('SELECT * FROM workspace_alias').all():[],ledgers:tables.has('workspace_migration_ledger')?db.prepare('SELECT * FROM workspace_migration_ledger').all():[],conflicts:tables.has('workspace_migration_conflicts')?db.prepare('SELECT task_id,source_key,canonical_key FROM workspace_migration_conflicts').all():[]};
db.close();process.stdout.write(JSON.stringify(result));\n`,
  );
  const remoteRoot = "/home/" + config.username + "/r3-workspace-a/.zcode-e2e/history-fixture";
  expect((await runSSHCommand(config, `mkdir -p '${remoteRoot}'`)).code).toBe(0);
  await uploadSSHFixtureFile(config, script, `${remoteRoot}/history-store.mjs`);
  // 冲突必须在旧程序停止后、当前程序启动前注入；旧主链没有 Server runtime，不能先偷跑迁移。
  const node = mode.startsWith("conflict")
    ? await prepareSSHHistoryFixtureNode(config, remoteRoot)
    : `${JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout).releaseDir}/runtime/node`;
  const result = await runSSHCommand(
    config,
    `'${node}' '${remoteRoot}/history-store.mjs' '${mode}' '${firstId}' '${secondId}'`,
  );
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as {
    injected: { canonicalKey: string; sourceKeys: string[] } | null;
    tasks: Array<{ task_id: string; workspace_key: string; project_id: string | null }>;
    projects: Array<{ project_id: string; name: string }>;
    roots: Array<{ project_id: string; root_path: string }>;
    aliases: unknown[];
    ledgers: Array<{
      migration_id: string;
      canonical_key: string;
      status: string;
      path: string;
      phase: string | null;
      updated_at: number;
    }>;
    conflicts: Array<{ task_id: string; source_key: string; canonical_key: string }>;
  };
}

async function listMigrationBackups(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(
    config,
    'find "$HOME/.zcode/server/migration-backups" -name tasks-index.sqlite -type f 2>/dev/null || true',
  );
  return result.stdout.trim();
}

async function openCurrentDirectory(
  config: SSHConnectionConfig,
  path: string,
  negative = false,
  historyTaskIds: string[] = [],
) {
  await openRemoteProjectSelection();
  await clickTestIdByWebDriver(TID_REMOTE_KIND_SSH);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(MARKER);
  await waitForSSHDirectoryStep(MARKER);
  if (!historyTaskIds.length) {
    await selectSSHRemoteDirectory(path, MARKER, { waitForDialogClose: !negative });
    return;
  }
  // 新建同目录项目会生成“(2)”并把旧历史留在原项目。按真实迁移结果重新加入原项目，
  // 保留任务归属验证；不能新建草稿来替代历史任务打开。
  const store = await readHistoryStore(config);
  const ids = new Set<string>();
  for (const taskId of historyTaskIds) {
    const tasks = store.tasks.filter((task) => task.task_id === taskId);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      if (!task.project_id) throw new Error(`${MARKER}: 旧任务 ${taskId} 没有迁移项目归属`);
      ids.add(task.project_id);
    }
  }
  let first = true;
  for (const id of ids) {
    const project = store.projects.find((project) => project.project_id === id);
    if (
      !project ||
      !store.roots.some((root) => root.project_id === id && root.root_path === path)
    ) {
      throw new Error(`${MARKER}: 旧任务项目或原目录丢失`);
    }
    if (!first) await openSSHSourceDirectory(config, MARKER);
    first = false;
    await browser.waitUntil(
      () =>
        browser.execute((name) => {
          const buttons = [
            ...document.querySelectorAll<HTMLButtonElement>('[data-testid="remote-project-pick"]'),
          ].filter((button) => button.textContent?.trim() === name && !button.disabled);
          if (buttons.length !== 1) return false;
          buttons[0]!.click();
          return true;
        }, project.name),
      { timeout: 30_000, timeoutMsg: `${MARKER}: 远端项目列表没有显示原项目` },
    );
    const row = $(`[data-project-id=${JSON.stringify(id)}]`);
    await row.waitForDisplayed();
    const toggle = row.$('[data-testid="virtual-project-toggle"]');
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
}

async function selectMigratedTask(taskId: string, facts: Record<string, unknown>) {
  const taskTestId = testId(TID_TASK_ITEM, taskId);
  const selector = `[data-testid=${JSON.stringify(taskTestId)}]`;
  const rows = await browser.execute(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((row) => row.getClientRects().length > 0)
        .map((row) => {
          const project = row.closest<HTMLElement>("[data-project-id]");
          return {
            projectId: project?.dataset.projectId,
            identity: project?.dataset.projectWorkspaceIdentity,
            connectionState: project?.dataset.connectionState,
          };
        }),
    selector,
  );
  facts.migratedTaskNavigation = { taskId, rows };
  expect(rows).toHaveLength(1);
  expect(rows[0]?.projectId).toBeTruthy();
  const row = $(`[data-project-id=${JSON.stringify(rows[0]!.projectId)}]`).$(selector);
  // 保留真实旧任务身份；项目内可见行的指针点击排除旧缓存行或 DOM click 的歧义。
  await row.click();
  try {
    await waitForV4Pane((pane) => pane.sessionId === taskId, `${MARKER}: 迁移后的原任务未打开`);
  } finally {
    facts.migratedTaskNavigation = {
      taskId,
      rows,
      after: await browser.execute(() => {
        const state = (
          window as Window & {
            __zcodeTabStoreE2E?: {
              getState(): {
                activeWorkspaceIdentity?: string | null;
                tabs?: Array<{ workspaceIdentity?: string; remoteSessionId?: string }>;
              };
            };
          }
        ).__zcodeTabStoreE2E?.getState();
        return {
          activeIdentity: state?.activeWorkspaceIdentity,
          tabs: state?.tabs?.map((tab) => ({
            identity: tab.workspaceIdentity,
            sessionId: tab.remoteSessionId,
          })),
          panes: [...document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]')]
            .filter((pane) => pane.getClientRects().length > 0)
            .map((pane) => ({ id: pane.dataset.testid, sessionId: pane.dataset.sessionId })),
        };
      }),
    };
  }
}

describe(`${MARKER}: staging 自然历史升级与回退`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = { scenario, stagingCommit: STAGING_COMMIT };
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "upgrade-history.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it(`SSH-GUIDE-HISTORY ${scenario}: 旧程序产生历史，当前版可打开续聊，单线路回退仍可使用`, async function () {
    this.timeout(25 * 60_000);
    const stagingBase = process.env.R3_STAGING_SERVER_BASE;
    if (!stagingBase)
      throw new Error("BLOCKED_ENV: 需要已验真的 staging Desktop、Server、Agent 构建");
    expect((await readFile(join(stagingBase, ".deployed-commit"), "utf8")).trim()).toBe(
      STAGING_COMMIT,
    );
    await readFile(join(stagingBase, "packages/desktop/out/main/index.js"));
    const prepared = await prepareSSHLifecycle(MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const currentBase = resolve(import.meta.dirname, "../../../../../../../../..");
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: () => replaceRunApplication(stagingBase),
    });
    await waitForRendererAfterColdRestart(MARKER);
    const first = await createStagingHistory(
      prepared.config,
      provider,
      "A",
      prepared.config.workspacePaths[0],
    );
    const histories = [first];
    if (scenario !== "single")
      histories.push(
        await createStagingHistory(
          { ...prepared.config, host: "localhost" },
          provider,
          "B",
          prepared.config.workspacePaths[0],
        ),
      );
    facts.stagingHistories = histories.map((task) => ({
      identity: task.identity,
      taskId: task.taskId,
      prompt: task.firstPrompt,
    }));
    await browser.saveScreenshot(join(artifactDir, "staging-history.png"));

    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        if (conflictScenario)
          facts.syntheticConflict = await readHistoryStore(
            prepared.config,
            scenario,
            first.taskId,
            histories[1]!.taskId,
          );
        await replaceRunApplication(currentBase);
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    if (conflictScenario) {
      // 两份旧程序自然历史之上合成身份矛盾；只用于稳定验证冲突处理，不冒充自然重复数据。
      await openCurrentDirectory(prepared.config, prepared.config.workspacePaths[1]);
      await openCurrentDirectory(prepared.config, first.workspacePath, true);
      await browser.waitUntil(
        async () => /冲突|conflict/iu.test(await $('[data-testid="ssh-error"]').getText()),
        { timeout: 60_000 },
      );
      await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        )
          .find((button) => button.innerText.trim() === "关闭")
          ?.click(),
      );
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            // RDUX-13：连接历史提醒在设备行展开区；行上只显示警告图标与数量，先展开收起的设备行。
            for (const toggle of document.querySelectorAll<HTMLElement>(
              '[data-source-server-toggle][aria-expanded="false"]',
            ))
              toggle.click();
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
            ).find((button) => button.innerText.includes("连接历史需要处理"));
            button?.click();
            return Boolean(button);
          }),
        { timeout: 30_000 },
      );
      const beforeRetry = await readHistoryStore(prepared.config);
      const backupsBeforeRetry = await listMigrationBackups(prepared.config);
      // 先留证再断言，失败时能区分场景退化、重复建账和备份。
      facts.conflictBeforeRetry = { beforeRetry, backupsBeforeRetry };
      expect(beforeRetry.ledgers.some((ledger) => ledger.status === "failed")).toBe(true);
      const injected = (facts.syntheticConflict as Awaited<ReturnType<typeof readHistoryStore>>)
        .injected;
      if (injected) {
        // 防止场景退化成 canonical/source 冲突：canonical 必须是不含该任务的第二条线路。
        expect([...new Set(beforeRetry.ledgers.map((ledger) => ledger.canonical_key))]).toEqual([
          injected.canonicalKey,
        ]);
      }
      // 身份冲突必须在建账和备份前发现：重复打开只复用同一失败 ledger，不复制两库。
      expect({ ledgers: beforeRetry.ledgers.length, backupsBeforeRetry }).toEqual({
        ledgers: 1,
        backupsBeforeRetry: "",
      });
      if (injected) {
        expect(beforeRetry.conflicts).toEqual([
          {
            task_id: first.taskId,
            source_key: injected.sourceKeys[1],
            canonical_key: injected.canonicalKey,
          },
        ]);
      }
      await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
        )
          .find((button) => button.innerText.trim() === "重试合并")
          ?.click(),
      );
      await browser.waitUntil(
        async () => /冲突|conflict/iu.test(await $("[data-settings-content-frame]").getText()),
        { timeout: 30_000 },
      );
      let afterRetry = beforeRetry;
      const originalLedgerUpdated = () =>
        afterRetry.ledgers.some(
          (row) =>
            row.status === "failed" &&
            row.updated_at >
              (beforeRetry.ledgers.find((old) => old.migration_id === row.migration_id)
                ?.updated_at ?? Infinity),
        );
      // 错误文本可以仍是旧结果；必须观察 ledger 的真实重试写入，避免空点击被误计为覆盖。
      // 新建 ledger 也算一次写入，先留下证据再断言，失败时能区分“未重试”和“重复建账”。
      await browser.waitUntil(
        async () => {
          afterRetry = await readHistoryStore(prepared.config);
          return (
            originalLedgerUpdated() || afterRetry.ledgers.length !== beforeRetry.ledgers.length
          );
        },
        { timeout: 30_000, timeoutMsg: `${MARKER}: 点击重试未写入迁移 ledger` },
      );
      const backupsAfterRetry = await listMigrationBackups(prepared.config);
      facts.conflictRetry = { beforeRetry, afterRetry, backupsBeforeRetry, backupsAfterRetry };
      expect(afterRetry.tasks).toEqual(beforeRetry.tasks);
      expect(afterRetry.ledgers.map((ledger) => ledger.migration_id)).toEqual(
        beforeRetry.ledgers.map((ledger) => ledger.migration_id),
      );
      expect(originalLedgerUpdated()).toBe(true);
      expect(backupsAfterRetry).toBe("");
      await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
        )
          .find((button) => button.innerText.trim() === "放弃合并")
          ?.click(),
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
            ).find(
              (button) => /放弃|保留|Abandon|Keep/iu.test(button.innerText) && !button.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000 },
      );
      let afterAbandon = afterRetry;
      await browser.waitUntil(
        async () => {
          afterAbandon = await readHistoryStore(prepared.config);
          return afterAbandon.ledgers.some((ledger) => ledger.status === "abandoned");
        },
        { timeout: 30_000 },
      );
      expect(afterAbandon.tasks).toEqual(beforeRetry.tasks);
      facts.conflictReportAndRecovery = { beforeRetry, afterRetry, afterAbandon };
      await browser.saveScreenshot(join(artifactDir, "conflict-abandoned.png"));
      expect((await readSettings()).sourceServers?.length).toBeGreaterThan(0);
      return;
    }
    // 升级后的保留页签可能等待处理，没有可创建草稿的 pane；从项目入口继续原目录意图。
    await openCurrentDirectory(
      prepared.config,
      first.workspacePath,
      false,
      histories.map((task) => task.taskId),
    );
    await selectMigratedTask(first.taskId, facts);
    const upgraded = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedPath: first.workspacePath,
    });
    expect(parseRemoteWorkspaceIdentity(upgraded.workspaceIdentity!)?.sourceServerId).toBeTruthy();
    for (const task of histories) {
      if (task.taskId !== first.taskId) await selectMigratedTask(task.taskId, facts);
      // 会话切换先发布 taskId，历史正文随后加载；按可见正文等待，不能立即读空数组判历史丢失。
      await waitForV4TimelineContaining(task.firstPrompt, 60_000);
      expect(
        (await getV4Messages("user")).some((message) => message.text?.includes(task.firstPrompt)),
      ).toBe(true);
      task.identity = upgraded.workspaceIdentity!;
      task.remoteSessionId = upgraded.remoteSessionId!;
      await sendSSHFollowTurn(task, MARKER, histories.find((other) => other !== task)?.firstPrompt);
    }
    facts.currentHistoriesContinued = histories.map((task) => task.taskId);
    if (scenario === "merge") {
      const store = await readHistoryStore(prepared.config);
      expect(store.ledgers.some((ledger) => ledger.status === "completed")).toBe(true);
      const backups = await runSSHCommand(
        prepared.config,
        'find "$HOME/.zcode/server/migration-backups" -name tasks-index.sqlite -type f',
      );
      expect(backups.stdout.trim()).not.toBe("");
      facts.mergeLedgerAndBackups = store;
    }
    await browser.saveScreenshot(join(artifactDir, "upgraded-history.png"));
    if (scenario === "single" || scenario === "merge") {
      await reloadElectronSessionPreservingBrowserProfile(browser, {
        afterElectronProcessExit: () => replaceRunApplication(stagingBase),
      });
      await waitForRendererAfterColdRestart(MARKER);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      // 返回主界面仍由实际旧 UI 完成；设置页用于证明旧应用已启动，不借当前页面留存冒充回退。
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      // 旧版没有新版 Source 启动静默重连，回退后须按旧用户流程实际连接原目录再核对历史。
      // 回退后的项目 DOM 属于旧程序；连接只需要旧版草稿，不能复用新版项目行 helper。
      await startNewV4Draft();
      await openStagingDirectory(prepared.config, first.workspacePath);
      await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: buildRemoteWorkspaceIdentity(first.workspacePath, {
          kind: "ssh",
          host: prepared.config.host,
          port: prepared.config.port,
          username: prepared.config.username,
        }),
        expectedPath: first.workspacePath,
      });
      if (scenario === "single") {
        await selectV4TaskById(first.taskId);
        await waitForV4TimelineContaining(first.firstPrompt, 60_000);
        expect(
          (await getV4Messages("user")).some((message) =>
            message.text?.includes(first.firstPrompt),
          ),
        ).toBe(true);
        const marker = `${MARKER}_ROLLBACK_FOLLOW_PROMPT`;
        await sendV4PromptAndWaitAccepted(
          `${marker}: 只回复 SSH_UPGRADE_HISTORY_REPLY`,
          marker,
          "回退后不能续聊原任务",
        );
        await waitForV4ConversationState(
          (state) => state.taskId === first.taskId && state.state === "idle",
          "回退后的续聊未完成",
        );
        facts.rollbackContinued = true;
      } else {
        // 多线路允许旧视图缺少被合并历史，但实际回退读取不能删除合并后的原任务数据。
        const visibleIds = () =>
          browser.execute(() =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="task-item-"]')).map(
              (item) => item.dataset.testid!.slice("task-item-".length),
            ),
          );
        facts.rollbackFirstRouteVisibleTaskIds = await visibleIds();
        await browser.saveScreenshot(join(artifactDir, "merged-rollback-first-route.png"));
        await startNewV4Draft();
        await openStagingDirectory({ ...prepared.config, host: "localhost" }, first.workspacePath);
        await waitForRemoteTab({
          caseMarker: MARKER,
          expectedIdentity: buildRemoteWorkspaceIdentity(first.workspacePath, {
            kind: "ssh",
            host: "localhost",
            port: prepared.config.port,
            username: prepared.config.username,
          }),
          expectedPath: first.workspacePath,
        });
        facts.rollbackOtherRouteVisibleTaskIds = await visibleIds();
        const afterRollback = await readHistoryStore(prepared.config);
        for (const task of histories)
          expect(afterRollback.tasks.some((row) => row.task_id === task.taskId)).toBe(true);
        facts.mergedDataPreservedAfterActualRollback = afterRollback;
        await browser.saveScreenshot(join(artifactDir, "merged-rollback-other-route.png"));
      }
    }
  });
});
