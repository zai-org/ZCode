import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  DecideExtensionActivationInput,
  DescribeExtensionEnableInput,
  ExtensionAuditEntry,
  ExtensionEnableImpact,
  ExtensionGrantsSnapshot,
  GetExtensionRecentActionsInput,
  GrantExtensionInput,
  RevokeExtensionInput,
  SetExtensionNotificationsInput,
} from "@zcode/shared/extension-host";
import { createServiceDescriptor } from "#src/descriptors.js";

// 扩展授权门面（docs/plugins/extension-host.md §17.7、§17.8）：授予、撤销、授权状态、启用确认与最近操作。
// 拆成单独频道的原因：IExtensionsService 已有 9 个方法，授权是一组独立的意图（9 个方法：P3a 的五个，P3b 的
// decideActivation，P4 的 grants.request 请求与回执两个（§18.1 H12）与通知开关一个（§18.1 H8）），并到一起会超过
// 架构门禁的 12 个公开方法上限；也让「谁能授予权限」一眼可见。
// 与 IExtensionsService 同一个 owner（Window Host 的 extensions-service），只在桌面本机 Host 注册，
// 不在手机远控白名单里。扩展进程没有授予自己权限的入口：extension-window 频道只有 call 与 subscribe。

/** 能力 grants.request 请 Renderer 弹授权对话框（§18.1 H12）。 */
export interface ExtensionGrantRequest {
  requestId: string;
  pluginId: string;
}

/** Renderer 在对话框结束（确认后授予调用也结束）之后回执。ok 为 false 表示没能弹出对话框。 */
export interface ExtensionGrantRequestAck {
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface IExtensionGrantsService {
  /** 订阅整份授权状态：先收当前一份（授权记录还没读完时 rev 为 0、没有插件），之后每次变化收新的一份。 */
  onDynamicGrants(input?: undefined): Event<ExtensionGrantsSnapshot>;
  /** 用户在授权对话框里确认。grants 必须等于清单当前声明的档位，否则拒绝（请求已过期）。写一行审计。 */
  grant(input: GrantExtensionInput): Promise<void>;
  /** 撤销该插件的全部授权：删记录，中止它在途的会话调用，写一行审计。 */
  revoke(input: RevokeExtensionInput): Promise<void>;
  /** 启用插件前调用：已有别的扩展持有会话权限、而它带扩展代码时，返回 confirm 与持有者。 */
  describeEnable(input: DescribeExtensionEnableInput): Promise<ExtensionEnableImpact>;
  /** 插件详情页「最近操作」：该插件最近的审计行，新的在前。只读审计文件，不含内容。 */
  getRecentActions(
    input: GetExtensionRecentActionsInput,
  ): Promise<{ entries: ExtensionAuditEntry[] }>;
  /**
   * 「需要确认」的决定（§17.7，P3b）：从插件商店安装后等待激活的插件，allow 激活它，否则记为不激活。
   * 插件不在等待时拒绝。
   */
  decideActivation(input: DecideExtensionActivationInput): Promise<void>;
  /** 详情页「系统通知」开关（§18.1 H8，默认开）：只在通知档位生效时可改。写一行审计。 */
  setNotificationsEnabled(input: SetExtensionNotificationsInput): Promise<void>;
  /** 能力 grants.request（§18.1 H12）：扩展请宿主弹授权对话框。同一插件的在途请求合并成一次。 */
  onDynamicGrantRequests(input?: undefined): Event<ExtensionGrantRequest>;
  /** 对话框结束后回执；Window Host 这时读授权状态作为 grants.request 的返回。 */
  ackGrantRequest(ack: ExtensionGrantRequestAck): Promise<void>;
}

export const IExtensionGrantsService = createServiceDescriptor<IExtensionGrantsService>(
  ServiceChannels.ExtensionGrants,
);
