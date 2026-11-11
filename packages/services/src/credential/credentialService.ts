import {
  createSystemCredentialCipher,
  migrateCredentialRecord,
} from "@zcode/shared/credential-security";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  withCredentialFileRead,
  withCredentialFileMutation,
  captureCredentialFileGuard,
  type CredentialFileGuard,
} from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  isCredentialDecryptError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import { type CredentialCipherProvider } from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(
  credentialsFile = getCredentialsFile(),
  locked = false,
): Promise<Record<string, string>> {
  if (locked) return readAllUnchecked(credentialsFile);
  return withCredentialFileRead(credentialsFile, () => readAllUnchecked(credentialsFile));
}

function parseRecord(raw: Buffer): Record<string, string> {
  return credentialRecordSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
  );
}

function isCorruptRecord(raw: Buffer): boolean {
  try {
    parseRecord(raw);
    return false;
  } catch {
    return true;
  }
}

function fingerprint(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readAllUnchecked(credentialsFile: string): Promise<Record<string, string>> {
  let raw: Buffer;
  try {
    raw = await readFile(credentialsFile);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    return parseRecord(raw);
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: {
    operation: "save" | "delete" | "batch" | "recover";
    keys: readonly string[];
  }) => void;
}

/** Host 私有缓存恢复能力，不进入 Renderer 的 ICredentialService 契约。 */
export interface LocalCredentialService extends ICredentialService {
  captureRecoveryGuard(): Promise<CredentialFileGuard>;
  deleteUnreadable(
    keys: readonly string[],
    options?: {
      expected?: Readonly<Record<string, string | null>>;
      removeKeys?: readonly string[];
      replacements?: Readonly<Record<string, string>>;
    },
  ): Promise<boolean>;
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  updateMany(
    changes: Readonly<Record<string, string | null>>,
    options?: {
      expected?: Readonly<Record<string, string | null>>;
      assertCurrent?: () => void;
    },
  ): Promise<boolean>;
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
  delete(key: string, assertCurrent?: () => void): Promise<void>;
  /** 文件锁内“没有才写入”，返回最终保存的值；多个 Host 进程并发生成同一凭据时收敛到先写入者。 */
  saveIfAbsent(key: string, value: string): Promise<string>;
  /** 文件锁内比较后删除，只删除仍等于 expected 的值，不误删其他进程刚写入的新值。 */
  deleteIfEquals(key: string, expected: string): Promise<void>;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): LocalCredentialService {
  const ciphers = new Map<string, CredentialCipherProvider>();
  function cipherForFile(file: string): CredentialCipherProvider {
    if (dependencies.cipherProvider) return dependencies.cipherProvider;
    let cipher = ciphers.get(file);
    if (!cipher) {
      cipher = createSystemCredentialCipher({ filePath: file });
      ciphers.set(file, cipher);
    }
    return cipher;
  }
  /** 调用方必须已在 withCredentialFileMutation 内；迁移写入与恢复共用同一代次屏障。 */
  async function readCurrentLocked(file: string) {
    const current = await readAll(file, true);
    const migrated = await migrateCredentialRecord(current, cipherForFile(file));
    if (migrated) await writeAll(file, migrated);
    return migrated ?? current;
  }
  async function readCurrent(file: string) {
    // 普通读取不取得写锁（慢写入曾让登录读取等锁超时），由读取前后的恢复代次校验拒绝旧结果。
    // 只有仍含旧格式值时才进入变更锁迁移一次。
    const current = await readAll(file);
    const cipher = cipherForFile(file);
    if (!Object.values(current).some((value) => cipher.needsMigration?.(value))) return current;
    return withCredentialFileMutation(file, () => readCurrentLocked(file));
  }

  return {
    captureRecoveryGuard: () => captureCredentialFileGuard(getCredentialsFile()),
    async inspectStore() {
      const file = getCredentialsFile();
      return withCredentialFileRead(file, async () => {
        let raw: Buffer;
        try {
          raw = await readFile(file);
        } catch (error) {
          if (getErrorCode(error) === "ENOENT") return { status: "healthy" as const };
          throw error;
        }
        return isCorruptRecord(raw)
          ? { status: "corrupt" as const, fingerprint: fingerprint(raw) }
          : { status: "healthy" as const };
      });
    },
    async recoverStore(expected) {
      if (!/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Invalid credential recovery fingerprint");
      const file = getCredentialsFile();
      const result = await withFileLock(file, async () => {
        let raw: Buffer;
        try {
          raw = await readFile(file);
        } catch (error) {
          if (getErrorCode(error) === "ENOENT") return { status: "changed" as const };
          throw error;
        }
        // 旧确认不可清空另一窗口修复的库，也不可恢复已被替换的另一份损坏内容。
        if (fingerprint(raw) !== expected || !isCorruptRecord(raw))
          return { status: "changed" as const };
        let backupPath = await backupCorruptFile(file);
        if (!(await readFile(backupPath)).equals(raw)) {
          // 旧备份可能因中断而不完整，不能覆盖证据，也不能让明确确认后的恢复永久卡住。
          backupPath = `${file}.corrupt-${fingerprint(raw).slice(0, 24)}.${randomUUID()}.bak`;
          await writeFile(backupPath, raw, { flag: "wx", mode: 0o600 });
          if (!(await readFile(backupPath)).equals(raw))
            throw new Error("Credential backup verification failed");
        }
        // 先持久化代次，使跨进程旧读写作废。后续替换失败时原件仍在，用户可重新确认。
        await atomicWritePrivateTextFile(`${file}.recovery-generation`, randomUUID());
        await atomicWritePrivateTextFile(file, "{}\n");
        logger.info(undefined, "corrupt credential store recovered after confirmation", {
          backupPath,
        });
        return { status: "recovered" as const, backupPath };
      });
      if (result.status === "recovered") {
        try {
          dependencies.onDidMutate?.({ operation: "recover", keys: [] });
        } catch (error) {
          logger.warn(undefined, "credential recovery notification failed", { error });
        }
      }
      return result;
    },
    async deleteUnreadable(keys, options) {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const validatedKeys = keys.map((key) => credentialKeySchema.parse(key));
      const removeKeys = (options?.removeKeys ?? keys).map((key) => credentialKeySchema.parse(key));
      const replacementEntries = await Promise.all(
        Object.entries(options?.replacements ?? {}).map(
          async ([key, value]) =>
            [
              credentialKeySchema.parse(key),
              await cipherProvider.encrypt(credentialValueSchema.parse(value)),
            ] as const,
        ),
      );
      const deleted = await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        for (const [key, expected] of Object.entries(options?.expected ?? {})) {
          const value = creds[credentialKeySchema.parse(key)];
          try {
            if ((value === undefined ? null : await cipherProvider.decrypt(value)) !== expected)
              return false;
          } catch (error) {
            if (!isCredentialDecryptError(error)) throw error;
            return false;
          }
        }
        const unreadable = (
          await Promise.all(
            validatedKeys.map(async (key) => {
              if (creds[key] === undefined) return false;
              try {
                await cipherProvider.decrypt(creds[key]);
                return false;
              } catch (error) {
                if (!isCredentialDecryptError(error)) throw error;
                return true;
              }
            }),
          )
        ).some(Boolean);
        // 旧读取失败后可能已有其他进程修复；锁内仍然损坏才允许整组清理。
        if (!unreadable) return false;
        for (const key of removeKeys) delete creds[key];
        for (const [key, value] of replacementEntries) creds[key] = value;
        await writeAll(credentialsFile, creds);
        return true;
      });
      if (deleted)
        dependencies.onDidMutate?.({
          operation: "batch",
          keys: [...removeKeys, ...replacementEntries.map(([key]) => key)],
        });
      return deleted;
    },
    async loadMany(keys) {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const validatedKeys = keys.map((key) => credentialKeySchema.parse(key));
      const creds = await readCurrent(credentialsFile);
      return Object.fromEntries(
        await Promise.all(
          validatedKeys.map(async (key) => [
            key,
            creds[key] === undefined ? null : await cipherProvider.decrypt(creds[key]),
          ]),
        ),
      );
    },

    async updateMany(changes, options) {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const entries = await Promise.all(
        Object.entries(changes).map(
          async ([key, value]) =>
            [
              credentialKeySchema.parse(key),
              value === null
                ? null
                : await cipherProvider.encrypt(credentialValueSchema.parse(value)),
            ] as const,
        ),
      );
      const expected = Object.entries(options?.expected ?? {}).map(
        ([key, value]) =>
          [
            credentialKeySchema.parse(key),
            value === null ? null : credentialValueSchema.parse(value),
          ] as const,
      );
      const committed = await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        // 比较与整组替换共用跨进程锁；旧网络结果不能覆盖另一进程已完成的新登录。
        for (const [key, value] of expected) {
          const current =
            creds[key] === undefined ? null : await cipherProvider.decrypt(creds[key]);
          if (current !== value) return false;
        }
        options?.assertCurrent?.();
        for (const [key, value] of entries) {
          if (value === null) delete creds[key];
          else creds[key] = value;
        }
        await writeAll(credentialsFile, creds);
        return true;
      });
      if (committed && entries.length > 0)
        dependencies.onDidMutate?.({ operation: "batch", keys: entries.map(([key]) => key) });
      return committed;
    },

    async recoverUnreadable(key, assertCurrent) {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const validatedKey = credentialKeySchema.parse(key);
      let deleted = false;
      const value = await withCredentialFileMutation(credentialsFile, async () => {
        assertCurrent();
        const creds = await readCurrentLocked(credentialsFile);
        assertCurrent();
        const rawValue = creds[validatedKey];
        if (rawValue === undefined) return null;
        try {
          return await cipherProvider.decrypt(rawValue);
        } catch (error) {
          if (!isCredentialDecryptError(error)) throw error;
        }
        // 缓存复核与删除必须共用跨进程锁；分别 load/delete 会误删另一窗口已修复的记录。
        // 此处仅处理调用方明确标记的派生缓存，不能因缓存损坏清理有效 OAuth 登录。
        assertCurrent();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
        deleted = true;
        return null;
      });
      if (deleted) dependencies.onDidMutate?.({ operation: "delete", keys: [validatedKey] });
      return value;
    },

    async load(key: string): Promise<string | null> {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const validatedKey = credentialKeySchema.parse(key);
      const creds = await readCurrent(credentialsFile);
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      return await cipherProvider.decrypt(rawValue);
    },

    async save(key: string, value: string, assertCurrent?: () => void): Promise<void> {
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = await cipherProvider.encrypt(validatedValue);
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        // 请求可能在等待文件锁时失效，不能只依赖调用方进入 IO 前的代次检查。
        assertCurrent?.();
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", keys: [validatedKey] });
    },

    async delete(key: string, assertCurrent?: () => void): Promise<void> {
      const credentialsFile = getCredentialsFile();
      const validatedKey = credentialKeySchema.parse(key);
      await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        assertCurrent?.();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", keys: [validatedKey] });
    },

    async saveIfAbsent(key: string, value: string): Promise<string> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      // 上游条件写入也必须走当前异步 cipher 和迁移路径；旧同步调用会把 Promise 当密文写入。
      // 条件操作也需在排队前固定代次，否则恢复后的空库会被旧请求重新填入。
      let saved = false;
      const current = await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        const existing = creds[validatedKey];
        if (existing !== undefined) {
          return await cipherProvider.decrypt(existing);
        }
        creds[validatedKey] = await cipherProvider.encrypt(validatedValue);
        await writeAll(credentialsFile, creds);
        saved = true;
        return validatedValue;
      });
      if (saved) dependencies.onDidMutate?.({ operation: "save", keys: [validatedKey] });
      return current;
    },

    async deleteIfEquals(key: string, expected: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      const cipherProvider = cipherForFile(credentialsFile);
      // 与条件保存共用恢复屏障，旧删除不能在新一代库中重新执行比较。
      const deleted = await withCredentialFileMutation(credentialsFile, async () => {
        const creds = await readCurrentLocked(credentialsFile);
        const existing = creds[validatedKey];
        if (existing === undefined || (await cipherProvider.decrypt(existing)) !== expected) {
          return false;
        }
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
        return true;
      });
      if (deleted) dependencies.onDidMutate?.({ operation: "delete", keys: [validatedKey] });
    },
  };
}
