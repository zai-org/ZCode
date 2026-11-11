import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { openProjectFileTree, startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

// 生产 bundle 会压缩函数名；按生产组件的独有 props 形状识别内容层，不依赖函数名。
// 在 React 启动前装配只读 commit hook；同一 Fiber 的 bailout 不重复计数。
const probe = `(() => {
 const seen = new WeakMap();
 const sample = window.__sidebarSelection = { projects: {}, rows: {}, unmounts: 0, changes: [] };
 const kind = f => typeof f.type === 'function' && (f.memoizedProps?.project &&
   'setActivatorNodeRef' in f.memoizedProps && 'editable' in f.memoizedProps ? 'projects' :
   f.memoizedProps?.task && 'showFiles' in f.memoizedProps && 'variant' in f.memoizedProps ? 'rows' : null);
 window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, inject: () => 1,
  onCommitFiberUnmount(_id, f) { if (kind(f)) sample.unmounts++; },
  onCommitFiberRoot(_id, root) {
   const walk = f => {
    if (!f) return;
    const group = kind(f);
    if (group) {
     const previous = seen.get(f) || seen.get(f.alternate);
     if (f.flags & 1 && previous !== f) {
      const p = f.memoizedProps;
      const key = group === 'projects' ? p.project.id : (p.task.workspaceIdentity || p.task.workspacePath) + ':' + p.task.taskId;
      sample[group][key] = (sample[group][key] || 0) + 1;
      if (group === 'projects') {
       const old = f.alternate?.memoizedProps || {};
       sample.changes.push({ key, props: Object.keys(p).filter(k => !Object.is(p[k], old[k])),
        tasks: (p.tasks || []).map(task => {
         const previous = (old.tasks || []).find(t => t.taskId === task.taskId);
         return { id: task.taskId, unreadBefore: previous?.unreadAt ?? null, unreadAfter: task.unreadAt ?? null,
          fields: [...new Set([...Object.keys(task), ...Object.keys(previous || {})])].filter(k => !Object.is(task[k], previous?.[k])) };
        }).filter(t => t.fields.length) });
      }
     }
     seen.set(f, f); if(f.alternate) seen.set(f.alternate, f);
    }
    walk(f.child); walk(f.sibling);
   }; walk(root.current);
  }
 };
})()`;
type ProjectChange = {
  key: string;
  props: string[];
  tasks: {
    id: string;
    fields: string[];
    unreadBefore: number | null;
    unreadAfter: number | null;
  }[];
};
type Counts = {
  projects: Record<string, number>;
  rows: Record<string, number>;
  unmounts: number;
  changes: ProjectChange[];
};
const readCounts = () =>
  browser.execute(() => structuredClone((window as any).__sidebarSelection) as Counts);
const changed = (before: Record<string, number>, after: Record<string, number>) =>
  Object.keys(after)
    .filter((key) => after[key] !== before[key])
    .sort();

async function enableProbe() {
  await browser.electron.execute(async (electron, source) => {
    const target = electron.BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!target) throw new Error("Renderer unavailable");
    const debug = target.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
    target.webContents.reload();
  }, probe);
  // reload 发起后立即 detach 会清掉 CDP 的预注入脚本；确认新文档已装配后再释放。
  await browser.waitUntil(
    () => browser.execute(() => Boolean((window as any).__sidebarSelection)),
    {
      timeout: 30000,
      timeoutMsg: "The renderer must install the commit probe before React starts",
    },
  );
  await browser.electron.execute((electron) => {
    const target = electron.BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes("/renderer/index.html"),
    );
    target?.webContents.debugger.detach();
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
  await browser.waitUntil(async () => Object.keys((await readCounts()).projects).length >= 44, {
    timeout: 30000,
    timeoutMsg: "44 project content instances must be observed before measurement",
  });
}

const out = process.env.ZCODE_E2E_ARTIFACT_DIR!;
describe("SPT08 full App session selection rendering", () => {
  after(async () => {
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("switches real sessions without rerendering unrelated projects or rows", async function () {
    this.timeout(180000);
    await mkdir(out, { recursive: true });
    await prepareV4ConversationE2E();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      // 首条也从项目入口创建；全局初始草稿可能未归类，新建时会合法切到另一目录。
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await sendV4Prompt(`E2E_SPT08_SESSION_SEED_${index}`);
      await waitForV4TimelineContaining("SPT08_SESSION_READY", 45000);
      const state = await waitForV4ConversationState(
        (state) => Boolean(state.taskId) && state.state === "idle",
        "seed completed",
        45000,
      );
      ids.push(state.taskId!);
    }
    await installHandoffRpcProbe();
    const seededTree = await callHandoffHost<{
      tasks: { taskId: string; projectId?: string | null }[];
    }>(ServiceChannels.Project, "readTree", []);
    for (const id of ids)
      expect(seededTree.tasks.find((task) => task.taskId === id)?.projectId).toBeTruthy();
    // 额外项目通过真实 Host 命令准备，保持模型会话、目录广播与导航 owner 不变。
    for (let index = 0; index < 44; index++)
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        {
          name: `SPT08 Project ${index}`,
          roots: [],
        },
      ]);
    await restoreHandoffProbes();
    await enableProbe();
    const evidence: unknown[] = [];
    const alreadyRead = new Set<string>();
    try {
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute((value) => (window as any).__testActions.setTheme(value), theme);
        await startDraftFromProject(DEFAULT_WORKSPACE);
        // 采样窗口用于让草稿初始化收口，不参与产品状态同步，也不判定性能耗时。
        await browser.pause(700);
        let before = await readCounts();
        let previous: string | null = null;
        for (const id of [ids[0]!, ids[1]!, ids[0]!, ids[1]!, ids[0]!]) {
          await selectV4TaskById(id);
          await waitForV4ConversationState(
            (state) => state.taskId === id && state.state === "idle",
            "selected session ready",
            30000,
          );
          await browser.pause(300);
          const after = await readCounts();
          const sample = {
            theme,
            id,
            projects: changed(before.projects, after.projects),
            rows: changed(before.rows, after.rows),
            unmounts: after.unmounts - before.unmounts,
            changes: after.changes.slice(before.changes.length),
          };
          evidence.push(sample);
          // 首次打开未读会话会清除 Host 的 unreadAt；它只应更新所属项目。
          // 同一会话再次切换已无数据变化，项目内容必须零更新，不能吞掉真实未读更新来过断言。
          if (alreadyRead.has(id)) expect(sample.projects).toEqual([]);
          for (const change of sample.changes) {
            expect(change.tasks).toHaveLength(1);
            expect(change.tasks[0]).toMatchObject({ id, unreadAfter: null });
            expect(typeof change.tasks[0]!.unreadBefore).toBe("number");
            expect(change.tasks[0]!.fields).toContain("unreadAt");
          }
          expect(sample.rows).toEqual(
            [
              ...(previous ? [`${DEFAULT_WORKSPACE}:${previous}`] : []),
              `${DEFAULT_WORKSPACE}:${id}`,
            ].sort(),
          );
          expect(sample.unmounts).toBe(0);
          before = after;
          previous = id;
          alreadyRead.add(id);
        }
        // 复现首次从历史会话补开 tab 后缺少分类的状态；新建入口应自行补全，不能带动全列。
        await browser.execute((path) => {
          const store = (window as any).__zcodeTabStoreE2E;
          store.setState((state: any) => ({
            tabs: state.tabs.map((tab: any) =>
              tab.workspacePath === path ? { ...tab, workspacePurpose: undefined } : tab,
            ),
          }));
        }, DEFAULT_WORKSPACE);
        await browser.pause(300);
        const beforeDraft = await readCounts();
        await browser.$('[data-testid="task-new-button"]').click();
        await waitForV4ConversationState((state) => !state.taskId, "new draft ready", 30000);
        await browser.waitUntil(
          () =>
            browser.execute((path) => {
              const state = (window as any).__zcodeTabStoreE2E.getState();
              return (
                state.tabs.find((tab: any) => tab.workspacePath === path)?.workspacePurpose ===
                "project"
              );
            }, DEFAULT_WORKSPACE),
          { timeout: 10000, timeoutMsg: "New draft must fill the workspace classification" },
        );
        await browser.pause(700);
        const afterDraft = await readCounts();
        const draftSample = {
          theme,
          id: "new-draft-with-workspace-classification",
          projects: changed(beforeDraft.projects, afterDraft.projects),
          rows: changed(beforeDraft.rows, afterDraft.rows),
          unmounts: afterDraft.unmounts - beforeDraft.unmounts,
          changes: afterDraft.changes.slice(beforeDraft.changes.length),
        };
        evidence.push(draftSample);
        expect(draftSample.projects).toEqual([]);
        expect(draftSample.rows).toEqual([`${DEFAULT_WORKSPACE}:${previous}`]);
        expect(draftSample.unmounts).toBe(0);
        await openProjectFileTree(DEFAULT_WORKSPACE);
        await browser.saveScreenshot(join(out, `session-selection-${theme}.png`));
      }
    } finally {
      await writeFile(
        join(out, "session-selection-rendering.json"),
        JSON.stringify(evidence, null, 2),
      );
    }
  });
});
