// ============================================================
// git.* world reads：只读**按构造**
// ============================================================
// 本模块是 git world-read 的**纯**那一半：实参校验、固定 argv 的构造、以及 porcelain-v2 /
// log / 路径列表输出的解析。副作用（真正 spawn 出一个 git）留在 workflow-world-read.ts。
//
// 为什么拆成纯模块：这里的每一条都是可以被单独钉住的性质——"这个 op 的 argv 恰好是这几个
// 元素"、"detached HEAD 时 branch 缺席"、"`-foo` 作为 base 被拒"、"带换行的文件名原样穿过"。
// 它们放在执行侧就只能经一个 fake port 间接断言；放在这里可以直接断言。
//
// ————————————————————————————————————————————————————————————————
// 只读是**构造**出来的，不是检查出来的
// ————————————————————————————————————————————————————————————————
// 本模块只能构造出五个被允许的子命令的 argv。没有一条路径能拼出 shell 字符串，也没有一处
// 把脚本给的串直接当成子命令或选项：base ref 过一道严格字符集（禁首字符 `-`，禁 `..` 区间），
// path 必须是工作区相对且不越界，且**总是**排在 `--` 之后。所以"写不进去"是这份代码能表达的
// 东西的性质，而不是一道可能哪天被忘掉的权限检查。
//
// ————————————————————————————————————————————————————————————————
// 两条贯穿全模块的输出契约（都是实测定下来的，不是从文档推的）
// ————————————————————————————————————————————————————————————————
// **1. `-z`：NUL 分隔，路径逐字节原样。** 不加 `-z` 时 `core.quotePath` 默认为真，git 会把
// 非 ASCII 路径 C 引用加八进制转义——`文档.md` 变成一串 `"\346\226\207..."`。这在本仓库的用户
// 身上是常态而不是边角。`-z` 一并解决两件事：路径不再被引用转义，且**含换行的文件名**不再
// 破坏按行切分（按行切会把它劈成两个不存在的路径，且没有任何报错——"少见且静默错误"正是
// 这套代码不接受的失败形态）。我们自己的 `git log` 也已经用 `%x00` 分隔字段，所以整族一致。
//
// **2. 路径一律以「工作区相对」交出，转换在我们这一侧做一次。** 实测：`-z` 会让
// `status --porcelain=v2` 输出**仓库根相对**路径，且没有任何 flag 或 config 能把它改回 cwd 相对
// （`status.relativePaths` 对 porcelain -z 无效）；`diff --name-only` 默认也是仓库根相对；而
// `ls-files --others` 默认是 **cwd 相对**。三条命令三种基准。
//
// 于是这里定一条统一规则：**线上一律取仓库根相对**（`ls-files` 补 `--full-name` 对齐），
// 再用一次 `rev-parse --show-prefix` 拿到工作区相对仓库根的前缀，在解析时剥掉它。这样
// 「基准」只有一处、只有一种，而不是三条命令各自依赖一个不同的 git 默认值——那种混搭正是
// 会让 `changedFiles()` 同时吐出两种基准路径的 bug（工作区就是仓库根时三者恰好相同，
// 所以它会一直不被发现，直到某个工作区是子目录）。
//
// 唯一的例外是 `git.diff` 的**补丁文本**：它不是我们解析的路径列表，而是一段带 `a/… b/…`
// 头的整体输出，没法在事后剥前缀。那一条因此用 git 自己的 `--relative` 让基准对齐。

import { WorkflowError } from "@zcode/dynamic-workflow";

/**
 * 一次 git 世界读取要跑的一条命令。`argv` 不含 `"git"` 本身——可执行文件名由执行侧提供，
 * 这样本模块完全不碰进程。
 */
interface GitCommandPlan {
  readonly argv: readonly string[];
}

