import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { link, lstat, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "../node/privateFilePersistence.js";
import type {
  CredentialCipher,
  CredentialKeyStore,
  PrivateFileKeyFallbackOptions,
  SystemCredentialCipherOptions,
  SystemCredentialCipher,
} from "./contract.js";

const LEGACY_PREFIX = "enc:v1:";
const SYSTEM_PREFIX = "enc:v2:";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SYSTEM_SERVICE = "ZCode Credential Encryption";
/** 与凭据文件同目录的来源标记；内容只能是 OS_SOURCE_MARKER，不含密钥。 */
const CREDENTIAL_SOURCE_FILE = "credential-source";
const OS_SOURCE_MARKER = "os\n";
// 系统密钥属于进程内的凭据目录，而不属于某个短命 cipher。
// 成功与失败都共享：拒绝授权后，后台读请求不能再次触发系统弹窗。
interface KeyMaterial {
  key: Buffer;
  source: "os" | "env";
  legacySecret?: string;
}
const systemKeys = new Map<string, Promise<KeyMaterial>>();
const injectedSystemKeys = new WeakMap<CredentialKeyStore, Map<string, Promise<KeyMaterial>>>();
// 默认关闭；只有 Linux Desktop Main 开启。Server 与独立 CLI 保持显式配置要求。
let privateFileKeyFallback: PrivateFileKeyFallbackOptions | undefined;

/**
 * Linux Desktop Main 专用：Secret Service 不可用时，允许尚未绑定任何来源的凭据目录改用
 * 同目录私有 credential-secret。来源决策按进程共享，必须早于首次凭据访问；
 * 已有加载结果时返回 false 且不改变行为，避免同一进程出现两种来源规则。
 */
export function enablePrivateFileKeyFallback(options: PrivateFileKeyFallbackOptions = {}): boolean {
  if (systemKeys.size > 0) return false;
  privateFileKeyFallback = options;
  return true;
}

function keyCacheFor(store?: CredentialKeyStore): Map<string, Promise<KeyMaterial>> {
  if (!store) return systemKeys;
  let cache = injectedSystemKeys.get(store);
  if (!cache) {
    cache = new Map();
    injectedSystemKeys.set(store, cache);
  }
  return cache;
}

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}
function decryptError(): Error {
  return Object.assign(
    new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}Invalid encrypted credential`),
    { code: CREDENTIAL_DECRYPT_ERROR_CODE },
  );
}
function unavailable(): Error {
  // 系统库锁定/缺失不能冒充密文损坏，否则既有 OAuth 恢复逻辑会误删登录。
  return Object.assign(
    new Error(
      "System credential storage is unavailable. Unlock the OS credential store and restart to retry; headless servers require Secret Service, ZCODE_CREDENTIAL_SECRET, or a readable ZCODE_CREDENTIAL_SECRET_FILE of 32–4096 bytes. Do not configure both managed secret sources.",
    ),
    { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" },
  );
}
function seal(value: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
}
function open(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)))
    throw decryptError();
  const [iv, tag, bytes] = parts.map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !bytes || iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw decryptError();
  try {
    const cipher = createDecipheriv(ALGORITHM, key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
  } catch {
    throw decryptError();
  }
}

function legacyKeyCandidates(env: Readonly<Record<string, string | undefined>>): Buffer[] {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* 兼容旧版本的同一默认推导规则。 */
  }
  const fallback = `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
  const secret = env.ZCODE_CREDENTIAL_SECRET;
  // 旧 Desktop 使用原字符串，旧 CLI 会 trim；不能让共用 decoder 破坏任一端升级。
  // GCM 认证决定正确历史密钥，绝不把解密失败的密文作为明文返回。
  // 首次配置随机密钥时，旧记录仍可能使用默认派生密钥，必须先读旧值再迁移。
  const keys = [...new Set([secret || fallback, secret?.trim() || fallback, fallback])].map(digest);
  return keys;
}

