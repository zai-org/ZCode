import { createConnection, createServer, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
import { readRemoteTabSnapshot, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  pasteV4ComposerFileAttachment,
  setV4ComposerText,
  getV4Messages,
  waitForV4ConversationState,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4RowAttachments,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_ATTACHMENT_RACES";
const scenario = process.env.R3_ATTACHMENT_RACE_CASE ?? "cancel";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-attachment-races",
);

async function createUploadGate(target: { host: string; port: number }) {
  const pairs = new Set<{ client: Socket; upstream: Socket; chunks: Buffer[] }>();
  let blocked = false;
  let holding = false;
  const server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = createConnection(target);
    const pair = { client, upstream, chunks: [] as Buffer[] };
    pairs.add(pair);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.once("error", close).once("close", close);
    upstream.once("error", close).once("close", close);
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) =>
      holding ? pair.chunks.push(Buffer.from(chunk)) : client.write(chunk),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少上传代理端口");
  return {
    port: address.port,
    hold() {
      holding = true;
    },
    block() {
      blocked = true;
      holding = false;
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
    },
    allow() {
      blocked = false;
    },
    async release() {
      holding = false;
      let bytes = 0;
      for (const pair of pairs)
        for (const chunk of pair.chunks.splice(0)) {
          bytes += chunk.length;
          await new Promise<void>((resolve, reject) =>
            pair.client.write(chunk, (error) => (error ? reject(error) : resolve())),
          );
        }
      return bytes;
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const statuses = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-composer-attachment-kind]")).map(
      (card) => ({ name: card.innerText, status: card.dataset.uploadStatus }),
    ),
  );
async function removeAttachment() {
  await browser.execute(() => {
    const card = document.querySelector<HTMLElement>("[data-composer-attachment-kind]");
    card?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    card?.querySelector<HTMLElement>("[data-composer-attachment-remove]")?.click();
  });
  await browser.waitUntil(async () => (await statuses()).length === 0, { timeout: 15_000 });
}

describe(`${MARKER}: 上传中的取消、断线与拖入恢复`, () => {
  let gate: Awaited<ReturnType<typeof createUploadGate>> | undefined;
  const facts: Record<string, unknown> = { scenario };
  let provider: SSHLifecycleProvider | null = null;
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "attachment-races.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await gate?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it(`SSH-GUIDE-UPLOAD ${scenario}: 等待上传完成时处理取消或断线，恢复后拖入文件可继续使用`, async function () {
    this.timeout(15 * 60_000);
    // 空草稿尚无真实会话，上传会停在 waitingSession；先建立真实远端任务再注入上传故障。
    const prepared = await prepareSSHLifecycle(MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const direct = prepared.config;
    gate = await createUploadGate(direct);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config: { ...direct, port: gate.port },
      provider,
      label: "A",
      workspacePath: direct.workspacePaths[0],
    });
    await setV4ComposerText(`${MARKER}_UNSENT_DRAFT`);
    gate.hold();
    await pasteV4ComposerFileAttachment("guide-upload.txt", {
      mimeType: "text/plain",
      base64: Buffer.from("GUIDE_UPLOAD_CONTENT").toString("base64"),
    });
    await browser.waitUntil(
      async () =>
        (await statuses()).some(
          (card) => card.status === "uploading" || card.status === "committing",
        ),
      { timeout: 15_000 },
    );
    facts.inFlight = await statuses();
    if (scenario === "cancel") {
      await removeAttachment();
      facts.releasedBytes = await gate.release();
      expect(facts.releasedBytes).toBeGreaterThan(0);
    } else {
      gate.block();
      await browser.waitUntil(
        async () => (await readRemoteTabSnapshot(task.identity)).remoteSessionId === null,
        { timeout: 60_000 },
      );
      gate.allow();
      await requestRemoteProjectConnection(task.identity, MARKER, { retryFailure: true });
      await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: task.identity,
        expectedPath: task.workspacePath,
        requireActive: false,
      });
      if ((await statuses()).length) await removeAttachment();
    }
    // 再粘贴一个小附件并等到 ready，作为同一连接上晚回包已收口、上传功能仍可用的后续操作屏障。
    await pasteV4ComposerFileAttachment("guide-after.txt", {
      mimeType: "text/plain",
      base64: Buffer.from("GUIDE_AFTER_CONTENT").toString("base64"),
    });
    await browser.waitUntil(
      async () => {
        const cards = await statuses();
        return cards.length === 1 && cards[0]?.status === "ready";
      },
      { timeout: 60_000 },
    );
    expect((await statuses())[0]?.name).not.toContain("guide-upload.txt");
    await removeAttachment();
    const dropped = await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]');
      if (!input) return false;
      const data = new DataTransfer();
      data.items.add(new File(["GUIDE_DROP_CONTENT"], "guide-drop.txt", { type: "text/plain" }));
      for (const type of ["dragenter", "dragover", "drop"])
        input.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      return true;
    });
    expect(dropped).toBe(true);
    await browser.waitUntil(
      async () => {
        const cards = await statuses();
        return (
          cards.length === 1 &&
          cards[0]?.status === "ready" &&
          cards[0].name.includes("guide-drop.txt")
        );
      },
      { timeout: 60_000 },
    );
    expect(await $('[data-testid="v4-composer-input"]').getText()).toContain(
      `${MARKER}_UNSENT_DRAFT`,
    );
    facts.afterRecovery = await statuses();
    await browser.saveScreenshot(resolve(artifactDir, "drop-after-recovery.png"));
    const repliesBefore = (await getV4Messages("assistant")).length;
    await sendV4Prompt(`${MARKER}_AFTER_UPLOAD 请只回复 SSH_ATTACHMENT_RACES_REPLY`);
    await waitForV4RowAttachments(60_000, ["guide-drop.txt"]);
    await browser.waitUntil(async () => (await getV4Messages("assistant")).length > repliesBefore, {
      timeout: 60_000,
    });
    await waitForV4AssistantMessageContaining("SSH_ATTACHMENT_RACES_REPLY");
    await waitForV4ConversationState(
      (state) => state.taskId === task.taskId && state.state === "idle",
      "恢复后的附件回合没有完成",
    );
    facts.sentRecoveredAttachment = true;
  });
});