/** `git.status()` 的返回形状。权威声明是 FACADE_DTS 里的 `declare interface GitStatus`。 */
export interface GitStatusResult {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** `git.log()` 的一条记录。权威声明是 FACADE_DTS 里的 `declare interface GitCommit`。 */
export interface GitCommitResult {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * base ref 的严格字符集：首字符必须是字母/数字，其后允许 `[A-Za-z0-9._/@^~-]`。
 *
 * 首字符不许是 `-` 是这条规则里唯一**安全相关**的部分：`-foo` 会被 git 当成选项而不是 ref，
 * 而"哪些选项存在"不由我们决定。首字符也不许是 `.`，顺手挡住 `.` / `..` 这类既不是合法 ref、
 * 又长得像区间的输入。
 *
 * 刻意排除的：空白（一个 ref 里没有空白的合法理由）、`{`/`}`（`@{u}` 这类 reflog 语法，v1
 * 不支持）、`:`（`ref:path` 语法）、以及任何 `..`（区间——v1 只接受**单个** ref）。这些都不是"危险"，只是超出了 v1 承诺过的语义；接受它们等于
 * 让脚本依赖一份没人写下来的契约。
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/** `git log` 的字段格式：NUL 分隔的 hash / subject / author name / author date(ISO-8601)。 */
export const GIT_LOG_PRETTY = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/**
 * 工作区相对仓库根的前缀（`"sub/nested/"`，在仓库根为空串）。这是把线上的仓库根相对路径
 * 换算成工作区相对路径的唯一依据，见本模块顶部的输出契约 2。
 */
export const GIT_SHOW_PREFIX_ARGV: readonly string[] = ["rev-parse", "--show-prefix"];

/**
 * `git status` 的固定 argv。`--branch` 是 GitStatus.branch 的来源；`-- .` 把观察范围收在
 * 工作区之内（见 {@link WORKSPACE_PATHSPEC}）。
 */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/**
 * 未跟踪文件的固定 argv。`--exclude-standard` 让它尊重 .gitignore；`--full-name` 把它从
 * cwd 相对拉成仓库根相对，与 status / diff 对齐（本模块顶部的输出契约 2）。
 */
export const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/**
 * 工作区 pathspec。git.* 是**世界读取**，而这个工作流的"世界"处处都是工作区：
 * files.glob/read/grep 是工作区范围的，actor 子会话以工作区为 cwd，权限档位也是工作区范围的。
 * 所以 git 的观察也收在同一个世界里——否则 `changedFiles()` 会交出工作区之外的路径，而
 * `changedFiles() → files.read(p)` 这个最显然的两行组合就成了一个陷阱。
 *
 * 代价（v1 有意接受）：工作区是仓库子目录时，看不到子目录之外的改动。
 */
const WORKSPACE_PATHSPEC = ".";

/**
 * 校验一个 base ref，返回原串。形状不符即结构化 `DriverError`（node 级，脚本可 `catch`）。
 * 错误消息说明**为什么**被拒，因为写脚本的那一侧要据此改写，而不是去猜。
 */
function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted. Pass ` +
        `one ref.`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax ` +
        `characters such as {} :).`,
    );
  }
  return value;
}

/**
 * 校验一个工作区相对路径，返回规范化（分隔符统一成 `/`）后的串。
 *
 * 三条，都是**词法层面的收束**（不追符号链接，见 v1 说明）：不许绝对路径、不许以 `-` 开头、
 * 不许含 `..` 段。第三条就是这一侧的越界检查：`relative` 的规范化结果里 `..` 只可能出现在
 * 开头，所以"没有 `..` 段且不是绝对路径"等价于"解析后仍在工作区内"。
 *
 * 以 `-` 开头即便排在 `--` 之后也已经安全，仍然拒绝：这是纵深防御——`--` 一旦哪天漏掉，
 * 一个 `-foo` 路径就是一个选项。
 */
