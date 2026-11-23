import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { link, lstat, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";
import {
  atomicWritePrivateTextFile,
  credentialGeneration,
  withFileLock,
} from "../node/privateFilePersistence.js";
import { RESET_STAGES, resetBoundCredentialStore } from "./boundStoreReset.js";
import {
  CREDENTIAL_SOURCE_FILE,
  OS_CIPHERTEXT_PREFIX,
  OS_SOURCE_MARKER,
  SYSTEM_PREFIX,
  isOsSourcePinned,
  readOptionalBytes,
  recordValues,
} from "./credentialFileState.js";
import type {
  CredentialCipher,
  CredentialKeyFailureDiagnostic,
  CredentialKeyFailureObserver,
  CredentialKeyFailureStage,
  CredentialKeyStore,
  PrivateFileKeyFallbackOptions,
  SystemCredentialCipherOptions,
  SystemCredentialCipher,
} from "./contract.js";

const LEGACY_PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SYSTEM_SERVICE = "ZCode Credential Encryption";
// 系统密钥属于进程内的凭据目录，而不属于某个短命 cipher。
// 成功与失败都共享：拒绝授权后，后台读请求不能再次触发系统弹窗。
interface KeyMaterial {
  key: Buffer;
  source: "os" | "env";
  legacySecret?: string;
  /** 加载时的恢复代次；只有缓存的默认密钥有（显式配置的密钥不缓存）。 */
  generation?: string;
}
const systemKeys = new Map<string, Promise<KeyMaterial>>();
const injectedSystemKeys = new WeakMap<CredentialKeyStore, Map<string, Promise<KeyMaterial>>>();
// 默认关闭；只有 Desktop Main 开启（全平台）。Server 与独立 CLI 保持显式配置要求。
let privateFileKeyFallback: PrivateFileKeyFallbackOptions | undefined;
let keyFailureObserver: CredentialKeyFailureObserver | undefined;

/**
 * Desktop Main 专用（全平台）：系统库不可用时，尚未绑定任何来源的凭据目录改用同目录私有
 * credential-secret；已绑定来源的目录在可判定的密钥丢失后由后台自动重置（见
 * resetBoundCredentialStore）。来源决策按进程共享，必须早于首次凭据访问；
 * 已有加载结果时返回 false 且不改变行为，避免同一进程出现两种来源规则。
 */
export function enablePrivateFileKeyFallback(options: PrivateFileKeyFallbackOptions = {}): boolean {
  if (systemKeys.size > 0) return false;
  privateFileKeyFallback = options;
  return true;
}

/**
 * 修复原因：3.18.2 Windows 用户 Credential Manager 已满时 CredWrite 返回
 * ERROR_NOT_ENOUGH_MEMORY，但所有失败都只剩统一的 unavailable 文案，日志分不清是模块加载、
 * 系统库读写还是文件层，排查需要多轮用户侧探针。这里给默认密钥加载提供进程级观察入口，
 * 每次加载失败通知一次（与失败缓存同一时机），日志量不随请求量增长。已注册时返回 false。
 */
export function observeCredentialKeyFailures(observer: CredentialKeyFailureObserver): boolean {
  if (keyFailureObserver) return false;
  keyFailureObserver = observer;
  return true;
}

function notifyKeyFailure(diagnostic: CredentialKeyFailureDiagnostic): void {
  try {
    keyFailureObserver?.({ ...diagnostic });
  } catch {
    /* 观察者只用于诊断，异常不能改变凭据结果。 */
  }
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
const UNAVAILABLE_CODE = "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE";
function unavailable(diagnostic?: CredentialKeyFailureDiagnostic): Error {
  // 系统库锁定/缺失不能冒充密文损坏，否则既有 OAuth 恢复逻辑会误删登录。
  return Object.assign(
    new Error(
      "System credential storage is unavailable. Unlock the OS credential store and restart to retry; headless servers require Secret Service, ZCODE_CREDENTIAL_SECRET, or a readable ZCODE_CREDENTIAL_SECRET_FILE of 32–4096 bytes. Do not configure both managed secret sources.",
    ),
    { code: UNAVAILABLE_CODE, ...(diagnostic ? { diagnostic } : {}) },
  );
}

// 只接受固定格式：Node.js 大写错误码；keyring-core 对 Windows 平台错误的
// “Windows error code N”/“Windows ERROR_*”与 std::io::Error 的“os error N”。
// 原生错误正文可能含路径或系统细节，绝不整体保留。
const NODE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OS_ERROR_NUMBER_PATTERN = /\b(?:Windows error code|os error) (\d{1,10})\b/;
const WINDOWS_ERROR_NAME_PATTERN = /\bWindows (ERROR_[A-Z_]{1,48})\b/;
// windows-native-keyring-store 只对这几个错误输出名称，其余输出数字。
const WINDOWS_NAMED_ERRORS: Readonly<Record<string, number>> = {
  ERROR_INVALID_PARAMETER: 87,
  ERROR_INVALID_FLAGS: 1004,
  ERROR_NOT_FOUND: 1168,
  ERROR_NO_SUCH_LOGON_SESSION: 1312,
  ERROR_BAD_USERNAME: 2202,
};

function nativeErrorCodes(error: unknown): Omit<CredentialKeyFailureDiagnostic, "stage"> {
  const codes: Omit<CredentialKeyFailureDiagnostic, "stage"> = {};
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === "string" && NODE_ERROR_CODE_PATTERN.test(code)) codes.errorCode = code;
  if (typeof message === "string") {
    const number = OS_ERROR_NUMBER_PATTERN.exec(message)?.[1];
    const name = WINDOWS_ERROR_NAME_PATTERN.exec(message)?.[1];
    const osCode = number !== undefined ? Number(number) : name && WINDOWS_NAMED_ERRORS[name];
    if (typeof osCode === "number" && Number.isSafeInteger(osCode)) codes.osCode = osCode;
  }
  return codes;
}

function diagnosticOf(error: unknown): CredentialKeyFailureDiagnostic | undefined {
  return (error as { diagnostic?: CredentialKeyFailureDiagnostic } | undefined)?.diagnostic;
}

/** 给失败标注阶段；已有诊断的错误（如更早的 load/config）保留原阶段。 */
function keyFailure(stage: CredentialKeyFailureStage, error: unknown): Error {
  if (diagnosticOf(error)) return error as Error;
  // 本模块自己抛出的 unavailable 没有原生信息，只记阶段。
  if ((error as { code?: unknown } | undefined)?.code === UNAVAILABLE_CODE)
    return unavailable({ stage });
  return unavailable({ stage, ...nativeErrorCodes(error) });
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
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE)
    throw unavailable({ stage: "config" });
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const explicit = env.ZCODE_CREDENTIAL_SECRET_FILE;
  if (!explicit && !discoverDefault) return undefined;
  const stage = explicit ? "config" : "managed";
  const path = explicit || join(dirname(resolve(options.filePath)), "credential-secret");
  const metadata = await stat(path).catch((error) => {
    if (!explicit && (error as { code?: string }).code === "ENOENT") return null;
    throw keyFailure(stage, error);
  });
  if (!metadata) return undefined;
  if (
    !metadata.isFile() ||
    (!explicit && process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  )
    throw unavailable({ stage });
  const value = await readFile(path, "utf8").catch((error) => {
    throw keyFailure(stage, error);
  });
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 4096) throw unavailable({ stage });
  return value;
}

