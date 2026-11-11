/* eslint-disable max-lines -- Provisioning target keeps transaction and rollback invariants together. */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  providerProvisioningEnvelopeSchema,
  OAUTH_SESSION_REVISION_KEY,
  providerProvisioningResultSchema,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
} from "@zcode/shared";
import type { LocalCredentialService } from "#src/credential/credentialService.js";
import type { ISettingService } from "../setting/setting.js";
import type { ProviderRuntime } from "./providerRuntime.js";
import type { AccountProviderService } from "@zcode/provider";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import {
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  PROVIDER_PROVISIONING_LEGACY_OAUTH_CREDENTIAL_KEYS,
  readProvisionablePersonalConfig,
} from "./providerProvisioningSource.js";

const PROVISIONING_SCHEMA_VERSION = 1 as const;

const OAUTH_CREDENTIAL_KEYS = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);

export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly accountProviderSource: Pick<AccountProviderService, "refresh">;
  readonly credentialService: Pick<LocalCredentialService, "loadMany" | "updateMany">;
  readonly settingService: ISettingService;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
  readonly listProvisioningCredentialKeys?: () => Promise<readonly string[]>;
}

interface ProvisioningStateRecord {
  readonly syncId: string;
  readonly result: ProviderProvisioningResult;
}

interface ProvisioningStateFile {
  readonly schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  readonly records: readonly ProvisioningStateRecord[];
}

/** 运行在目标 Environment 内的 Provisioning target；负责写正式 Store 并在失败时回滚。 */
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
      const envelope = providerProvisioningEnvelopeSchema.parse(input);
      return withFileLock(options.stateFilePath, async () => {
        const previousState = await readStateFile(options.stateFilePath);
        const previousResult = previousState?.records.find(
          (record) => record.syncId === envelope.syncId,
        );
        if (previousResult) {
          return {
            ...previousResult.result,
            status: "already-applied",
          } satisfies ProviderProvisioningResult;
        }

        validateCredentialEntries(envelope);
        // schema v1 接受旧 Source 的账号 Key 字段，但新 Host 不再读取或应用它。
        // 旧/手工 Key 留在原 Store，避免升级同步误删其它客户端共享的凭据。
        const oauthCredentials = envelope.credentials.filter(
          (entry) => entry.scope === "oauth-session",
        );
        await options.providerRuntime.start();
        const before = await captureBeforeState(envelope, options);
        const personalUpdate = parsePersonalConfig(envelope);
        const applied: AppliedProvisioningState = {
          settings: false,
          settingsExpected: envelope.accountSettings,
          settingsVersion: Math.max(
            Date.now(),
            (before.settings.providerFamilyDomainUpdatedAt ?? 0) + 1,
          ),
          credentials: null,
          personalConfig: false,
          personalConfigExpected: personalUpdate,
        };

        let errorCode: ProviderProvisioningErrorCode = "target-write-failed";
        try {
          // 先登记再写入：底层原子写即使在替换完成后才抛错，也必须进入回滚集合。
          applied.settings = true;
          await options.settingService.update(
            {
              providerFamilyDomainUpdatedAt: applied.settingsVersion,
              providerFamilyDomain: envelope.accountSettings.providerFamilyDomain ?? undefined,
              providerFamilyConnectionSelections:
                envelope.accountSettings.providerFamilyConnectionSelections,
            },
            {
              // 原因：Host 同步也与本地连接选择竞争，提交必须比较捕获的完整快照和版本。
              providerFamilyDomain: before.settings.providerFamilyDomain,
              providerFamilyConnectionSelections:
                before.settings.providerFamilyConnectionSelections,
              providerFamilyDomainUpdatedAt: before.settings.providerFamilyDomainUpdatedAt ?? 0,
            },
          );

          const incomingCredentials = new Map(
            oauthCredentials.map((credential) => [credential.key, credential.value]),
          );
          const credentials = Object.fromEntries(
            Object.keys(before.credentials).map((key) => [
              key,
              incomingCredentials.get(key) ?? null,
            ]),
          );
          // revision 属于目标进程的会话提交，不能重放 Source 旧代次制造 A→B→A。
          // 同 syncId 已在前面零写入返回；每次真正应用都生成新的目标代次。
          credentials[OAUTH_SESSION_REVISION_KEY] = randomUUID();
          applied.credentials = credentials;
          if (
            !(await options.credentialService.updateMany(credentials, {
              expected: before.credentials,
            }))
          ) {
            throw new Error("OAuth 会话在同步期间被其它操作修改");
          }

          applied.personalConfig = true;
          await options.personalRepository.update((current) => {
            // 其他域写入期间 Personal 可能已被编辑；检查与替换必须在同一个文件锁内。
            if (!samePersonalConfig(current, before.personal)) {
              throw new Error("Personal Provider Config 在同步期间被其它操作修改");
            }
            return personalUpdate;
          });

          errorCode = "target-refresh-failed";
          await options.accountProviderSource.refresh("provider-provisioning");
          const snapshot =
            await options.providerRuntime.registryService.refresh("provider-provisioning");
          // 失效默认只是新会话偏好；把它当同步硬条件会让正常 SSH 被旧模型/档位阻断。
          // 原样保留偏好，由 Host 现有推荐逻辑解析；真实写入/刷新失败仍按事务回滚。

          const result = {
            syncId: envelope.syncId,
            status: "applied" as const,
            personalProviderCount: personalUpdate.providers.keys().length,
            credentialCount: oauthCredentials.length,
            configRevision: snapshot.sourceRevisions.config,
            rolledBack: false,
          } satisfies ProviderProvisioningResult;
          errorCode = "target-commit-failed";
          await writeStateFile(options.stateFilePath, appendStateRecord(previousState, result));
          return result;
        } catch (error) {
          // 回滚前对每个 domain 做 CAS 式校验；若期间已有其它写入，宁可报告
          // rollback_failed，也不能用过期快照覆盖或删除用户的新配置。
          const rollbackError = await rollback(before, applied, options);
          if (rollbackError) {
            return {
              syncId: envelope.syncId,
              status: "rollback_failed",
              personalProviderCount: before.personal.providers.keys().length,
              credentialCount: oauthCredentials.length,
              errorMessage: `${formatError(error)}；回滚失败：${formatError(rollbackError)}`,
              errorCode,
              rolledBack: false,
            } satisfies ProviderProvisioningResult;
          }
          return {
            syncId: envelope.syncId,
            status: "failed",
            personalProviderCount: before.personal.providers.keys().length,
            credentialCount: oauthCredentials.length,
            errorMessage: formatError(error),
            errorCode,
            rolledBack: true,
          } satisfies ProviderProvisioningResult;
        }
      });
    },
  };
}

