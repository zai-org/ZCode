import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCodeBuiltinRemoteSynchronizer,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  downloadZCodeBuiltinRelease,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";

const CLIENT_CONFIG_PATH = "/api/v1/client/configs?";
const ENDPOINT = "https://zcode-control.example.com";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// 每例都经过真实文件锁、原子写与 Registry 启动；全量并发运行时 5 秒默认值不够。
const CASE_TIMEOUT_MS = 30_000;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      // 独立 CLI 运行时 dispose 后仍可能有收尾写入；重试避免 ENOTEMPTY 让清理失败。
      .map((directory) => rm(directory, { force: true, recursive: true, maxRetries: 10 })),
  );
});

/** 可控的第一跳/CDN 服务端：URL、间隔与 Release revision 都可在用例中途改变。 */
async function createRemote() {
  const root = await mkdtemp(join(tmpdir(), "zcode-builtin-cadence-"));
  temporaryDirectories.push(root);
  const builtin = JSON.parse(
    await readFile(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      "utf8",
    ),
  ) as { revision: number };
  const bundled = join(root, "bundled.json");
  const active = join(root, "active.json");
  await writeFile(bundled, JSON.stringify(builtin));
  await writeFile(active, JSON.stringify(builtin));
  const remote: {
    url: string | undefined;
    intervalSeconds: unknown;
    revision: number;
    cdnStatus: number;
  } = {
    url: "https://cdn.example.com/release-1.json",
    intervalSeconds: 60,
    revision: builtin.revision + 1,
    cdnStatus: 200,
  };
  const configRequests: string[] = [];
  const cdnRequests: string[] = [];
  // 挂起第一跳，模拟“自动刷新正在请求时用户点刷新”。
  let configGate: Promise<void> | undefined;
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(CLIENT_CONFIG_PATH)) {
      configRequests.push(url);
      await configGate;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            configs: {
              ...(remote.url ? { builtin_provider_config_json: remote.url } : {}),
              ...(remote.intervalSeconds === undefined
                ? {}
                : { clientConfigRefreshIntervalSeconds: remote.intervalSeconds }),
            },
          },
        }),
      );
    }
    cdnRequests.push(url);
    if (remote.cdnStatus !== 200) return new Response("unavailable", { status: remote.cdnStatus });
    return new Response(JSON.stringify({ ...builtin, revision: remote.revision }));
  });
  return {
    root,
    bundled,
    active,
    controlFile: join(root, "zcode-builtin-refresh.json"),
    remote,
    request,
    configRequests,
    cdnRequests,
    holdConfig() {
      let release!: () => void;
      configGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        configGate = undefined;
        release();
      };
    },
  };
}

