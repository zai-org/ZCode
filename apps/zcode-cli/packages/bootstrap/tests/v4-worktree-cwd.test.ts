// 受管 worktree = 会话 cwd（docs/git/worktree.md §1.1 / §9.3）集成验收：
// 真实 git 仓库 + 真实 linked worktree（<dataBaseDir>/.zcode/worktrees/<bucket>/<repo>）+
// 真 sqlite sessionStore + ZCodeProtocolAgentServer + 真 app。
// 覆盖：能力声明、createSession.cwd（key 属于项目、执行路径是 worktree、权限/记忆映射回源仓库）、
// "已创建 worktree" 首轮落盘并在首个用户输入之前投影、冷恢复（Host key + 存储 cwd）、
// forkAssistant.targetCwd（同一进程注册、追加标记、幂等）、worktreeSessionIds 冷列表。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  commandAckSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  routedTopicWireFrameSchema,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  MessageId,
  MessagePart,
  ModelId,
  ModelProviderId,
  SessionId,
} from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { projectIdFromDirectory } from "../src/app/paths.js";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

const execFileAsync = promisify(execFile);
const BUCKET = "3f2a";
const REPO = "repo";
const MODEL = { providerId: "zai", modelId: "glm-4.6" };
const WORKTREE_CREATION_OUTPUT = "Preparing worktree (detached HEAD)\nHEAD is now at abc\n";

const PARENT_SESSION_ID = "sess_worktree_fork_parent";

type Booted = Awaited<ReturnType<typeof bootServer>>;

/** 父会话直接落 sqlite（项目主目录），冷订阅即可得到可 fork 的 assistant 行，不依赖模型。 */
async function seedParentSession(dbPath: string, directory: string) {
  const store = await createSqliteSessionStore({ dbPath });
  const sessionID = PARENT_SESSION_ID as SessionId;
  try {
    await store.createSession({
      id: sessionID,
      projectID: projectIdFromDirectory(directory),
      slug: "worktree-fork-parent",
      directory,
      path: directory,
      title: "Worktree fork parent",
      version: "test-version",
      time: { created: 1, updated: 2 },
    });
    for (const [index, role, text] of [
      [1, "user", "父任务问题"],
      [2, "assistant", "父任务回答"],
    ] as const) {
      const id = `msg_wt_fork_${role}` as MessageId;
      await store.saveMessage(
        role === "user"
          ? {
              id,
              sessionID,
              role,
              time: { created: index },
              agent: "zcode-agent",
              model: { providerID: MODEL.providerId as ModelProviderId, modelID: MODEL.modelId as ModelId },
              tools: {},
            }
          : {
              id,
              sessionID,
              role,
              time: { created: index, completed: index },
              parentID: "msg_wt_fork_user" as MessageId,
              providerID: MODEL.providerId as ModelProviderId,
              modelID: MODEL.modelId as ModelId,
              mode: "build",
              agent: "zcode-agent",
              path: { cwd: directory, root: directory },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      );
      await store.savePart({
        id: `${id}_text` as MessagePart["id"],
        sessionID,
        messageID: id,
        type: "text",
        text,
        time: { start: index, end: index },
      });
    }
  } finally {
    store.close();
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=ZCode Test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );
  return stdout.trim();
}

async function fixture(root: string) {
  const source = join(root, "projects", REPO);
  const dataBaseDir = join(root, "data");
  const worktree = join(dataBaseDir, ".zcode", "worktrees", BUCKET, REPO);
  const plain = join(root, "plain");
  await mkdir(source, { recursive: true });
  await mkdir(plain, { recursive: true });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(source, "init", "-q");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "init");
  await mkdir(join(dataBaseDir, ".zcode", "worktrees", BUCKET), { recursive: true });
  await git(source, "worktree", "add", "--detach", worktree, "HEAD");
  const sha = await git(worktree, "rev-parse", "HEAD");
  return { source, dataBaseDir, worktree, plain, sha };
}

