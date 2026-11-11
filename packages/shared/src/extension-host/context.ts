import type {
  CapabilityContext,
  CapabilityDisposable,
  ExtensionCapabilityTable,
  LocallyWrappedCapabilityId,
} from "#src/extension-host/capabilities.js";
import type { ResolvedScope, ScopeInput, SlotItemPatch } from "#src/extension-host/slots.js";
import type { ViewDefinition, ViewServerFactory } from "#src/extension-host/views.js";

// ExtensionContext（docs/plugins/extension-host.md §7.1、§7.4）是唯一定义：
// 扩展进程运行时用 `satisfies ExtensionContext` 钉住；P3 的类型包从这里导出。

export type Disposable = CapabilityDisposable;

/** 命令被执行时宿主传给扩展的参数。作用域由 Window Host 校验后补全。 */
export interface CommandCall {
  scope: ResolvedScope;
  /**
   * 插槽给命令的参数：composer.mention 是 `{ query }`（§16.6），命令返回候选项数组。
   * composer.status 的点击没有参数，返回值被忽略。
   */
  args?: Readonly<Record<string, unknown>>;
}

/** ctx 的本地部分：在扩展进程内完成，不经 Window Host。 */
export interface ExtensionLocalContext {
  readonly extension: {
    readonly id: string;
    readonly version: string;
    readonly path: string;
    /** 插件的持久数据目录（§18.1 H6）：CLI 的 `data/<插件 id>`，激活前已建好，插件更新后保留。 */
    readonly dataPath: string;
  };
  readonly log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly commands: {
    register(id: string, run: (call: CommandCall) => unknown): Disposable;
  };
  readonly slots: {
    update(itemId: string, patch: SlotItemPatch, scope?: ScopeInput): void;
  };
  readonly views: {
    /** 写法一传 ViewDefinition（宿主帮手）；写法二传返回 McpServer 的工厂（§8）。 */
    register(id: string, view: ViewDefinition | ViewServerFactory): Disposable;
    /** 能力 views.open：请 Renderer 打开视图并等回执。id 未声明时在本进程内抛 not-declared。 */
    open(id: string, scope?: ScopeInput): Promise<void>;
  };
}

/** 本地部分 + 由能力表推导的能力部分（本地包装的能力除外，见 LOCALLY_WRAPPED_CAPABILITIES）。 */
export type ExtensionContext = ExtensionLocalContext &
  CapabilityContext<Omit<ExtensionCapabilityTable, LocallyWrappedCapabilityId>>;

/** 插件入口模块的形状。 */
export interface ExtensionModule {
  activate(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
