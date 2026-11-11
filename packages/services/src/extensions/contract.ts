import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  ContributionMessage,
  ExecuteCommandInput,
  ExtensionEnv,
  ExtensionHostStatus,
  ExtensionLogEntry,
  ExtensionLogsSnapshot,
  ExtensionStaticTable,
  GetExtensionLogsInput,
  MentionItemsResult,
  ProvideMentionItemsInput,
  WorkbenchReport,
} from "@zcode/shared/extension-host";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * Renderer 收到的插槽数据消息（§16.1），一条流里有两个 owner 的数据：
 * - `static`：静态表（owner 是本服务），整份；重读清单后推新的一份。
 * - `snapshot` / `delta`：贡献表（owner 是扩展进程：运行状态与动态值）。
 * - `detached`：当前没有已连接的扩展进程（重启中或已停止）。它不是第二份贡献表，只表示「没有可用快照」；
 *   静态表不受影响。
 */
export type ExtensionsContributionsMessage =
  | ContributionMessage
  | { kind: "detached" }
  | { kind: "static"; table: ExtensionStaticTable };

/**
 * Window Host 的扩展门面（docs/plugins/extension-host.md §3.5、§4）。Renderer 只经它与
 * IExtensionViewsService（扩展视图，views/contract.ts）访问扩展。
 * 只在桌面本机 Host 注册：不进入远程 workspace RPC 合同、source-settings 与手机白名单。
 */
export interface IExtensionsService {
  /**
   * 订阅插槽数据：先收当前静态表（还没读完清单时 rev 为 0、没有插件），再收当前贡献表快照
   * （没有时收 detached），之后是重读后的静态表、增量与后续快照。静态表在插件清单变化与
   * 「重新加载扩展」时重读；扩展进程停止时静态表照常。
   */
  onDynamicContributions(input?: undefined): Event<ExtensionsContributionsMessage>;
  /** 订阅扩展进程状态（owner 是 Main 的监管器）：先收当前状态，再收变化。 */
  onDynamicHostStatus(input?: undefined): Event<ExtensionHostStatus>;
  /** 执行扩展命令（例如点击 composer.status 条目）。作用域由 Window Host 校验。 */
  executeCommand(input: ExecuteCommandInput): Promise<void>;
  /**
   * composer.mention 的候选项（§16.6）：command 条目调扩展命令，tool 条目调 CLI plugins/mentionItems
   * （要会话，草稿用预热会话）。不设计取消：seq 原样带回，Renderer 只采用最新一次。错误折成结果里的码。
   */
  provideMentionItems(input: ProvideMentionItemsInput): Promise<MentionItemsResult>;
  /** 重新加载扩展：经 parentPort 请 Main 清零崩溃预算并重启扩展进程，并重读静态表。 */
  reload(): Promise<void>;
  /**
   * 报告屏幕上的会话（③ Renderer 报告）：窗格、草稿、焦点或草稿所选模型变化时整份报告。
   * Window Host 只持最近一份。
   */
  reportWorkbench(report: WorkbenchReport): Promise<void>;
  /** 报告 App 环境（③ Renderer 报告，§16.11）：语言变化时调用。Window Host 只持最近一份。 */
  reportEnv(env: ExtensionEnv): Promise<void>;
  /**
   * 日志快照（§16.8）：缓冲的 owner 是 Main 的监管器，本服务向 Main 请求后原样转发，不留副本。
   * 带 sinceSeq 时只要它之后的条目（Renderer 发现 seq 不连续时补齐）。
   */
  getLogs(input: GetExtensionLogsInput): Promise<ExtensionLogsSnapshot>;
  /** 订阅追加的日志：Main 每轮事件循环一批，本服务只转发。订阅时不重放，先订阅再 getLogs。 */
  onDynamicLogs(input?: undefined): Event<ExtensionLogEntry[]>;
}

export const IExtensionsService = createServiceDescriptor<IExtensionsService>(
  ServiceChannels.Extensions,
);