function systemKeyStore(filePath: string): CredentialKeyStore {
  let entry: Promise<import("@napi-rs/keyring").AsyncEntry> | undefined;
  const getEntry = () => {
    // Bug 原因：模块加载失败与创建条目对象失败曾共用一个 catch，都被标成 load。Linux 没有
    // D-Bus 或 Secret Service 时，模块能加载，new AsyncEntry() 即抛错；load 不触发自动重置，
    // 已绑定 os 的目录一直无法再登录。修复：只有 import 失败标 load（打包回归，不重置）；
    // 构造失败保持原生错误，由 getKey 按所处阶段（read）标注，与读条目失败一样触发重置。
    entry ??= import("@napi-rs/keyring")
      .catch((error) => {
        throw keyFailure("load", error);
      })
      .then(
        ({ AsyncEntry }) =>
          new AsyncEntry(SYSTEM_SERVICE, digest(resolve(filePath)).toString("hex"), {
            linux: { store: "secret-service" },
          }),
      )
      .catch((error) => {
        entry = undefined;
        throw error;
      });
    return entry;
  };
  // 原生读写错误原样交给调用方：getKey 按所处阶段提取受控错误码，
  // 数据根切换同样转成 unavailable。原生错误正文不离开本模块。
  return {
    async get() {
      return await (await getEntry()).getPassword();
    },
    async set(value) {
      await (await getEntry()).setPassword(value);
    },
  };
}

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

