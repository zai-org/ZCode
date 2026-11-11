import { createHash } from "node:crypto";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
  type ForkCommitBundle,
  type SharedContextImportCommitBundle,
  type ModelId,
  type ModelProviderId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import {
  SqliteSessionMigrationError,
  createSqliteSessionStore,
  getDefaultSessionDbPath,
  openStartupSqliteSessionStore,
} from "../src/storage/index.js";
import {
  createStorageFsFaultInjector,
  resetStorageFsFaultInjectorForTests,
  setStorageFsFaultInjectorForTests,
} from "../src/storage/fs-fault-injection.js";

interface ConcurrentStartupResult {
  kind?: string;
  message?: string;
  migrationIds?: string[];
  ok: boolean;
}

const CONCURRENT_STARTUP_ATTEMPTS = 5;
// 五轮真实进程冷启动的加载时间已接近十秒，整组预算按轮数计算，避免把加载耗时误报为迁移失败。
const CONCURRENT_STARTUP_TEST_TIMEOUT_MS = CONCURRENT_STARTUP_ATTEMPTS * 10_000;

function openSessionStoreInConcurrentProcesses(dbPath: string): Promise<ConcurrentStartupResult[]> {
  const workerUrl = new URL("./fixtures/session-store-concurrent-process.ts", import.meta.url);
  const children = [0, 1].map(() =>
    fork(workerUrl, {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`startup child exited early: ${code}`)));
        child.on("message", (message: { type?: unknown }) => {
          if (message.type === "ready") resolve();
        });
      }),
  );
  const results = children.map(
    (child) =>
      new Promise<ConcurrentStartupResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`startup child exited early: ${code}`)));
        child.on("message", (message: { result?: ConcurrentStartupResult; type?: unknown }) => {
          if (message.type === "result" && message.result) resolve(message.result);
        });
      }),
  );

  return Promise.all(ready).then(() => {
    for (const child of children) child.send({ dbPath, type: "start" });
    return Promise.all(results);
  });
}

afterEach(() => {
  resetStorageFsFaultInjectorForTests();
});

describe("assistant block order at the read boundary", () => {
  async function seed(
    parts: Array<{ id: string; type: string; blockIndex?: number }>,
    dbPath = ":memory:",
  ) {
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("block-order-read");
    const messageID = createMessageId("block-order-assistant");
    await store.createSession({
      id: sessionID,
      projectID: createProjectId("block-order-read"),
      directory: "/workspace",
      slug: "block-order",
      title: "Block order",
      version: "test",
    });
    await store.saveMessage({
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1 },
      parentID: createMessageId("block-order-user"),
      modelId: "m" as ModelId,
      providerId: "p" as ModelProviderId,
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    for (const part of parts) {
      const base = { id: createPartId(part.id), sessionID, messageID };
      const blockIndex = part.blockIndex === undefined ? {} : { blockIndex: part.blockIndex };
      if (part.type === "step-start") {
        await store.savePart({ ...base, type: "step-start" });
      } else if (part.type === "tool") {
        await store.savePart({
          ...base,
          ...blockIndex,
          type: "tool",
          callID: part.id,
          tool: part.id,
          state: { status: "pending", input: {}, raw: "{}" },
        });
      } else {
        await store.savePart({ ...base, ...blockIndex, type: "text", text: part.id });
      }
    }
    const read = async () => ({
      all: (await store.messages({ sessionID }))[0]!.parts.map((part) => part.id),
      single: (await store.messageWithParts({ sessionID, messageID }))!.parts.map(
        (part) => part.id,
      ),
    });
    return { read, store };
  }

  it("sorts ordered assistant block parts and keeps other parts in place", async () => {
    const { read, store } = await seed([
      { id: "step", type: "step-start" },
      { id: "read-tool", type: "tool", blockIndex: 2 },
      { id: "first", type: "text", blockIndex: 0 },
      { id: "second", type: "text", blockIndex: 1 },
    ]);
    const expected = ["step", "first", "second", "read-tool"].map((id) => createPartId(id));
    expect(await read()).toEqual({ all: expected, single: expected });
    store.close();
  });

  it("keeps physical order when any block part lacks blockIndex", async () => {
    const { read, store } = await seed([
      { id: "read-tool", type: "tool", blockIndex: 2 },
      { id: "first", type: "text" },
      { id: "second", type: "text", blockIndex: 1 },
    ]);
    const expected = ["read-tool", "first", "second"].map((id) => createPartId(id));
    expect(await read()).toEqual({ all: expected, single: expected });
    store.close();
  });

  it.each(["$.state.input", "$.state"])(
    "reads a damaged tool part without %s instead of failing the whole session",
    async (missingPath) => {
      // 截图识别对每个 tool part 读 state.input.source。part data 没有 schema 校验，
      // 损坏数据缺字段时按普通 tool part 排序。savePart 写不出这种数据，所以直接改库。
      const root = await mkdtemp(join(tmpdir(), "zcode-block-order-damaged-"));
      const dbPath = join(root, "session.sqlite");
      const { read, store } = await seed(
        [
          { id: "damaged-tool", type: "tool", blockIndex: 1 },
          { id: "first", type: "text", blockIndex: 0 },
        ],
        dbPath,
      );
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE part SET data = json_remove(data, ?) WHERE id = ?").run(
        missingPath,
        createPartId("damaged-tool"),
      );
      db.close();
      const expected = ["first", "damaged-tool"].map((id) => createPartId(id));
      try {
        expect(await read()).toEqual({ all: expected, single: expected });
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("virtual project CLI session facts", () => {
  it("升级本分支旧 ID 时先执行上游迁移，保留正文、软删除与结果且不重跑", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-merge-old-id-"));
    const dbPath = join(root, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    const oldId = "0020_session_soft_delete_outcome";
    const own = SQLITE_MIGRATIONS.find(
      (migration) => migration.id === "0023_session_soft_delete_outcome",
    )!;
    db.exec(
      "CREATE TABLE schema_migration(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,app_version TEXT,time_applied INTEGER NOT NULL)",
    );
    for (const migration of [...SQLITE_MIGRATIONS.filter((item) => item.id < "0020"), own]) {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration VALUES(?,?,?,?)").run(
        migration === own ? oldId : migration.id,
        createHash("sha256").update(migration.sql.trim()).digest("hex"),
        migration.appVersion,
        123,
      );
    }
    const sessionID = createSessionId("merged-old-id");
    db.prepare(
      "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,time_deleted,last_outcome) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(sessionID, "project", "slug", root, "保留旧标题", "old", 10, 20, 30, "error");
    db.prepare(
      "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
    ).run(
      "old-message",
      sessionID,
      10,
      20,
      JSON.stringify({
        role: "user",
        agent: "main",
        time: { created: 10 },
        model: { providerID: "legacy-p", modelID: "legacy-m" },
      }),
      1,
    );
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    ).run(
      "old-part",
      "old-message",
      sessionID,
      10,
      20,
      JSON.stringify({ type: "text", text: "正文保留" }),
    );
    const oldSession = db.prepare("SELECT * FROM session").get();
    try {
      const store = await createSqliteSessionStore({ dbPath });
      try {
        expect(store.debugMigrationIds()).toEqual(
          expect.arrayContaining([
            oldId,
            "0020_provider_model_selection",
            "0021_official_glm_selection",
            "0022_backfilled_session_reasoning",
            own.id,
          ]),
        );
        expect(db.prepare("SELECT * FROM session").get()).toEqual(oldSession);
        expect(await store.listSessions()).toEqual([]);
        expect((await store.messages({ sessionID }))[0]).toMatchObject({
          info: { modelSelection: { providerId: "legacy-p", modelId: "legacy-m" } },
          parts: [expect.objectContaining({ text: "正文保留" })],
        });
        const old = db
          .prepare("SELECT checksum,app_version,time_applied FROM schema_migration WHERE id=?")
          .get(oldId);
        expect(
          db
            .prepare("SELECT checksum,app_version,time_applied FROM schema_migration WHERE id=?")
            .get(own.id),
        ).toEqual(old);
      } finally {
        store.close();
      }
      const before = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
      const reopened = await createSqliteSessionStore({ dbPath });
      reopened.close();
      expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM session").get()).toEqual(oldSession);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("soft-deletes idempotently, preserves transcript and excludes deleted sessions from every list", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const bundle = createSharedContextImportBundle({ sessionSlug: "soft-delete" });
    await store.commitSharedContextImportBundle?.(bundle);
    const before = store.debugCounts(bundle.session.id);
    await store.softDeleteSession(bundle.session.id, 2000);
    await store.softDeleteSession(bundle.session.id, 3000);
    expect((await store.getSession(bundle.session.id))?.time.deleted).toBe(2000);
    expect(await store.listSessions()).toEqual([]);
    expect(await store.messages({ sessionID: bundle.session.id })).toHaveLength(1);
    expect(store.debugCounts(bundle.session.id)).toEqual(before);
    await store.createSession(bundle.session);
    expect(await store.listSessions()).toEqual([]);
    store.close();
  });

  it("purges a session with its owned children but never a fork or an unrelated session", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const parent = createSharedContextImportBundle({ sessionSlug: "purge-parent", shareId: "s1" });
    await store.commitSharedContextImportBundle?.(parent);
    const child = createSessionId("purge-child");
    const grandchild = createSessionId("purge-grandchild");
    const fork = createSessionId("purge-fork");
    const unrelated = createSessionId("purge-unrelated");
    const base = { ...parent.session, title: "x", time: { created: 1, updated: 1 } };
    await store.createSession({ ...base, id: child, slug: "c", parentID: parent.session.id, taskType: "subagent_child" });
    await store.createSession({ ...base, id: grandchild, slug: "g", parentID: child, taskType: "workflow_child" });
    await store.createSession({ ...base, id: fork, slug: "f", parentID: parent.session.id, taskType: "fork" });
    await store.createSession({ ...base, id: unrelated, slug: "u" });

    const trees = await store.listOwnedSessionTrees?.([parent.session.id, unrelated]);
    expect(trees?.get(parent.session.id)?.sort()).toEqual([child, parent.session.id, grandchild].sort());
    expect(trees?.get(unrelated)).toEqual([unrelated]);

    await store.purgeSessions?.([parent.session.id]);
    expect(await store.getSession(parent.session.id)).toBeNull();
    expect(await store.getSession(child)).toBeNull();
    expect(await store.getSession(grandchild)).toBeNull();
    expect(await store.messages({ sessionID: parent.session.id })).toEqual([]);
    expect(store.debugCounts(parent.session.id)).toMatchObject({ messages: 0, parts: 0 });
    // fork 是独立的用户任务（可能属于别的项目），源会话删除后仍保留。
    expect(await store.getSession(fork)).not.toBeNull();
    expect(await store.getSession(unrelated)).not.toBeNull();
    // 已不存在的会话再次删除是空操作。
    await store.purgeSessions?.([parent.session.id]);
    expect((await store.listOwnedSessionTrees?.([parent.session.id]))?.get(parent.session.id)).toEqual([]);
    store.close();
  });

  it("lists the live sessions whose parts still point at another session's artifacts", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const source = createSharedContextImportBundle({ sessionSlug: "artifact-source", shareId: "s2" });
    await store.commitSharedContextImportBundle?.(source);
    const base = { ...source.session, title: "x", time: { created: 1, updated: 1 } };
    const fork = createSessionId("artifact-fork");
    const deletedFork = createSessionId("artifact-deleted-fork");
    const other = createSessionId("artifact-other");
    const refer = async (sessionID: SessionId, text: string) => {
      const messageID = createMessageId(`${sessionID}-m`);
      await store.saveMessage({
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "zcode-agent",
        model: { providerID: "p" as ModelProviderId, modelID: "m" as ModelId },
      });
      await store.savePart({ id: createPartId(`${sessionID}-p`), sessionID, messageID, type: "text", text, time: { start: 1, end: 1 } });
    };
    for (const id of [fork, deletedFork, other])
      await store.createSession({ ...base, id, slug: id, parentID: source.session.id, taskType: "fork" });
    const uri = `zcode-artifact://${source.session.id}/art_1`;
    await refer(fork, `image ${uri} and again ${uri}`);
    await refer(deletedFork, uri);
    await store.softDeleteSession(deletedFork);
    // 引用自身附件不算外部引用；没有引用的会话不出现在结果里。
    await refer(other, `zcode-artifact://${other}/own`);

    const referrers = await store.listArtifactReferrers?.([source.session.id, other]);
    expect(referrers?.get(source.session.id)).toEqual([fork]);
    expect(referrers?.has(other)).toBe(false);
    store.close();
  });

  it("round-trips the terminal outcome without changing activity on rename", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const bundle = createSharedContextImportBundle({ sessionSlug: "outcome", now: 1000 });
    await store.createSession(bundle.session);
    await store.updateSession({
      id: bundle.session.id,
      lastOutcome: "interrupted",
      timeUpdated: 2000,
    });
    await store.updateSession({
      id: bundle.session.id,
      title: "manual",
      titleSource: "custom",
    });
    expect(await store.getSession(bundle.session.id)).toMatchObject({
      title: "manual",
      titleSource: "custom",
      lastOutcome: "interrupted",
      time: { updated: 2000 },
    });
    expect(await store.listSessions()).toHaveLength(1);
    store.close();
  });

  it("does not overwrite concurrent title or outcome facts with a stale full-row update", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const bundle = createSharedContextImportBundle({ sessionSlug: "narrow-update" });
    await store.createSession(bundle.session);
    await Promise.all([
      store.updateSession({ id: bundle.session.id, title: "manual", titleSource: "custom" }),
      store.updateSession({ id: bundle.session.id, lastOutcome: "error", timeUpdated: 2000 }),
    ]);
    await store.updateSession({
      id: bundle.session.id,
      title: "late generated",
      titleSource: "generated",
      expectedTitleSources: ["first_input", "generated"],
    });
    expect(await store.getSession(bundle.session.id)).toMatchObject({
      title: "manual",
      titleSource: "custom",
      lastOutcome: "error",
      time: { updated: 2000 },
    });
    store.close();
  });
});

function createSharedContextImportBundle(params: {
  sessionSlug: string;
  shareId: string;
  provenanceId?: string;
  now?: number;
}): SharedContextImportCommitBundle {
  const sessionID = createSessionId(params.sessionSlug);
  const messageID = createMessageId(`${params.sessionSlug}-message`);
  const now = params.now ?? 1_000;
  return {
    session: {
      id: sessionID,
      projectID: createProjectId("shared-context-project"),
      slug: params.sessionSlug,
      directory: "/workspace/imported",
      path: "/workspace/imported",
      title: "Imported share",
      titleSource: "custom",
      permission: { mode: "build" },
      version: "3.9.0",
      time: { created: now, updated: now },
    },
    contextMessage: {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "zcode-agent",
        model: {
          providerID: "glm" as ModelProviderId,
          modelID: "glm-5" as ModelId,
        },
        synthetic: true,
        source: "shared_context",
        visibility: "model-only",
        semantics: {
          origin: "import",
          kind: "shared_context",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
      parts: [
        {
          id: createPartId(`${params.sessionSlug}-part`),
          sessionID,
          messageID,
          type: "text",
          text: "# Shared context",
          time: { start: now, end: now },
        },
      ],
    },
    provenance: {
      // provenance.id 必须以 sessionID 作命名空间，见 sqlite-session-store 的守卫。
      id: params.provenanceId ?? `v4_shared_context_import:${sessionID}:${params.shareId}`,
      sessionID,
      type: "v4/shared_context_import",
      time: { created: now, updated: now },
      data: { shareId: params.shareId },
    },
  };
}

describe("shared context import transaction", () => {
  it("atomically stores session, one model-only context message, and provenance", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const bundle = createSharedContextImportBundle({
      sessionSlug: "shared-context-import",
      shareId: "share-1",
    });
    const sessionID = bundle.session.id;

    await expect(store.commitSharedContextImportBundle?.(bundle)).resolves.toMatchObject({
      id: sessionID,
    });
    const messages = await store.messages({ sessionID });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.info).toMatchObject({
      visibility: "model-only",
      source: "shared_context",
    });
    expect(
      (await store.sessionEntries({ sessionID, type: "v4/shared_context_import" }))[0]?.data,
    ).toEqual({ shareId: "share-1" });
  });

  // Bug 回归：session_entry.id 是全库主键，且 saveSessionEntry 的 on conflict(id) 会
  // 改绑 session_id。旧 provenance id 只含 shareId，同一个 share 被导入到第二个
  // workspace（去重不命中）时会夺走第一个会话的条目，旧会话的 shared context 静默消失。
  it("keeps per-session entries when the same share is imported into two sessions", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const first = createSharedContextImportBundle({
      sessionSlug: "shared-context-import-a",
      shareId: "share-1",
    });
    const second = createSharedContextImportBundle({
      sessionSlug: "shared-context-import-b",
      shareId: "share-1",
      now: 2_000,
    });

    await store.commitSharedContextImportBundle?.(first);
    await store.commitSharedContextImportBundle?.(second);

    const firstEntries = await store.sessionEntries({
      sessionID: first.session.id,
      type: "v4/shared_context_import",
    });
    const secondEntries = await store.sessionEntries({
      sessionID: second.session.id,
      type: "v4/shared_context_import",
    });
    expect(firstEntries).toHaveLength(1);
    expect(secondEntries).toHaveLength(1);
    expect(firstEntries[0]?.id).not.toBe(secondEntries[0]?.id);
    expect(firstEntries[0]?.sessionID).toBe(first.session.id);
    expect(secondEntries[0]?.sessionID).toBe(second.session.id);
  });

  it("rejects a provenance id that is not namespaced by the session", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const bundle = createSharedContextImportBundle({
      sessionSlug: "shared-context-import-legacy",
      shareId: "share-1",
      provenanceId: "v4_shared_context_import:share-1",
    });

    await expect(store.commitSharedContextImportBundle?.(bundle)).rejects.toThrow(
      "Shared context import bundle identity is invalid",
    );
  });
});

