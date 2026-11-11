// 原因：本用例的回放 Provider 只声明 high/max；保留两个不同合法档位验证配置更新与隔离。
import { subagentUpdateCursor } from "#e2e/helpers/subagent-snapshot-wait";
import { exerciseSubagentHostBranches } from "#e2e/helpers/subagent-host-branches";
import {
  openSubagentHostWindow,
  setHostFaults,
  waitForHostBoundary,
} from "#e2e/helpers/subagent-host-window";
import { writeFile, mkdir, stat, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  sendV4PromptAndWaitAccepted,
  sendV4Prompt,
} from "#e2e/helpers/v4-conversation";
import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
} from "#e2e/helpers/subagent-refresh-conversation";
import { saveRefreshProfile, type RefreshProfile } from "#e2e/helpers/subagent-refresh-settings";
import {
  waitForSubagentRequest,
  readSubagentCapture,
  assertSubagentProfile,
  readChildSessionIds,
  boundaryRpcReads,
  assertChildTrajectory,
} from "#e2e/helpers/subagent-refresh-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "#e2e/helpers/upstream-provider";
import {
  assertProviderPrefix,
  assertRequestCacheBreakpoint,
  type CapturedPrompt,
} from "#e2e/helpers/provider-prefix";
import { exportPromptTrajectory } from "#e2e/helpers/prompt-trajectory-export";

const old: RefreshProfile = {
  name: "e2e-host-reviewer",
  description: "Host refresh",
  prompt: "E2E_SHI_PROFILE_OLD",
  model: UPSTREAM_MODEL,
  provider: UPSTREAM_PROVIDER_ID,
  effort: "high",
  tools: ["Read"],
};
const updated: RefreshProfile = {
  ...old,
  prompt: "E2E_SHI_PROFILE_NEW",
  model: UPSTREAM_ALTERNATE_MODEL,
  provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
  effort: "max",
  tools: ["Grep"],
};

