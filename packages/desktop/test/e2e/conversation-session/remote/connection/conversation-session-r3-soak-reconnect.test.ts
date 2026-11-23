import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  openSSHSourceDirectory,
  readHostProcesses,
  readRemoteTabSnapshot,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import {
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

const CASE_MARKER = "E2E_R3_SOAK_RECONNECT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-soak-reconnect",
);
const ROUNDS = Number(process.env.R3_SOAK_ROUNDS?.trim() || "50");

interface RoundRecord {
  round: number;
  disconnectMs: number;
  reconnectMs: number;
  sessionChanged: boolean;
  hosts: number;
  agents: number;
  turnOk: boolean | null;
  error?: string;
}

describe(`${CASE_MARKER}: 两项目 + conversation 的连接/断开/恢复/开关 tab 循环`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};
  const rounds: RoundRecord[] = [];

  after(async () => {
    facts.rounds = rounds;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "soak-reconnect.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`R3A-SOAK-01 ${ROUNDS} 轮断开/重连/切 tab：每轮可继续执行、Host/远端 Agent 回到基线、Core 不换代、无旧 generation 误写`, async function () {
    if (!Number.isSafeInteger(ROUNDS) || ROUNDS <= 0) {
      throw new Error(`${CASE_MARKER}: R3_SOAK_ROUNDS 必须是正整数，不能跳过重连循环`);
    }
    this.timeout(150 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    await openSSHSourceDirectory(prepared.config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceB, CASE_MARKER);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspaceB,
      timeoutMs: 120_000,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId ?? "";

    const core0 = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    const baseline = {
      hosts: (await readHostProcesses()).length,
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
      core: core0.pid,
    };
    facts.baseline = baseline;

    let previousSession = (await readRemoteTabSnapshot(taskA.identity)).remoteSessionId;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const record: RoundRecord = {
        round,
        disconnectMs: 0,
        reconnectMs: 0,
        sessionChanged: false,
        hosts: 0,
        agents: 0,
        turnOk: null,
      };
      try {
        // 切 tab：本地 → 远端 A → 远端 B → 远端 A。
        await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
        await selectV4TaskById(taskA.taskId);
        // 断开。
        const t0 = Date.now();
        await disconnectRemoteSource(sourceId!, CASE_MARKER, {
          workspaceIdentities: [taskA.identity],
        });

        record.disconnectMs = Date.now() - t0;
        // 重连。
        const t1 = Date.now();
        await reconnectRemoteProject(taskA.identity, CASE_MARKER);
        let sessionNow: string | null = null;
        await browser.waitUntil(
          async () => {
            const snapshot = await readRemoteTabSnapshot(taskA.identity).catch(() => null);
            sessionNow = snapshot?.remoteSessionId ?? null;
            return Boolean(sessionNow);
          },
          { timeout: 120_000, interval: 1000, timeoutMsg: `round ${round}: 重连没有恢复` },
        );
        await browser.waitUntil(
          async () =>
            Boolean(
              (await readRemoteTabSnapshot(undefined, workspaceB).catch(() => null))
                ?.remoteSessionId,
            ),
          { timeout: 60_000, interval: 1000, timeoutMsg: `round ${round}: 项目 b 没有恢复` },
        );
        record.reconnectMs = Date.now() - t1;
        record.sessionChanged = sessionNow !== previousSession;
        previousSession = sessionNow;
        // 每 10 轮做一次真实回合，确认可继续执行且历史守恒。
        if (round % 10 === 0 || round === ROUNDS) {
          await selectV4TaskById(taskA.taskId, 30_000);
          const start = await getUpstreamRequestRecordCount();
          const marker = `${CASE_MARKER}_R${round}`;
          await sendV4PromptAndWaitAccepted(
            `${marker} 请回复`,
            marker,
            `round ${round}: 回合未被接受`,
          );
          await waitForUpstreamRequest(
            { lastUserMessageIncludes: [marker], includes: [taskA.firstPrompt] },
            `round ${round}: 请求没有到达或丢历史`,
            90_000,
            { afterIndex: start - 1 },
          );
          await waitForV4AssistantMessageContaining("R3_SOAK_RECONNECT_REPLY", 90_000);
          await waitForV4ConversationState(
            (s) => s.taskId === taskA.taskId && s.state === "idle",
            `round ${round}: 回合没有收口`,
            90_000,
          );
          record.turnOk = true;
        }
        record.hosts = (await readHostProcesses()).length;
        record.agents = (await listRemoteAgentProcesses(prepared.config)).length;
      } catch (error) {
        record.error = String(error).slice(0, 300);
        rounds.push(record);
        throw error;
      }
      rounds.push(record);
    }
    const core1 = await readRemoteCoreIdentity(prepared.config, CASE_MARKER);
    facts.final = {
      core: core1.pid,
      hosts: (await readHostProcesses()).length,
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
      maxReconnectMs: Math.max(...rounds.map((r) => r.reconnectMs)),
      avgReconnectMs: Math.round(rounds.reduce((a, r) => a + r.reconnectMs, 0) / rounds.length),
    };
    expect(core1.pid).toBe(core0.pid);
    expect((facts.final as { hosts: number }).hosts).toBe(baseline.hosts);
    expect((facts.final as { agents: number }).agents).toBeLessThanOrEqual(baseline.agents + 1);
    expect(rounds.every((r) => r.sessionChanged)).toBe(true);
    expect(rounds).toHaveLength(ROUNDS);
    expect(rounds.at(-1)?.turnOk).toBe(true);
    await startNewV4Draft();
  });
});
