/**
 * git.* / files.glob / files.grep world reads（driver 侧）。见 docs/execution-engine.md 的
 * "World-read execution, per op family" 与 "Cap enforcement sits in the driver, with the
 * constants in the pure package"。
 *
 * 这份用例钉三件事，每一件都是"只读按构造"的一部分：
 *
 *   1. **每个 op 的 argv 逐元素精确**。argv 就是这个原语的安全边界——没有 shell 字符串，
 *      path 总在 `--` 之后，base 缺省是 HEAD。所以断言不是"包含 diff"，而是整个数组相等：
 *      多一个元素、少一个 `--`，都是一次真实的语义变化。
 *   2. **实参校验在 driver**（Boundary A 只承诺按位置原样送达）。尾部可选的接受/拒绝矩阵，
 *      以及 base / path 的字符集拒绝，都在这里。
 *   3. **上限溢出拒绝节点**（`WorldReadCapExceeded`），既不截断也不折成 DriverError。
 *
 * 为什么独立成文件而不并入 workflow-driver.test.ts：那份用例经 helpers 在运行时 import
 * `@zcode/core`（真实 AgentRuntime），而本文件只碰 driver 的世界读取面（它对 `@zcode/core`
 * 只有类型导入），因此不依赖模型侧的任何东西。同 workflow-driver-world-read-args.test.ts。
 */

import { describe, expect, it } from "vitest";
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  FileSystemPort,
  FileSystemSearchFilesRequest,
  FileSystemSearchTextEntry,
  FileSystemSearchTextRequest,
} from "@zcode/contracts";
import {
  FACADE_DTS,
  InMemoryJournalStore,
  WORLD_READ_CAPS,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";

const CWD = "/ws";

/** 一次被记录下来的 git 调用（argv 与 cwd 都要能断言）。 */
interface GitCall {
  argv: string[];
  cwd?: string;
  maxInlineBytes?: number;
}

/** 一条脚本化的 git 响应；按调用顺序取用。 */
interface GitReply {
  stdout?: string;
  /** stdout 的总字节数；缺省按 stdout 算。用于伪造"被截断的大输出"。 */
  bytes?: number;
  truncated?: boolean;
  exitCode?: number;
  status?: ExecutionResult["status"];
  stderr?: string;
}

/**
 * 拼一段 `-z` 输出：段以 NUL **终止**（不是分隔），所以末尾也有一个 NUL——真 git 就是这样，
 * 而它会在 split 后留下一个空段，解析器必须容得下。
 */
function nul(...segments: string[]): string {
  return segments.map((segment) => `${segment}\u0000`).join("");
}

/** `rev-parse --show-prefix` 在仓库根的回复：空前缀（只有一个换行）。 */
const PREFIX_AT_ROOT: GitReply = { stdout: "\n" };

function fakeExecutionPort(replies: GitReply[]): {
  port: ExecutionPort;
  calls: GitCall[];
} {
  const calls: GitCall[] = [];
  let at = 0;
  const port: ExecutionPort = {
    async run(request: ExecutionRequest): Promise<ExecutionResult> {
      if (request.command.mode !== "argv") {
        // 只读按构造的核心：driver 绝不构造 shell 命令。走到这里就是回归。
        throw new Error(`world-read git 必须用 argv 模式，收到 ${request.command.mode}`);
      }
      expect(request.command.file).toBe("git");
      calls.push({
        argv: [...(request.command.args ?? [])],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.outputLimit?.maxInlineBytes === undefined
          ? {}
          : { maxInlineBytes: request.outputLimit.maxInlineBytes }),
      });
      const reply = replies[at] ?? {};
      at += 1;
      const stdout = reply.stdout ?? "";
      return {
        status: reply.status ?? "completed",
        exitCode: reply.exitCode ?? 0,
        stdout: {
          text: stdout,
          bytes: reply.bytes ?? Buffer.byteLength(stdout, "utf8"),
          truncated: reply.truncated ?? false,
        },
        stderr: { text: reply.stderr ?? "", bytes: 0, truncated: false },
        durationMs: 0,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(0),
        completedAt: new Date(0),
      };
    },
  };
  return { calls, port };
}

