import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  ZCODE_AGENT_PROVIDER,
  encodeCustomModelValue,
  type ProviderFamilyConnectionSelection,
} from "@zcode/shared";
import { TID_CHAT_MODEL_SELECT_TRIGGER, TID_V4_MODEL_CONFIG } from "@zcode/shared/test-ids";
import { getE2EAppDataPaths } from "./desktop-app.js";
import { getUpstreamApiKey } from "./upstream-provider.js";
import { waitForSqliteTable } from "./e2e-sqlite-readiness.js";
import { resolveSeededReplayBaseUrl } from "./custom-openai-provider-store.js";
import {
  restartIntoWorkspacePreservingProfile as restartIntoWorkspacePreservingProfileFixture,
  restartIntoWorkspaceRestoringPreferences,
  type ModelProviderRestartOptions,
} from "./model-provider-restart-runtime.js";
import {
  seedPersonalProviderConfig,
  type PersonalProviderConfigSeed,
  type SeedReplayProviderModel,
} from "./model-provider-restart-config.js";
import { getV4DraftThoughtState } from "./v4-conversation.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";

const paths = getE2EAppDataPaths();
const SETTINGS_FILE = join(paths.appDataDir, "setting.json");
const CREDENTIALS_FILE = paths.credentialsFile;
// 设备级引导记录跟随 dataBaseDir，E2E 隔离 HOME 下即 appDataDir。
const ONBOARDING_RECORD_FILE = join(paths.appDataDir, "onboarding-record.json");
const BIGMODEL_E2E_USER_ID = "bigmodel-e2e-user";
async function currentComposerRecentKey(): Promise<string> {
  return browser.execute((workspacePath) => {
    // 首次草稿可能尚无导航缓存；直接读当前草稿 owner，不能用旧 workspace 键或猜测项目。
    const state = (
      window as Window & {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftProjectId?: string | null }> };
        };
      }
    ).__zcodeSessionStoreE2E?.getState().workspaces[workspacePath];
    if (!state) throw new Error(`当前工作区草稿状态未就绪: ${workspacePath}`);
    return `zcode-composer-recent:v2:${JSON.stringify(["desktop", "local", state.draftProjectId ?? null])}`;
  }, paths.workspace);
}

export { seedTurboAgentStartupModel } from "./model-provider-restart-runtime.js";

export const E2E_BIGMODEL_PLAN_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
export const E2E_BIGMODEL_START_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
export const E2E_BIGMODEL_API_PROVIDER_ID = BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
export const E2E_PLAN_FIRST_MODEL = "GLM-5.3";
export const E2E_PLAN_DEFAULT_MODEL = "GLM-5.2";
export const E2E_PLAN_NON_DEFAULT_MODEL = "GLM-5.3-Flash";
export const E2E_PLAN_TURBO_MODEL = "GLM-5-Turbo";

export async function seedBigModelConnectionSelection(
  selection: ProviderFamilyConnectionSelection,
) {
  await writeJsonPatch(SETTINGS_FILE, {
    providerFamilyConnectionSelections: {
      bigmodel: selection,
    },
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainMigrated: true,
  });
}

export async function readBigModelConnectionSelection(): Promise<
  ProviderFamilyConnectionSelection | undefined
> {
  const settings = await readJson(SETTINGS_FILE);
  const selections = settings.providerFamilyConnectionSelections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return undefined;
  }
  return (selections as { bigmodel?: ProviderFamilyConnectionSelection }).bigmodel;
}

export async function seedBigModelOAuthCredential() {
  await writeJsonPatch(CREDENTIALS_FILE, {
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: BIGMODEL_E2E_USER_ID,
      username: "bigmodel-e2e-user",
    }),
  });
}

