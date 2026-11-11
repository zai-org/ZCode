// host（services 层）侧的 v4 命令信封构造与 ACK 收口共用件（send/交互回执收敛）。
//
// 与 renderer 的 packages/ui/src/v4/commandFactory.ts 平行：renderer 走浏览器
// localStorage 持久化 clientId；host 进程用进程内稳定 clientId（host 重启 = 新提交端，
// 幂等表以 commandId 为键不受影响）。不合并成一个实现的原因：ui 包不能被 services 反向依赖。
import { randomBytes, randomUUID } from "node:crypto";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** uuid v7（RFC 9562）：48-bit Unix ms 时间戳 + 74-bit 随机；与 renderer 工厂同构。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** host services 进程稳定 clientId；pendingCommands 展示与幂等表以它区分提交端。 */
const hostV4ClientId = `host-services-${uuidv7()}`;

export function getHostV4ClientId(): string {
  return hostV4ClientId;
}

export interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** createSession 时为 null。 */
  sessionId: string | null;
  /**
   * 幂等键。手机 replayable 的 send_prompt 用 inputId（=traceId）作 commandId：
   * CLI 侧 sendText 以 commandId 为 inputId 起 turn，终态事件的 inputId 才能与
   * host command queue 的 traceId 对账收口（inputId→commandId 对齐）。
   * 缺省生成 uuid v7（stop/resolveInteraction 等一次性命令）。
   */
  commandId?: string;
  /** 手机 replayable 保留原提交端 clientId；缺省用 host 进程稳定 id。 */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** 构造 host 侧命令信封；CAS 命令缺 baseRevision 就地抛出。 */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
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
            `sess_${randomUUID()}`,
        }
      : input.payload;
  return {
    commandId: input.commandId ?? uuidv7(),
    clientId: input.clientId ?? hostV4ClientId,
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload,
    issuedAt: Date.now(),
  };
}

/** v4 命令被服务端否决（rejected/stale/failed）。code 供调用方结构化分流，不匹配错误文案。 */
export class ZCodeV4CommandRejectedError extends Error {
  readonly code = "ZCODE_V4_COMMAND_REJECTED";

  constructor(
    readonly commandType: CommandType,
    readonly ack: CommandAck,
    contextMessage: string,
  ) {
    super(
      `v4 command ${commandType} ${ack.status}` +
        `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
        `${ack.message ? `: ${ack.message}` : ""} — ${contextMessage}`,
    );
    this.name = "ZCodeV4CommandRejectedError";
  }
}

/**
 * ACK 错误映射（旧 op 抛错语义 → v4 六态）：
 * - accepted：正常收口；duplicate：同 commandId 重试回放，幂等成功；
 * - noop：晚到应答/已收口，幂等成功（resolveInteraction 先到先得语义）；
 * - rejected/stale/failed：抛结构化错误，reasonCode 原样携带给调用方。
 */
export function assertV4CommandAckOk(
  commandType: CommandType,
  ack: CommandAck,
  contextMessage: string,
): CommandAck {
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return ack;
  }
  throw new ZCodeV4CommandRejectedError(commandType, ack, contextMessage);
}

/**
 * CAS 命令的 host 侧提交（配置写下沉）：host services 没有本地 v4 投影，
 * 拿不到当前 conversation revision——「stale ACK 必带 revisionAtDecision」
 * 用服务端回报的最新 revision 收敛重试，与 renderer 的 dispatchConfigCas 同构
 * （packages/ui/src/v4/SessionPane.tsx）。首发 baseRevision=0 作探测，典型路径一次
 * stale 即命中；每次尝试新 commandId（stale 裁决不进幂等表，语义等价且避免歧义）。
 * 旧 facade 从不带 expectedRevision（无 CAS），这里 stale 仅意味着并发推进而非冲突，
 * 重试即为「无 CAS 提交」语义的保真；连续用尽仅在病态并发下出现，按拒绝抛出。
 */
export async function sendHostCasCommandV4<T extends CommandType>(input: {
  send: (envelope: CommandEnvelope) => Promise<CommandAck>;
  type: T;
  payload: CommandPayloadMap[T];
  sessionId: string;
  contextMessage: string;
  maxAttempts?: number;
  /** 提交端身份；缺省用 host 进程稳定 id。扩展切换权限模式时是 `extension:<pluginId>`（§17.12）。 */
  clientId?: string;
}): Promise<CommandAck> {
  const maxAttempts = input.maxAttempts ?? 4;
  let baseRevision = 0;
  let lastAck: CommandAck | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ack = await input.send(
      createHostCommandEnvelope({
        type: input.type,
        payload: input.payload,
        sessionId: input.sessionId,
        baseRevision,
        ...(input.clientId ? { clientId: input.clientId } : {}),
      }),
    );
    if (ack.status === "stale") {
      lastAck = ack;
      baseRevision = ack.revisionAtDecision;
      continue;
    }
    return assertV4CommandAckOk(input.type, ack, input.contextMessage);
  }
  throw new ZCodeV4CommandRejectedError(
    input.type,
    lastAck ?? {
      commandId: "",
      status: "stale",
      revisionAtDecision: baseRevision,
    },
    `${input.contextMessage}（连续 stale，放弃重试）`,
  );
}
