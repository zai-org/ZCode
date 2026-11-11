import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ExtensionError,
  applySlotPatch,
  extensionGlobalId,
  type CommandCall,
  type ContributionMessage,
  type CommandInvocation,
  type ContributionSnapshot,
  type ExtensionDeclaration,
  type ExtensionDeclarations,
  type ExtensionModule,
  type ExtensionRunState,
  type OpenViewInput,
  type OpenViewResult,
  type SlotItemPatch,
  type SlotScopeKey,
  type SlotValue,
  type ViewDefinition,
  type ViewServerFactory,
} from "@zcode/shared/extension-host";
import type { CapabilityClient } from "#src/extension-host/capabilityClient.js";
import type { ViewHost } from "#src/extension-host/viewHost.js";
import {
  createExtensionContext,
  type ExtensionContextHandle,
} from "#src/extension-host/extensionContext.js";
import {
  hostLog,
  registerPluginRoot,
  runAsPlugin,
  unregisterPluginRoot,
} from "#src/extension-host/runtime.js";

// 扩展注册表：贡献表的唯一 owner（docs/plugins/extension-host.md §3.4、§6、§12.2、§13、§16.1）。
// 贡献表只有运行状态与插槽动态值：状态变化推整份快照；slots.update 推增量；两者共用 rev，每代际内单调递增。
// 静态声明归 Window Host：本进程不读 plugin.json，只收 Window Host 校验过的扩展声明。

const ACTIVATION_TIMEOUT_MS = 10_000;

interface ExtensionRecord {
  decl: ExtensionDeclaration;
  /** 声明变更判断：整份声明。设置值不在声明里（经能力 settings.* 读），设置变化不重启扩展。 */
  declKey: string;
  activationEvents: Set<string>;
  state: ExtensionRunState;
  reason?: string;
  activation: Promise<void> | null;
  context: ExtensionContextHandle | null;
  module: ExtensionModule | null;
  commands: Map<string, (call: CommandCall) => unknown>;
  views: Map<string, ViewDefinition | ViewServerFactory>;
  /** 本扩展已声明的条目全局 id。 */
  itemIds: Set<string>;
}

/** 激活期间的注册先缓存，成功返回后一起生效。 */
interface ActivationTransaction {
  commands: Map<string, (call: CommandCall) => unknown>;
  views: Map<string, ViewDefinition | ViewServerFactory>;
  values: Map<string, Map<SlotScopeKey, SlotValue | null>>;
}