/** 仅兼容旧容器及显式 fixture；默认运行时必须使用 createSystemCredentialCipher。 */
export function createLegacyCredentialCipher(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { encrypt(value: string): string; decrypt(value: string): string } {
  return createLegacyCipher(legacyKeyCandidates(env));
}

function createLegacyCipher(keys: Buffer[], writeKey = keys[0]!) {
  return {
    encrypt: (value: string) => LEGACY_PREFIX + seal(value, writeKey),
    decrypt(value: string) {
      if (value.startsWith(LEGACY_PREFIX)) {
        for (const key of keys) {
          try {
            return open(value.slice(LEGACY_PREFIX.length), key);
          } catch {
            /* 继续尝试另一端的历史规则。 */
          }
        }
        throw decryptError();
      }
      if (value.startsWith("enc:")) throw decryptError();
      return value;
    },
  };
}

async function resolveManagedSecret(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
  discoverDefault = false,
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) throw unavailable();
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const explicit = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (!explicit && !discoverDefault) return undefined;
  const path = explicit || join(dirname(resolve(options.filePath)), "credential-secret");
  const metadata = await stat(path).catch((error) => {
    if (!explicit && (error as { code?: string }).code === "ENOENT") return null;
    throw unavailable();
  });
  if (!metadata) return undefined;
  if (
    !metadata.isFile() ||
    (!explicit && process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  )
    throw unavailable();
  const value = await readFile(path, "utf8").catch(() => {
    throw unavailable();
  });
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 4096) throw unavailable();
  return value;
}

function systemKeyStore(filePath: string): CredentialKeyStore {
  let entry: Promise<import("@napi-rs/keyring").AsyncEntry> | undefined;
  const getEntry = () => {
    entry ??= import("@napi-rs/keyring")
      .then(
        ({ AsyncEntry }) =>
          new AsyncEntry(SYSTEM_SERVICE, digest(resolve(filePath)).toString("hex"), {
            linux: { store: "secret-service" },
          }),
      )
      .catch(() => {
        entry = undefined;
        throw unavailable();
      });
    return entry;
  };
  return {
    async get() {
      try {
        return await (await getEntry()).getPassword();
      } catch {
        throw unavailable();
      }
    },
    async set(value) {
      try {
        await (await getEntry()).setPassword(value);
      } catch {
        throw unavailable();
      }
    },
  };
}

const OS_CIPHERTEXT_PREFIX = `${SYSTEM_PREFIX}os:`;
const KEY_FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;
const ENCODED_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function keyFingerprint(key: Buffer): string {
  return digest(key).toString("hex").slice(0, 24);
}

/** 系统条目中编码密钥的指纹；格式不合法时返回 null。 */
function encodedKeyFingerprint(encoded: string): string | null {
  return ENCODED_KEY_PATTERN.test(encoded)
    ? keyFingerprint(Buffer.from(encoded, "base64url"))
    : null;
}

