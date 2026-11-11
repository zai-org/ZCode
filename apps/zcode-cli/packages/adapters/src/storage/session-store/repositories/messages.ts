import type { DatabaseSync } from "node:sqlite";
import {
  assistantBlockParts,
  isAssistantBlockPart,
  sortByCompleteIndex,
  type ForkCommitBundle,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow, partCreatedAt } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { MessageRow, PartRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 只补回旧版快照字段，不合并整个 JSON：递归 merge 会让已清空的 metadata/options 残留。
function preserveLegacyMembers(table: "message" | "part", keys: readonly string[]): string {
  return keys.reduce(
    (sql, key) =>
      `(select case when json_type(${table}.data, '$.${key}') is not null
      then json_set(previous.data, '$.${key}', json_extract(${table}.data, '$.${key}')) else previous.data end
      from (select ${sql} as data) as previous)`,
    "excluded.data",
  );
}

const MESSAGE_DATA_UPDATE = preserveLegacyMembers("message", [
  "model",
  "providerID",
  "modelID",
  "variant",
]);
const PART_DATA_UPDATE = preserveLegacyMembers("part", ["fromModel", "toModel", "model"]);

// on-conflict 的 sequence 规则：
// 同 scope 再保存必须原样保留现有 sequence——包括 NULL。coalesce(existing, excluded)
// 会把 NULL 历史行（迁移遗漏/旧版本二进制写入）在任何一次再保存时重排到队尾（excluded=max+1），
// assistant 完成后的二次 save 就足以触发，造成时间线漂移；NULL 由 0015 backfill 统一修复。
// 跨 scope 改绑（id 冲突但 session/message 不同，仅导入 upsert 场景）才取 excluded 的新 scope 队尾。
// DatabaseSync 的内部仓库保持同步；事务内 await 会让其他会话的写入混入同一连接的事务。
export function saveMessage(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): void {
  const { id, sessionID, ...data } = input;
  // 冻结旧版协议 mapper 无条件读取 user.model；缺少整个对象会让正文也无法打开。
  // 只补必需对象；旧行的原 model 仍由冲突更新/复制逻辑保留，新版 Reader 不使用它。
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? Date.now()) : timeCreated;

  db.prepare(
    `
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then ${MESSAGE_DATA_UPDATE} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    encodeJson(copyLegacyMembers(db, "message", storedData, copyFrom)),
    sessionID,
  );
  touchSession(db, sessionID, timeUpdated);
}

export async function removeMessage(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  db.prepare("delete from message where id = ? and session_id = ?").run(
    input.messageID,
    input.sessionID,
  );
}

export function savePart(
  db: DatabaseSync,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): void {
  const { id, sessionID, messageID, ...data } = input;
  let storedData: Record<string, unknown> = data;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    // 冻结旧版 Reader 直接访问 toModel.providerID；只为这一个必需对象做最小兼容写入。
    // 当前 Reader 不读它，更新同一旧行时 SQL 保留原快照，不持续反向同步。
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    storedData = {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  } else if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    storedData = { ...part, modelSelection: model };
  }
  const now = Date.now();

  db.prepare(
    `
      insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = ?
        )
      )
      on conflict(id) do update set
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
          then ${PART_DATA_UPDATE} else excluded.data end,
        sequence = case
          when part.message_id = excluded.message_id and part.session_id = excluded.session_id
            then part.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    messageID,
    sessionID,
    partCreatedAt(input, now),
    now,
    encodeJson(copyLegacyMembers(db, "part", storedData, copyFrom)),
    messageID,
  );
  touchSession(db, sessionID, now);
}

function copyLegacyMembers(
  db: DatabaseSync,
  table: "message" | "part",
  data: Record<string, unknown>,
  source: Parameters<SessionStorePort["saveMessage"]>[1],
): Record<string, unknown> {
  if (!source) return data;
  // 复制只搬运存储快照；运行层不读取旧字段，也不能凭当前选择重建旧值。
  const row = db
    .prepare(`SELECT data FROM ${table} WHERE id=? AND session_id=?`)
    .get(source.id, source.sessionID);
  if (!row) throw new Error(`Storage copy source missing: ${table}/${source.id}`);
  const original = JSON.parse(String(row.data)) as Record<string, unknown>;
  const result = { ...data };
  const keys =
    table === "message"
      ? ["model", "providerID", "modelID", "variant"]
      : ["fromModel", "toModel", "model"];
  for (const key of keys) if (Object.hasOwn(original, key)) result[key] = original[key];
  return result;
}

export async function removePart(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  db.prepare("delete from part where id = ? and message_id = ? and session_id = ?").run(
    input.partID,
    input.messageID,
    input.sessionID,
  );
}