/** fs 端口：只实现 searchText（grep），其余被触及即失败。 */
function fakeFileSystemPort(
  entries: FileSystemSearchTextEntry[],
  options: { truncated?: boolean; globFiles?: string[]; globTruncated?: boolean } = {},
): {
  port: FileSystemPort;
  requests: FileSystemSearchTextRequest[];
  readPaths: string[];
  globRequests: FileSystemSearchFilesRequest[];
} {
  const requests: FileSystemSearchTextRequest[] = [];
  const readPaths: string[] = [];
  const globRequests: FileSystemSearchFilesRequest[] = [];
  const unsupported = (name: string) => () => {
    throw new Error(`fakeFileSystemPort.${name} 不应被本用例触及`);
  };
  const port = {
    async searchFiles(request: FileSystemSearchFilesRequest) {
      globRequests.push(request);
      const all = options.globFiles ?? [];
      // 复刻真适配器的截断语义：maxResults 之内切片，truncated 表示还有剩余。
      const files = request.maxResults === undefined ? [...all] : all.slice(0, request.maxResults);
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files,
        numFiles: files.length,
        truncated: options.globTruncated ?? files.length < all.length,
      };
    },
    async searchText(request: FileSystemSearchTextRequest) {
      requests.push(request);
      const limited =
        request.headLimit === undefined ? entries : entries.slice(0, request.headLimit);
      return {
        path: request.path,
        pattern: request.pattern,
        mode: "content" as const,
        durationMs: 0,
        files: [...new Set(limited.map((e) => e.path))],
        entries: limited,
        numMatches: limited.length,
        truncated: options.truncated ?? entries.length > (request.headLimit ?? Infinity),
      };
    },
    async readTextFile(request: { path: string }) {
      readPaths.push(request.path);
      return {
        path: request.path,
        content: "body",
        encoding: "utf-8",
        bytesRead: 4,
        sizeBytes: 4,
        truncated: false,
      };
    },
    createDirectory: unsupported("createDirectory"),
    stat: unsupported("stat"),
    readBinaryFile: unsupported("readBinaryFile"),
    readTextFileRange: unsupported("readTextFileRange"),
    writeTextFile: unsupported("writeTextFile"),
    removeFile: unsupported("removeFile"),
    listDirectory: unsupported("listDirectory"),
  } as unknown as FileSystemPort;
  return { port, readPaths, requests, globRequests };
}

function noopSink(): WorkflowReportSink {
  const unexpected = (name: string) => (): never => {
    throw new Error(`noopSink.${name} 不应被触及`);
  };
  return {
    askSubmitAttempted: unexpected("askSubmitAttempted"),
    askTurnEnded: unexpected("askTurnEnded"),
    askProgress: unexpected("askProgress"),
    askStats: unexpected("askStats"),
    askFailed: unexpected("askFailed"),
  };
}

function makeDriver(input: {
  git?: GitReply[];
  grep?: FileSystemSearchTextEntry[];
  grepTruncated?: boolean;
  glob?: string[];
  globTruncated?: boolean;
}) {
  const exec = fakeExecutionPort(input.git ?? []);
  const fs = fakeFileSystemPort(input.grep ?? [], {
    ...(input.grepTruncated === undefined ? {} : { truncated: input.grepTruncated }),
    ...(input.glob === undefined ? {} : { globFiles: input.glob }),
    ...(input.globTruncated === undefined ? {} : { globTruncated: input.globTruncated }),
  });
  const driver = createAgentRuntimeWorkflowDriver({
    cwd: CWD,
    emit: () => undefined,
    escalationRegistry: createWorkflowEscalationRegistry(),
    executionPort: exec.port,
    fileSystemPort: fs.port,
    journal: new InMemoryJournalStore(),
    runId: "run",
    runtimeFactory: () => {
      throw new Error("世界读取不该创建 actor runtime");
    },
  })(noopSink());
  return {
    driver,
    gitCalls: exec.calls,
    grepRequests: fs.requests,
    readPaths: fs.readPaths,
    globRequests: fs.globRequests,
  };
}

// ————————————————————————————————————————————————————————————————
// argv：只读的边界就是这几个数组
// ————————————————————————————————————————————————————————————————

