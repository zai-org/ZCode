import { z } from "zod";
import {
  modelExecutionSelectionFallbackReasonSchema,
  type ModelExecutionSelectionFallback,
} from "./model-execution.js";
import type { ModelSelection } from "./model-selection.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

/**
 * 卡在 Turn 中过期时加速网关返回的业务错误码（HTTP 400 / provider_code=3402）。
 * 见 docs/highspeed/highspeed-card-spec.md：命中它要保留上下文并退回原模型跑完本轮。
 */
export const HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE = "3402";

/**
 * 加速卡的隐藏 Built-in Provider；端点与模型名单由 ZCode Built-in Provider Config 提供
 * （config/provider/zcode-builtin.json），这里只保留跨层引用的 ID。
 * 与 Off-Peak 同规则按账号 Family 拆分：卡是对当前账号 Coding Plan 权益的抽取，
 * 不跨 Family 静默迁移。
 */
export const HIGHSPEED_PROVIDER_IDS = {
  zai: "account:zai-highspeed-card",
  bigmodel: "account:bigmodel-highspeed-card",
} as const;

export function resolveHighspeedProviderId(
  family: "zai" | "bigmodel",
): (typeof HIGHSPEED_PROVIDER_IDS)[typeof family] {
  return HIGHSPEED_PROVIDER_IDS[family];
}

/**
 * 判定一次 Selection 是否指向加速卡 Provider。拆 Family 之后不能再和单个常量比较，
 * 否则 BigModel 账号的卡在队列提升时会被判成「非加速」而静默丢卡。
 */
export function isHighspeedProviderId(providerId: string | undefined): boolean {
  if (providerId === undefined) return false;
  return Object.values(HIGHSPEED_PROVIDER_IDS).some((id) => id === providerId);
}

/**
 * draw body 的 provider 契约值：服务端 highspeed 白名单只认 Coding Plan 的 builtin 身份
 * （builtin:zai-coding-plan / builtin:bigmodel-coding-plan，2026-09-17 与服务端确认；
 * 设计文档示例里的 "zai" 是缩写示意，非线上取值）。Start Plan、Off-Peak、API Key 与
 * 自定义 Provider 都不在白名单内，必须解析为 null 后降级，禁止映射后发送。
 */
export const HIGHSPEED_DRAW_PROVIDER_IDS = {
  zai: "builtin:zai-coding-plan",
  bigmodel: "builtin:bigmodel-coding-plan",
} as const;

const HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID = new Map<string, string>([
  [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
]);

/** 把会话选择的 Provider ID 解析成 draw body 可用的白名单 provider 值；不命中返回 null。 */
export function resolveHighspeedDrawProviderId(providerId: string): string | null {
  return HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID.get(providerId) ?? null;
}

export const highspeedCardSchema = z.object({
  card_id: z.string().min(1),
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

/**
 * 写入 message.data 的协议级卡快照。版本字段保证后续扩展仍能宽容读取旧消息。
 */
export const highspeedMessageMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    cardId: z.string().min(1),
    ownerKey: z
      .string()
      .regex(/^v1:[a-f0-9]{64}$/)
      .optional(),
    taskId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** 发送该轮时从 Coding Plan 健康检查采样的普通 Pro/Max decode TPS。 */
    regularTps: z.number().positive().optional(),
    /** 完成态统计；这些字段由同一次 CLI 持久化更新原子写入。 */
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    /** 卡到期后从 Highspeed healthy usage 采样的卡级平均 completion TPS。 */
    highspeedTps: z.number().positive().optional(),
    savedDurationMs: z.number().nonnegative().optional(),
    /** CLI 从运行时事件聚合的真实耗时拆分；缺省时客户端回退到 20/80 估算。 */
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
    /** Turn 内加速请求失败并回落普通模型的时刻；只用于投影降级提示，不改变分享统计。 */
    fallbackAt: z.number().int().nonnegative().optional(),
    /** 回落原因：卡过期或其他加速请求失败；Renderer 据此选择提示文案，缺省按卡过期处理旧数据。 */
    fallbackReason: modelExecutionSelectionFallbackReasonSchema.optional(),
  })
  .strict();

export const highspeedDrawRequestSchema = z.object({
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const highspeedDrawResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card: highspeedCardSchema.nullable(),
    next_draw_at: z.number().int().nonnegative(),
  }),
});

