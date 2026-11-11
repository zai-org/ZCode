// 受管 worktree 的编排（docs/git/worktree.md §3.3–§3.6、§3.11、§8）。
// 本服务是 worktree 生命周期的唯一执行者；git 操作、任务行、会话命令、终端查询都经注入端口完成。
// 创建记录只在内存中，是创建阶段的唯一数据源；renderer 只订阅，不推算。
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import {
  MANAGED_WORKTREE_OUTPUT_LIMIT,
  type CreateManagedWorktreeResult,
  type ManagedWorktreeCreation,
  type ManagedWorktreeCreationSettlement,
  type ManagedWorktreeError,
} from "@zcode/shared";
import {
  isPathInside,
  mapProjectRootsIntoWorktree,
  isSamePath,
} from "@zcode/shared/managed-worktree";
import {
  COMMAND_QUERY_UNAVAILABLE_REASON,
  type CommandAck,
  type CommandEnvelope,
  type CommandKey,
} from "@zcode/shared/zcode-protocol-v4";
import type { ManagedWorktreeServicePorts } from "#src/managed-worktree-tasks/ports.js";
import { createWorktreeRemoval, errorOf } from "#src/managed-worktree-tasks/removal.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IManagedWorktreeService,
  ManagedWorktreeGroup,
  ManagedWorktreeWorkspace,
  StartManagedWorktreeCreationResult,
} from "./contract.js";

const log = createServiceLogger("managed-worktree");
/** 无法确认最后一次会话命令是否执行；调用方不能做破坏性清理（§3.5）。 */
const COMMAND_UNCONFIRMED_ERROR = "worktree.command-unconfirmed";
/** 残留 worktree 中仍有忙碌的会话，不能删除。 */
const WORKTREE_IN_USE_ERROR = "worktree.worktree-in-use";
/** 请 CLI 卸载残留 worktree 中的会话时请求失败。 */
const SESSION_CLOSE_FAILED_ERROR = "worktree.session-close-failed";
/** 这些错误表示操作被拒绝、没有发送任何会话命令；创建记录保持原来的失败状态。 */
const REJECTED_ACTION_ERRORS: ReadonlySet<string> = new Set([
  COMMAND_UNCONFIRMED_ERROR,
  WORKTREE_IN_USE_ERROR,
  SESSION_CLOSE_FAILED_ERROR,
]);
/** 与 commandFactory 预分配会话 ID 的格式一致，CLI 按普通会话 ID 接受。 */
const SESSION_ID_PREFIX = "sess_";

interface CreationState {
  record: ManagedWorktreeCreation;
  /** 原始命令：新建任务为 createSession，fork 为 forkAssistant。 */
  envelope: CommandEnvelope;
  /** worktree 的检出源目录：新建任务为项目主目录，fork 为父任务 cwd。 */
  sourcePath: string;
  workspaceIdentity?: string;
  /** worktree 建好后保存，重试会话创建时复用。 */
  created: Extract<CreateManagedWorktreeResult, { ok: true }> | null;
  /** 预分配的会话 ID（新建任务）或子会话 ID（fork），重试时不变。 */
  sessionId: string;
  /**
   * 最后一次发给 CLI 的会话命令及其预期会话 ID。会话启动失败可能只是结果未知（请求异常），
   * 放弃前按它向 CLI 查询是否已执行（§3.5）。
   */
  sentCommand: { key: CommandKey; sessionId: string } | null;
  /**
   * 本次发送使用的命令 ID：初始为原始命令的 ID；CLI 确认上一次命令未执行时换新（§3.5）。
   * 原始命令 ID 仍用于 startNewTask / forkToWorktree 的幂等查找。
   */
  commandId: string;
  /** 选择"不使用 worktree"后为 true：sessionId 已换成项目主目录会话的 ID，之后都在主目录发送。 */
  localMode: boolean;
  running: boolean;
}

function isAccepted(ack: CommandAck): boolean {
  return ack.status === "accepted" || ack.status === "duplicate";
}

