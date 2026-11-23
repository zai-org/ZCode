import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_SERVER_REMOTE_RELEASE_TARGETS,
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
} from "./remoteAssetRelease.js";

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // Bug 原因：Windows 上 pnpm 只以 .cmd/.ps1 shim 存在，Node 不经 shell 无法解析，
    // spawn("pnpm") 直接 ENOENT；e2e onPrepare 自动 prepare:remote-assets 时因此 fatal。
    // 与 wdio.conf.ts runPnpmWorkspaceCommand 一致，仅 Windows 交给 shell 解析 shim；
    // 当前参数均无空格，无需额外转义。
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const linuxOnly = process.argv.slice(2).includes("--linux");
  // E2E onPrepare 已在本轮构建 agent bundle 时传入：所有 target 复用它，不再构建第二轮。
  const callerBuiltAgent = process.argv.slice(2).includes("--skip-agent-build");
  const targets = linuxOnly
    ? SOURCE_SERVER_REMOTE_RELEASE_TARGETS.filter((target) => target.startsWith("linux-"))
    : SOURCE_SERVER_REMOTE_RELEASE_TARGETS;
  const env = { ...process.env };
  if (linuxOnly) {
    // Linux 开发入口与 dev:desktop 共用 production 默认值，避免远端模型配置退回 test。
    // 原全平台入口继续沿用通用构建器的环境选择规则。
    const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() || "production";
    if (zcodeEnv !== "test" && zcodeEnv !== "production") {
      throw new Error(`Invalid ZCODE_ENV for prepare:remote-assets:linux: ${zcodeEnv}`);
    }
    env.ZCODE_ENV = zcodeEnv;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = resolve(packageRoot, "../..");
  const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const versionReleaseDir = join(repoRoot, "packages/desktop/mock-cdn/releases", version);
  await beginSourceServerRemoteReleaseGeneration({ versionReleaseDir });
  await run("pnpm", ["--filter", "@zcode/server-cli", "build"], repoRoot, env);
  for (const [index, target] of targets.entries()) {
    await run(
      "pnpm",
      [
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        target,
        ...(linuxOnly ? ["--skip-component-archives"] : []),
        ...(index === 0 && !callerBuiltAgent ? [] : ["--skip-agent-build"]),
      ],
      repoRoot,
      env,
    );
  }
  const collected = await collectSourceServerRemoteReleaseArchives({
    distReleaseDir: join(packageRoot, "dist-release"),
    versionReleaseDir,
    version,
    targets,
  });
  for (const path of collected) console.log(`[source-server-release] ${path}`);
}

await main();
