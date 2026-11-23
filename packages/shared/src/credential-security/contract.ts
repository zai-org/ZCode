export interface CredentialCipher {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  needsMigration?(value: string): boolean;
}
export interface SystemCredentialCipher extends CredentialCipher {
  /** 独立 Server 在开放服务前验证安全后端；不返回密钥。 */
  initialize(): Promise<void>;
  /**
   * 数据根复制后，保证目标凭据路径的系统条目能满足复制过去的依赖；不读出密钥。
   * 目标 os 密文只有一个指纹且也出现在本目录文件时，条目必须是这把密钥；目标没有 os 密文、
   * 但目标与本目录的 credential-source 都是 os 时，条目只需存在且合法；其他情况不访问系统库。
   * 目标条目已满足时直接成功，不加载本目录密钥；目标条目缺失时登记本目录密钥，
   * 本目录密钥不可用或目标已登记另一把密钥时以 CREDENTIAL_SECURE_STORAGE_UNAVAILABLE 拒绝，不覆盖。
   * `targetKeyStore` 只供测试替换目标条目。
   */
  shareKeyWithCopiedCredentials(
    targetFilePath: string,
    targetKeyStore?: CredentialKeyStore,
  ): Promise<void>;
}
/** 仅后端可持有；不得通过 RPC 暴露系统密钥。 */
export interface CredentialKeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}
export interface SystemCredentialCipherOptions {
  filePath: string;
  env?: Readonly<Record<string, string | undefined>>;
  keyStore?: CredentialKeyStore;
}
/** Desktop Main 开启私有文件密钥回退与自动重置时的观察入口；回调不接收密钥或凭据值。 */
export interface PrivateFileKeyFallbackOptions {
  /** `diagnostic` 是触发回退的系统库失败原因。 */
  onFallback?(diagnostic: CredentialKeyFailureDiagnostic): void;
  /** 已绑定目录的自动重置在后台结束时调用一次（含放弃与失败）。 */
  onReset?(event: CredentialStoreResetEvent): void;
}
/**
 * 自动重置结果。`reset`：已解除来源绑定；`clearedEntries` 为清空的条目数（0 表示只移走了
 * 无数据依赖的坏私有文件）。`skipped`：锁内复核不再满足条件。`failed`：重置中途 IO 失败，
 * 失败缓存保持。路径只指向备份文件，不含密钥或凭据值。
 */
export type CredentialStoreResetEvent =
  | {
      status: "reset";
      diagnostic: CredentialKeyFailureDiagnostic;
      clearedEntries: number;
      backupPath?: string;
      movedSecretPath?: string;
    }
  | { status: "skipped"; diagnostic: CredentialKeyFailureDiagnostic }
  | { status: "failed"; diagnostic: CredentialKeyFailureDiagnostic; errorCode?: string };
/**
 * 默认密钥加载失败的阶段：显式配置、来源标记、凭据文件、私有密钥文件、加载原生模块、
 * 读条目、写条目、写后读回、已绑定来源但条目缺失、条目格式、写来源标记、发布回退文件、
 * 取得 keyring 锁。
 */
export type CredentialKeyFailureStage =
  | "config"
  | "source"
  | "file"
  | "managed"
  | "load"
  | "read"
  | "create"
  | "verify"
  | "missing"
  | "invalid"
  | "pin"
  | "fallback"
  | "lock";
/** 受控诊断：只含阶段与固定格式的错误码，不含密钥、凭据值、路径或原生错误正文。 */
export interface CredentialKeyFailureDiagnostic {
  stage: CredentialKeyFailureStage;
  /** Node.js 错误码，如 `ENOENT`、`EPERM`、`ZCODE_FILE_LOCK_TIMEOUT`。 */
  errorCode?: string;
  /** 系统错误号，如 Windows `8` = `ERROR_NOT_ENOUGH_MEMORY`。 */
  osCode?: number;
}
/** 进程级观察者；每次默认密钥加载失败调用一次。异常被隔离，不影响凭据结果。 */
export type CredentialKeyFailureObserver = (diagnostic: CredentialKeyFailureDiagnostic) => void;
