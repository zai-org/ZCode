import { executionStateSchema } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import type { SessionStorePort } from "@zcode/contracts";
import { saveSessionEntry } from "./session-entries.js";

/** SQLite adapter 的同步事务中不 await，取消检查和提交之间没有异步重入窗口。 */
export async function commitPermissionFullAccess(
  db: DatabaseSync,
  input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
): Promise<void> {
  input.signal?.throwIfAborted();
  const { mode } = executionStateSchema.parse(input.execution.data);
  if (mode !== "yolo" && mode !== "guarded") throw new Error("Unsupported permission grant mode");
  if (
    input.execution.sessionID !== input.sessionID ||
    input.receipt.sessionID !== input.sessionID
  ) {
    throw new Error("Permission commit session mismatch");
  }
  db.exec("begin immediate");
  try {
    const existing = db
      .prepare("select session_id from session_entry where id = ?")
      .get(input.receipt.id);
    if (existing) {
      if (existing.session_id !== input.sessionID)
        throw new Error("Permission receipt session mismatch");
      db.exec("commit");
      return;
    }
    const read = db.prepare(
      "select payload from session_input where id = ? and session_id = ? and status = 'admitted'",
    );
    const write = db.prepare(
      "update session_input set payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
    );
    for (const id of input.queueItemIds) {
      const row = read.get(id, input.sessionID);
      if (!row || typeof row.payload !== "string")
        throw new Error(`Pending input unavailable: ${id}`);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      for (const key of ["intent", "conversationInputIntent"]) {
        const intent = payload[key];
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          payload[key] = { ...intent, mode };
        }
      }
      write.run(JSON.stringify(payload), Date.now(), id, input.sessionID);
    }
    saveSessionEntry(db, input.execution);
    saveSessionEntry(db, input.receipt);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