/**
 * 换成种入的 BigModel 身份重启后，等该身份的职业引导判定落定；需要引导时按真实 UI 跳过。
 * 修复原因：settings 已有职业时主界面不等判定先渲染；新身份没有引导记录也没有本地任务，
 * 判定稍后返回需要引导，引导页整页盖住主界面。Windows 上主界面就绪早于判定结果，
 * 随后点不到模型选择器。判定落定只有两个事实：引导页已出现，或本地引导记录已有该身份
 * （作答、关闭或存量用户）。不能把主界面可见当作就绪，也不能用固定等待猜时序。
 */
export async function settleBigModelIdentityOnboarding() {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="onboarding-page"]').isExisting()) ||
      (await hasOnboardingIdentityRecord(BIGMODEL_E2E_USER_ID)),
    { timeout: 30_000, timeoutMsg: "BigModel 身份的职业引导判定没有落定" },
  );
  await skipOccupationOnboardingIfPresent();
}

async function hasOnboardingIdentityRecord(userId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(ONBOARDING_RECORD_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const record = JSON.parse(raw) as {
    entries?: { userId?: string | null }[];
    decisions?: { userId?: string | null }[];
  };
  return [...(record.entries ?? []), ...(record.decisions ?? [])].some(
    (item) => item.userId === userId,
  );
}

/** 为需要经过 Highspeed 网关鉴权的 E2E 补齐登录 JWT。 */
export async function seedHighspeedLoginCredential() {
  await writeJsonPatch(CREDENTIALS_FILE, {
    zcodejwttoken: "e2e-highspeed-zcode-jwt",
  });
}

/**
 * 为需要实际进入 BigModel Start Plan 的 E2E 补齐 zcode JWT。
 *
 * Start Plan 与个人 Coding Plan 共用 OAuth 用户身份，但请求授权读取的是
 * `zcodejwttoken`；只 seed business access token 会让菜单把 Start Plan 判成未认证。
 */
export async function seedBigModelStartPlanCredential() {
  await writeJsonPatch(CREDENTIALS_FILE, {
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: BIGMODEL_E2E_USER_ID,
      username: "bigmodel-e2e-user",
    }),
    zcodejwttoken: "e2e-bigmodel-start-plan-jwt",
  });
}

export async function seedReplayProvider(params: {
  apiFormat?: PersonalProviderConfigSeed["apiFormat"];
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
  id: string;
  models: readonly SeedReplayProviderModel[];
  name: string;
}) {
  const baseURL = params.baseURL ?? (await resolveSeededReplayBaseUrl());
  if (!baseURL) {
    throw new Error("没有可用 replay Base URL，无法 seed model provider restart case");
  }
  const provider: PersonalProviderConfigSeed = {
    id: params.id,
    label: params.name,
    // 内建 account provider 的模型规则按 anthropic-messages 匹配；若用 OpenAI Chat Completions
    // 格式覆盖连接配置，GLM builtin model rules 不会命中，模型在 Registry 中
    // 会因缺少完整 option/properties 被过滤，UI 菜单就看不到该计划模型。
    apiFormat:
      params.apiFormat ??
      (params.id.startsWith("account:") ? "anthropic-messages" : "openai-chat-completions"),
    apiKey: params.apiKey ?? getUpstreamApiKey(),
    baseURL,
    enabled: params.enabled ?? true,
    models: params.models.map((input) =>
      typeof input === "string"
        ? { id: input }
        : {
            contextWindow: input.contextWindow,
            id: input.id,
            maxOutputTokens: input.maxOutputTokens ?? input.limit?.output,
            // 保留场景声明的档位，避免退回 disabled 后拒绝已保存的 high/max 偏好。
            reasoningLevel: input.reasoningLevel,
          },
    ),
  };
  await seedPersonalProviderConfig(paths.configFile, provider);
}

export async function seedPersistedModelSelection(params: {
  modelId: string;
  providerId: string;
  reasoningLevel: string;
}) {
  const key = await currentComposerRecentKey();
  await browser.execute(
    (recentKey, selection, appProvider) => {
      const previous = JSON.parse(window.localStorage.getItem(recentKey) ?? "{}");
      window.localStorage.setItem(
        recentKey,
        JSON.stringify({
          ...previous,
          modelSelection: {
            providerId: selection.providerId,
            modelId: selection.modelId,
            options: { reasoningLevel: selection.reasoningLevel },
          },
        }),
      );
      window.localStorage.setItem("zcode-last-agent-provider", appProvider);
    },
    key,
    params,
    ZCODE_AGENT_PROVIDER,
  );
}

