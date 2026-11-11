import {
  ExtensionError,
  getCapabilityDef,
  isExtensionError,
  type ExtensionAuditEntry,
  type ExtensionErrorCode,
  type ExtensionGrant,
} from "@zcode/shared/extension-host";
import {
  SessionControlError,
  type AppSessionControl,
  type AppTrustedContext,
  type SessionControlErrorCode,
} from "@zcode/session-control/contracts";
import type {
  AppControlClientBinding,
  AppControlServiceHandle,
} from "#src/app-control/contract.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { buildSessionWriteAudit } from "#src/extensions/sessionsAudit.js";

// 会话能力的后端（docs/plugins/extension-host.md §17.2、§17.3，① 调现有服务）：扩展以客户端类调用方
// 调 session-control facade，与模型的会话控制工具同一份 AppControlService。业务层只知道「可信的非会话
// 客户端」，不知道插件；插件 id 只出现在 clientId 与 connectionId 里，用于归因（§7.3）。
//
//   网关（已查表、校验、查声明与授权）──► run(call, capabilityId, invoke)
//       ├─ bindClient({ clientId: extension:<pluginId>, connectionId: extension-host:<gen>:<pluginId> })
//       │     assertCurrent：代际没变、未释放、授权仍在
//       ├─ invoke(ctx, control) ──► AppSessionControl（授权、owner 调用、输出复验）
//       └─ 错误按名映射成 ExtensionError；结束时再查一次代际与授权
//
// 在途调用按插件登记：换代或断开时全部中止（wait 最长 300 秒，跨 RPC 不能取消）；撤销授权时中止该插件的。

/** 每个插件同时在途的 waitSessions 上限（§17.2）。 */
export const MAX_WAITS_PER_PLUGIN = 4;

const WAIT_CAPABILITY = "sessions.waitSessions";

/** session-control 错误码按名映射（§17.3）；没有对应扩展错误码的归 internal。 */
const SESSION_CONTROL_ERROR_CODES: Partial<Record<SessionControlErrorCode, ExtensionErrorCode>> = {
  invalid_input: "invalid-input",
  forbidden: "forbidden",
  unavailable: "unavailable",
  conflict: "conflict",
  cancelled: "cancelled",
};

export interface SessionsBackendCall {
  pluginId: string;
  /** 调用到达的扩展进程代际。 */
  gen: number;
}

export interface SessionsBackendDeps {
  /** createLocalServices 交出的会话控制 facade；没有时会话能力报 unavailable。 */
  appControl: AppControlServiceHandle | undefined;
  /** 当前连接的扩展进程代际；没有连接时为 null。 */
  currentGen(): number | null;
  /** 用户授权是否仍覆盖该档位（授权记录的 owner 判断）。 */
  covers(pluginId: string, grant: ExtensionGrant): boolean;
  /** 写动作的审计（§17.8）：每次调用结束写一行；没有时不写。 */
  audit?: { append(entry: Omit<ExtensionAuditEntry, "v" | "ts">): Promise<void> };
  logger: Pick<ServiceLogger, "warn">;
}

/** 审计行的补充字段（§17.12）：由调用在执行中填，结束时写进这次调用的审计行。不含内容。 */
export interface SessionAuditDetails {
  interactionKind?: "permission" | "userInput";
  choice?: string;
  mode?: string;
}

export interface SessionsBackend {
  /**
   * 以插件的客户端身份调一次 facade。capabilityId 决定需要的档位与是否计入 wait 上限。
   * 写档动作的绑定带来源 {kind:"extension", pluginId}（§17.8），结束时按 input 与结果写一行审计。
   */
  run<T>(
    call: SessionsBackendCall,
    capabilityId: string,
    invoke: (ctx: AppTrustedContext, control: AppSessionControl) => Promise<T>,
    input?: unknown,
    details?: SessionAuditDetails,
  ): Promise<T>;
  /** 授权撤销或收窄：中止该插件在途的调用（结束时报 not-granted）。 */
  abortPlugin(pluginId: string): void;
  /** 换代或断开：中止全部在途调用。 */
  abortAll(): void;
}

interface InFlight {
  controller: AbortController;
  wait: boolean;
}