async function bootServer(dbPath: string, dataBaseDir: string) {
  const store = await createSqliteSessionStore({ dbPath });
  const apps: Array<{ app: ZCodeApp; options: Omit<ZCodeAppOptions, "providerRegistry"> }> = [];
  const env = { ZCODE_DATA_BASE_DIR: dataBaseDir };
  const providerRegistry = createTestProviderRegistry([MODEL]);
  const server = new ZCodeProtocolAgentServer({
    cwd: process.cwd(),
    env,
    sessionStore: store,
    createZCodeApp: async (options = {}) => {
      const app = await createRegistryBackedTestApp({
        ...options,
        // 内置 MCP 子进程与本用例无关，关闭避免进程握手噪声。
        runtimeConfig: { ...options.runtimeConfig, mcp: { enabled: false } },
        env,
        skipUserConfig: true,
        providerRegistry,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop" as const,
              text: "worktree answer",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText() {
            yield { type: "text_delta" as const, text: "worktree answer" };
            yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
          },
        },
      });
      apps.push({ app, options });
      return app;
    },
  });
  server.setNotificationSink((message) => {
    if (!("id" in message)) return;
    if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
    }
  });
  return {
    server,
    store,
    apps,
    close: async () => {
      await server.shutdown();
      server.disposeProjections();
      for (const { app } of apps) await app.close();
      store.close();
    },
  };
}

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function takeInitialFrame(server: ZCodeProtocolAgentServer, requestId: string) {
  const messages = server.takePostResponseMessages(requestId);
  const frameMessage = messages.find(
    (message) => "method" in message && message.method === V4_NOTIFICATIONS.conversationFrame,
  );
  if (!frameMessage) throw new Error("Expected an initial conversation frame");
  const wire = routedTopicWireFrameSchema.parse((frameMessage as { params: unknown }).params);
  if (wire.kind !== "complete") throw new Error("Expected one complete physical wire");
  return wire.frame;
}

async function conversationSnapshot(
  booted: Booted,
  sessionId: string,
  workspace?: { workspaceKey: string; workspacePath: string },
): Promise<ConversationSnapshot> {
  const id = `subscribe-${sessionId}-${Math.random()}`;
  await requestResult(booted.server, {
    id,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: conversationTopic(sessionId),
      connectionId: id,
      clientMode: "desktop-continuous",
      ...(workspace ? { workspace } : {}),
    },
  });
  const frame = conversationTopicFrameSchema.parse(takeInitialFrame(booted.server, id));
  if (frame.payload.kind !== "snapshot") throw new Error("Expected conversation snapshot");
  return frame.payload.snapshot;
}

async function sessionsIndexIds(
  booted: Booted,
  workspaceId: string,
  worktreeSessionIds?: string[],
): Promise<string[]> {
  const id = `index-${workspaceId}-${Math.random()}`;
  await requestResult(booted.server, {
    id,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: sessionsIndexTopic(workspaceId),
      connectionId: id,
      clientMode: "desktop-continuous",
      ...(worktreeSessionIds ? { worktreeSessionIds } : {}),
    },
  });
  const frame = sessionsIndexTopicFrameSchema.parse(takeInitialFrame(booted.server, id));
  if (frame.payload.kind !== "snapshot") throw new Error("Expected sessions-index snapshot");
  return frame.payload.snapshot.sessions.map((session) => session.sessionId).sort();
}

