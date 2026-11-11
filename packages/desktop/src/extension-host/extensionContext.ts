import { randomUUID } from "node:crypto";
import {
  ExtensionError,
  isLocallyWrappedCapability,
  listCapabilities,
  scopeInputSchema,
  slotItemPatchSchema,
  slotScopeKey,
  type CapabilityContext,
  type CapabilitySubscriptionErrorListener,
  type CommandCall,
  type Disposable,
  type ExtensionCapabilityTable,
  type ExtensionContext,
  type LocallyWrappedCapabilityId,
  type ScopeInput,
  type SlotItemPatch,
  type SlotScopeKey,
  type ViewDefinition,
  type ViewServerFactory,
} from "@zcode/shared/extension-host";
import type { CapabilityClient } from "#src/extension-host/capabilityClient.js";
import { formatLogArgs, hostLog } from "#src/extension-host/runtime.js";

// 按插件创建的 ctx（docs/plugins/extension-host.md §7.1）。ctx 及其子对象冻结；
// 所有注册与监听挂在扩展生命周期上，停用时自动回收；停用后再调用抛 disposed。

/** 注册表为单个扩展提供的落点；激活期间由事务缓存，成功后才生效。 */
export interface ExtensionContextBackend {
  readonly pluginId: string;
  readonly version: string;
  readonly rootPath: string;
  /** 插件数据目录（§18.1 H6）；激活前已建好。 */
  readonly dataPath: string;
  isCommandDeclared(id: string): boolean;
  isSlotItemDeclared(id: string): boolean;
  isViewDeclared(id: string): boolean;
  /** 返回注销函数。 */
  registerCommand(id: string, run: (call: CommandCall) => unknown): () => void;
  /** 返回注销函数。 */
  registerView(id: string, view: ViewDefinition | ViewServerFactory): () => void;
  updateSlot(itemId: string, patch: SlotItemPatch, scopeKey: SlotScopeKey): void;
}

export interface ExtensionContextHandle {
  readonly ctx: ExtensionContext;
  readonly disposed: boolean;
  dispose(): void;
}

/**
 * 带请求身份的写动作（§17.3 实现 P3c-1）：插件没传 requestId 时在这里补一个。插件要靠幂等重试时自己传，
 * 重试传同一个。入参不是对象时原样交给网关，由能力表的 schema 报 invalid-input。
 */
function withRequestId(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if ((input as { requestId?: unknown }).requestId !== undefined) return input;
  return { ...input, requestId: randomUUID() };
}

