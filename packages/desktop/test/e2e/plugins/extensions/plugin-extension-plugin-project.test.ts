// PLM-EXT-P3C2：扩展不指定项目建会话时放进插件项目（docs/plugins/extension-host.md §17.4 实现 P3c-2、§18.1 H7、
// §17.10 第 3 步）。
// 隔离 HOME：
// - 纯 JS fixture 扩展 e2e-ext-projects（test/e2e/fixtures/fs/plugins/plugin-extension-projects/）经 plugins.dirs
//   加载，清单声明 sessions.write；授权记录预先写进隔离 HOME 的 grants.json（授权流程由 PLM-EXT-P3A 覆盖）。
//   它在输入框状态栏有一个命令：每次点击读一次用例写的步骤文件，按顺序执行操作（写 AGENTS.md、并发的一组
//   ctx.sessions.* 操作、单个操作），结果写日志。
// - 模型用 replay（plugin-extension-plugin-project.json）：首发夹具要求请求体里有 AGENTS.md 的标记。
// 运行时证据：Main 日志（fixture 的 E2E_PROJECTS_*）、Window Host 项目树、侧栏 DOM、截图。
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { EXTENSION_SESSION_CONSENT_REVISION } from "@zcode/shared/extension-host";
import type { ProjectTree, VirtualProject } from "@zcode/services";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  createExtensionLog,
  waitForSlot,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  prepareV4ConversationE2E,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P3C2";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-projects",
);
const PLUGIN = "e2e-ext-projects";
const PLUGIN_ID = `${PLUGIN}@inline`;
const SLOT_ITEM = `${PLUGIN_ID}/run`;
const AGENTS_MARKER = "E2E_P3C2_AGENTS_MARKER_7f3a";
const PROMPTS = {
  first: "E2E_P3C2_FIRST: reply with the persona marker.",
  second: "E2E_P3C2_SECOND: reply with the second marker.",
  later: "E2E_P3C2_LATER: reply with the later marker.",
  recreated: "E2E_P3C2_RECREATED: reply with the recreated marker.",
} as const;
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd();

interface CreateResult {
  creation?: string;
  firstInput?: string;
  session?: { sessionId: string; workspacePath: string; project?: { projectId: string } };
}
interface Op {
  name: string;
  input?: Record<string, unknown>;
  ops?: Op[];
}
interface OpResult {
  ok?: CreateResult & Record<string, unknown>;
  error?: string;
}

const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const log = createExtensionLog();
let seq = 0;

function fixturesDir(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-projects");
}

function extensionsDataPath(...parts: string[]): string {
  return join(resolveE2EStorageRoot(), "v2", "extensions", ...parts);
}

async function seedPlugin(): Promise<void> {
  const target = fixturesDir();
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  await writePluginDirsConfig([join(target, PLUGIN)], [PLUGIN_ID]);
  await mkdir(extensionsDataPath(), { recursive: true });
  await writeFile(
    extensionsDataPath("grants.json"),
    JSON.stringify({
      version: 1,
      plugins: {
        [PLUGIN_ID]: {
          grants: ["sessions.write"],
          consentedVersion: "1.0.0",
          consentedAt: Date.now(),
          // 当前的会话档位含义（§17.12）：没有这个字段的旧记录要重新确认，迁移由 PLM-EXT-P3E 覆盖。
          consentRevision: EXTENSION_SESSION_CONSENT_REVISION,
        },
      },
    }),
  );
}

async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
  timeout = 60000,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await log.lines()).slice(from).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout, interval: 300, timeoutMsg: message },
  );
  return found;
}

