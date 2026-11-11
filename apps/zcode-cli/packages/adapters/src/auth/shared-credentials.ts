import { randomUUID } from "node:crypto";
import { OAUTH_SESSION_REVISION_KEY, OAUTH_LINKED_BIGMODEL_KEY } from "@zcode/shared";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  captureCredentialFileGuard,
  type CredentialFileGuard,
  withCredentialFileRead,
  withCredentialFileMutation,
  withFileLock,
} from "@zcode/shared/node";
import type { ZCodeCredentialCipher } from "./credential-cipher.js";
import {
  createSystemCredentialCipher,
  migrateCredentialRecord,
} from "@zcode/shared/credential-security";

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
const ZAI_PROVIDER_ID = "zai";
const WRITE_PROBE_VALUE = "zcode-credential-write-probe";
const credentialChangeListeners = new Map<string, Set<() => void | Promise<void>>>();

export const SHARED_ZCODE_CREDENTIAL_KEYS = {
  activeProvider: "oauth:active_provider",
  sessionRevision: OAUTH_SESSION_REVISION_KEY,
  linkedBigModel: OAUTH_LINKED_BIGMODEL_KEY,
  zaiCnAccessToken: "oauth:zai_cn:access_token",
  zaiCnRefreshToken: "oauth:zai_cn:refresh_token",
  zaiCnUserInfo: "oauth:zai_cn:user_info",
  bigmodelAccessToken: "oauth:bigmodel:access_token",
  bigmodelRefreshToken: "oauth:bigmodel:refresh_token",
  bigmodelUserInfo: "oauth:bigmodel:user_info",
  zaiAccessToken: "oauth:zai:access_token",
  zaiRefreshToken: "oauth:zai:refresh_token",
  zaiUserInfo: "oauth:zai:user_info",
  zcodeJwtToken: "zcodejwttoken",
} as const;

export interface SharedZCodeCredentialStoreOptions {
  baseDir?: string;
  cipher?: ZCodeCredentialCipher;
  env?: Record<string, string | undefined>;
  filePath?: string;
}

export interface ZaiLoginCredentialUser {
  avatar?: string;
  email?: string;
  name?: string;
  user_id: string;
}

export interface ZaiLoginCredentialPayload {
  accessToken: string;
  jwtToken: string;
  user: ZaiLoginCredentialUser;
}

export interface SharedCredentialRecoveryGuard {
  readonly run: CredentialFileGuard;
  /** 仅保护其它文件的最终提交；调用方先取得其它文件锁，回调不能再次写凭据库。 */
  readonly commit: CredentialFileGuard;
}

export interface SharedZCodeCredentialStore {
  readonly filePath: string;
  /** 用首次写入的同一密钥路径确认可写；不写凭据文件，不可用时抛出原始安全存储错误。 */
  assertWritable(): Promise<void>;
  /** 跨请求流程在启动时捕获，不能等网络返回后领取恢复后的新代次。 */
  captureRecoveryGuard(): Promise<SharedCredentialRecoveryGuard>;
  clearZaiLoginCredentials(): Promise<void>;
  delete(key: string): Promise<void>;
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  deleteIfValues(
    expectedValues: Readonly<Record<string, string>>,
  ): Promise<Record<string, boolean>>;
  deleteManyIfValue(
    guardKey: string,
    expectedGuardValue: string,
    keysToDelete: readonly string[],
  ): Promise<boolean>;
  updateMany(
    changes: Readonly<Record<string, string | null>>,
    options?: { expected?: Readonly<Record<string, string | null>>; assertCurrent?: () => void },
  ): Promise<boolean>;
  load(key: string): Promise<string | null>;
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  loadOAuthSessionSnapshot(): Promise<Record<string, string | null>>;
  onDidChange?(listener: () => void | Promise<void>): () => void;
  save(key: string, value: string): Promise<void>;
  saveMany(entries: Readonly<Record<string, string>>): Promise<void>;
  saveReplacing(key: string, value: string, replacedKeys: readonly string[]): Promise<void>;
  saveZaiLoginCredentials(
    payload: ZaiLoginCredentialPayload,
    expected?: Readonly<Record<string, string | null>>,
    assertCurrent?: () => void,
  ): Promise<void>;
}

