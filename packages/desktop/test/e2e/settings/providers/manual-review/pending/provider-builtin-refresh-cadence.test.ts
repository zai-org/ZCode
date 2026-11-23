// BIR-01：Built-in Provider Config 跟随 client/configs 的刷新间隔自动更新；
// 规格见 docs/builtin-provider-maintenance/delivery.md「生效与恢复边界」。
import {
  NodePersonalProviderConfigRepository,
  createZCodeBuiltinEndpointKey,
} from "@zcode/provider-node";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  startE2ENetworkCaptureProxy,
  type E2ENetworkCaptureArtifact,
  type E2ENetworkCaptureResponseMock,
} from "#e2e/helpers/network-capture-proxy";

const CONTROL_HOST = "builtin-control.e2e.invalid";
const CDN_HOST = "builtin-cdn.e2e.invalid";
// 60 秒检查定时器 + 60 秒间隔：容差生效时一个间隔内必然完成下一轮。
const REFRESH_INTERVAL_SECONDS = 60;
const AUTO_REFRESH_TIMEOUT_MS = 130_000;

describe("Built-in 按服务端间隔自动刷新", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BIR-01/02：URL 不变时只请求第一跳；换新 URL 后自动生效；强制刷新重新下载", async function () {
    this.timeout(360_000);
    const providerId = "e2e-builtin-cadence";
    const modelId = "E2E_BUILTIN_CADENCE_MODEL";
    const paths = getE2EAppDataPaths();
    const repository = new NodePersonalProviderConfigRepository({
      filePath: paths.configFile,
      pollingIntervalMs: false,
    });
    let proxy: Awaited<ReturnType<typeof startE2ENetworkCaptureProxy>> | undefined;
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      const root = join(paths.workspace, ".zcode-e2e", "builtin-cadence");
      await mkdir(root, { recursive: true });
      const artifacts = join(
        process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
        "provider-builtin-refresh-cadence",
      );
      await mkdir(artifacts, { recursive: true });
      const networkArtifact = join(artifacts, "network.json");
      const release = JSON.parse(
        await readFile(join(process.cwd(), "../../config/provider/zcode-builtin.json"), "utf8"),
      );
      const clientConfig = JSON.parse(
        await readFile(
          join(process.cwd(), "test/e2e/fixtures/coding-plan-client-configs.json"),
          "utf8",
        ),
      );
      clientConfig.data.configs.clientConfigRefreshIntervalSeconds = REFRESH_INTERVAL_SECONDS;
      clientConfig.data.configs.builtin_provider_config_json = `https://${CDN_HOST}/release-a.json`;
      const control: E2ENetworkCaptureResponseMock = {
        host: CONTROL_HOST,
        path: "/api/v1/client/configs",
        body: JSON.stringify(clientConfig),
      };
      const oldCdn: E2ENetworkCaptureResponseMock = {
        host: CDN_HOST,
        path: "/release-a.json",
        body: "",
      };
      const newCdn = { ...oldCdn, path: "/release-b.json" };
      proxy = await startE2ENetworkCaptureProxy({
        artifactPath: networkArtifact,
        caDir: join(root, "ca"),
        responseMocks: [control, oldCdn, newCdn],
      });
      const network = proxy;
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedReplayProvider({
            id: providerId,
            name: "E2E Builtin Cadence",
            apiKey: "e2e-only",
            baseURL: "http://127.0.0.1:9/v1",
            models: [modelId],
          });
          const personal = await repository.read();
          const config = personal.models.getExact(providerId, modelId)!.toJSON();
          config.properties!.contextWindow = 500_000;
          release.revision += 1000;
          release.config.modelConfigRules.modelApiRules.push({
            modelMatch: modelId,
            apiTypeMatch: "openai-chat-completions",
            config,
          });
          oldCdn.body = JSON.stringify(release);
          config.properties!.contextWindow = 700_000;
          release.revision += 1;
          newCdn.body = JSON.stringify(release);
          // 测试模型必须继承 Built-in，不留下 Personal 规则掩盖更新。
          await repository.update((current) => ({
            ...current,
            models: current.models.deleteExactForProvider(providerId),
          }));
          await seedSettings({
            zcodeEndpointOrigin: `https://${CONTROL_HOST}`,
            httpProxy: network.proxyUrl,
            httpProxyNoProxy: "localhost,127.0.0.1,::1",
            httpProxyCaCertPath: network.caCertPath,
          });
        },
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const row = () => $(`[data-model-provider-model-id="${modelId}"]`);
      await browser.waitUntil(async () => (await row().getText()).includes("500K"), {
        timeout: 60_000,
        timeoutMsg: "启动后的首轮 Built-in 下载没有进入设置 Registry",
      });

      const requests = async (host: string, path: string) => {
        const artifact = JSON.parse(
          await readFile(networkArtifact, "utf8"),
        ) as E2ENetworkCaptureArtifact;
        return artifact.records.filter(
          (record) => record.host.startsWith(host) && record.path.startsWith(path),
        );
      };
      // ClientConfigService 也读同一个 client/configs；Built-in 是否完成一轮检查只看它自己的控制文件。
      const readControl = async () => {
        const providerRoot = join(paths.appDataDir, "runtime", "provider");
        const endpointKey = createZCodeBuiltinEndpointKey(`https://${CONTROL_HOST}`);
        const files = (await readdir(providerRoot, { recursive: true })).filter(
          (file) => file.includes(endpointKey) && file.endsWith("zcode-builtin-refresh.json"),
        );
        if (files.length !== 1) return null;
        return JSON.parse(await readFile(join(providerRoot, files[0]!), "utf8")) as {
          nextEligibleAt: number;
          releaseUrl?: string;
        };
      };
      const first = await readControl();
      expect(first?.releaseUrl).toBe(`https://${CDN_HOST}/release-a.json`);
      // 启动阶段 Host 与托管进程可能各自完成首次物化，只比较首轮之后的新增下载。
      const releaseADownloadsAfterFirst = (await requests(CDN_HOST, "/release-a.json")).length;
      // URL 不变：下一轮检查只请求第一跳，不重复下载 CDN。
      await browser.waitUntil(
        async () => ((await readControl())?.nextEligibleAt ?? 0) > first!.nextEligibleAt,
        {
          timeout: AUTO_REFRESH_TIMEOUT_MS,
          timeoutMsg: "按服务端间隔的第二轮 Built-in 检查没有发生",
        },
      );
      const second = await readControl();
      // 成功间隔从本轮开始计时；两轮相隔应接近服务端下发的 60 秒，而不是原来的一小时。
      expect(second!.nextEligibleAt - first!.nextEligibleAt).toBeLessThan(
        (REFRESH_INTERVAL_SECONDS + 15) * 1000,
      );
      expect(await requests(CDN_HOST, "/release-a.json")).toHaveLength(releaseADownloadsAfterFirst);

      // 换新 URL：不点刷新，等待下一个间隔自动生效。
      clientConfig.data.configs.builtin_provider_config_json = `https://${CDN_HOST}/release-b.json`;
      control.body = JSON.stringify(clientConfig);
      const changedAt = Date.now();
      await browser.waitUntil(async () => (await row().getText()).includes("700K"), {
        timeout: AUTO_REFRESH_TIMEOUT_MS,
        timeoutMsg: "新 URL 没有在一个刷新间隔内自动生效",
      });
      const elapsedMs = Date.now() - changedAt;
      // 新 URL 只需要被下载，不能每轮重复下载；多进程首轮物化同样允许各一次。
      expect((await requests(CDN_HOST, "/release-b.json")).length).toBeGreaterThanOrEqual(1);
      expect((await requests(CDN_HOST, "/release-b.json")).length).toBeLessThanOrEqual(
        releaseADownloadsAfterFirst,
      );

      // BIR-02：URL 不变时点设置页“刷新”仍重新下载 CDN，便于排查与即时生效。
      const releaseBBeforeForce = (await requests(CDN_HOST, "/release-b.json")).length;
      const refresh = $('button[aria-label="刷新"],button[aria-label="Refresh"]');
      await refresh.waitForClickable({ timeout: 15_000 });
      await refresh.click();
      await browser.waitUntil(
        async () => (await requests(CDN_HOST, "/release-b.json")).length > releaseBBeforeForce,
        { timeout: 30_000, timeoutMsg: "强制刷新没有重新下载同一 URL 的 CDN 配置" },
      );
      const forcedDownloads = (await requests(CDN_HOST, "/release-b.json")).length;
      await writeFile(
        join(artifacts, "asserted-cadence.json"),
        JSON.stringify(
          {
            elapsedMs,
            controlRequests: (await requests(CONTROL_HOST, "/api/v1/client/configs")).map(
              (record) => record.startedAt,
            ),
            releaseA: (await requests(CDN_HOST, "/release-a.json")).length,
            releaseB: (await requests(CDN_HOST, "/release-b.json")).length,
            releaseBBeforeForce,
            releaseBAfterForce: forcedDownloads,
          },
          null,
          2,
        ),
      );
    } finally {
      repository.dispose();
      await proxy?.stop();
    }
  });
});