/** 读取凭据容器中 os 来源密文的密钥指纹；文件缺失或无法解析时视为没有（损坏由既有恢复机制处理）。 */
async function readOsKeyFingerprints(filePath: string): Promise<Set<string>> {
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  });
  const fingerprints = new Set<string>();
  let record: unknown;
  try {
    record = JSON.parse(raw || "{}");
  } catch {
    return fingerprints;
  }
  if (!record || typeof record !== "object") return fingerprints;
  for (const value of Object.values(record)) {
    if (typeof value !== "string" || !value.startsWith(OS_CIPHERTEXT_PREFIX)) continue;
    const fingerprint = value.slice(OS_CIPHERTEXT_PREFIX.length).split(":")[0];
    if (fingerprint && KEY_FINGERPRINT_PATTERN.test(fingerprint)) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

/** 凭据目录的来源是否已固定为 os；标记缺失视为未固定，其他读取错误向上抛出。 */
async function isOsSourcePinned(filePath: string): Promise<boolean> {
  const marker = await readFile(join(dirname(filePath), CREDENTIAL_SOURCE_FILE), "utf8").catch(
    (error) => {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    },
  );
  return marker === OS_SOURCE_MARKER;
}

export function createSystemCredentialCipher(
  options: SystemCredentialCipherOptions,
): SystemCredentialCipher {
  const env = options.env ?? process.env;
  let managedSecret: Promise<string | undefined> | undefined;
  // 此处只解析显式配置；默认文件必须在下方所有调用者共用的 keyring 锁内发现，避免来源竞态。
  const getManagedSecret = () => (managedSecret ??= resolveManagedSecret(options));
  const filePath = resolve(options.filePath);
  const store = options.keyStore ?? systemKeyStore(filePath);
  const cache = keyCacheFor(options.keyStore);
  const getKey = async (create: boolean): Promise<KeyMaterial> => {
    const secret = await getManagedSecret();
    if (secret) return { key: digest(secret), source: "env", legacySecret: secret };
    const existing = cache.get(filePath);
    if (existing) return existing;
    // 创建与读取分开：解密缺密钥的旧文件时禁止生成替代密钥、误判损坏并清理身份。
    let lockAcquired = false;
    const pendingKey = withFileLock(`${filePath}.keyring`, async () => {
      lockAcquired = true;
      try {
        const sourcePath = join(dirname(filePath), CREDENTIAL_SOURCE_FILE);
        const pinnedSource = await readFile(sourcePath, "utf8").catch((error) => {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        });
        if (pinnedSource !== null && pinnedSource !== OS_SOURCE_MARKER) throw unavailable();
        const raw = await readFile(filePath, "utf8").catch((error) => {
          if ((error as { code?: string }).code === "ENOENT") return "";
          throw error;
        });
        // OS 初始化与首次写入之间也必须固定来源，不能被并发的远端准备切到文件密钥。
        const useOs = pinnedSource !== null || raw.includes("enc:v2:os:");
        if (!useOs) {
          const value = await resolveManagedSecret({ filePath, env: {} }, true);
          if (value) return { key: digest(value), source: "env", legacySecret: value } as const;
          if (raw.includes("enc:v2:env:")) throw unavailable();
        }
        // 目录尚未绑定任何来源（无来源标记、无 v2 密文、无私有文件），没有数据依赖系统密钥。
        const unbound = create && !useOs && !raw.includes(SYSTEM_PREFIX);
        let encoded: string | null;
        try {
          encoded = await store.get();
          if (encoded === null && unbound) {
            encoded = randomBytes(KEY_BYTES).toString("base64url");
            await store.set(encoded);
            if ((await store.get()) !== encoded) throw unavailable();
          }
          if (!encoded || !ENCODED_KEY_PATTERN.test(encoded)) throw unavailable();
        } catch (error) {
          // Bug 原因：Linux 的 Secret Service 不是必备组件；没有 keyring 服务、D-Bus 不可达，
          // 或 keyring 被锁且用户取消解锁框时，Desktop 的失败缓存到进程退出，登录永远无法保存，
          // 删除 credentials.json 也不能恢复。修复：只对未绑定来源的目录，排他发布同目录 0600
          // 私有文件并使用它；之后所有进程按上方既有规则先发现该文件，不再访问系统库。
          // 已绑定来源的目录绝不切换，避免已有密文失去对应密钥。
          if (!privateFileKeyFallback || !unbound) throw error;
          await publishPrivateSecretFile(join(dirname(filePath), "credential-secret"));
          const value = await resolveManagedSecret({ filePath, env: {} }, true);
          if (!value) throw unavailable();
          privateFileKeyFallback.onFallback?.();
          return { key: digest(value), source: "env", legacySecret: value } as const;
        }
        const key = Buffer.from(encoded, "base64url");
        if (key.length !== KEY_BYTES) throw unavailable();
        if (!pinnedSource) await atomicWritePrivateTextFile(sourcePath, OS_SOURCE_MARKER);
        return { key, source: "os" } as const;
      } catch {
        throw unavailable();
      }
    });
    cache.set(filePath, pendingKey);
    // Bug 原因：另一进程持锁等待系统授权超过锁等待上限时，锁超时也被当作系统库失败缓存，
    // 锁释放后本进程仍永久失败。未取得锁就没有访问系统库，不缓存；拒绝授权仍只弹一次。
    pendingKey.catch(() => {
      if (!lockAcquired && cache.get(filePath) === pendingKey) cache.delete(filePath);
    });
    return pendingKey;
  };
  return {
    async initialize() {
      await getKey(true);
    },
    needsMigration: (value) => !value.startsWith(SYSTEM_PREFIX),
    async shareKeyWithCopiedCredentials(targetFilePath, targetKeyStore) {
      // 修复原因（ZCT-2120723935487688704）：系统条目按凭据文件路径区分，切换数据存储路径
      // 只复制 credentials.json 与 credential-source；新根没有条目，来源又固定为 os，
      // 启动后既解不开原凭据也不能生成新密钥，用户掉登录且无法重新登录。
      // 这里由密钥 owner 把同一把密钥登记到目标路径，密文和指纹无需改写。
      const target = resolve(targetFilePath);
      if (target === filePath) return;
      const [sourcePrints, targetPrints, sourcePinned, targetPinned] = await Promise.all([
        readOsKeyFingerprints(filePath),
        readOsKeyFingerprints(target),
        isOsSourcePinned(filePath),
        isOsSourcePinned(target),
      ]);
      // 目标条目要满足的密钥：目标有本目录的 os 密文时必须是生成它的那把；null 表示任意合法条目。
      let requiredFingerprint: string | null;
      if (targetPrints.size === 1) {
        const [fingerprint] = targetPrints;
        // 密文不来自本目录（目标自有凭据未被覆盖）：没有数据依赖本目录密钥。
        if (!fingerprint || !sourcePrints.has(fingerprint)) return;
        requiredFingerprint = fingerprint;
      } else if (targetPrints.size === 0 && targetPinned && sourcePinned) {
        // 修复原因（评审）：源已固定 os 但没有 os 密文（只用过 API Key 后删光、CLI 登录前写入
        // 探针后中止、恢复凭据存储后），复制把 credential-source 带到新根；新根没有条目时
        // getKey 按“密钥丢失”拒绝生成新密钥，重新登录失败。标记依赖的是“目标路径有条目”，
        // 不依赖某把具体密钥。源未固定时目标标记不是本次复制带来的，按下方原则不处理。
        requiredFingerprint = null;
      } else {
        // 从未建过密钥、托管密钥等：不访问系统库，也不加载本目录密钥——空目录加载失败会
        // 缓存到进程退出，阻断之后的首次登录。
        return;
      }
      const targetStore = targetKeyStore ?? systemKeyStore(target);
      // 修复原因（评审）：已受影响的根（3.18.0 切换后缺自己的条目）按 spec 补救切回原路径时，
      // Main 绑定的本目录没有密钥，先加载本目录密钥会失败并中止切换，用户被困在受影响的根。
      // 切换只需保证目标条目能解开目标密文：目标条目指纹已匹配时直接成功，不加载本目录密钥。
      const registered = await targetStore.get().catch(() => {
        throw unavailable();
      });
      const registeredFingerprint = registered === null ? null : encodedKeyFingerprint(registered);
      if (
        registeredFingerprint !== null &&
        (requiredFingerprint === null || registeredFingerprint === requiredFingerprint)
      )
        return;
      const { key, source } = await getKey(false);
      if (
        source !== "os" ||
        (requiredFingerprint !== null && keyFingerprint(key) !== requiredFingerprint)
      )
        return;
      const encoded = key.toString("base64url");
      // 与 getKey 使用同一把目标 keyring 锁，避免与目标路径上的首次创建竞争。
      await withFileLock(`${target}.keyring`, async () => {
        try {
          const existing = await targetStore.get();
          if (existing === encoded) return;
          // 目标路径已有另一把密钥时可能仍有数据依赖它，不能覆盖；明确失败让调用方中止切换。
          if (existing !== null) throw unavailable();
          await targetStore.set(encoded);
          if ((await targetStore.get()) !== encoded) throw unavailable();
        } catch {
          throw unavailable();
        }
      });
    },
    async encrypt(value) {
      const { key, source } = await getKey(true);
      const fingerprint = keyFingerprint(key);
      return `${SYSTEM_PREFIX}${source}:${fingerprint}:${seal(value, key)}`;
    },
    async decrypt(value) {
      if (!value.startsWith(SYSTEM_PREFIX)) {
        if (value.startsWith("enc:") && !value.startsWith(LEGACY_PREFIX)) throw decryptError();
        const { legacySecret } = await getKey(true);
        return createLegacyCredentialCipher({
          ...env,
          ZCODE_CREDENTIAL_SECRET: legacySecret,
        }).decrypt(value);
      }
      const parts = value.slice(SYSTEM_PREFIX.length).split(":");
      if (
        parts.length !== 3 ||
        !parts[0] ||
        !parts[1] ||
        !parts[2] ||
        !["os", "env"].includes(parts[0]) ||
        !/^[a-f0-9]{24}$/.test(parts[1])
      )
        throw decryptError();
      const { key, source } = await getKey(false);
      if (parts[0] !== source) throw unavailable();
      if (keyFingerprint(key) !== parts[1]) throw unavailable();
      return open(parts[2], key);
    },
  };
}

/** Desktop 显式请求远端准备；随机密钥只在目标机生成，不能随连接结果返回。 */
export async function prepareServerCredentialStorage(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE) return;
  const filePath = resolve(options.filePath);
  const secretPath = join(dirname(filePath), "credential-secret");
  // 与迁移保持同一锁序，避免迁移持有凭据锁并等待密钥锁时互相阻塞。
  await withFileLock(filePath, () =>
    withFileLock(`${filePath}.keyring`, async () => {
      const existing = await lstat(secretPath).catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      });
      if (existing) return;
      const pinnedSource = await readFile(
        join(dirname(filePath), CREDENTIAL_SOURCE_FILE),
        "utf8",
      ).catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      });
      if (pinnedSource !== null) {
        if (pinnedSource !== OS_SOURCE_MARKER) throw unavailable();
        return;
      }
      const raw = await readFile(filePath, "utf8").catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return "";
        throw error;
      });
      // 已有 v2 数据意味着已有独立密钥来源。丢失密钥时不能生成替代品或切换来源。
      if (raw.includes(SYSTEM_PREFIX)) return;
      await publishPrivateSecretFile(secretPath);
    }),
  );
}

