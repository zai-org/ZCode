/**
 * The dynamic-workflow facade: the entire model-facing API surface, shipped as an
 * embedded .d.ts asset (same pattern as SCRIPT_WORKFLOW_CHILD_SOURCE) so the compiler
 * works inside the bundled/SEA CLI where no node_modules exists on disk.
 *
 * One noun (the actor), one verb
 * (the task). Runtime shims are injected by the runtime layer, never imported.
 *
 * 段式组织：facade 拆成命名段常量，`FACADE_DTS`
 * 与 `SNIPPET_FACADE_DTS` 都由段**拼接**而成——单一事实源，子集绝不手抄。拼接结果对
 * 拆分前的 `FACADE_DTS` 逐字节不变。每段以
 * 单个换行开头结尾，段间拼接自然形成原有的空行分隔。
 */

import { FACADE_MODEL_DECLARATIONS } from "./dts-model.js";
import { FACADE_STREAM_SEGMENT } from "./dts-stream.js";
import { FACADE_HOLE_SEGMENT } from "./dts-hole.js";

export const FACADE_FILE_NAME = "workflow-facade.d.ts";

/** actor 族：Node / ModelRef / model() / AgentPersona / Agent / agent()。snippet 刻意不含。 */
const FACADE_ACTOR_SEGMENT = String.raw`
/** The pending result of one ask. Await it, or pass it to Promise.all with others. */
declare interface Node<T> extends PromiseLike<T> {}

${FACADE_MODEL_DECLARATIONS}
/** Persona of a subagent, fixed when agent() creates it. Every subagent has the same working tools. */
declare interface AgentPersona {
  /** System prompt describing the actor's role. */
  system?: string;
  /** Model id literal or ModelRef; omitted = the run's subagent model. */
  model?: ModelRef | string;
  /** WebSearch calls per ask (integer literal, at most 1024); omitted = 128. */
  budget?: { webSearch?: number };
}

/**
 * A subagent: one conversation that keeps its context across asks. Asks issued while it is
 * busy wait their turn, first in, first out.
 */
declare interface Agent {
  /**
   * Give the subagent one task. With a type argument, the answer is a value of type T,
   * validated against a schema built from it: T is an interface you define in this script
   * with a plain "interface" declaration (no "declare" modifier). Without one, the answer is
   * the subagent's final reply text.
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * Create a subagent. Every call starts a new, empty conversation; to share one, share the
 * returned value. A non-empty name is an identity: unique within the run (a literal duplicate
 * is a compile error, a computed one fails the run) and the key AmendWorkflow matches cached
 * work by. Unnamed subagents are allowed and never reuse cached work.
 */
declare function agent(name?: string, persona?: string | AgentPersona): Agent;
`;

/** 进度叙事：log()。两个 facade 都含。 */
const FACADE_LOG_SEGMENT = String.raw`
/** Emit a progress message to the user. */
declare function log(message: string): void;
`;

/** 渐进产物：report()。journal 化、run 面板 Results 区；snippet 刻意不含。 */
const FACADE_REPORT_SEGMENT = String.raw`
/**
 * Publish one intermediate result while the run is going; returns nothing. Items are
 * recorded: a resumed run never shows one twice, and they reach the completion notification
 * even when the run fails. The item must be JSON-serializable (plain objects, arrays, strings,
 * numbers, booleans, null); functions, class instances, Date and promises are compile
 * errors. Caps fail the whole run, not the call: 65,536 items per run, 1 MiB per serialized
 * item, 1 GiB per run.
 *
 * artifactId routes the item to a dashboard: a compile-time literal naming a preset
 * (artifact.chart / table / metrics / board) whose declaration has executed by then. The
 * item becomes one point, row, tile value or card there and still lands in the run's
 * Results. A tag naming nothing, or a file/markdown artifact, fails the run.
 */
declare function report(item: unknown, artifactId?: string): void;
`;

