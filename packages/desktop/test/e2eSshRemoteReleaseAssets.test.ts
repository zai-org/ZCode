import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  ensureSshRemoteReleaseAssets,
  resolveSshRemoteReleaseScope,
  type SshRemoteReleasePrepareRequest,
} from "./e2e/helpers/e2e-ssh-remote-release-assets.js";

const RELEASE_DIR = "/repo/packages/desktop/mock-cdn/releases/3.12.0";
const DESCRIPTOR_PATH = `${RELEASE_DIR}/source-server-release.json`;
// 与 stage:remote-assets（remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives）
// 的实际产物一致：descriptor 最后原子写入，四个 archive 按 target 命名。
const RELEASE_FILES = [
  "source-server-release.json",
  "zcode-server-linux-x64.tar.gz",
  "zcode-server-linux-arm64.tar.gz",
  "zcode-server-darwin-x64.tar.gz",
  "zcode-server-darwin-arm64.tar.gz",
];

function normalize(path: string) {
  // join 的分隔符随平台变化，fake IO 统一归一化成 posix 形式保证跨 OS 稳定。
  return path.split("\\").join("/");
}

function descriptor(targets: string[]) {
  return JSON.stringify({
    schemaVersion: 1,
    version: "3.12.0",
    archives: targets.map((target) => ({
      target,
      version: "3.12.0",
      fileName: `zcode-server-${target}.tar.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      urls: [`zcode-server-${target}.tar.gz`],
    })),
  });
}

/** 发布目录的假实现：exists/readText 读同一份内存文件表，prepare 可以改写它。 */
function createFakeRelease(files: Record<string, string>) {
  const table = new Map(
    Object.entries(files).map(([name, text]) => [`${RELEASE_DIR}/${name}`, text]),
  );
  return {
    table,
    exists: vi.fn(async (path: string) => table.has(normalize(path))),
    writeText: vi.fn(async (path: string, text: string) => {
      table.set(normalize(path), text);
    }),
    readText: vi.fn(async (path: string) => {
      const text = table.get(normalize(path));
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    }),
  };
}

const ALL_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

/** 全平台完整发布：descriptor 登记四个 target，四个 archive 都在。 */
function completeAllRelease(): Record<string, string> {
  return {
    ...Object.fromEntries(RELEASE_FILES.map((name) => [name, "archive"])),
    "source-server-release.json": descriptor(ALL_TARGETS),
  };
}

describe("ensureSshRemoteReleaseAssets（默认全平台判断）", () => {
  it.each([undefined, "previous-commit", "current-commit"])(
    "only reuses complete CI archives built for the current revision (receipt=%s)",
    async (receipt) => {
      const files = completeAllRelease();
      if (receipt) files[".e2e-build-revision"] = receipt;
      const fixture = createFakeRelease(files);
      const prepareReleaseAssets = vi.fn();
      const prepared = await ensureSshRemoteReleaseAssets({
        ...fixture,
        releaseDir: RELEASE_DIR,
        buildRevision: "current-commit",
        prepareReleaseAssets,
      });
      expect(prepared).toBe(receipt !== "current-commit");
      expect(prepareReleaseAssets).toHaveBeenCalledTimes(receipt === "current-commit" ? 0 : 1);
      expect(fixture.table.get(`${RELEASE_DIR}/.e2e-build-revision`)).toBe("current-commit");
    },
  );

  it("invalidates the old receipt before prepare so a failed build cannot be reused", async () => {
    const files = completeAllRelease();
    delete files[RELEASE_FILES.at(-1)!];
    const fixture = createFakeRelease({ ...files, ".e2e-build-revision": "current-commit" });
    const options = { ...fixture, releaseDir: RELEASE_DIR, buildRevision: "current-commit" };
    await expect(
      ensureSshRemoteReleaseAssets({
        ...options,
        prepareReleaseAssets: async () => {
          fixture.table.set(`${RELEASE_DIR}/${RELEASE_FILES.at(-1)}`, "partial");
          throw new Error("build interrupted");
        },
      }),
    ).rejects.toThrow("build interrupted");
    expect(fixture.table.get(`${RELEASE_DIR}/.e2e-build-revision`)).toBe("");
    const prepareReleaseAssets = vi.fn();
    expect(await ensureSshRemoteReleaseAssets({ ...options, prepareReleaseAssets })).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
    expect(fixture.table.get(`${RELEASE_DIR}/.e2e-build-revision`)).toBe("current-commit");
  });

  it("skips prepare when the descriptor lists all four targets and their archives exist", async () => {
    const prepareReleaseAssets = vi.fn();

    const prepared = await ensureSshRemoteReleaseAssets({
      ...createFakeRelease(completeAllRelease()),
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("does not treat legacy manifest-<platform>.json files as a complete release", async () => {
    // Bug 根因：分支把 remote release 切换成 descriptor+archive 布局并删掉了
    // scripts/prepare-prebuilds.mjs，但 staging 合入的 helper 仍以四份 manifest 为完成态哨兵，
    // 新布局永远判“不完整”；旧布局残留目录也不能再被当成可用 release。
    const release = createFakeRelease(
      Object.fromEntries(
        ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"].map((platform) => [
          `manifest-${platform}.json`,
          "{}",
        ]),
      ),
    );
    const prepareReleaseAssets = vi.fn(() => {
      for (const [name, text] of Object.entries(completeAllRelease()))
        release.table.set(`${RELEASE_DIR}/${name}`, text);
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("re-prepares when the release dir exists but the descriptor is missing", async () => {
    // 复查回归（issueId Q-a2867155a0ed0492e7f5）：目录存在性判幂等时，prepare 中途取消
    // 残留的半成品目录会永久跳过自愈。beginSourceServerRemoteReleaseGeneration 在开始时
    // 删除 descriptor、collect 全部完成后才重新写入，因此 descriptor 缺失即为不完整。
    const files = completeAllRelease();
    delete files["source-server-release.json"];
    const release = createFakeRelease(files);
    const prepareReleaseAssets = vi.fn(() => {
      release.table.set(DESCRIPTOR_PATH, descriptor(ALL_TARGETS));
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("runs the full-platform entry without env overrides when nothing is declared", async () => {
    // 未声明「只需 Linux」时（服务器队列、CI）保持原行为：调用全平台入口，不改 ZCODE_ENV。
    const release = createFakeRelease({});
    const prepareReleaseAssets = vi.fn((_request: SshRemoteReleasePrepareRequest) => {
      for (const [name, text] of Object.entries(completeAllRelease()))
        release.table.set(`${RELEASE_DIR}/${name}`, text);
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledExactlyOnceWith({
      script: "prepare:remote-assets",
      env: {},
      args: [],
    });
  });

  it("stays fail-closed and names the missing archives when prepare does not complete", async () => {
    const prepareReleaseAssets = vi.fn();
    const release = createFakeRelease({
      "source-server-release.json": descriptor(ALL_TARGETS),
      "zcode-server-linux-x64.tar.gz": "x64",
    });

    await expect(
      ensureSshRemoteReleaseAssets({
        ...release,
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
      }),
    ).rejects.toThrow(
      /prepare:remote-assets.*\/releases\/3\.12\.0.*zcode-server-linux-arm64\.tar\.gz, zcode-server-darwin-x64\.tar\.gz, zcode-server-darwin-arm64\.tar\.gz/u,
    );
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });
});

// Bug 根因（!3777 评审 CR-02）：Linux 范围重建只替换两个 Linux 目标、descriptor 只登记它们，
// 旧 darwin archive 仍留在同一目录。全平台判断原来只看文件存在，切回 all 时会复用，
// 远端 darwin 安装按 descriptor 查不到目标而在连接阶段失败。两种范围必须按 descriptor 判断。
describe("ensureSshRemoteReleaseAssets（all → linux → all 切换）", () => {
  it.each([undefined, "commit-2"])(
    "rebuilds the full release after a Linux-only rebuild left stale darwin archives (revision=%s)",
    async (buildRevision) => {
      const release = createFakeRelease({
        ...completeAllRelease(),
        ".e2e-build-revision": "commit-1",
      });
      const publish = (targets: readonly string[]) => () => {
        // 与发布器一致：只覆盖本轮目标的 archive，descriptor 只登记本轮目标。
        for (const target of targets)
          release.table.set(`${RELEASE_DIR}/zcode-server-${target}.tar.gz`, "fresh");
        release.table.set(DESCRIPTOR_PATH, descriptor([...targets]));
      };

      // 1. Linux 范围重建：darwin archive 留在目录里，但 descriptor 不再登记它们。
      await ensureSshRemoteReleaseAssets({
        ...release,
        releaseDir: RELEASE_DIR,
        buildRevision: "commit-2",
        scope: "linux",
        prepareReleaseAssets: publish(["linux-x64", "linux-arm64"]),
      });
      expect(release.table.has(`${RELEASE_DIR}/zcode-server-darwin-x64.tar.gz`)).toBe(true);

      // 2. 切回全平台：即使回执匹配（或本机不传提交），也必须重建。
      const prepareAll = vi.fn(publish(ALL_TARGETS));
      const prepared = await ensureSshRemoteReleaseAssets({
        ...release,
        releaseDir: RELEASE_DIR,
        buildRevision,
        prepareReleaseAssets: prepareAll,
      });

      expect(prepared).toBe(true);
      expect(prepareAll).toHaveBeenCalledOnce();
      const finalDescriptor = JSON.parse(release.table.get(DESCRIPTOR_PATH)!) as {
        archives: Array<{ target: string }>;
      };
      expect(finalDescriptor.archives.map((archive) => archive.target).sort()).toEqual(
        [...ALL_TARGETS].sort(),
      );
    },
  );
});

// Bug 根因（!3777 评审 CR-01 第二轮）：ZCODE_E2E_SKIP_AGENT_BUILD=1 时 onPrepare 不构建 agent，只检查入口
// 存在；打包器若仍跳过首个 target 的 agent 重建，会把工作区里的旧 bundle 打进 archive，再写入当前
// 提交回执，之后同提交运行一直复用这个错版本的包。只有本轮 onPrepare 真实构建过 agent 才能跳过。
describe("ensureSshRemoteReleaseAssets（打包器是否复用本轮 agent）", () => {
  it.each([
    [true, ["--skip-agent-build"]],
    [false, []],
    [undefined, []],
  ])("agentBundleBuiltThisRun=%s → prepare args %j", async (agentBundleBuiltThisRun, args) => {
    const release = createFakeRelease({ ".e2e-build-revision": "commit-0" });
    const prepareReleaseAssets = vi.fn((_request: SshRemoteReleasePrepareRequest) => {
      for (const [name, text] of Object.entries(completeAllRelease()))
        release.table.set(`${RELEASE_DIR}/${name}`, text);
    });

    await ensureSshRemoteReleaseAssets({
      ...release,
      releaseDir: RELEASE_DIR,
      buildRevision: "commit-1",
      agentBundleBuiltThisRun,
      prepareReleaseAssets,
    });

    expect(prepareReleaseAssets).toHaveBeenCalledExactlyOnceWith({
      script: "prepare:remote-assets",
      env: {},
      args,
    });
    expect(release.table.get(`${RELEASE_DIR}/.e2e-build-revision`)).toBe("commit-1");
  });
});

describe("ensureSshRemoteReleaseAssets（声明只需 Linux）", () => {
  it("accepts a descriptor that lists only the two Linux targets", async () => {
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64", "linux-arm64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "arm64",
    });
    const prepareReleaseAssets = vi.fn();

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
      scope: "linux",
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("rebuilds through the Linux entry with ZCODE_ENV=test, never the full-platform entry", async () => {
    // 磁盘上有 Linux 包但 descriptor 只列了 linux-x64：不能凭文件存在就复用。
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "stale",
    });
    const prepareReleaseAssets = vi.fn((_request: SshRemoteReleasePrepareRequest) => {
      release.table.set(DESCRIPTOR_PATH, descriptor(["linux-x64", "linux-arm64"]));
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
      scope: "linux",
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledExactlyOnceWith({
      script: "prepare:remote-assets:linux",
      env: { ZCODE_ENV: "test" },
      args: [],
    });
  });

  it("does not require darwin archives and fails closed when a Linux archive is still missing", async () => {
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64", "linux-arm64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
    });
    const prepareReleaseAssets = vi.fn();

    await expect(
      ensureSshRemoteReleaseAssets({
        ...release,
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
        scope: "linux",
      }),
    ).rejects.toThrow(/prepare:remote-assets:linux.*zcode-server-linux-arm64\.tar\.gz/u);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
    expect(prepareReleaseAssets.mock.calls[0]?.[0]?.script).toBe("prepare:remote-assets:linux");
  });

  it("treats an unreadable descriptor as incomplete", async () => {
    const release = createFakeRelease({
      "source-server-release.json": "{not json",
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "arm64",
    });
    const prepareReleaseAssets = vi.fn(() => {
      release.table.set(DESCRIPTOR_PATH, descriptor(["linux-x64", "linux-arm64"]));
    });

    expect(
      await ensureSshRemoteReleaseAssets({
        ...release,
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
        scope: "linux",
      }),
    ).toBe(true);
  });
});

describe("resolveSshRemoteReleaseScope", () => {
  it("defaults to all and only switches to linux on the explicit declaration", () => {
    expect(resolveSshRemoteReleaseScope({})).toBe("all");
    expect(resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: " " })).toBe("all");
    expect(resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: "linux" })).toBe("linux");
    expect(() =>
      resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: "darwin" }),
    ).toThrow(/ZCODE_E2E_REMOTE_RELEASE_SCOPE/u);
  });
});

describe("wdio.conf.ts SSH remote assets wiring", () => {
  it("auto-prepares missing remote release assets via the root workspace scripts", async () => {
    const source = await readFile(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const stageDesktopE2EAppOutput = source.slice(
      source.indexOf("async function prepareSshRemoteReleaseForRun("),
      source.indexOf("function isRendererE2EStoreBridgeCompiled"),
    );

    // Bug 根因：版本 bump 后专用 e2e runner 的工作区 mock-cdn 必然缺新版本 release，
    // 直接 fatal 会把每次版本升级都变成 CI-only 失败；必须先自动 prepare 再 fail-closed。
    expect(stageDesktopE2EAppOutput).toContain("await ensureSshRemoteReleaseAssets(");
    expect(stageDesktopE2EAppOutput).not.toContain("SSH remote assets missing");
    // 「只需 Linux」声明来自本机 Docker runner 的环境变量；未声明时 helper 返回全平台入口。
    expect(stageDesktopE2EAppOutput).toContain("resolveSshRemoteReleaseScope(process.env)");
    expect(stageDesktopE2EAppOutput).toContain("buildRevision: process.env.CI_COMMIT_SHA");
    // Bug 根因：packages/desktop 的 prepare:remote-assets 脚本已随 legacy asset pipeline 删除，
    // `pnpm --filter @zcode/desktop prepare:remote-assets` 会以 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
    // 失败并让 onPrepare fatal；唯一有效入口是根 package.json 的脚本（helper 给出脚本名）。
    // 是否跳过打包器的 agent 构建由 helper 按“本轮 onPrepare 是否真实构建”决定，调用点只透传参数。
    expect(stageDesktopE2EAppOutput).toMatch(
      /runPnpmWorkspaceCommand\(\[request\.script, \.\.\.request\.args\]/u,
    );
    expect(stageDesktopE2EAppOutput).not.toContain('"--skip-agent-build"');
    expect(stageDesktopE2EAppOutput).toContain("agentBundleBuiltThisRun");
    expect(stageDesktopE2EAppOutput).not.toMatch(/@zcode\/desktop",\s*"prepare:remote-assets/u);
    // prepare 调用点必须带 timeoutMs：CI 上下载/构建挂死时让 onPrepare 可失败退出，
    // 而不是占住专用 runner 直到 job 全局超时。（本片段内仅 prepare 一处 pnpm 调用。）
    expect(stageDesktopE2EAppOutput).toContain("timeoutMs: ");
    expect(stageDesktopE2EAppOutput).toContain("env: request.env");
  });

  it("prepares the remote release only for scheduled specs that need it, after the single agent build", async () => {
    const source = await readFile(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const prepareRemote = source.slice(
      source.indexOf("async function prepareSshRemoteReleaseForRun("),
      source.indexOf("function isRendererE2EStoreBridgeCompiled"),
    );
    const appStage = source.slice(
      source.indexOf("async function stageDesktopE2EAppOutput()"),
      source.indexOf("async function prepareSshRemoteReleaseForRun("),
    );
    const onPrepare = source.slice(
      source.indexOf("  async onPrepare() {"),
      source.indexOf("  onWorkerStart(cid"),
    );

    // 判据是本轮调度 spec 的 import 关系，而不是 runner 是否配置了 SSH 环境变量。
    expect(prepareRemote).toContain("listSpecsRequiringRemoteRelease(");
    expect(prepareRemote).toContain("resolveE2EScheduledSpecFiles(");
    // worker 兜底读取的目录只能由 onPrepare 在 stage 后经 runnerEnv 下发。
    expect(prepareRemote).toContain("[REMOTE_RELEASE_DIR_ENV]: E2E_REMOTE_RELEASE_OUTPUT_DIR");
    expect(prepareRemote).toContain("withE2EDesktopBuildLock(");
    expect(appStage).not.toContain("ensureSshRemoteReleaseAssets(");

    // 子步骤计时，agent 先于 remote release 构建且只构建一次。
    for (const phase of [
      '"prepare:desktop-build"',
      '"prepare:agent-build"',
      '"prepare:remote-release"',
      '"prepare:plugin-cache"',
    ])
      expect(source).toContain(phase);
    expect(onPrepare.indexOf("prepareZCodeAgentServer()")).toBeGreaterThan(-1);
    expect(onPrepare.indexOf("prepareZCodeAgentServer()")).toBeLessThan(
      onPrepare.indexOf("prepareSshRemoteReleaseForRun("),
    );
  });
});
