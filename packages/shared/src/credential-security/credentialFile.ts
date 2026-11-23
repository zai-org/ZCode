import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withFileLock } from "../node/privateFilePersistence.js";
import {
  prepareCredentialSecretLocked,
  prepareServerCredentialStorage,
} from "./systemCredentialCipher.js";

/**
 * 进程装配：Source Server Core 使用自有凭据库时写入凭据文件的绝对路径，Core 拉起的 Agent 继承。
 * 不是用户配置；Desktop 不设置。
 */
export const ZCODE_CREDENTIALS_FILE_ENV = "ZCODE_CREDENTIALS_FILE";

const OS_SYSTEM_PREFIX = "enc:v2:os:";
const ENV_SYSTEM_PREFIX = "enc:v2:env:";

/** 读取进程装配的凭据文件；空值视为未设置，非绝对路径直接失败，不按 cwd 解析。 */
export function readAssignedCredentialsFile(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[ZCODE_CREDENTIALS_FILE_ENV]?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) {
    throw new Error(`${ZCODE_CREDENTIALS_FILE_ENV} must be an absolute file path`);
  }
  return value;
}

interface ServerCredentialFileOptions {
  /** 与本机 Desktop 共用的 `<dataBaseDir>/.zcode/v2/credentials.json`。 */
  sharedFilePath: string;
  /** Server 自有凭据文件；其所在目录存在即表示已改用自有库，且其中的密钥已就绪。 */
  serverFilePath: string;
}

/**
 * Bug 原因（评审）：原实现吞掉所有 stat 错误，已隔离的 Server 遇到 EACCES/EIO 或该路径被
 * 普通文件占用时被当作“未隔离”，Core 静默改用共享库，去访问 Desktop 的系统库条目，或报出
 * 掩盖原始故障的凭据错误。只有 ENOENT 表示不存在；其他错误和非目录向上抛出，阻止改选凭据库。
 */
async function isDirectory(path: string): Promise<boolean> {
  const metadata = await stat(path).catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return false;
  if (!metadata.isDirectory()) {
    throw Object.assign(new Error(`Server credential path is not a directory: ${path}`), {
      code: "ENOTDIR",
    });
  }
  return true;
}

async function readOptionalText(path: string): Promise<string | null> {
  return await readFile(path, "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Core 启动时只读判定 Server 使用哪个凭据文件，不创建目录或密钥；准备动作由启动命令负责。
 */
export async function resolveServerCredentialFile(
  options: ServerCredentialFileOptions,
): Promise<string> {
  const serverFilePath = resolve(options.serverFilePath);
  return (await isDirectory(dirname(serverFilePath)))
    ? serverFilePath
    : resolve(options.sharedFilePath);
}

/**
 * Bug 原因（评审）：原实现先创建自有目录、释放锁后再发布密钥。两步之间中断或发布失败时，
 * 由服务（`serve --daemon`，不带准备参数）拉起的 Core 会选中无密钥的自有库，在系统库可用时
 * 创建 OS 密钥并固定来源，之后的准备也不再生成文件密钥。修复：在同级私有临时目录中发布
 * credential-secret，再整体 rename 为自有目录，让“目录存在”与“密钥就绪”同时成立。
 * 调用方须持有共享库的凭据锁 → 密钥锁。
 */
async function publishServerCredentialDir(serverDir: string): Promise<void> {
  const staging = `${serverDir}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(serverDir), { recursive: true });
  await mkdir(staging, { mode: 0o700 });
  try {
    // 临时目录只有本进程知道，无需再取其中凭据文件的锁。
    await prepareCredentialSecretLocked(join(staging, "credentials.json"));
    await rename(staging, serverDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Desktop 发起的准备命令：判定 Server 使用的凭据文件并准备其密钥，返回该文件。
 *
 * Bug 原因（ZCT-2120452663971209216）：Source Server 与同机 Desktop 共用
 * `~/.zcode/v2/credentials.json`。Desktop 先把它固定为 OS 来源后，Server 进程拿不到 Desktop 的
 * 系统密钥：旧 Supervisor 下的候选 Core 按兼容规则拒绝已有 v2，在线更新必然失败并回滚；新
 * Supervisor 下的 Core 只能从 SSH/后台进程访问 Desktop 创建的系统库条目，同样不可用。
 * 修复：共享库已固定为 OS 来源时，Server 改用自有目录中的凭据文件与 credential-secret，
 * 不读写共享库。判定与原有密钥准备在同一组共享锁内完成，Desktop 不能在中间固定来源；
 * 自有目录一旦创建即为唯一事实，不随 Desktop 后续状态回退。
 */
export async function prepareServerCredentialFile(
  options: ServerCredentialFileOptions & {
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<string> {
  const env = options.env ?? process.env;
  const sharedFilePath = resolve(options.sharedFilePath);
  const serverFilePath = resolve(options.serverFilePath);
  const serverDir = dirname(serverFilePath);
  if (!(await isDirectory(serverDir))) {
    const managedSecret = Boolean(env.ZCODE_CREDENTIAL_SECRET || env.ZCODE_CREDENTIAL_SECRET_FILE);
    // 锁序与 prepareServerCredentialStorage 一致：凭据文件锁 → 密钥锁。
    const useServerFile = await withFileLock(sharedFilePath, () =>
      withFileLock(`${sharedFilePath}.keyring`, async () => {
        // 并发准备在锁外都看到“不存在”时，后到者在锁内复用已发布的目录。
        if (await isDirectory(serverDir)) return true;
        const pinnedSource = await readOptionalText(
          join(dirname(sharedFilePath), "credential-source"),
        );
        const raw = (await readOptionalText(sharedFilePath)) ?? "";
        // Bug 原因（评审）：显式密钥优先于 OS 标记，Server 能读共享库中自己写入的 v2:env
        // 条目；此时切到空自有库会让非 allowlist 凭据失效。共享库已有 v2 说明主机已运行
        // ≥3.18 的 owner，不存在旧候选 Core 拒绝 v2 的问题，因此保持共享库。
        const readableByManagedSecret = managedSecret && raw.includes(ENV_SYSTEM_PREFIX);
        if (
          (pinnedSource === "os\n" || raw.includes(OS_SYSTEM_PREFIX)) &&
          !readableByManagedSecret
        ) {
          await publishServerCredentialDir(serverDir);
          return true;
        }
        if (!managedSecret) await prepareCredentialSecretLocked(sharedFilePath);
        return false;
      }),
    );
    return useServerFile ? serverFilePath : sharedFilePath;
  }
  await prepareServerCredentialStorage({ filePath: serverFilePath, env });
  return serverFilePath;
}