describe("remote session path repair CAS", () => {
  it("only updates paths and preserves concurrently written session metadata", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionID = createSessionId("remote-path-cas");
    const workspaceID = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("remote-path-cas"),
        workspaceID,
        slug: "remote-path-cas",
        directory: workspaceID,
        path: workspaceID,
        title: "旧标题",
        permission: { mode: "build" },
        version: "3.4.2",
        time: { created: 1, updated: 2 },
      });
      await store.updateSession({
        id: sessionID,
        title: "并发新标题",
        permission: { mode: "yolo" },
        timeUpdated: 99,
      });

      const repaired = await store.repairRemoteSessionPaths!({
        sessionID,
        workspaceID,
        expectedDirectory: workspaceID,
        expectedPath: workspaceID,
        directory: "/home/dev/project",
        path: "/home/dev/project",
        timeUpdated: 2,
      });

      expect(repaired).toBe(true);
      await expect(store.getSession(sessionID)).resolves.toMatchObject({
        directory: "/home/dev/project",
        path: "/home/dev/project",
        title: "并发新标题",
        permission: { mode: "yolo" },
        time: { updated: 99 },
      });
    } finally {
      store.close();
    }
  });

  it("does not overwrite a path changed by a concurrent writer", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionID = createSessionId("remote-path-cas-miss");
    const workspaceID = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("remote-path-cas-miss"),
        workspaceID,
        slug: "remote-path-cas-miss",
        directory: "/home/dev/project/packages/core",
        path: "/home/dev/project/packages/core",
        title: "Concurrent path",
        version: "3.4.2",
        time: { created: 1, updated: 9 },
      });

      await expect(
        store.repairRemoteSessionPaths!({
          sessionID,
          workspaceID,
          expectedDirectory: workspaceID,
          expectedPath: workspaceID,
          directory: "/home/dev/project",
          path: "/home/dev/project",
          timeUpdated: 2,
        }),
      ).resolves.toBe(false);
      await expect(store.getSession(sessionID)).resolves.toMatchObject({
        directory: "/home/dev/project/packages/core",
        path: "/home/dev/project/packages/core",
        time: { updated: 9 },
      });
    } finally {
      store.close();
    }
  });
});

