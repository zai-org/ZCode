import {
  createLegacyCredentialCipher,
  type CredentialCipher,
} from "@zcode/shared/credential-security";
export type ZCodeCredentialCipher = CredentialCipher;
export interface ZCodeCredentialCipherOptions {
  env?: Record<string, string | undefined>;
}
/** 仅兼容旧格式；正式凭据仓库默认使用系统安全存储。 */
export function createZCodeCredentialCipher(options: ZCodeCredentialCipherOptions = {}) {
  return createLegacyCredentialCipher(options.env);
}
export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith("enc:");
}
