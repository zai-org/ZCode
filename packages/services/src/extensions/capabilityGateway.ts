import type { Event, IDisposable } from "@zcode/rpc";
import {
  ExtensionError,
  capabilityCallInputSchema,
  capabilitySubscribeInputSchema,
  getCapabilityDef,
  grantsCover,
  isExtensionError,
  isProtocolCompatible,
  type CapabilityDef,
  type CapabilityId,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilitySubscriptionMessage,
  type ExtensionCapabilityTable,
  type ExtensionGrant,
  type ExtensionProtocols,
  type IExtensionWindowChannel,
} from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  CapabilityCallContext,
  CapabilitySubscription,
} from "#src/extensions/capabilityTypes.js";
import type { SessionsBackend } from "#src/extensions/sessionsBackend.js";
import type { SessionReads } from "#src/extensions/sessionReads.js";
import type { SessionControls } from "#src/extensions/sessionControls.js";
import type { ContextPump } from "#src/extensions/contextPump.js";
import type { ExtensionDraftRelay } from "#src/extensions/draftRelay.js";
import type { GrantRequestRelay } from "#src/extensions/grantRequestRelay.js";
import type { NotificationRelay } from "#src/extensions/notificationRelay.js";
import type { PluginProjects } from "#src/extensions/pluginProjects.js";
import type { EnvState } from "#src/extensions/envState.js";
import type { GenerationPump } from "#src/extensions/generationPump.js";
import type { ModelsBackend } from "#src/extensions/modelsBackend.js";
import type { SettingsBackend } from "#src/extensions/settingsBackend.js";
import type { ExtensionViewRelay } from "#src/extensions/viewRelay.js";
import type { WorkbenchState } from "#src/extensions/workbenchState.js";

// 能力网关（docs/plugins/extension-host.md §3.5、§7.2、§17.1）：插件访问 App 的唯一入口。
// 收到 call / subscribe 后依次：查表 → 按 input 校验 → 清单声明了档位吗（not-declared）→
// 声明的协议版本对得上吗（incompatible）→ 用户授权了吗（not-granted）→ 审计 → 分派。
// 新增一个能力只改两处：协议里的能力表加一行，这里的处理函数表加一项。

export type { CapabilityCallContext, CapabilitySubscription };

export type CapabilityHandler<K extends CapabilityId> =
  ExtensionCapabilityTable[K]["kind"] extends "call"
    ? (input: CapabilityInput<K>, call: CapabilityCallContext) => Promise<CapabilityOutput<K>>
    : (
        input: CapabilityInput<K>,
        call: CapabilityCallContext,
      ) => CapabilitySubscription<CapabilityOutput<K>>;

/** 处理函数表：少写一个能力就编译失败。 */
export type CapabilityHandlerMap = { [K in CapabilityId]: CapabilityHandler<K> };

/**
 * 处理函数按 §3.5 的三块后端分派：① 调现有服务（settings、sessions、models.list）、② 数据泵（context、models）、
 * ③ 请 Renderer（workbench、env、views、drafts、grants.request、notifications.show）。
 */
export interface CapabilityBackends {
  workbench: WorkbenchState;
  env: EnvState;
  context: ContextPump;
  generation: GenerationPump;
  models: ModelsBackend;
  views: ExtensionViewRelay;
  settings: SettingsBackend;
  sessions: SessionsBackend;
  /** 插件项目（§17.4，P3c-2）：createSession 不带 project 时用。 */
  pluginProjects: PluginProjects;
  /** 会话读连接（§17.5，P3b）：列表泵、会话镜像与 readRows。 */
  reads: SessionReads;
  /** 插件项目里的会话：回答审批与提问、切换权限模式（§17.12，P3e）。 */
  controls: SessionControls;
  drafts: ExtensionDraftRelay;
  grantRequests: GrantRequestRelay;
  notifications: NotificationRelay;
}

