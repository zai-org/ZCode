export interface CredentialCipher {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
  needsMigration?(value: string): boolean;
}
export interface SystemCredentialCipher extends CredentialCipher {
  /** 独立 Server 在开放服务前验证安全后端；不返回密钥。 */
  initialize(): Promise<void>;
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
