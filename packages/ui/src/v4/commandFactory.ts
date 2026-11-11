// Command 信封工厂。
// commandId = uuid v7（时间有序，重试不变）；clientId 每个客户端实例稳定并持久化，
// 服务端幂等表与 pendingCommands 展示都以它区分提交端。
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import { uuidv7 } from "@zcode/shared";
export { uuidv7 } from "@zcode/shared";

const CLIENT_ID_STORAGE_KEY = "zcode-v4-client-id:v1";
let cachedClientId: string | null = null;

/**
 * 本客户端实例的稳定 clientId。优先 localStorage 持久化（刷新后不变，
 * 幂等表跨刷新仍能识别重试）；无 storage 环境退化为进程内稳定。
 */
export function getV4ClientId(): string {
  if (cachedClientId) return cachedClientId;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch {
    // incognito / node 测试环境无 localStorage，退化为内存缓存
  }
  const clientId = stored ?? `client-${uuidv7()}`;
  if (!stored) {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
      // 同上，忽略
    }
  }
  cachedClientId = clientId;
  return clientId;
}

const EDITOR_ID_STORAGE_KEY = "zcode-v4-editor-id:v1";
let cachedEditorId: string | null = null;

/**
 * 本窗口（Web 每个标签页）的编辑器实例 id，作为队列编辑锁的归属
 * （docs/ui/composer-edit-mode.md）。sessionStorage 让刷新后不变、不同窗口不同；
 * clientId 存在 localStorage，同设备多窗口共享，不能单独区分锁的持有者。
 */
export function getV4EditorId(): string {
  if (cachedEditorId) return cachedEditorId;
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(EDITOR_ID_STORAGE_KEY);
  } catch {
    // 无 sessionStorage 环境退化为进程内稳定
  }
  const editorId = stored ?? `editor-${uuidv7()}`;
  if (!stored) {
    try {
      sessionStorage.setItem(EDITOR_ID_STORAGE_KEY, editorId);
    } catch {
      // 同上，忽略
    }
  }
  cachedEditorId = editorId;
  return editorId;
}

/** 当前 id 已被另一个在线页面占用（复制标签页）时换新 id，并写回 sessionStorage 供刷新沿用。 */
export function regenerateV4EditorId(): string {
  const editorId = `editor-${uuidv7()}`;
  try {
    sessionStorage.setItem(EDITOR_ID_STORAGE_KEY, editorId);
  } catch {
    // 无 sessionStorage 环境只在进程内生效
  }
  cachedEditorId = editorId;
  return editorId;
}

export interface CreateCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** createSession 时为 null。 */
  sessionId: string | null;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** 构造命令信封；CAS 命令缺 baseRevision 直接抛（客户端编程错误就地暴露）。 */
export function createCommandEnvelope<T extends CommandType>(
  input: CreateCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(
      `command ${input.type} 是 CAS 命令，必须携带 baseRevision（10-protocol-spec §6.4）`,
    );
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} 是 row target 命令，必须携带 baseLogEpoch`);
  }
  // 会话 ID 恢复 UUID v4；在信封首次构造时分配，避免重试重新生成并预留另一条任务。
  const payload =
    input.type === "createSession"
      ? {
          ...input.payload,
          sessionId:
            (input.payload as CommandPayloadMap["createSession"]).sessionId ??
            `sess_${crypto.randomUUID()}`,
        }
      : input.payload;
  return {
    commandId: uuidv7(),
    clientId: getV4ClientId(),
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload,
    issuedAt: Date.now(),
  };
}