/**
 * 产物：artifact.*。脚本交给**用户**的产出——
 * 内容成员（`file` / `markdown`）是效应，预置成员（`chart` / `table` / `metrics` / `board`）
 * 是声明。snippet 刻意不含：片段是世界读取 + 纯逻辑的工作台，没有 run 可以往上挂交付物，
 * 所以片段里的 `artifact.file(...)` 得到 TS2304，教删除（与 `agent` / `report` 同姿态）。
 *
 * ⚠ 术语：这一段里的 artifact 全是**用户面产物**；引擎内部同名的那个
 * artifact（顶层返回值 / 站点的类型化输出）在 facade 上是 `Node<T>` 的 T，两者不相干。
 */
const FACADE_ARTIFACT_SEGMENT = String.raw`
/** A published artifact version: the id it was published under, and which version this call minted. */
declare interface ArtifactRef { id: string; version: number }
/** Card metadata every artifact kind accepts. */
declare interface ArtifactOptions {
  /** Shown as the card title; defaults to the id. In the user's language. */
  title?: string;
  /** A sentence or two, shown beside the title when this artifact is the run's primary. */
  description?: string;
  /** The run's deliverable: the card and the run pane lead with it. At most one id per run; once set it stays set for later versions. */
  primary?: boolean;
}
declare interface ArtifactFileOptions extends ArtifactOptions {
  /** Overrides the type sniffed from the extension ("application/pdf", "text/html", …). */
  contentType?: string;
}
/** One value taken from a reported item: a dot path into the item ("timing.after"). */
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: "line" | "bar" | "scatter";        // default "line"
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];        // several = several series
  scale?: "linear" | "log";                  // y axis, default "linear"
  /** A reference value drawn as a horizontal rule, taken from the first item that has the field. */
  baseline?: ArtifactField;
}
declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  /** Field that identifies a row; a later item with the same key replaces the row. Absent = append-only. */
  key?: string;
}
declare interface MetricsSpec extends ArtifactOptions {
  /** Each tile shows the value from the latest item that has the field. */
  metrics: ArtifactField[];
}
declare interface BoardSpec extends ArtifactOptions {
  /** Field identifying a card; a later item with the same key moves/updates the card. */
  key: string;
  /** Field holding the card's column. */
  status: string;
  /** Column order. Items whose status is not listed land in a trailing "other" column. */
  columns: string[];
  /** Field for the card title (default: the key) and extra fields shown on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
}
/**
 * Publish what the user keeps: cards beside the run, kept after it ends. Every id is a
 * compile-time string literal (non-empty, at most 64 characters of [A-Za-z0-9_.-]) and is
 * used with one member only.
 * - CONTENT (file, markdown) are effects: async, resolve to an ArtifactRef, and reject
 *   catchably (missing file, not a file, outside the workspace, over the cap, or no artifact
 *   store in this host).
 *   Bytes are copied at publish time; republishing an id mints the next version and keeps
 *   the old ones.
 * - PRESET (chart, table, metrics, board) are declarations: synchronous and void, drawn from
 *   the items tagged report(item, "<id>"). Declare each once, at the top level; an identical
 *   re-declaration is a no-op, a different or malformed spec fails the whole run.
 * Caps: 32 ids per run, 16 versions per id, 20 MiB per file, 256 KB per markdown, 120
 * characters of title and 500 of description.
 */
declare const artifact: {
  /** Publish a workspace file, path resolved as in files.read(). The type comes from the extension unless opts.contentType sets it. */
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  /** Publish markdown text the script composed. */
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  /** Declare a chart fed by report(item, id): each tagged item is one point. */
  chart(id: string, spec: ChartSpec): void;
  /** Declare a table fed by report(item, id): each tagged item is one row. */
  table(id: string, spec: TableSpec): void;
  /** Declare a metric tile row fed by report(item, id): each tile shows the newest value it has. */
  metrics(id: string, spec: MetricsSpec): void;
  /** Declare a board fed by report(item, id): each tagged item is a card, placed by its status field. */
  board(id: string, spec: BoardSpec): void;
};
`;