function command(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  extra: { sessionId?: string | null; baseRevision?: number; baseLogEpoch?: string } = {},
) {
  return {
    id,
    method: V4_METHODS.command,
    params: {
      commandId: id,
      clientId: "client-worktree-cwd",
      sessionId: extra.sessionId ?? null,
      ...(extra.baseRevision !== undefined ? { baseRevision: extra.baseRevision } : {}),
      ...(extra.baseLogEpoch ? { baseLogEpoch: extra.baseLogEpoch } : {}),
      type,
      payload,
      issuedAt: 1_700_000_000_000,
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rowKinds(snapshot: ConversationSnapshot): string[] {
  return snapshot.rows.window.map((row) =>
    row.kind === "timelineMarker" ? `marker:${row.marker.type}` : row.kind,
  );
}

describe("受管 worktree 作为会话 cwd（集成：真 git worktree + sqlite + server + app）", { timeout: 30_000 }, () => {
  let root: string;
  let paths: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    // resolver 按 realpath 判定；macOS 临时目录是软链，fixture 统一用 realpath。
    root = await realpath(await mkdtemp(join(tmpdir(), "zcode-v4-worktree-cwd-")));
    paths = await fixture(root);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("runtime/capabilities 声明 worktreeCwd，不再声明 forkTargetWorkspace", async () => {
    const booted = await bootServer(join(root, "capabilities.db"), paths.dataBaseDir);
    try {
      const capabilities = await requestResult(booted.server, {
        id: "capabilities",
        method: zcodeProtocolMethods.runtimeCapabilities,
        params: {},
      });
      expect(capabilities).toMatchObject({ worktreeCwd: true });
      expect(capabilities).not.toHaveProperty("forkTargetWorkspace");
    } finally {
      await booted.close();
    }
  });

  it("runtime/capabilities 声明 conversationQuoteComment，App 才提供选区批注入口", async () => {
    const booted = await bootServer(join(root, "quote-comment.db"), paths.dataBaseDir);
    try {
      const capabilities = await requestResult(booted.server, {
        id: "capabilities-quote-comment",
        method: zcodeProtocolMethods.runtimeCapabilities,
        params: {},
      });
      expect(zcodeRuntimeCapabilitiesSchema.parse(capabilities)).toMatchObject({
        conversationQuoteComment: true,
      });
    } finally {
      await booted.close();
    }
  });

  it("createSession.cwd：key 属于项目、在 worktree 执行；首轮前落盘标记；冷恢复保持 cwd", async () => {
    const dbPath = join(root, "create.db");
    const live = await bootServer(dbPath, paths.dataBaseDir);
    let sessionId = "";
    try {
      const ack = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("create-wt", "createSession", {
            workspaceId: paths.source,
            cwd: paths.worktree,
            worktreeCreation: {
              path: paths.worktree,
              sha: paths.sha,
              ref: null,
              output: WORKTREE_CREATION_OUTPUT,
            },
            firstInput: { text: "在 worktree 里工作", modelSelection: MODEL },
          }),
        ),
      );
      expect(ack.status).toBe("accepted");
      if (ack.result?.type !== "createSession") throw new Error("Expected createSession result");
      sessionId = ack.result.sessionId;
      const created = live.apps.at(-1)!;
      expect(created.options.runtimeConfig?.workingDirectory).toBe(paths.worktree);
      // Hook Trust 等对外字段使用项目 workspace key（§7.3）。
      expect(created.options.workspaceKey).toBe(paths.source);
      // MCP 工具调用与官方 MCP 授权头以会话 key 为身份（§9.3）。config 是 runtime 私有字段，
      // 这里只读校验 create-app 的接线。
      expect(
        (created.app.runtime as unknown as { config: { workspaceKey?: string } }).config.workspaceKey,
      ).toBe(paths.source);
      // 权限与记忆的项目身份映射回源仓库（§6.6.3）。
      expect(created.app.runtime.getProjectId()).toBe(projectIdFromDirectory(paths.source));

      await waitFor(async () => {
        const messages = await live.store.messages({ sessionID: sessionId as SessionId });
        return messages.some((message) => message.info.role === "user");
      });
      const stored = await live.store.getSession(sessionId as SessionId);
      expect(stored).toMatchObject({ directory: paths.worktree, path: paths.worktree });
      expect(stored?.workspaceID).toBeUndefined();
      const firstMessage = (await live.store.messages({ sessionID: sessionId as SessionId }))[0]!;
      expect(firstMessage.parts).toEqual([
        expect.objectContaining({
          type: "timeline",
          timelineType: "worktree_creation",
          worktreeCreation: {
            path: paths.worktree,
            sha: paths.sha,
            ref: null,
            output: WORKTREE_CREATION_OUTPUT,
          },
        }),
      ]);

      const liveKinds = rowKinds(await conversationSnapshot(live, sessionId));
      expect(liveKinds.indexOf("marker:worktreeCreated")).toBeGreaterThanOrEqual(0);
      expect(liveKinds.indexOf("marker:worktreeCreated")).toBeLessThan(
        liveKinds.indexOf("userInput"),
      );
      // live 记录按项目 key 进入项目的 sessions-index。
      expect(await sessionsIndexIds(live, paths.source)).toContain(sessionId);
    } finally {
      await live.close();
    }

    const cold = await bootServer(dbPath, paths.dataBaseDir);
    try {
      // 合并后激活预检也要认识受管 worktree，但普通目录不能借用项目 key 绕过归属校验。
      const wrongWorkspace = { workspaceKey: paths.source, workspacePath: paths.plain };
      const rejectedCold = await cold.server.handleMessage({
        id: "reject-foreign-cold-workspace",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: { sessionId, workspace: wrongWorkspace },
      });
      expect(rejectedCold).toHaveProperty("error");
      expect(cold.apps).toHaveLength(0);
      // 冷列表：目录扫描看不到 worktree 会话，Host 用 worktreeSessionIds 精确提供。
      expect(await sessionsIndexIds(cold, paths.source)).not.toContain(sessionId);
      expect(await sessionsIndexIds(cold, paths.source, [sessionId, "sess_foreign"])).toContain(
        sessionId,
      );
      const snapshot = await conversationSnapshot(cold, sessionId, {
        workspaceKey: paths.source,
        workspacePath: paths.source,
      });
      const kinds = rowKinds(snapshot);
      expect(kinds.filter((kind) => kind === "marker:worktreeCreated")).toHaveLength(1);
      expect(kinds.indexOf("marker:worktreeCreated")).toBeLessThan(kinds.indexOf("userInput"));
      const resumed = cold.apps.at(-1)!;
      // 冷恢复：身份取 Host 请求（项目），执行路径取存储 cwd（I2）。
      expect(resumed.options.runtimeConfig?.workingDirectory).toBe(paths.worktree);
      // Gen UI 目录按 [workspace 路径, sessionId] 计算；冷恢复后 workspace 路径仍是 worktree，
      // fork 时按目标 cwd 算出的目录才与子会话自己的一致（core session-fork 的 targetCwd 用例）。
      expect(resumed.options.runtimeConfig?.workspacePath).toBe(paths.worktree);
      expect(resumed.options.workspaceKey).toBe(paths.source);
      await requestResult(cold.server, {
        id: "ensure-active-from-project",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: {
          sessionId,
          workspace: { workspaceKey: paths.source, workspacePath: paths.source },
        },
      });
      const rejectedActive = await cold.server.handleMessage({
        id: "reject-foreign-active-workspace",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: { sessionId, workspace: wrongWorkspace },
      });
      expect(rejectedActive).toHaveProperty("error");
      expect(cold.apps).toHaveLength(1);
    } finally {
      await cold.close();
    }

    // worktree 删除后：归属以创建时持久化的 projectID 为准，Host 提供的 id 仍能列出（§3.12）。
    await rm(paths.worktree, { recursive: true, force: true });
    const afterRemoval = await bootServer(dbPath, paths.dataBaseDir);
    try {
      expect(await sessionsIndexIds(afterRemoval, paths.source, [sessionId])).toContain(sessionId);
    } finally {
      await afterRemoval.close();
    }
  });

  it("冷恢复归属：Host key 大小写与磁盘不同、worktree 已删除时仍属于项目", async () => {
    const dbPath = join(root, "ownership.db");
    const live = await bootServer(dbPath, paths.dataBaseDir);
    let sessionId = "";
    try {
      const ack = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("create-wt-ownership", "createSession", {
            workspaceId: paths.source,
            cwd: paths.worktree,
            firstInput: { text: "归属校验", modelSelection: MODEL },
          }),
        ),
      );
      if (ack.result?.type !== "createSession") throw new Error("Expected createSession result");
      sessionId = ack.result.sessionId;
      await waitFor(async () => {
        const messages = await live.store.messages({ sessionID: sessionId as SessionId });
        return messages.some((message) => message.info.role === "user");
      });
    } finally {
      await live.close();
    }

    // 用户添加项目时输入的大小写会原样成为 Host key；resolver 返回磁盘真实大小写（WT-36）。
    // 只在大小写不敏感的文件系统（macOS / Windows 默认）上有意义。
    const caseVariant = join(root, "projects", REPO.toUpperCase());
    const caseInsensitive = await realpath(caseVariant).then(
      () => true,
      () => false,
    );
    if (caseInsensitive) {
      const cold = await bootServer(dbPath, paths.dataBaseDir);
      try {
        const snapshot = await conversationSnapshot(cold, sessionId, {
          workspaceKey: caseVariant,
          workspacePath: caseVariant,
        });
        expect(rowKinds(snapshot)).toContain("userInput");
        expect(cold.apps.at(-1)?.options.runtimeConfig?.workingDirectory).toBe(paths.worktree);
      } finally {
        await cold.close();
      }
    }

    // worktree 删除后 resolver 无法校验 .git 链接，归属以创建时的 projectID 为准（WT-38）。
    await rm(paths.worktree, { recursive: true, force: true });
    const afterRemoval = await bootServer(dbPath, paths.dataBaseDir);
    try {
      const snapshot = await conversationSnapshot(afterRemoval, sessionId, {
        workspaceKey: paths.source,
        workspacePath: paths.source,
      });
      expect(rowKinds(snapshot)).toContain("userInput");
      // 普通目录仍不能借用项目 key 绕过归属校验。
      const rejected = await afterRemoval.server.handleMessage({
        id: "reject-foreign-after-removal",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: {
          sessionId,
          workspace: { workspaceKey: paths.source, workspacePath: paths.plain },
        },
      });
      expect(rejected).toHaveProperty("error");
    } finally {
      await afterRemoval.close();
    }
  });

  it("冷恢复归属：projectID 相同的另一个项目不能借用当前 key 恢复会话", async () => {
    // "my project" 与 "my-project" 的 projectID slug 相同，但不是同一个目录（MR !3520 review CR-01）。
    const spaced = join(root, "projects", "my project");
    const dashed = join(root, "projects", "my-project");
    await mkdir(spaced, { recursive: true });
    await mkdir(dashed, { recursive: true });
    expect(projectIdFromDirectory(spaced)).toBe(projectIdFromDirectory(dashed));
    const dbPath = join(root, "slug-collision.db");
    const live = await bootServer(dbPath, paths.dataBaseDir);
    let sessionId = "";
    try {
      const ack = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("create-spaced", "createSession", {
            workspaceId: spaced,
            firstInput: { text: "另一个项目", modelSelection: MODEL },
          }),
        ),
      );
      if (ack.result?.type !== "createSession") throw new Error("Expected createSession result");
      sessionId = ack.result.sessionId;
      await waitFor(async () => {
        const messages = await live.store.messages({ sessionID: sessionId as SessionId });
        return messages.some((message) => message.info.role === "user");
      });
    } finally {
      await live.close();
    }

    const cold = await bootServer(dbPath, paths.dataBaseDir);
    try {
      const rejected = await cold.server.handleMessage({
        id: "reject-slug-collision",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: { sessionId, workspace: { workspaceKey: dashed, workspacePath: dashed } },
      });
      expect(rejected).toHaveProperty("error");
      expect(cold.apps).toHaveLength(0);
    } finally {
      await cold.close();
    }
  });

  it("subscribe 之外的冷恢复入口（plans、改名）使用 Host 注入的项目 workspace", async () => {
    const dbPath = join(root, "query-resume.db");
    const live = await bootServer(dbPath, paths.dataBaseDir);
    let sessionId = "";
    try {
      const ack = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("create-wt-query", "createSession", {
            workspaceId: paths.source,
            cwd: paths.worktree,
            firstInput: { text: "计划目录冷恢复", modelSelection: MODEL },
          }),
        ),
      );
      if (ack.result?.type !== "createSession") throw new Error("Expected createSession result");
      sessionId = ack.result.sessionId;
      await waitFor(async () => {
        const messages = await live.store.messages({ sessionID: sessionId as SessionId });
        return messages.some((message) => message.info.role === "user");
      });
    } finally {
      await live.close();
    }

    const project = { workspaceKey: paths.source, workspacePath: paths.source };
    // runtime 卸载后先到的是计划目录查询，而不是 subscribe（WT-37）。
    const queried = await bootServer(dbPath, paths.dataBaseDir);
    try {
      await requestResult(queried.server, {
        id: "plans-cold",
        method: V4_METHODS.conversationPlans,
        params: { sessionId, workspace: project },
      });
      const resumed = queried.apps.at(-1)!;
      expect(resumed.options.workspaceKey).toBe(paths.source);
      expect(resumed.options.runtimeConfig?.workingDirectory).toBe(paths.worktree);
    } finally {
      await queried.close();
    }

    // 历史行改名经命令信封冷恢复，同样使用 Host 注入的身份。
    const renamed = await bootServer(dbPath, paths.dataBaseDir);
    try {
      const envelope = command(
        "rename-cold",
        "renameSession",
        { title: "改名后" },
        { sessionId },
      );
      const ack = commandAckSchema.parse(
        await requestResult(renamed.server, {
          ...envelope,
          params: { ...envelope.params, workspace: project },
        }),
      );
      expect(ack.status).toBe("accepted");
      expect(renamed.apps.at(-1)?.options.workspaceKey).toBe(paths.source);
    } finally {
      await renamed.close();
    }
  });

  it("createSession.cwd 指向普通目录：项目身份回退为 cwd；远程 workspace 结构化拒绝", async () => {
    const booted = await bootServer(join(root, "fallback.db"), paths.dataBaseDir);
    try {
      const ack = commandAckSchema.parse(
        await requestResult(
          booted.server,
          command("create-plain", "createSession", { workspaceId: paths.source, cwd: paths.plain }),
        ),
      );
      expect(ack.status).toBe("accepted");
      expect(booted.apps.at(-1)!.app.runtime.getProjectId()).toBe(
        projectIdFromDirectory(paths.plain),
      );

      const remote = commandAckSchema.parse(
        await requestResult(
          booted.server,
          command("create-remote", "createSession", {
            workspaceId: "remote:ssh:example.test:22:coder:/workspace/project",
            cwd: "/workspace/project-wt",
          }),
        ),
      );
      expect(remote.status).not.toBe("accepted");
    } finally {
      await booted.close();
    }
  });

  it("forkAssistant.targetCwd：child 在同一进程与 workspace 注册，cwd 为 worktree，追加标记，重试幂等", async () => {
    const dbPath = join(root, "fork.db");
    await seedParentSession(dbPath, paths.source);
    const booted = await bootServer(dbPath, paths.dataBaseDir);
    const childSessionId = "sess_worktree_fork_child";
    try {
      const parentId = PARENT_SESSION_ID;
      const snapshot = await conversationSnapshot(booted, parentId);
      const assistantRow = snapshot.rows.window.find(
        (row) => row.kind === "assistantText" && row.actions?.canFork,
      )!;
      const appsBeforeFork = booted.apps.length;
      const forkPayload = {
        target: { rowId: assistantRow.rowId, entityId: assistantRow.entityId },
        targetCwd: {
          cwd: paths.worktree,
          childSessionId,
          worktreeCreation: { path: paths.worktree, sha: paths.sha, ref: null, output: "" },
        },
      };
      const fork = (id: string) =>
        command(id, "forkAssistant", forkPayload, {
          sessionId: parentId,
          baseRevision: snapshot.revision,
          baseLogEpoch: snapshot.logEpoch,
        });
      const ack = commandAckSchema.parse(await requestResult(booted.server, fork("fork-1")));
      expect(ack).toMatchObject({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: childSessionId },
      });
      // 同一 workspace：child 在当前进程注册（不再交给另一个 CLI 进程冷恢复）。
      expect(booted.apps.length).toBe(appsBeforeFork + 1);
      const childApp = booted.apps.at(-1)!;
      expect(childApp.options.runtimeConfig?.workingDirectory).toBe(paths.worktree);
      expect(childApp.options.workspaceKey).toBe(paths.source);

      const child = await booted.store.getSession(childSessionId as SessionId);
      expect(child).toMatchObject({
        parentID: parentId,
        taskType: "fork",
        directory: paths.worktree,
        path: paths.worktree,
        projectID: projectIdFromDirectory(paths.source),
      });
      expect(child?.workspaceID).toBeUndefined();
      // core 的 fork 按 targetCwd.directory 计算子会话的 Gen UI 目录（键为 [workspace 路径, sessionId]），
      // 并写进子会话的环境更新；子会话 runtime 的 workspace 路径必须是同一个值，否则两边的目录不一致。
      expect(childApp.options.runtimeConfig?.workspacePath).toBe(paths.worktree);
      expect(childApp.options.runtimeConfig?.workspacePath).toBe(child?.path);

      const childKinds = rowKinds(await conversationSnapshot(booted, childSessionId));
      expect(childKinds).toContain("marker:forkNotice");
      expect(childKinds.indexOf("marker:worktreeCreated")).toBeGreaterThan(
        childKinds.indexOf("marker:forkNotice"),
      );

      const retry = commandAckSchema.parse(await requestResult(booted.server, fork("fork-2")));
      expect(["accepted", "duplicate"]).toContain(retry.status);
      expect(retry.result).toEqual({ type: "forkAssistant", sessionId: childSessionId });
      expect(await sessionsIndexIds(booted, paths.source)).toEqual(
        [parentId, childSessionId].sort(),
      );
    } finally {
      await booted.close();
    }
  });
});