export function createCapabilityHandlers(backends: CapabilityBackends) {
  return {
    "context.get": (input) => backends.context.get(input.sessionId),
    "context.onDidChange": () => backends.context.onDidChange,
    "models.onDidGenerate": () => backends.generation.onDidGenerate,
    "models.list": () => backends.models.list(),
    "workbench.visibleSessions": async () => backends.workbench.sessions(),
    // 订阅后的第一个事件是整份列表（重新订阅也一样），之后只在列表变化时推。
    "workbench.onDidChange": () => (listener) => {
      listener({ sessions: backends.workbench.sessions() });
      return backends.workbench.onDidChangeSessions((sessions) => listener({ sessions }));
    },
    // 请 Renderer 开预填草稿并等回执（§18.1 H2）；插件 id 只用于日志归因。
    "workbench.startDraft": (input, call) => backends.drafts.requestStart(call.pluginId, input),
    // 语言只在 Renderer：还没有报告过时没有可信的值，按 host-unavailable 处理（与 views.open 相同）。
    "env.get": async () => {
      const env = backends.env.current();
      if (!env)
        throw new ExtensionError("host-unavailable", "no window has reported the app environment");
      return env;
    },
    // 订阅后的第一个事件是当前值（已报告过时），之后只在变化时推。
    "env.onDidChange": () => (listener) => {
      const env = backends.env.current();
      if (env) listener(env);
      return backends.env.onDidChange(listener);
    },
    "views.open": (input, call) => backends.views.requestOpen(call.pluginId, input),
    // 只问调用方自己的插件（§18.1 H12）：插件 id 来自网关，入参里没有。
    "grants.request": (_input, call) => backends.grantRequests.request(call.pluginId),
    // 网关已查 notifications 档位；插件 id 来自网关（§18.1 H8）。
    "notifications.show": (input, call) => backends.notifications.show(call.pluginId, input),
    // 只给调用方自己的插件：插件 id 来自网关，入参里没有（§16.7）。
    "settings.get": (_input, call) => backends.settings.get(call.pluginId),
    "settings.onDidChange": (_input, call) => backends.settings.onDidChange(call.pluginId),
    // 会话 facade 的四个读（§17.3）：插件以客户端类调用方调用，与模型工具同一份 AppControlService。
    "sessions.listProjects": (input, call) =>
      backends.sessions.run(call, "sessions.listProjects", (ctx, control) =>
        control.listProjects(ctx, input),
      ),
    "sessions.listSessions": (input, call) =>
      backends.sessions.run(call, "sessions.listSessions", (ctx, control) =>
        control.listSessions(ctx, input),
      ),
    "sessions.readSession": (input, call) =>
      backends.sessions.run(call, "sessions.readSession", (ctx, control) =>
        control.readSession(ctx, input),
      ),
    "sessions.waitSessions": (input, call) =>
      backends.sessions.run(call, "sessions.waitSessions", (ctx, control) =>
        control.waitSessions(ctx, input),
      ),
    // 会话 facade 的八个写（§17.3，P3c）：同一个后端注入来源 {kind:"extension"}，每次调用写一行审计。
    // 不带 project 时先找（或新建）插件项目，再按带 project 的普通调用进 facade（§17.4，P3c-2）。
    // 放在 invoke 里：建项目的失败与其他失败一样按错误码映射、写进审计。
    // 带 mode 时（§17.12）：只能建在插件项目里（与切换权限模式同一范围），完全访问另要 sessions.fullAccess。
    "sessions.createSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.createSession",
        async (ctx, control) => {
          if (input.mode === "yolo") backends.controls.assertFullAccess(call.pluginId);
          if (input.mode && input.project) {
            const allowed = await backends.pluginProjects.projectIds(call.pluginId);
            if (!allowed.has(input.project.projectId))
              throw new ExtensionError(
                "forbidden",
                "a permission mode can only be chosen for sessions in the plugin's project",
              );
          }
          return control.createSession(ctx, {
            ...input,
            project: input.project ?? (await backends.pluginProjects.ensure(call.pluginId)),
          });
        },
        input,
      ),
    "sessions.forkSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.forkSession",
        (ctx, control) => control.forkSession(ctx, input),
        input,
      ),
    "sessions.sendToSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.sendToSession",
        (ctx, control) => control.sendToSession(ctx, input),
        input,
      ),
    "sessions.interruptSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.interruptSession",
        (ctx, control) => control.interruptSession(ctx, input),
        input,
      ),
    "sessions.renameSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.renameSession",
        (ctx, control) => control.renameSession(ctx, input),
        input,
      ),
    "sessions.openSession": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.openSession",
        (ctx, control) => control.openSession(ctx, input),
        input,
      ),
    "sessions.setSessionArchived": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.setSessionArchived",
        (ctx, control) => control.setSessionArchived(ctx, input),
        input,
      ),
    "sessions.setSessionPinned": (input, call) =>
      backends.sessions.run(
        call,
        "sessions.setSessionPinned",
        (ctx, control) => control.setSessionPinned(ctx, input),
        input,
      ),
    // 会话读连接（§17.5）：列表来自控制器投影，正文来自按会话共享的镜像，readRows 走 v4 rows/range。
    "sessions.readRows": (input, call) => backends.reads.readRows(call, input),
    "sessions.onDidChangeList": (_input, call) => backends.reads.onDidChangeList(call),
    "sessions.onDidChangeConversation": (input, call) =>
      backends.reads.onDidChangeConversation(call, input),
    "sessions.onDidChangeRows": (input, call) => backends.reads.onDidChangeRows(call, input),
    // 插件项目里的会话（§17.12）：交互与权限模式来自同一个镜像；回答与切换走界面同一套 V4 命令。
    "sessions.onDidChangeInteractions": (input, call) =>
      backends.reads.onDidChangeInteractions(call, input),
    "sessions.resolveInteraction": (input, call) =>
      backends.controls.resolveInteraction(call, input),
    "sessions.setPermissionMode": (input, call) => backends.controls.setPermissionMode(call, input),
    // 只写调用方自己的插件（§18.1 H1）：插件 id 同样来自网关。
    "settings.update": (input, call) => backends.settings.update(call.pluginId, input),
  } satisfies CapabilityHandlerMap;
}

