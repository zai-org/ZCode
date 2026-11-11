import {
  createLegacyCredentialCipher,
  type CredentialCipher,
} from "@zcode/shared/credential-security";
export type CredentialCipherProvider = CredentialCipher;
/** 旧格式仅用于历史导入或显式 fixture，默认服务使用系统安全存储。 */
export function createCredentialCipherProvider(options: { env?: NodeJS.ProcessEnv } = {}) {
  return createLegacyCredentialCipher(options.env);
}
