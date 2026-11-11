import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  providerProvisioningEnvelopeSchema,
  OAUTH_LINKED_BIGMODEL_KEY,
  OAUTH_SESSION_REVISION_KEY,
  type ProviderProvisioningCredentialEntry,
  type ProviderProvisioningEnvelope,
} from "@zcode/shared";
import type {
  PersonalProviderConfigRepository,
  ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import { type CredentialCipherProvider } from "../credential/providers/credentialCipherProvider.js";
import type { ISettingService } from "../setting/setting.js";

const CREDENTIAL_FILE_NAME = "credentials.json";
export const PROVIDER_PROVISIONING_LEGACY_OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "zcodejwttoken",
] as const;

/** v3 的 OAuth 会话组；旧信封不允许声明新增字段。 */
export const PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS = [
  ...PROVIDER_PROVISIONING_LEGACY_OAUTH_CREDENTIAL_KEYS,
  OAUTH_SESSION_REVISION_KEY,
  OAUTH_LINKED_BIGMODEL_KEY,
  "oauth:zai_cn:access_token",
  "oauth:zai_cn:refresh_token",
  "oauth:zai_cn:user_info",
] as const;

export interface ProviderProvisioningSource {
  read(syncId: string): Promise<ProviderProvisioningEnvelope>;
}

export interface ProviderProvisioningSourceOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly settingService: ISettingService;
  readonly credentialFilePath: string;
  readonly personalConfigFilePath: string;
  readonly cipherProvider?: CredentialCipherProvider;
}

/** 从 Local Environment 读取可 Provision 的事实；不会读取或导出完整 Registry Snapshot。 */
export function createProviderProvisioningSource(
  options: ProviderProvisioningSourceOptions,
): ProviderProvisioningSource {
  // 同步源会反复读取快照；复用 cipher，避免每次同步都重新申请系统凭据访问。
  const cipher =
    options.cipherProvider ??
    createSystemCredentialCipher({ filePath: options.credentialFilePath });
  return {
    async read(syncId: string): Promise<ProviderProvisioningEnvelope> {
      const [personal, settings, credentials] = await Promise.all([
        readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
        options.settingService.get(),
        readProvisioningCredentials(options.credentialFilePath, cipher),
      ]);
      // 默认与规则来自同一份持锁读取，不能把两次读取的值拼成不存在的配置版本。
      const personalConfig = encodeProviderConfigFile(personal).config;
      const accountSettings = {
        providerFamilyDomain: settings.providerFamilyDomain ?? null,
        providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
      };
      return providerProvisioningEnvelopeSchema.parse({
        schemaVersion: 3,
        syncId,
        personalConfig,
        accountSettings,
        credentials,
      });
    },
  };
}

/** 分发读取不能把坏文件的内存降级当成权威；Source 与 Target 使用同一完整读取约束。 */
export async function readProvisionablePersonalConfig(
  repository: PersonalProviderConfigRepository,
  filePath: string,
): Promise<ProviderConfigLayerSnapshot> {
  const personal = await repository.read();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      const rules = personal.models.toPersonalJSON();
      // 首次尚无 Personal 文件是合法空配置；已有内容后文件消失不能继续导出旧快照。
      if (
        personal.providers.keys().length === 0 &&
        rules.providerModelRules.length === 0 &&
        rules.manualProviderModelRules.length === 0 &&
        !personal.providerOrder?.length &&
        personal.defaultModelSelection === undefined
      )
        return personal;
    }
    throw new Error(`本地 Personal Provider Config 无法同步: ${filePath}`, { cause: error });
  }
  try {
    const decoded = decodeProviderConfigFile(JSON.parse(raw) as unknown);
    const actualRevision = createHash("sha256")
      .update(JSON.stringify(encodeProviderConfigFile(decoded)))
      .digest("hex");
    if (actualRevision !== personal.revision) {
      throw new Error("Personal Provider Config 在读取期间发生变化");
    }
    return personal;
  } catch (error) {
    throw new Error(`本地 Personal Provider Config 无法同步: ${filePath}`, { cause: error });
  }
}

async function readProvisioningCredentials(
  credentialFilePath: string,
  cipher: CredentialCipherProvider,
): Promise<ProviderProvisioningCredentialEntry[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Credential Store 必须是 JSON 对象");
  }
  const allowedKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const entries: ProviderProvisioningCredentialEntry[] = [];
  // Credential Store 还可能包含不属于 Provisioning allowlist 的历史记录；
  // 这些记录不是本次同步事实，不能因为其值损坏而阻断合法账号凭据的同步。
  // allowlist 内的条目仍保持字符串和解密校验，避免把未知内容当成 Secret 传输。
  for (const [key, encrypted] of Object.entries(parsed)) {
    // OAuth 换证不再依赖旧账号 Key；它的坏密文也不能阻断远端登录态同步。
    if (!allowedKeys.has(key)) continue;
    if (typeof encrypted !== "string") {
      throw new Error(`Credential allowlist value must be a string: ${key}`);
    }
    const value = await cipher.decrypt(encrypted);
    if (!value.trim()) continue;
    entries.push({ scope: "oauth-session", key, value });
  }
  return entries;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveCredentialFilePath(appConfigDir: string): string {
  return join(appConfigDir, CREDENTIAL_FILE_NAME);
}

/** 只枚举 Provisioning allowlist 的物理 key，供目标端实现 replace-allowlist 删除语义。 */
export async function listProviderProvisioningCredentialKeys(
  credentialFilePath: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Credential Store 必须是 JSON 对象");
  const oauthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  return Object.keys(parsed).filter((key) => oauthKeys.has(key));
}
