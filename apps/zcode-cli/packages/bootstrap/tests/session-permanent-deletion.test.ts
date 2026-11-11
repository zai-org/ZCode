import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionId } from "@zcode/contracts";
import { SqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createNodeSessionDataFiles } from "../../adapters/src/storage/session-data-files/index.js";
import { NodeToolArtifactStore } from "../../adapters/src/storage/index.js";
import {
  previewSessionDeletionWith,
  executeSessionDeletionWith,
  type SessionDeletionHost,
} from "../src/zcode-protocol/session-data/permanent-deletion.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const params = { sessionId: "root", workspace: { workspacePath: "/work/example" } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "permanent-deletion-runtime-"));
  const dbPath = join(root, "db.sqlite");
  const store = await SqliteSessionStore.open({ dbPath });
  const db = new DatabaseSync(dbPath);
  cleanups.push(async () => {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, parentID, taskType] of [
    ["root", undefined, "interactive"],
    ["child", "root", "subagent_child"],
    ["fork", "root", "interactive"],
  ] as const)
    await store.createSession({
      id: id as SessionId,
      projectID: "project" as never,
      slug: id,
      directory: params.workspace.workspacePath,
      title: id,
      version: "1",
      parentID: parentID as SessionId | undefined,
      taskType,
    });
  db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('m','fork',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('p','m','fork',1,1,?)",
  ).run(JSON.stringify({ url: "zcode-artifact://root/shared" }));
  const dir = join(root, "artifacts", "root");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "shared.png"), "shared");
  await writeFile(join(dir, "private.txt"), "private");
  const files = createNodeSessionDataFiles({
    cliStorageRoot: root,
    memoryRoot: () => join(root, "memories", "projects", "unused", "memory"),
  });
  const busy = new Set<string>();
  const host: SessionDeletionHost = {
    store,
    files,
    busy: (id) => busy.has(id),
    release: async () => {},
    forget: () => {},
  };
  const execute = async (revision: string) =>
    executeSessionDeletionWith(host, { ...params, revision, operationId: "op" });
  return { root, dbPath, db, store, dir, host, busy, execute };
}
describe("归档永久删除执行面", () => {
  it("保留 fork 和引用文件，物理删除正文，重复请求返回已完成", async () => {
    const { root, host, store, dir, execute, db } = await setup();
    // 用真实正文验证行级清理，不能只以 getSession 隐藏了记录作为永久删除证据。
    for (const id of ["root", "child"]) {
      db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,1,1,?)",
      ).run(`${id}-message`, id, '{"role":"user","text":"E2E_PRIVATE_BODY"}');
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,1,1,?)",
      ).run(`${id}-part`, `${id}-message`, id, '{"type":"text","text":"E2E_PRIVATE_BODY"}');
    }
    db.exec(
      "INSERT INTO input_history(id,project_id,session_id,text,kind,time_created) VALUES('history','project','root','E2E_PRIVATE_INPUT','prompt',1)",
    );
    db.exec(
      "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('owned-run','root',1,'completed',1,1)",
    );
    db.exec(
      `INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES('owned-run',1,'result','{"text":"E2E_PRIVATE_WORKFLOW"}',1)`,
    );
    await writeFile(join(root, "workspace-file.txt"), "E2E_KEEP_WORKSPACE");
    const preview = await previewSessionDeletionWith(host, params);
    expect(preview.forks.map((f) => f.sessionId)).toEqual(["fork"]);
    expect(preview.retainedArtifacts[0]?.fileName).toBe("shared.png");
    expect(preview.deletedFiles).toBe(1);
    expect((await execute(preview.revision)).status).toBe("deleted");
    expect(await store.getSession("root" as SessionId)).toBeNull();
    expect(await store.getSession("fork" as SessionId)).not.toBeNull();
    expect(await readFile(join(dir, "shared.png"), "utf8")).toBe("shared");
    const artifacts = new NodeToolArtifactStore({
      rootDir: join(root, "artifacts"),
      imageCacheRootDir: join(root, "image-cache"),
      videoCacheRootDir: join(root, "video-cache"),
    });
    expect(
      Buffer.from(
        (await artifacts.readToolResultBinaryArtifact({ uri: "zcode-artifact://root/shared" }))
          .bytes,
      ).toString(),
    ).toBe("shared");
    await expect(readFile(join(dir, "private.txt"))).rejects.toThrow();
    expect(db.prepare("SELECT 1 FROM session WHERE id IN ('root','child')").get()).toBeUndefined();
    for (const table of ["message", "part", "input_history"])
      expect(
        db.prepare(`SELECT 1 FROM ${table} WHERE session_id IN ('root','child')`).get(),
      ).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM dwf_event WHERE run_id='owned-run'").get()).toBeUndefined();
    expect(await readFile(join(root, "workspace-file.txt"), "utf8")).toBe("E2E_KEEP_WORKSPACE");
    expect((await execute(preview.revision)).status).toBe("deleted");
  });
  it("其他会话的工作流产物记录引用也保留附件", async () => {
    const { host, db } = await setup();
    db.exec(`UPDATE part SET data='{}';
      INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('run','fork',1,'completed',1,1);
      INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES('run',1,'artifact','{"uri":"zcode-artifact://root/shared"}',1);`);
    expect(
      (await previewSessionDeletionWith(host, params)).retainedArtifacts.map(
        (file) => file.fileName,
      ),
    ).toEqual(["shared.png"]);
  });
  it("运行中的 owned child 阻止整棵删除", async () => {
    const { host, busy, execute, store } = await setup();
    const preview = await previewSessionDeletionWith(host, params);
    busy.add("child");
    expect(await execute(preview.revision)).toMatchObject({ status: "blocked", reason: "running" });
    expect(await store.getSession("root" as SessionId)).not.toBeNull();
  });
  it("预检后新增文件要求重新确认", async () => {
    const { host, dir, execute, store } = await setup();
    const preview = await previewSessionDeletionWith(host, params);
    await writeFile(join(dir, "new.txt"), "new");
    expect(await execute(preview.revision)).toMatchObject({ status: "blocked", reason: "changed" });
    expect(await store.getSession("root" as SessionId)).not.toBeNull();
  });
  it("预检后新增外部引用要求重查，准入后拒绝迟到引用", async () => {
    const { host, db, store, execute } = await setup();
    const preview = await previewSessionDeletionWith(host, params);
    db.prepare("UPDATE part SET data=? WHERE id='p'").run(
      JSON.stringify({
        url: "zcode-artifact://root/private",
      }),
    );
    expect(await execute(preview.revision)).toMatchObject({ status: "blocked", reason: "changed" });
    expect(db.prepare("SELECT 1 FROM session_purge").get()).toBeUndefined();
    const fresh = await store.inspectSessionDeletion("root" as SessionId);
    await store.beginSessionDeletion("root" as SessionId, fresh.revision, "op", []);
    expect(() =>
      db.prepare("UPDATE part SET data=? WHERE id='p'").run(
        JSON.stringify({
          url: "zcode-artifact://root/shared",
        }),
      ),
    ).toThrow("session-data.deleting");
    expect(() =>
      db
        .prepare(
          "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('late-run','root',1,'running',1,1)",
        )
        .run(),
    ).toThrow("session-data.deleting");
  });
  it("文件清理后数据库失败，新存储连接凭持久凭据续删", async () => {
    const { host, store, dir, dbPath, execute } = await setup();
    const preview = await previewSessionDeletionWith(host, params);
    host.store = {
      inspectSessionDeletion: store.inspectSessionDeletion.bind(store),
      beginSessionDeletion: store.beginSessionDeletion.bind(store),
      completeSessionDeletion: async () => {
        throw new Error("injected SQL failure");
      },
    };
    expect((await execute(preview.revision)).status).toBe("incomplete");
    await expect(readFile(join(dir, "private.txt"))).rejects.toThrow();
    const reopened = await SqliteSessionStore.open({ dbPath });
    try {
      expect(await reopened.getSession("root" as SessionId)).toBeNull();
      expect((await reopened.inspectSessionDeletion("root" as SessionId)).deleting).toBe(true);
      host.store = reopened;
      expect((await execute(preview.revision)).status).toBe("deleted");
      expect(await readFile(join(dir, "shared.png"), "utf8")).toBe("shared");
    } finally {
      reopened.close();
    }
  });
  it("部分失败留下写屏障，重试只完成余项", async () => {
    const { host, execute, store, db } = await setup();
    const preview = await previewSessionDeletionWith(host, params);
    const remove = host.files.removeSession;
    host.files.removeSession = async () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    };
    expect((await execute(preview.revision)).status).toBe("incomplete");
    expect(await store.getSession("root" as SessionId)).toBeNull();
    expect(db.prepare("SELECT 1 FROM session WHERE id='root'").get()).toBeDefined();
    expect(() =>
      db
        .prepare(
          "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('late','root',1,1,'{}')",
        )
        .run(),
    ).toThrow("session-data.deleting");
    host.files.removeSession = remove;
    expect((await execute(preview.revision)).status).toBe("deleted");
  });
  it("跨连接运行态互斥且拒绝错误目录身份", async () => {
    const { host, store, dbPath, execute } = await setup();
    const other = await SqliteSessionStore.open({ dbPath });
    try {
      const preview = await previewSessionDeletionWith(host, params);
      await other.registerSessionRuntime("root" as SessionId);
      expect(await execute(preview.revision)).toMatchObject({
        status: "blocked",
        reason: "in-use",
      });
      await other.unregisterSessionRuntime("root" as SessionId);
      await expect(
        previewSessionDeletionWith(host, { ...params, workspace: { workspacePath: "/other" } }),
      ).rejects.toThrow("identity-mismatch");
      expect(await store.getSession("root" as SessionId)).not.toBeNull();
    } finally {
      other.close();
    }
  });
});
