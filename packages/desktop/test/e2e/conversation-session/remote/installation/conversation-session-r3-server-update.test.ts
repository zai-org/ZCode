import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { prepareSourceServerUpdateArchive } from "#e2e/helpers/source-server-update-fixture";
import {
  disconnectDuringNextSourceUpdate,
  readUpdateDisconnectEvidence,
  restoreUpdateDisconnectProbe,
  updateAndRemoveNonCurrentProfile,
} from "#e2e/helpers/source-server-update-disconnect";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  readTaskRowInProject,
  sendSSHFollowTurn,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_SERVER_UPDATE";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-server-update",
);
const run = promisify(execFile);
const updateScenario = process.env.R3_SERVER_UPDATE_CASE ?? "cancel";

/** 上传/解压期间容器 sshd 在 x64 模拟下会拒绝或拖慢新握手；只读探针改走 docker exec，不经 sshd。 */
async function dockerSh(
  command: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
  if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
  try {
    const result = await run("docker", ["exec", "-u", "dev", container, "bash", "-lc", command], {
      maxBuffer: 1 << 22,
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

async function readRemoteCurrentSha(_config: SSHConnectionConfig): Promise<string> {
  const result = await dockerSh(
    'grep -o \'"archiveSha256": *"[0-9a-f]*"\' "$HOME/.zcode/server/current.json" | grep -o "[0-9a-f]\\{64\\}"',
  );
  return result.stdout.trim();
}

async function readRemoteCoreIdentityViaDocker(): Promise<{
  pid: number;
  supervisorPid: number;
  state: string;
  generation: number;
  startTicks: number;
}> {
  const result = await dockerSh(
    'S="$HOME/.zcode/server/run/status.json"; cat "$S"; echo; P=$(sed -nE \'s/.*"pid": *([0-9]+).*/\\1/p\' "$S" | head -n1); echo "__STAT__ $(awk \'{print $4" "$22}\' /proc/$P/stat)"',
  );
  const statusText = result.stdout.slice(0, result.stdout.indexOf("__STAT__"));
  const status = JSON.parse(statusText) as { pid: number; generation: number; state: string };
  const stat = /__STAT__ (\d+) (\d+)/u.exec(result.stdout);
  if (!stat) throw new Error(`${CASE_MARKER}: 读取远端 Core 身份失败: ${result.stderr}`);
  return {
    pid: status.pid,
    supervisorPid: Number.parseInt(stat[1]!, 10),
    state: status.state,
    generation: status.generation,
    startTicks: Number.parseInt(stat[2]!, 10),
  };
}

/** 远端解压 75MB 期间（x64 模拟）sshd 握手可能超时；轮询中把探针失败当作"尚未就绪"而不是用例失败。 */
async function readRemoteCurrentShaOrNull(config: SSHConnectionConfig): Promise<string | null> {
  try {
    return await readRemoteCurrentSha(config);
  } catch {
    return null;
  }
}

async function readRemoteRuntimeReleaseDirs(_config: SSHConnectionConfig): Promise<string[]> {
  const result = await dockerSh(
    'for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *releases/*) echo "$c" | grep -oE "releases/[^/ ]+" | head -n1;; esac; done | sort | uniq -c',
  );
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe(`${CASE_MARKER}: 同版本异 SHA 更新在 running task 下被守卫，显式强制后换代`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = { scenario: updateScenario, timeline: [] as string[] };
  const mark = async (label: string) => {
    (facts.timeline as string[]).push(`${new Date().toISOString()} ${label}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "server-update.json"), JSON.stringify(facts, null, 2));
  };

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    if (updateScenario === "remove-sibling") {
      facts.finalEvidence = await readUpdateDisconnectEvidence().catch(() => null);
      facts.finalUi = await browser.execute(() => document.body?.innerText ?? "");
      await browser.saveScreenshot(resolve(artifactDir, "source-update.png"));
    }
    await restoreUpdateDisconnectProbe();
    await writeFile(resolve(artifactDir, "server-update.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-UPG-03/04 同版本异 SHA 刷新在 running task 下被守卫且保持可用；任务收口后重连原子切换到新 release", async function () {
    this.timeout(35 * 60_000);
    if (!["cancel", "force", "disconnect", "remove-sibling"].includes(updateScenario))
      throw new Error("未知更新场景");
    if (updateScenario === "remove-sibling") await waitForDefaultWorkspaceReady(30_000);
    if (updateScenario === "remove-sibling") {
      const config = readSSHRuntimeConfig(CASE_MARKER);
      if (!["localhost", "127.0.0.1"].includes(config.host))
        throw new Error(`${CASE_MARKER}: 多线路回归要求本机隔离 SSH 容器`);
      const tabA = await connectSSHWorkspace({
        caseMarker: CASE_MARKER,
        config,
        workspacePath: config.workspacePaths[0],
      });
      const sourceId = parseRemoteWorkspaceIdentity(tabA.workspaceIdentity!)?.sourceServerId;
      const ownerProfileId = (await readSettings()).connectionProfiles?.find(
        (profile) => profile.sourceServerId === sourceId,
      )?.profileId;
      await connectSSHWorkspace({
        caseMarker: CASE_MARKER,
        config: { ...config, host: config.host === "localhost" ? "127.0.0.1" : "localhost" },
        workspacePath: config.workspacePaths[1],
      });
      const shaBefore = await readRemoteCurrentSha(config);
      facts.before = { tabA, sha: shaBefore };
      const repack = await prepareSourceServerUpdateArchive(shaBefore, CASE_MARKER);
      expect(repack.newSha).not.toBe(shaBefore);
      facts.repack = repack;
      const siblingId = (await readSettings()).connectionProfiles?.find(
        (profile) => profile.sourceServerId === sourceId && profile.profileId !== ownerProfileId,
      )?.profileId;
      if (!sourceId || !ownerProfileId || !siblingId)
        throw new Error(`${CASE_MARKER}: 没有建立同一 Source 的两条真实线路`);
      await updateAndRemoveNonCurrentProfile(sourceId, ownerProfileId, {
        profileId: siblingId,
        profileDisplayName: "Update route B",
        sshAuthMethod: "password",
        target: {
          kind: "ssh",
          host: config.host === "localhost" ? "127.0.0.1" : "localhost",
          port: config.port,
          username: config.username,
          password: config.password,
        },
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
      await browser.waitUntil(
        async () => {
          const evidence = await readUpdateDisconnectEvidence();
          if (evidence.savedProfile) expect(evidence.savedProfile.header[0]).toBe(201);
          if (evidence.update && !evidence.sent)
            throw new Error(`${CASE_MARKER}: 更新在取消前结束: ${JSON.stringify(evidence.update)}`);
          return Boolean(
            evidence.cancellation &&
            evidence.update &&
            evidence.states.some(
              (state) => state.profileId === ownerProfileId && state.state === "online",
            ),
          );
        },
        { timeout: 240_000, timeoutMsg: `${CASE_MARKER}: 删除更新线路后原线路没有恢复` },
      );
      const evidence = await readUpdateDisconnectEvidence();
      facts.removeUpdatingSibling = { ownerProfileId, siblingId, ...evidence };
      expect(evidence.cancellation?.header[0]).toBe(201);
      expect(evidence.update?.header[0]).toBe(202);
      expect(evidence.update?.body.name).toBe("SourceServerProfileRemovedError");
      expect(
        evidence.states.some(
          (state) => state.profileId === ownerProfileId && state.state === "retrying",
        ),
      ).toBe(true);
      expect(
        (await readSettings()).connectionProfiles?.some(
          (profile) => profile.profileId === siblingId,
        ),
      ).toBe(false);
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      const recovered = await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: tabA.workspaceIdentity!,
        expectedPath: config.workspacePaths[0],
        requireActive: false,
      });
      expect(recovered.remoteSessionId).not.toBe(tabA.remoteSessionId);
      facts.recovered = recovered;
      await mark("R3-REMOTE-08F-original-owner-recovered-after-sibling-removal");
      return;
    }

    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const shaBefore = await readRemoteCurrentSha(prepared.config);
    const core0 = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    facts.before = {
      sha: shaBefore,
      core: core0,
      runtimeReleases: await readRemoteRuntimeReleaseDirs(prepared.config),
    };

    const repack = await prepareSourceServerUpdateArchive(shaBefore, CASE_MARKER);
    expect(repack.newSha).not.toBe(shaBefore);
    facts.repack = repack;

    if (updateScenario === "disconnect") {
      const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
      if (!sourceId) throw new Error(`${CASE_MARKER}: 缺少已握手 Source 身份`);
      await disconnectRemoteSource(sourceId, CASE_MARKER);
      await disconnectDuringNextSourceUpdate(sourceId);
      await requestRemoteProjectConnection(taskA.identity, CASE_MARKER);
      await browser.waitUntil(
        async () => {
          if ((await readUpdateDisconnectEvidence()).sent) return true;
          await browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
            ).find(
              (item) =>
                /^(更新远端|Update server|立即更新|Update now)$/iu.test(item.innerText.trim()) &&
                !item.disabled,
            );
            button?.click();
          });
          return false;
        },
        { timeout: 180_000, timeoutMsg: `${CASE_MARKER}: 未进入真实更新并发断开场景` },
      );
      await browser.waitUntil(
        async () => {
          const evidence = await readUpdateDisconnectEvidence();
          return Boolean(evidence.cancellation && evidence.update);
        },
        { timeout: 180_000, timeoutMsg: `${CASE_MARKER}: 断开或更新操作没有收口` },
      );
      const evidence = await readUpdateDisconnectEvidence();
      facts.disconnectDuringUpdate = evidence;
      expect(evidence.cancellation?.header[0]).toBe(201);
      expect(
        evidence.cancellation?.body.states.find(
          (state: { sourceServerId?: string }) => state.sourceServerId === sourceId,
        )?.state,
      ).toBe("offline");
      expect(evidence.update?.header[0]).toBe(202);
      expect(evidence.update?.body.code).toBe("remote-connection-canceled");
      expect(evidence.states.at(-1)?.state).toBe("offline");
      expect(evidence.states.some((state) => state.state === "online")).toBe(false);
      await mark("R3-REMOTE-08E-update-canceled-without-republish");
      return;
    }

    // 受控回放保持任务运行，只有确认守卫并取消强制更新后才释放。
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_UPDATE_STREAMING", 60_000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId === taskA.taskId,
      "A 没有进入 running",
      45_000,
    );

    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;

    // 同版本异 SHA 属开发态内容寻址判定：连接时判定“需要更新”后，走与生产态相同的 needs-upgrade → updateSource 链路。
    // 普通路径：running 中断开再重连 → 向导自动发起 force:false 更新 → running-task guard → 向导弹出“强制更新”确认；
    // 用户取消后远端保持原 release、任务继续，向导错误面板保留“立即更新”入口（R3A-B-06 修正前该状态只有普通连接失败）。
    await selectTaskOrganizeMode(["项目", "Project"]);
    await disconnectRemoteSource(sourceId!, CASE_MARKER, { workspaceIdentities: [taskA.identity] });

    await requestRemoteProjectConnection(taskA.identity, CASE_MARKER);
    const FORCE_UPDATE_TITLE = /强制更新此设备|Force update this device/iu;
    // guard：向导内自动 force:false 更新被拒绝后，弹出共享的“强制更新”确认（与生产态 needs-upgrade 完全相同的入口）。
    let guardText = "";
    const forceConfirmVisible = () =>
      browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).some(
          (button) =>
            button.getClientRects().length &&
            /^(强制更新|Force update)$/iu.test(button.innerText.trim()),
        ),
      );
    // running-tasks 是 Server 根命令；多加 server 会误走旧 CLI，使守卫取证失真。
    facts.runningTasksBeforeUpdate = (
      await dockerSh('"$HOME/.zcode/server/bin/zcode" running-tasks --json')
    ).stdout;
    // 手动原项目连接应自动尝试一次受保护更新；直接等待 running-task 守卫，不能补点更新掩盖交接缺失。
    await browser
      .waitUntil(
        async () => {
          guardText = await browser.execute(() => document.body?.innerText ?? "");
          return FORCE_UPDATE_TITLE.test(guardText) && (await forceConfirmVisible());
        },
        {
          timeout: 180_000,
          interval: 1000,
          timeoutMsg: `${CASE_MARKER}: 重连没有经 running-task guard 弹出强制更新确认`,
        },
      )
      .catch(async (error) => {
        facts.guardFailure = {
          body: await browser.execute(() => document.body.innerText.slice(-3500)),
          currentSha: await readRemoteCurrentShaOrNull(prepared.config),
          runningTasks: (await dockerSh('"$HOME/.zcode/server/bin/zcode" running-tasks --json'))
            .stdout,
          core: await readRemoteCoreIdentityViaDocker().catch(() => null),
        };
        throw error;
      });
    const remoteShaDuringGuard = await readRemoteCurrentSha(prepared.config);
    const coreAfterGuard = await readRemoteCoreIdentityViaDocker();
    expect(remoteShaDuringGuard).toBe(shaBefore);
    expect(coreAfterGuard.pid).toBe(core0.pid);
    await mark("guard-observed");
    expect(guardText).toContain(workspaceA);
    let updateActionConfirmed = false;
    if (updateScenario === "force") {
      // 守卫已经证明回合仍运行；只有此处真实确认才允许强制中断并更新。
      updateActionConfirmed = await browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find(
          (item) => /^(强制更新|Force update)$/iu.test(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      });
      expect(updateActionConfirmed).toBe(true);
      facts.guard = { forceConfirmedWhileRunning: true, listedWorkspace: workspaceA };
    } else {
      const cancelled = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
        const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
          (item) =>
            /^(取消连接|Cancel connection)$/iu.test(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      });
      expect(cancelled).toBe(true);
      // 当前合同取消整个连接流程并给出“重试”，旧 case 要求过时的“立即更新”错误面板。
      await browser.waitUntil(
        async () => /已取消|Cancelled/iu.test(await $('[data-testid="ssh-dialog"]').getText()),
        { timeout: 30_000 },
      );
      expect(await readRemoteCurrentSha(prepared.config)).toBe(shaBefore);
      const runningAfterCancel = await dockerSh(
        '"$HOME/.zcode/server/bin/zcode" running-tasks --json',
      );
      expect(runningAfterCancel.code).toBe(0);
      expect(JSON.parse(runningAfterCancel.stdout).length).toBeGreaterThan(0);
      facts.guard = {
        forceConfirmCancelled: true,
        remoteShaUnchanged: true,
        coreUnchanged: true,
        listedWorkspace: workspaceA,
      };
      await releaseControlledReplay("r3-update-slow-turn");
      await browser.waitUntil(
        async () => {
          const result = await dockerSh('"$HOME/.zcode/server/bin/zcode" running-tasks --json');
          return result.code === 0 && JSON.parse(result.stdout).length === 0;
        },
        { timeout: 120_000, timeoutMsg: `${CASE_MARKER}: 释放回合后运行任务未收口` },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
            ).find((item) => /^(重试|Retry)$/iu.test(item.innerText.trim()) && !item.disabled);
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 取消后没有重试入口` },
      );
      // 当前重试会自动发起受保护更新；不能在更新已成功后等待一个不会再次出现的按钮。
      updateActionConfirmed = true;
    }
    await mark("guard-recorded");
    await browser.waitUntil(
      async () => (await readRemoteCurrentShaOrNull(prepared.config)) === repack.newSha,
      {
        timeout: 600_000,
        interval: 2000,
        timeoutMsg: `${CASE_MARKER}: 确认更新后 current.json 没有切换到新 SHA`,
      },
    );
    expect(updateActionConfirmed).toBe(true);
    facts.updatePath =
      updateScenario === "force" ? "confirmed-force-update" : "cancel-retry-auto-update";
    await mark("sha-switched");
    let core1: {
      pid: number;
      supervisorPid: number;
      state: string;
      generation: number;
      startTicks: number;
    } = core0;
    await browser.waitUntil(
      async () => {
        try {
          core1 = await readRemoteCoreIdentityViaDocker();
        } catch {
          return false;
        }
        return core1.state === "ready" && core1.pid !== core0.pid;
      },
      {
        timeout: 180_000,
        interval: 2000,
        timeoutMsg: `${CASE_MARKER}: 新 release 的 Core 没有 ready`,
      },
    );
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
      timeoutMs: 180_000,
    });
    expect(reconnected.remoteSessionId).not.toBe(taskA.remoteSessionId);
    const releaseDirs = await readRemoteRuntimeReleaseDirs(prepared.config);
    const remoteMarker = await dockerSh(
      'ls "$HOME"/.zcode/server/releases/*/runtime/E2E_R3_UPGRADE_MARKER.txt 2>/dev/null | wc -l; grep -o \'"releaseId": *"[^"]*"\' "$HOME/.zcode/server/current.json"; ls "$HOME/.zcode/server/releases"',
    );
    facts.after = {
      sha: repack.newSha,
      core: core1,
      runtimeReleases: releaseDirs,
      marker: remoteMarker.stdout.trim(),
    };
    expect(remoteMarker.stdout).toContain(repack.newSha.slice(0, 12));
    const distinctReleases = releaseDirs
      .map((line) => line.trim().split(/\s+/u)[1])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0 && !value.endsWith("*)"),
      );
    expect(new Set(distinctReleases).size).toBe(1);
    expect(distinctReleases[0]).toContain(repack.newSha.slice(0, 12));
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);

    const resumed: SSHLifecycleTask = { ...taskA, remoteSessionId: reconnected.remoteSessionId! };
    await readTaskRowInProject(resumed, CASE_MARKER);
    await sendSSHFollowTurn(resumed, CASE_MARKER);
  });
});