export function messages(db: DatabaseSync, input: { sessionID: SessionId }): MessageWithParts[] {
  const messageRows = db
    .prepare(
      `
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageRow[];

  const partRows = db
    .prepare(
      `
      select * from part
      where session_id = ?
      order by message_id, sequence is null, sequence, time_created, id
      `,
    )
    .all(input.sessionID) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();

  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => {
    const info = decodeMessageRow(row);
    return { info, parts: orderAssistantBlockParts(info, partsByMessage.get(row.id) ?? []) };
  });
}

export async function messageWithParts(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<MessageWithParts | null> {
  const messageRow = db
    .prepare("select * from message where id = ? and session_id = ?")
    .get(input.messageID, input.sessionID) as unknown as MessageRow | undefined;
  if (!messageRow) return null;

  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(input.messageID, input.sessionID) as unknown as PartRow[];
  const info = decodeMessageRow(messageRow);
  return { info, parts: orderAssistantBlockParts(info, partRows.map(decodePartRow)) };
}

/**
 * 有序 assistant 消息的块 part 按 blockIndex 稳定排序，消费方（V4 冷恢复、services、fork）拿到流顺序，
 * 而不是写库顺序（只读工具在流中写库，reasoning/text 在流结束后写库）。
 * 只在块 part 占用的位置之间重排；step-start、step-finish、file、截图等其他 part 位置不变。
 * 旧消息保持物理顺序。见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
 */
function orderAssistantBlockParts(info: MessageInfo, parts: MessagePart[]): MessagePart[] {
  if (info.role !== "assistant") return parts;
  // 块 part 只筛一次，判定和排序共用；有块缺合法序号（旧消息、混合消息）时保持物理顺序。
  const blockParts = sortByCompleteIndex(assistantBlockParts(parts), (part) => part.blockIndex);
  if (!blockParts) return parts;
  let next = 0;
  return parts.map((part) => (isAssistantBlockPart(part) ? blockParts[next++]! : part));
}

const COPY_BATCH_SIZE = 128;
const JSON_EDIT_BATCH_SIZE = 128;

/** 正文留在 SQLite；仅将既有 fork 规则需要的元数据交给同步规划器。 */
export function forkSourceMetadata(db: DatabaseSync, sessionID: SessionId): MessageWithParts[] {
  const messages = db
    .prepare(`
    select id, session_id, json_remove(data, '$.summary.body', '$.summary.diffs', '$.system') as data
    from message where session_id = ?
    order by sequence is null, sequence, time_created, rowid
  `)
    .all(sessionID) as unknown as MessageRow[];
  // 旧版隐藏提醒的选型判定仍读文本，不能用截断前缀改变既有语义。
  const parts = db
    .prepare(`
    select p.id, p.message_id, p.session_id,
      case when json_type(p.data, '$.state.attachments') = 'array' then
        json_set(projected.data, '$.state.attachments', json((
          select json_group_array(json_remove(value, '$.url'))
          from json_each(p.data, '$.state.attachments')
        ))) else projected.data end as data
    from part p join (
      select p0.id, json_remove(case when json_extract(m0.data, '$.role') = 'user'
          and json_extract(m0.data, '$.semantics.kind') = 'system_reminder'
          and json_extract(m0.data, '$.semantics.uiVisibility') = 'hidden'
          then p0.data else json_remove(p0.data, '$.text') end,
        '$.url', '$.state.input', '$.state.output', '$.state.raw', '$.state.error',
        '$.prompt', '$.description', '$.files', '$.snapshot'
      ) as data from part p0 join message m0 on m0.id = p0.message_id and m0.session_id = p0.session_id where p0.session_id = ?
    ) projected on projected.id = p.id
    where p.session_id = ?
    order by p.message_id, p.sequence is null, p.sequence, p.time_created, p.id
  `)
    .all(sessionID, sessionID) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of parts) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }
  return messages.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

type JsonObject = Record<string, unknown>;
interface Changes {
  remove: string[];
  set: string[];
  values: unknown[];
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 比较同一份轻量投影的克隆前后值，只改引用/可见性等真实差异。不能用 merge-patch：
// 它会删除显式 null，也不能用全量 JSON 覆盖：那会丢失未读出的正文与旧版快照字段。
function diffJson(before: unknown, after: unknown, path: string, changes: Changes): void {
  if (before === after) return;
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffJson(before[key], after[key], `${path}.${JSON.stringify(key)}`, changes);
    }
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    // orderedMessageIds 可包含整个长对话。标量数组整体改写，避免每个 ID 占一个
    // JSON 函数参数；附件对象仍逐字段改写，保留投影时省略的 URL/正文。
    if (after.every((value) => value === null || typeof value !== "object")) {
      if (after.some((value, index) => value !== before[index])) {
        changes.set.push(path);
        changes.values.push(after);
      }
      return;
    }
    before.forEach((value, index) => diffJson(value, after[index], `${path}[${index}]`, changes));
  } else if (after === undefined) {
    changes.remove.push(path);
  } else {
    changes.set.push(path);
    changes.values.push(after);
  }
}

interface CopyRow {
  source: string;
  id: string;
  messageId?: string;
  created: number;
  updated: number;
  sequence: number;
  values: unknown[];
}
interface CopyGroup {
  changes: Changes;
  rows: CopyRow[];
}

function addCopy(
  groups: Map<string, CopyGroup>,
  before: object,
  after: object,
  row: Omit<CopyRow, "values">,
): void {
  const changes: Changes = { remove: [], set: [], values: [] };
  const dataOnly = (value: object) => {
    const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = value as JsonObject;
    return data;
  };
  diffJson(dataOnly(before), dataOnly(after), "$", changes);
  const key = JSON.stringify([changes.remove, changes.set]);
  const group = groups.get(key) ?? { changes, rows: [] };
  group.rows.push({ ...row, values: changes.values });
  groups.set(key, group);
}

function insertCopies(
  db: DatabaseSync,
  table: "message" | "part",
  groups: Map<string, CopyGroup>,
  parent: SessionId,
  child: SessionId,
): void {
  for (const { changes, rows } of groups.values()) {
    let data = "source.data";
    for (let offset = 0; offset < changes.remove.length; offset += JSON_EDIT_BATCH_SIZE) {
      data = `json_remove(${data}, ${changes.remove
        .slice(offset, offset + JSON_EDIT_BATCH_SIZE)
        .map(() => "?")
        .join(",")})`;
    }
    for (let offset = 0; offset < changes.set.length; offset += JSON_EDIT_BATCH_SIZE) {
      data = `json_set(${data}, ${changes.set
        .slice(offset, offset + JSON_EDIT_BATCH_SIZE)
        .map((_, index) => `?, json(plan.value -> '$.values[${offset + index}]')`)
        .join(",")})`;
    }
    // 普通 JOIN 会被 SQLite 排成 source 在外层，每批重复扫描整个父会话，退化为平方级。
    // CROSS JOIN 固定 plan 在外层，每个复制项只按源记录主键查询一次。
    const statement = db.prepare(`
      insert into ${table} (id, session_id, ${table === "part" ? "message_id," : ""} time_created, time_updated, sequence, data)
      select json_extract(plan.value, '$.id'), ?, ${table === "part" ? "json_extract(plan.value, '$.messageId')," : ""}
        json_extract(plan.value, '$.created'), json_extract(plan.value, '$.updated'), json_extract(plan.value, '$.sequence'), ${data}
      from json_each(?) plan cross join ${table} source on source.id = json_extract(plan.value, '$.source')
      where source.session_id = ?
    `);
    for (let index = 0; index < rows.length; index += COPY_BATCH_SIZE) {
      const batch = rows.slice(index, index + COPY_BATCH_SIZE);
      const result = statement.run(
        child,
        ...changes.remove,
        ...changes.set,
        JSON.stringify(batch),
        parent,
      );
      if (Number(result.changes) !== batch.length) throw new Error("Fork copy source missing");
    }
  }
}

/** 调用方持有 BEGIN IMMEDIATE；严格 INSERT 防止 ID 冲突把其他会话记录改绑到 child。 */
export function copyForkMessages(
  db: DatabaseSync,
  bundle: ForkCommitBundle,
  source: MessageWithParts[],
): void {
  const sources = new Map(source.map((message) => [String(message.info.id), message]));
  const messageGroups = new Map<string, CopyGroup>();
  const partGroups = new Map<string, CopyGroup>();
  const fresh: { message: MessageWithParts; sequence: number }[] = [];
  const now = Date.now();
  bundle.messages.forEach((message, sequence) => {
    const sourceId = bundle.copySources?.messages[message.info.id];
    if (!sourceId) {
      fresh.push({ message, sequence });
      return;
    }
    const original = sources.get(sourceId);
    if (!original) throw new Error("Fork message copy source is not parent-local");
    addCopy(messageGroups, original.info, message.info, {
      source: sourceId,
      id: message.info.id,
      sequence,
      created: message.info.time.created,
      updated:
        message.info.role === "assistant"
          ? (message.info.time.completed ?? now)
          : message.info.time.created,
    });
    const originalParts = new Map(original.parts.map((part) => [String(part.id), part]));
    message.parts.forEach((part, partSequence) => {
      const partSourceId = bundle.copySources?.parts[part.id];
      const originalPart = partSourceId && originalParts.get(partSourceId);
      if (!originalPart) throw new Error("Fork part copy source is not message-local");
      addCopy(partGroups, originalPart, part, {
        source: partSourceId,
        id: part.id,
        messageId: part.messageID,
        sequence: partSequence,
        created: partCreatedAt(part, now),
        updated: now,
      });
    });
  });
  insertCopies(db, "message", messageGroups, bundle.child.parentID!, bundle.child.id);
  insertCopies(db, "part", partGroups, bundle.child.parentID!, bundle.child.id);
  for (const { message, sequence } of fresh) {
    // 新建的边界提示没有复制源；显式保留 bundle 顺序，不依赖分组 INSERT 的执行顺序。
    if (db.prepare("select 1 from message where id = ?").get(message.info.id)) {
      throw new Error("Fork new message ID already exists");
    }
    saveMessage(db, message.info);
    db.prepare("update message set sequence = ? where id = ?").run(sequence, message.info.id);
    for (const part of message.parts) {
      if (db.prepare("select 1 from part where id = ?").get(part.id)) {
        throw new Error("Fork new part ID already exists");
      }
      savePart(db, part);
    }
  }
}
