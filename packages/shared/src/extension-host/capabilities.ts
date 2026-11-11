import { z } from "zod";
import {
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appProjectRefSchema,
  appInterruptSessionInputSchema,
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appListSessionsResultSchema,
  appOpenSessionInputSchema,
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appSendToSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  appWaitSessionsInputSchema,
  createSessionResultSchema,
  forkSessionResultSchema,
  listProjectsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  waitSessionsResultSchema,
} from "@zcode/session-control/contracts";
import { contextCompositionSchema } from "#src/zcode-protocol-v4/context-composition/contract.js";
import { EXTENSION_ERROR_CODES, type ExtensionError } from "#src/extension-host/errors.js";
import {
  extensionGrantSchema,
  type CapabilityGrant,
  type ExtensionProtocolName,
} from "#src/extension-host/grants.js";
import { extensionEnvSchema } from "#src/extension-host/env.js";
import { generationMetricsSchema } from "#src/extension-host/generation.js";
import { extensionModelListSchema } from "#src/extension-host/models.js";
import {
  notificationsShowInputSchema,
  notificationsShowResultSchema,
} from "#src/extension-host/notifications.js";
import { extensionLocalIdSchema } from "#src/extension-host/manifest.js";
import {
  extensionSettingsSchema,
  extensionSettingsUpdateSchema,
} from "#src/extension-host/settings.js";
import {
  sessionConversationEventSchema,
  sessionListEventSchema,
  sessionReadRowsInputSchema,
  sessionReadRowsResultSchema,
  sessionRowsEventSchema,
  sessionTargetInputSchema,
} from "#src/extension-host/sessions.js";
import {
  sessionInteractionsEventSchema,
  sessionResolveInteractionInputSchema,
  sessionResolveInteractionResultSchema,
  sessionSetPermissionModeInputSchema,
  sessionSetPermissionModeResultSchema,
} from "#src/extension-host/interactions.js";
import { scopeInputSchema } from "#src/extension-host/slots.js";
import {
  workbenchSessionSchema,
  workbenchStartDraftInputSchema,
} from "#src/extension-host/workbench.js";

// 能力表（docs/plugins/extension-host.md §7.2）：能力的唯一定义。表里没有的能力就不存在。
// 新增一个能力只改两处：这里加一行，Window Host 的能力网关加一个处理函数。

export interface CapabilityDef {
  kind: "call" | "subscribe";
  /** 入参 schema；没有入参用 z.undefined()。 */
  input: z.ZodType;
  /** call 的返回，或 subscribe 的事件。 */
  output: z.ZodType;
  /** §3.5 的三块后端。 */
  backend: "service" | "pump" | "renderer";
  /**
   * 需要的档位（§17.3）。none 不需要授权；其余档位要清单声明（否则 not-declared）且用户授予
   * （否则 not-granted）。write 包含 read。
   */
  grant: CapabilityGrant;
  /** 返回值属于哪个稳定投影（§17.6）。清单声明的版本对不上时报 incompatible。 */
  protocol?: ExtensionProtocolName;
  /**
   * 入参带必填的 `requestId`（幂等键，§17.2）。ctx 的类型把它改成可选，扩展进程的通用包装在插件没传时
   * 补 randomUUID()；按这个标记处理，不按能力名分支。
   */
  requestIdentity?: true;
}

const sessionIdSchema = z.string().min(1).max(200);