function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path must not be empty. Pass a workspace-relative path or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option. ` +
        `Pass a path that does not start with '-'.`,
    );
  }
  if (looksAbsolute(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted. Pass the path relative to the workspace root.`,
    );
  }
  // 分隔符统一成 `/`：git 的 pathspec 在三个平台上都吃 `/`，而模型写出 windows 风格的
  // 相对路径是常事。规范化必须在 `..` 检查**之前**，否则 `..\x` 会从段切分里溜过去。
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the ` +
        `workspace. Pass a path inside the workspace.`,
    );
  }
  return normalized;
}

/**
 * 绝对路径判定，**不依赖当前平台**：`node:path` 的 posix 版认不出 `C:\x`，而这份校验要在
 * 三个平台上给同一个答案（跨平台原则：不按开发机的系统行为实现）。
 */
function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value);
}

/**
 * `git.changedFiles(base?)` 要跑的命令。
 *
 * 无 base 时是**两条**命令的并集：`diff --name-only HEAD` 加上 `ls-files --others
 * --exclude-standard`。未跟踪文件对读者而言就是改动，漏掉它们会让这个原语在一条刚开的
 * feature 分支上毫无用处（那时几乎所有新文件都还未跟踪）。
 *
 * 给了 base 时只有一条：`diff --name-only <base>`。"相对某个 ref 改了什么"是一个关于
 * **已跟踪历史**的问题——一个从未进过 git 的文件与任何 ref 都无从比较。
 */
export function gitChangedFilesPlan(base: string | undefined): GitCommandPlan[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const tracked: GitCommandPlan = {
    argv: [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      ref,
      "--",
      WORKSPACE_PATHSPEC,
    ],
  };
  if (base !== undefined) return [tracked];
  return [tracked, { argv: [...GIT_UNTRACKED_ARGV] }];
}

/**
 * `git.diff(base?, path?)` 的 argv。base 缺省为 `HEAD`；path 缺省为工作区 pathspec `.`，
 * 且**总是**排在 `--` 之后，这样一个恰好与分支同名的路径不会被 git 解读成 ref（也不会反过来）。
 *
 * `--relative` 在这一条上是必需的，理由与别处不同：补丁文本里的 `a/… b/…` 头是 git 自己写的，
 * 我们不解析、也没法事后剥前缀，所以只能让 git 按 cwd（= 工作区）为基准输出。少了它，
 * `changedFiles()` 说"只有 a.md 改了"而 `diff()` 交出一段带 `../x` 的仓库级补丁——两个原语
 * 会对"什么算改动"给出不同答案。
 *
 * `--relative` 本身也会排除 cwd 之外的改动，所以 `-- .` 在无 path 时是冗余的。**冗余是有意的**：
 * 范围收束不该悄悄依赖另一个 flag 的副作用，写出来才能被 argv 测试钉住。
 */
// 只读 diff 不能执行配置中的外部命令；--no-ext-diff 不包含 textconv，需分别禁止。
export function gitDiffArgv(base: string | undefined, path: string | undefined): string[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? WORKSPACE_PATHSPEC : validateGitPath("git-diff", path);
  return ["diff", "--no-ext-diff", "--no-textconv", "--relative", ref, "--", pathspec];
}

/**
 * `git.log(count)` 的 argv。count 由调用方校验并夹在 [1, cap] 内。
 *
 * **刻意不带 pathspec，与本族其余 op 不对称。** commit 是仓库级的对象；给 log 加一个
 * pathspec 会把它的语义改成"碰过工作区的那些 commit"，那是另一个问题，没人点过。log 读的是
 * 历史元数据（hash / subject / author / date），不是工作区里的路径，所以工作区收束对它没有
 * 可施加的对象。
 */
export function gitLogArgv(count: number): string[] {
  return ["log", `-n${count}`, GIT_LOG_PRETTY];
}

/** `rev-parse --show-prefix` 的输出 → 前缀串（仓库根时为空串）。 */
export function parseGitShowPrefix(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

/**
 * 把 `-z` 输出切成段：按 NUL 切，丢掉空段（末尾的 NUL 终止符会留下一个空段）。
 *
 * 丢空段是安全的，且对 rename 项的双段消费无影响：路径永远不是空串，所以空段只可能来自
 * 终止符本身。
 */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/**
 * 剥掉工作区前缀，把仓库根相对路径换算成**工作区相对**路径（本模块顶部的输出契约 2）。
 *
 * 前缀外的路径**大声失败**而不是原样交出。`-- .` 已经保证了每个路径都在工作区之内，所以
 * 走到这里说明某个假设塌了；此时把一个带 `../` 的路径交给脚本，正是这套收束要防的那件事，
 * 而脚本会拿它去 `files.read`。宁可让节点失败。
 */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw new WorkflowError(
    "DriverError",
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace, so the scoping is broken; report this as a bug.`,
  );
}