async function readControl(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("Built-in 远端刷新节奏", () => {
  async function createSynchronizer(remote: Awaited<ReturnType<typeof createRemote>>) {
    const clock = { now: 1_800_000_000_000 };
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: remote.bundled,
      activeFilePath: remote.active,
      watch: false,
    });
    await source.read();
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath: remote.controlFile,
      resolveEndpointKey: () => ENDPOINT,
      now: () => clock.now,
      fetchRelease: (endpointOrigin, signal, options) =>
        downloadZCodeBuiltinRelease({
          endpointOrigin,
          signal,
          appVersion: "0.0.0-test",
          platform: "test",
          request: remote.request,
          ...(options?.reuseUrl ? { reuseUrl: options.reuseUrl } : {}),
        }),
    });
    return {
      clock,
      synchronizer,
      dispose() {
        synchronizer.dispose();
        source.dispose();
      },
    };
  }

  it("成功间隔跟随第一跳配置，并从本轮开始计时", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      const startedAt = clock.now;
      expect(await synchronizer.refresh()).toBe("updated");
      const control = await readControl(remote.controlFile);
      expect(control.nextEligibleAt).toBe(startedAt + MINUTE_MS);
      expect(control.releaseUrl).toBe(remote.remote.url);
      expect(control.releaseDownloadedAt).toBe(startedAt);
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("到期判断有 5 秒容差，未到期时不发请求", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      const startedAt = clock.now;
      await synchronizer.refresh();
      clock.now = startedAt + 30_000;
      expect(await synchronizer.refresh()).toBe("skipped");
      expect(remote.configRequests).toHaveLength(1);
      // 60 秒定时器的相位可能比到期时间早几百毫秒；容差保证配置 1 分钟时不会退化成 2 分钟。
      clock.now = startedAt + 56_000;
      expect(await synchronizer.refresh()).toBe("unchanged");
      expect(remote.configRequests).toHaveLength(2);
      expect((await readControl(remote.controlFile)).nextEligibleAt).toBe(
        startedAt + 56_000 + MINUTE_MS,
      );
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("URL 不变时跳过 CDN；URL 变化、超过一小时或 force 时重新下载", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      const startedAt = clock.now;
      expect(await synchronizer.refresh()).toBe("updated");
      expect(remote.cdnRequests).toHaveLength(1);

      clock.now = startedAt + MINUTE_MS;
      expect(await synchronizer.refresh()).toBe("unchanged");
      expect(remote.configRequests).toHaveLength(2);
      expect(remote.cdnRequests).toHaveLength(1);
      // 跳过 CDN 不能刷新“上次下载时间”，否则同 URL 永远不会兜底重下。
      expect((await readControl(remote.controlFile)).releaseDownloadedAt).toBe(startedAt);

      expect(await synchronizer.refresh({ force: true })).toBe("unchanged");
      expect(remote.cdnRequests).toHaveLength(2);

      clock.now = startedAt + HOUR_MS + MINUTE_MS;
      expect(await synchronizer.refresh()).toBe("unchanged");
      expect(remote.cdnRequests).toHaveLength(3);

      remote.remote.url = "https://cdn.example.com/release-2.json";
      remote.remote.revision += 1;
      clock.now += MINUTE_MS;
      expect(await synchronizer.refresh()).toBe("updated");
      expect(remote.cdnRequests.at(-1)).toBe(remote.remote.url);
      expect((await readControl(remote.controlFile)).releaseUrl).toBe(remote.remote.url);
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("一小时间隔的到期轮次略早于一小时，也兜底重下 CDN", async () => {
    const remote = await createRemote();
    remote.remote.intervalSeconds = 3600;
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      const startedAt = clock.now;
      expect(await synchronizer.refresh()).toBe("updated");
      expect(remote.cdnRequests).toHaveLength(1);
      // 检查定时器的相位可能让到期轮次早于一小时几百毫秒；兜底重下必须与到期判断用同一容差，
      // 否则这一轮仍复用 URL，下一轮再推迟一小时，同 URL 的覆盖最长约两小时才生效。
      clock.now = startedAt + HOUR_MS - 1_000;
      expect(await synchronizer.refresh()).toBe("unchanged");
      expect(remote.cdnRequests).toHaveLength(2);
      expect((await readControl(remote.controlFile)).releaseDownloadedAt).toBe(clock.now);
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("普通刷新在途时手动 force：等它结束后再强制下载一次，并发 force 合并为一次", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      expect(await synchronizer.refresh()).toBe("updated");
      clock.now += MINUTE_MS;
      // 到期的普通刷新会复用 URL、跳过 CDN；挂起它的第一跳，在途中点“刷新”。
      const release = remote.holdConfig();
      const normal = synchronizer.refresh();
      await vi.waitFor(() => expect(remote.configRequests).toHaveLength(2));
      const forced = synchronizer.refresh({ force: true });
      expect(synchronizer.refresh({ force: true })).toBe(forced);
      release();
      expect(await normal).toBe("unchanged");
      expect(await forced).toBe("unchanged");
      expect(remote.configRequests).toHaveLength(3);
      expect(remote.cdnRequests).toHaveLength(2);
      expect((await readControl(remote.controlFile)).releaseDownloadedAt).toBe(clock.now);
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("间隔越界按上下限，缺失或非法按一小时", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    const expectInterval = async (intervalSeconds: unknown, expectedMs: number) => {
      remote.remote.intervalSeconds = intervalSeconds;
      clock.now += 2 * HOUR_MS;
      const startedAt = clock.now;
      await synchronizer.refresh();
      expect((await readControl(remote.controlFile)).nextEligibleAt).toBe(startedAt + expectedMs);
    };
    try {
      await expectInterval(5, MINUTE_MS);
      await expectInterval(999_999, HOUR_MS);
      await expectInterval(90.9, 90_000);
      await expectInterval(undefined, HOUR_MS);
      await expectInterval("60", HOUR_MS);
      await expectInterval(-1, HOUR_MS);
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("下发地址撤销时记为 missing 并清除 URL；下载失败保留上次 URL 并退避", async () => {
    const remote = await createRemote();
    const { clock, synchronizer, dispose } = await createSynchronizer(remote);
    try {
      await synchronizer.refresh();
      const firstUrl = remote.remote.url;

      remote.remote.url = "https://cdn.example.com/release-broken.json";
      remote.remote.cdnStatus = 500;
      clock.now += MINUTE_MS;
      const failedAt = clock.now;
      await expect(synchronizer.refresh()).rejects.toThrow("ZCode Built-in cdn: HTTP 500");
      const failed = await readControl(remote.controlFile);
      expect(failed.failureCount).toBe(1);
      expect(failed.nextEligibleAt).toBe(failedAt + MINUTE_MS);
      expect(failed.releaseUrl).toBe(firstUrl);

      remote.remote.url = undefined;
      clock.now += 2 * MINUTE_MS;
      const missingAt = clock.now;
      expect(await synchronizer.refresh()).toBe("missing");
      const missing = await readControl(remote.controlFile);
      expect(missing.failureCount).toBe(0);
      expect(missing.nextEligibleAt).toBe(missingAt + MINUTE_MS);
      expect(missing.releaseUrl).toBeUndefined();
    } finally {
      dispose();
    }
  }, CASE_TIMEOUT_MS);

  it("独立 CLI 运行时按服务端间隔排期，到期复查时 URL 不变不下载 CDN", async () => {
    const remote = await createRemote();
    const events: ZCodeBuiltinRefreshEvent[] = [];
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_DATA_BASE_DIR: remote.root },
    });
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: remote.active,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(remote.root, "personal.json"),
      [ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: remote.bundled,
    };
    const start = () =>
      startProcessProviderRegistryRuntime(env, {
        standalone: {
          credentialStore,
          request: remote.request,
          legacyCliUserConfigFilePath: join(remote.root, "absent.json"),
          onBuiltinRefreshResult: (event) => events.push(event),
        },
      });

    const before = Date.now();
    const first = await start();
    try {
      await vi.waitFor(() => expect(events.map((event) => event.result)).toEqual(["updated"]));
      const control = await readControl(remote.controlFile);
      expect(control.nextEligibleAt as number).toBeGreaterThanOrEqual(before + MINUTE_MS);
      expect(control.nextEligibleAt as number).toBeLessThanOrEqual(Date.now() + MINUTE_MS);
      expect(control.releaseUrl).toBe(remote.remote.url);
    } finally {
      first.dispose();
    }

    // 模拟下一次定时检查：只把到期时间提前，保留上次下载的 URL 记录。
    await writeFile(
      remote.controlFile,
      JSON.stringify({ ...(await readControl(remote.controlFile)), nextEligibleAt: 0 }),
    );
    const second = await start();
    try {
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1]?.result).toBe("unchanged");
      expect(remote.configRequests).toHaveLength(2);
      expect(remote.cdnRequests).toHaveLength(1);
    } finally {
      second.dispose();
    }
  }, CASE_TIMEOUT_MS);
});