function declarationKey(decl: ExtensionDeclaration): string {
  return JSON.stringify(decl);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 插件数据目录（docs/plugins/extension-host.md §18.1 H6）：激活前建好，扩展拿到时目录已存在。
 * 声明里没有它说明 plugins/list 来自不报告 dataPath 的旧 CLI。错误只带错误码：路径在用户目录下。
 */
async function ensureDataPath(dataPath: string | undefined): Promise<void> {
  if (!dataPath) throw new Error("the agent did not report the plugin data path; update ZCode");
  try {
    await mkdir(dataPath, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new Error(`could not create the plugin data directory (${code ?? "error"})`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExtensionRegistry {
  private readonly records = new Map<string, ExtensionRecord>();
  /** 本扩展进程内激活失败过的插件：不再激活（§12.2）。 */
  private readonly failedReasons = new Map<string, string>();
  private readonly values = new Map<string, Map<SlotScopeKey, SlotValue>>();
  private readonly listeners = new Set<(message: ContributionMessage) => void>();
  private rev = 0;
  private inventoryChain: Promise<void> = Promise.resolve();
  private restartRequested = false;

  constructor(
    private readonly gen: number,
    private readonly capabilities: CapabilityClient,
    private readonly views: ViewHost,
    private readonly requestRestart: (reason: string) => void,
  ) {}

  onMessage(listener: (message: ContributionMessage) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** 当前快照（不递增 rev）：新连上的一方先收这一份。 */
  snapshot(): ContributionSnapshot {
    const values: ContributionSnapshot["values"] = {};
    for (const [itemId, byScope] of this.values) values[itemId] = Object.fromEntries(byScope);
    return {
      kind: "snapshot",
      gen: this.gen,
      rev: this.rev,
      extensions: [...this.records.values()].map((record) => ({
        pluginId: record.decl.pluginId,
        state: record.state,
        ...(record.reason ? { reason: record.reason } : {}),
      })),
      values,
    };
  }

  setDeclarations(declarations: ExtensionDeclarations): Promise<void> {
    // 声明推送可能连续到达；串行处理，避免两次对比交错。
    const run = this.inventoryChain.then(() => this.applyDeclarations(declarations));
    this.inventoryChain = run.catch(() => {});
    return run;
  }

  /**
   * 执行命令并返回它的返回值（§16.3）：按 JSON 带回 Window Host，由它按插槽的 schema 校验。
   * 不能序列化的返回值（循环引用、BigInt 等）按 undefined 处理，并记一条 warn：
   * 否则 RPC 回包序列化失败，整个调用失败，连 composer.status 的点击也会报错。
   */
  async executeCommand(input: CommandInvocation): Promise<unknown> {
    const { record, localId } = this.findByGlobalId(input.commandId);
    if (!record?.decl.commands.includes(localId)) {
      throw new ExtensionError("not-declared", `command is not declared: ${input.commandId}`);
    }
    await this.ensureActive(record, `onCommand:${localId}`);
    const run = record.commands.get(localId);
    if (!run) {
      throw new ExtensionError(
        "internal",
        `command is declared but not registered: ${input.commandId}`,
      );
    }
    const pluginId = record.decl.pluginId;
    // 带参数的调用是插槽查询（composer.mention 每次按键一次），按根规则不记 info；点击照旧记一条。
    if (!input.args) {
      hostLog("info", `run command ${input.commandId} scope=${input.scope.kind}`, pluginId);
    }
    let result: unknown;
    try {
      result = await runAsPlugin(pluginId, () =>
        run({ scope: input.scope, ...(input.args ? { args: input.args } : {}) }),
      );
    } catch (error) {
      hostLog("error", `command ${input.commandId} failed: ${describe(error)}`, pluginId);
      throw new ExtensionError("internal", `command failed: ${input.commandId}`);
    }
    if (result === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(result)) as unknown;
    } catch (error) {
      hostLog(
        "warn",
        `command ${input.commandId} returned a value that is not JSON: ${describe(error)}`,
        pluginId,
      );
      return undefined;
    }
  }

  /**
   * 打开视图实例（§8）：首次打开按 onView 激活扩展；视图必须已在激活期间注册。
   * 之后的页面请求与关闭由 ViewHost 按实例 id 处理。
   */
  async openView(input: OpenViewInput): Promise<OpenViewResult> {
    const { record, localId } = this.findByGlobalId(input.viewId);
    if (!record?.decl.views.includes(localId)) {
      throw new ExtensionError("not-declared", `view is not declared: ${input.viewId}`);
    }
    await this.ensureActive(record, `onView:${localId}`);
    const view = record.views.get(localId);
    if (!view) {
      throw new ExtensionError("internal", `view is declared but not registered: ${input.viewId}`);
    }
    return this.views.open({
      instanceId: input.instanceId,
      pluginId: record.decl.pluginId,
      viewId: localId,
      rootPath: record.decl.rootPath,
      scope: input.scope,
      ...(input.input ? { input: input.input } : {}),
      view,
    });
  }

  /** 退出与计划重启：所有扩展的 deactivate 共用一个时间预算。 */
  async deactivateAll(budgetMs: number): Promise<void> {
    const records = [...this.records.values()];
    await Promise.race([
      Promise.allSettled(records.map((record) => this.deactivate(record, "host dispose"))),
      new Promise((resolveTimer) => setTimeout(resolveTimer, budgetMs)),
    ]);
  }

  /** 全局 id `<pluginId>/<localId>` → 所属扩展与本地 id。插件 id 里可以有 `/` 以外的任何字符。 */
  private findByGlobalId(globalId: string): { record?: ExtensionRecord; localId: string } {
    const record = [...this.records.values()].find((item) =>
      globalId.startsWith(`${item.decl.pluginId}/`),
    );
    return { record, localId: record ? globalId.slice(record.decl.pluginId.length + 1) : "" };
  }

  /** 按激活事件激活（resolved 时），或等在途激活结束；之后必须是 active。 */
  private async ensureActive(record: ExtensionRecord, event: string): Promise<void> {
    if (record.state === "resolved") await this.activate(record, event);
    else if (record.activation) await record.activation;
    if (record.state !== "active") {
      throw new ExtensionError("internal", `extension ${record.decl.pluginId} is ${record.state}`);
    }
  }

  private async applyDeclarations(declarations: ExtensionDeclarations): Promise<void> {
    let changed = false;
    const seen = new Set<string>();
    const toActivate: ExtensionRecord[] = [];
    for (const decl of declarations.plugins) {
      const { pluginId } = decl;
      seen.add(pluginId);
      const declKey = declarationKey(decl);
      const existing = this.records.get(pluginId);
      if (existing && existing.declKey === declKey) {
        existing.decl = decl;
        continue;
      }
      if (existing && existing.module) {
        // Node 无法卸载已加载的模块：已激活扩展的声明变了，请求 Main 计划重启。
        if (!this.restartRequested) {
          this.restartRequested = true;
          hostLog(
            "info",
            "declaration of an activated extension changed; requesting planned restart",
            pluginId,
          );
          this.requestRestart(`manifest changed: ${pluginId}`);
        }
        continue;
      }
      if (existing) await this.remove(existing, "manifest changed");
      const record = this.createRecord(decl, declKey);
      this.records.set(pluginId, record);
      registerPluginRoot(decl.rootPath, pluginId);
      changed = true;
      hostLog(
        record.state === "resolved" ? "info" : "warn",
        `extension ${record.state}${record.reason ? `: ${record.reason}` : ""}`,
        pluginId,
      );
      if (record.state === "resolved" && record.activationEvents.has("onAvailable")) {
        toActivate.push(record);
      }
    }
    for (const record of this.records.values()) {
      if (seen.has(record.decl.pluginId)) continue;
      await this.remove(record, "plugin disabled, removed or no longer a valid extension");
      changed = true;
    }
    if (changed) this.pushSnapshot("declarations");
    for (const record of toActivate) void this.activate(record, "onAvailable").catch(() => {});
  }

  private createRecord(decl: ExtensionDeclaration, declKey: string): ExtensionRecord {
    const failedReason = this.failedReasons.get(decl.pluginId);
    return {
      decl,
      declKey,
      activationEvents: new Set(decl.activationEvents),
      state: failedReason ? "failed" : "resolved",
      ...(failedReason ? { reason: failedReason } : {}),
      activation: null,
      context: null,
      module: null,
      commands: new Map(),
      views: new Map(),
      itemIds: new Set(decl.slotItems.map((id) => extensionGlobalId(decl.pluginId, id))),
    };
  }

  private activate(record: ExtensionRecord, event: string): Promise<void> {
    if (record.activation) return record.activation;
    if (record.state !== "resolved") return Promise.resolve();
    const main = record.decl.main;
    if (!main) return Promise.resolve();
    const activation = this.runActivation(record, main, event);
    record.activation = activation;
    return activation;
  }

  private async runActivation(record: ExtensionRecord, main: string, event: string): Promise<void> {
    const { pluginId, rootPath } = record.decl;
    record.state = "activating";
    this.pushSnapshot(`activating ${pluginId}`);
    hostLog("info", `activating (${event})`, pluginId);
    const startedAt = Date.now();
    const tx: ActivationTransaction = { commands: new Map(), views: new Map(), values: new Map() };
    const handle = createExtensionContext(
      {
        pluginId,
        version: record.decl.version ?? "0.0.0",
        rootPath,
        dataPath: record.decl.dataPath ?? "",
        isCommandDeclared: (id) => record.decl.commands.includes(id),
        isSlotItemDeclared: (id) => record.itemIds.has(extensionGlobalId(pluginId, id)),
        isViewDeclared: (id) => record.decl.views.includes(id),
        registerView: (id, view) => {
          const target = record.state === "active" ? record.views : tx.views;
          target.set(id, view);
          return () => {
            if (record.views.get(id) === view) record.views.delete(id);
            if (tx.views.get(id) === view) tx.views.delete(id);
          };
        },
        registerCommand: (id, run) => {
          const target = record.state === "active" ? record.commands : tx.commands;
          target.set(id, run);
          return () => {
            if (record.commands.get(id) === run) record.commands.delete(id);
            if (tx.commands.get(id) === run) tx.commands.delete(id);
          };
        },
        updateSlot: (id, patch, scopeKey) => {
          const itemId = extensionGlobalId(pluginId, id);
          if (record.state === "active") this.updateValue(itemId, patch, scopeKey);
          else {
            const byScope = tx.values.get(itemId) ?? new Map<SlotScopeKey, SlotValue | null>();
            const current = byScope.has(scopeKey)
              ? (byScope.get(scopeKey) ?? undefined)
              : this.values.get(itemId)?.get(scopeKey);
            byScope.set(scopeKey, applySlotPatch(current, patch));
            tx.values.set(itemId, byScope);
          }
        },
      },
      this.capabilities,
    );
    record.context = handle;
    try {
      await ensureDataPath(record.decl.dataPath);
      const entry = resolve(rootPath, main);
      const rel = relative(rootPath, entry);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("main resolves outside the plugin root");
      const loaded = (await runAsPlugin(pluginId, () => import(pathToFileURL(entry).href))) as
        | Partial<ExtensionModule>
        | { default?: Partial<ExtensionModule> };
      const module = (
        typeof (loaded as Partial<ExtensionModule>).activate === "function"
          ? loaded
          : (loaded as { default?: Partial<ExtensionModule> }).default
      ) as Partial<ExtensionModule> | undefined;
      if (!module || typeof module.activate !== "function") {
        throw new Error("entry does not export activate()");
      }
      record.module = module as ExtensionModule;
      await withTimeout(
        Promise.resolve(runAsPlugin(pluginId, () => module.activate!(handle.ctx))),
        ACTIVATION_TIMEOUT_MS,
        `activate() did not finish within ${ACTIVATION_TIMEOUT_MS / 1000}s`,
      );
      if (record.context !== handle) return; // 激活期间被移除
      // 提交事务：注册与动态值一起生效，随后推一份快照。
      for (const [id, run] of tx.commands) record.commands.set(id, run);
      for (const [id, view] of tx.views) record.views.set(id, view);
      for (const [itemId, byScope] of tx.values) {
        for (const [scopeKey, value] of byScope) this.setValue(itemId, scopeKey, value);
      }
      record.state = "active";
      record.activation = null;
      hostLog("info", `activated in ${Date.now() - startedAt}ms`, pluginId);
      this.pushSnapshot(`activated ${pluginId}`);
    } catch (error) {
      handle.dispose();
      if (record.context !== handle) return;
      record.context = null;
      record.commands.clear();
      record.views.clear();
      record.state = "failed";
      record.reason = describe(error);
      record.activation = null;
      this.failedReasons.set(pluginId, record.reason);
      this.clearValues(record);
      hostLog("error", `activation failed: ${record.reason}`, pluginId);
      this.pushSnapshot(`failed ${pluginId}`);
    }
  }

  private async deactivate(record: ExtensionRecord, reason: string): Promise<void> {
    const handle = record.context;
    record.context = null;
    const module = record.module;
    if (module?.deactivate && record.state === "active") {
      try {
        await runAsPlugin(record.decl.pluginId, () => module.deactivate!());
      } catch (error) {
        hostLog("warn", `deactivate failed: ${describe(error)}`, record.decl.pluginId);
      }
    }
    handle?.dispose();
    record.commands.clear();
    record.views.clear();
    await this.views.closePlugin(record.decl.pluginId);
    this.clearValues(record);
    if (handle) hostLog("info", `deactivated (${reason})`, record.decl.pluginId);
  }

  private async remove(record: ExtensionRecord, reason: string): Promise<void> {
    this.records.delete(record.decl.pluginId);
    unregisterPluginRoot(record.decl.rootPath);
    await this.deactivate(record, reason);
  }

  private clearValues(record: ExtensionRecord): void {
    for (const itemId of record.itemIds) this.values.delete(itemId);
  }

  private setValue(itemId: string, scopeKey: SlotScopeKey, value: SlotValue | null): void {
    const byScope = this.values.get(itemId) ?? new Map<SlotScopeKey, SlotValue>();
    if (value) byScope.set(scopeKey, value);
    else byScope.delete(scopeKey);
    if (byScope.size > 0) this.values.set(itemId, byScope);
    else this.values.delete(itemId);
  }

  private updateValue(itemId: string, patch: SlotItemPatch, scopeKey: SlotScopeKey): void {
    const value = applySlotPatch(this.values.get(itemId)?.get(scopeKey), patch);
    this.setValue(itemId, scopeKey, value);
    this.rev += 1;
    this.emit({ kind: "delta", gen: this.gen, rev: this.rev, itemId, scopeKey, value });
  }

  private pushSnapshot(reason: string): void {
    this.rev += 1;
    const snapshot = this.snapshot();
    hostLog(
      "info",
      `contributions snapshot gen=${snapshot.gen} rev=${snapshot.rev} extensions=${snapshot.extensions.length} (${reason})`,
    );
    this.emit(snapshot);
  }

  private emit(message: ContributionMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