export function createSharedZCodeCredentialStore(
  options: SharedZCodeCredentialStoreOptions = {},
): SharedZCodeCredentialStore {
  const env = options.env ?? process.env;
  const filePath = resolveSharedZCodeCredentialsPath(options);
  const cipher = options.cipher ?? createSystemCredentialCipher({ env, filePath });
  const readCurrent = async () => {
    // 普通读取不取得写锁（慢写入曾让登录读取等锁超时），由读取前后的恢复代次校验拒绝旧结果。
    // 只有仍含旧格式值时才进入变更锁迁移，迁移写入与恢复共用同一代次屏障。
    const current = await readRawCredentialRecord(filePath);
    if (!Object.values(current).some((value) => cipher.needsMigration?.(value))) return current;
    return withCredentialFileMutation(filePath, async () => {
      const locked = await readRawCredentialRecord(filePath, true);
      const migrated = await migrateCredentialRecord(locked, cipher);
      if (migrated)
        await atomicWritePrivateTextFile(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
      return migrated ?? locked;
    });
  };
  const mutate = (
    mutation: (raw: Record<string, string>) => void | boolean | Promise<void | boolean>,
  ) =>
    mutateRawCredentialRecord(filePath, async (raw) => {
      const migrated = await migrateCredentialRecord(raw, cipher);
      if (migrated) Object.assign(raw, migrated);
      return mutation(raw);
    });

  const loadMany = async (keys: readonly string[]): Promise<Record<string, string | null>> => {
    const raw = await readCurrent();
    return Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => {
          const value = raw[validateCredentialKey(key)];
          return [key, value === undefined ? null : await cipher.decrypt(value)];
        }),
      ),
    );
  };
  const updateMany: SharedZCodeCredentialStore["updateMany"] = async (changes, options) => {
    const entries = await Promise.all(
      Object.entries(changes).map(
        async ([key, value]) =>
          [
            validateCredentialKey(key),
            value === null ? null : await cipher.encrypt(validateCredentialValue(value)),
          ] as const,
      ),
    );
    const expected = Object.entries(options?.expected ?? {}).map(
      ([key, value]) =>
        [
          validateCredentialKey(key),
          value === null ? null : validateCredentialValue(value),
        ] as const,
    );
    let committed = false;
    await mutate(async (raw) => {
      for (const [key, value] of expected) {
        if ((raw[key] === undefined ? null : await cipher.decrypt(raw[key])) !== value)
          return false;
      }
      options?.assertCurrent?.();
      for (const [key, value] of entries) {
        if (value === null) delete raw[key];
        else raw[key] = value;
      }
      if (entries.some(([key]) => key === "zcodejwttoken" || key.startsWith("oauth:")))
        raw[OAUTH_SESSION_REVISION_KEY] = await cipher.encrypt(randomUUID());
      options?.assertCurrent?.();
      committed = true;
    });
    return committed;
  };

  const loadOAuthSessionSnapshot = async (): Promise<Record<string, string | null>> => {
    const raw = await readCurrent();
    const activeRaw = raw[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider];
    const provider = activeRaw === undefined ? null : await cipher.decrypt(activeRaw);
    const keys = [
      SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider,
      SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken,
      OAUTH_SESSION_REVISION_KEY,
      ...(provider
        ? [
            `oauth:${provider}:access_token`,
            `oauth:${provider}:refresh_token`,
            `oauth:${provider}:user_info`,
          ]
        : []),
    ];
    return Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => [
          key,
          raw[key] === undefined ? null : await cipher.decrypt(raw[key]),
        ]),
      ),
    );
  };

  return {
    filePath,
    async assertWritable() {
      // Bug 原因：空库读取不调用 cipher，首次访问系统库发生在登录授权之后的写入时。
      // 加密探针值走与首次写入相同的取密钥路径（必要时创建密钥），结果丢弃。
      await cipher.encrypt(WRITE_PROBE_VALUE);
    },
    async captureRecoveryGuard() {
      const run = await captureCredentialFileGuard(filePath);
      return { run, commit: (operation) => withFileLock(filePath, () => run(operation)) };
    },

    updateMany,
    loadOAuthSessionSnapshot,
    async clearZaiLoginCredentials(): Promise<void> {
      const expected = await loadOAuthSessionSnapshot();
      await updateMany(
        {
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: null,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiRefreshToken]: null,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo]: null,
          ...(expected[SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider] === ZAI_PROVIDER_ID
            ? {
                [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: null,
                [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: null,
                [SHARED_ZCODE_CREDENTIAL_KEYS.linkedBigModel]: null,
              }
            : {}),
        },
        { expected },
      );
    },

    async delete(key: string): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      await mutate(async (rawCredentials) => {
        delete rawCredentials[validatedKey];
      });
    },

    async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
      const validatedKey = validateCredentialKey(key);
      const validatedExpectedValue = validateCredentialValue(expectedValue);
      let deleted = false;
      await mutate(async (rawCredentials) => {
        const encryptedValue = rawCredentials[validatedKey];
        if (
          encryptedValue === undefined ||
          (await cipher.decrypt(encryptedValue)) !== validatedExpectedValue
        ) {
          return;
        }
        delete rawCredentials[validatedKey];
        deleted = true;
      });
      return deleted;
    },

    async deleteIfValues(
      expectedValues: Readonly<Record<string, string>>,
    ): Promise<Record<string, boolean>> {
      const validatedEntries = Object.entries(expectedValues).map(
        ([key, value]) => [validateCredentialKey(key), validateCredentialValue(value)] as const,
      );
      if (validatedEntries.length === 0) return {};
      const deleted: Record<string, boolean> = {};
      await mutate(async (rawCredentials) => {
        for (const [key, expectedValue] of validatedEntries) {
          const encryptedValue = rawCredentials[key];
          const matches =
            encryptedValue !== undefined &&
            (await cipher.decrypt(encryptedValue)) === expectedValue;
          deleted[key] = matches;
          if (matches) delete rawCredentials[key];
        }
      });
      return deleted;
    },

    /**
     * 条件事务：`guardKey` 当前值与期望值相等才删除 `keysToDelete` 全部 key，否则一个都不删。
     *
     * `deleteIfValues` 是逐 key 比较、逐 key 删除，无法表达「canonical generation 匹配
     * 才整体失效」——canonical 比较失败时 legacy 镜像仍可能被删掉，反之亦然。OAuth 凭据失效必须
     * 是整对的：stale 事务不能删掉 winner 的 canonical，也不能只删掉它的一半镜像。
     */
    async deleteManyIfValue(
      guardKey: string,
      expectedGuardValue: string,
      keysToDelete: readonly string[],
    ): Promise<boolean> {
      const validatedGuardKey = validateCredentialKey(guardKey);
      const validatedExpectedValue = validateCredentialValue(expectedGuardValue);
      const validatedKeys = keysToDelete.map(validateCredentialKey);
      let deleted = false;
      await mutate(async (rawCredentials) => {
        const encryptedGuard = rawCredentials[validatedGuardKey];
        if (
          encryptedGuard === undefined ||
          (await cipher.decrypt(encryptedGuard)) !== validatedExpectedValue
        ) {
          return;
        }
        for (const key of validatedKeys) delete rawCredentials[key];
        deleted = true;
      });
      return deleted;
    },

    async load(key: string): Promise<string | null> {
      const rawCredentials = await readCurrent();
      const rawValue = rawCredentials[validateCredentialKey(key)];
      if (rawValue === undefined) {
        return null;
      }
      return cipher.decrypt(rawValue);
    },

    loadMany,

    onDidChange(listener: () => void | Promise<void>): () => void {
      let listeners = credentialChangeListeners.get(filePath);
      if (!listeners) {
        listeners = new Set();
        credentialChangeListeners.set(filePath, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) credentialChangeListeners.delete(filePath);
      };
    },

    async save(key: string, value: string): Promise<void> {
      await updateMany({ [key]: value });
    },

    async saveMany(entries: Readonly<Record<string, string>>): Promise<void> {
      await updateMany(entries);
    },

    async saveReplacing(
      key: string,
      value: string,
      replacedKeys: readonly string[],
    ): Promise<void> {
      const validatedKey = validateCredentialKey(key);
      const encryptedValue = await cipher.encrypt(validateCredentialValue(value));
      const validatedReplacedKeys = replacedKeys.map(validateCredentialKey);
      await mutate(async (rawCredentials) => {
        rawCredentials[validatedKey] = encryptedValue;
        for (const replacedKey of validatedReplacedKeys) {
          if (replacedKey !== validatedKey) delete rawCredentials[replacedKey];
        }
      });
    },

    async saveZaiLoginCredentials(payload, expected, assertCurrent): Promise<void> {
      const snapshot = expected ?? (await loadOAuthSessionSnapshot());
      const committed = await updateMany(
        {
          ...Object.fromEntries(
            Object.values(SHARED_ZCODE_CREDENTIAL_KEYS).map((key) => [key, null]),
          ),
          [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: ZAI_PROVIDER_ID,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: payload.accessToken,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: payload.jwtToken,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo]: JSON.stringify(payload.user),
        },
        { expected: snapshot, assertCurrent },
      );
      if (!committed) throw new Error("OAuth session changed before login commit");
    },
  };
}