export function createSessionsBackend(deps: SessionsBackendDeps): SessionsBackend {
  const inFlight = new Map<string, Set<InFlight>>();

  const register = (pluginId: string, entry: InFlight) => {
    let entries = inFlight.get(pluginId);
    if (!entries) inFlight.set(pluginId, (entries = new Set()));
    entries.add(entry);
    return () => {
      entries.delete(entry);
      if (entries.size === 0 && inFlight.get(pluginId) === entries) inFlight.delete(pluginId);
    };
  };

  const toExtensionError = (error: unknown, capabilityId: string): ExtensionError => {
    if (error instanceof ExtensionError) return error;
    if (isExtensionError(error)) return new ExtensionError(error.code, error.message);
    if (error instanceof SessionControlError) {
      const code = SESSION_CONTROL_ERROR_CODES[error.code];
      // session-control 的错误文案是固定文本，不含路径与正文，可以交给扩展。
      if (code) return new ExtensionError(code, error.message);
      deps.logger.warn(undefined, `${capabilityId} failed with session-control ${error.code}`);
      return new ExtensionError("internal", `${capabilityId} failed`);
    }
    // 原始错误文本可能带路径或远端地址：日志只记类型，不记文本。
    deps.logger.warn(
      undefined,
      `${capabilityId} failed (${error instanceof Error ? error.name : typeof error})`,
    );
    return new ExtensionError("internal", `${capabilityId} failed`);
  };

  return {
    async run(call, capabilityId, invoke, input, details) {
      const def = getCapabilityDef(capabilityId);
      const grant = def?.grant;
      if (!grant || grant === "none")
        throw new ExtensionError("internal", `${capabilityId} is not a session capability`);
      const handle = deps.appControl;
      if (!handle) throw new ExtensionError("unavailable", "session control is unavailable");
      const { pluginId, gen } = call;
      const wait = capabilityId === WAIT_CAPABILITY;
      const write = grant === "sessions.write";
      if (wait) {
        const waits = [...(inFlight.get(pluginId) ?? [])].filter((entry) => entry.wait).length;
        if (waits >= MAX_WAITS_PER_PLUGIN)
          throw new ExtensionError(
            "limit-exceeded",
            `at most ${MAX_WAITS_PER_PLUGIN} waitSessions calls may be in flight per plugin`,
          );
      }
      // 结束时以这个函数为准：调用过程中换代、撤销授权，结果都不再交给扩展。
      const assertAllowed = () => {
        if (deps.currentGen() !== gen)
          throw new ExtensionError("cancelled", "the extension host generation changed");
        if (!deps.covers(pluginId, grant))
          throw new ExtensionError("not-granted", `${grant} is not granted`);
      };
      const entry: InFlight = { controller: new AbortController(), wait };
      const unregister = register(pluginId, entry);
      const binding: AppControlClientBinding = {
        kind: "client",
        // 跨代际不变，是幂等键的一部分；connectionId 每代际不同，是 fence。
        clientId: `extension:${pluginId}`,
        connectionId: `extension-host:${gen}:${pluginId}`,
        sourceServerId: handle.sourceServerId,
        // 来源只由这里（网关一侧）注入；渲染进程与手机发来的 extension 来源由连接作用域拒绝。
        ...(write ? { inputSource: { kind: "extension" as const, pluginId } } : {}),
        signal: entry.controller.signal,
        assertCurrent: assertAllowed,
      };
      const startedAt = Date.now();
      const audit = (outcome: { result?: unknown; errorCode?: string }) => {
        if (!write || !deps.audit) return;
        void deps.audit.append(
          buildSessionWriteAudit({
            pluginId,
            gen,
            capability: capabilityId,
            sourceServerId: handle.sourceServerId,
            input,
            ...outcome,
            ...(details ? { details } : {}),
            durationMs: Date.now() - startedAt,
          }),
        );
      };
      try {
        assertAllowed();
        const ctx = await handle.service.bindClient(binding);
        const result = await invoke(ctx, handle.service.control);
        assertAllowed();
        audit({ result });
        return result;
      } catch (error) {
        let failure: ExtensionError;
        try {
          // 换代或撤销授权导致的失败按当前状态报告（cancelled / not-granted），不报底层的取消原因。
          assertAllowed();
          failure = toExtensionError(error, capabilityId);
        } catch (current) {
          failure = toExtensionError(current, capabilityId);
        }
        audit({ errorCode: failure.code });
        throw failure;
      } finally {
        unregister();
      }
    },
    abortPlugin(pluginId) {
      for (const entry of inFlight.get(pluginId) ?? []) entry.controller.abort();
    },
    abortAll() {
      for (const entries of inFlight.values()) {
        for (const entry of entries) entry.controller.abort();
      }
    },
  };
}
