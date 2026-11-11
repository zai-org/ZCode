function redactUnquotedPath(value: string): string {
  // 裸路径可能含空格，不能把空格后的用户名/目录当成正文放行。只保留机器可识别的
  // 诊断尾部和已经脱敏的字段；其他无法消歧的尾部继续保守过滤，生产者应给路径加引号。
  // Bug 原因：Docker 错误在 URL 后还会输出裸 socket 路径，旧规则连同末尾的 connect
  // 系统错误一起吞掉；只放行有明确分隔符的这三种诊断，仍不按空格猜测路径边界。
  // Bug 原因（ZCT-2115996335380615168）：glibc 过低时动态链接器输出
  // `<程序>: <库>: version `GLIBC_2.28' not found (required by <程序>)`，裸路径一直匹配到 `'`，
  // 缺失符号随路径一起被遮掉，用户只看到 `[redacted-path]' not found`。放行 `: version `<符号>`，
  // 符号只含单词字符和点，不会带出路径片段。
  const suffix =
    value.match(
      /(?:: connect: (?:no such file or directory|connection refused|permission denied)|: version `[\w.]+|(?:\s+(?:failed with exit code -?\d+|permission denied|no space left on device|read-only file system|[\w-]+=\[redacted\]))+)\.?$/iu,
    )?.[0] ?? "";
  return `[redacted-path]${suffix}`;
}

/**
 * Bug 原因：已知秘密曾按子串替换，短密码（如 `dev`）会把固定文案 `device` 改成
 * `[redacted]ice`，看日志即可反推出密码。秘密必须按完整 token 匹配：秘密首/尾是
 * ASCII 单词字符时，相邻字符不能也是 ASCII 单词字符；中文等非 ASCII 字符仍视为边界。
 */
function secretTokenPattern(secret: string): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = /^\w/.test(secret) ? "(?<!\\w)" : "";
  const after = /\w$/.test(secret) ? "(?!\\w)" : "";
  return new RegExp(`${before}${escaped}${after}`, "g");
}

/** 所有用户可见连接日志（含反馈附件）共用的过滤边界；原始诊断另行落盘。 */
export function sanitizeRemoteConnectionLog(
  message: string,
  secrets: readonly string[] = [],
): string {
  let result = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replace(secretTokenPattern(secret), "[redacted]");
  }
  return (
    result
      .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[redacted]")
      // Header 里的 Basic/Cookie 值可含空格和分号，按单个 token 截断会泄漏剩余凭据。
      // 只有带引号的键按结构字段处理；普通 Header 一律遮蔽到行尾，包含带引号值之后的内容。
      .replace(
        /(["'](?:authorization|(?:set-)?cookie)["'][ \t]*[:=][ \t]*)(?:\[redacted\](?=[,}\]\r\n]|$)|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi,
        "$1[redacted]",
      )
      .replace(/(\b(?:authorization|(?:set-)?cookie)[ \t]*[:=][ \t]*)[^\r\n]*/gi, "$1[redacted]")
      .replace(/\b(Bearer|Basic)[ \t]+[^\s,"'};]+/gi, "$1 [redacted]")
      .replace(
        /(["']?(?:[\w-]*token|[\w-]*api[_-]?key|[\w-]*secret|password|passphrase|privateKey|credentialRef|credentialId|profileId|sourceServerId|serverId|deviceId)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
        "$1[redacted]",
      )
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted]")
      // Bug 原因：docker CLI 报错带 daemon 地址（unix:// / npipe:// / tcp://），旧规则不认这些协议，
      // `unix:` 里的 `x:/` 又被下面的 Windows 盘符规则当成路径开头，一直遮到行尾，
      // 用户看不到 “Is the docker daemon running?” 这类原因。把它们按 URL 整体遮蔽，保留后续正文。
      .replace(/(?:https?|wss?|file|unix|npipe|tcp):\/\/[^\s"'<>]+/gi, "[redacted-url]")
      // 引号提供精确边界，保留后续正文；无引号时不能靠空格猜测路径结束位置。
      .replace(/"(?:~?\/|[A-Za-z]:[\\/]|\\\\)(?:\\[^\r\n]|[^"\\\r\n])*"/g, "[redacted-path]")
      .replace(/'(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^'\r\n]*'/g, "[redacted-path]")
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>]+/g, redactUnquotedPath)
      .replace(
        /(^|[\s("'=:[])(~?\/[^\r\n"'<>),;]+)/g,
        (_match, prefix: string, path: string) => `${prefix}${redactUnquotedPath(path)}`,
      )
      // oxlint-disable-next-line no-control-regex -- 清除终端 ANSI 控制序列，用户日志只保留可读文本。
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .trim()
  );
}

export function remoteConnectionFailureLogLevel(code: string): "info" | "error" {
  // 更新期间被拒绝的连接是等待点，不是连接失败；与等待安装确认一样记为 info。
  return code === "source-server-install-required" ||
    code === "source-server-update-in-progress" ||
    code === "remote-connection-canceled" ||
    code === "remote-bind-canceled"
    ? "info"
    : "error";
}
