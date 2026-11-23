import { spawn as spawnProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import { spawn } from "node-pty";
import type { createToolSearchCliFixture } from "./toolsearch-cli-process.js";

let tuiBuild: Promise<void> | undefined;

/**
 * 构建 CLI `tui` 子命令加载的 `@zcode/tui` dist；同一 worker 只构建一次。
 * 修复原因：`zcode.cjs` 把 `@zcode/tui` 作为外部模块，从其 `dist/index.js` 加载；desktop agent
 * 构建（scripts/build-desktop-agent-cli.mjs）不产出该 dist，干净的 Windows CI 工作区里 TUI 启动即报
 * `Cannot find module …/@zcode/tui/dist/index.js`（PTY 捕获为证），用例只表现为"TUI 未完成首帧
 * 终端绘制"。本地残留旧 dist 时也会跑到过期 TUI，因此每次运行都重新构建。
 */
export function ensureToolSearchTuiBuild(): Promise<void> {
  tuiBuild ??= new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawnProcess("pnpm", ["--filter", "@zcode/tui", "build"], {
      cwd: resolve(process.cwd(), "../.."),
      stdio: "inherit",
      // Windows 上 pnpm 是 .cmd 包装脚本，必须经 shell 启动。
      shell: process.platform === "win32",
    });
    child.on("error", rejectBuild);
    child.on("exit", (code) =>
      code === 0 ? resolveBuild() : rejectBuild(new Error(`@zcode/tui 构建失败，退出码 ${code}`)),
    );
  });
  return tuiBuild;
}

/** 真实终端输入，不替换 TUI renderer、submit handler 或 runtime。调用前须先 ensureToolSearchTuiBuild()。 */
export function startToolSearchTerminal(
  fixture: Awaited<ReturnType<typeof createToolSearchCliFixture>>,
  args: string[],
) {
  // 仓库中的 TUI 是外置 workspace 模块，依赖共享包的 TS 入口；沿用 tsx 解析源码导入。
  const tsx = pathToFileURL(createRequire(join(process.cwd(), "package.json")).resolve("tsx")).href;
  const terminal = spawn(
    process.execPath,
    ["--import", tsx, fixture.cliPath, "tui", ...args, "--no-browser", "--locale", "en-US"],
    {
      name: "xterm-256color",
      // 系统 ConPTY 会先关输出管道再回传退出码；使用 node-pty 自带版本保证退出事件完整。
      useConptyDll: process.platform === "win32",
      cols: 140,
      rows: 40,
      cwd: fixture.workspace,
      env: { ...fixture.env, TERM: "xterm-256color" },
    },
  );
  let output = "";
  let exited = false;
  terminal.onData((data) => {
    output += data;
  });
  const done = new Promise<number>((resolve) =>
    terminal.onExit(({ exitCode }) => {
      exited = true;
      resolve(exitCode);
    }),
  );
  return {
    done,
    output: () => stripVTControlCharacters(output),
    // ConPTY 的能力探测也会输出同步帧结束序列；只有输入框占位符才证明 TUI 已可输入。
    ready: () => stripVTControlCharacters(output).includes("Type a prompt"),
    frameCount: () => output.split("\x1b[?2026l").length - 1,
    write: (text: string) => terminal.write(text),
    async close() {
      if (!exited) terminal.kill();
      await done;
      const capture = process.env.E2E_PROVIDER_CAPTURE_PATH;
      if (capture) await writeFile(`${capture}.pty-${terminal.pid}.txt`, output);
    },
  };
}
