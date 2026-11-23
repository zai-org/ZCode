import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { buildProductGitArgs, createGitCommandProvider } from "../../packages/services/src/git/providers/gitCommandProvider.ts";
import { getGitNullDevicePath } from "../../packages/services/src/git/config.ts";

// 运行时验收：仓库内的 .gitattributes 与 .git/config 可以安排 external diff、textconv、fsmonitor
// 三条外部命令通道（ZP-20261105-08）。这里用真实 git 与临时仓库确认产品 Git 入口不会启动它们。
// 脚本只追加一行通道名到标记文件，textconv 额外输出可区分的文本，用于断言 patch 来自原文。

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ["-c", "user.name=zcode-test", "-c", "user.email=zcode-test@example.com"];

let root: string;
let repo: string;
let markerPath: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_IDENTITY, ...args], { cwd: repo });
  return stdout;
}

async function readMarkers(): Promise<string> {
  return await readFile(markerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function clearMarkers(): Promise<void> {
  await rm(markerPath, { force: true });
}

describe("产品 Git 子进程不执行仓库配置的外部命令", () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-git-invocation-"));
    repo = join(root, "repo");
    markerPath = join(root, "markers.log");
    const payloadPath = join(root, "payload", "channel.mjs");
    await mkdir(join(root, "payload"));
    await writeFile(
      payloadPath,
      [
        'import { appendFileSync } from "node:fs";',
        "const channel = process.argv[2];",
        `appendFileSync(${JSON.stringify(markerPath)}, channel + "\\n");`,
        'if (channel === "textconv") process.stdout.write("CONVERTED\\n");',
        "",
      ].join("\n"),
    );
    const command = (channel: string) => `"${process.execPath}" "${payloadPath}" ${channel}`;

    await mkdir(repo);
    await git(["init", "-q"]);
    await writeFile(join(repo, ".gitattributes"), "data.txt diff=evil\n");
    await writeFile(join(repo, "data.txt"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "init"]);
    await writeFile(join(repo, "data.txt"), "hello world\n");

    await git(["config", "diff.external", command("external")]);
    await git(["config", "diff.evil.textconv", command("textconv")]);
    await git(["config", "core.fsmonitor", command("fsmonitor")]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("对照：原生 git 确实会执行三条通道，证明负载可运行", async () => {
    await clearMarkers();
    await execFileAsync("git", ["diff"], { cwd: repo }).catch(() => undefined);
    assert.match(await readMarkers(), /^external$/m);

    await clearMarkers();
    await execFileAsync("git", ["diff", "--no-ext-diff"], { cwd: repo });
    assert.match(await readMarkers(), /^textconv$/m, "--no-ext-diff 不禁止 textconv");

    await clearMarkers();
    await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    assert.match(await readMarkers(), /^fsmonitor$/m);
  });

  // 调用方即使自带 --no-ext-diff，也只禁止了 external 通道；入口必须补上 textconv 与 fsmonitor 的禁用。
  const cases: Array<{ name: string; args: string[]; exitCodes: number[]; patch: boolean }> = [
    {
      name: "diff 带 --no-ext-diff",
      args: ["diff", "--no-ext-diff", "--binary"],
      exitCodes: [0],
      patch: true,
    },
    { name: "diff 不带调用方防护", args: ["diff", "--binary"], exitCodes: [0], patch: true },
    { name: "show", args: ["show", "--no-ext-diff", "HEAD"], exitCodes: [0], patch: true },
    { name: "log -p", args: ["log", "--no-ext-diff", "-p", "-1"], exitCodes: [0], patch: true },
    {
      name: "diff --no-index（未跟踪文件）",
      args: ["diff", "--no-index", "--binary", getGitNullDevicePath(), "data.txt"],
      exitCodes: [1],
      patch: true,
    },
    {
      name: "status",
      args: ["status", "--porcelain=v2", "--branch", "-z"],
      exitCodes: [0],
      patch: false,
    },
  ];

  for (const { name, args, exitCodes, patch } of cases) {
    it(`经产品入口执行 ${name} 不启动任何外部命令`, async () => {
      const provider = createGitCommandProvider();
      await clearMarkers();
      const result = await provider.run({ cwd: repo, args });

      assert.ok(
        exitCodes.includes(result.exitCode ?? -1),
        `退出码异常：${result.exitCode} ${result.stderr}`,
      );
      assert.equal(await readMarkers(), "", "不得启动 external / textconv / fsmonitor 负载");
      if (patch) {
        assert.doesNotMatch(result.stdout, /CONVERTED/, "patch 必须来自原始文件内容");
        assert.match(result.stdout, /\+hello/, "输出应包含原始文本");
      }
    });
  }
});

// 参数组装是纯函数，不需要 git 进程：防护参数必须紧跟子命令，并且只按 args[0] 识别子命令。
describe("buildProductGitArgs", () => {
  const prefix = ["-c", "core.fsmonitor="];
  const guard = ["--no-ext-diff", "--no-textconv"];

  it("show、log、diff 紧跟子命令带上防护参数，调用方参数原样保留", () => {
    assert.deepEqual(buildProductGitArgs(["diff", "--stat", "HEAD"]), [...prefix, "diff", ...guard, "--stat", "HEAD"]);
    assert.deepEqual(buildProductGitArgs(["show", "HEAD:README.md"]), [...prefix, "show", ...guard, "HEAD:README.md"]);
    assert.deepEqual(buildProductGitArgs(["log", "-p", "-n", "1"]), [...prefix, "log", ...guard, "-p", "-n", "1"]);
  });

  it("不输出 patch 的子命令不加防护参数", () => {
    assert.deepEqual(buildProductGitArgs(["status", "--porcelain"]), [...prefix, "status", "--porcelain"]);
  });

  it("子命令前置全局选项时防护不生效：这是调用方约定，不是修复目标", () => {
    // 若将来改为解析全局选项，应同步更新本断言与 buildProductGitArgs 注释。
    assert.deepEqual(buildProductGitArgs(["-c", "color.ui=never", "diff"]), [
      ...prefix,
      "-c",
      "color.ui=never",
      "diff",
    ]);
  });
});