export async function readLastSelectedAgentConfig() {
  const key = await currentComposerRecentKey();
  return await browser.execute((recentKey) => {
    const raw = window.localStorage.getItem(recentKey);
    if (!raw) return null;
    const recent: unknown = JSON.parse(raw);
    // Recent 扩展为模型与权限并列保存；重启断言同时兼容旧的纯模型种子。
    const record = recent && typeof recent === "object" && !Array.isArray(recent) ? recent : null;
    const selection =
      record && "modelSelection" in record ? record.modelSelection : (record ?? recent);
    const candidate =
      selection && typeof selection === "object" && !Array.isArray(selection)
        ? (selection as {
            providerId?: unknown;
            modelId?: unknown;
            options?: { reasoningLevel?: unknown };
          })
        : null;
    if (
      !candidate ||
      typeof candidate.providerId !== "string" ||
      typeof candidate.modelId !== "string" ||
      candidate.providerId.length === 0 ||
      candidate.modelId.length === 0
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      model: `${candidate.providerId}/${candidate.modelId}`,
      thoughtLevel: candidate.options?.reasoningLevel ?? null,
    };
  }, key);
}

export async function waitForLastSelectedAgentConfig(params: {
  model: string;
  thoughtLevel: string;
}) {
  let latest: Awaited<ReturnType<typeof readLastSelectedAgentConfig>> = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readLastSelectedAgentConfig();
        return Boolean(
          latest?.model.includes(params.model) && latest.thoughtLevel === params.thoughtLevel,
        );
      },
      {
        timeout: 30000,
        timeoutMsg: `last-selected 配置没有收敛到 ${params.model}/${params.thoughtLevel}`,
      },
    );
  } catch {
    const storedAgentPreferences = await browser.execute(() =>
      Object.fromEntries(
        Object.entries(window.localStorage).filter(([key]) => key.startsWith("zcode-last-agent-")),
      ),
    );
    throw new Error(
      `last-selected 配置没有收敛到 ${params.model}/${params.thoughtLevel}，实际值：${JSON.stringify(latest)}，全部偏好：${JSON.stringify(storedAgentPreferences)}`,
    );
  }
  return latest;
}

