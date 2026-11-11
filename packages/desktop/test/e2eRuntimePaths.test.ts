import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findE2EBashOutputPath,
  E2E_RUNTIME_RELATIVE_ROOT,
  E2E_RUNTIME_ROOT_REPLAY_TOKEN,
  createE2EReplayFixtureVariables,
  isIsolatedE2EHomeDir,
  resolveE2EHomeDir,
  resolveE2EStorageRoot,
  resolveE2ERuntimePath,
  resolveE2ERuntimeRoot,
  resolveE2EShellPath,
  resolveE2EToolPath,
} from "./e2e/helpers/e2e-runtime-paths.js";

const DESKTOP_TEST_DIR = import.meta.dirname;
const E2E_DIR = join(DESKTOP_TEST_DIR, "e2e");
const SOURCE_EXTENSIONS = new Set([".js", ".json", ".mjs", ".ts", ".tsx"]);
// 这条守卫约束的是「Desktop E2E 自己的 runtime 文件不许落在本机系统 /tmp」。
// R3A-BLD-09 的被测对象恰好是远端主机的 /tmp（8MB noexec tmpfs），用例必须断言
// 远端 mount 属性以及安装后 /tmp 无 zcode-server 残留，这里的 /tmp 不是本地 runtime 路径。
// 新增豁免必须像这样显式登记并说明理由，避免守卫被整体放宽。
const REMOTE_TMP_ASSERTION_SOURCES = new Set([
  "conversation-session/remote/installation/manual-review/pending/conversation-session-r3-install-environment.test.ts",
  // 数字 UID 的 HOME/workdir 位于被测 Docker 容器；不是 Desktop 宿主上的 runtime 文件。
  "conversation-session/remote/connection/manual-review/pending/conversation-session-r3-docker-transport.test.ts",
  // 修复原因：以下用例在 10-27 / 11-03 合入时未登记豁免，守卫在 staging 上已失败。
  // 被测 SSH/Docker 容器内的 /tmp：私有 tmp 挂载、探针夹具、采样/kill 日志、鉴权计数与安装包。
  "conversation-session/remote/installation/manual-review/pending/conversation-session-r3-daemon-service-fallback.test.ts",
  "conversation-session/remote/installation/manual-review/pending/conversation-session-ssh-probe-validation.test.ts",
  "conversation-session/remote/installation/manual-review/pending/conversation-session-ssh-remote-daemon-starting-reuse.test.ts",
  "conversation-session/remote/installation/manual-review/pending/conversation-session-ssh-remote-install-killed.test.ts",
  "conversation-session/remote/installation/manual-review/pending/conversation-session-ssh-remote-legacy-install-handoff.test.ts",
  "helpers/remote-restart-stale-daemon.ts",
  // 本机 Unix socket 需要短绝对路径（sun_path 约 104 字符上限），放进隔离 HOME 会超长；
  // 文件只是监听地址，不承载 E2E runtime 状态，用例结束即删除。
  "conversation-session/remote/installation/manual-review/pending/conversation-session-r3-docker-daemon-unavailable.test.ts",
]);
// 只匹配作为绝对路径起点的系统 /tmp：前面不能紧跟路径字符，后面不能继续是单词字符。
// 缺陷原因：此前用 includes("/tmp") 子串匹配，把远端 Source 的私有 staging 目录
// "$HOME/.zcode/tmp/prompt-attachments" 也当成了系统 /tmp（R3 attachments 用例被误报）。
const SYSTEM_TMP_PATH_PATTERN = /(?<![\w.\-~}$])\/tmp(?![\w-])/u;

