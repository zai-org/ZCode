/* off-peak 服务端五接口客户端。
   只负责 额度快照/取号/批量查状态/结算 四个 JSON 接口——messages 调模型不走这里
   （由 idle plan per-turn provider 在 agent 进程内直连，D33）。
   无内建重试：排队/退避语义在调用方（offPeakTaskService 轮询 / 适配层 D24）。 */
import { z } from "zod";
import type { OffPeakTakeNumberAvailability } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  withRequestIdHeader,
  REQUEST_ID_HEADER_NAME,
} from "#src/providers/api/requestIdHeaders.js";
import { buildZCodeSourceHeaders } from "#src/providers/sourceHeaders.js";
import {
  buildOffPeakPlanIdentityHeaders,
  type OffPeakCredentialSnapshot,
} from "./offPeakRuntimeModel.js";

/** 服务端准入态（两轴状态机的服务端轴）。 */
export const offPeakTicketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
export type OffPeakTicketState = z.infer<typeof offPeakTicketStateSchema>;

// 响应字段 snake_case 按服务端 v2；宽容解析（loose），未知字段不报错。
// ⚠ next_poll_after 单位按"秒"实现（与 Retry-After 同惯例）。
const takeTicketResponseSchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    accepted: z.boolean().optional(),
    // 服务端仅在 queued 态返回数字，进入 ready/active 等状态后会显式返回 null；
    // 这里接受 null，并在领域模型映射时归一化为字段缺省，避免整批状态同步被解析失败中断。
    position: z.number().int().nonnegative().nullish(),
    next_poll_after: z.number().nonnegative().optional(),
    queued_at: z.number().optional(),
    ready_deadline: z.number().optional(),
  })
  .passthrough();

const ticketStatusEntrySchema = z
  .object({
    ticket_id: z.string().min(1),
    task_id: z.string().optional(),
    state: offPeakTicketStateSchema,
    position: z.number().int().nonnegative().nullish(),
    active_deadline: z.number().optional(),
  })
  .passthrough();

const batchStatusResponseSchema = z
  .object({
    next_poll_after: z.number().nonnegative().optional(),
    tickets: z.array(ticketStatusEntrySchema).default([]),
  })
  .passthrough();

const settleResponseSchema = z
  .object({
    ticket_id: z.string().min(1).optional(),
    task_id: z.string().optional(),
    state: z.string().optional(),
    settled_at: z.number().optional(),
  })
  .passthrough();

const takeNumberAvailabilityResponseSchema = z
  .object({
    can_take_number: z.boolean(),
    next_take_at: z.number().int().positive().optional(),
  })
  .passthrough();

/** 业务错误体（HTTP 非 2xx 时尽力解析；zai 网关惯例 code/msg，字段缺失容忍）。 */
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export interface OffPeakTakeTicketResult {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  /** 下次轮询间隔（毫秒；服务端下发秒，此处已换算）。 */
  nextPollAfterMs?: number;
  registeredAt: number;
}

export interface OffPeakTicketStatusEntry {
  ticketId: string;
  state: OffPeakTicketState;
  position?: number;
  activeDeadline?: number;
}

export interface OffPeakBatchStatusResult {
  nextPollAfterMs?: number;
  tickets: OffPeakTicketStatusEntry[];
}

/** 类型化服务端错误：调用方按 bizCode 分流（3101 无资格 / 3103 取号超限 / 其余）。 */
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