describe("git world reads — exact argv", () => {
  it("changedFiles with no base unions tracked changes with untracked files", async () => {
    // 两条命令的并集。未跟踪文件对读者而言就是改动——漏掉它们会让这个原语在一条刚开的
    // feature 分支上毫无用处。前面还有一次 rev-parse：线上路径是仓库根相对的，要剥前缀。
    const { driver, gitCalls } = makeDriver({
      git: [PREFIX_AT_ROOT, { stdout: nul("b.ts", "a.ts") }, { stdout: nul("c.ts", "a.ts") }],
    });
    await expect(driver.executeWorldRead("git-changed-files", [])).resolves.toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(gitCalls.map((c) => c.argv)).toEqual([
      ["rev-parse", "--show-prefix"],
      ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--", "."],
      ["ls-files", "--others", "--exclude-standard", "-z", "--full-name", "--", "."],
    ]);
    // 每次调用都以工作区根为 cwd。
    expect(gitCalls.every((c) => c.cwd === CWD)).toBe(true);
  });

  it("changedFiles with a base asks only about tracked history", async () => {
    // "相对某个 ref 改了什么"是关于已跟踪历史的问题——一个从未进过 git 的文件与任何 ref
    // 都无从比较，所以这一路**没有** ls-files。
    const { driver, gitCalls } = makeDriver({
      git: [PREFIX_AT_ROOT, { stdout: nul("src/a.ts") }],
    });
    await expect(driver.executeWorldRead("git-changed-files", ["main"])).resolves.toEqual([
      "src/a.ts",
    ]);
    expect(gitCalls.map((c) => c.argv)).toEqual([
      ["rev-parse", "--show-prefix"],
      ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "main", "--", "."],
    ]);
  });

  it("diff defaults base to HEAD and pathspec to the workspace, always after --", async () => {
    // 无 path 时 pathspec 缺省为 `.`：否则 changedFiles 说"只有 a.md 变了"，而 diff 交出
    // 一段仓库级补丁——两个原语会对"什么算改动"给出不同答案。
    const noPath = makeDriver({ git: [{ stdout: "@@ -1 +1 @@\n" }] });
    await expect(noPath.driver.executeWorldRead("git-diff", [])).resolves.toContain("@@");
    expect(noPath.gitCalls[0]?.argv).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "HEAD",
      "--",
      ".",
    ]);

    const withPath = makeDriver({ git: [{ stdout: "diff" }] });
    await withPath.driver.executeWorldRead("git-diff", ["main", "src/a.ts"]);
    // `--` 是契约的一部分：一个恰好与分支同名的路径不能被 git 解读成 ref（也不能反过来）。
    // 显式 path **取代**缺省 pathspec。
    expect(withPath.gitCalls[0]?.argv).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "main",
      "--",
      "src/a.ts",
    ]);

    const pathOnly = makeDriver({ git: [{ stdout: "diff" }] });
    await pathOnly.driver.executeWorldRead("git-diff", [undefined, "src/a.ts"]);
    expect(pathOnly.gitCalls[0]?.argv).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "HEAD",
      "--",
      "src/a.ts",
    ]);
  });

  it("does not need a prefix lookup for the patch diff (git --relative does that base)", async () => {
    // 补丁文本不是我们解析的路径列表，没法事后剥前缀，所以这一条靠 git 自己的 --relative
    // 对齐基准——也因此不必多跑一次 rev-parse。
    const { driver, gitCalls } = makeDriver({ git: [{ stdout: "diff" }] });
    await driver.executeWorldRead("git-diff", []);
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]?.argv[0]).toBe("diff");
  });

  it("normalizes a windows-style relative path into a git pathspec", async () => {
    // 模型写 windows 风格的相对路径是常事；git 的 pathspec 在三个平台上都吃 `/`。
    const { driver, gitCalls } = makeDriver({ git: [{ stdout: "diff" }] });
    await driver.executeWorldRead("git-diff", ["HEAD", "src\\app\\a.ts"]);
    expect(gitCalls[0]?.argv).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "HEAD",
      "--",
      "src/app/a.ts",
    ]);
  });

  it("status and log use their fixed argv", async () => {
    const status = makeDriver({
      git: [PREFIX_AT_ROOT, { stdout: nul("# branch.head main") }],
    });
    await status.driver.executeWorldRead("git-status", []);
    expect(status.gitCalls.map((c) => c.argv)).toEqual([
      ["rev-parse", "--show-prefix"],
      ["status", "--porcelain=v2", "-z", "--branch", "--", "."],
    ]);

    const dflt = makeDriver({ git: [{ stdout: "" }] });
    await dflt.driver.executeWorldRead("git-log", []);
    // log 刻意**不带** pathspec 也不带 -z：commit 是仓库级对象，给它加 pathspec 会把语义改成
    // "碰过工作区的那些 commit"；而 %s 按定义单行，所以按行切记录是可靠的。
    expect(dflt.gitCalls[0]?.argv).toEqual([
      "log",
      `-n${WORLD_READ_CAPS.gitLogDefaultCount}`,
      "--pretty=format:%H%x00%s%x00%an%x00%aI",
    ]);
    expect(dflt.gitCalls).toHaveLength(1);

    const five = makeDriver({ git: [{ stdout: "" }] });
    await five.driver.executeWorldRead("git-log", [5]);
    expect(five.gitCalls[0]?.argv).toEqual([
      "log",
      "-n5",
      "--pretty=format:%H%x00%s%x00%an%x00%aI",
    ]);
  });
});

// ————————————————————————————————————————————————————————————————
// 工作区收束：线上是仓库根相对，交出去是工作区相对
// ————————————————————————————————————————————————————————————————

describe("git world reads — workspace-relative paths", () => {
  it("strips the workspace prefix when the workspace is a repo subdirectory", async () => {
    // 实测事实：`-z` 让 porcelain status 输出**仓库根相对**路径，且没有任何 flag/config 能
    // 改回 cwd 相对；`diff --name-only` 默认也是根相对。所以基准统一在线上取根相对，由这一侧
    // 剥一次前缀——三条命令各依赖一个不同的 git 默认值，才是那个会吐出两种基准路径的 bug。
    const { driver } = makeDriver({
      git: [
        { stdout: "sub/nested/\n" },
        { stdout: nul("sub/nested/deep.ts", "sub/nested/other.ts") },
        { stdout: nul("sub/nested/untracked.ts") },
      ],
    });
    await expect(driver.executeWorldRead("git-changed-files", [])).resolves.toEqual([
      "deep.ts",
      "other.ts",
      "untracked.ts",
    ]);
  });

  it("strips the prefix in status buckets too", async () => {
    const { driver } = makeDriver({
      git: [
        { stdout: "sub/\n" },
        {
          stdout: nul(
            "# branch.head main",
            "1 M. N... 100644 100644 100644 aaa bbb sub/staged.ts",
            "? sub/new.ts",
          ),
        },
      ],
    });
    await expect(driver.executeWorldRead("git-status", [])).resolves.toEqual({
      branch: "main",
      clean: false,
      staged: ["staged.ts"],
      unstaged: [],
      untracked: ["new.ts"],
    });
  });

  it("fails loudly if git reports a path outside the workspace prefix", async () => {
    // pathspec 已经保证了范围，所以走到这里说明某个假设塌了。此时把一个带 ../ 的路径交给
    // 脚本，正是这套收束要防的那件事——而脚本会拿它去 files.read。
    const { driver } = makeDriver({
      git: [{ stdout: "sub/\n" }, { stdout: nul("outside/elsewhere.ts") }],
    });
    await expect(driver.executeWorldRead("git-changed-files", ["main"])).rejects.toMatchObject({
      code: "DriverError",
    });
  });

  it("is identity at the repo root (the common case pays nothing)", async () => {
    const { driver } = makeDriver({
      git: [PREFIX_AT_ROOT, { stdout: nul("a.ts", "sub/b.ts") }],
    });
    await expect(driver.executeWorldRead("git-changed-files", ["main"])).resolves.toEqual([
      "a.ts",
      "sub/b.ts",
    ]);
  });
});