interface BeforeState {
  readonly personal: ProviderConfigLayerUpdate;
  readonly settings: Awaited<ReturnType<ISettingService["get"]>>;
  readonly credentials: Readonly<Record<string, string | null>>;
}

interface AppliedProvisioningState {
  settings: boolean;
  settingsExpected: ProviderProvisioningEnvelope["accountSettings"];
  settingsVersion: number;
  credentials: Readonly<Record<string, string | null>> | null;
  personalConfig: boolean;
  personalConfigExpected: ProviderConfigLayerUpdate;
}

function parsePersonalConfig(envelope: ProviderProvisioningEnvelope): ProviderConfigLayerUpdate {
  // 信封与本地保存复用正式 Personal codec，不在接收端另建字段清单或模式判断。
  return decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
}

async function captureBeforeState(
  envelope: ProviderProvisioningEnvelope,
  options: ProviderProvisioningTargetOptions,
): Promise<BeforeState> {
  const [personal, settings] = await Promise.all([
    readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
    options.settingService.get(),
  ]);
  const credentialKeys = new Set<string>([
    ...OAUTH_CREDENTIAL_KEYS,
    ...((await options.listProvisioningCredentialKeys?.()) ?? []),
    ...envelope.credentials.map((entry) => entry.key),
  ]);
  const credentials = await options.credentialService.loadMany(
    [...credentialKeys].filter((key) => OAUTH_CREDENTIAL_KEYS.has(key)),
  );
  return {
    personal,
    settings,
    credentials,
  };
}