export interface OffPeakServerClientDeps {
  /** API origin（真实服务端或 mock 网关，ZCODE_OFFPEAK_MOCK 切换在装配层）；mock 网关懒启动故允许异步。 */
  resolveOrigin: () => string | Promise<string>;
  /** 凭证快照：四个 ticket 接口统一携带同一次 selected credential snapshot。 */
  resolveCredentials: () => Promise<OffPeakCredentialSnapshot>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
  /** 宿主的实时界面语言，用于 X-Client-Language；与 NodeApiClient 同源。 */
  resolveClientLanguage?: () => string | undefined;
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface OffPeakServerClient {
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  takeTicket(taskId: string): Promise<OffPeakTakeTicketResult>;
  batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult>;
  settle(ticketId: string): Promise<void>;
}

export function createOffPeakServerClient(deps: OffPeakServerClientDeps): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const origin = await deps.resolveOrigin();
      // 该 client 直接使用 fetch，过去绕过 NodeApiClient 的来源头与 request id 注入；
      // test 服务端只能看到 user_agent=node，且客户端日志无法关联 2007/裸 429 的服务端请求。
      // 这里只补标准非敏感来源头和链路 id，JWT/API Key 仍禁止进入日志。
      const headers = withRequestIdHeader({
        // 以前无参调用，X-Client-Language 回落到进程 Intl 系统语言，与界面语言不一致。
        ...buildZCodeSourceHeaders({ clientLanguage: deps.resolveClientLanguage?.() }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${credentials.jwt}`,
        "x-coding-plan-api-key": credentials.codingPlanApiKey,
        ...buildOffPeakPlanIdentityHeaders(credentials),
      });
      const response = await fetchImpl(`${origin}/api/v1/off-peak${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
        const requestId =
          response.headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          headers.get(REQUEST_ID_HEADER_NAME)?.trim() ||
          undefined;
        // 可恢复的服务端拒绝使用 warn；只记录契约元数据，禁止记录凭证原文、指纹或响应体。
        deps.logger.warn(undefined, "off-peak request rejected", {
          bizCode: errorBody.code,
          credentialKind: credentials.kind,
          httpStatus: response.status,
          method,
          path,
          requestId,
        });
        throw new OffPeakServerError(
          `off-peak ${path} failed: HTTP ${response.status}${errorBody.code ? ` code=${errorBody.code}` : ""}${(errorBody.msg ?? errorBody.message) ? ` ${errorBody.msg ?? errorBody.message}` : ""}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
          requestId,
        );
      }
      // 兼容裸体与 {code:0,data} 信封两种形态（v2 文档为裸体；网关惯例可能包信封）。
      if (
        json &&
        typeof json === "object" &&
        "data" in json &&
        (json as { code?: number }).code === 0
      ) {
        return (json as { data: unknown }).data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getTakeNumberAvailability() {
      const raw = await request("GET", "/ticket/availability");
      const parsed = takeNumberAvailabilityResponseSchema.parse(raw);
      // 缺少恢复时间的 false 快照会让 UI 无法安排重查，再次形成永久灰态。
      // 契约要求 false 必带 next_take_at；脏响应按查询失败处理，由 UI fail-open、POST /ticket 兜底。
      if (!parsed.can_take_number && parsed.next_take_at === undefined) {
        throw new Error("off-peak availability missing next_take_at while unavailable");
      }
      return {
        canTakeNumber: parsed.can_take_number,
        ...(parsed.next_take_at !== undefined ? { nextTakeAt: parsed.next_take_at } : {}),
      };
    },
    async takeTicket(taskId) {
      const raw = await request("POST", "/ticket", { task_id: taskId });
      const parsed = takeTicketResponseSchema.parse(raw);
      deps.logger.info(
        undefined,
        `off-peak take ticket ok task=${taskId} ticket=${parsed.ticket_id} state=${parsed.state} position=${parsed.position ?? "-"}`,
      );
      return {
        ticketId: parsed.ticket_id,
        state: parsed.state,
        ...(parsed.position != null ? { position: parsed.position } : {}),
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds) {
      if (ticketIds.length === 0) return { tickets: [] };
      // 契约上限 ≤100；调用方 listNonTerminal 规模远小于此，超限截断并警告而非拆包。
      // 单用户非终态任务数达到 100 前，服务端取号上限早就先挡住了。
      const limited = ticketIds.slice(0, 100);
      if (limited.length < ticketIds.length) {
        deps.logger.warn(`off-peak batch status truncated ${ticketIds.length} -> 100`);
      }
      const raw = await request("POST", "/ticket/status", {
        ticket_ids: limited,
      });
      const parsed = batchStatusResponseSchema.parse(raw);
      return {
        ...(parsed.next_poll_after !== undefined
          ? { nextPollAfterMs: parsed.next_poll_after * 1000 }
          : {}),
        tickets: parsed.tickets.map((entry) => ({
          ticketId: entry.ticket_id,
          state: entry.state,
          ...(entry.position != null ? { position: entry.position } : {}),
          ...(entry.active_deadline !== undefined ? { activeDeadline: entry.active_deadline } : {}),
        })),
      };
    },
    async settle(ticketId) {
      // 幂等：重复上报/未知票一律 2xx；无 body。
      const raw = await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
      settleResponseSchema.parse(raw);
      deps.logger.info(undefined, `off-peak settle acked ticket=${ticketId}`);
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