function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function createExtensionContext(
  backend: ExtensionContextBackend,
  capabilities: CapabilityClient,
): ExtensionContextHandle {
  let disposed = false;
  const owned = new Set<Disposable>();
  const assertLive = (what: string) => {
    if (disposed) throw new ExtensionError("disposed", `${what}: extension is deactivated`);
  };
  const own = (dispose: () => void): Disposable => {
    let done = false;
    const disposable: Disposable = {
      dispose() {
        if (done) return;
        done = true;
        owned.delete(disposable);
        dispose();
      },
    };
    owned.add(disposable);
    return disposable;
  };
  const log =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]) => {
      // 日志在停用后也允许写，便于 deactivate 末尾留痕；只有注册类调用受 disposed 约束。
      hostLog(level, formatLogArgs(args), backend.pluginId);
    };

  // 能力部分：按能力表由同一组通用包装生成。本地包装的能力（views.open）在下面的本地部分。
  const namespaces: Record<string, Record<string, unknown>> = {};
  for (const [capabilityId, def] of listCapabilities()) {
    if (isLocallyWrappedCapability(capabilityId)) continue;
    const [namespace, name] = capabilityId.split(".", 2) as [string, string];
    const target = (namespaces[namespace] ??= {});
    target[name] =
      def.kind === "call"
        ? (input?: unknown) => {
            assertLive(capabilityId);
            return capabilities.call(
              backend.pluginId,
              capabilityId,
              def.requestIdentity ? withRequestId(input) : input,
            );
          }
        : (...args: unknown[]) => {
            assertLive(capabilityId);
            // 带入参的订阅是 (input, listener, onError?)，没有入参的是 (listener, onError?)（§17.3）。
            // 第一个参数是函数就没有入参；入参由能力表的 schema 在 subscribe 里校验，不按能力名分支。
            const withInput = typeof args[0] !== "function";
            const input = withInput ? args[0] : undefined;
            const listener = args[withInput ? 1 : 0];
            const onError = args[withInput ? 2 : 1];
            if (typeof listener !== "function") {
              throw new ExtensionError("invalid-input", `${capabilityId} expects a listener`);
            }
            if (onError !== undefined && typeof onError !== "function") {
              throw new ExtensionError(
                "invalid-input",
                `${capabilityId} onError must be a function`,
              );
            }
            const subscription = capabilities.subscribe(
              backend.pluginId,
              capabilityId,
              input,
              listener as (event: unknown) => void,
              onError as CapabilitySubscriptionErrorListener | undefined,
            );
            return own(() => subscription.dispose());
          };
  }

  const ctx = {
    extension: {
      id: backend.pluginId,
      version: backend.version,
      path: backend.rootPath,
      dataPath: backend.dataPath,
    },
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    commands: {
      register(id: string, run: (call: CommandCall) => unknown): Disposable {
        assertLive("commands.register");
        if (!backend.isCommandDeclared(id)) {
          throw new ExtensionError(
            "not-declared",
            `command is not declared in the manifest: ${id}`,
          );
        }
        if (typeof run !== "function") {
          throw new ExtensionError("invalid-input", "commands.register expects a function");
        }
        return own(backend.registerCommand(id, run));
      },
    },
    slots: {
      update(itemId: string, patch: SlotItemPatch, scope?: unknown): void {
        assertLive("slots.update");
        if (!backend.isSlotItemDeclared(itemId)) {
          throw new ExtensionError(
            "not-declared",
            `slot item is not declared in the manifest: ${itemId}`,
          );
        }
        const parsedPatch = slotItemPatchSchema.safeParse(patch);
        if (!parsedPatch.success) {
          throw new ExtensionError(
            "invalid-input",
            `slots.update patch: ${parsedPatch.error.message}`,
          );
        }
        const parsedScope = scope === undefined ? undefined : scopeInputSchema.safeParse(scope);
        if (parsedScope && !parsedScope.success) {
          throw new ExtensionError(
            "invalid-input",
            `slots.update scope: ${parsedScope.error.message}`,
          );
        }
        backend.updateSlot(itemId, parsedPatch.data, slotScopeKey(parsedScope?.data));
      },
    },
    views: {
      register(id: string, view: ViewDefinition | ViewServerFactory): Disposable {
        assertLive("views.register");
        if (!backend.isViewDeclared(id)) {
          throw new ExtensionError("not-declared", `view is not declared in the manifest: ${id}`);
        }
        const helperForm =
          view &&
          typeof view === "object" &&
          typeof (view as ViewDefinition).entry === "string" &&
          ["undefined", "function"].includes(typeof (view as ViewDefinition).onDidOpen);
        if (typeof view !== "function" && !helperForm) {
          throw new ExtensionError(
            "invalid-input",
            "views.register expects a ViewDefinition with entry (and an optional onDidOpen function) or a server factory",
          );
        }
        return own(backend.registerView(id, view));
      },
      open(id: string, scope?: ScopeInput): Promise<void> {
        assertLive("views.open");
        if (!backend.isViewDeclared(id)) {
          return Promise.reject(
            new ExtensionError("not-declared", `view is not declared in the manifest: ${id}`),
          );
        }
        return capabilities
          .call(backend.pluginId, "views.open", { viewId: id, ...(scope ? { scope } : {}) })
          .then(() => undefined);
      },
    },
    ...(namespaces as CapabilityContext<
      Omit<ExtensionCapabilityTable, LocallyWrappedCapabilityId>
    >),
  } satisfies ExtensionContext;

  return {
    ctx: deepFreeze(ctx),
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of owned) disposable.dispose();
    },
  };
}