// ————————————————————————————————————————————————————————————————
// porcelain v2 解析
// ————————————————————————————————————————————————————————————————

describe("git status — porcelain v2 -z parsing", () => {
  /** 一次 status 读取：先一条根前缀回复，再一段 `-z` porcelain。 */
  function statusDriver(...segments: string[]) {
    return makeDriver({ git: [PREFIX_AT_ROOT, { stdout: nul(...segments) }] });
  }

  it("reports a clean tree with its branch", async () => {
    // 头信息段同样以 NUL 终止（不是换行）——实测确认。
    const { driver } = statusDriver(
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    );
    await expect(driver.executeWorldRead("git-status", [])).resolves.toEqual({
      branch: "main",
      clean: true,
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });

  it("splits staged / unstaged / untracked, and reports a file in both when it is", async () => {
    // `XY` 的两位分别是暂存区与工作区状态，`.` 表示未变。所以"改了、暂存了、又接着改"的
    // 文件同时出现在 staged 与 unstaged——这不是重复，是两条不同的事实。
    const { driver } = statusDriver(
      "# branch.head feature/x",
      "1 M. N... 100644 100644 100644 aaa bbb staged-only.ts",
      "1 .M N... 100644 100644 100644 aaa bbb worktree only.ts",
      "1 MM N... 100644 100644 100644 aaa bbb both.ts",
      "? untracked one.ts",
      "? another.ts",
    );
    await expect(driver.executeWorldRead("git-status", [])).resolves.toEqual({
      branch: "feature/x",
      clean: false,
      // 路径可以含空格：解析按"跳过 N 个定长字段取余文"，绝不整段 split。
      staged: ["both.ts", "staged-only.ts"],
      unstaged: ["both.ts", "worktree only.ts"],
      untracked: ["another.ts", "untracked one.ts"],
    });
  });

  it("consumes a rename entry's second segment instead of misreading it as a record", async () => {
    // `-z` 下 rename/copy 项占**两段**：`2 … R100 <新路径>\0<原路径>`（不带 -z 时用 TAB 分隔）。
    // 少消费那一段，原路径就会被当成下一条记录——它不以类型字符开头，于是被静默丢掉，而紧随
    // 其后的真记录会被错位读取。这里用 rename 后面紧跟一条真记录来抓住这种错位。
    const { driver } = statusDriver(
      "# branch.head main",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts",
      "old/name.ts",
      "1 .M N... 100644 100644 100644 aaa bbb after-rename.ts",
    );
    await expect(driver.executeWorldRead("git-status", [])).resolves.toEqual({
      branch: "main",
      clean: false,
      // 只交出**新**路径：facade 报告的是"现在哪些路径变了"。原路径不出现在任何桶里。
      staged: ["new/name.ts"],
      unstaged: ["after-rename.ts"],
      untracked: [],
    });
  });

  it("carries a non-ASCII filename through verbatim", async () => {
    // 不加 `-z` 时 core.quotePath 会把它 C 引用成 `"\346\226\207..."`。在本仓库的用户身上
    // 这是常态而不是边角，所以这条是 `-z` 存在的第一个理由。
    const { driver } = statusDriver(
      "# branch.head main",
      "1 .M N... 100644 100644 100644 aaa bbb 文档 中文.md",
      "? 未跟踪.txt",
    );
    await expect(driver.executeWorldRead("git-status", [])).resolves.toMatchObject({
      unstaged: ["文档 中文.md"],
      untracked: ["未跟踪.txt"],
    });
  });

  it("carries a newline-containing filename through intact", async () => {
    // `-z` 存在的第二个理由：按行切会把这个文件名劈成两个不存在的路径，且不报任何错——
    // "少见且静默错误"正是这套代码不接受的失败形态。
    const { driver } = statusDriver("# branch.head main", "? has\nnewline.txt");
    await expect(driver.executeWorldRead("git-status", [])).resolves.toMatchObject({
      untracked: ["has\nnewline.txt"],
    });
  });

  it("omits branch entirely on a detached HEAD", async () => {
    // git 写字面量 "(detached)"。把它当分支名交出去，脚本就会拿它去 diff。
    const { driver } = statusDriver("# branch.oid abc", "# branch.head (detached)");
    const status = (await driver.executeWorldRead("git-status", [])) as Record<string, unknown>;
    expect(status.branch).toBeUndefined();
    expect("branch" in status).toBe(false);
    expect(status.clean).toBe(true);
  });

  it("counts an unmerged entry as unstaged work", async () => {
    // 冲突文件确实"有待办"，但它不是"已经准备好提交"，所以落 unstaged 而不是 staged。
    const { driver } = statusDriver(
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts",
    );
    await expect(driver.executeWorldRead("git-status", [])).resolves.toMatchObject({
      clean: false,
      staged: [],
      unstaged: ["conflicted.ts"],
    });
  });
});

describe("git path lists — -z parsing", () => {
  it("carries non-ASCII and newline-containing filenames through changedFiles", async () => {
    const { driver } = makeDriver({
      git: [
        PREFIX_AT_ROOT,
        { stdout: nul("文档 中文.md", "src/a.ts") },
        { stdout: nul("未跟踪.txt", "has\nnewline.txt") },
      ],
    });
    await expect(driver.executeWorldRead("git-changed-files", [])).resolves.toEqual([
      "has\nnewline.txt",
      "src/a.ts",
      "文档 中文.md",
      "未跟踪.txt",
    ]);
  });

  it("tolerates the trailing NUL terminator without emitting an empty path", async () => {
    const { driver } = makeDriver({
      git: [PREFIX_AT_ROOT, { stdout: nul("a.ts") }],
    });
    await expect(driver.executeWorldRead("git-changed-files", ["main"])).resolves.toEqual(["a.ts"]);
  });

  it("returns an empty list for an empty -z output", async () => {
    const { driver } = makeDriver({ git: [PREFIX_AT_ROOT, { stdout: "" }] });
    await expect(driver.executeWorldRead("git-changed-files", ["main"])).resolves.toEqual([]);
  });
});

describe("git log — NUL field parsing", () => {
  it("parses NUL-separated records into commits, newest first", async () => {
    const { driver } = makeDriver({
      git: [
        {
          stdout:
            "aaa\u0000feat: add thing\u0000Ada\u00002026-08-20T10:00:00+08:00\n" +
            "bbb\u0000fix: a | pipe, a: colon and  spaces\u0000Bob Builder\u00002026-08-19T09:00:00+08:00",
        },
      ],
    });
    await expect(driver.executeWorldRead("git-log", [2])).resolves.toEqual([
      { hash: "aaa", subject: "feat: add thing", author: "Ada", date: "2026-08-20T10:00:00+08:00" },
      {
        hash: "bbb",
        // NUL 分隔而不是别的分隔符，正是为了让 subject 里的 `|` / `:` / 连续空格都安全。
        subject: "fix: a | pipe, a: colon and  spaces",
        author: "Bob Builder",
        date: "2026-08-19T09:00:00+08:00",
      },
    ]);
  });

  it("returns an empty list for an empty log", async () => {
    const { driver } = makeDriver({ git: [{ stdout: "" }] });
    await expect(driver.executeWorldRead("git-log", [])).resolves.toEqual([]);
  });

  it("fails loudly on a record whose field count is wrong", async () => {
    // 格式串与解析器在同一个模块里，两者不一致只可能是本地改动出了岔子；一条只填了一半的
    // commit 会一路流进 journal 与模型的上下文。
    const { driver } = makeDriver({ git: [{ stdout: "aaa\u0000only-two" }] });
    await expect(driver.executeWorldRead("git-log", [])).rejects.toMatchObject({
      code: "DriverError",
    });
  });
});

// ————————————————————————————————————————————————————————————————
// 实参校验：base / path / count
// ————————————————————————————————————————————————————————————————

describe("git world reads — argument validation", () => {
  const rejects = async (op: "git-diff" | "git-changed-files" | "git-log", args: unknown[]) => {
    const { driver, gitCalls } = makeDriver({ git: [PREFIX_AT_ROOT, { stdout: "" }] });
    await expect(driver.executeWorldRead(op, args)).rejects.toMatchObject({
      code: "DriverError",
    });
    // 校验失败**不得**已经 spawn 出一个 git：argv 在跑任何东西之前就构造好，所以坏 base /
    // 坏 path 连 rev-parse 都不该发生。
    expect(gitCalls).toEqual([]);
  };

  it("rejects a base that would be read as an option", async () => {
    // `-foo` 会被 git 当成选项而不是 ref，而"哪些选项存在"不由我们决定。
    await rejects("git-diff", ["-foo"]);
    await rejects("git-changed-files", ["--cached"]);
  });

  it("rejects a range base (v1 accepts a single ref only)", async () => {
    await rejects("git-diff", ["main..HEAD"]);
    await rejects("git-diff", ["main...HEAD"]);
    await rejects("git-changed-files", ["a..b"]);
  });

  it("rejects whitespace and reflog/rev syntax in a base", async () => {
    await rejects("git-diff", ["main HEAD"]);
    await rejects("git-diff", ["main\tx"]);
    await rejects("git-diff", ["HEAD@{1}"]);
    await rejects("git-diff", ["HEAD:src/a.ts"]);
    await rejects("git-diff", [""]);
  });

  it("accepts the single-ref forms a script actually writes", async () => {
    for (const base of ["HEAD", "HEAD~3", "HEAD^", "main", "origin/main", "v1.2.3", "abc123"]) {
      const { driver, gitCalls } = makeDriver({ git: [{ stdout: "" }] });
      await driver.executeWorldRead("git-diff", [base]);
      expect(gitCalls[0]?.argv).toEqual([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        base,
        "--",
        ".",
      ]);
    }
  });

  it("accepts a legitimate nested path", async () => {
    const { driver, gitCalls } = makeDriver({ git: [{ stdout: "" }] });
    await driver.executeWorldRead("git-diff", ["HEAD", "sub/nested/deep.ts"]);
    expect(gitCalls[0]?.argv).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "HEAD",
      "--",
      "sub/nested/deep.ts",
    ]);
  });

  it("rejects an absolute or escaping path", async () => {
    await rejects("git-diff", ["HEAD", "/etc/passwd"]);
    // 平台无关：posix 的 isAbsolute 认不出 `C:\x`，而这道校验要在三个平台上给同一个答案。
    await rejects("git-diff", ["HEAD", "C:\\Windows\\x"]);
    await rejects("git-diff", ["HEAD", "\\\\server\\share"]);
    await rejects("git-diff", ["HEAD", "../outside/a.ts"]);
    await rejects("git-diff", ["HEAD", "src/../../a.ts"]);
    // `--` 之后 `-foo` 已经安全，但仍然拒绝：`--` 一旦哪天漏掉，它就是一个选项。
    await rejects("git-diff", ["HEAD", "-foo"]);
    await rejects("git-diff", ["HEAD", ""]);
  });

  it("rejects a log count above the cap rather than silently clamping it", async () => {
    // 请求 500 条却拿到 100 条，会在脚本自己的逻辑里变成一个查不明白的"历史怎么这么短"。
    await rejects("git-log", [WORLD_READ_CAPS.gitLogMaxCount + 1]);
    await rejects("git-log", [1000]);
    await rejects("git-log", [0]);
    await rejects("git-log", [-1]);
    await rejects("git-log", [2.5]);
    await rejects("git-log", ["5"]);
    await rejects("git-log", [5, 6]);
  });

  it("accepts a log count exactly at the cap", async () => {
    const { driver, gitCalls } = makeDriver({ git: [{ stdout: "" }] });
    await driver.executeWorldRead("git-log", [WORLD_READ_CAPS.gitLogMaxCount]);
    expect(gitCalls[0]?.argv[1]).toBe(`-n${WORLD_READ_CAPS.gitLogMaxCount}`);
  });

  it("rejects extra arguments on a no-argument op", async () => {
    const { driver, gitCalls } = makeDriver({ git: [{ stdout: "" }] });
    await expect(driver.executeWorldRead("git-status", ["extra"])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(driver.executeWorldRead("git-diff", ["a", "b", "c"])).rejects.toMatchObject({
      code: "DriverError",
    });
    expect(gitCalls).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————
// 失败与上限
// ————————————————————————————————————————————————————————————————

describe("git world reads — failure and caps", () => {
  it("turns a non-repository / missing-binary failure into a catchable DriverError", async () => {
    // spec 的 fall-back-to-files.glob 惯用法就是一个纯 try/catch，所以这条失败必须是
    // **node 级**且带上 stderr 的线索。
    const failed: GitReply = {
      exitCode: 128,
      status: "failed",
      stderr: "fatal: not a git repository\n",
    };
    // 非仓库时**第一条**命令（rev-parse）就已经失败，所以两次断言各只消耗一条回复。
    const { driver } = makeDriver({ git: [failed, failed] });
    await expect(driver.executeWorldRead("git-status", [])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(driver.executeWorldRead("git-status", [])).rejects.toThrow(/not a git repository/);
  });

  it("treats a spawn error as a DriverError too", async () => {
    const { driver } = makeDriver({
      git: [{ status: "spawn_error", stderr: "spawn git ENOENT" }],
    });
    await expect(driver.executeWorldRead("git-log", [])).rejects.toMatchObject({
      code: "DriverError",
    });
  });

  it("rejects an over-cap diff with WorldReadCapExceeded and actionable guidance", async () => {
    const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
    const overflowing: GitReply = { stdout: "x".repeat(64), bytes: cap + 1, truncated: true };
    const { driver, gitCalls } = makeDriver({ git: [overflowing, overflowing] });
    await expect(driver.executeWorldRead("git-diff", [])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    await expect(driver.executeWorldRead("git-diff", [])).rejects.toThrow(/path/);
    // cap + 1 的 inline 上限是溢出探测的手法：刚好 cap 字节与"被截断"必须可区分。
    expect(gitCalls[0]?.maxInlineBytes).toBe(cap + 1);
  });

  it("passes a diff exactly at the cap through", async () => {
    const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
    const { driver } = makeDriver({ git: [{ stdout: "ok", bytes: cap, truncated: false }] });
    await expect(driver.executeWorldRead("git-diff", [])).resolves.toBe("ok");
  });
});

// ————————————————————————————————————————————————————————————————
// files.glob
// ————————————————————————————————————————————————————————————————

// 这组用例钉的是 2026-08-26 的一次真实事故（seq-map bug 扫描 run dwfrun-00cefbcb）：
// worldGlob 曾把文件系统端口的结果原样交出——绝对路径、mtime 降序、并静默继承端口
// 面向 UI 工具的 100 条默认上限。绝对路径让脚本的 `startsWith("apps/…")` 路由全部
// 落空，6 路扇出坍缩成 1 路；mtime 序让同一脚本两次提交扇出次序不同；100 条静默截断
// 则违反 caps 的"拒绝、绝不截断"总则。三条契约在此各有一枚钉子。
describe("files.glob world read", () => {
  it("maps the port's mtime-ordered absolute paths to lexicographic workspace-relative", async () => {
    const { driver, globRequests } = makeDriver({
      // 端口按 mtime 降序、绝对/相对混合（真适配器给绝对路径；形状归一是 driver 的事）。
      glob: ["/ws/src/z.ts", "/ws/a.ts", "src/m.ts"],
    });
    await expect(driver.executeWorldRead("glob", ["**/*.ts"])).resolves.toEqual([
      "a.ts",
      "src/m.ts",
      "src/z.ts",
    ]);
    expect(globRequests[0]).toMatchObject({
      path: CWD,
      pattern: "**/*.ts",
      // cap+1 惯用法（与 grep 同族）：恰好 cap 条无从区分"正好"与"截掉了一百万条"。
      maxResults: WORLD_READ_CAPS.globMaxFiles + 1,
    });
  });

  it("rejects over-cap file counts with actionable guidance, never a truncated view", async () => {
    // 截断的世界视图会被 journal 记录、被 resume 原样重放，脚本还会拿它去扇出。
    const cap = WORLD_READ_CAPS.globMaxFiles;
    const tooMany = Array.from({ length: cap + 1 }, (_, i) => `/ws/f${i}.ts`);
    const { driver } = makeDriver({ glob: tooMany });
    await expect(driver.executeWorldRead("glob", ["**/*"])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    await expect(driver.executeWorldRead("glob", ["**/*"])).rejects.toThrow(/pattern/);
  });

  it("passes a file count exactly at the cap through", async () => {
    const cap = WORLD_READ_CAPS.globMaxFiles;
    const exact = Array.from({ length: cap }, (_, i) => `/ws/f${i}.ts`);
    const { driver } = makeDriver({ glob: exact });
    const files = (await driver.executeWorldRead("glob", ["**/*"])) as string[];
    expect(files).toHaveLength(cap);
  });

  it("rejects when the port reports truncation even under the count cap", async () => {
    // 与 grep 同一条线：端口若因别的原因截断，我们手上就不是完整结果了。
    const { driver } = makeDriver({ glob: ["/ws/a.ts"], globTruncated: true });
    await expect(driver.executeWorldRead("glob", ["*.ts"])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
  });
});

// ————————————————————————————————————————————————————————————————
// files.grep
// ————————————————————————————————————————————————————————————————

describe("files.grep world read", () => {
  it("maps port entries to workspace-relative {path, line, text}", async () => {
    const { driver, grepRequests } = makeDriver({
      grep: [
        { path: "/ws/src/a.ts", lineNumber: 12, text: "// TODO: fix" },
        { path: "src/b.ts", lineNumber: 3, text: "// TODO: later" },
        // 端口在别的 outputMode 下会产出没有行号的条目；那不是一条内容命中。
        { path: "/ws/src/c.ts", count: 4 },
      ],
    });
    await expect(driver.executeWorldRead("grep", ["TODO", "*.ts"])).resolves.toEqual([
      { path: "src/a.ts", line: 12, text: "// TODO: fix" },
      { path: "src/b.ts", line: 3, text: "// TODO: later" },
    ]);
    expect(grepRequests[0]).toMatchObject({
      path: CWD,
      pattern: "TODO",
      glob: "*.ts",
      outputMode: "content",
      showLineNumbers: true,
      headLimit: WORLD_READ_CAPS.grepMaxMatches + 1,
    });
  });

  it("omits glob entirely when the script did not pass one", async () => {
    const { driver, grepRequests } = makeDriver({ grep: [] });
    await expect(driver.executeWorldRead("grep", ["TODO"])).resolves.toEqual([]);
    expect("glob" in grepRequests[0]!).toBe(false);
    // 显式 undefined 是脚本可写的（`grep(p, undefined)`），归一成同一个"缺席"。
    const explicit = makeDriver({ grep: [] });
    await explicit.driver.executeWorldRead("grep", ["TODO", undefined]);
    expect("glob" in explicit.grepRequests[0]!).toBe(false);
  });

  it("rejects over-cap match counts with actionable guidance, never a truncated view", async () => {
    // 截断把一份悄悄残缺的世界视图交给脚本，而脚本接下来会拿它去扇出——扇出才是贵的那一步。
    const cap = WORLD_READ_CAPS.grepMaxMatches;
    const tooMany = Array.from({ length: cap + 1 }, (_, i) => ({
      path: `/ws/f${i}.ts`,
      lineNumber: 1,
      text: "hit",
    }));
    const { driver } = makeDriver({ grep: tooMany });
    await expect(driver.executeWorldRead("grep", ["."])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    await expect(driver.executeWorldRead("grep", ["."])).rejects.toThrow(/glob/);
  });

  it("passes a match count exactly at the cap through", async () => {
    const cap = WORLD_READ_CAPS.grepMaxMatches;
    const exact = Array.from({ length: cap }, (_, i) => ({
      path: `f${i}.ts`,
      lineNumber: 1,
      text: "h",
    }));
    const { driver } = makeDriver({ grep: exact });
    const matches = (await driver.executeWorldRead("grep", ["."])) as unknown[];
    expect(matches).toHaveLength(cap);
  });

  it("rejects when the port reports truncation even under the count cap", async () => {
    // 端口若因别的原因截断，我们手上就不是完整结果了——这与"命中数超限"是同一件事。
    const { driver } = makeDriver({
      grep: [{ path: "a.ts", lineNumber: 1, text: "h" }],
      grepTruncated: true,
    });
    await expect(driver.executeWorldRead("grep", ["."])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
  });

  it("rejects an over-cap serialized size even when the match count is fine", async () => {
    // 两个上限**先到先拒**：少量命中也可以很大（一行 minified bundle）。
    const bigLine = "x".repeat(WORLD_READ_CAPS.grepMaxSerializedBytes);
    const { driver } = makeDriver({
      grep: [{ path: "bundle.js", lineNumber: 1, text: bigLine }],
    });
    await expect(driver.executeWorldRead("grep", ["x"])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
  });

  it("rejects malformed grep arity", async () => {
    const { driver } = makeDriver({ grep: [] });
    await expect(driver.executeWorldRead("grep", [])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(driver.executeWorldRead("grep", [42])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(driver.executeWorldRead("grep", ["a", 42])).rejects.toMatchObject({
      code: "DriverError",
    });
    await expect(driver.executeWorldRead("grep", ["a", "b", "c"])).rejects.toMatchObject({
      code: "DriverError",
    });
  });
});

// ————————————————————————————————————————————————————————————————
// facade 与 driver 的形状一致性
// ————————————————————————————————————————————————————————————————

describe("facade / driver shape agreement", () => {
  it("returns exactly the fields the facade declares", () => {
    // driver 侧的 GrepMatch / GitStatus / GitCommit 是 FACADE_DTS 的 TS 镜像（facade 是一个
    // 字符串资产，没法直接 import 它的类型）。这条断言让"镜像走形"在这里失败，而不是在
    // 某个脚本读到 undefined 字段的时候。
    for (const declaration of [
      "declare interface GrepMatch",
      "declare interface GitStatus",
      "declare interface GitCommit",
      "declare const git",
      "glob(pattern: string): Promise<string[]>",
      "grep(pattern: string, glob?: string)",
      "changedFiles(base?: string)",
      "diff(base?: string, path?: string)",
      "status(): Promise<GitStatus>",
      "log(count?: number): Promise<GitCommit[]>",
    ]) {
      expect(FACADE_DTS).toContain(declaration);
    }
  });
});

// ————————————————————————————————————————————————————————————————
// 工作区收束：files.read 的路径必须落在工作区之内
// ————————————————————————————————————————————————————————————————

describe("files.read — workspace containment", () => {
  it("resolves a legitimate nested path against the workspace", async () => {
    const { driver, readPaths } = makeDriver({});
    await expect(driver.executeWorldRead("read", ["sub/nested/a.ts"])).resolves.toBe("body");
    expect(readPaths).toEqual([`${CWD}/sub/nested/a.ts`]);
  });

  it("rejects a path that escapes the workspace with ..", async () => {
    // 这道检查是 git.* 落地才变得要紧的：`changedFiles() → files.read(p)` 是那个最显然的
    // 两行组合，而 git 的原生输出在工作区是仓库子目录时会带 ../ 前缀。一个原语的显然组合
    // 不该是个陷阱。
    const { driver, readPaths } = makeDriver({});
    for (const escape of ["../outside.ts", "sub/../../outside.ts", "../../etc/passwd"]) {
      await expect(driver.executeWorldRead("read", [escape])).rejects.toMatchObject({
        code: "DriverError",
      });
    }
    // 一次都没打到端口：拒绝发生在解析之后、读取之前。
    expect(readPaths).toEqual([]);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const { driver, readPaths } = makeDriver({});
    await expect(driver.executeWorldRead("read", ["/etc/passwd"])).rejects.toMatchObject({
      code: "DriverError",
    });
    expect(readPaths).toEqual([]);
  });

  it("accepts a path that normalizes back inside the workspace", async () => {
    // `sub/../a.ts` 归一成 `a.ts`，仍在工作区内——判据是**解析之后**的位置，不是字面量里
    // 有没有出现过 `..`。
    const { driver } = makeDriver({});
    await expect(driver.executeWorldRead("read", ["sub/../a.ts"])).resolves.toBe("body");
  });
});