/**
 * 阶段标注：phase()。展示用的分组标记——
 * 无站点、无 journal 行；lowering 改写成 `__host.enterPhase`，引擎只发一条进入事件
 * 。snippet 刻意不含：片段是世界读取 + 纯逻辑的工作台，不画图，
 * 所以片段里的 `phase()` 得到 TS2304，教删除。
 */
const FACADE_PHASE_SEGMENT = String.raw`
/**
 * Mark the start of a phase: a named group of the steps that follow, drawn as one node on
 * the graph the user approves. Presentation only: it starts, waits for and returns nothing.
 * Required. The name is a non-empty compile-time literal and the call a standalone
 * statement. A marker covers every step from it to the end of the block it stands in
 * (nested blocks and inlined helpers included); two markers with the same name are one
 * phase. Every phase contains at least one ask or world.run.
 */
declare function phase(name: string): void;
`;

/** 世界读取：files.* 与 git.*。两个 facade 都含（snippet 的保真核心）。 */
const FACADE_WORLD_SEGMENT = String.raw`
/** One matching line found by files.grep. */
declare interface GrepMatch {
  /** Workspace-relative path of the file the match was found in. */
  path: string;
  /** One-based line number of the match. */
  line: number;
  /** The full text of the matching line. */
  text: string;
}

/**
 * Read-only views of the workspace. Each result is recorded, so a resumed run gets the same
 * answer back instead of reading again. There is no write: writing is a subagent's task.
 */
declare const files: {
  /** Workspace-relative paths matching a glob, sorted. Over 2000 files the call rejects. */
  glob(pattern: string): Promise<string[]>;
  /** Read one workspace file as UTF-8 text. Size-capped. */
  read(path: string): Promise<string>;
  /**
   * Search contents with a ripgrep-compatible regex, optionally narrowed by a glob over
   * paths ("*.ts", "src/**"); one entry per matching line. Over 2000 matches or 256KB of
   * results the call rejects.
   */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** The working tree's status, as reported by git.status(). */
declare interface GitStatus {
  /** Current branch name; absent when HEAD is detached. */
  branch?: string;
  /** True when nothing is staged, modified, or untracked. */
  clean: boolean;
  /** Workspace-relative paths staged for the next commit. */
  staged: string[];
  /** Workspace-relative paths modified in the working tree but not staged. */
  unstaged: string[];
  /** Workspace-relative paths git does not track (honouring .gitignore). */
  untracked: string[];
}

/** One commit, as reported by git.log(). */
declare interface GitCommit {
  /** Full commit hash. */
  hash: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

/**
 * Read-only git views, recorded like files.* so a resumed run gets the same answer back; no
 * call can write. A base names a single ref (no ".." ranges). Paths are workspace-relative, and
 * changes outside the workspace are not reported; git.log alone is repository-wide. Caps
 * reject rather than truncate: diff at 512KB, log at 100 commits. Outside a git repository,
 * or without git, every call rejects catchably.
 */
declare const git: {
  /**
   * Workspace-relative paths that changed. With no base: files modified against HEAD, plus
   * untracked files. With a base ref: tracked files whose current state differs from that
   * ref, uncommitted edits included, untracked files not.
   */
  changedFiles(base?: string): Promise<string[]>;
  /**
   * Unified diff against base (default HEAD). Covers the whole workspace unless you
   * narrow it to one workspace-relative path.
   */
  diff(base?: string, path?: string): Promise<string>;
  /** The current working-tree status, for the workspace. */
  status(): Promise<GitStatus>;
  /** The most recent commits, newest first. Default 20, maximum 100. */
  log(count?: number): Promise<GitCommit[]>;
};
`;

/**
 * journal 化命令执行：world.run。两个 facade 都含
 * ——snippet 正是测试这些调用的工作台（gate 逻辑在提交前先对真命令跑通）。
 */