export function createSystemCredentialCipher(
  options: SystemCredentialCipherOptions,
): SystemCredentialCipher {
  const env = options.env ?? process.env;
  let managedSecret: Promise<string | undefined> | undefined;
  // 此处只解析显式配置；默认文件必须在下方所有调用者共用的 keyring 锁内发现，避免来源竞态。
  // 结果按实例记住，失败也只通知一次。
  const getManagedSecret = () =>
    (managedSecret ??= resolveManagedSecret(options).catch((error) => {
      if (!options.keyStore) notifyKeyFailure(diagnosticOf(error) ?? { stage: "config" });
      throw error;
    }));
  const filePath = resolve(options.filePath);
  const store = options.keyStore ?? systemKeyStore(filePath);
  const cache = keyCacheFor(options.keyStore);
  const getKey = async (create: boolean): Promise<KeyMaterial> => {
    const secret = await getManagedSecret();
    if (secret) return { key: digest(secret), source: "env", legacySecret: secret };
    const existing = cache.get(filePath);
    if (existing) {
      const material = await existing;
      // Bug 原因：缓存的密钥曾在进程内永久有效。另一进程自动重置（missing）后重新登录会建立
      // 新系统密钥并再次固定 os，本进程仍用旧密钥加密，写入成功但冷启动无法解密。
      // 修复：缓存属于加载时的恢复代次；代次已变化就丢弃缓存，在 keyring 锁内重新加载。
      if (material.generation === (await credentialGeneration(filePath))) return material;
      if (cache.get(filePath) === existing) cache.delete(filePath);
      return getKey(create);
    }
    // 创建与读取分开：解密缺密钥的旧文件时禁止生成替代密钥、误判损坏并清理身份。
    let lockAcquired = false;
    const pendingKey = withFileLock(`${filePath}.keyring`, async () => {
      lockAcquired = true;
      // 当前步骤；任何失败由下方唯一的 catch 标注为该阶段，保证诊断与实际失败点一致。
      let stage: CredentialKeyFailureStage = "source";
      try {
        const sourcePath = join(dirname(filePath), CREDENTIAL_SOURCE_FILE);
        const pinnedSource = await readFile(sourcePath, "utf8").catch((error) => {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        });
        if (pinnedSource !== null && pinnedSource !== OS_SOURCE_MARKER) throw unavailable();
        stage = "file";
        const raw = await readFile(filePath, "utf8").catch((error) => {
          if ((error as { code?: string }).code === "ENOENT") return "";
          throw error;
        });
        // 重置在凭据文件锁与 keyring 锁内推进代次，因此这里读到的代次与本次加载的密钥一致。
        const generation = await credentialGeneration(filePath);
        // OS 初始化与首次写入之间也必须固定来源，不能被并发的远端准备切到文件密钥。
        const useOs = pinnedSource !== null || raw.includes("enc:v2:os:");
        if (!useOs) {
          stage = "managed";
          const value = await resolveManagedSecret({ filePath, env: {} }, true);
          if (value)
            return { key: digest(value), source: "env", legacySecret: value, generation } as const;
          if (raw.includes("enc:v2:env:")) throw unavailable();
        }
        // 目录尚未绑定任何来源（无来源标记、无 v2 密文、无私有文件），没有数据依赖系统密钥。
        const unbound = create && !useOs && !raw.includes(SYSTEM_PREFIX);
        let encoded: string | null;
        try {
          stage = "read";
          encoded = await store.get();
          if (encoded === null && unbound) {
            stage = "create";
            encoded = randomBytes(KEY_BYTES).toString("base64url");
            await store.set(encoded);
            stage = "verify";
            if ((await store.get()) !== encoded) throw unavailable();
          }
          stage = encoded ? "invalid" : "missing";
          if (!encoded || !ENCODED_KEY_PATTERN.test(encoded)) throw unavailable();
        } catch (error) {
          // Bug 原因：系统库可能不可用（Linux 没有 Secret Service、Windows Credential Manager
          // 已满、macOS 授权被拒绝等），Desktop 的失败缓存到进程退出，登录永远无法保存，
          // 删除 credentials.json 也不能恢复。修复：只对未绑定来源的目录，排他发布同目录 0600
          // 私有文件并使用它；之后所有进程按上方既有规则先发现该文件，不再访问系统库。
          // 已绑定来源的目录在这里不切换（已有密文离不开原密钥），交给后台自动重置。
          if (!privateFileKeyFallback || !unbound) throw error;
          const reason = diagnosticOf(keyFailure(stage, error))!;
          stage = "fallback";
          await publishPrivateSecretFile(join(dirname(filePath), "credential-secret"));
          const value = await resolveManagedSecret({ filePath, env: {} }, true);
          if (!value) throw unavailable();
          privateFileKeyFallback.onFallback?.(reason);
          return { key: digest(value), source: "env", legacySecret: value, generation } as const;
        }
        stage = "invalid";
        const key = Buffer.from(encoded, "base64url");
        if (key.length !== KEY_BYTES) throw unavailable();
        stage = "pin";
        if (!pinnedSource) await atomicWritePrivateTextFile(sourcePath, OS_SOURCE_MARKER);
        return { key, source: "os", generation } as const;
      } catch (error) {
        throw keyFailure(stage, error);
      }
    });
    cache.set(filePath, pendingKey);
    // Bug 原因：另一进程持锁等待系统授权超过锁等待上限时，锁超时也被当作系统库失败缓存，
    // 锁释放后本进程仍永久失败。未取得锁就没有访问系统库，不缓存；拒绝授权仍只弹一次。
    pendingKey.catch((error) => {
      if (!lockAcquired && cache.get(filePath) === pendingKey) cache.delete(filePath);
      // 锁内失败都已带诊断；未取得锁的失败保持原错误（调用方据锁超时错误码判断），只通知。
      if (!options.keyStore)
        notifyKeyFailure(diagnosticOf(error) ?? { stage: "lock", ...nativeErrorCodes(error) });
      // 只处理锁内、已缓存的失败：未取得锁的失败未缓存，下一次请求会重新加载。
      // 不能在本次请求里重置：请求可能来自正持有凭据文件锁的 Host，在这里取文件锁会互相等待。
      const diagnostic = diagnosticOf(error);
      const fallback = privateFileKeyFallback;
      if (fallback && lockAcquired && diagnostic && RESET_STAGES.has(diagnostic.stage)) {
        void resetBoundCredentialStore({
          filePath,
          cache,
          failed: pendingKey,
          diagnostic,
          isManagedSecretValid: () =>
            resolveManagedSecret({ filePath, env: {} }, true).then(
              (value) => value !== undefined,
              () => false,
            ),
        }).then((event) => {
          try {
            fallback.onReset?.(event);
          } catch {
            /* 观察者只用于日志，异常不能改变凭据结果。 */
          }
        });
      }
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
  // 与迁移保持同一锁序，避免迁移持有凭据锁并等待密钥锁时互相阻塞。
  await withFileLock(filePath, () =>
    withFileLock(`${filePath}.keyring`, () => prepareCredentialSecretLocked(filePath)),
  );
}

/** 调用方必须已按“凭据文件锁 → 密钥锁”持锁，且没有显式密钥配置。 */
export async function prepareCredentialSecretLocked(filePath: string): Promise<void> {
  const secretPath = join(dirname(filePath), "credential-secret");
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
}

/**
 * 写入凭据容器；调用方必须持有凭据文件锁。
 *
 * Bug 原因：自动重置删除 credential-source 后，同目录的独立 CLI 仍可能缓存着旧系统密钥并写入
 * enc:v2:os；getKey 见到 os 密文会优先选择系统库，Desktop 下次启动又失败并再次清空。
 * 修复：本次新产生的 os 密文（磁盘上的当前记录中没有该值）要求来源仍固定为 os，否则拒绝
 * 写入；重置推进了恢复代次，该进程下一次请求复核代次后按文件规则重新解析来源。
 * 磁盘上已有的值不检查（标记出现前的旧版本可能留下无标记的 os 密文）；env 密文不检查
 * （同机 Server 的显式密钥可写入已固定 os 的共享库）。
 *
 * 新 os 密文是否来自重置前的旧密钥不在这里判断：写入方在加密前用 withCredentialGeneration
 * 领取代次，由锁内代次屏障拒绝跨越重置的写入（加密可能在另一进程完成，这里无从得知）。
 */
export async function writeCredentialRecordLocked(
  filePath: string,
  record: Readonly<Record<string, string>>,
): Promise<void> {
  const osValues = Object.values(record).filter((value) => value.startsWith(OS_CIPHERTEXT_PREFIX));
  if (osValues.length > 0 && !(await isOsSourcePinned(resolve(filePath)))) {
    const existing = new Set(recordValues(await readOptionalBytes(filePath)));
    if (osValues.some((value) => !existing.has(value))) throw unavailable();
  }
  await atomicWritePrivateTextFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
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