async function rollback(
  before: BeforeState,
  applied: AppliedProvisioningState,
  options: ProviderProvisioningTargetOptions,
): Promise<Error | undefined> {
  const errors: unknown[] = [];
  if (applied.personalConfig) {
    try {
      await options.personalRepository.update((current) => {
        if (samePersonalConfig(current, before.personal)) return current;
        if (!samePersonalConfig(current, applied.personalConfigExpected)) {
          throw new Error("Personal Provider Config 在同步期间被其它操作修改，跳过回滚");
        }
        // 默认选择与 Provider/Model 共用一份 CAS；不能分别回滚制造混合状态或覆盖新选择。
        return before.personal;
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (applied.credentials) {
    try {
      const current = await options.credentialService.loadMany(Object.keys(before.credentials));
      if (!sameCredentials(current, before.credentials)) {
        // 比较与回滚写入在同一凭据锁内完成；并发登录时整组保留，不逐键拼接两代会话。
        if (
          !(await options.credentialService.updateMany(
            { ...before.credentials, [OAUTH_SESSION_REVISION_KEY]: randomUUID() },
            { expected: applied.credentials },
          ))
        ) {
          throw new Error("OAuth 会话在同步期间被其它操作修改，跳过整组回滚");
        }
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (applied.settings) {
    try {
      const current = await options.settingService.get();
      const previousSettings = toProvisioningAccountSettings(before.settings);
      if (sameAccountSettings(current, previousSettings)) {
        // 写入失败发生在落盘前，目标已经处于回滚前的状态。
      } else if (
        !sameAccountSettings(current, applied.settingsExpected) ||
        (current.providerFamilyDomainUpdatedAt ?? 0) !== applied.settingsVersion
      ) {
        errors.push(new Error("Account Settings 在同步期间被其它操作修改，跳过回滚"));
      } else {
        await options.settingService.update(
          {
            providerFamilyDomain: before.settings.providerFamilyDomain,
            providerFamilyConnectionSelections: before.settings.providerFamilyConnectionSelections,
          },
          {
            // 原因：归属检查与写入间仍有竞态，回滚也必须在锁内比较本次提交版本。
            providerFamilyDomain: current.providerFamilyDomain,
            providerFamilyConnectionSelections: current.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: applied.settingsVersion,
          },
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return new Error(errors.map(formatError).join("；"));
  }
  try {
    await options.accountProviderSource.refresh("provider-provisioning-rollback");
    await options.providerRuntime.registryService.refresh("provider-provisioning-rollback");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

function samePersonalConfig(
  left: ProviderConfigLayerUpdate,
  right: ProviderConfigLayerUpdate,
): boolean {
  return (
    JSON.stringify(encodeProviderConfigFile(left)) ===
    JSON.stringify(encodeProviderConfigFile(right))
  );
}

function toProvisioningAccountSettings(
  settings: Awaited<ReturnType<ISettingService["get"]>>,
): ProviderProvisioningEnvelope["accountSettings"] {
  return {
    providerFamilyDomain: settings.providerFamilyDomain ?? null,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
  };
}

function sameAccountSettings(
  current: Awaited<ReturnType<ISettingService["get"]>>,
  expected: ProviderProvisioningEnvelope["accountSettings"],
): boolean {
  return JSON.stringify(toProvisioningAccountSettings(current)) === JSON.stringify(expected);
}

function sameCredentials(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  return Object.keys(right).every((key) => left[key] === right[key]);
}

function validateCredentialEntries(envelope: ProviderProvisioningEnvelope): void {
  const seen = new Set<string>();
  const oauthKeys =
    envelope.schemaVersion === 3
      ? OAUTH_CREDENTIAL_KEYS
      : new Set<string>(PROVIDER_PROVISIONING_LEGACY_OAUTH_CREDENTIAL_KEYS);
  for (const entry of envelope.credentials) {
    if (seen.has(entry.key)) throw new Error(`重复 Provisioning Credential key: ${entry.key}`);
    seen.add(entry.key);
    const allowed =
      (entry.scope === "oauth-session" && oauthKeys.has(entry.key)) ||
      (entry.scope === "account-provider" && isProviderProvisioningAccountCredentialKey(entry.key));
    if (!allowed) throw new Error(`不允许同步的 Credential key: ${entry.key}`);
  }
}

async function readStateFile(filePath: string): Promise<ProvisioningStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROVISIONING_SCHEMA_VERSION) {
      return null;
    }
    const rawRecords = Array.isArray(parsed.records)
      ? parsed.records
      : parsed.syncId && parsed.result
        ? [{ syncId: parsed.syncId, result: parsed.result }]
        : [];
    const records = rawRecords.flatMap((record) => {
      if (typeof record !== "object" || record === null) return [];
      const candidate = record as Record<string, unknown>;
      if (typeof candidate.syncId !== "string" || !candidate.syncId.trim()) return [];
      const result = providerProvisioningResultSchema.safeParse(candidate.result);
      return result.success ? [{ syncId: candidate.syncId, result: result.data }] : [];
    });
    return { schemaVersion: PROVISIONING_SCHEMA_VERSION, records };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
}

function appendStateRecord(
  previousState: ProvisioningStateFile | null,
  result: ProviderProvisioningResult,
): ProvisioningStateFile {
  const records = [
    ...(previousState?.records ?? []).filter((record) => record.syncId !== result.syncId),
    { syncId: result.syncId, result },
  ];
  return {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    records,
  };
}

function writeStateFile(filePath: string, state: ProvisioningStateFile): Promise<void> {
  return atomicWritePrivateTextFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