/** 键是能力 id `<命名空间>.<名字>`，例如 `context.get`。 */
export const EXTENSION_CAPABILITIES = {
  // context 组成（§9）：会话不在 Renderer 报告里、没有 CLI、旧 CLI 都返回 null。
  "context.get": {
    kind: "call",
    input: z.strictObject({ sessionId: sessionIdSchema }),
    output: contextCompositionSchema.nullable(),
    backend: "pump",
    grant: "none",
  },
  // 只带修订号；扩展按需调 context.get。
  "context.onDidChange": {
    kind: "subscribe",
    input: z.undefined(),
    output: z.strictObject({
      sessionId: sessionIdSchema,
      revision: z.number().int().nonnegative(),
    }),
    backend: "pump",
    grant: "none",
  },
  // 生成速率（§10）：只统计主轮请求。
  "models.onDidGenerate": {
    kind: "subscribe",
    input: z.undefined(),
    output: generationMetricsSchema,
    backend: "pump",
    grant: "none",
  },
  // 已配置的模型（§18.1 H9，① 调现有服务）：与输入框模型选择器同一份视图，隐藏的 provider 已过滤。
  "models.list": {
    kind: "call",
    input: z.undefined(),
    output: extensionModelListSchema,
    backend: "service",
    grant: "none",
  },
  "workbench.visibleSessions": {
    kind: "call",
    input: z.undefined(),
    output: z.array(workbenchSessionSchema),
    backend: "renderer",
    grant: "none",
  },
  // 订阅后的第一个事件是整份列表。
  "workbench.onDidChange": {
    kind: "subscribe",
    input: z.undefined(),
    output: z.strictObject({ sessions: z.array(workbenchSessionSchema) }),
    backend: "renderer",
    grant: "none",
  },
  // 请 Renderer 开一个预填文字的新草稿并等回执（§18.1 H2）：走插件市场「试用」同一条新建任务路径，不自动发送。
  // 回执表示窗口已接手；没有窗口时 host-unavailable。
  "workbench.startDraft": {
    kind: "call",
    input: workbenchStartDraftInputSchema,
    output: z.undefined(),
    backend: "renderer",
    grant: "none",
  },
  // App 环境（§16.11）：Renderer 还没有报告过时抛 host-unavailable。
  "env.get": {
    kind: "call",
    input: z.undefined(),
    output: extensionEnvSchema,
    backend: "renderer",
    grant: "none",
  },
  // 订阅后的第一个事件是当前值（Renderer 已报告过时），之后只在变化时推。
  "env.onDidChange": {
    kind: "subscribe",
    input: z.undefined(),
    output: extensionEnvSchema,
    backend: "renderer",
    grant: "none",
  },
  // 插件设置（§16.7）：只给调用方自己的插件（网关注入插件 id）。值是 user 层有效值，含敏感值；
  // 旧 CLI 没有 plugins/readUserOptions 时只有非敏感值。
  "settings.get": {
    kind: "call",
    input: z.undefined(),
    output: extensionSettingsSchema,
    backend: "service",
    grant: "none",
  },
  // 本插件的 user 层设置保存或重置成功后推一次当前值。订阅后不推初始值，扩展先调 settings.get。
  "settings.onDidChange": {
    kind: "subscribe",
    input: z.undefined(),
    output: extensionSettingsSchema,
    backend: "service",
    grant: "none",
  },
  // 会话 facade 的四个读（§17.3，① 调现有服务）：入参与返回直接用 session-control 的端口 schema，
  // 与模型的会话控制工具同一份定义。调用方是客户端类（AppControlService.bindClient），范围与模型工具一致：
  // 本机 Host 的全部会话可读，已连接来源的会话能列出。
  "sessions.listProjects": {
    kind: "call",
    input: appListProjectsInputSchema,
    output: listProjectsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  "sessions.listSessions": {
    kind: "call",
    input: appListSessionsInputSchema,
    output: appListSessionsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // view: "messages" 的正文是 { id, role, text }（会话投影 v1）。
  "sessions.readSession": {
    kind: "call",
    input: appReadSessionInputSchema,
    output: readSessionResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // 最长 300 秒，跨 RPC 不能取消，只在换代、断开或撤销授权时中止。每个插件同时最多 4 个。
  "sessions.waitSessions": {
    kind: "call",
    input: appWaitSessionsInputSchema,
    output: waitSessionsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // 会话读连接（§17.5，P3b）：完整行取自 v4 rows/range，会话目标经 facade 解析（与 readSession 同一份授权）。
  "sessions.readRows": {
    kind: "call",
    input: sessionReadRowsInputSchema,
    output: sessionReadRowsResultSchema,
    backend: "service",
    grant: "sessions.read",
    protocol: "rows",
  },
  // 列表泵：Window Host 控制器的投影（与侧栏、手机同一份）。第一个事件是 snapshot，之后是 delta。
  "sessions.onDidChangeList": {
    kind: "subscribe",
    input: z.undefined(),
    output: sessionListEventSchema,
    backend: "pump",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // 会话镜像（按会话在插件之间共享）：只推修订号与阶段。
  "sessions.onDidChangeConversation": {
    kind: "subscribe",
    input: sessionTargetInputSchema,
    output: sessionConversationEventSchema,
    backend: "pump",
    grant: "sessions.read",
    protocol: "sessions",
  },
  // 会话镜像推 apply 之后的整行：先 reset，之后 rows；事件过大时 stale。
  "sessions.onDidChangeRows": {
    kind: "subscribe",
    input: sessionTargetInputSchema,
    output: sessionRowsEventSchema,
    backend: "pump",
    grant: "sessions.read",
    protocol: "rows",
  },
  // 回答审批、提问与切换权限模式（§17.12，P3e）：只对插件项目里的会话，档位 sessions.write；
  // 完全访问（yolo 与「允许并切到完全访问」）另外要 sessions.fullAccess，由后端按入参检查。
  // 交互原样是 v4 pendingInteraction（只留 permission / userInput），所以跟 protocols.rows 走。
  "sessions.onDidChangeInteractions": {
    kind: "subscribe",
    input: sessionTargetInputSchema,
    output: sessionInteractionsEventSchema,
    backend: "pump",
    grant: "sessions.write",
    protocol: "rows",
  },
  "sessions.resolveInteraction": {
    kind: "call",
    input: sessionResolveInteractionInputSchema,
    output: sessionResolveInteractionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "rows",
    requestIdentity: true,
  },
  "sessions.setPermissionMode": {
    kind: "call",
    input: sessionSetPermissionModeInputSchema,
    output: sessionSetPermissionModeResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "rows",
    requestIdentity: true,
  },
  // 会话 facade 的八个写（§17.3，P3c）：插件以客户端类调用方调用，入参与返回直接用 session-control 的端口
  // schema。网关注入来源 {kind:"extension", pluginId}；写范围与模型工具一致（只到本机 Host）。每次调用写一行审计。
  // 不带 project 时放进插件项目（§17.4，P3c-2）：由端口 schema 派生，只把 project 改成可选；
  // 模型的工具与 facade 的端口仍要求 project，后端在进入 facade 前填好。
  "sessions.createSession": {
    kind: "call",
    input: appCreateSessionInputSchema.extend({
      project: appProjectRefSchema
        .optional()
        .describe(
          "A project from listProjects, replayed exactly as returned. Omit it to use the plugin's own project.",
        ),
    }),
    output: createSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.forkSession": {
    kind: "call",
    input: appForkSessionInputSchema,
    output: forkSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  // 可带 model（§18.1 H10）：只对客户端类调用方开放，模型的工具面没有这个字段。
  "sessions.sendToSession": {
    kind: "call",
    input: appSendToSessionInputSchema,
    output: sendToSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.interruptSession": {
    kind: "call",
    input: appInterruptSessionInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.renameSession": {
    kind: "call",
    input: appRenameSessionInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  // 在窗口里打开会话（例如带用户去确认审批）；没有 requestId。
  "sessions.openSession": {
    kind: "call",
    input: appOpenSessionInputSchema,
    output: openSessionResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
  },
  "sessions.setSessionArchived": {
    kind: "call",
    input: appSetSessionArchivedInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  "sessions.setSessionPinned": {
    kind: "call",
    input: appSetSessionPinnedInputSchema,
    output: mutationResultSchema,
    backend: "service",
    grant: "sessions.write",
    protocol: "sessions",
    requestIdentity: true,
  },
  // 写本插件的 user 层设置（§18.1 H1）：网关注入插件 id；键与值类型按本插件的 userConfig 校验。
  // 成功后照常经插件管理的成功信号触发 settings.onDidChange，本调用不等通知。
  "settings.update": {
    kind: "call",
    input: extensionSettingsUpdateSchema,
    output: z.undefined(),
    backend: "service",
    grant: "none",
  },
  // 请宿主弹授权对话框（§18.1 H12，③ 请 Renderer）：只问本插件清单声明的档位；已授予或没有声明时不弹。
  // 返回请求结束时本插件生效的档位；用户取消不是错误。
  "grants.request": {
    kind: "call",
    input: z.undefined(),
    output: z.strictObject({ granted: z.array(extensionGrantSchema) }),
    backend: "renderer",
    grant: "none",
  },
  // 系统通知（§18.1 H8，③ 请 Renderer → preload → Main）：要 notifications 档位。不弹不是错误，返回原因；
  // 网关注入插件 id，标题由宿主加插件名前缀。
  "notifications.show": {
    kind: "call",
    input: notificationsShowInputSchema,
    output: notificationsShowResultSchema,
    backend: "renderer",
    grant: "notifications",
  },
  // 请 Renderer 打开扩展视图并等回执（§8）。ctx 上的入口是本地部分的 ctx.views.open。
  "views.open": {
    kind: "call",
    input: z.strictObject({ viewId: extensionLocalIdSchema, scope: scopeInputSchema.optional() }),
    output: z.undefined(),
    backend: "renderer",
    grant: "none",
  },
} as const satisfies Record<string, CapabilityDef>;

/**
 * 由本地部分包装的能力：ctx 上的入口在 ExtensionLocalContext 里（先在扩展进程内校验 id 是否声明），
 * 不由能力表自动生成。
 */
export const LOCALLY_WRAPPED_CAPABILITIES = ["views.open"] as const;
export type LocallyWrappedCapabilityId = (typeof LOCALLY_WRAPPED_CAPABILITIES)[number];

export function isLocallyWrappedCapability(id: string): id is LocallyWrappedCapabilityId {
  return (LOCALLY_WRAPPED_CAPABILITIES as readonly string[]).includes(id);
}

export type ExtensionCapabilityTable = typeof EXTENSION_CAPABILITIES;
export type CapabilityId = keyof ExtensionCapabilityTable & string;
export type CapabilityInput<K extends CapabilityId> = z.input<ExtensionCapabilityTable[K]["input"]>;
export type CapabilityOutput<K extends CapabilityId> = z.output<
  ExtensionCapabilityTable[K]["output"]
>;

export function getCapabilityDef(id: string): CapabilityDef | undefined {
  return Object.hasOwn(EXTENSION_CAPABILITIES, id)
    ? (EXTENSION_CAPABILITIES as Record<string, CapabilityDef>)[id]
    : undefined;
}

export function listCapabilities(): Array<[string, CapabilityDef]> {
  return Object.entries(EXTENSION_CAPABILITIES as Record<string, CapabilityDef>);
}

// —— extension-window 频道的两个通用入口的线格式 ——

export const capabilityCallInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  capabilityId: z.string().min(1),
  // 没有入参的能力传 undefined；跨 RPC 走 JSON 时这个键会消失，所以是可选的。
  input: z.unknown().optional(),
});
export type CapabilityCallInput = z.infer<typeof capabilityCallInputSchema>;

export const capabilitySubscribeInputSchema = capabilityCallInputSchema;
export type CapabilitySubscribeInput = CapabilityCallInput;

/**
 * onDynamicSubscribe 的事件信封（§17.3「订阅的错误」）：event 是能力的事件；error 结束这次订阅
 * （准入被拒、后端上限、授权撤销等），之后不再有事件。
 */
export const capabilitySubscriptionMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), event: z.unknown() }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.enum(EXTENSION_ERROR_CODES),
    message: z.string(),
  }),
]);
export type CapabilitySubscriptionMessage = z.infer<typeof capabilitySubscriptionMessageSchema>;

