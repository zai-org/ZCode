import { mkdir, writeFile } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { resolve } from "node:path";
import { BufferWriter, serialize } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  countUpstreamRequests,
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
  clickV4Send,
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_ACK_LOSS";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-ack-loss");

declare global {
  interface Window {
    __ackLossCommand?: { count: number; release(): void; restore(): void };
  }
}

/** 只暂挂本例原始输入，不伪造 RPC 结果，也不拦截发送前的配置查询。 */
async function holdInputCommand(marker: string): Promise<void> {
  const signature = new BufferWriter();
  serialize(signature, ServiceChannels.ZCodeAgent);
  serialize(signature, "sendConversationCommandV4");
  await browser.execute(
    (signature, marker) => {
      const original = MessagePort.prototype.postMessage;
      const held: { port: MessagePort; data: Uint8Array }[] = [];
      let intercepting = true;
      const probe = {
        count: 0,
        release() {
          intercepting = false;
          for (const { port, data } of held) original.call(port, data);
          held.length = 0;
        },
        restore() {
          probe.release();
          MessagePort.prototype.postMessage = original;
          delete window.__ackLossCommand;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (
          intercepting &&
          message instanceof Uint8Array &&
          new TextDecoder().decode(message).includes(marker) &&
          message.some((_, start) =>
            signature.every((byte, offset) => message[start + offset] === byte),
          )
        ) {
          held.push({ port: this, data: message.slice() });
          probe.count++;
          return;
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__ackLossCommand = probe;
    },
    Array.from(signature.buffer.buffer),
    marker,
  );
}

interface Pair {
  client: Socket;
  upstream: Socket;
  held: Buffer[];
  holding: boolean;
  generation: number;
}

/** 可按连接代际 hold 上游回包的 SSH TCP 代理：hold 期间上游→Desktop 的字节暂存，release 后一次性冲出。 */
async function createHoldingProxy(target: { host: string; port: number }): Promise<{
  port: number;
  holdCurrent(): number;
  release(): { flushedBytes: number; pairs: number };
  stats(): { pairs: number; heldBytes: number };
  close(): Promise<void>;
}> {
  const pairs = new Set<Pair>();
  let generation = 0;
  const server: Server = createServer((client) => {
    generation += 1;
    const upstream = createConnection({ host: target.host, port: target.port });
    const pair: Pair = { client, upstream, held: [], holding: false, generation };
    pairs.add(pair);
    const cleanup = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) => {
      if (pair.holding) pair.held.push(Buffer.from(chunk));
      else client.write(chunk);
    });
    client.once("error", cleanup);
    upstream.once("error", cleanup);
    client.once("close", cleanup);
    upstream.once("close", () => {
      // hold 期间上游关闭也不向 Desktop 传递 FIN，模拟"旧回包/旧 close 迟到"。
      if (!pair.holding) cleanup();
    });
  });
  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    holdCurrent() {
      let count = 0;
      for (const pair of pairs) {
        pair.holding = true;
        count += 1;
      }
      return count;
    },
    release() {
      let flushed = 0;
      let count = 0;
      for (const pair of pairs) {
        if (!pair.holding) continue;
        count += 1;
        pair.holding = false;
        for (const chunk of pair.held) {
          flushed += chunk.length;
          if (!pair.client.destroyed) pair.client.write(chunk);
        }
        pair.held = [];
        if (pair.upstream.destroyed) {
          pair.client.end();
        }
      }
      return { flushedBytes: flushed, pairs: count };
    },
    stats() {
      let heldBytes = 0;
      for (const pair of pairs) for (const chunk of pair.held) heldBytes += chunk.length;
      return { pairs: pairs.size, heldBytes };
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

describe(`${CASE_MARKER}: command 已 admitted 但 ACK 经代理丢失后的唯一归属`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let proxy: Awaited<ReturnType<typeof createHoldingProxy>> | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await browser.execute(() => window.__ackLossCommand?.restore());
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "ack-loss.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TASK-07 发送后 ACK 被代理扣住：远端已 admitted 并完成回合；换代恢复后原输入在 transcript 中唯一出现、模型请求唯一、无 silent drop", async function () {
    this.timeout(30 * 60_000);
    const direct = readSSHRuntimeConfig(CASE_MARKER);
    proxy = await createHoldingProxy(direct);
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
    const messagesBefore = (await getV4Messages()).length;
    const repliesBefore = (await getV4Messages("assistant")).filter((message) =>
      message.text?.includes("R3_ACK_LOSS_REPLY"),
    ).length;

    // 过早扣住全部 SSH 回包会挡住发送前的查询，无法建立“已 admitted”前提。
    // 等原输入到 RPC 出口后再布置故障，随后仅放行这一份真实命令。
    const marker = `${CASE_MARKER}_ACK`;
    await setV4ComposerText(`${marker} 请回复`);
    const requestStart = await getUpstreamRequestRecordCount();
    await holdInputCommand(marker);
    await clickV4Send();
    await browser.waitUntil(
      async () => (await browser.execute(() => window.__ackLossCommand?.count ?? 0)) > 0,
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 原输入尚未到达 RPC 出口，不能注入 ACK 故障`,
      },
    );
    facts.heldInputCommands = await browser.execute(() => window.__ackLossCommand!.count);
    expect(facts.heldInputCommands).toBe(1);
    const held = proxy.holdCurrent();
    expect(held).toBeGreaterThan(0);
    await browser.execute(() => window.__ackLossCommand!.release());
    const admitted = await waitForUpstreamRequest(
      { lastUserMessageIncludes: [marker] },
      `${CASE_MARKER}: 命令没有到达远端（模型请求缺失）`,
      60_000,
      { afterIndex: requestStart - 1 },
    )
      .then(() => true)
      .catch(() => false);
    facts.admittedWhileAckHeld = admitted;
    expect(admitted).toBe(true);
    // 远端已接受但 ACK 尚未到达时继续编辑，恢复不能用旧发送结果清空后续草稿。
    const laterDraft = `${CASE_MARKER}_LATER_UNSENT_DRAFT`;
    await setV4ComposerText(laterDraft);
    await browser.waitUntil(() => proxy!.stats().heldBytes > 0, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 代理没有扣住实际回包`,
    });
    const duringHold = await getV4ConversationState();
    const composerDuringHold = await browser.execute(
      () =>
        document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')?.innerText ?? "",
    );
    facts.duringHold = {
      state: duringHold.state,
      composerText: composerDuringHold.slice(0, 80),
      heldBytes: proxy.stats().heldBytes,
    };
    expect(proxy.stats().heldBytes).toBeGreaterThan(0);

    // 传输失活 → 自动换代。
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
      { timeout: 240_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: ACK 丢失后没有自动换代` },
    );
    facts.released = proxy.release();
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 换代后回合没有收口`,
      180_000,
    );
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).filter((message) =>
          message.text?.includes("R3_ACK_LOSS_REPLY"),
        ).length > repliesBefore,
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 恢复后未投影远端已完成回复`,
      },
    );

    // 归属唯一：用户消息只出现一次、模型请求只有一次、助手回复出现、composer 不残留已发送正文，后续草稿仍保留。
    const userMessages = (await getV4Messages("user")).map((message) => message.text ?? "");
    const occurrences = userMessages.filter((text) => text.includes(marker)).length;
    const replayRecords = await countUpstreamRequests(
      { lastUserMessageIncludes: [marker], excludes: ["Generate a concise title"] },
      { afterIndex: requestStart - 1 },
    );
    const repliesAfter = (await getV4Messages("assistant")).filter((message) =>
      message.text?.includes("R3_ACK_LOSS_REPLY"),
    ).length;
    const composerAfter = await browser.execute(
      () =>
        document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]')?.innerText ?? "",
    );
    facts.afterRecovery = {
      regenerated,
      userMessageOccurrences: occurrences,
      totalMessagesDelta: (await getV4Messages()).length - messagesBefore,
      assistantReplyDelta: repliesAfter - repliesBefore,
      composerText: composerAfter.slice(0, 80),
      matchingCommandModelRequests: replayRecords,
    };
    expect(occurrences).toBe(1);
    expect(repliesAfter - repliesBefore).toBe(1);
    expect(composerAfter.trim()).toBe(laterDraft);
    expect(composerAfter).not.toContain(marker);
    expect(userMessages.some((text) => text.includes(laterDraft))).toBe(false);
    facts.laterDraftPreservedWithoutSending = true;
    expect(await readHostProcesses()).toEqual(initialHosts);
    const core1 = await readRemoteCoreIdentity(direct, CASE_MARKER);
    expect(core1.pid).toBe(core0.pid);
    expect(core1.startTicks).toBe(core0.startTicks);

    expect(replayRecords).toBe(1);
    const remoteStatus = await runSSHCommand(
      direct,
      'tr -d "\\n " < "$HOME/.zcode/server/run/status.json" | cut -c1-120',
    );
    facts.remoteStatus = remoteStatus.stdout.trim();
  });
});
