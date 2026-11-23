import type { PreinstalledToolManifest } from "@zcode/shared/preinstalled-tools";

type RewriteRule = NonNullable<PreinstalledToolManifest["rewrite"]>[number];

export class PreinstalledToolRewriteError extends Error {
  constructor(
    public readonly code: "unsupported" | "extract",
    message: string,
    public readonly placeholderBytes: number,
    public readonly installationBytes: number,
  ) {
    super(message);
    this.name = "PreinstalledToolRewriteError";
  }
}

function replaceBytes(input: Buffer, placeholder: Buffer, replacement: Buffer): Buffer {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (let at = input.indexOf(placeholder); at !== -1; at = input.indexOf(placeholder, cursor)) {
    parts.push(input.subarray(cursor, at), replacement);
    cursor = at + placeholder.length;
  }
  if (cursor === 0) return input;
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts);
}

function replaceBinaryPrefixes(input: Buffer, placeholder: Buffer, replacement: Buffer): Buffer {
  const parts: Buffer[] = [];
  let cursor = 0;
  for (let at = input.indexOf(placeholder); at !== -1; at = input.indexOf(placeholder, cursor)) {
    const terminator = input.indexOf(0, at);
    const end = terminator === -1 ? input.length : terminator + 1;
    const original = input.subarray(at, end);
    const rewritten = replaceBytes(original, placeholder, replacement);
    // NUL 必须补在整段字符串末尾；补在前缀后会截断 /share 等路径后缀。
    parts.push(
      input.subarray(cursor, at),
      rewritten,
      Buffer.alloc(original.length - rewritten.length),
    );
    cursor = end;
  }
  if (cursor === 0) return input;
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts);
}

/** 制作与安装共用的纯字节格式边界；不读文件、不发布状态。 */
export function rewritePreinstalledToolBytes(
  input: Buffer,
  rule: RewriteRule,
  installationDir: string,
): Buffer {
  const placeholder = Buffer.from(rule.placeholder, "utf8");
  const replacement = Buffer.from(installationDir, "utf8");
  if (!placeholder.length)
    throw new PreinstalledToolRewriteError(
      "extract",
      "Empty relocation placeholder",
      0,
      replacement.length,
    );
  if (rule.mode !== "text" && replacement.length > placeholder.length)
    throw new PreinstalledToolRewriteError(
      "unsupported",
      "Installation path exceeds relocation placeholder",
      placeholder.length,
      replacement.length,
    );
  if (rule.mode === "text") return replaceBytes(input, placeholder, replacement);
  if (rule.mode === "binary") return replaceBinaryPrefixes(input, placeholder, replacement);
  for (
    let at = input.indexOf(placeholder);
    at !== -1;
    at = input.indexOf(placeholder, at + placeholder.length)
  ) {
    const next = input[at + placeholder.length];
    if (next !== undefined && next !== 0 && next !== 0x2f)
      throw new PreinstalledToolRewriteError(
        "extract",
        "Invalid directory prefix boundary",
        placeholder.length,
        replacement.length,
      );
  }
  // C++ 可把原路径长度编译成常量；目录槽用分隔符填满，避免追加的子目录落到 NUL 后面。
  const padded = Buffer.alloc(placeholder.length, 0x2f);
  replacement.copy(padded);
  return replaceBytes(input, placeholder, padded);
}
