// 扩展错误码（docs/plugins/extension-host.md §7.1）。判断一律用 code，不依赖错误文本。

export const EXTENSION_ERROR_CODES = [
  "not-declared",
  "invalid-input",
  "disposed",
  "host-unavailable",
  "internal",
  // P3（§17.3）：需要授权的能力与会话 facade。
  /** 清单声明了档位，但用户还没有授予（或插件更新后权限变多，等待重新确认）。 */
  "not-granted",
  /** 清单声明的协议版本与宿主不一致（§17.6）。 */
  "incompatible",
  /** 目标不在授权范围内（session-control forbidden）。 */
  "forbidden",
  /** 目标或宿主能力暂不可用（session-control unavailable）。 */
  "unavailable",
  /** 与 owner 的当前状态冲突（session-control conflict）。 */
  "conflict",
  /** 调用被取消（换代、断开或撤销授权时中止）。 */
  "cancelled",
  /** 超过上限（例如同时在途的 wait）。 */
  "limit-exceeded",
] as const;
export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;

  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
  }
}

/** 跨 RPC 后类实例会丢失，只剩 name 与 code（@zcode/rpc 透传 code）。按字段判断。 */
export function isExtensionError(
  error: unknown,
): error is { code: ExtensionErrorCode; message: string } {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (EXTENSION_ERROR_CODES as readonly string[]).includes(code);
}