export const highspeedHealthyResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card_id: z.string().min(1),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
  }),
});

export type HighspeedCardApi = z.infer<typeof highspeedCardSchema>;
export type HighspeedMessageMeta = z.infer<typeof highspeedMessageMetaSchema>;
export type HighspeedDrawRequest = z.infer<typeof highspeedDrawRequestSchema>;
export type HighspeedDrawResponse = z.infer<typeof highspeedDrawResponseSchema>;
export type HighspeedHealthyResponse = z.infer<typeof highspeedHealthyResponseSchema>;

export interface HighspeedCardUsage {
  cardId: string;
  promptTokens: number;
  completionTokens: number;
  durationSeconds: number;
}

export interface HighspeedCardSnapshot {
  cardId: string;
  ownerKey?: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
}

export type HighspeedPrepareFallbackReason =
  | "automation"
  | "cooldown"
  | "draw-miss"
  | "draw-timeout"
  | "expired"
  | "foreign-card"
  | "no-coding-plan"
  | "unavailable";

export interface HighspeedPrepareTurnParams {
  taskId: string;
  /**
   * 会话模型选择的 Provider ID。draw body 的 provider 契约是白名单里的 Coding Plan
   * builtin 身份（builtin:zai-coding-plan / builtin:bigmodel-coding-plan），由服务层
   * 发送前解析；调用方禁止直接传白名单值或把完整 providerId 透传上链路
   * （透传会被服务端白名单拒绝并返回 3001 参数错误）。
   */
  providerId: string;
  /**
   * 会话当前选择的模型。除 provider 白名单外，模型还必须属于所选 Coding Plan Provider 的
   * 模型目录（Built-in Provider Config 投影）才会发起新 draw；陈旧的 (coding-plan provider,
   * 已下线模型) 组合按 unavailable 降级（spec §3 规则 14）。
   */
  model: string;
  /**
   * 会话当前生效的思考档位。加速只换端点不换模型，卡的 modelSelection 必须带上与会话
   * 一致的 reasoningLevel；否则 CLI Registry 会因 execution 选择缺档位判定
   * reasoning-level-missing，抛出 "Reasoning level is required" 让整轮发送失败。
   * 模型无思考档位时省略（不写 options）。
   */
  reasoningLevel?: string;
  /** 仅表示本轮由 Automation 派发；不得用 Task 上粘性的 cronAutomationId 代替。 */
  automationId?: string;
  waitBudgetMs?: number;
}

/**
 * 单轮加速执行材料。静态事实（端点、API 形态、模型能力）由 Built-in Provider Config
 * 提供，这里只携带「本轮选哪个模型」和「本次执行的动态鉴权」，禁止再下发 provider 定义。
 */
export interface HighspeedTurnExecution {
  modelSelection: ModelSelection;
  requestAuth: { apiKey: string; headers: Record<string, string> };
  /**
   * 加速请求任何失败时退回原模型跑完本轮；卡过期（3402）与其他失败按规则给出不同原因。
   * 退回目标 `target` 是抽卡时的提交选择（会话原模型 + 档位），CLI 优先用它，缺省才退回会话常驻选择。
   */
  selectionFallback: ModelExecutionSelectionFallback;
}

export type HighspeedPrepareTurnResult =
  | {
      kind: "accelerated";
      card: HighspeedCardSnapshot;
      nextDrawAt: number;
      /** Mock 只保留加速业务语义，省略该字段即可继续使用 session 普通推理路由。 */
      execution?: HighspeedTurnExecution;
    }
  | {
      kind: "fallback";
      reason: HighspeedPrepareFallbackReason;
      card?: HighspeedCardSnapshot;
      nextDrawAt: number | null;
    };

export interface HighspeedServiceSnapshot {
  card: HighspeedCardSnapshot | null;
  nextDrawAt: number | null;
  drawing: boolean;
}

export type HighspeedMockScenario =
  | "hit-fast"
  | "miss"
  | "hit-after-timeout"
  | "hit-invalid-model"
  | "hit-queue-edit"
  | "existing-foreign-task-card"
  | "expired-card";
