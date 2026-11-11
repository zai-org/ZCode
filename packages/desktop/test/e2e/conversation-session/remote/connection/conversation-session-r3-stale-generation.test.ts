import { mkdir, writeFile } from "node:fs/promises";
import { createHeldResponseProxy } from "#e2e/helpers/ssh-held-response-proxy";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { resolve } from "node:path";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  readRemoteCoreIdentity,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_STALE_GENERATION";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-stale-generation",
);

describe(`${CASE_MARKER}: 旧连接代际的回包/close 迟到不得覆盖新 session`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let proxy: Awaited<ReturnType<typeof createHeldResponseProxy>> | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "stale-generation.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-REC-08 扣留旧代际真实回包并自动换代；旧链路转发/退役丢弃均可对账，新 session 与状态保持有效", async function () {
    this.timeout(30 * 60_000);
    const direct = readSSHRuntimeConfig(CASE_MARKER);
    proxy = await createHeldResponseProxy(direct);
    // Desktop 经代理连接；模型回放隧道走直连（tunnel 用户），避免 hold 影响远端模型请求。
    const proxied: SSHConnectionConfig = {
      host: direct.host,
      password: direct.password,
      port: proxy.port,
      username: direct.username,
    };
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    provider = await createSSHLifecycleProvider(direct, CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    const [workspaceA] = direct.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: proxied,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const core0 = await readRemoteCoreIdentity(direct, CASE_MARKER);
    facts.generation1 = { remoteSessionId: taskA.remoteSessionId, proxyPairs: proxy.stats().pairs };

    // 旧代际上 running 一个慢回合，然后 hold 上游回包（旧 generation 的响应被扣住）。
    const slowStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_STALE_STREAMING", 60_000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId === taskA.taskId,
      `${CASE_MARKER}: 慢回合没有进入 running`,
      45_000,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`] },
      `${CASE_MARKER}: 慢回合没有到达回放`,
      30_000,
      { afterIndex: slowStart - 1 },
    );
    const heldPairs = proxy.holdCurrent();
    facts.held = { pairs: heldPairs, at: Date.now() };
    expect(heldPairs).toBeGreaterThan(0);
    // 先让 Source 真正完成，确保旧连接丢失的是本回合的最终投影，而不是只等 SSH 心跳。
    await releaseControlledReplay("r3-stale-slow");
    await browser.waitUntil(
      async () => {
        const requests = await getUpstreamRequestEvidence(
          {
            lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`],
            excludes: ["CRITICAL: Respond with TEXT ONLY"],
          },
          { afterIndex: slowStart - 1 },
        );
        return (
          requests.length === 1 &&
          requests[0]!.status === "complete" &&
          requests[0]!.statusCode === 200
        );
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: Source 慢回合没有真正完成` },
    );
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );
    expect(
      (await getV4Messages("assistant")).some((message) =>
        message.text.includes("R3_STALE_COMPLETE"),
      ),
    ).toBe(false);
    await browser.waitUntil(
      () => {
        const stats = proxy!.stats();
        return stats.heldBytes + stats.retiredBytes > 0;
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 代理没有扣住真实上游字节` },
    );
    facts.sourceCompletedWhileOldConnectionHeld = true;

    // 传输失活 → Desktop 自动换代（新 TCP 连接经代理正常放行）。
    let regenerated: string | null = null;
    await browser.waitUntil(
      async () => {
        const snapshot = await readRemoteTabSnapshot(taskA.identity).catch(() => null);
        if (snapshot?.remoteSessionId && snapshot.remoteSessionId !== taskA.remoteSessionId) {
          regenerated = snapshot.remoteSessionId;
          return true;
        }
        return false;
      },
      { timeout: 240_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: hold 回包后没有自动换代` },
    );
    const heldStats = proxy.stats();
    facts.generation2 = {
      remoteSessionId: regenerated,
      heldBytesAtRegeneration: heldStats.heldBytes,
      pairs: heldStats.pairs,
      elapsedMs: Date.now() - (facts.held as { at: number }).at,
    };
    await waitForV4AssistantMessageContaining("R3_STALE_COMPLETE", 60_000);
    await waitForV4ConversationState(
      (state) => state.taskId === taskA.taskId && state.state === "idle" && state.queueCount === 0,
      `${CASE_MARKER}: 换代后没有恢复真实完成态`,
      60_000,
    );
    const afterRegeneration = await getV4ConversationState();
    facts.slowTurnAfterRegeneration = {
      state: afterRegeneration.state,
      runtimeStatus: afterRegeneration.runtimeStatus,
    };
    facts.completedReplyRestored = true;

    // 真实 client 可在换代时主动关闭旧 TCP；这时只能对账丢弃，不能伪称已送达。
    // 应用层迟到 close/成功回调由 sourceServerConnectionManager.test.ts 强制乱序覆盖。
    const beforeRelease = proxy.stats();
    const released = await proxy.release();
    facts.beforeRelease = beforeRelease;
    facts.released = released;
    expect(released.heldPairs).toBeGreaterThan(0);
    expect(released.forwardedBytes + released.discardedBytes).toBeGreaterThan(0);
    expect(released.forwardedBytes + released.discardedBytes).toBe(
      beforeRelease.heldBytes + beforeRelease.retiredBytes,
    );
    await browser.pause(8_000);
    const afterRelease = await readRemoteTabSnapshot(taskA.identity);
    facts.afterRelease = {
      remoteSessionId: afterRelease.remoteSessionId,
      sameAsGeneration2: afterRelease.remoteSessionId === regenerated,
      lastConnectionStatus:
        (
          (await readSettings()).lastWorkspaceSession?.find(
            (entry) => entry.kind === "remote" && entry.workspacePath === workspaceA,
          ) as { lastConnectionStatus?: string } | undefined
        )?.lastConnectionStatus ?? null,
    };
    expect(afterRelease.remoteSessionId).toBe(regenerated);
    expect(
      (facts.afterRelease as { lastConnectionStatus: string | null }).lastConnectionStatus,
    ).toBe("connected");
    expect(await readHostProcesses()).toEqual(initialHosts);
    const core1 = await readRemoteCoreIdentity(direct, CASE_MARKER);
    facts.remoteCore = { before: core0, after: core1 };
    expect(core1.pid).toBe(core0.pid);
    expect(core1.startTicks).toBe(core0.startTicks);

    // 新代际可继续工作：普通回合到达并收口。
    const nextStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_NEXT 请回复`,
      `${CASE_MARKER}_NEXT`,
      `${CASE_MARKER}: 释放后新回合未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_NEXT`], includes: [taskA.firstPrompt] },
      `${CASE_MARKER}: 释放后新回合没有到达回放或丢历史`,
      90_000,
      { afterIndex: nextStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_STALE_NEXT_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 释放后新回合没有收口`,
      90_000,
    );
    facts.nextTurnAfterRelease = true;
    const remoteStatus = await runSSHCommand(
      direct,
      'tr -d "\\n " < "$HOME/.zcode/server/run/status.json" | cut -c1-120',
    );
    facts.remoteStatus = remoteStatus.stdout.trim();
  });
});