// —— ctx 能力部分的类型推导：表里加一行，ctx 的类型自动跟上 ——

export interface CapabilityDisposable {
  dispose(): void;
}

/** 订阅结束时的错误（§17.3「订阅的错误」）；之后这个监听不再收到事件。 */
export type CapabilitySubscriptionErrorListener = (error: ExtensionError) => void;

// 带入参的订阅（§17.3）生成 (input, listener, onError?) => Disposable；没有入参的是 (listener, onError?) => Disposable。
/** 带请求身份的动作：`requestId` 在 ctx 上可选，扩展进程补（§17.3 实现 P3c-1）。 */
type CallInput<D extends CapabilityDef> = D["requestIdentity"] extends true
  ? Omit<z.input<D["input"]>, "requestId"> & { requestId?: string }
  : z.input<D["input"]>;

type CapabilityMember<D extends CapabilityDef> = D["kind"] extends "call"
  ? z.input<D["input"]> extends undefined
    ? () => Promise<z.output<D["output"]>>
    : (input: CallInput<D>) => Promise<z.output<D["output"]>>
  : z.input<D["input"]> extends undefined
    ? (
        listener: (event: z.output<D["output"]>) => void,
        onError?: CapabilitySubscriptionErrorListener,
      ) => CapabilityDisposable
    : (
        input: z.input<D["input"]>,
        listener: (event: z.output<D["output"]>) => void,
        onError?: CapabilitySubscriptionErrorListener,
      ) => CapabilityDisposable;

type NamespaceOf<K extends string> = K extends `${infer NS}.${string}` ? NS : never;
type MemberOf<K extends string, NS extends string> = K extends `${NS}.${infer Name}` ? Name : never;

/** 由能力表推导出 ctx 的能力部分：`"context.get"` → `ctx.context.get`。 */
export type CapabilityContext<T extends Record<string, CapabilityDef>> = {
  readonly [NS in NamespaceOf<keyof T & string>]: {
    readonly [K in keyof T & string as MemberOf<K, NS>]: CapabilityMember<T[K]>;
  };
};

/**
 * 能力 K 在 ctx 上的入参（类型包 §17.9）：与 ctx 成员同一份推导，带请求身份的动作 `requestId` 可选。
 * 没有入参的能力为 undefined。不用 CapabilityInput：那是线上 schema 的入参，requestId 必填。
 */
export type ExtensionCapabilityInput<K extends CapabilityId> = CallInput<
  ExtensionCapabilityTable[K]
>;
/** 能力 K 在 ctx 上的返回：call 是 Promise 解出的值，subscribe 是监听收到的事件。 */
export type ExtensionCapabilityOutput<K extends CapabilityId> = z.output<
  ExtensionCapabilityTable[K]["output"]
>;
