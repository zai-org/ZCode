import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import {
  restartIntoWorkspace,
  seedReplayProvider,
  seedPersistedModelSelection,
  readLastSelectedAgentConfig,
} from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  startE2ENetworkCaptureProxy,
  type E2ENetworkCaptureResponseMock,
} from "#e2e/helpers/network-capture-proxy";

describe("Todo127 Built-in 设置刷新整链", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BR117-N02：刷新进入目标 Registry，后续执行使用新配置且 Personal 不变", async function () {
    this.timeout(150_000);
    const providerId = "e2e-builtin-refresh";
    const modelId = "E2E_BUILTIN_REFRESH_MODEL";
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "builtin-probe",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing probe port");
    const paths = getE2EAppDataPaths();
    const repository = new NodePersonalProviderConfigRepository({
      filePath: paths.configFile,
      pollingIntervalMs: false,
    });
    let proxy: Awaited<ReturnType<typeof startE2ENetworkCaptureProxy>> | undefined;
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      const root = join(paths.workspace, ".zcode-e2e", "builtin-refresh");
      await mkdir(root, { recursive: true });
      // afterSession 会清理隔离工作区，验收证据必须写到报告目录。
      const artifacts = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
        "provider-builtin-refresh",
      );
      await mkdir(artifacts, { recursive: true });
      const release = JSON.parse(
        await readFile(join(process.cwd(), "../../config/provider/zcode-builtin.json"), "utf8"),
      );
      const clientConfig = JSON.parse(
        await readFile(
          join(process.cwd(), "test/e2e/fixtures/coding-plan-client-configs.json"),
          "utf8",
        ),
      );
      const control: E2ENetworkCaptureResponseMock = {
        host: "builtin-control.e2e.invalid",
        path: "/api/v1/client/configs",
        body: "",
      };
      const oldCdn: E2ENetworkCaptureResponseMock = {
        host: "builtin-cdn.e2e.invalid",
        path: "/release-a.json",
        body: "",
      };
      const newCdn = { ...oldCdn, path: "/release-b.json" };
      clientConfig.data.configs.builtin_provider_config_json =
        "https://builtin-cdn.e2e.invalid/release-a.json";
      control.body = JSON.stringify(clientConfig);
      proxy = await startE2ENetworkCaptureProxy({
        artifactPath: join(artifacts, "network.json"),
        caDir: join(root, "ca"),
        responseMocks: [control, oldCdn, newCdn],
      });
      const network = proxy;
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedReplayProvider({
            id: providerId,
            name: "E2E Builtin Refresh",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [modelId],
          });
          const personal = await repository.read();
          const config = personal.models.getExact(providerId, modelId)!.toJSON();
          config.properties!.contextWindow = 500_000;
          config.optionSpecs!.maxOutputTokens!.map =
            '{"max_completion_tokens":maxOutputTokens,"top_p":0.17}';
          release.revision += 1000;
          release.config.modelConfigRules.modelApiRules.push({
            modelMatch: modelId,
            apiTypeMatch: "openai-chat-completions",
            config,
          });
          oldCdn.body = JSON.stringify(release);
          config.properties!.contextWindow = 700_000;
          config.optionSpecs!.maxOutputTokens!.map =
            '{"max_completion_tokens":maxOutputTokens,"top_p":0.37}';
          release.revision += 1;
          newCdn.body = JSON.stringify(release);
          // 测试模型必须继承 Built-in，不留下 Personal 默认值掩盖更新。
          await repository.update((current) => ({
            ...current,
            models: current.models.deleteExactForProvider(providerId),
          }));
          await seedSettings({
            zcodeEndpointOrigin: "https://builtin-control.e2e.invalid",
            httpProxy: network.proxyUrl,
            httpProxyNoProxy: "localhost,127.0.0.1,::1",
            httpProxyCaCertPath: network.caCertPath,
          });
        },
      });
      // 最近选择也是用户持久事实；刷新能力配置不应代写它。
      await seedPersistedModelSelection({ providerId, modelId, reasoningLevel: "high" });
      const selectionBefore = await readLastSelectedAgentConfig();
      expect(selectionBefore?.model).toBe(`${providerId}/${modelId}`);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const row = () => $(`[data-model-provider-model-id="${modelId}"]`);
      await browser.waitUntil(async () => (await row().getText()).includes("500K"), {
        timeout: 30_000,
        timeoutMsg: "初始 HTTPS release 未进入设置 Registry",
      });
      const before = await readFile(paths.configFile, "utf8");
      const probe = async (count: number, marker: number) => {
        const button = row().$("button:has(svg.lucide-unplug)");
        await button.waitForClickable({ timeout: 15_000 });
        await button.click();
        await browser.waitUntil(() => bodies.length === count, { timeout: 15_000 });
        await button.waitForClickable({ timeout: 15_000 });
        expect(bodies[count - 1]?.model).toBe(modelId);
        expect(bodies[count - 1]?.top_p).toBe(marker);
        await browser.waitUntil(
          async () => {
            const text = await browser.execute(() => document.body.innerText);
            return text.includes("connected") || text.includes("连接成功");
          },
          { timeout: 15_000, timeoutMsg: "连接测试未成功完成" },
        );
      };
      await probe(1, 0.17);
      clientConfig.data.configs.builtin_provider_config_json =
        "https://builtin-cdn.e2e.invalid/release-b.json";
      control.body = JSON.stringify(clientConfig);
      const refresh = $('button[aria-label="刷新"],button[aria-label="Refresh"]');
      await refresh.waitForClickable({ timeout: 15_000 });
      await refresh.click();
      await browser.waitUntil(async () => (await row().getText()).includes("700K"), {
        timeout: 30_000,
        timeoutMsg: "手动刷新未发布新 Registry 到设置页",
      });
      await probe(2, 0.37);
      expect(await readFile(paths.configFile, "utf8")).toBe(before);
      expect(await readLastSelectedAgentConfig()).toEqual(selectionBefore);
      await writeFile(
        join(artifacts, "asserted-wire.json"),
        JSON.stringify({ bodies, selectionBefore, personalUnchanged: true }, null, 2),
      );
    } finally {
      repository.dispose();
      await proxy?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