/**
 * 解析 `git status --porcelain=v2 -z --branch -- .`。
 *
 * 段首字符即记录类型：`#` 头信息、`1` 普通变更、`2` 重命名/复制、`u` 未合并、`?` 未跟踪、
 * `!` 已忽略（只在 `--ignored` 下出现，这里不会有）。`1`/`2` 的 `XY` 两位分别是**暂存区**与
 * **工作区**状态，`.` 表示未变——所以一个文件可以同时进 staged 与 unstaged（改了、暂存了、
 * 又接着改）。
 *
 * 两处 `-z` 特有的形状（都实测过）：
 *   - 头信息行同样以 NUL 终止，不是换行。
 *   - **rename/copy 项占两段**：`2 … R100 <新路径>\0<原路径>`（不带 `-z` 时这两者用 TAB 分隔）。
 *     所以解析必须显式多消费一段，否则原路径会被当成下一条记录——而它不以类型字符开头，
 *     会被静默丢掉。原路径本身不交出：facade 报告的是"现在哪些路径变了"。
 *
 * 路径是记录的**尾段**而不是定长字段：路径可以含空格（甚至换行，`-z` 下原样保留），所以按
 * "跳过前 N 个空格分隔字段、取余文"来切，绝不整段 split。
 */
export function parseGitStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // detached HEAD 时 git 写字面量 "(detached)"。此时 branch **缺席**，而不是带着这个
      // 占位串——把它当分支名交出去，脚本就会拿它去做 diff。
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      // `1` 的路径是第 8 个字段起；`2` 多一个 `<X><score>` 字段，所以从第 9 个起，且其**原路径**
      // 占紧随其后的一整段（`-z` 下的分隔符是 NUL），必须显式跳过。
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // 未合并（冲突）：算工作区待处理，落 unstaged。它确实"有待办"，而 staged 会误导——
      // 一个冲突文件不是"已经准备好提交"。
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
    // `!` 与未识别的段：跳过。
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    ...(branch === undefined ? {} : { branch }),
    clean,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * 解析 {@link GIT_LOG_PRETTY} 的输出：每行一条记录，字段以 NUL 分隔。
 *
 * 这一条按**换行**切记录是可靠的，与路径列表的情形不同：`%s` 是 commit message 的第一行，
 * 按定义不含换行，而其余三个字段（hash / author name / ISO 日期）也都不含换行。所以这里
 * 不需要 `-z`。
 *
 * 字段数不等于 4 即抛：格式串与解析器都在本模块里，两者不一致只可能是本地改动出了岔子，
 * 而一条只填了一半的 commit 会一路流进 journal 与模型的上下文。
 */
export function parseGitLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split("\n")) {
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.length === 0) continue;
    const fields = record.split("\u0000");
    if (fields.length !== 4) {
      throw new WorkflowError(
        "DriverError",
        `world-read git-log: cannot parse the output; a record should have 4 NUL-separated ` +
          `fields, got ${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}

/**
 * 把 `--name-only -z` / `ls-files -z` 的输出切成**工作区相对**路径列表。
 * 两者都已由 argv 拉成仓库根相对（`--full-name`），所以这里统一剥一次前缀。
 */
export function parseGitPathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/**
 * 从第 `index` 个空格分隔字段起的**整段余文**。porcelain v2 的字段是单空格分隔且定长，
 * 只有路径在最后且可含空格，所以"跳过 N 个空格再取余文"是这里唯一正确的切法。
 */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** 去重并排序。journal 存的是这个值，所以它必须只依赖内容而不依赖 git 的输出顺序。 */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