function startedSessionId(ack: CommandAck, expected: string): string {
  return ack.result?.type === "forkAssistant" || ack.result?.type === "createSession"
    ? ack.result.sessionId
    : expected;
}

function sessionIdOf(envelope: CommandEnvelope): string | undefined {
  const value = (envelope.payload as { sessionId?: unknown } | null)?.sessionId;
  return typeof value === "string" && value ? value : undefined;
}

export function createManagedWorktreeService(
  ports: ManagedWorktreeServicePorts,
): IManagedWorktreeService {
  const now = ports.now ?? Date.now;
  const creations = new Map<string, CreationState>();
  const changeEmitter = new Emitter<ManagedWorktreeCreation[]>();
  const settleEmitter = new Emitter<ManagedWorktreeCreationSettlement>();

  function snapshot(): ManagedWorktreeCreation[] {
    return [...creations.values()].map((state) => ({ ...state.record }));
  }

  function publish(): void {
    changeEmitter.fire(snapshot());
    ports.reportCreatingCount?.(
      [...creations.values()].filter((state) => state.record.phase !== "failed").length,
    );
  }

  function appendOutput(state: CreationState, text: string): void {
    const output = state.record.output + text;
    state.record.output =
      output.length > MANAGED_WORKTREE_OUTPUT_LIMIT
        ? output.slice(output.length - MANAGED_WORKTREE_OUTPUT_LIMIT)
        : output;
    publish();
  }

  function fail(state: CreationState, error: ManagedWorktreeError): void {
    state.record.phase = "failed";
    state.record.error = error;
    log.warn(undefined, "worktree 创建失败", {
      creationId: state.record.id,
      kind: state.record.kind,
      code: error.code,
      // detail 是结构化原因码或 git stderr 摘要，不含用户输入。
      detail: error.detail,
    });
    publish();
  }

  function settle(state: CreationState, settlement: ManagedWorktreeCreationSettlement): void {
    creations.delete(state.record.id);
    // 先发结束事件再推送列表：renderer 先切到真实会话，避免创建视图消失后闪出空草稿。
    settleEmitter.fire(settlement);
    publish();
    void ports.afterChange?.();
  }

  function assertLocal(): void {
    if (!ports.isLocalHost) throw new Error("worktree.local-only");
  }

  async function requireProject(projectId: string) {
    assertLocal();
    const project = (await ports.repository())
      .readTree({ includeTasks: false })
      .projects.find((item) => item.id === projectId && !item.deleted);
    if (!project) throw new Error("project.not-found");
    return project;
  }

  /**
   * worktree 任务的附加目录（I3/I16，§2.1）：源仓库内的 root 映射到 worktree 中对应的路径，
   * 起点中不存在的目录不加入；worktree 任务不能拿到源仓库主 checkout 的写权限。
   */
  async function explicitDirectories(
    projectId: string,
    placement: { sourceRoot: string; worktreeRoot: string; cwd: string },
  ): Promise<string[]> {
    const project = await requireProject(projectId);
    const candidates = mapProjectRootsIntoWorktree(
      project.roots.map((root) => root.rootPath),
      placement,
    );
    const exists = await Promise.all(
      candidates.map((path) =>
        stat(path).then(
          (stats) => stats.isDirectory(),
          () => false,
        ),
      ),
    );
    return candidates.filter((_, index) => exists[index]);
  }

  const removal = createWorktreeRemoval({
    ports,
    requireProject,
    // 创建中的 worktree 由创建记录的"放弃"处理，不允许从管理弹窗删除（§3.11）。
    isCreatingAt: (worktreeRoot) =>
      [...creations.values()].some(
        (state) =>
          state.record.worktreePath !== null && isSamePath(state.record.worktreePath, worktreeRoot),
      ),
  });
  const releaseCliSessionsUnder = removal.releaseCliSessionsUnder;

  function requireState(creationId: string): CreationState {
    const state = creations.get(creationId);
    if (!state) throw new Error("worktree.creation-not-found");
    return state;
  }

  /**
   * 卸载这条创建记录的 worktree 中由失败的会话命令留下的驻留会话（§3.5）。worktree 是本次创建新建的，
   * 其中只有这条记录产生的会话。忙 → WORKTREE_IN_USE_ERROR；请求失败 → SESSION_CLOSE_FAILED_ERROR。
   */
  async function unloadFailedSessionsIn(state: CreationState, worktreePath: string): Promise<void> {
    let cli: { released: string[]; busy: string[] };
    try {
      cli = await releaseCliSessionsUnder(
        state.record.projectId,
        [{ workspacePath: state.record.workspacePath }],
        worktreePath,
      );
    } catch (error) {
      log.warn(undefined, "卸载残留 worktree 中的会话失败", {
        creationId: state.record.id,
        error: String(error),
      });
      throw new Error(SESSION_CLOSE_FAILED_ERROR);
    }
    if (cli.busy.length > 0) throw new Error(WORKTREE_IN_USE_ERROR);
  }

  /**
   * 创建失败后残留的 worktree；它没有可见任务（只有尚无 CLI 事实的预留行），可以强制删除。
   * 预留行已有 CLI 事实时说明会话已存在：不删除 worktree，返回 false（§3.5）。
   */
  async function discardWorktree(state: CreationState): Promise<boolean> {
    // Bug 原因：预留行带着 worktree_root，曾在放弃后保留，删除检查把它当作使用中的任务，
    // 残留 worktree 无法在管理弹窗中清理（§3.5）。先撤销预留，再删除目录。
    const release = (await ports.repository()).releaseReservedTask({
      task: {
        workspacePath: state.record.workspacePath,
        ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
        taskId: state.sessionId,
      },
    });
    // 修复原因：曾忽略返回值并强制删除目录；会话已由 CLI 创建时，这会删掉真实任务的 cwd 和改动。
    // 只有 kept（行已有 CLI 事实）说明会话已存在；absent（从未预留或已撤销）可以继续清理。
    if (release === "kept") return false;
    const path = state.created?.worktree.path ?? state.record.worktreePath;
    if (!path) return true;
    // 失败的 createSession 可能已在 CLI 中留下草稿会话（首条消息失败时 CLI 不清理记录）。删除目录前
    // 先请 CLI 卸载这个 worktree 内的驻留会话，避免会话驻留在已删除的目录上（§3.5）。
    await unloadFailedSessionsIn(state, path);
    const result = await ports.git.remove({ path, force: true });
    if (!result.ok && result.error.code !== "not-managed")
      log.warn(undefined, "清理残留 worktree 失败，保留给管理弹窗处理", {
        creationId: state.record.id,
        code: result.error.code,
      });
    state.created = null;
    state.record.worktreePath = null;
    return true;
  }

  /**
   * 查询上一次会话命令的裁决。修复原因：查询请求本身抛错（连接中断等）时，曾在"不使用 worktree"中
   * 被记为会话启动失败，另外两个操作却原样抛出；三者统一为"无法确认"（§3.5）。
   */
  async function queryPreviousCommand(
    target: Parameters<ManagedWorktreeServicePorts["agent"]["queryCommandResult"]>[0],
  ) {
    try {
      return await ports.agent.queryCommandResult(target);
    } catch (error) {
      log.warn(undefined, "查询会话命令结果失败", { error: String(error) });
      throw new Error(COMMAND_UNCONFIRMED_ERROR);
    }
  }

  /**
   * 放弃、"不使用 worktree"或重试之前，向 CLI 确认最后一次发出的会话命令是否已执行（§3.5）。
   * "会话启动失败"可能只是结果未知（请求异常、连接中断），CLI 是唯一能回答的一方；不用超时推断。
   * - 已执行：按"会话已启动"结束创建记录，返回 true。
   * - 无法确认：抛出，创建记录保持失败。
   * - 确认没有成功：撤销旧预留，换新的会话 ID 与命令 ID，返回 false（原因见下方注释）。
   */
  async function resolvePreviousAttempt(state: CreationState): Promise<boolean> {
    const sent = state.sentCommand;
    if (!sent) return false;
    const result = await queryPreviousCommand({
      workspacePath: state.record.workspacePath,
      ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
      key: sent.key,
    });
    if (result !== "unknown" && isAccepted(result)) {
      settleStarted(state, startedSessionId(result, sent.sessionId));
      return true;
    }
    // 修复原因：CLI 读取命令记录失败时返回 failed + queryUnavailable，而不是抛错；曾被当作"未执行"
    // 继续撤销预留并强制删除目录，可能删掉真实会话的 cwd。无法确认时不做破坏性清理（§3.5）。
    if (result !== "unknown" && result.reasonCode === COMMAND_QUERY_UNAVAILABLE_REASON)
      throw new Error(COMMAND_UNCONFIRMED_ERROR);
    // 确认没有成功：换新的会话 ID 与命令 ID。修复原因：CLI 的 createSession 先建会话记录、再发首条
    // 消息，首条消息失败时记录不清理；沿用旧会话 ID 重发会报会话已存在，记录永远无法恢复（§3.5）。
    // 旧 ID 的预留先撤销；行已有 CLI 事实说明会话已存在，按"会话已启动"结束。
    const release = (await ports.repository()).releaseReservedTask({
      task: {
        workspacePath: state.record.workspacePath,
        ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
        taskId: state.sessionId,
      },
    });
    if (release === "kept") {
      settleStarted(state, state.sessionId);
      return true;
    }
    // 确认不是真实任务之后，worktree 模式再卸载失败留下的草稿（与 discardWorktree 同一顺序）：
    // 否则它一直驻留在 worktree 中，之后的强制删除会被当作"有任务正在使用"拒绝。曾先卸载再判断，
    // 真实任务忙时会被拦成"worktree 正在使用"。主目录中的会话不能按目录整体卸载，不处理。
    if (!state.localMode && state.created)
      await unloadFailedSessionsIn(state, state.created.worktree.path);
    state.sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    state.commandId = randomUUID();
    // 上一次命令已有结论，之后不再按它查询。
    state.sentCommand = null;
    return false;
  }

  /** 在项目主目录发送首条消息（"不使用 worktree"与它之后的重试）。 */
  async function sendLocal(state: CreationState): Promise<void> {
    const commandId = state.commandId;
    state.record.phase = "starting-session";
    state.record.error = null;
    publish();
    state.sentCommand = { key: { sessionId: null, commandId }, sessionId: state.sessionId };
    const ack = await ports.agent.sendCommand({
      workspacePath: state.record.workspacePath,
      projectId: state.record.projectId,
      envelope: {
        ...state.envelope,
        commandId,
        payload: {
          ...(state.envelope.payload as Record<string, unknown>),
          sessionId: state.sessionId,
        },
      },
    });
    if (!isAccepted(ack)) {
      fail(state, errorOf("session-failed", ack.reasonCode ?? ack.status));
      return;
    }
    settleStarted(state, startedSessionId(ack, state.sessionId));
  }

  function settleStarted(state: CreationState, sessionId: string): void {
    log.info(undefined, "worktree 任务已启动", {
      creationId: state.record.id,
      kind: state.record.kind,
      sessionId,
    });
    settle(state, {
      creationId: state.record.id,
      outcome: "session-started",
      workspacePath: state.record.workspacePath,
      sessionId,
    });
  }

  async function createWorktree(state: CreationState): Promise<boolean> {
    const created = await ports.git.create(
      {
        sourcePath: state.sourcePath,
        ...(state.record.ref ? { startRef: state.record.ref } : {}),
        // fork 的新 worktree 是父任务 cwd 当前状态的副本，带入未提交改动（§3.6）。
        ...(state.record.kind === "fork" ? { carryChanges: true } : {}),
      },
      {
        onOutput: (text) => appendOutput(state, text),
        onPathAllocated: (path) => {
          state.record.worktreePath = path;
          publish();
        },
      },
    );
    if (!created.ok) {
      state.record.worktreePath = null;
      fail(state, created.error);
      return false;
    }
    state.created = created;
    state.record.worktreePath = created.worktree.path;
    return true;
  }

  async function startSession(state: CreationState): Promise<void> {
    const created = state.created!;
    state.record.phase = "starting-session";
    state.record.error = null;
    publish();
    const repository = await ports.repository();
    const worktreeCreation = {
      path: created.worktree.path,
      sha: created.worktree.head ?? "",
      ref: state.record.ref,
      output: state.record.output,
    };
    // 先于 CLI 写入任务行：workspace = 项目，cwd 与 worktree 根只在这里写一次（§6.6.1）。
    repository.reserveCreatedTask({
      task: {
        workspacePath: state.record.workspacePath,
        ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
        taskId: state.sessionId,
      },
      projectId: state.record.projectId,
      cwd: created.cwd,
      worktreeRoot: created.worktree.path,
      additionalDirectories: await explicitDirectories(state.record.projectId, {
        sourceRoot: created.worktree.sourceRoot,
        worktreeRoot: created.worktree.path,
        cwd: created.cwd,
      }),
    });
    const payload = state.envelope.payload as Record<string, unknown>;
    const envelope: CommandEnvelope =
      state.record.kind === "new-task"
        ? {
            ...state.envelope,
            commandId: state.commandId,
            payload: { ...payload, sessionId: state.sessionId, cwd: created.cwd, worktreeCreation },
          }
        : {
            ...state.envelope,
            commandId: state.commandId,
            payload: {
              ...payload,
              targetCwd: { cwd: created.cwd, childSessionId: state.sessionId, worktreeCreation },
            },
          };
    state.sentCommand = {
      key: {
        sessionId: state.record.kind === "new-task" ? null : (state.envelope.sessionId ?? null),
        commandId: envelope.commandId,
      },
      sessionId: state.sessionId,
    };
    const ack = await ports.agent.sendCommand({
      workspacePath: state.record.workspacePath,
      ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
      ...(state.record.kind === "new-task" ? { projectId: state.record.projectId } : {}),
      envelope,
    });
    if (!isAccepted(ack)) {
      // worktree 保留：重试只重做会话创建，重发前先向 CLI 确认这次命令的结果（§3.5）。
      fail(state, errorOf("session-failed", ack.reasonCode ?? ack.status));
      return;
    }
    settleStarted(state, startedSessionId(ack, state.sessionId));
  }

  async function run(state: CreationState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
      if (!state.created) {
        state.record.phase = "creating";
        state.record.error = null;
        publish();
        if (!(await createWorktree(state))) return;
      }
      await startSession(state);
    } catch (error) {
      fail(
        state,
        errorOf("session-failed", error instanceof Error ? error.message : String(error)),
      );
    } finally {
      state.running = false;
    }
  }

  function findByCommand(commandId: string): CreationState | undefined {
    return [...creations.values()].find((state) => state.envelope.commandId === commandId);
  }

  function begin(state: CreationState): StartManagedWorktreeCreationResult {
    creations.set(state.record.id, state);
    publish();
    void run(state);
    return { ok: true, creationId: state.record.id };
  }

  async function supports(target: ManagedWorktreeWorkspace): Promise<boolean> {
    if (!ports.isLocalHost || target.workspaceIdentity?.trim()) return false;
    return await ports.agent.supportsWorktreeCwd(target);
  }

  function assertFailed(state: CreationState): void {
    if (state.record.phase !== "failed" || state.running)
      throw new Error("worktree.creation-not-failed");
  }

  /**
   * 同一 commandId 只启动一次创建（§10）：在第一次 await 之前同步登记，并发重放复用同一结果。
   * 修复原因：曾在幂等查找之后经过多次 await 才登记创建记录，并发重放会建出第二个 worktree。
   * 只需在本 Host 内去重：一台机器只有一个本地 Host，renderer 的命令只发往它（docs/git/worktree.md §8.3）。
   */
  const pendingStarts = new Map<string, Promise<StartManagedWorktreeCreationResult>>();
  function startOnce(
    commandId: string,
    start: () => Promise<StartManagedWorktreeCreationResult>,
  ): Promise<StartManagedWorktreeCreationResult> {
    const existing = findByCommand(commandId);
    if (existing) return Promise.resolve({ ok: true, creationId: existing.record.id });
    const pending = pendingStarts.get(commandId);
    if (pending) return pending;
    const started = start().finally(() => pendingStarts.delete(commandId));
    pendingStarts.set(commandId, started);
    return started;
  }

  async function startNewTaskNow(
    params: Parameters<IManagedWorktreeService["startNewTask"]>[0],
  ): Promise<StartManagedWorktreeCreationResult> {
    if (params.workspaceIdentity?.trim()) return { ok: false, error: errorOf("local-only") };
    const { envelope } = params;
    const payload = envelope.payload as { firstInput?: { text?: unknown } } | null;
    if (envelope.type !== "createSession" || !payload?.firstInput)
      throw new Error("worktree.invalid-command");
    const project = await requireProject(params.projectId);
    // worktree 只从项目主目录检出（§3.2）；其他目录说明草稿与项目不一致。
    const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
    if (!primary || !isSamePath(primary, params.workspacePath))
      throw new Error("worktree.not-primary-root");
    if (!(await supports(params))) return { ok: false, error: errorOf("unsupported-agent") };
    return begin({
      record: {
        id: randomUUID(),
        kind: "new-task",
        projectId: params.projectId,
        workspacePath: params.workspacePath,
        phase: "creating",
        ref: params.ref,
        worktreePath: null,
        output: "",
        error: null,
        promptText: typeof payload.firstInput.text === "string" ? payload.firstInput.text : "",
        parentSessionId: null,
        createdAt: now(),
      },
      envelope,
      sourcePath: params.workspacePath,
      created: null,
      sessionId: sessionIdOf(envelope) ?? `${SESSION_ID_PREFIX}${randomUUID()}`,
      sentCommand: null,
      commandId: envelope.commandId,
      localMode: false,
      running: false,
    });
  }

  async function forkToWorktreeNow(
    params: Parameters<IManagedWorktreeService["forkToWorktree"]>[0],
  ): Promise<StartManagedWorktreeCreationResult> {
    if (!ports.isLocalHost || params.workspaceIdentity?.trim())
      return { ok: false, error: errorOf("local-only") };
    const { envelope } = params;
    if (envelope.type !== "forkAssistant" || !envelope.sessionId)
      throw new Error("worktree.invalid-command");
    if (!(await supports(params))) return { ok: false, error: errorOf("unsupported-agent") };
    // 父任务的 cwd 与项目取 tasks-index（不信任 UI 传入）。
    const parent = (await ports.repository()).resolveSessionDirectories({
      workspacePath: params.workspacePath,
      taskId: envelope.sessionId,
    });
    if (!parent.projectId) throw new Error("worktree.requires-project");
    return begin({
      record: {
        id: randomUUID(),
        kind: "fork",
        projectId: parent.projectId,
        workspacePath: params.workspacePath,
        phase: "creating",
        ref: null,
        worktreePath: null,
        output: "",
        error: null,
        promptText: null,
        parentSessionId: envelope.sessionId,
        createdAt: now(),
      },
      envelope,
      // worktree 从父任务 cwd 检出（父任务本身可能在另一个 worktree 中）。
      sourcePath: parent.cwd ?? parent.workspacePath,
      created: null,
      sessionId: `${SESSION_ID_PREFIX}${randomUUID()}`,
      sentCommand: null,
      commandId: envelope.commandId,
      localMode: false,
      running: false,
    });
  }

  return {
    startNewTask: (params) => startOnce(params.envelope.commandId, () => startNewTaskNow(params)),

    forkToWorktree: (params) =>
      startOnce(params.envelope.commandId, () => forkToWorktreeNow(params)),

    async retryCreation({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      // 重发前确认上一次命令：已执行则直接打开，确认未执行则换新命令 ID（§3.5）。
      state.running = true;
      try {
        if (await resolvePreviousAttempt(state)) return;
      } finally {
        state.running = false;
      }
      // 项目主目录模式下重试的是主目录发送，不再创建 worktree。
      if (!state.localMode) {
        await run(state);
        return;
      }
      state.running = true;
      try {
        await sendLocal(state);
      } catch (error) {
        fail(
          state,
          errorOf("session-failed", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        state.running = false;
      }
    },

    async continueWithoutWorktree({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      if (state.record.kind !== "new-task") throw new Error("worktree.invalid-command");
      state.running = true;
      try {
        // 会话其实已创建时不能再发一次首条消息（§3.5）。
        if (await resolvePreviousAttempt(state)) return;
        if (!(await discardWorktree(state))) {
          settleStarted(state, state.sessionId);
          return;
        }
        // 切换为项目主目录模式：换新的会话 ID（旧 ID 的预留指向 worktree cwd）与命令 ID。
        // 修复原因：曾每次都生成新 ID 且不写回 state.sessionId，之后的放弃与重试作用在旧 ID 上。
        if (!state.localMode) {
          state.localMode = true;
          state.sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
          state.commandId = randomUUID();
        }
        await sendLocal(state);
      } catch (error) {
        // 操作被拒绝（无法确认、worktree 正在使用、卸载会话失败）不是启动失败：原样抛给调用方
        // 按各自原因提示，记录保持原来的失败状态。
        if (error instanceof Error && REJECTED_ACTION_ERRORS.has(error.message)) throw error;
        fail(
          state,
          errorOf("session-failed", error instanceof Error ? error.message : String(error)),
        );
      } finally {
        state.running = false;
      }
    },

    async dismissCreation({ creationId }) {
      const state = requireState(creationId);
      assertFailed(state);
      state.running = true;
      try {
        if (await resolvePreviousAttempt(state)) return;
        if (!(await discardWorktree(state))) {
          settleStarted(state, state.sessionId);
          return;
        }
      } finally {
        state.running = false;
      }
      settle(state, {
        creationId,
        outcome: "dismissed",
        workspacePath: state.record.workspacePath,
        promptText: state.record.promptText,
      });
    },

    async listCreations() {
      return ports.isLocalHost ? snapshot() : [];
    },

    onDidChangeCreations: changeEmitter.event,
    onDidSettleCreation: settleEmitter.event,

    async listWorktrees(params) {
      const project = await requireProject(params.projectId);
      const repository = await ports.repository();
      const groups = new Map<string, ManagedWorktreeGroup>();
      const owned = [...creations.values()]
        .map((state) => state.record.worktreePath)
        .filter((path): path is string => Boolean(path));
      // 项目可有多个 root 属于同一仓库；按源仓库去重，每个仓库只列一次。
      for (const root of project.roots) {
        const listed = await ports.git.list({ sourcePath: root.rootPath }).catch(() => null);
        if (!listed?.sourceRoot || groups.has(listed.sourceRoot)) continue;
        groups.set(listed.sourceRoot, {
          sourceRoot: listed.sourceRoot,
          worktrees: listed.worktrees.map((worktree) => ({
            ...worktree,
            creating: owned.some((path) => isSamePath(path, worktree.path)),
            tasks: repository
              .listTasksByWorktree({ worktreeRoot: worktree.path })
              .map(({ taskId, workspacePath, workspaceIdentity, title, archived }) => ({
                taskId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                title,
                archived,
              })),
          })),
        });
      }
      return { groups: [...groups.values()] };
    },

    removeWorktree: (params) => removal.removeWorktree(params),

    async pruneWorktrees(params) {
      const project = await requireProject(params.projectId);
      if (!project.roots.some((root) => isPathInside(params.sourceRoot, root.rootPath)))
        throw new Error("worktree.not-managed");
      await ports.git.prune({ sourcePath: params.sourceRoot });
    },

    async listStartRefs(params) {
      const project = await requireProject(params.projectId);
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      return primary ? await ports.git.listStartRefs({ sourcePath: primary }) : null;
    },

    async isWorktreeAvailable(params) {
      if (!ports.isLocalHost) return true;
      return (await ports.git.resolveManagedWorktree(params.worktreeRoot)) !== null;
    },

    async supportsWorktreeCwd(params) {
      return await supports(params);
    },
  };
}
