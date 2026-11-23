import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "../node/privateFilePersistence.js";
import type {
  CredentialKeyFailureDiagnostic,
  CredentialKeyFailureStage,
  CredentialStoreResetEvent,
} from "./contract.js";
import {
  CREDENTIAL_SOURCE_FILE,
  ENV_CIPHERTEXT_PREFIX,
  OS_CIPHERTEXT_PREFIX,
  isOsSourcePinned,
  readOptionalBytes,
  recordValues,
} from "./credentialFileState.js";

/**
 * 触发自动重置的失败阶段：密钥确定拿不到（系统库读取失败、条目缺失或格式错误、私有文件
 * 缺失或无效）。load 不触发：打包回归会让同一版本所有升级用户同时命中，重装即可恢复；
 * lock 是暂时性的；config 由用户修正；file/source 是文件 IO 问题，清空也写不进去。
 */
export const RESET_STAGES: ReadonlySet<CredentialKeyFailureStage> = new Set([
  "read",
  "missing",
  "invalid",
  "managed",
]);

export interface BoundStoreResetOptions<T> {
  /** 已规范化的凭据文件路径。 */
  filePath: string;
  /** 进程内密钥缓存；重置成功后删除该路径，下一次 getKey 重新解析来源。 */
  cache: Map<string, Promise<T>>;
  /** 触发本次重置的那次失败加载。 */
  failed: Promise<T>;
  diagnostic: CredentialKeyFailureDiagnostic;
  /** 私有 credential-secret 当前是否可读且合法（managed 复核用）。 */
  isManagedSecretValid(): Promise<boolean>;
}

/**
 * Desktop 自动重置已绑定来源的凭据目录（spec：已绑定目录：自动重置）。
 *
 * Bug 原因：已绑定 os 的目录在系统库拒绝授权、条目丢失或格式错误后，旧密文只能用原密钥
 * 解开；已绑定 env 的目录私有文件丢失或损坏时同理。失败缓存到进程退出，重新登录也无法
 * 保存，用户手动删除凭据前一直无法登录。修复：备份后清空凭据库并解除来源绑定，让下一次
 * getKey 重新解析来源（系统库可用则重建系统密钥，否则回退到私有文件）。
 *
 * 锁序与其他写入相同（凭据文件锁 → keyring 锁）。只处理触发本次重置的那次失败；锁内复核
 * 不再满足时放弃，因此多个进程或请求的同一失败只清空一次。不加重试：失败时保持失败缓存，
 * 下次启动再尝试。不抛出：结果统一以事件返回。
 */
export async function resetBoundCredentialStore<T>(
  options: BoundStoreResetOptions<T>,
): Promise<CredentialStoreResetEvent> {
  const { filePath, cache, failed, diagnostic } = options;
  const skipped = { status: "skipped", diagnostic } as const;
  try {
    return await withFileLock(filePath, () =>
      withFileLock(`${filePath}.keyring`, async (): Promise<CredentialStoreResetEvent> => {
        if (cache.get(filePath) !== failed) return skipped;
        const dir = dirname(filePath);
        const secretPath = join(dir, "credential-secret");
        const raw = await readOptionalBytes(filePath);
        const text = raw?.toString("utf8") ?? "";
        let clear: boolean;
        let moveSecret = false;
        if (diagnostic.stage === "managed") {
          // 私有文件已被修复（重新可读且合法）时不再动它。
          if (await options.isManagedSecretValid()) return skipped;
          // 坏文件必须移走，否则下次 getKey 仍先发现它，形成“清空 → 失败 → 再清空”的循环。
          moveSecret = (await lstat(secretPath).catch(() => null)) !== null;
          // 只有一个坏私有文件、没有 env 密文依赖它时，只移走文件，不清空库。
          clear = text.includes(ENV_CIPHERTEXT_PREFIX);
          if (!clear && !moveSecret) return skipped;
        } else {
          if (!(await isOsSourcePinned(filePath)) && !text.includes(OS_CIPHERTEXT_PREFIX))
            return skipped;
          // 文件损坏时同样清空：留下含 os 密文的原件会让下次 getKey 再次选择系统库。
          clear = raw !== null;
        }
        let backupPath: string | undefined;
        let clearedEntries = 0;
        if (clear && raw) {
          // 备份永久保留：它仍由旧密钥加密，钥匙串以后恢复时还能恢复数据。
          backupPath = `${filePath}.key-unavailable-${randomUUID()}.bak`;
          await writeFile(backupPath, raw, { flag: "wx", mode: 0o600 });
          if (!(await readFile(backupPath)).equals(raw))
            throw new Error("Credential backup verification failed");
        }
        // 先推进恢复代次，使跨进程旧读写与旧密钥缓存作废，再写空库、解除绑定。
        // Bug 原因：曾只在清空时推进。凭据文件不存在、只解除绑定时代次不变，其他进程缓存的
        // 旧系统密钥在重新固定 os 后仍会被当作当前密钥使用。
        await atomicWritePrivateTextFile(`${filePath}.recovery-generation`, randomUUID());
        if (clear && raw) {
          await atomicWritePrivateTextFile(filePath, "{}\n");
          clearedEntries = recordValues(raw).length;
        }
        await rm(join(dir, CREDENTIAL_SOURCE_FILE), { force: true });
        let movedSecretPath: string | undefined;
        if (moveSecret) {
          movedSecretPath = `${secretPath}.invalid-${randomUUID()}.bak`;
          await rename(secretPath, movedSecretPath);
        }
        cache.delete(filePath);
        return { status: "reset", diagnostic, clearedEntries, backupPath, movedSecretPath };
      }),
    );
  } catch (error) {
    const errorCode = (error as { code?: unknown } | undefined)?.code;
    return {
      status: "failed",
      diagnostic,
      ...(typeof errorCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(errorCode)
        ? { errorCode }
        : {}),
    };
  }
}
