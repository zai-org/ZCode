import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 凭据目录的磁盘状态：来源标记、密文前缀与容器读取。密钥选择与自动重置共用，不含密钥。 */
export const SYSTEM_PREFIX = "enc:v2:";
export const OS_CIPHERTEXT_PREFIX = `${SYSTEM_PREFIX}os:`;
export const ENV_CIPHERTEXT_PREFIX = `${SYSTEM_PREFIX}env:`;
/** 与凭据文件同目录的来源标记；内容只能是 OS_SOURCE_MARKER，不含密钥。 */
export const CREDENTIAL_SOURCE_FILE = "credential-source";
export const OS_SOURCE_MARKER = "os\n";

export async function readOptionalBytes(path: string): Promise<Buffer | null> {
  return await readFile(path).catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
}

/** 凭据容器中的全部值；文件缺失或无法解析时视为没有（损坏由既有恢复机制处理）。 */
export function recordValues(raw: Buffer | null): string[] {
  let record: unknown;
  try {
    record = JSON.parse(raw?.toString("utf8") || "{}");
  } catch {
    return [];
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.values(record).filter((value): value is string => typeof value === "string");
}

/** 凭据目录的来源是否已固定为 os；标记缺失视为未固定，其他读取错误向上抛出。 */
export async function isOsSourcePinned(filePath: string): Promise<boolean> {
  const marker = await readFile(join(dirname(filePath), CREDENTIAL_SOURCE_FILE), "utf8").catch(
    (error) => {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    },
  );
  return marker === OS_SOURCE_MARKER;
}
