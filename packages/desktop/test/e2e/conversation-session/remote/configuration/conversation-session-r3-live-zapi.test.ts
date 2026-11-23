import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ApiKeyAccessConfig, ProviderApiConfig, ProviderConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import { getUpstreamRequestRecordCount } from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_LIVE_ZAPI";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-live-zapi");
const LIVE_PROVIDER_ID = "e2e-r3-live-zapi";
const LIVE_PROVIDER_NAME = "R3 Live ZAPI";
const LIVE_MODEL_ID = "GLM-5.3";
const USER_ZAPI_PROVIDER_ID = "84916fff-3839-4e1c-a59d-64923669a665";
const run = promisify(execFile);

/** 用户输入含相同标记；必须在 assistant 正文中等待，并容许模型插入空白。 */
async function waitForLiveReply(marker: string): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = (await getV4Messages("assistant")).map((message) => message.text ?? "").join("\n");
      return text.replace(/\s+/gu, "").includes(marker);
    },
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: assistant 未返回 ${marker}` },
  );
  return text;
}

/** 只从本机正式 Personal 配置读取 ZAPI 的 baseURL 与 key（内存），经产品 Personal 写入口导入隔离 profile；key 不写入任何记录。 */
async function seedLiveZapiProvider(): Promise<{ baseURL: string; keyLength: number }> {
  // WDIO worker 的 HOME 已被 E2E 隔离目录覆盖，真实 Personal 配置路径由启动方显式传入。
  const sourcePath = process.env.R3_LIVE_PERSONAL_CONFIG?.trim();
  if (!sourcePath)
    throw new Error(`${CASE_MARKER}: 需设置 R3_LIVE_PERSONAL_CONFIG 指向本机 provider_config.json`);
  // 0911 修复：本机配置已迁移到新 schema（schemaVersion:1, config.providerConfigRules），
  // 旧的手读 raw.providers[<id>] 得到 undefined → TypeError。改走正式 repository.read()
  // 拿统一 snapshot（新旧 schema 由其内部归一），找不到材料时报可读错误而非崩在类型上。
  const sourceRepository = new NodePersonalProviderConfigRepository({
    filePath: sourcePath,
    pollingIntervalMs: false,
  });
  let sourceApiKey: string | undefined;
  let sourceBaseURL: string | undefined;
  let sourceApiType: string | undefined;
  let sourceModelIds: readonly string[] | undefined;
  try {
    const snapshot = await sourceRepository.read();
    const rule = snapshot.providers.getRule(USER_ZAPI_PROVIDER_ID);
    // access 是 api-key / zhipu-account 联合类型，只有 api-key 形态才有 apiKey；
    // snapshot 字段可能为 null（显式清空），统一归一成 undefined 走下方缺失判定。
    const access = rule?.config.access;
    sourceApiKey = access?.type === "api-key" ? (access.apiKey ?? undefined) : undefined;
    sourceBaseURL = rule?.config.api?.baseUrl ?? undefined;
    sourceApiType = rule?.config.api?.type ?? undefined;
    sourceModelIds = rule?.config.personalModelIds ?? undefined;
  } finally {
    sourceRepository.dispose();
  }
  if (
    !sourceApiKey ||
    sourceApiType !== "anthropic-messages" ||
    !sourceBaseURL ||
    !sourceModelIds?.includes(LIVE_MODEL_ID)
  ) {
    throw new Error(
      `${CASE_MARKER}: 本机 ZAPI provider（${USER_ZAPI_PROVIDER_ID}, anthropic-messages, ${LIVE_MODEL_ID}）配置不可用——live 材料缺失，需在本机 Personal 配置中导入 ZAPI provider`,
    );
  }
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({
        providerId: LIVE_PROVIDER_ID,
        providerName: LIVE_PROVIDER_NAME,
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: sourceApiKey }),
          api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: sourceBaseURL }),
          // 模型规则全部继承 Built-in 的 glm-5.3 规则，不写 Personal 覆盖。
          personalModelIds: [LIVE_MODEL_ID],
        }),
      }),
      models: current.models,
    }));
  } finally {
    repository.dispose();
  }
  return { baseURL: sourceBaseURL, keyLength: sourceApiKey.length };
}

async function severDesktopSshSessions(container: string): Promise<string> {
  const script = [
    "target_uid=$(id -u dev); killed=''",
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = 1 ] && continue',
    "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue; case \"$c\" in *sshd*) ;; *) continue;; esac",
    'uid=$(awk \'/^Uid:/ {print $2}\' "$d/status"); [ "$uid" = "$target_uid" ] || continue',
    'parent=$(awk \'{print $4}\' "$d/stat"); kill -9 "$p" 2>/dev/null && killed="$killed $p"',
    '[ "$parent" != 1 ] && kill -9 "$parent" 2>/dev/null && killed="$killed $parent"; done',
    "echo $killed",
  ].join("; ");
  const result = await run("docker", ["exec", container, "sh", "-c", script]);
  return result.stdout.trim();
}

/** 远端 CLI 日志中本 session 的真实模型请求记录（endpoint/model/usage），不含鉴权值。 */
interface RemoteModelRequestRecord {
  at?: string;
  event?: string;
  status?: string;
  raw?: string;
  [key: string]: unknown;
}

async function readRemoteModelRequests(
  config: SSHConnectionConfig,
  sinceIso: string,
): Promise<RemoteModelRequestRecord[]> {
  const result = await runSSHCommand(
    config,
    `F=$(ls -t "$HOME/.zcode/cli/log/"*.jsonl | head -n1); awk -v since="${sinceIso}" -F'"timestamp":"' 'substr($2,1,24) >= since' "$F" | grep -E '"event":"model\\.(request|network)\\.(completed|failed)"|"event":"model\\.response\\.diagnostics"'`,
  );
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = JSON.parse(line) as {
          timestamp: string;
          event: string;
          status?: string;
          context?: Record<string, unknown>;
        };
        const context = entry.context ?? {};
        const picked: Record<string, unknown> = {};
        for (const key of [
          "modelId",
          "providerId",
          "providerKind",
          "baseURL",
          "statusCode",
          "usage",
          "inputTokens",
          "outputTokens",
          "attempt",
          "finishReason",
          "error",
          "errorCode",
          "querySource",
        ]) {
          if (key in context) picked[key] = context[key];
        }
        return {
          at: entry.timestamp,
          event: entry.event,
          status: entry.status,
          durationMs: (entry as { durationMs?: number }).durationMs,
          ...picked,
        };
      } catch {
        return { raw: line.slice(0, 200) };
      }
    });
}

describe(`${CASE_MARKER}: API Key 代表（ZAPI / GLM-5.3）经 Provisioning 到达 SSH 目标并真实请求`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "live-zapi.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-LIVE-01/03 本机导入 → 真实 SSH 同步 → 远端首发/续发 → 断线恢复后新请求仍命中 GLM-5.3", async function () {
    this.timeout(30 * 60_000);
    const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspaceA = config.workspacePaths[0];
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    const seeded = await seedLiveZapiProvider();
    facts.provider = {
      id: LIVE_PROVIDER_ID,
      model: LIVE_MODEL_ID,
      baseURL: seeded.baseURL,
      keyLength: seeded.keyLength,
      apiType: "anthropic-messages",
    };
    await refreshSeededOpenAIProvidersThroughSettings([LIVE_PROVIDER_NAME]);

    const startedAt = new Date().toISOString();
    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: workspaceA,
    });
    // 同步后的远端 Personal 配置必须含该 provider 与 baseURL；secret 不落入本记录。
    const remoteConfig = await runSSHCommand(config, 'cat "$HOME/.zcode/v2/provider_config.json"');
    expect(remoteConfig.stdout).toContain(LIVE_PROVIDER_NAME);
    expect(remoteConfig.stdout).toContain(seeded.baseURL);
    facts.remoteConfigHasProvider = true;

    await selectUpstreamProviderModelById(LIVE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: LIVE_PROVIDER_ID,
      providerName: LIVE_PROVIDER_NAME,
    });
    await selectUpstreamThoughtLevelValue("low");
    // 项目创建已打开所属 Source 的草稿；全局新建会改为本地未分类任务。
    const replayBefore = await getUpstreamRequestRecordCount();
    const firstPrompt = `${CASE_MARKER}_FIRST 请只回复四个大写字母 LIVE 和一个数字 1，即 LIVE1，不要其它内容`;
    await sendV4PromptAndWaitAccepted(
      firstPrompt,
      `${CASE_MARKER}_FIRST`,
      `${CASE_MARKER}: 首发未被接受`,
    );
    const running = await waitForV4ConversationState(
      (s) => Boolean(s.taskId && s.taskId !== "draft"),
      `${CASE_MARKER}: 首发没有产生 task`,
      60_000,
    );
    const taskId = running.taskId!;
    await waitForV4ConversationState(
      (s) => s.taskId === taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 真实首发没有收口`,
      180_000,
    );
    const firstText = await waitForLiveReply("LIVE1");
    expect(firstText).toMatch(/LIVE\s*1/u);
    // 真实请求不经回放：回放请求计数不变。
    expect(await getUpstreamRequestRecordCount()).toBe(replayBefore);
    facts.firstTurn = {
      taskId,
      replyContainsMarker: /LIVE\s*1/u.test(firstText),
      replayRecordsUnchanged: true,
    };

    // 续发：同 session 第二次真实请求。
    await selectV4TaskById(taskId, 30_000);
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_FOLLOW 请只回复 LIVE2`,
      `${CASE_MARKER}_FOLLOW`,
      `${CASE_MARKER}: 续发未被接受`,
    );
    await waitForV4ConversationState(
      (s) => s.taskId === taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 真实续发没有收口`,
      180_000,
    );
    expect(await waitForLiveReply("LIVE2")).toMatch(/LIVE\s*2/u);

    // LIVE-03：切断 Desktop 传输 → 自动恢复 → 新请求仍命中同一 provider/model。
    facts.severed = await severDesktopSshSessions(container);
    await browser.waitUntil(
      async () => {
        const snapshot = await readRemoteTabSnapshot(tab.workspaceIdentity!).catch(() => null);
        return Boolean(
          snapshot?.remoteSessionId && snapshot.remoteSessionId !== tab.remoteSessionId,
        );
      },
      { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 断连后没有自动换代恢复` },
    );
    await selectV4TaskById(taskId, 30_000);
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_AFTER_RECONNECT 请只回复 LIVE3`,
      `${CASE_MARKER}_AFTER_RECONNECT`,
      `${CASE_MARKER}: 恢复后发送未被接受`,
    );
    await waitForV4ConversationState(
      (s) => s.taskId === taskId && s.state === "idle" && s.queueCount === 0,
      `${CASE_MARKER}: 恢复后真实请求没有收口`,
      180_000,
    );
    expect(await waitForLiveReply("LIVE3")).toMatch(/LIVE\s*3/u);
    expect(await readHostProcesses()).toEqual(initialHosts);

    const requests = await readRemoteModelRequests(config, startedAt);
    facts.remoteModelRequests = requests;
    facts.liveNetworkRequestCount = requests.filter(
      (entry) => entry.event === "model.network.completed",
    ).length;
    const completed = requests.filter((entry) => entry.event === "model.request.completed");
    expect(completed.length).toBeGreaterThanOrEqual(3);
    for (const entry of completed) {
      expect(entry.providerId).toBe(LIVE_PROVIDER_ID);
      expect(entry.modelId).toBe(LIVE_MODEL_ID);
      // 外层 span 不带 baseURL；带 baseURL 的网络记录必须命中真实端点而非回放。
      if (entry.baseURL !== undefined) expect(String(entry.baseURL)).toBe(seeded.baseURL);
    }
  });
});