/** 写步骤文件，点状态栏命令，等这一步执行完；结果按「序号.并发内序号」返回。 */
async function runStep(label: string, ops: Op[]): Promise<Record<string, OpResult>> {
  seq += 1;
  const current = seq;
  await writeFile(
    join(fixturesDir(), "e2e-ext-projects-step.json"),
    JSON.stringify({ seq: current, ops }),
  );
  const from = (await log.lines()).length;
  await waitForSlot(SLOT_ITEM, (slot) => slot.text.includes("E2E projects"), "the run slot");
  await clickSlot(SLOT_ITEM);
  await waitForLogAfter(
    from,
    (line) => line.includes(`E2E_PROJECTS_DONE seq=${current}`),
    `${label}: the extension should finish step ${current}`,
    120000,
  );
  const results: Record<string, OpResult> = {};
  for (const line of (await log.lines()).slice(from)) {
    const match = new RegExp(`E2E_PROJECTS_RESULT seq=${current} index=(\\S+) `).exec(line);
    if (!match) continue;
    const ok = /\bok=(.*)$/.exec(line)?.[1];
    const error = /\berror=(\S+)/.exec(line)?.[1];
    results[match[1]!] = {
      ...(ok !== undefined ? { ok: JSON.parse(ok) as OpResult["ok"] } : {}),
      ...(error ? { error } : {}),
    };
  }
  evidence[`step-${current}-${label}`] = results;
  return results;
}

async function readTree(): Promise<ProjectTree> {
  return callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
}

/** 目录含插件 workspace 的未删除项目（与实现的认定规则相同）。 */
function pluginProjects(tree: ProjectTree, workspace: string): VirtualProject[] {
  return tree.projects.filter(
    (project) =>
      !project.deleted && project.roots.some((root) => normalize(root.rootPath) === workspace),
  );
}

function createdSession(result: OpResult | undefined, label: string) {
  if (!result?.ok) throw new Error(`${label} failed: ${result?.error ?? "no result"}`);
  expect(result.ok).toMatchObject({ creation: "created", firstInput: "accepted" });
  return result.ok.session!;
}

/** 侧栏里这个项目的一行：可见、名字是插件名。 */
async function waitForSidebarProject(projectId: string, message: string): Promise<string> {
  let name = "";
  await browser.waitUntil(
    async () => {
      name = await browser.execute((id) => {
        const section = document.querySelector<HTMLElement>(`section[data-project-id="${id}"]`);
        return section?.dataset.projectName ?? "";
      }, projectId);
      return Boolean(name);
    },
    { timeout: 30000, interval: 300, timeoutMsg: message },
  );
  return name;
}

/** 用户在侧栏移除项目：悬停行 → 「更多」→「删除」（侧栏项目菜单的真实路径）。 */
async function removeProjectFromSidebar(projectId: string): Promise<void> {
  const section = $(`section[data-project-id="${projectId}"]`);
  const row = section.$('[data-testid="virtual-project-row"]');
  await row.scrollIntoView({ block: "center" });
  await row.moveTo();
  await section.$('[data-testid="virtual-project-menu"]').click();
  await $('[data-testid="virtual-project-delete"]').click();
  await section.waitForExist({ reverse: true, timeout: 30000 });
}