describe("Desktop E2E runtime paths", () => {
  it("keeps runtime files below the isolated Agent execution workspace", () => {
    const e2eHomeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2ERuntimeRoot(e2eHomeDir)).toBe(join(e2eHomeDir, "ZCodeProject", ".zcode-e2e"));
    expect(resolveE2ERuntimePath("bg25", "release-child-bash")).toBe(
      join(resolveE2ERuntimeRoot(), "bg25", "release-child-bash"),
    );
  });

  it("uses portable absolute tool paths and workspace-relative shell paths", () => {
    expect(resolveE2EToolPath("bg25", "continued-work.txt")).toBe(
      resolveE2ERuntimePath("bg25", "continued-work.txt").replaceAll("\\", "/"),
    );
    expect(resolveE2EShellPath("bg25", "release-child-bash")).toBe(
      ".zcode-e2e/bg25/release-child-bash",
    );
    expect(E2E_RUNTIME_RELATIVE_ROOT).toBe(".zcode-e2e");
    expect(E2E_RUNTIME_ROOT_REPLAY_TOKEN).toBe("{{e2eRuntimeRoot}}");
    expect(createE2EReplayFixtureVariables(resolve("root", "fixture-home"))).toEqual({
      e2eRuntimeRoot: resolveE2ERuntimeRoot(resolve("root", "fixture-home")).replaceAll("\\", "/"),
    });
  });

  it("uses the existing E2E HOME precedence", () => {
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: { ZCODE_DATA_BASE_DIR: resolve("root", "data-base") },
      }),
    ).toBe(resolve("root", "data-base"));
    expect(
      resolveE2EHomeDir({
        cwd: resolve("root", "desktop"),
        env: {
          ZCODE_DATA_BASE_DIR: resolve("root", "data-base"),
          ZCODE_E2E_HOME_DIR: resolve("root", "explicit-home"),
        },
      }),
    ).toBe(resolve("root", "explicit-home"));
  });

  it("keeps the E2E CLI storage under the legacy .zcode directory", () => {
    const homeDir = resolve("root", "isolated-e2e-home");

    expect(resolveE2EStorageRoot(homeDir)).toBe(join(homeDir, ".zcode"));
  });

  it("accepts only runner-isolated E2E HOME directories for fixture-writing guards", () => {
    expect(isIsolatedE2EHomeDir(resolve("repo", "desktop", ".e2e-home"))).toBe(true);
    expect(isIsolatedE2EHomeDir(resolve("repo", "desktop", ".e2e-home-run1"))).toBe(true);
    expect(isIsolatedE2EHomeDir(resolve("repo", "desktop", ".e2e-home-run1-shard-2"))).toBe(true);
    // 显式根目录名带 .e2e-home 时，分片子目录同样放行。
    expect(isIsolatedE2EHomeDir(resolve("srv", ".e2e-home", "run1", "shard-1-of-2"))).toBe(true);
    // 显式根目录名不带 .e2e-home 时无法与真实目录区分，守卫保守拒绝。
    expect(isIsolatedE2EHomeDir(resolve("srv", "e2e-root", "run1", "shard-1-of-2"))).toBe(false);
    expect(isIsolatedE2EHomeDir(resolve("Users", "dev"))).toBe(false);
    expect(isIsolatedE2EHomeDir(undefined)).toBe(false);
    expect(isIsolatedE2EHomeDir("  ")).toBe(false);
  });

  it("does not allow raw system /tmp paths in Desktop E2E runtime sources", () => {
    const offenders = collectSourceFiles(E2E_DIR)
      .filter((path) => SYSTEM_TMP_PATH_PATTERN.test(readFileSync(path, "utf-8")))
      .map((path) => relative(E2E_DIR, path).replaceAll("\\", "/"))
      .filter((path) => !REMOTE_TMP_ASSERTION_SOURCES.has(path));

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(path);
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
  });
}

it("Bash 输出查找按 session/tool 隔离，区分清理完成与多个实际文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "e2e-output-path-"));
  const storageRoot = join(root, "storage");
  const sessionId = "session_current";
  const toolCallId = "tool_current";
  const create = async (dir: string, session = sessionId) => {
    const path = join(root, dir, session, `${toolCallId}-stdout.log`);
    await mkdir(join(root, dir, session), { recursive: true });
    await writeFile(path, "output");
    return path;
  };
  try {
    await create("zcode-bash-other", "session_other");
    const options = { tempRoot: root, storageRoot };
    expect(await findE2EBashOutputPath(sessionId, toolCallId, options)).toBeNull();
    const path = await create("zcode-bash-current");
    expect(await findE2EBashOutputPath(sessionId, toolCallId, options)).toBe(path);
    await create("zcode-bash-duplicate");
    await expect(findE2EBashOutputPath(sessionId, toolCallId, options)).rejects.toThrow("没有唯一");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