describe("SQLite session store", () => {
  it("updates persisted execution paths without changing identity or activity time", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionID = createSessionId("remote-path-repair");
    const workspaceID = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    try {
      const created = await store.createSession({
        id: sessionID,
        projectID: createProjectId("remote-path-repair"),
        workspaceID,
        slug: "remote-path-repair",
        directory: `/home/dev/project/${workspaceID}`,
        path: `/home/dev/project/${workspaceID}`,
        title: "remote path repair",
        version: "0.1.0",
        time: { created: 1, updated: 2 },
      });

      await store.updateSession({
        id: sessionID,
        directory: "/home/dev/project",
        path: "/home/dev/project",
        timeUpdated: created.time.updated,
      });

      await expect(store.getSession(sessionID)).resolves.toMatchObject({
        workspaceID,
        directory: "/home/dev/project",
        path: "/home/dev/project",
        time: created.time,
      });
    } finally {
      store.close();
    }
  });

  it("defaults the session database under the db directory", () => {
    expect(getDefaultSessionDbPath()).toBe(join(homedir(), ".zcode", "cli", "db", "db.sqlite"));
  });

  it("can inject sqlite open failures for startup/recovery cases", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-open-fault-"));
    const dbPath = join(tempRoot, "session.sqlite");
    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          code: "EACCES",
          id: "D04-session-db-open-eacces",
          maxMatches: 0,
          operations: ["sqliteOpen"],
          pathEndsWith: "/session.sqlite",
        },
      ]),
    );

    try {
      await expect(createSqliteSessionStore({ dbPath })).rejects.toThrow(
        SqliteSessionMigrationError,
      );
      try {
        await createSqliteSessionStore({ dbPath });
        throw new Error("expected injected sqlite open failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteSessionMigrationError);
        const migrationError = error as SqliteSessionMigrationError;
        expect(migrationError.kind).toBe("open_failed");
        expect(migrationError.dbPath).toBe(dbPath);
        expect(
          migrationError.cause as NodeJS.ErrnoException & {
            zcodeFsFaultId?: string;
          },
        ).toMatchObject({
          code: "EACCES",
          path: dbPath,
          syscall: "sqliteOpen",
          zcodeFsFaultId: "D04-session-db-open-eacces",
        });
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("can inject sqlite write failures before session history writes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-write-fault-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("sqlite-run-fault");

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("sqlite-run-fault"),
        slug: "sqlite-run-fault",
        directory: tempRoot,
        title: "sqlite run fault",
        version: "0.1.0",
      });
      setStorageFsFaultInjectorForTests(
        createStorageFsFaultInjector([
          {
            code: "ENOSPC",
            id: "D01-session-history-enospc",
            operations: ["sqliteRun"],
            pathEndsWith: "/session.sqlite",
          },
        ]),
      );

      await expect(
        store.saveMessage({
          id: createMessageId("blocked-user-message"),
          sessionID,
          role: "user",
          time: {
            created: 1_700_000_000_000,
          },
          agent: "zcode-agent",
          model: {
            providerID: "test-provider" as ModelProviderId,
            modelID: "test-model" as ModelId,
          },
        }),
      ).rejects.toMatchObject({
        code: "ENOSPC",
        path: dbPath,
        syscall: "sqliteRun",
        zcodeFsFaultId: "D01-session-history-enospc",
      });
      expect(store.debugCounts().messages).toBe(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps migration IDs and numeric prefixes unique and increasing", () => {
    // 分支合并曾把两个 0023 同时写入账本；完整 ID 不同不能放过编号冲突。
    const ids = SQLITE_MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{4}_[a-z0-9_]+$/);
    const numbers = ids.map((id) => Number(id.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((left, right) => left - right));
  });

  it("records ordered schema migrations and keeps reopening idempotent", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-migrations-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const expectedMigrations = [
      "0001_base_session_store",
      "0002_local_setting",
      "0003_backfill_permission_local_setting",
      "0004_session_target",
      "0005_session_target_accounting",
      "0006_input_history_attachments",
      "0007_workflow_script_runtime",
      "0008_workflow_definition_scope",
      "0009_session_title_metadata",
      "0010_usage_observability",
      "0011_session_target_summary_title",
      "0012_session_trace_id",
      "0013_session_target_active_run_accounting",
      "0014_message_part_sequence",
      "0015_message_part_sequence_backfill_and_guard",
      "0016_session_input_ledger",
      "0017_session_input_start_now_delivery",
      "0018_session_input_failed_status",
      "0019_dwf_journal",
      "0020_provider_model_selection",
      "0021_official_glm_selection",
      "0022_backfilled_session_reasoning",
      "0023_session_soft_delete_outcome",
      "0024_session_database_identity",
      "0025_session_permanent_deletion",
    ];

    try {
      const firstStore = await createSqliteSessionStore({ dbPath });
      expect(firstStore.debugMigrationIds()).toEqual(expectedMigrations);
      expect(firstStore.debugCounts().schemaMigrations).toBe(expectedMigrations.length);
      expect(firstStore.debugCounts().localSettings).toBe(0);
      firstStore.close();

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare("select app_version from schema_migration order by id")
        .all() as Array<{ app_version: string }>;
      expect(rows.map((row) => row.app_version)).toEqual([
        "0.2.0",
        "0.2.0",
        "0.2.0",
        "0.7.0",
        "0.7.0",
        "0.11.0",
        "0.13.0",
        "0.13.0",
        "0.14.0",
        "0.15.0",
        "0.15.0",
        "0.15.0",
        "0.15.0",
        "0.15.0",
        "0.15.2",
        "0.15.2",
        "0.15.2",
        "0.15.2",
        "0.16.5",
        "0.16.5",
        "0.16.5",
        "0.16.5",
        "0.16.9",
        "0.16.9",
        "0.17.1",
      ]);

      db.close();

      const secondStore = await createSqliteSessionStore({ dbPath });
      expect(secondStore.debugMigrationIds()).toEqual(expectedMigrations);
      expect(secondStore.debugCounts().schemaMigrations).toBe(expectedMigrations.length);
      expect(secondStore.debugCounts().localSettings).toBe(0);
      secondStore.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it(
    "allows two Agent processes to migrate the same new database concurrently",
    async () => {
      const attempts: ConcurrentStartupResult[][] = [];

      for (let attempt = 0; attempt < CONCURRENT_STARTUP_ATTEMPTS; attempt += 1) {
        const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-concurrent-startup-"));
        try {
          attempts.push(
            await openSessionStoreInConcurrentProcesses(join(tempRoot, "session.sqlite")),
          );
        } finally {
          await rm(tempRoot, { force: true, recursive: true });
        }
      }

      expect(attempts.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ok: true }),
          expect.objectContaining({ ok: true }),
        ]),
      );
      expect(attempts.flat().filter((result) => !result.ok)).toEqual([]);
      expect(attempts.flat().every((result) => result.migrationIds?.length === 25)).toBe(true);
    },
    CONCURRENT_STARTUP_TEST_TIMEOUT_MS,
  );

  it("returns a structured timeout when the startup database lock is not released", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-startup-lock-timeout-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const lockOwner = new DatabaseSync(dbPath);
    lockOwner.exec(`
      create table lock_probe (id integer primary key);
      begin exclusive;
      insert into lock_probe (id) values (1);
    `);

    try {
      await expect(
        openStartupSqliteSessionStore({ dbPath, startupLockTimeoutMs: 25 }),
      ).rejects.toThrow(SqliteSessionMigrationError);
      try {
        await openStartupSqliteSessionStore({ dbPath, startupLockTimeoutMs: 25 });
        throw new Error("expected SQLite startup lock timeout");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteSessionMigrationError);
        expect(error).toMatchObject({ dbPath, kind: "lock_timeout" });
      }
    } finally {
      lockOwner.exec("rollback");
      lockOwner.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("upgrades an 0017 database to durable failed inputs without losing its ledger", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-input-failed-upgrade-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const sessionID = createSessionId("failed-upgrade-session");

    try {
      const seedStore = await createSqliteSessionStore({ dbPath });
      await seedStore.createSession({
        id: sessionID,
        projectID: createProjectId("failed-upgrade-project"),
        slug: "failed-upgrade-session",
        directory: tempRoot,
        title: "failed upgrade session",
        version: "0.1.0",
      });
      await seedStore.saveSessionInput!({
        id: "queue_upgrade-input",
        sessionID,
        kind: "sendText",
        delivery: "startNow",
        payload: { text: "preserve me" },
      });
      seedStore.close();

      // 模拟用户停在 0017 的真实旧库：保留全部旧数据，只撤销 0018 记录并恢复旧 CHECK。
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        delete from schema_migration where id = '0018_session_input_failed_status';
        alter table session_input rename to session_input_after_0018;
        create table session_input (
          id text primary key,
          session_id text not null references session(id) on delete cascade,
          kind text not null,
          delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
          payload text not null,
          admitted_sequence integer not null,
          promoted_sequence integer,
          promoted_message_id text,
          status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
          status_reason text,
          time_created integer not null,
          time_updated integer not null
        );
        insert into session_input select * from session_input_after_0018;
        drop table session_input_after_0018;
        create index session_input_session_admitted_idx
          on session_input(session_id, admitted_sequence);
        create index session_input_session_status_idx
          on session_input(session_id, status);
      `);
      legacyDb.close();

      const upgradedStore = await createSqliteSessionStore({ dbPath });
      expect(upgradedStore.debugMigrationIds()).toContain("0018_session_input_failed_status");
      await expect(upgradedStore.listSessionInputs({ sessionID })).resolves.toMatchObject([
        {
          id: "queue_upgrade-input",
          delivery: "startNow",
          status: "admitted",
          payload: { text: "preserve me" },
        },
      ]);
      await upgradedStore.settleSessionInput!({
        id: "queue_upgrade-input",
        sessionID,
        status: "failed",
        reason: "fault.command.childStartFailed",
      });
      await expect(upgradedStore.listSessionInputs({ sessionID })).resolves.toMatchObject([
        {
          id: "queue_upgrade-input",
          status: "failed",
          statusReason: "fault.command.childStartFailed",
        },
      ]);
      upgradedStore.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("backfills legacy project permissions into local settings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-permission-migration-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const projectID = createProjectId("legacy-permission");
    const created = 1_700_000_000_000;
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      create table permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );
    `);
    legacyDb
      .prepare(
        "insert into permission (project_id, time_created, time_updated, data) values (?, ?, ?, ?)",
      )
      .run(
        projectID,
        created,
        created,
        JSON.stringify({
          version: 1,
          allow: [{ toolName: "Read" }],
        }),
      );
    legacyDb.close();

    try {
      const store = await createSqliteSessionStore({ dbPath });
      expect(await store.getProjectPermission(projectID)).toEqual({
        version: 1,
        allow: [{ toolName: "Read" }],
      });
      expect(store.debugCounts().permissions).toBe(1);
      expect(store.debugCounts().localSettings).toBe(1);
      store.close();

      const reopenedStore = await createSqliteSessionStore({ dbPath });
      expect(reopenedStore.debugCounts().localSettings).toBe(1);
      reopenedStore.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects edited migration SQL by checksum", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-migration-checksum-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      );
      insert into schema_migration (id, checksum, app_version, time_applied)
      values ('0001_base_session_store', 'not-the-current-checksum', '0.2.0', 1);
    `);
    db.close();

    try {
      await expect(createSqliteSessionStore({ dbPath })).rejects.toThrow(
        SqliteSessionMigrationError,
      );
      try {
        await createSqliteSessionStore({ dbPath });
        throw new Error("expected migration checksum mismatch");
      } catch (error) {
        expect(error).toBeInstanceOf(SqliteSessionMigrationError);
        const migrationError = error as SqliteSessionMigrationError;
        expect(migrationError.kind).toBe("checksum_mismatch");
        expect(migrationError.dbPath).toBe(dbPath);
        expect(migrationError.migrationId).toBe("0001_base_session_store");
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("exposes a startup gate opener for migrated session stores", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-startup-session-store-"));
    const dbPath = join(tempRoot, "session.sqlite");

    try {
      const store = await openStartupSqliteSessionStore({ dbPath });
      expect(store.debugMigrationIds()).toEqual([
        "0001_base_session_store",
        "0002_local_setting",
        "0003_backfill_permission_local_setting",
        "0004_session_target",
        "0005_session_target_accounting",
        "0006_input_history_attachments",
        "0007_workflow_script_runtime",
        "0008_workflow_definition_scope",
        "0009_session_title_metadata",
        "0010_usage_observability",
        "0011_session_target_summary_title",
        "0012_session_trace_id",
        "0013_session_target_active_run_accounting",
        "0014_message_part_sequence",
        "0015_message_part_sequence_backfill_and_guard",
        "0016_session_input_ledger",
        "0017_session_input_start_now_delivery",
        "0018_session_input_failed_status",
        "0019_dwf_journal",
        "0020_provider_model_selection",
        "0021_official_glm_selection",
        "0022_backfilled_session_reasoning",
        "0023_session_soft_delete_outcome",
        "0024_session_database_identity",
        "0025_session_permanent_deletion",
      ]);
      store.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists session task types and workflow runtime tables", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-session-task-type-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const workflowSessionId = createSessionId("workflow-child-session");
    const interactiveSessionId = createSessionId("interactive-session");
    const workflowTraceId = createTraceId();

    try {
      const store = await createSqliteSessionStore({ dbPath });
      await store.createSession({
        id: workflowSessionId,
        projectID: createProjectId("workflow-task-type"),
        slug: "workflow-child-session",
        directory: tempRoot,
        traceID: workflowTraceId,
        taskType: "workflow_child",
        title: "workflow child",
        version: "0.1.0",
      });
      await store.createSession({
        id: interactiveSessionId,
        projectID: createProjectId("workflow-task-type"),
        slug: "interactive-session",
        directory: tempRoot,
        title: "interactive",
        version: "0.1.0",
      });

      await expect(store.getSession(workflowSessionId)).resolves.toMatchObject({
        id: workflowSessionId,
        traceID: workflowTraceId,
        taskType: "workflow_child",
      });
      await expect(store.getSession(interactiveSessionId)).resolves.toMatchObject({
        id: interactiveSessionId,
        taskType: "interactive",
      });
      await expect(store.listSessions({ taskTypes: ["workflow_child"] })).resolves.toEqual([
        expect.objectContaining({
          id: workflowSessionId,
          taskType: "workflow_child",
        }),
      ]);
      const definition = await store.upsertScriptWorkflowDefinition({
        id: "script_test",
        meta: {
          description: "Test workflow persistence",
          name: "test-workflow",
          phases: [{ title: "Run" }],
        },
        name: "test-workflow",
        scope: "project",
        scriptHash: "hash-script",
        scriptPath: join(tempRoot, ".zcode", "workflows", "test.workflow.js"),
        source: "user",
      });
      expect(definition.scope).toBe("project");
      const run = await store.createScriptWorkflowRun({
        cwd: tempRoot,
        definitionId: definition.id,
        id: "workflow_test",
        name: "test-workflow",
        parentSessionId: interactiveSessionId,
        scriptHash: "hash-script",
        scriptPath: definition.scriptPath,
      });
      const activity = await store.createScriptWorkflowActivity({
        callIndex: 1,
        callPath: "root/agent0",
        id: "activity_test",
        inputHash: "hash-input",
        label: "run:test",
        phase: "Run",
        prompt: "Run a test agent.",
        runId: run.id,
        type: "agent",
      });
      await store.updateScriptWorkflowActivity({
        childSessionId: workflowSessionId,
        completedAt: Date.now(),
        id: activity.id,
        result: { value: "ok" },
        status: "completed",
      });
      await store.createSessionTaskLink({
        activityId: activity.id,
        childSessionId: workflowSessionId,
        id: "tasklink_test",
        parentSessionId: interactiveSessionId,
        path: activity.callPath,
        role: "workflow_agent",
        rootWorkflowRunId: run.id,
        status: "completed",
      });
      await store.appendScriptWorkflowEvent({
        id: "workflow_event_test",
        payload: { ok: true },
        runId: run.id,
        type: "activity_completed",
      });
      await expect(store.listScriptWorkflowActivities({ runId: run.id })).resolves.toEqual([
        expect.objectContaining({
          childSessionId: workflowSessionId,
          result: { value: "ok" },
          status: "completed",
        }),
      ]);
      await expect(store.listScriptWorkflowEvents({ runId: run.id })).resolves.toEqual([
        expect.objectContaining({ sequence: 1, type: "activity_completed" }),
      ]);
      store.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("overwrites the prompt snapshot row in place, including the cleared tombstone", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-prompt-snapshot-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const sessionID = createSessionId("prompt-snapshot-test");
    let store: Awaited<ReturnType<typeof createSqliteSessionStore>> | undefined;

    try {
      store = await createSqliteSessionStore({ dbPath });
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("prompt-snapshot-test"),
        slug: "prompt-snapshot-test",
        directory: tempRoot,
        title: "prompt snapshot",
        version: "0.1.0",
      });
      const updatedBefore = (await store.getSession(sessionID))!.time.updated;
      const save = (data: unknown, at: number) =>
        store!.saveSessionEntry({
          id: `${sessionID}:runtime-prompt-snapshot`,
          sessionID,
          type: SESSION_ENTRY_PROMPT_SNAPSHOT,
          touchSession: false,
          time: { created: at, updated: at },
          data,
        });
      const snapshot = {
        model: { providerId: "test", modelId: "model-a" },
        system: [{ role: "system", content: "prefix" }],
      };
      await save(snapshot, updatedBefore + 1_000);
      await expect(
        store.sessionEntries({ sessionID, type: SESSION_ENTRY_PROMPT_SNAPSHOT }),
      ).resolves.toEqual([expect.objectContaining({ data: snapshot })]);
      // 不改表：同一行覆盖成墓碑；写入不改变会话列表的排序时间。
      await save({ cleared: true }, updatedBefore + 2_000);
      await expect(
        store.sessionEntries({ sessionID, type: SESSION_ENTRY_PROMPT_SNAPSHOT }),
      ).resolves.toEqual([expect.objectContaining({ data: { cleared: true } })]);
      expect((await store.getSession(sessionID))?.time.updated).toBe(updatedBefore);
    } finally {
      store?.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists durable session entries by type", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-entries-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const sessionID = createSessionId("session-entry-test");
    let store: Awaited<ReturnType<typeof createSqliteSessionStore>> | undefined;

    try {
      store = await createSqliteSessionStore({ dbPath });
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("session-entry-test"),
        slug: "session-entry-test",
        directory: tempRoot,
        title: "session entries",
        version: "0.1.0",
      });
      const createdSession = await store.getSession(sessionID);
      expect(createdSession).not.toBeNull();
      const sessionCreatedTimestamp = createdSession!.time.updated;
      const defaultTouchTimestamp = sessionCreatedTimestamp + 1_000;
      const entryOnlyTimestamp = defaultTouchTimestamp + 1_000;

      await store.saveSessionEntry({
        id: "entry_later",
        sessionID,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: { created: defaultTouchTimestamp - 1, updated: defaultTouchTimestamp },
        data: { payload: { verificationId: "verify_later" } },
      });
      await store.saveSessionEntry({
        id: "entry_earlier",
        sessionID,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: { created: sessionCreatedTimestamp - 1, updated: sessionCreatedTimestamp },
        data: { payload: { verificationId: "verify_earlier" } },
      });
      const sessionAfterDefaultEntries = await store.getSession(sessionID);
      expect(sessionAfterDefaultEntries?.time.updated).toBe(defaultTouchTimestamp);

      await store.saveSessionEntry({
        id: "entry_model_selection",
        sessionID,
        type: SESSION_ENTRY_MODEL_SELECTION,
        time: { created: entryOnlyTimestamp - 1, updated: entryOnlyTimestamp },
        touchSession: false,
        data: {
          modelId: "zai/glm-main",
          options: { reasoningLevel: "max" },
          providerId: "zai",
        },
      });

      await expect(
        store.sessionEntries({
          sessionID,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        }),
      ).resolves.toMatchObject([
        {
          data: { payload: { verificationId: "verify_earlier" } },
          id: "entry_earlier",
          time: { created: sessionCreatedTimestamp - 1, updated: sessionCreatedTimestamp },
        },
        {
          data: { payload: { verificationId: "verify_later" } },
          id: "entry_later",
          time: { created: defaultTouchTimestamp - 1, updated: defaultTouchTimestamp },
        },
      ]);
      await expect(
        store.sessionEntries({
          sessionID,
          type: SESSION_ENTRY_MODEL_SELECTION,
        }),
      ).resolves.toMatchObject([
        {
          data: {
            modelId: "zai/glm-main",
            options: { reasoningLevel: "max" },
            providerId: "zai",
          },
          id: "entry_model_selection",
          time: { created: entryOnlyTimestamp - 1, updated: entryOnlyTimestamp },
        },
      ]);
      await expect(store.getSession(sessionID)).resolves.toMatchObject({
        time: { updated: defaultTouchTimestamp },
      });
    } finally {
      store?.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("atomically creates a fork child and idempotent command fact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-stable-fork-child-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("stable-fork-parent");
    const firstChildId = createSessionId("stable-fork-child-first");
    const duplicateChildId = createSessionId("stable-fork-child-duplicate");
    const store = await createSqliteSessionStore({ dbPath });
    const metadata = {
      parentSessionId: String(parentSessionId),
      sourceCommandId: "command-stable-fork",
      forkTarget: {
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: ["user-1", "assistant-1"],
        boundaryMessageId: "assistant-1",
      },
    };

    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("stable-fork-project"),
        slug: "stable-fork-parent",
        directory: tempRoot,
        title: "stable fork parent",
        version: "0.1.0",
      });
      const first = await store.createForkedSessionWithMetadata(
        {
          id: firstChildId,
          parentID: parentSessionId,
          projectID: createProjectId("stable-fork-project"),
          slug: "stable-fork-child-first",
          directory: tempRoot,
          title: "stable fork child",
          version: "0.1.0",
        },
        metadata,
      );
      const duplicate = await store.createForkedSessionWithMetadata(
        {
          id: duplicateChildId,
          parentID: parentSessionId,
          projectID: createProjectId("stable-fork-project"),
          slug: "stable-fork-child-duplicate",
          directory: tempRoot,
          title: "must not be created",
          version: "0.1.0",
        },
        metadata,
      );

      expect(first.id).toBe(firstChildId);
      expect(duplicate.id).toBe(firstChildId);
      await expect(store.getSession(duplicateChildId)).resolves.toBeNull();
      await expect(
        store.sessionEntries({
          sessionID: parentSessionId,
          type: "v4/command_fact",
        }),
      ).resolves.toMatchObject([
        {
          id: `v4_command_fact:child:${parentSessionId}:command-stable-fork`,
          data: {
            source: "child",
            ack: {
              commandId: "command-stable-fork",
              status: "accepted",
              result: { type: "forkAssistant", sessionId: firstChildId },
            },
            metadata,
          },
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts an empty before-input prefix for a first-turn compact edit", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-root-before-input-fork-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("root-before-input-parent");
    const childSessionId = createSessionId("root-before-input-child");
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("root-before-input-project"),
        slug: "root-before-input-parent",
        directory: tempRoot,
        title: "root before input parent",
        version: "0.1.0",
      });
      await expect(
        store.createForkedSessionWithMetadata(
          {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId("root-before-input-project"),
            slug: "root-before-input-child",
            directory: tempRoot,
            title: "root before input child",
            version: "0.1.0",
          },
          {
            parentSessionId: String(parentSessionId),
            sourceCommandId: "command-root-before-input",
            forkTarget: {
              productTurnId: "product-1",
              transcriptTurnId: "runtime-1",
              orderedMessageIds: [],
              boundaryMessageId: "user-1",
            },
          },
        ),
      ).resolves.toMatchObject({ id: childSessionId });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("commits fork child, copied transcript, admission and parent fact in one transaction", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-fork-bundle-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("bundle-parent");
    const childSessionId = createSessionId("bundle-child");
    const messageId = createMessageId("bundle-message");
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("bundle-project"),
        slug: "bundle-parent",
        directory: tempRoot,
        title: "bundle parent",
        version: "0.1.0",
      });
      const bundle: ForkCommitBundle = {
        child: {
          id: childSessionId,
          parentID: parentSessionId,
          projectID: createProjectId("bundle-project"),
          slug: "bundle-child",
          directory: tempRoot,
          title: "bundle child",
          version: "0.1.0",
        },
        messages: [
          {
            info: {
              id: messageId,
              sessionID: childSessionId,
              role: "user",
              agent: "build",
              model: { providerID: "test", modelID: "test" },
              system: [],
              tools: {},
              time: { created: 1 },
            },
            parts: [
              {
                id: createPartId("bundle-part"),
                sessionID: childSessionId,
                messageID: messageId,
                type: "text",
                text: "copied",
              },
            ],
          },
        ],
        goal: {
          source: {
            sessionID: childSessionId,
            targetID: "target-bundle-child",
            objective: "bundle goal",
            summaryTitle: null,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            time: { created: 1, updated: 1 },
          },
          status: "active",
        },
        entries: [
          {
            id: "bundle-verifier-entry",
            sessionID: childSessionId,
            type: "target_completion_verification",
            time: { created: 1, updated: 1 },
            data: {
              payload: {
                targetId: "target-bundle-child",
                status: "completed",
                verificationId: "verify-bundle-child",
              },
            },
          },
          {
            id: "bundle-model-selection-entry",
            sessionID: childSessionId,
            type: SESSION_ENTRY_MODEL_SELECTION,
            touchSession: false,
            time: { created: 1, updated: 1 },
            data: {
              modelId: "test",
              options: { reasoningLevel: "high" },
              providerId: "test",
            },
          },
        ],
        initialInput: {
          id: "queue_cmd-edit",
          sessionID: childSessionId,
          kind: "sendText",
          delivery: "startNow",
          payload: { text: "edited" },
        },
        commandFact: {
          parentSessionId: String(parentSessionId),
          sourceCommandId: "cmd-edit",
          ack: {
            commandId: "cmd-edit",
            status: "accepted",
            revisionAtDecision: 7,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: childSessionId,
            },
          },
          metadata: { source: "compact-edit" },
        },
      };
      await store.commitForkBundle!(bundle);

      const rawDatabase = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const raw = rawDatabase
          .prepare("select data from session_entry where id = ?")
          .get("bundle-model-selection-entry");
        expect(JSON.parse(String(raw?.data))).toEqual({
          modelSelection: {
            providerId: "test",
            modelId: "test",
            options: { reasoningLevel: "high" },
          },
        });
      } finally {
        rawDatabase.close();
      }

      const duplicateChildId = createSessionId("bundle-child-duplicate");
      const duplicate = await store.commitForkBundle!({
        ...bundle,
        child: { ...bundle.child, id: duplicateChildId },
        messages: [],
        initialInput: { ...bundle.initialInput, sessionID: duplicateChildId },
      });
      expect(duplicate.id).toBe(childSessionId);
      await expect(store.getSession(duplicateChildId)).resolves.toBeNull();

      await expect(store.getSession(childSessionId)).resolves.toMatchObject({
        id: childSessionId,
      });
      await expect(store.messages({ sessionID: childSessionId })).resolves.toHaveLength(1);
      await expect(store.readTarget({ sessionID: childSessionId })).resolves.toMatchObject({
        targetID: "target-bundle-child",
      });
      await expect(store.sessionEntries({ sessionID: childSessionId })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "bundle-verifier-entry" }),
          expect.objectContaining({
            id: "bundle-model-selection-entry",
            sessionID: childSessionId,
            type: SESSION_ENTRY_MODEL_SELECTION,
            data: {
              modelId: "test",
              options: { reasoningLevel: "high" },
              providerId: "test",
            },
          }),
        ]),
      );
      await expect(store.listSessionInputs({ sessionID: childSessionId })).resolves.toMatchObject([
        { id: "queue_cmd-edit", delivery: "startNow", status: "admitted" },
      ]);
      await store.settleSessionInput!({
        id: "queue_cmd-edit",
        sessionID: childSessionId,
        status: "failed",
        reason: "fault.command.childStartFailed",
      });
      await expect(store.listSessionInputs({ sessionID: childSessionId })).resolves.toMatchObject([
        {
          id: "queue_cmd-edit",
          status: "failed",
          statusReason: "fault.command.childStartFailed",
        },
      ]);
      await expect(
        store.sessionEntries({
          sessionID: parentSessionId,
          type: "v4/command_fact",
        }),
      ).resolves.toMatchObject([
        {
          data: {
            ack: {
              result: { type: "editUserQuery", sessionId: childSessionId },
            },
          },
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("commits selection_side_chat child fact while root session queries keep it hidden", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-selection-side-bundle-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("selection-side-parent");
    const childSessionId = createSessionId("selection-side-child");
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("selection-side-project"),
        slug: "selection-side-parent",
        directory: tempRoot,
        title: "selection side parent",
        version: "0.1.0",
      });
      await store.commitForkBundle!({
        child: {
          id: childSessionId,
          parentID: parentSessionId,
          projectID: createProjectId("selection-side-project"),
          slug: "selection-side-child",
          taskType: "selection_side_chat",
          directory: tempRoot,
          title: "Selection side chat",
          version: "0.1.0",
        },
        messages: [],
        entries: [],
        commandFact: {
          parentSessionId: String(parentSessionId),
          sourceCommandId: "cmd-selection-side",
          ack: {
            commandId: "cmd-selection-side",
            status: "accepted",
            revisionAtDecision: 0,
            result: {
              type: "createSelectionSideSession",
              sessionId: childSessionId,
            },
          },
          metadata: { source: "selection-side-chat" },
        },
      });

      await expect(store.getSession(childSessionId)).resolves.toMatchObject({
        parentID: parentSessionId,
        taskType: "selection_side_chat",
      });
      await expect(store.listSessions({ directory: tempRoot, roots: true })).resolves.toEqual([
        expect.objectContaining({ id: parentSessionId }),
      ]);
      await expect(
        store.listSessions({
          directory: tempRoot,
          taskTypes: ["selection_side_chat"],
        }),
      ).resolves.toEqual([expect.objectContaining({ id: childSessionId })]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("fault injection at every fork transaction stage rolls back child and all canonical facts", async () => {
    const stages = [
      "afterChild",
      "afterMessages",
      "afterGoal",
      "afterEntries",
      "afterInput",
      "afterCommandFact",
      "beforeCommit",
    ] as const;
    for (const stage of stages) {
      const tempRoot = await mkdtemp(join(tmpdir(), `zcode-fork-stage-${stage}-`));
      const dbPath = join(tempRoot, "session.sqlite");
      const parentSessionId = createSessionId(`fault-parent-${stage}`);
      const childSessionId = createSessionId(`fault-child-${stage}`);
      const messageId = createMessageId(`fault-message-${stage}`);
      const store = await createSqliteSessionStore({
        dbPath,
        forkCommitFaultAt: stage,
      } as never);
      try {
        await store.createSession({
          id: parentSessionId,
          projectID: createProjectId(`fault-project-${stage}`),
          slug: `fault-parent-${stage}`,
          directory: tempRoot,
          title: "fault parent",
          version: "0.1.0",
        });
        await expect(
          store.commitForkBundle!({
            child: {
              id: childSessionId,
              parentID: parentSessionId,
              projectID: createProjectId(`fault-project-${stage}`),
              slug: `fault-child-${stage}`,
              directory: tempRoot,
              title: "fault child",
              version: "0.1.0",
            },
            messages: [
              {
                info: {
                  id: messageId,
                  sessionID: childSessionId,
                  role: "user",
                  agent: "build",
                  model: { providerID: "test", modelID: "test" },
                  tools: {},
                  time: { created: 1 },
                },
                parts: [
                  {
                    id: createPartId(`fault-part-${stage}`),
                    sessionID: childSessionId,
                    messageID: messageId,
                    type: "text",
                    text: "copied",
                  },
                ],
              },
            ],
            goal: {
              source: {
                sessionID: childSessionId,
                targetID: `target-child-${stage}`,
                objective: "fault goal",
                summaryTitle: null,
                status: "active",
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                time: { created: 1, updated: 1 },
              },
              status: "active",
            },
            entries: [
              {
                id: `fault-entry-${stage}`,
                sessionID: childSessionId,
                type: "target_completion_verification",
                time: { created: 1, updated: 1 },
                data: { payload: { status: "completed" } },
              },
            ],
            initialInput: {
              id: `queue-fault-${stage}`,
              sessionID: childSessionId,
              kind: "sendText",
              delivery: "startNow",
              payload: { text: "edited" },
            },
            commandFact: {
              parentSessionId: String(parentSessionId),
              sourceCommandId: `cmd-fault-${stage}`,
              ack: {
                commandId: `cmd-fault-${stage}`,
                status: "accepted",
                revisionAtDecision: 1,
                result: { type: "forkAssistant", sessionId: childSessionId },
              },
              metadata: { stage },
            },
          }),
        ).rejects.toThrow(`injected fork commit fault: ${stage}`);
        await expect(store.getSession(childSessionId)).resolves.toBeNull();
        await expect(store.messages({ sessionID: childSessionId })).resolves.toEqual([]);
        await expect(store.readTarget({ sessionID: childSessionId })).resolves.toBeNull();
        await expect(store.sessionEntries({ sessionID: childSessionId })).resolves.toEqual([]);
        await expect(store.listSessionInputs({ sessionID: childSessionId })).resolves.toEqual([]);
        await expect(
          store.sessionEntries({
            sessionID: parentSessionId,
            type: "v4/command_fact",
          }),
        ).resolves.toEqual([]);
      } finally {
        store.close();
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("rejects a fork bundle whose child-local assistant parent still points at parent transcript", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-fork-parent-leak-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("parent-leak-parent");
    const childSessionId = createSessionId("parent-leak-child");
    const assistantId = createMessageId("parent-leak-assistant");
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("parent-leak-project"),
        slug: "parent-leak-parent",
        directory: tempRoot,
        title: "parent",
        version: "0.1.0",
      });
      await expect(
        store.commitForkBundle!({
          child: {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId("parent-leak-project"),
            slug: "parent-leak-child",
            directory: tempRoot,
            title: "child",
            version: "0.1.0",
          },
          messages: [
            {
              info: {
                id: assistantId,
                sessionID: childSessionId,
                role: "assistant",
                parentID: createMessageId("parent-only-user"),
                time: { created: 1, completed: 2 },
                modelID: "test" as ModelId,
                providerID: "test" as ModelProviderId,
                mode: "build",
                agent: "build",
                path: { cwd: tempRoot, root: tempRoot },
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              },
              parts: [],
            },
          ],
          entries: [],
          commandFact: {
            parentSessionId: String(parentSessionId),
            sourceCommandId: "cmd-parent-leak",
            ack: {
              commandId: "cmd-parent-leak",
              status: "accepted",
              revisionAtDecision: 1,
              result: { type: "forkAssistant", sessionId: childSessionId },
            },
            metadata: {},
          },
        }),
      ).rejects.toThrow(/assistant parent is not child-local/);
      await expect(store.getSession(childSessionId)).resolves.toBeNull();
      await expect(
        store.sessionEntries({
          sessionID: parentSessionId,
          type: "v4/command_fact",
        }),
      ).resolves.toEqual([]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("stable fork bundle commits without creating a child input admission", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-stable-bundle-no-input-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("stable-no-input-parent");
    const childSessionId = createSessionId("stable-no-input-child");
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("stable-no-input-project"),
        slug: "stable-no-input-parent",
        directory: tempRoot,
        title: "parent",
        version: "0.1.0",
      });
      await expect(
        store.commitForkBundle!({
          child: {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId("stable-no-input-project"),
            slug: "stable-no-input-child",
            directory: tempRoot,
            title: "child",
            version: "0.1.0",
          },
          messages: [],
          entries: [],
          commandFact: {
            parentSessionId: String(parentSessionId),
            sourceCommandId: "cmd-stable-no-input",
            ack: {
              commandId: "cmd-stable-no-input",
              status: "accepted",
              revisionAtDecision: 1,
              result: { type: "forkAssistant", sessionId: childSessionId },
            },
            metadata: { forkOrigin: { parentSessionId } },
          },
        }),
      ).resolves.toMatchObject({ id: childSessionId });
      await expect(store.listSessionInputs({ sessionID: childSessionId })).resolves.toEqual([]);
      await expect(
        store.sessionEntries({
          sessionID: parentSessionId,
          type: "v4/command_fact",
        }),
      ).resolves.toMatchObject([{ data: { ack: { result: { sessionId: childSessionId } } } }]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("first fork bundle rejects missing or invalid command result and rolls back", async () => {
    const invalidResults: unknown[] = [
      undefined,
      { type: "retryTurn", sessionId: "sess_invalid" },
      { type: "forkAssistant", sessionId: "" },
      { type: "forkAssistant", sessionId: "sess_other_child" },
      {
        type: "editUserQuery",
        disposition: "rewind",
        sessionId: "sess_invalid",
      },
    ];
    for (const [index, result] of invalidResults.entries()) {
      const tempRoot = await mkdtemp(join(tmpdir(), `zcode-fork-result-${index}-`));
      const dbPath = join(tempRoot, "session.sqlite");
      const parentSessionId = createSessionId(`result-parent-${index}`);
      const childSessionId = createSessionId(`result-child-${index}`);
      const store = await createSqliteSessionStore({ dbPath });
      try {
        await store.createSession({
          id: parentSessionId,
          projectID: createProjectId(`result-project-${index}`),
          slug: `result-parent-${index}`,
          directory: tempRoot,
          title: "parent",
          version: "0.1.0",
        });
        const bundle = {
          child: {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId(`result-project-${index}`),
            slug: `result-child-${index}`,
            directory: tempRoot,
            title: "child",
            version: "0.1.0",
          },
          messages: [],
          entries: [],
          commandFact: {
            parentSessionId: String(parentSessionId),
            sourceCommandId: `cmd-result-${index}`,
            ack: {
              commandId: `cmd-result-${index}`,
              status: "accepted",
              revisionAtDecision: 1,
              ...(result === undefined ? {} : { result }),
            },
            metadata: {},
          },
        } as unknown as ForkCommitBundle;
        await expect(store.commitForkBundle!(bundle)).rejects.toThrow(/command result/);
        await expect(store.getSession(childSessionId)).resolves.toBeNull();
        await expect(
          store.sessionEntries({
            sessionID: parentSessionId,
            type: "v4/command_fact",
          }),
        ).resolves.toEqual([]);
      } finally {
        store.close();
        await rm(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("rolls back fork child when command metadata persistence fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-stable-fork-rollback-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const parentSessionId = createSessionId("stable-fork-rollback-parent");
    const childSessionId = createSessionId("stable-fork-rollback-child");
    const store = await createSqliteSessionStore({ dbPath });

    try {
      await store.createSession({
        id: parentSessionId,
        projectID: createProjectId("stable-fork-rollback-project"),
        slug: "stable-fork-rollback-parent",
        directory: tempRoot,
        title: "stable fork rollback parent",
        version: "0.1.0",
      });
      await expect(
        store.createForkedSessionWithMetadata(
          {
            id: childSessionId,
            parentID: parentSessionId,
            projectID: createProjectId("stable-fork-rollback-project"),
            slug: "stable-fork-rollback-child",
            directory: tempRoot,
            title: "must roll back",
            version: "0.1.0",
          },
          {
            parentSessionId: String(parentSessionId),
            sourceCommandId: "command-stable-fork-rollback",
            forkTarget: {
              // BigInt 不能编码为 JSON，用于证明 session insert 与 fact insert 同事务回滚。
              productTurnId: 1n as unknown as string,
              transcriptTurnId: "runtime-1",
              orderedMessageIds: ["assistant-1"],
              boundaryMessageId: "assistant-1",
            },
          },
        ),
      ).rejects.toThrow();

      await expect(store.getSession(childSessionId)).resolves.toBeNull();
      await expect(
        store.sessionEntries({
          sessionID: parentSessionId,
          type: "v4/command_fact",
        }),
      ).resolves.toEqual([]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps persisted message order when message timestamps collide", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-store-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("same-ms-order");
    const userMessageID = createMessageId("user-same-ms");
    const assistantMessageID = createMessageId("000-assistant-same-ms");
    const firstPartID = createPartId("z-user-text");
    const secondPartID = createPartId("a-user-text");
    const created = 1_700_000_000_000;

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("same-ms-order"),
        slug: "same-ms-order",
        directory: tempRoot,
        title: "same ms order",
        version: "0.1.0",
        time: {
          created,
          updated: created,
        },
      });
      await store.saveMessage({
        id: userMessageID,
        sessionID,
        role: "user",
        time: {
          created,
        },
        agent: "zcode-agent",
        model: {
          providerID: "test-provider" as ModelProviderId,
          modelID: "test-model" as ModelId,
        },
      });
      await store.savePart({
        id: firstPartID,
        sessionID,
        messageID: userMessageID,
        type: "text",
        text: "first prompt",
        time: {
          start: created,
          end: created,
        },
      });
      await store.savePart({
        id: secondPartID,
        sessionID,
        messageID: userMessageID,
        type: "text",
        text: "second prompt",
        time: {
          start: created,
          end: created,
        },
      });
      await store.savePart({
        id: firstPartID,
        sessionID,
        messageID: userMessageID,
        type: "text",
        text: "first prompt updated",
        time: {
          start: created,
          end: created,
        },
      });
      await store.saveMessage({
        id: assistantMessageID,
        sessionID,
        role: "assistant",
        time: {
          created,
          completed: created,
        },
        parentID: userMessageID,
        modelID: "test-model" as ModelId,
        providerID: "test-provider" as ModelProviderId,
        mode: "build",
        agent: "zcode-agent",
        path: {
          cwd: tempRoot,
          root: tempRoot,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        finish: "stop",
      });
      await store.savePart({
        id: createPartId("assistant-text"),
        sessionID,
        messageID: assistantMessageID,
        type: "text",
        text: "first answer",
        time: {
          start: created,
          end: created,
        },
      });

      const messages = await store.messages({ sessionID });

      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"]);
      expect(messages.map((message) => message.parts[0]?.type)).toEqual(["text", "text"]);
      expect(messages[0]?.parts.map((part) => part.id)).toEqual([firstPartID, secondPartID]);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const messageRows = db
          .prepare("select id, sequence from message where session_id = ? order by sequence")
          .all(sessionID) as Array<{ id: string; sequence: number }>;
        const partRows = db
          .prepare("select id, sequence from part where message_id = ? order by sequence")
          .all(userMessageID) as Array<{ id: string; sequence: number }>;
        expect(messageRows).toEqual([
          { id: userMessageID, sequence: 0 },
          { id: assistantMessageID, sequence: 1 },
        ]);
        expect(partRows).toEqual([
          { id: firstPartID, sequence: 0 },
          { id: secondPartID, sequence: 1 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("reads one message without decoding unrelated session parts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-message-read-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("target-message-read");
    const targetMessageID = createMessageId("target-message");
    const unrelatedMessageID = createMessageId("unrelated-message");
    const targetPartID = createPartId("target-part");
    const unrelatedPartID = createPartId("unrelated-part");

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("target-message-read"),
        slug: "target-message-read",
        directory: tempRoot,
        title: "Target message read",
        version: "0.1.0",
      });
      for (const [messageID, text] of [
        [targetMessageID, "target"],
        [unrelatedMessageID, "unrelated"],
      ] as const) {
        await store.saveMessage({
          id: messageID,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "zcode-agent",
          model: {
            providerID: "test-provider" as ModelProviderId,
            modelID: "test-model" as ModelId,
          },
        });
        await store.savePart({
          id: messageID === targetMessageID ? targetPartID : unrelatedPartID,
          sessionID,
          messageID,
          type: "text",
          text,
        });
      }

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("update part set data = ? where id = ?").run("{", unrelatedPartID);
      } finally {
        db.close();
      }

      await expect(
        store.messageWithParts({ sessionID, messageID: targetMessageID }),
      ).resolves.toMatchObject({
        info: { id: targetMessageID },
        parts: [{ id: targetPartID, type: "text", text: "target" }],
      });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // 16-timeline-authority-plan P0 / null-seq-determinism：NULL sequence 历史行（迁移遗漏或
  // 旧版本二进制写入）被再保存时，旧 on-conflict 的 coalesce(existing, excluded) 会把它
  // 重排到队尾（excluded = max+1），造成时间线漂移。修复后同 scope 再保存原样保留 sequence。
  it("keeps a legacy NULL-sequence message in place when it is re-saved", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-null-seq-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("null-seq-resave");
    const created = 1_700_000_000_000;
    const messageIDs = [
      createMessageId("null-seq-1"),
      createMessageId("null-seq-2"),
      createMessageId("null-seq-3"),
    ] as const;

    const userMessage = (id: (typeof messageIDs)[number], createdAt: number) =>
      ({
        id,
        sessionID,
        role: "user",
        time: { created: createdAt },
        agent: "zcode-agent",
        model: {
          providerID: "test-provider" as ModelProviderId,
          modelID: "test-model" as ModelId,
        },
      }) as const;

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("null-seq-resave"),
        slug: "null-seq-resave",
        directory: tempRoot,
        title: "null seq resave",
        version: "0.1.0",
        time: { created, updated: created },
      });
      await store.saveMessage(userMessage(messageIDs[0], created));
      await store.saveMessage(userMessage(messageIDs[1], created + 1));
      await store.saveMessage(userMessage(messageIDs[2], created + 2));

      // 模拟迁移遗漏/旧二进制写入：前两条失去 sequence（AFTER INSERT 触发器不拦 UPDATE）。
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("update message set sequence = null where id = ?").run(messageIDs[0]);
        db.prepare("update message set sequence = null where id = ?").run(messageIDs[1]);
      } finally {
        db.close();
      }

      // 读序基线：非空 sequence 在前，NULL 块按 time_created 兜底。
      const before = await store.messages({ sessionID });
      expect(before.map((message) => message.info.id)).toEqual([
        messageIDs[2],
        messageIDs[0],
        messageIDs[1],
      ]);

      // 再保存较晚的 NULL 行：旧实现会给它 max+1=3，使其越过 messageIDs[0]（漂移）。
      await store.saveMessage(userMessage(messageIDs[1], created + 1));

      const after = await store.messages({ sessionID });
      expect(after.map((message) => message.info.id)).toEqual([
        messageIDs[2],
        messageIDs[0],
        messageIDs[1],
      ]);

      const verify = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = verify
          .prepare("select sequence from message where id = ?")
          .get(messageIDs[1]) as { sequence: number | null };
        expect(row.sequence).toBeNull();
      } finally {
        verify.close();
      }
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // 16-timeline-authority-plan P0：0015 增量 backfill 只补 NULL 行且从各 scope 现有
  // max(sequence)+1 起编号——backfill 前后读序不变；0014 的全量 row_number 写法在混排
  // 数据下会撞号，不能复用。触发器兜底旧二进制的 NULL 写入。
  it("backfills NULL sequences after existing rows and guards new inserts (0015)", async () => {
    const { SQLITE_MIGRATIONS } = await import("../src/storage/session-store/migrations.js");
    const guardIndex = SQLITE_MIGRATIONS.findIndex(
      (migration) => migration.id === "0015_message_part_sequence_backfill_and_guard",
    );
    expect(guardIndex).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of SQLITE_MIGRATIONS.slice(0, guardIndex)) {
        db.exec(migration.sql);
      }
      const created = 1_700_000_000_000;
      db.prepare(
        `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
           values ('sess-1', 'proj-1', 'slug', '/tmp', 'title', '0.1.0', ?, ?)`,
      ).run(created, created);
      const insertMessage = db.prepare(
        `insert into message (id, session_id, time_created, time_updated, data, sequence)
         values (?, 'sess-1', ?, ?, '{}', ?)`,
      );
      insertMessage.run("m-seq-0", created, created, 0);
      insertMessage.run("m-seq-1", created + 1, created + 1, 1);
      // 两条 legacy NULL 行，time_created 交错在非空行之前——读序上它们仍排在非空行之后。
      insertMessage.run("m-null-early", created - 10, created - 10, null);
      insertMessage.run("m-null-late", created - 5, created - 5, null);

      const insertPart = db.prepare(
        `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
         values (?, 'm-seq-0', 'sess-1', ?, ?, '{}', ?)`,
      );
      insertPart.run("p-seq-0", created, created, 0);
      insertPart.run("p-null", created - 1, created - 1, null);

      db.exec(SQLITE_MIGRATIONS[guardIndex]!.sql);

      const messageRows = db
        .prepare(
          "select id, sequence from message where session_id = 'sess-1' order by sequence is null, sequence, time_created, rowid",
        )
        .all() as Array<{ id: string; sequence: number | null }>;
      expect(messageRows).toEqual([
        { id: "m-seq-0", sequence: 0 },
        { id: "m-seq-1", sequence: 1 },
        { id: "m-null-early", sequence: 2 },
        { id: "m-null-late", sequence: 3 },
      ]);

      const partRows = db
        .prepare("select id, sequence from part where message_id = 'm-seq-0' order by sequence")
        .all() as Array<{ id: string; sequence: number | null }>;
      expect(partRows).toEqual([
        { id: "p-seq-0", sequence: 0 },
        { id: "p-null", sequence: 1 },
      ]);

      // 触发器兜底：旧二进制的 INSERT 不含 sequence 列 → 自动补当前 scope 队尾。
      db.prepare(
        `insert into message (id, session_id, time_created, time_updated, data)
           values ('m-legacy-writer', 'sess-1', ?, ?, '{}')`,
      ).run(created + 100, created + 100);
      const guarded = db
        .prepare("select sequence from message where id = 'm-legacy-writer'")
        .get() as { sequence: number | null };
      expect(guarded.sequence).toBe(4);

      db.prepare(
        `insert into part (id, message_id, session_id, time_created, time_updated, data)
           values ('p-legacy-writer', 'm-seq-0', 'sess-1', ?, ?, '{}')`,
      ).run(created + 100, created + 100);
      const guardedPart = db
        .prepare("select sequence from part where id = 'p-legacy-writer'")
        .get() as { sequence: number | null };
      expect(guardedPart.sequence).toBe(2);
    } finally {
      db.close();
    }
  });

  it("replaces and reads session todos in stable position order", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-todos-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const sessionID = createSessionId("todo-order");
    const created = 1_700_000_000_000;

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("todo-order"),
        slug: "todo-order",
        directory: tempRoot,
        title: "todo order",
        version: "0.1.0",
        time: {
          created,
          updated: created,
        },
      });

      await store.updateTodos({
        sessionID,
        todos: [
          {
            content: "Inspect session spec",
            priority: "high",
            status: "completed",
          },
          {
            content: "Implement todo store",
            priority: "medium",
            status: "in_progress",
          },
        ],
      });
      await store.updateTodos({
        sessionID,
        todos: [
          {
            content: "Write tests",
            priority: "high",
            status: "pending",
          },
        ],
      });

      expect(await store.readTodos({ sessionID })).toEqual([
        {
          content: "Write tests",
          priority: "high",
          status: "pending",
        },
      ]);
      expect(store.debugCounts(sessionID).todos).toBe(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists the current session goal with replacement and status updates", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-target-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const sessionID = createSessionId("target-store");
    const created = 1_700_000_000_000;

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("target-store"),
        slug: "target-store",
        directory: tempRoot,
        title: "target store",
        version: "0.1.0",
        time: {
          created,
          updated: created,
        },
      });

      expect(await store.readTarget({ sessionID })).toBeNull();

      const first = await store.createTarget({
        objective: "Ship target MVP",
        sessionID,
      });
      expect(first).toMatchObject({
        objective: "Ship target MVP",
        sessionID,
        status: "active",
        summaryTitle: null,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      });
      expect(await store.createTarget({ objective: "Second target", sessionID })).toBeNull();

      const accounted = await store.accountTargetUsage({
        sessionID,
        targetID: first?.targetID ?? "missing",
        timeUsedSecondsDelta: 3,
        tokensUsedDelta: 42,
      });
      expect(accounted).toMatchObject({
        status: "active",
        tokensUsed: 42,
        timeUsedSeconds: 3,
      });

      const budgeted = await store.setTarget({
        objective: "Budget target",
        sessionID,
        tokenBudget: 50,
      });
      const budgetLimited = await store.accountTargetUsage({
        sessionID,
        targetID: budgeted.targetID,
        tokensUsedDelta: 50,
      });
      expect(budgetLimited).toMatchObject({
        status: "budget_limited",
        tokenBudget: 50,
        tokensUsed: 50,
      });

      const running = await store.setTarget({
        objective: "Timed target",
        sessionID,
      });
      const started = await store.startTargetRun({
        inputID: "input-1",
        sessionID,
        startedAtMs: 1_000,
        targetID: running.targetID,
      });
      expect(started).toMatchObject({
        activeInputId: "input-1",
        activeRunLastSeenAtMs: 1_000,
        activeRunStartedAtMs: 1_000,
        timeUsedSeconds: 0,
      });
      const heartbeat = await store.heartbeatTargetRun({
        inputID: "input-1",
        seenAtMs: 2_600,
        sessionID,
        targetID: running.targetID,
      });
      expect(heartbeat).toMatchObject({
        activeInputId: "input-1",
        activeRunLastSeenAtMs: 2_600,
      });
      const finished = await store.finishTargetRun({
        endedAtMs: 3_101,
        inputID: "input-1",
        sessionID,
        targetID: running.targetID,
        tokensUsedDelta: 7,
      });
      expect(finished).toMatchObject({
        activeInputId: null,
        activeRunLastSeenAtMs: null,
        activeRunStartedAtMs: null,
        status: "active",
        timeUsedSeconds: 3,
        tokensUsed: 7,
      });
      const duplicateFinish = await store.finishTargetRun({
        endedAtMs: 9_999,
        inputID: "input-1",
        sessionID,
        targetID: running.targetID,
        tokensUsedDelta: 99,
      });
      expect(duplicateFinish).toMatchObject({
        timeUsedSeconds: 3,
        tokensUsed: 7,
      });

      const interrupted = await store.setTarget({
        objective: "Interrupted target",
        sessionID,
      });
      await store.startTargetRun({
        inputID: "input-crash",
        sessionID,
        startedAtMs: 1_000,
        targetID: interrupted.targetID,
      });
      await store.heartbeatTargetRun({
        inputID: "input-crash",
        seenAtMs: 11_200,
        sessionID,
        targetID: interrupted.targetID,
      });
      const recovered = await store.recoverInterruptedTargetRun({ sessionID });
      expect(recovered).toMatchObject({
        activeInputId: null,
        activeRunLastSeenAtMs: null,
        activeRunStartedAtMs: null,
        status: "paused",
        timeUsedSeconds: 11,
      });

      const forkSourceBase = await store.setTarget({
        objective: "Fork target state",
        sessionID,
      });
      await store.accountTargetUsage({
        sessionID,
        targetID: forkSourceBase.targetID,
        timeUsedSecondsDelta: 5,
        tokensUsedDelta: 77,
      });
      await store.startTargetRun({
        inputID: "input-fork-source",
        sessionID,
        startedAtMs: 20_000,
        targetID: forkSourceBase.targetID,
      });
      const forkSource = await store.readTarget({ sessionID });
      const forkedSessionID = createSessionId("target-store-fork");
      await store.createSession({
        id: forkedSessionID,
        parentID: sessionID,
        projectID: createProjectId("target-store"),
        slug: "target-store-fork",
        directory: tempRoot,
        title: "target store fork",
        version: "0.1.0",
        time: {
          created,
          updated: created,
        },
      });
      const forkedTarget = await store.cloneTargetForFork({
        sessionID: forkedSessionID,
        source: forkSource!,
        status: "active",
      });
      expect(forkedTarget).toMatchObject({
        activeInputId: null,
        activeRunLastSeenAtMs: null,
        activeRunStartedAtMs: null,
        objective: "Fork target state",
        sessionID: forkedSessionID,
        status: "active",
        targetID: forkSourceBase.targetID,
        timeUsedSeconds: 5,
        tokensUsed: 77,
      });

      const pausedSource = await store.setTarget({
        objective: "Ship target MVP",
        sessionID,
      });
      const paused = await store.updateTargetStatus({
        sessionID,
        status: "paused",
      });
      expect(paused).toMatchObject({
        objective: "Ship target MVP",
        status: "paused",
        targetID: pausedSource.targetID,
      });
      const titled = await store.updateTargetSummaryTitle({
        sessionID,
        summaryTitle: "Ship Target MVP",
        targetID: pausedSource.targetID,
      });
      expect(titled).toMatchObject({
        objective: "Ship target MVP",
        summaryTitle: "Ship Target MVP",
        targetID: pausedSource.targetID,
      });
      await expect(
        store.updateTargetSummaryTitle({
          sessionID,
          summaryTitle: "Stale Title",
          targetID: "stale-target",
        }),
      ).resolves.toMatchObject({
        summaryTitle: "Ship Target MVP",
        targetID: pausedSource.targetID,
      });

      const replacement = await store.setTarget({
        objective: "Replace target",
        sessionID,
      });
      expect(replacement.objective).toBe("Replace target");
      expect(replacement.status).toBe("active");
      expect(replacement.summaryTitle).toBeNull();
      expect(replacement.targetID).not.toBe(first?.targetID);

      expect(store.debugCounts(sessionID).targets).toBe(1);
      expect(await store.clearTarget({ sessionID })).toBe(true);
      expect(await store.readTarget({ sessionID })).toBeNull();
      expect(await store.clearTarget({ sessionID })).toBe(false);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists project permission rulesets", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-permission-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const projectID = createProjectId("permission-rules");

    try {
      expect(await store.getProjectPermission(projectID)).toBeNull();

      await store.saveProjectPermission({
        projectID,
        permission: {
          version: 1,
          allow: [
            { toolName: "Bash", ruleContent: "npm run:*" },
            { toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME },
          ],
        },
      });

      expect(await store.getProjectPermission(projectID)).toEqual({
        version: 1,
        allow: [
          { toolName: "Bash", ruleContent: "npm run:*" },
          { toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME },
        ],
      });
      expect(store.debugCounts().permissions).toBe(0);
      expect(store.debugCounts().localSettings).toBe(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("reopens Bash prefix and exact rules without migrating their JSON shape", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bash-permission-reopen-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const projectID = createProjectId("bash-permission-reopen");
    const permission = {
      version: 1 as const,
      allow: [
        { toolName: "Bash", ruleContent: "pnpm run lint:*" },
        { toolName: "Bash", ruleContent: "rm -rf ./generated" },
      ],
    };

    const firstStore = await createSqliteSessionStore({ dbPath });
    try {
      await firstStore.saveProjectPermission({ projectID, permission });
      firstStore.close();

      const reopenedStore = await createSqliteSessionStore({ dbPath });
      try {
        expect(await reopenedStore.getProjectPermission(projectID)).toEqual(permission);
        expect(reopenedStore.debugCounts().localSettings).toBe(1);
        expect(reopenedStore.debugCounts().permissions).toBe(0);
      } finally {
        reopenedStore.close();
      }
    } finally {
      try {
        firstStore.close();
      } catch {
        // 测试清理允许重复 close；业务路径只关闭一次。
      }
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists the typed project mode local setting", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-local-setting-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const projectID = createProjectId("local-setting-project");

    try {
      expect(await store.getProjectPermissionMode(projectID)).toBeNull();
      await store.saveProjectPermissionMode({ mode: "yolo", projectID });

      expect(await store.getProjectPermissionMode(projectID)).toBe("yolo");
      expect(store.debugCounts().localSettings).toBe(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists edit project permission mode", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-local-setting-edit-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const projectID = createProjectId("local-setting-edit-project");

    try {
      await store.saveProjectPermissionMode({ mode: "edit", projectID });

      expect(await store.getProjectPermissionMode(projectID)).toBe("edit");
      expect(store.debugCounts().localSettings).toBe(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("records project input history with global retention and duplicate suppression", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-input-history-"));
    const store = await createSqliteSessionStore({
      dbPath: join(tempRoot, "session.sqlite"),
    });
    const projectID = createProjectId("input-history");
    const otherProjectID = createProjectId("input-history-other");
    const sessionID = createSessionId("input-history");

    try {
      expect(
        await store.recordInputHistory({
          kind: "prompt",
          projectID,
          sessionID,
          text: "   ",
        }),
      ).toBeNull();

      const first = await store.recordInputHistory({
        kind: "prompt",
        projectID,
        sessionID,
        text: " first prompt ",
        time: { created: 1 },
      });

      expect(first?.text).toBe("first prompt");
      expect(
        await store.recordInputHistory({
          kind: "prompt",
          projectID,
          sessionID,
          text: "first prompt",
          time: { created: 2 },
        }),
      ).toBeNull();
      expect(await store.recallPreviousInputHistory({ projectID })).toMatchObject({
        kind: "prompt",
        projectID,
        sessionID,
        text: "first prompt",
      });

      const withAttachment = await store.recordInputHistory({
        attachments: [
          {
            content: "data:image/png;base64,aW1hZ2U=",
            path: "[image #1]",
            type: "image",
          },
        ],
        kind: "prompt",
        projectID,
        sessionID,
        text: "first prompt",
        time: { created: 3 },
      });

      expect(withAttachment).toMatchObject({
        attachments: [
          {
            path: "[image #1]",
            type: "image",
          },
        ],
        text: "first prompt",
      });
      expect(withAttachment?.attachments?.[0]?.content).toBeUndefined();
      const recalledAttachment = await store.recallPreviousInputHistory({
        projectID,
      });
      expect(recalledAttachment).toMatchObject({
        attachments: [
          {
            path: "[image #1]",
            type: "image",
          },
        ],
        text: "first prompt",
      });
      expect(recalledAttachment?.attachments?.[0]?.content).toBeUndefined();

      for (let index = 0; index < 105; index += 1) {
        await store.recordInputHistory({
          kind: index % 2 === 0 ? "prompt" : "steered_input",
          projectID: index % 2 === 0 ? projectID : otherProjectID,
          text: `prompt ${index}`,
          time: { created: 10 + index },
        });
      }

      expect(store.debugCounts().inputHistory).toBe(100);
      expect(await store.recallPreviousInputHistory({ projectID })).toMatchObject({
        text: "prompt 104",
      });
      expect(await store.recallPreviousInputHistory({ projectID: otherProjectID })).toMatchObject({
        text: "prompt 103",
      });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("retains historical model, turn, and tool usage after writes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-observability-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("usage-observability");
    const turnID = createTurnId("usage-turn");
    const traceID = createTraceId();
    const messageID = createMessageId("usage-assistant");
    const toolCallID = createToolCallId("usage-tool");
    const oldTime = 1_700_000_000_000;
    const now = Date.now();

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("usage-observability"),
        slug: "usage-observability",
        directory: tempRoot,
        title: "usage observability",
        version: "0.1.0",
      });

      await store.recordModelUsage({
        assistantMessageID: messageID,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 30,
        completedAt: now + 1200,
        durationMs: 1200,
        finishReason: "stop",
        id: "usage_model_recent",
        inputTokens: 44,
        logicalRequestId: "logical-recent",
        modelId: "test-model",
        outputTokens: 2,
        providerId: "test-provider",
        querySource: "main_turn",
        rawUsage: { inputTokens: 44 },
        reasoningLevel: "high",
        sessionID,
        startedAt: now,
        status: "completed",
        traceID,
        turnID,
      });
      await store.recordModelUsage({
        id: "usage_model_old",
        logicalRequestId: "logical-old",
        modelId: "old-model",
        providerId: "test-provider",
        querySource: "compact",
        sessionID,
        startedAt: oldTime,
        status: "completed",
      });
      await store.upsertTurnUsage({
        cacheReadInputTokens: 30,
        completedAt: now + 2000,
        computedTotalTokens: 46,
        durationMs: 2000,
        inputTokens: 44,
        modelRequestCount: 1,
        outputTokens: 2,
        sessionID,
        startedAt: now,
        status: "completed",
        toolCallCount: 1,
        traceID,
        turnID,
      });
      await store.upsertToolUsage({
        completedAt: now + 200,
        durationMs: 200,
        id: "usage_tool_recent",
        outputBytes: 12,
        sessionID,
        startedAt: now,
        status: "completed",
        toolCallID,
        toolName: "Read",
        traceID,
        turnID,
      });
      await store.upsertToolUsage({
        id: "usage_tool_old",
        sessionID,
        startedAt: oldTime,
        status: "completed",
        toolCallID: createToolCallId("old-tool"),
        toolName: "Read",
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID: createTurnId("usage-turn-old"),
        startedAt: oldTime,
        status: "completed",
      });

      expect(store.debugCounts(sessionID)).toMatchObject({
        modelUsage: 2,
        toolUsage: 2,
        turnUsage: 2,
      });

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const modelRow = db
          .prepare("select * from model_usage where id = ?")
          .get("usage_model_recent") as {
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          computed_total_tokens: number;
          input_tokens: number;
          output_tokens: number;
          variant: string | null;
        };
        expect(modelRow).toMatchObject({
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 30,
          computed_total_tokens: 46,
          input_tokens: 44,
          output_tokens: 2,
          variant: "high",
        });
      } finally {
        db.close();
      }
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("maps the domain reasoning level to the legacy model usage variant column", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-reasoning-level-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("usage-reasoning-level");

    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("usage-reasoning-level"),
        slug: "usage-reasoning-level",
        directory: tempRoot,
        title: "usage reasoning level",
        version: "0.1.0",
      });

      await store.recordModelUsage({
        id: "usage_reasoning_level",
        logicalRequestId: "logical-reasoning-level",
        modelId: "test-model",
        providerId: "test-provider",
        querySource: "main_turn",
        reasoningLevel: "high",
        sessionID,
        startedAt: Date.now(),
        status: "completed",
      });

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          db.prepare("select variant from model_usage where id = ?").get("usage_reasoning_level"),
        ).toEqual({ variant: "high" });
      } finally {
        db.close();
      }

      await store.recordModelUsage({
        id: "usage_reasoning_level",
        logicalRequestId: "logical-reasoning-level",
        modelId: "test-model",
        providerId: "test-provider",
        querySource: "main_turn",
        reasoningLevel: "max",
        sessionID,
        startedAt: Date.now(),
        status: "completed",
      });

      const updatedDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          updatedDb
            .prepare("select variant from model_usage where id = ?")
            .get("usage_reasoning_level"),
        ).toEqual({ variant: "max" });
      } finally {
        updatedDb.close();
      }
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

// 16-timeline-authority-plan P3：session_input 账本生命周期。
// promotion 原子性是硬要求：账本置 promoted 与 user message/parts 持久化同一事务，
// 杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
describe("session input ledger (0016)", () => {
  it("admits, promotes atomically with the user message, and settles without regressing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-input-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("input-ledger");
    const created = 1_700_000_000_000;
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("input-ledger"),
        slug: "input-ledger",
        directory: tempRoot,
        title: "input ledger",
        version: "0.1.0",
        time: { created, updated: created },
      });

      await store.saveSessionInput!({
        id: "input-1",
        sessionID,
        kind: "sendText",
        delivery: "startNow",
        payload: { text: "执行前 admission" },
      });
      await store.saveSessionInput!({
        id: "input-2",
        sessionID,
        kind: "sendText",
        delivery: "guide",
        payload: { text: "引导二" },
      });
      // 同 id 重入：runtime 的实际 queue 裁决覆盖预 admission，仍保序保状态（幂等）。
      await store.saveSessionInput!({
        id: "input-1",
        sessionID,
        kind: "sendText",
        delivery: "queue",
        payload: { text: "排队一（改）" },
      });

      const admitted = await store.listSessionInputs!({ sessionID });
      expect(admitted.map((record) => [record.id, record.status, record.admittedSequence])).toEqual(
        [
          ["input-1", "admitted", 0],
          ["input-2", "admitted", 1],
        ],
      );
      expect(admitted[0]?.payload.text).toBe("排队一（改）");
      expect(admitted[0]?.delivery).toBe("queue");
      await expect(store.getSessionInputById("input-1")).resolves.toMatchObject({
        id: "input-1",
        sessionID,
        status: "admitted",
      });
      await expect(store.getSessionInputById("missing-input")).resolves.toBeNull();

      await store.saveSessionInput!({
        id: "input-1",
        sessionID,
        kind: "sendText",
        delivery: "queue",
        payload: {
          text: "排队一（改）",
          attachments: [{ ref: "artifact:one" }],
          intent: {
            sourceCommandId: "command-1",
            clientId: "desktop",
            queuePosition: 0,
          },
          conversationInputIntent: {
            sourceCommandId: "command-1",
            queueItemId: "input-1",
            clientId: "desktop",
            text: "排队一（改）",
            attachments: [{ ref: "artifact:one" }],
            order: { admissionSeq: 10, queuePosition: 0 },
          },
        },
      });
      await store.saveSessionInput!({
        id: "input-2",
        sessionID,
        kind: "sendText",
        delivery: "guide",
        payload: {
          text: "引导二",
          intent: {
            sourceCommandId: "command-2",
            clientId: "mobile",
            queuePosition: 1,
          },
          conversationInputIntent: {
            sourceCommandId: "command-2",
            queueItemId: "input-2",
            clientId: "mobile",
            text: "引导二",
            attachments: [],
            order: { admissionSeq: 11, queuePosition: 1 },
          },
        },
      });
      await store.updateSessionInputs!({
        sessionID,
        updates: [
          { id: "input-2", text: "引导二（编辑）", queuePosition: 0 },
          { id: "input-1", queuePosition: 1 },
        ],
      });
      await store.updateSessionInputs!({
        sessionID,
        updates: [
          {
            id: "input-2",
            delivery: "queue",
            intent: {
              sourceCommandId: "command-2",
              queueItemId: "input-2",
              clientId: "mobile",
              kind: "sendText",
              admissionSeq: 11,
              admittedAt: created + 1,
              requestedDelivery: "guide",
              admittedDelivery: "queue",
              queuePosition: 0,
              fallbackReasonCode: "guide.noToolBoundary",
            },
          },
        ],
      });
      const updated = await store.listSessionInputs!({ sessionID });
      expect(updated[1]?.delivery).toBe("queue");
      expect(updated[1]?.payload).toMatchObject({
        text: "引导二（编辑）",
        intent: {
          sourceCommandId: "command-2",
          clientId: "mobile",
          queuePosition: 0,
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.noToolBoundary",
        },
        conversationInputIntent: {
          sourceCommandId: "command-2",
          clientId: "mobile",
          text: "引导二（编辑）",
          attachments: [],
          order: { admissionSeq: 11, queuePosition: 0 },
          delivery: {
            requested: "guide",
            admitted: "queue",
            fallbackReasonCode: "guide.noToolBoundary",
          },
          steer: { state: "fellBack", reasonCode: "guide.noToolBoundary" },
        },
      });
      expect(updated[0]?.payload).toMatchObject({
        attachments: [{ ref: "artifact:one" }],
        conversationInputIntent: {
          sourceCommandId: "command-1",
          clientId: "desktop",
          order: { admissionSeq: 10, queuePosition: 1 },
        },
      });

      // promote 原子：账本 promoted + message + part 同事务。
      const messageID = createMessageId("input-1-msg");
      await store.promoteSessionInput!({
        id: "input-1",
        sessionID,
        message: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: created + 10 },
          agent: "zcode-agent",
          model: {
            providerID: "test-provider" as ModelProviderId,
            modelID: "test-model" as ModelId,
          },
          metadata: { turnSteerDelivery: "queue" },
        },
        parts: [
          {
            id: createPartId("input-1-text"),
            sessionID,
            messageID,
            type: "text",
            text: "排队一（改）",
            time: { start: created + 10, end: created + 10 },
          },
        ],
      });
      const messages = await store.messages({ sessionID });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.parts[0]?.type).toBe("text");

      const afterPromote = await store.listSessionInputs!({ sessionID });
      expect(afterPromote[0]).toMatchObject({
        id: "input-1",
        status: "promoted",
        promotedMessageID: messageID,
        promotedSequence: 0,
      });

      // settle 只收口 admitted：promoted 不回退（迟到 discard 不得改写已消费事实）。
      await store.settleSessionInput!({
        id: "input-1",
        sessionID,
        status: "discarded",
        reason: "session_resumed",
      });
      await store.settleSessionInput!({
        id: "input-2",
        sessionID,
        status: "discarded",
        reason: "session_resumed",
      });
      const settled = await store.listSessionInputs!({ sessionID });
      expect(settled.map((record) => [record.id, record.status])).toEqual([
        ["input-1", "promoted"],
        ["input-2", "discarded"],
      ]);
      expect(settled[1]?.statusReason).toBe("session_resumed");
      expect(settled[1]?.payload).toMatchObject({
        text: "引导二（编辑）",
        conversationInputIntent: {
          text: "引导二（编辑）",
          order: { queuePosition: 0 },
        },
      });
      await store.updateSessionInputs!({
        sessionID,
        updates: [{ id: "input-2", text: "不得复活终态", queuePosition: 9 }],
      });
      const terminalAfterLateUpdate = (await store.listSessionInputs!({ sessionID })).find(
        (record) => record.id === "input-2",
      );
      expect(terminalAfterLateUpdate?.payload).toMatchObject({
        text: "引导二（编辑）",
        conversationInputIntent: { order: { queuePosition: 0 } },
      });

      // markSessionInputPromoted：非原子标记路径（background wake）。
      await store.saveSessionInput!({
        id: "wake-1",
        sessionID,
        kind: "backgroundNotification",
        delivery: "queue",
        payload: { text: "<task-notification>done</task-notification>" },
      });
      await store.markSessionInputPromoted!({
        id: "wake-1",
        sessionID,
        promotedMessageID: createMessageId("wake-1-msg"),
      });
      const wake = (await store.listSessionInputs!({ sessionID })).find(
        (record) => record.id === "wake-1",
      );
      expect(wake).toMatchObject({ status: "promoted", promotedSequence: 1 });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