describe("PLM-EXT-P3C2 扩展不指定项目建会话时放进插件项目", () => {
  after(async () => {
    evidence.screenshots = screenshots;
    await writeFile(
      join(artifacts, "plm-ext-p3c2-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("并发建会话只建一个插件项目，cwd 是插件 workspace，AGENTS.md 进请求；移除后重新创建", async function () {
    this.timeout(900000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedPlugin();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await log.mark();
      },
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    const activated = await log.waitFor(
      (line) => line.includes(`E2E_PROJECTS_ACTIVATED plugin=${PLUGIN_ID}`),
      "the project fixture should activate",
      90000,
    );
    const dataPath = JSON.parse(/dataPath=(".*")$/.exec(activated)![1]!) as string;
    const workspace = normalize(join(dataPath, "workspace"));
    evidence.dataPath = dataPath;
    await installHandoffRpcProbe();
    expect(pluginProjects(await readTree(), workspace)).toEqual([]);

    // (a) 先在 workspace 写 AGENTS.md，再同时发两个不带项目的 createSession：只建出一个插件项目。
    const first = await runStep("concurrent-create", [
      { name: "writeAgents", input: { marker: AGENTS_MARKER } },
      {
        name: "parallel",
        ops: [
          { name: "createSession", input: { prompt: PROMPTS.first } },
          { name: "createSession", input: { prompt: PROMPTS.second } },
        ],
      },
    ]);
    expect(first["0.0"]?.ok).toMatchObject({ workspace: join(dataPath, "workspace") });
    const sessionA = createdSession(first["1.0"], "the first concurrent create");
    const sessionB = createdSession(first["1.1"], "the second concurrent create");
    const projectId = sessionA.project!.projectId;
    expect(sessionB.project?.projectId).toBe(projectId);
    // H7：会话所在目录就是插件 workspace（项目的唯一目录、主要目录）。
    expect(normalize(sessionA.workspacePath)).toBe(workspace);
    expect(normalize(sessionB.workspacePath)).toBe(workspace);

    let tree = await readTree();
    const projects = pluginProjects(tree, workspace);
    evidence.projectsAfterConcurrentCreate = projects.map(({ id, name, roots }) => ({
      id,
      name,
      roots,
    }));
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: projectId, name: PLUGIN });
    expect(projects[0]!.roots).toEqual([
      expect.objectContaining({ rootPath: workspace, isPrimary: true }),
    ]);
    for (const id of [sessionA.sessionId, sessionB.sessionId])
      expect(tree.tasks.find((task) => task.taskId === id)?.projectId).toBe(projectId);
    expect(
      await waitForSidebarProject(projectId, "the sidebar should show the plugin project"),
    ).toBe(PLUGIN);

    // (b) AGENTS.md 进了请求：首发夹具只在请求体带标记时命中，回复才会出现。
    const opened = await runStep("open-first", [
      { name: "openSession", input: { sessionId: sessionA.sessionId } },
    ]);
    expect(opened["0.0"]?.ok).toMatchObject({ status: "opened" });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionA.sessionId,
      "the desktop should open the first plugin session",
      30000,
    );
    await waitForV4AssistantMessageContaining("E2E_P3C2_AGENTS_SEEN", 90000);
    await waitForSidebarProject(projectId, "the plugin project should stay in the sidebar");
    screenshots.push(await capturePluginManualReview(CASE_ID, "plugin-project-zh-CN-zai-light"));
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    screenshots.push(await capturePluginManualReview(CASE_ID, "plugin-project-en-US-zai-dark"));
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (c) 之后再建一个：复用同一个项目。
    const later = await runStep("later-create", [
      { name: "createSession", input: { prompt: PROMPTS.later } },
    ]);
    const sessionC = createdSession(later["0.0"], "the later create");
    expect(sessionC.project?.projectId).toBe(projectId);
    tree = await readTree();
    expect(pluginProjects(tree, workspace).map((project) => project.id)).toEqual([projectId]);

    // (d) 用户在侧栏移除这个项目；下一次不带项目的 createSession 新建一个插件项目。
    await removeProjectFromSidebar(projectId);
    tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { includeDeleted: true },
    ]);
    expect(tree.projects.find((project) => project.id === projectId)?.deleted).toBe(true);
    const recreated = await runStep("recreate", [
      { name: "createSession", input: { prompt: PROMPTS.recreated } },
    ]);
    const sessionD = createdSession(recreated["0.0"], "the create after removal");
    const newProjectId = sessionD.project!.projectId;
    expect(newProjectId).not.toBe(projectId);
    expect(normalize(sessionD.workspacePath)).toBe(workspace);
    tree = await readTree();
    const after = pluginProjects(tree, workspace);
    evidence.projectsAfterRecreate = after.map(({ id, name }) => ({ id, name }));
    expect(after.map((project) => project.id)).toEqual([newProjectId]);
    expect(after[0]!.name).toBe(PLUGIN);
    expect(
      await waitForSidebarProject(newProjectId, "the sidebar should show the new plugin project"),
    ).toBe(PLUGIN);

    // 日志：建项目各记一次 info（两次新建），不含路径。
    const created = (await log.lines()).filter((line) => line.includes("plugin project created"));
    evidence.createdLogLines = created;
    expect(created).toHaveLength(2);
    expect(JSON.stringify(created)).not.toContain(dataPath);
  });
});
