import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitPermissionFullAccess } from "../src/storage/session-store/repositories/permission-full-access.js";
import type { SessionId } from "@zcode/contracts";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";

function fixture(mode: "guarded" | "yolo" = "yolo") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const id of ["0001_base_session_store", "0016_session_input_ledger"])
    db.exec(SQLITE_MIGRATIONS.find((migration) => migration.id === id)!.sql);
  for (const id of ["s", "other"])
    db.prepare(
      "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, 'project', 'test', '/workspace', 'test', '1', 0, 0)",
    ).run(id);
  const original = {
    text: "hello",
    intent: { mode: "edit", planEnabled: true },
    conversationInputIntent: {
      mode: "edit",
      planEnabled: true,
      attachments: ["a"],
      order: { admissionSeq: 7 },
    },
  };
  for (const [id, session, status] of [
    ["a", "s", "admitted"],
    ["other", "other", "admitted"],
    ["done", "s", "promoted"],
  ]) {
    db.prepare(
      "insert into session_input (id, session_id, payload, status, kind, delivery, admitted_sequence, time_created, time_updated) values (?, ?, ?, ?, 'sendText', 'queue', 1, 0, 0)",
    ).run(id!, session!, JSON.stringify(original), status!);
  }
  const entry = (id: string, data: unknown) => ({
    id,
    sessionID: "s" as SessionId,
    type: "runtime/execution_state",
    touchSession: false,
    time: { created: 1, updated: 1 },
    data,
  });
  const input = {
    sessionID: "s" as SessionId,
    queueItemIds: ["a"],
    execution: entry("execution", { mode, planEnabled: true }),
    receipt: {
      ...entry("receipt", { interactionId: "p" }),
      type: "runtime/permission_full_access",
    },
  };
  const read = (id: string) =>
    JSON.parse(
      db.prepare("select payload from session_input where id = ?").get(id)!.payload as string,
    );
  return { db, input, read, original };
}

describe("完全访问 SQLite 原子提交", () => {
  it("真实外键拒绝缺少 session 父行的授权且不留下部分记录", async () => {
    const { db, input } = fixture();
    const sessionID = "missing-draft" as SessionId;
    try {
      await expect(
        commitPermissionFullAccess(db, {
          ...input,
          sessionID,
          queueItemIds: [],
          execution: { ...input.execution, sessionID },
          receipt: { ...input.receipt, sessionID },
        }),
      ).rejects.toThrow("FOREIGN KEY constraint failed");
      expect(db.prepare("select count(*) as n from session_entry").get()!.n).toBe(0);
    } finally {
      db.close();
    }
  });
  it.each(["guarded", "yolo"] as const)("只将固定队列改为 %s", async (mode) => {
    const { db, input, read, original } = fixture(mode);
    try {
      await commitPermissionFullAccess(db, input);
      expect(read("a")).toEqual({
        ...original,
        intent: { ...original.intent, mode },
        conversationInputIntent: { ...original.conversationInputIntent, mode },
      });
      expect(read("other")).toEqual(original);
      expect(read("done")).toEqual(original);
      await commitPermissionFullAccess(db, { ...input, queueItemIds: ["other"] });
      expect(read("other")).toEqual(original);
    } finally {
      db.close();
    }
  });
  it("最后的 receipt 保存失败时回滚 execution 和队列", async () => {
    const { db, input, read, original } = fixture();
    try {
      db.exec(
        "CREATE TRIGGER fail_receipt BEFORE INSERT ON session_entry WHEN NEW.id = 'receipt' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
      await expect(commitPermissionFullAccess(db, input)).rejects.toThrow("disk full");
      expect(read("a")).toEqual(original);
      expect(db.prepare("select count(*) as n from session_entry").get()!.n).toBe(0);
    } finally {
      db.close();
    }
  });
  it("过期/跨任务队列项拒绝整个提交", async () => {
    const { db, input, read, original } = fixture();
    try {
      await expect(
        commitPermissionFullAccess(db, { ...input, queueItemIds: ["a", "other"] }),
      ).rejects.toThrow("unavailable");
      expect(read("a")).toEqual(original);
      const controller = new AbortController();
      controller.abort();
      await expect(
        commitPermissionFullAccess(db, { ...input, signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