const FACADE_WORLD_RUN_SEGMENT = String.raw`
/** The outcome of one world.run command, including nonzero exits. */
declare interface WorldRunResult {
  /** The process exit code. Nonzero is a normal, returned outcome — branch on it. */
  exitCode: number;
  /** Captured output (UTF-8), shaped by opts.output. */
  stdout: string;
  stderr: string;
}

/**
 * Run a command. Each call runs once and its result is recorded: a resumed run reuses the
 * recorded result instead of running the command again. A completed process RESOLVES,
 * nonzero exit included; the promise rejects (catchably) only on spawn failure or timeout
 * (default 300000ms, timeoutMs overrides, no upper cap). cmd is a compile-time string
 * literal, shown to the user at confirmation. Fixed argv, never a shell: no pipes,
 * redirection or expansion. cwd is the workspace. Node builtins are reachable as
 * world.run("node", ["-e", code]).
 * opts.output (both streams): "full" (default) rejects over 16 MiB; "discard" is "";
 * { tail: n } keeps the last n bytes, n <= 16777216 (16 MiB). Neither bounds what the process prints.
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number; output?: "full" | "discard" | { tail: number } }): Promise<WorldRunResult>;
};
`;

/** 运行实参：saved workflow 的声明式参数。两个 facade 都含（snippet 里恒为 `{}`）。 */
const FACADE_ARGS_SEGMENT = String.raw`
/**
 * The run's arguments. For a saved workflow they are validated against its declared
 * arguments, with defaults filled in, before the run starts; an inline script or a snippet
 * gets {}. Always defined; the values are unknown, so narrow them (String(args.target), a
 * typeof guard).
 */
declare const args: Readonly<Record<string, unknown>>;
`;

/**
 * run 身份：两个 facade 都含（snippet 里是一次性的 `dwfeval-…`，无前驱）。注释只写参考层；
 * 「别放进 ask 指令、persona、world 实参」的理由（缓存键）在技能与 authoring.md 里。
 */
const FACADE_RUN_SEGMENT = String.raw`
/**
 * This run's id, and the run it amends. ResumeWorkflowRun keeps both; AmendWorkflow mints a
 * new id. Keep them out of ask text, personas and world arguments: those are cache keys.
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };
`;

export const FACADE_DTS =
  FACADE_ACTOR_SEGMENT +
  FACADE_ARGS_SEGMENT +
  FACADE_RUN_SEGMENT +
  FACADE_LOG_SEGMENT +
  FACADE_REPORT_SEGMENT +
  FACADE_ARTIFACT_SEGMENT +
  FACADE_PHASE_SEGMENT +
  // 留白段只进完整 facade（docs/dynamic-workflow/authoring.md「Holes」）：片段没有 run，也就
  // 没有可等主代理补全的东西，snippet 里的 `hole(...)` 得到 TS2304，教删除。
  FACADE_HOLE_SEGMENT +
  FACADE_WORLD_SEGMENT +
  FACADE_WORLD_RUN_SEGMENT +
  FACADE_STREAM_SEGMENT;

/**
 * snippet（EvalWorkflowSnippet）的 scratch facade：生产 facade 减去 actor 族 / report /
 * artifact / phase（channel / future 保留：流水线的纯逻辑正是片段要排练的东西）（docs/dynamic-workflow/authoring.md「The facade」，phase 见
 * docs/dynamic-workflow/authoring.md「Phases」，artifact 见 docs/dynamic-workflow/authoring.md「Artifacts: what the user keeps」）。留下的是脚本自己
 * 能单测的那部分：世界读取 + world.run +
 * 纯计算 + log。`agent(...)` 在这份 facade 下是普通的 TS2304（Cannot find name），拒绝发生
 * 在编译期而不是运行期。
 *
 * 注入编译器时必须仍以 {@link FACADE_FILE_NAME} 为文件名：facade 身份在五处按声明文件名
 * 判定（registry / sites / facade-misuse / lowering），换名字会让站点收集静默变空——
 * snippet 编译通过却什么都不做。
 */
export const SNIPPET_FACADE_DTS =
  FACADE_ARGS_SEGMENT +
  FACADE_RUN_SEGMENT +
  FACADE_LOG_SEGMENT +
  FACADE_WORLD_SEGMENT +
  FACADE_WORLD_RUN_SEGMENT +
  FACADE_STREAM_SEGMENT;