describe("Subagent 跨真实 Host 失效", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SHR22: 双 Host 消费大小写不同目录的更新及项目目录首次创建、重建", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await useEnglishSubagentSettings();
    const storage = getE2EAppDataPaths().storageRoot;
    const probe = join(storage, "CaseProbe");
    await mkdir(probe);
    try {
      const actual = await stat(probe);
      const alias = await stat(join(storage, "caseprobe")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!alias || actual.dev !== alias.dev || actual.ino !== alias.ino) this.skip();
    } finally {
      await rm(probe, { recursive: true });
    }
    const profile = { ...old, name: "e2e-path-reviewer", prompt: "E2E_SHP_PROFILE_OLD" };
    const next = { ...profile, prompt: "E2E_SHP_PROFILE_NEW" };
    await saveRefreshProfile(profile);
    const initialHandle = await browser.getWindowHandle();
    const projectRoot = join(getE2EAppDataPaths().workspace, ".zcode", "agents");
    await rm(projectRoot, { recursive: true, force: true });
    const root = join(storage, "agents");
    // 两步更名确保实际目录项变为大写；随后启动的 Host 必须从真实目录建立监听。
    await rename(root, root + "-case-tmp");
    await rename(root + "-case-tmp", join(storage, "AGENTS"));
    const nestedName = "e2e-nested-ignored";
    const nestedRoot = join(root, "nested");
    await mkdir(nestedRoot);
    await writeFile(
      join(nestedRoot, `${nestedName}.md`),
      `---\nname: ${nestedName}\ndescription: Nested profile\n---\nNested profile must not be listed.`,
    );
    const windows: Array<Awaited<ReturnType<typeof openSubagentHostWindow>>> = [];
    const sessions: Array<{
      side: string;
      sessionId: string;
      hostPid: number;
      cliPid: number;
      handle: string;
    }> = [];
    try {
      for (const side of ["A", "B"]) {
        const window = await openSubagentHostWindow();
        windows.push(window);
        // 新窗口可能恢复全局草稿；显式选择项目，才能验证项目配置的跨 Host 传播。
        await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);
        await selectUpstreamModel();
        await selectUpstreamThoughtLevel();
        const marker = `E2E_SHP_${side}_SEED`;
        await sendV4PromptAndWaitAccepted(`${marker}: Remember this session.`, marker, marker);
        await finishSubagentTurn(`${marker}_DONE`, 60000);
        const sessionId = (await getV4PaneSnapshot()).sessionId!;
        const rpc = (await boundaryRpcReads()).find(
          (r) => r.sessionId === sessionId && r.kind === "read",
        )!;
        expect(rpc).toBeTruthy();
        sessions.push({
          side,
          sessionId,
          hostPid: rpc.hostPid,
          cliPid: rpc.pid,
          handle: window.handle,
        });
        const seed = await waitForSubagentRequest(`shp-${side.toLowerCase()}-seed`);
        expect(JSON.stringify(seed.requestJson)).toContain(profile.name);
        expect(JSON.stringify(seed.requestJson)).not.toContain(nestedName);
      }
      expect(sessions[0]!.hostPid).not.toBe(sessions[1]!.hostPid);
      expect(sessions[0]!.cliPid).not.toBe(sessions[1]!.cliPid);
      await browser.switchToWindow(sessions[0]!.handle);
      await useEnglishSubagentSettings();
      const published = await subagentUpdateCursor();
      let publicationError: string | undefined;
      try {
        await saveRefreshProfile(next, profile.name);
        await published(
          sessions.map((s) => s.hostPid),
          [`${profile.name}.md`],
        );
      } catch (error) {
        // 仅保留缓存发布超时用于归因，UI 保存失败仍立即失败。后续必须断言新配置。
        if (!String(error).includes("Host 未完成配置文件更新")) throw error;
        publicationError = String(error);
      }
      const disk = await readFile(join(storage, "AGENTS", `${profile.name}.md`), "utf8");
      expect(disk).toContain(next.prompt);
      const children: Array<{
        capture: Awaited<ReturnType<typeof waitForSubagentRequest>>;
        profile: RefreshProfile;
      }> = [];
      const stages = ["NEXT", "CREATED", "REBUILT"] as const;
      for (const [stageIndex, stage] of stages.entries()) {
        const expected = stage === "NEXT" ? next : { ...next, prompt: `E2E_SHP_PROFILE_${stage}` };
        if (stage !== "NEXT") {
          await browser.switchToWindow(sessions[0]!.handle);
          if (stage === "REBUILT") {
            const removed = await subagentUpdateCursor();
            await rm(projectRoot, { recursive: true });
            await removed(
              sessions.map((s) => s.hostPid),
              [projectRoot],
            );
          }
          // 两个 Host 从启动起观察缺失的项目目录；真实 Settings 创建触发目录切换。
          const created = await subagentUpdateCursor();
          await saveRefreshProfile(expected, undefined, {
            workspacePath: getE2EAppDataPaths().workspace,
          });
          await created(
            sessions.map((s) => s.hostPid),
            [projectRoot],
          );
          expect(await readFile(join(projectRoot, `${profile.name}.md`), "utf8")).toContain(
            expected.prompt,
          );
        }
        for (const session of sessions) {
          await browser.switchToWindow(session.handle);
          const marker = `E2E_SHP_${session.side}_${stage}`;
          await sendV4PromptAndWaitAccepted(`${marker}: Launch ${profile.name}.`, marker, marker);
          await finishSubagentTurn(`${marker}_DONE`, 60000);
          expect((await getV4PaneSnapshot()).sessionId).toBe(session.sessionId);
          const id = `shp-${session.side.toLowerCase()}-${stage.toLowerCase()}-child`;
          children.push({ capture: await waitForSubagentRequest(id), profile: expected });
          const childIds = readChildSessionIds(session.sessionId);
          expect(childIds).toHaveLength(stageIndex + 1);
          await assertChildTrajectory(childIds.at(-1)!, [id]);
          const bodies = (await readSubagentCapture())
            .filter((r) =>
              new RegExp(
                `^shp-${session.side.toLowerCase()}-(seed|(?:next|created|rebuilt)-(?:tool|final))$`,
                "u",
              ).test(r.replay?.fixtureId ?? ""),
            )
            .map((r) => r.requestJson as CapturedPrompt);
          const requestCount = 3 + stageIndex * 2;
          expect(bodies).toHaveLength(requestCount);
          for (const body of bodies) expect(JSON.stringify(body)).not.toContain(nestedName);
          for (let i = 1; i < bodies.length; i++) assertProviderPrefix(bodies[i - 1]!, bodies[i]!);
          const trajectory = await exportPromptTrajectory(
            session.sessionId,
            `subagent-path-${session.side}-${stage}`,
          );
          expect(trajectory.trajectories).toEqual([
            expect.objectContaining({ reason: "initial", requestCount }),
          ]);
        }
      }
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "subagent-path-evidence.json"),
        JSON.stringify(
          {
            sessions,
            disk,
            publicationError,
            requests: children.map(({ capture, profile }) => ({
              id: capture.replay?.fixtureId,
              request: capture.requestJson,
              expected: profile,
            })),
          },
          null,
          2,
        ),
      );
      // 先采集两个 Host 的完整请求及轨迹，再一起报告配置断言，避免 A 的失败遮住 B。
      const failures: string[] = [];
      for (const { capture: child, profile: expected } of children) {
        try {
          assertRequestCacheBreakpoint(child.requestJson as CapturedPrompt);
          assertSubagentProfile(child, expected);
        } catch (error) {
          failures.push(`${child.replay?.fixtureId}: ${String(error)}`);
        }
      }
      expect(failures).toEqual([]);
      expect(publicationError).toBeUndefined();
    } finally {
      for (const window of windows)
        await browser.electron.execute(
          (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
          window.windowId,
        );
      await rm(projectRoot, { recursive: true, force: true });
      await browser.switchToWindow(initialHandle);
      await rm(nestedRoot, { recursive: true, force: true });
      await rename(join(storage, "AGENTS"), root + "-case-tmp");
      await rename(root + "-case-tmp", root);
    }
  });
  it("SHR16/SHR18-SHR21: 双 Host 的目录、覆盖、失效故障、并发和销毁边界", async function () {
    this.timeout(600000);
    await prepareV4ConversationE2E();
    await useEnglishSubagentSettings();
    await saveRefreshProfile(old);
    await turn("A_SEED");
    const a = (await getV4PaneSnapshot()).sessionId!;
    const aHandle = await browser.getWindowHandle();
    const { windowId: bWindowId, handle: bHandle } = await openSubagentHostWindow();
    try {
      await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);
      await selectUpstreamModel();
      await selectUpstreamThoughtLevel();
      await turn("B_SEED");
      const b = (await getV4PaneSnapshot()).sessionId!;
      expect(b).not.toBe(a);
      const childId = readChildSessionIds(b)[0]!;
      expect(childId).toBeTruthy();
      assertSubagentProfile(await waitForSubagentRequest("shi-b-seed-child"), old);
      const rpc = await boundaryRpcReads();
      const aRead = rpc.find((r) => r.sessionId === a && r.kind === "read")!;
      const bRead = rpc.find((r) => r.sessionId === b && r.kind === "read")!;
      expect(aRead.hostPid).not.toBe(bRead.hostPid);
      expect(aRead.pid).not.toBe(bRead.pid);
      await send("B_HOLD");
      await browser.waitUntil(
        async () =>
          (await readSubagentCapture()).some((r) => r.replay?.fixtureId === "shi-b-hold-tool"),
        { timeout: 30000 },
      );
      const published = await subagentUpdateCursor();
      await browser.switchToWindow(aHandle);
      await saveRefreshProfile(updated, old.name);
      await published([aRead.hostPid, bRead.hostPid]);
      await browser.switchToWindow(bHandle);
      assertSubagentProfile(await waitForSubagentRequest("shi-b-hold-child"), old);
      await finish("B_HOLD");
      await browser.switchToWindow(aHandle);
      await turn("A_NEXT");
      assertSubagentProfile(await waitForSubagentRequest("shi-a-next-child"), updated);
      expect((await getV4PaneSnapshot()).sessionId).toBe(a);
      await browser.switchToWindow(bHandle);
      await turn("B_RESUME");
      assertSubagentProfile(await waitForSubagentRequest("shi-b-resume-child"), updated);
      expect(readChildSessionIds(b)).toEqual([childId]);
      await turn("B_SPAWN");
      assertSubagentProfile(await waitForSubagentRequest("shi-b-spawn-child"), updated);
      expect(readChildSessionIds(b)).toHaveLength(2);
      const bodies = (await readSubagentCapture())
        .filter((r) =>
          /^shi-b-(seed|hold|resume|spawn)-(tool|final|notification)$/u.test(
            r.replay?.fixtureId ?? "",
          ),
        )
        .map((r) => r.requestJson as CapturedPrompt);
      expect(bodies).toHaveLength(10);
      for (let i = 1; i < bodies.length; i++) assertProviderPrefix(bodies[i - 1]!, bodies[i]!);
      const trajectory = await exportPromptTrajectory(b, "subagent-cross-host-parent");
      expect(trajectory.trajectories).toEqual([
        expect.objectContaining({ reason: "initial", requestCount: 10 }),
      ]);
      for (const id of [
        "shi-b-seed-child",
        "shi-b-hold-child",
        "shi-b-resume-child",
        "shi-b-spawn-child",
      ])
        assertRequestCacheBreakpoint(
          (await waitForSubagentRequest(id)).requestJson as CapturedPrompt,
        );
      await assertChildTrajectory(childId, [
        "shi-b-seed-child",
        "shi-b-hold-child",
        "shi-b-resume-child",
      ]);
      const allReads = (await boundaryRpcReads()).filter(
        (r) => r.sessionId === b && r.kind === "read",
      );
      // 初始化一次，四个用户 turn 加两次后台完成通知；工具后的请求不重复读取。
      expect(allReads).toHaveLength(1 + 6);
      expect(new Set(allReads.map((r) => r.pid))).toEqual(new Set([bRead.pid]));
      const aReads = (await boundaryRpcReads()).filter(
        // 新窗口可能先恢复 A；该 Host 的初始化读取不属于原 Host 的父轮计数。
        (r) => r.sessionId === a && r.hostPid === aRead.hostPid && r.kind === "read",
      );
      expect(aReads).toHaveLength(1 + 2);
      expect(new Set(aReads.map((r) => r.pid))).toEqual(new Set([aRead.pid]));
      const aBodies = (await readSubagentCapture())
        .filter((r) => /^shi-a-(seed|next-tool|next-final)$/u.test(r.replay?.fixtureId ?? ""))
        .map((r) => r.requestJson as CapturedPrompt);
      expect(aBodies).toHaveLength(3);
      for (let i = 1; i < aBodies.length; i++) assertProviderPrefix(aBodies[i - 1]!, aBodies[i]!);
      const aTrajectory = await exportPromptTrajectory(a, "subagent-cross-host-a-parent");
      expect(aTrajectory.trajectories).toEqual([
        expect.objectContaining({ reason: "initial", requestCount: 3 }),
      ]);
      const latest = await exerciseSubagentHostBranches(
        {
          a: { handle: aHandle, sessionId: a, hostPid: aRead.hostPid, cliPid: aRead.pid },
          b: { handle: bHandle, sessionId: b, hostPid: bRead.hostPid, cliPid: bRead.pid },
        },
        old,
        updated,
      );
      // 后台文件重载不再挂住 RPC；通过测试侧 stdio 代理挂起请求，保留断连取消的原始断言。
      // 退出是 E2E 的生命周期屏障；迟到 Promise 不能回填的细粒度断言由缓存单测负责。
      const disposalProfile = { ...latest, prompt: "E2E_SHB_COLD_PROFILE" };
      const file = join(getE2EAppDataPaths().storageRoot, "agents", `${old.name}.md`);
      await setHostFaults({
        files: [{ id: "dispose", operation: "readFile", path: file, action: "hold", once: true }],
      });
      await browser.switchToWindow(aHandle);
      await saveRefreshProfile(disposalProfile, old.name);
      await waitForHostBoundary("file-held", "dispose");
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "subagent-config-control.json"),
        JSON.stringify({ heldSessionIds: [b] }),
      );
      const beforeClosing = (await boundaryRpcReads()).filter(
        (r) => r.sessionId === b && r.kind === "read",
      ).length;
      await browser.switchToWindow(bHandle);
      await sendV4Prompt("E2E_SHB_CLOSE_WAIT: Await configuration before executing.");
      await browser.waitUntil(
        async () =>
          (await boundaryRpcReads()).filter((r) => r.sessionId === b && r.kind === "read")
            .length ===
          beforeClosing + 1,
        { timeout: 15000 },
      );
      await browser.waitUntil(
        async () => (await boundaryRpcReads()).some((r) => r.sessionId === b && r.kind === "held"),
        { timeout: 15000 },
      );
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
        bWindowId,
      );
      await browser.waitUntil(
        () => {
          try {
            process.kill(bRead.hostPid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        },
        { timeout: 15000, timeoutMsg: "待配置读取的 Host 未退出" },
      );
      await setHostFaults({ released: ["dispose"] });
      const requestsAfterClose = (await readSubagentCapture()).filter((r) =>
        JSON.stringify(r.requestJson).includes("E2E_SHB_CLOSE_WAIT:"),
      );
      // 新窗口首次准备不依赖早先是否收到通知，直接加载磁盘最新配置。
      const cold = await openSubagentHostWindow();
      try {
        await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);
        await selectUpstreamModel();
        await selectUpstreamThoughtLevel();
        await sendV4PromptAndWaitAccepted(
          "E2E_SHB_COLD_START: Launch the current reviewer.",
          "E2E_SHB_COLD_START",
          "未接收 cold start",
        );
        await finishSubagentTurn("E2E_SHB_COLD_START_DONE", 60000);
        const coldSession = (await getV4PaneSnapshot()).sessionId!;
        assertSubagentProfile(
          await waitForSubagentRequest("shb-cold_start-child"),
          disposalProfile,
        );
        const coldReads = (await boundaryRpcReads()).filter(
          (r) => r.sessionId === coldSession && r.kind === "read",
        );
        // 新 Host 上的 session 同样先初始化，再为首个父轮读取快照。
        expect(coldReads).toHaveLength(1 + 1);
        expect([aRead.hostPid, bRead.hostPid]).not.toContain(coldReads[0]!.hostPid);
        expect([aRead.pid, bRead.pid]).not.toContain(coldReads[0]!.pid);
        const exported = await exportPromptTrajectory(coldSession, "subagent-host-cold-start");
        expect(exported.trajectories).toEqual([
          expect.objectContaining({ reason: "initial", requestCount: 2 }),
        ]);
        await assertChildTrajectory(readChildSessionIds(coldSession)[0]!, ["shb-cold_start-child"]);
      } finally {
        await browser.electron.execute(
          (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
          cold.windowId,
        );
      }
      // 先完成独立的冷启动验证，再报告关闭分支；保留失败断言，不让一个失败掩盖后续未执行场景。
      expect(requestsAfterClose).toHaveLength(0);
    } finally {
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
        bWindowId,
      );
      await browser.switchToWindow(aHandle);
    }
  });
});
async function send(stage: string) {
  const marker = `E2E_SHI_${stage}`;
  await sendV4PromptAndWaitAccepted(
    `${marker}: ${stage === "A_SEED" ? "Remember this session." : stage === "B_HOLD" || stage === "B_RESUME" ? "Resume the existing subagent using SendMessage." : `Launch ${old.name}.`}`,
    marker,
    `未接收 ${marker}`,
  );
}
const finish = (stage: string) =>
  finishSubagentTurn(
    `E2E_SHI_${stage}_${stage === "B_HOLD" || stage === "B_RESUME" ? "SETTLED" : "DONE"}`,
    90000,
  );
async function turn(stage: string) {
  await send(stage);
  await finish(stage);
}