export async function seedGlobalAgentReasoningLevel(thoughtLevel: string) {
  const databasePath = join(paths.storageRoot, "cli", "db", "db.sqlite");
  // Bug 根因：workspace UI ready 不代表 Agent DB migration ready；直接打开 writable DB
  // 会在父目录尚未创建时报 unable to open，甚至可能抢先生成缺少 schema 的空库。
  await waitForSqliteTable(databasePath, "local_setting");
  const db = new DatabaseSync(databasePath);
  const now = Date.now();
  try {
    db.exec("pragma busy_timeout = 5000");
    // Bug 根因：同一 spec 内 Agent SQLite 会跨 case 保留上一条显式 thought，
    // 只 seed renderer localStorage 不能隔离跨模型默认值。这里固定 Agent 侧前置状态，
    // 避免 I39 的 GLM high 泄漏到 I42，让用例真正验证 Turbo enabled → GLM 默认值。
    db.prepare(`
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
    `).run(
      "user",
      "default",
      "model",
      "reasoningLevel",
      JSON.stringify({ level: thoughtLevel }),
      1,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

export async function waitForDraftThoughtLevelState(params: {
  current: string;
  values: readonly string[];
  timeoutMsg?: string;
}) {
  let latest: Awaited<ReturnType<typeof getV4DraftThoughtState>> | null = null;
  await browser.waitUntil(
    async () => {
      // Bugfix：legacy workspace 目录可能仍属于上一模型；当前值与能力集优先读 V4
      // 当前模型投影，避免把 Turbo 二态误判成旧模型的 off/high/max。
      latest = await getV4DraftThoughtState(paths.workspace);
      const actualValues = [...latest.values].sort();
      const expectedValues = [...params.values].sort();
      return (
        latest.current === params.current &&
        JSON.stringify(actualValues) === JSON.stringify(expectedValues)
      );
    },
    {
      timeout: 30000,
      timeoutMsg: params.timeoutMsg ?? `draft thought 没有收敛到 ${params.current}`,
    },
  );
  return latest;
}

export async function waitForV4DraftModelConfig(params: { model: string; thought: string }) {
  let latest: { model: string | null; thought: string | null } | null = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((configTestId) => {
        const config = document.querySelector<HTMLElement>(`[data-testid="${configTestId}"]`);
        return {
          model: config?.dataset.model?.trim() || null,
          thought: config?.dataset.thought?.trim() || null,
        };
      }, TID_V4_MODEL_CONFIG);
      const modelMatches =
        latest.model === params.model || latest.model?.endsWith(`/${params.model}`) === true;
      return modelMatches && latest.thought === params.thought;
    },
    {
      timeout: 30000,
      timeoutMsg: `V4 draft 配置没有收敛到 ${params.model}/${params.thought}`,
    },
  );
  return latest;
}

export async function waitForPlanModelIoRequest(expectedText: string) {
  const debugDir = join(paths.homeDir, ".zcode", "cli", "debug");
  let matched: { model?: string; thinking?: { type?: string } } | null = null;
  await browser.waitUntil(
    async () => {
      const files = await readdir(debugDir).catch(() => []);
      for (const file of files.filter(
        (item) => item.startsWith("model-io-") && item.endsWith(".jsonl"),
      )) {
        const content = await readFile(join(debugDir, file), "utf-8").catch(() => "");
        for (const line of content.split("\n")) {
          if (!line.includes(expectedText)) continue;
          try {
            const record = JSON.parse(line) as {
              querySource?: string;
              request?: { body?: { model?: string; thinking?: { type?: string } } };
            };
            if (record.querySource === "main_turn" && record.request?.body) {
              matched = record.request.body;
              return true;
            }
          } catch {
            // model IO 正在追加时可能读到半行，下一轮重试即可。
          }
        }
      }
      return false;
    },
    { timeout: 30000, timeoutMsg: `没有找到 Plan model IO 请求: ${expectedText}` },
  );
  return matched as { model?: string; thinking?: { type?: string } } | null;
}

export async function restartIntoWorkspace(options: ModelProviderRestartOptions = {}) {
  await restartIntoWorkspaceRestoringPreferences(paths.workspace, options);
}

export async function restartIntoWorkspacePreservingProfile() {
  await restartIntoWorkspacePreservingProfileFixture(paths.workspace);
}

export async function waitForSelectedModel(providerId: string, modelId: string) {
  const expected = encodeCustomModelValue(providerId, modelId);
  const recentKey = await currentComposerRecentKey();
  let actual: string | null = null;
  let storedConfig: string | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const snapshot = await browser.execute(
          (value, triggerTestId, key) => {
            const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
            return {
              actual: trigger?.dataset.modelCurrentValue ?? null,
              matched: trigger?.dataset.modelCurrentValue === value,
              storedConfig: window.localStorage.getItem(key),
            };
          },
          expected,
          TID_CHAT_MODEL_SELECT_TRIGGER,
          recentKey,
        );
        actual = snapshot.actual;
        storedConfig = snapshot.storedConfig;
        return snapshot.matched;
      },
      {
        timeout: 30000,
        timeoutMsg: `toolbar 没有选择 ${expected}`,
      },
    );
  } catch (error) {
    throw new Error(
      `toolbar 没有选择 ${expected}，actual=${actual}，storedConfig=${storedConfig}`,
      { cause: error },
    );
  }
}

async function writeJsonPatch(file: string, patch: Record<string, unknown>) {
  const current = await readJson(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