/** 网关查授权用的两份事实：清单声明（静态表）与用户授权（授权记录）。 */
export interface CapabilityGrantFacts {
  /** 插件清单声明的档位与协议版本；插件不在静态表里或没有合法扩展时为 null。 */
  declared(
    pluginId: string,
  ): { grants: readonly ExtensionGrant[]; protocols: ExtensionProtocols } | null;
  /** 用户授权是否覆盖该档位。 */
  granted(pluginId: string, grant: ExtensionGrant): boolean;
  /** 清单声明或用户授权可能变了（静态表重读、授予、撤销）：网关据此复查开着的订阅。 */
  onDidChange: Event<void>;
}

/**
 * 一条连接（一代扩展进程）上的网关。gen 来自连接本身，处理函数据此构造 fence，旧代际的在途调用
 * 在换代后不会被当作新代际的调用。
 */
export function createCapabilityGateway(
  handlers: CapabilityHandlerMap,
  facts: CapabilityGrantFacts,
  logger: Pick<ServiceLogger, "debug">,
  gen: number,
): IExtensionWindowChannel {
  /** 清单声明了档位吗 → 协议版本对得上吗 → 用户授权了吗。订阅开着时授权变化也按它复查。 */
  const assertGranted = (pluginId: string, capabilityId: string, def: CapabilityDef) => {
    if (def.grant === "none") return;
    const declared = facts.declared(pluginId);
    if (!declared || !grantsCover(declared.grants, def.grant)) {
      throw new ExtensionError(
        "not-declared",
        `${capabilityId} needs ${def.grant}; declare it in extension.grants`,
      );
    }
    if (def.protocol && !isProtocolCompatible(declared.protocols, def.protocol)) {
      throw new ExtensionError(
        "incompatible",
        `${capabilityId}: extension.protocols.${def.protocol} does not match this host`,
      );
    }
    if (!facts.granted(pluginId, def.grant)) {
      throw new ExtensionError("not-granted", `${capabilityId} needs ${def.grant}`);
    }
  };
  const admit = (raw: unknown, kind: "call" | "subscribe") => {
    const parsed = (
      kind === "call" ? capabilityCallInputSchema : capabilitySubscribeInputSchema
    ).safeParse(raw);
    if (!parsed.success) throw new ExtensionError("invalid-input", parsed.error.message);
    const { pluginId, capabilityId, input } = parsed.data;
    const def = getCapabilityDef(capabilityId);
    if (!def || def.kind !== kind) {
      throw new ExtensionError("not-declared", `unknown capability: ${capabilityId}`);
    }
    const checked = def.input.safeParse(input);
    if (!checked.success) {
      throw new ExtensionError("invalid-input", `${capabilityId}: ${checked.error.message}`);
    }
    assertGranted(pluginId, capabilityId, def);
    // 调用按 debug 记一行（不含入参）。写动作的审计文件由会话后端在调用结束时写（§17.8）。
    if (kind === "call") {
      logger.debug(undefined, `audit call ${capabilityId} plugin=${pluginId} gen=${gen}`);
    }
    const handler = (handlers as Record<string, unknown>)[capabilityId];
    if (typeof handler !== "function") {
      throw new ExtensionError("internal", `capability has no handler: ${capabilityId}`);
    }
    return {
      handler: handler as (input: unknown, call: CapabilityCallContext) => unknown,
      input: checked.data,
      pluginId,
      capabilityId,
      def,
    };
  };
  const toMessage = (error: unknown, capabilityId: string): CapabilitySubscriptionMessage => {
    if (isExtensionError(error)) return { kind: "error", code: error.code, message: error.message };
    // 原始错误文本可能带路径：只交给扩展固定文案。
    return { kind: "error", code: "internal", message: `${capabilityId} failed` };
  };
  return {
    async call(raw) {
      const { handler, input, pluginId } = admit(raw, "call");
      return handler(input, { pluginId, gen });
    },
    // 事件是信封（§17.3「订阅的错误」）：准入被拒、后端 fail、授权撤销都以一条 error 结束这次订阅。
    // 原先准入错误直接抛出，只在扩展进程的 RPC 层打一行日志，扩展收不到。
    onDynamicSubscribe(raw) {
      return (listener) => {
        const label = (() => {
          const parsed = capabilitySubscribeInputSchema.safeParse(raw);
          return parsed.success
            ? `${parsed.data.capabilityId} plugin=${parsed.data.pluginId} gen=${gen}`
            : `invalid gen=${gen}`;
        })();
        let admitted: ReturnType<typeof admit>;
        try {
          admitted = admit(raw, "subscribe");
        } catch (error) {
          const message = toMessage(error, "subscription");
          logger.debug(
            undefined,
            `subscription rejected ${label} ${message.kind === "error" ? message.code : ""}`,
          );
          listener(message);
          return { dispose() {} };
        }
        const { handler, input, pluginId, capabilityId, def } = admitted;
        let closed = false;
        let inner: IDisposable | null = null;
        let grantWatch: IDisposable | null = null;
        const close = () => {
          closed = true;
          inner?.dispose();
          inner = null;
          grantWatch?.dispose();
          grantWatch = null;
        };
        const end = (error: unknown) => {
          if (closed) return;
          close();
          const message = toMessage(error, capabilityId);
          // 订阅只记开始与结束（debug，§17.8），不记事件内容。
          logger.debug(
            undefined,
            `subscription ended ${label} ${message.kind === "error" ? message.code : ""}`,
          );
          listener(message);
        };
        const subscribe = handler(input, { pluginId, gen }) as CapabilitySubscription<unknown>;
        try {
          const subscription = subscribe((event) => {
            if (!closed) listener({ kind: "event", event });
          }, end);
          // 后端可能在登记时同步 fail（例如超过上限）：此时补释放。
          if (closed) subscription.dispose();
          else inner = subscription;
        } catch (error) {
          end(error);
          return { dispose() {} };
        }
        if (!closed && def.grant !== "none") {
          grantWatch = facts.onDidChange(() => {
            try {
              assertGranted(pluginId, capabilityId, def);
            } catch (error) {
              end(error);
            }
          });
        }
        if (!closed) logger.debug(undefined, `subscription open ${label}`);
        return {
          dispose() {
            if (closed) return;
            close();
            logger.debug(undefined, `subscription close ${label}`);
          },
        };
      };
    },
  };
}