/** 调用方须持有 keyring 锁并确认目录未绑定来源；已有文件绝不覆盖。 */
async function publishPrivateSecretFile(secretPath: string): Promise<void> {
  const temporary = `${secretPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, randomBytes(KEY_BYTES).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    // 先完整写入，再排他发布；rename 会覆盖另一创建者，直接写目标会暴露半个密钥。
    await link(temporary, secretPath).catch((error) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Server 无交互 shell；读取持久私有文件，准备动作由启动命令显式负责。 */
export async function createLegacyServerCredentialCipher(
  options: Pick<SystemCredentialCipherOptions, "filePath" | "env">,
): Promise<CredentialCipher> {
  return await withFileLock(options.filePath, async () => {
    const raw = await readFile(options.filePath, "utf8").catch((error) => {
      if ((error as { code?: string }).code === "ENOENT") return "";
      throw error;
    });
    // 旧 Supervisor 可能自动拉回旧 Core；在 handoff 前不能写入它不认识的新密文。
    if (raw.includes(SYSTEM_PREFIX)) throw unavailable();
    const env = options.env ?? process.env;
    const secret = await resolveManagedSecret(options, true);
    const keys = legacyKeyCandidates({ ...env, ZCODE_CREDENTIAL_SECRET: secret });
    let values: string[] = [];
    try {
      values = Object.values(JSON.parse(raw || "{}")).filter(
        (value): value is string => typeof value === "string" && value.startsWith(LEGACY_PREFIX),
      );
    } catch {
      /* 损坏容器仍由既有 Store 恢复路径处理。 */
    }
    // 随机文件可能刚为升级准备。继续使用已认证的历史密钥，不能提前让旧 Core 失去读权限。
    const writeKey =
      keys.find((key) =>
        values.some((value) => {
          try {
            open(value.slice(LEGACY_PREFIX.length), key);
            return true;
          } catch {
            return false;
          }
        }),
      ) ??
      (env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE
        ? keys[0]!
        : legacyKeyCandidates(env)[0]!);
    const cipher = createLegacyCipher(keys, writeKey);
    return {
      ...cipher,
      decrypt(value: string) {
        if (value.startsWith(SYSTEM_PREFIX)) throw unavailable();
        return cipher.decrypt(value);
      },
    };
  });
}

export async function createServerCredentialCipher(
  options: SystemCredentialCipherOptions,
): Promise<SystemCredentialCipher> {
  const env = options.env ?? process.env;
  const defaultFile = join(dirname(resolve(options.filePath)), "credential-secret");
  try {
    const cipher = createSystemCredentialCipher({ ...options, env });
    await cipher.initialize();
    return cipher;
  } catch (error) {
    // 首句保留操作方法，确保 Supervisor 有界错误摘要和 Desktop 连接详情仍能展示。
    throw Object.assign(
      new Error(
        `Remote credential storage unavailable. Restore or create the correct private (0600), 32–4096 byte credential-secret file in the remote ZCode config directory (${dirname(defaultFile)}), then reconnect. Or configure ZCODE_CREDENTIAL_SECRET_FILE before starting the remote service. Existing encrypted data requires its original key.`,
        { cause: error },
      ),
      { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" },
    );
  }
}

/** 调用方须在既有文件锁内读、迁移和写；不会修改传入对象，失败时不产生半份迁移。 */
export async function migrateCredentialRecord(
  record: Readonly<Record<string, string>>,
  cipher: CredentialCipher,
): Promise<Record<string, string> | null> {
  const needsMigration = cipher.needsMigration;
  if (!needsMigration) return null;
  if (!Object.values(record).some((value) => needsMigration(value))) return null;
  // 混合新旧容器先验证已有新格式的密钥来源；不能迁移一半后才发现原密钥不可用。
  for (const value of Object.values(record)) {
    if (needsMigration(value)) continue;
    try {
      await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== CREDENTIAL_DECRYPT_ERROR_CODE) throw error;
    }
  }
  const next = { ...record };
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    if (!needsMigration(value)) continue;
    let plain: string;
    try {
      plain = await cipher.decrypt(value);
    } catch (error) {
      if ((error as { code?: unknown })?.code === CREDENTIAL_DECRYPT_ERROR_CODE) continue;
      throw error;
    }
    next[key] = await cipher.encrypt(plain);
    changed = true;
  }
  return changed ? next : null;
}
