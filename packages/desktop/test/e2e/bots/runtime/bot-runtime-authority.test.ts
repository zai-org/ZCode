import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDataBaseDir } from "@zcode/services/node";

import { acquireFeishuWebSocketLock } from "../../../../../services/src/bots/channelRuntime.js";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  readBotSyntheticFixture,
} from "#e2e/bots/helpers/bots-service-harness";

describe("Bot runtime authority E2E", () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    setDataBaseDir(null);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("BOT-E2E-RT-01 grants the Feishu runtime lock to only one local host", async () => {
    const fixture = await readBotSyntheticFixture("feishu-runtime-lock.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-RT-01", classification: "synthetic" });
    dataDir = await mkdtemp(join(tmpdir(), "zcode-e2e-bot-runtime-"));
    setDataBaseDir(dataDir);
    const bot = createFeishuConfig().bots[0]!;
    const firstHostLock = await acquireFeishuWebSocketLock(bot);
    expect(firstHostLock).not.toBeNull();
    try {
      const competingBot = {
        ...bot,
        id: "feishu-same-app-other-record",
        credentialRef: "feishu-other-secret-ref",
      };
      const competingHostLock = await acquireFeishuWebSocketLock(competingBot);
      expect(competingHostLock).toBeNull();
    } finally {
      await firstHostLock?.release();
    }
    const takeoverLock = await acquireFeishuWebSocketLock(bot);
    expect(takeoverLock).not.toBeNull();
    await takeoverLock?.release();
  });

  it("BOT-E2E-RT-02 keeps provider runtimes disabled for an attached remote host", async () => {
    const fixture = await readBotSyntheticFixture("attached-remote-runtime.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-RT-02", classification: "synthetic" });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ code: 0 }));
    };
    const harness = createBotsServiceHarness({
      config: createFeishuConfig(),
      // 与 services/node.ts 的 !isDesktopAttachedRemote 装配一致；这是 owner 权限，
      // 不是跳过被测流程。下方保存配置还会触发 scheduleRefresh，验证 guard 仍生效。
      runStartupBackgroundTasks: false,
      projectWorkspaces: [
        {
          kind: "remote",
          workspacePath: "/workspace",
          workspaceIdentity: "remote:server:e2e-host:/workspace",
          remoteSessionId: "remote-session-e2e",
        },
      ],
    });
    try {
      await harness.service.saveConfig(createFeishuConfig());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await harness.service.getStatus();
      expect(status.botRuntime).toEqual([
        expect.objectContaining({
          botId: "feishu-e2e",
          provider: "feishu",
          status: "idle",
          message: "Bot is configured.",
        }),
      ]);
      expect(requests).toEqual([]);
    } finally {
      await harness.service.disposeAllAndWait();
      globalThis.fetch = originalFetch;
    }
  });
});