/** 所有凭据读取均为异步，避免系统密钥库阻塞 UI 或 CLI 事件循环。 */
export async function loadSharedZCodeCredential(
  key: string,
  options: SharedZCodeCredentialStoreOptions = {},
): Promise<string | undefined> {
  const value = await createSharedZCodeCredentialStore(options).load(key);
  return value?.trim() ? value : undefined;
}

export function resolveSharedZCodeCredentialsPath(
  options: SharedZCodeCredentialStoreOptions = {},
): string {
  if (options.filePath) {
    return resolveUserPath(options.filePath);
  }

  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? env[ZCODE_DATA_BASE_DIR_ENV_KEY] ?? homedir();
  return join(resolveUserPath(baseDir), ".zcode", "v2", "credentials.json");
}

async function readRawCredentialRecord(
  filePath: string,
  locked = false,
): Promise<Record<string, string>> {
  if (locked) return readRawCredentialRecordUnchecked(filePath);
  return withCredentialFileRead(filePath, () => readRawCredentialRecordUnchecked(filePath));
}

async function readRawCredentialRecordUnchecked(filePath: string): Promise<Record<string, string>> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read shared ZCode credentials: ${filePath}`, { cause: error });
  }

  try {
    // 宽松 UTF-8 解码会把坏字节替换后继续使用或写回，违背与 Desktop 共用的损坏边界。
    return parseCredentialRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  } catch (error) {
    // 损坏的凭据文件若被当成空对象继续保存，会一次性抹掉其他进程的全部凭据。
    // 先保留现场再失败，调用方必须显式处理恢复，不能静默覆盖。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    const evidence = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(`Shared ZCode credentials are corrupt: ${filePath}.${evidence}`, {
      cause: error,
    });
  }
}

async function mutateRawCredentialRecord(
  filePath: string,
  mutation: (value: Record<string, string>) => void | boolean | Promise<void | boolean>,
): Promise<void> {
  // CLI、设置页和 session 可能位于不同 Node 进程；锁必须覆盖完整的
  // read-modify-write，单独原子 rename 只能防半写，不能防旧快照覆盖新 key。
  const committed = await withCredentialFileMutation(filePath, async () => {
    const value = await readRawCredentialRecord(filePath, true);
    if ((await mutation(value)) === false) return false;
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  });
  if (!committed) return;
  const listeners = [...(credentialChangeListeners.get(filePath) ?? [])];
  // 同进程的 Registry Source 需要在登录返回前观察到新凭据；单个监听者失败不应
  // 把已经原子落盘的 Credential 伪装成写入失败。
  await Promise.allSettled(listeners.map((listener) => listener()));
}

function parseCredentialRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Credential record must be an object");
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Credential record value must be a string: ${key}`);
    }
    result[key] = entry;
  }
  return result;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function validateCredentialKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("Credential key must not be empty");
  }
  return trimmed;
}

function validateCredentialValue(value: string): string {
  if (value.length === 0) {
    throw new Error("Credential value must not be empty");
  }
  return value;
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
