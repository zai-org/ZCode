import { seedSidebarRichContentFixture } from "./test/e2e/helpers/sidebar-rich-content-fixture.js";
import { createConversationShareMockRoute } from "./test/e2e/helpers/conversation-share-mock-route.js";
import { prepareTtftOtlpFixture } from "./test/e2e/helpers/ttft-otlp-fixture.js";
import {
  loadToolSearchResponses,
  toolSearchResponseStage,
  type ToolSearchRequest,
} from "./test/e2e/helpers/toolsearch-provider.js";
import {
  requestSecurityCaptureMocks,
  recordRequestSecurityCaptureMode,
  requestSecurityWorkerEnv,
  restoreRequestSecurityEndpointEnv,
  requestSecurityClientConfig,
  requestSecurityAgentConfig,
  requestSecuritySpecTimeout,
  startRequestSecurityFixture,
  stopRequestSecurityFixture,
} from "./test/e2e/helpers/request-security-edition/index.js";
import {
  presentationResponse,
  type EntitlementPresentation,
} from "./test/e2e/fixtures/entitlement-presentation.js";
/* eslint-disable max-lines -- WDIO 配置需要集中维护 Electron、Xvfb、代理和容器 demo 参数，拆开会让测试入口更难追踪。 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tmpdir, userInfo } from "node:os";
import {
  resolveE2EChromedriverExecutable,
  startE2EChromedriverServer,
} from "./scripts/e2e-chromedriver-server.mjs";
import {
  captureWorkspaceSources,
  withE2ESourceEvidence,
} from "./test/e2e/reporting/e2e-source-evidence.js";
import { config as loadDotenv } from "dotenv";
import {
  PROVIDER_RESPONSIVE_TEAM_NAME,
  buildProviderResponsiveStartBalance,
} from "./test/e2e/fixtures/provider-family-responsive.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./test/e2e/helpers/upstream-replay-server.js";
import {
  hasUpstreamCaseLocalReplayFixtureForWorker,
  resolveUpstreamE2EHttpMode,
  resolveUpstreamE2EHttpModeForWorker,
  resolvePluginReplayFixturePaths,
  resolveUpstreamReplayFixturePaths as resolveUpstreamReplayFixturePathsFromContract,
  type UpstreamReplayFixtureMode,
} from "./test/e2e/helpers/upstream-replay-fixture-resolution.js";
import {
  buildE2ERunIdArg,
  buildWindowsTaskkillArgs,
  createWindowsE2EHomeMarkerArg,
  listE2EProcessTreePids,
  waitE2EDelay,
} from "./test/e2e/helpers/e2e-process-cleanup.js";
import {
  collectE2EWebDriverPageHandleCandidates,
  type E2EBrowserTargetInfo,
} from "./test/e2e/helpers/e2e-window-target.js";
import { runE2EBeforeSessionSetup } from "./test/e2e/helpers/e2e-before-session.js";
import {
  PROJECT_UPGRADE_ORDER_SPEC,
  seedProjectUpgradeOrderFixture,
} from "./test/e2e/helpers/project-upgrade-order-fixture.js";
import {
  isNativeKeychainCredentialSpec,
  resolveAskUserQuestionClockScaleForWorker,
  resolveE2ECredentialSecret,
} from "./test/e2e/helpers/e2e-worker-environment.js";
import {
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  applyCodingPlanTeamMockEnv,
  applyCodingPlanUpgradeMockEnv,
  clearCodingPlanTeamMockEnv,
  clearCodingPlanUpgradeMockEnv,
  shouldPrepareCodingPlanTeamMock,
  shouldReuseDesktopE2EBuild,
  isOffPeakTeamPlanSpec,
} from "./test/e2e/helpers/coding-plan-mock-env.js";
import {
  CN_UNLINKED_E2E_ZCODE_JWT,
  buildCnUnlinkedProfileResponse,
} from "./test/e2e/helpers/start-plan-cn-unlinked-fixture.js";
import {
  createCodingPlanDataPlaneResponse,
  type DataPlaneTurnFixture,
} from "./test/e2e/helpers/coding-plan-data-plane-response.js";
import {
  HIGHSPEED_MOCK_SCENARIO_ENV,
  resolveHighspeedE2EMockScenario,
} from "./test/e2e/helpers/highspeed-mock-env.js";
import { createE2ERendererBridgeRootHooks } from "./test/e2e/helpers/e2e-renderer-bridge-root-hook.js";
import { resetDraftRegenerationResend } from "#e2e/helpers/draft-regeneration-resend";
import { installHookTrustFixture } from "./test/e2e/helpers/hook-trust-fixture.js";
import { resolveUpstreamModels } from "./test/e2e/helpers/upstream-recorded-models.js";
import { runMeasuredE2ELifecyclePhase } from "./test/e2e/helpers/e2e-lifecycle-measurement.js";
import { createE2ERunnerFinalizationGuard } from "./test/e2e/helpers/e2e-runner-finalization-guard.js";
import { installHooksLifecycleFixture } from "./test/e2e/helpers/hooks-lifecycle-fixture.js";
import { installStopToolResultsFixture } from "./test/e2e/helpers/stop-tool-results-fixture.js";
import { installBashPrefixPermissionPnpmShim } from "./test/e2e/helpers/bash-prefix-permission-shim.js";
import {
  applyE2EWorkerModelRetryEnv,
  applyE2EWorkerReplayProxyEnv,
  replaceChromeUserDataDirArg,
  resolveE2EWorkerModelStreamIdleTimeoutMs,
  resolveE2EWebDriverRequestLimits,
  resolveE2EWorkerChromiumProfileDir,
  workerSpecsContain,
} from "./test/e2e/helpers/e2e-worker-isolation.js";
import { createE2EStartupCredentialSeed } from "./test/e2e/helpers/e2e-startup-credentials.js";
import { seedRemoteOnboardingFixture } from "./test/e2e/helpers/remote-startup-profile.js";
import {
  installOfficialPluginCacheTemplate,
  prepareOfficialPluginCacheTemplate,
} from "./test/e2e/helpers/official-plugin-cache-prewarm.js";
import { getE2EProviderEndpointEnv } from "#e2e/helpers/e2e-provider-endpoint";
import { prepareOAuthCompletionRaceFixture } from "./test/e2e/helpers/oauth-completion-race-fixture.js";
import { prepareWebRemoteControlAuthGateFixture } from "./test/e2e/helpers/web-remote-control-auth-gate-fixture.js";
import { prepareAccessToken401Fixture } from "./test/e2e/helpers/access-token-401-fixture.js";
import { prepareVoiceInputFixture } from "./test/e2e/helpers/asr-mock-server.js";
import { prepareOfficialMcpAuthRoutingFixture } from "#e2e/helpers/mcp-official-auth-routing-fixture";
import { prepareMcpFailureGuidanceFixture } from "#e2e/helpers/mcp-failure-guidance-fixture";
import { createE2EReplayFixtureVariables } from "./test/e2e/helpers/e2e-runtime-paths.js";
import { stageE2EAppOutput } from "./test/e2e/helpers/e2e-app-output-stage.js";
import { withE2EDesktopBuildLock } from "./scripts/ensure-e2e-desktop-build.mjs";
import {
  ensureSshRemoteReleaseAssets,
  resolveSshRemoteReleaseScope,
} from "./test/e2e/helpers/e2e-ssh-remote-release-assets.js";
import {
  ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV,
  BUILTIN_MODEL_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import {
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
  type PersonalProviderConfigSeed,
} from "./test/e2e/helpers/model-provider-restart-config.js";
import {
  DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
  startE2ENetworkCaptureProxy,
  type E2ENetworkCaptureProxy,
} from "./test/e2e/helpers/network-capture-proxy.js";
import {
  resetCodingPlanUpgradeMockServer,
  resolveCodingPlanUpgradeMockScenario,
  shouldPrepareCodingPlanUpgradeMockForBuild,
  startCodingPlanUpgradeMockServer,
  type CodingPlanUpgradeMockServer,
} from "./test/e2e/helpers/coding-plan-upgrade-mock-server.js";
import {
  MANUAL_REVIEW_SPEC_GLOB,
  hasRequiredSshE2EEnvironment,
  isExplicitE2ESpecSelection,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "./scripts/e2e-formal-spec-selection.mjs";
import {
  applyDynamicWorkflowConfigMockEnv,
  clearDynamicWorkflowConfigMockEnv,
  resolveDynamicWorkflowConfigMockScenario,
  startDynamicWorkflowConfigMockServer,
  type DynamicWorkflowConfigMockServer,
} from "./test/e2e/helpers/dynamic-workflow-config-mock-server.js";
import {
  resolveModelContextBudgetConfigMockScenario,
  startModelContextBudgetConfigMockServer,
  type ModelContextBudgetConfigMockServer,
} from "./test/e2e/helpers/model-context-budget-config-mock-server.js";
import {
  MODEL_PROVIDER_CATALOG_PAYLOAD,
  resolveSubagentLoginCatalogConfigVersion,
  resolveSubagentLoginCatalogPayload,
} from "./test/e2e/helpers/model-provider-catalog-mock-server.js";
import {
  applyClientScenesMockEnv,
  clearClientScenesMockEnv,
  shouldUseClientScenesMock,
  startClientScenesMockServer,
  type ClientScenesMockServer,
} from "./test/e2e/helpers/client-scenes-mock-server.js";
import {
  resolvePluginCdnZipMarketplaceLastUpdated,
  seedPluginCdnZipMarketplaceFixture,
  shouldUsePluginCdnZipMarketplaceFixture,
  startPluginCdnZipFixtureServer,
  stopPluginCdnZipFixtureServer,
  type PluginCdnZipFixtureServer,
} from "./test/e2e/helpers/plugin-cdn-zip-marketplace.js";
import { E2EFailureArtifactCollector } from "./test/e2e/reporting/e2e-failure-artifacts.js";
import { classifyError, createE2EReporter } from "./test/e2e/reporting/e2e-reporting.js";
import type { E2ELifecyclePhase } from "./test/e2e/reporting/e2e-reporting-types.js";
import {
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS,
  resolveE2EElectronBinary,
} from "./test/e2e/helpers/e2e-electron-binary.js";
import {
  CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
  CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
  CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
  seedProviderReadinessHistoryFixture,
} from "./test/e2e/helpers/provider-readiness-history-fixture.js";
import {
  PASSIVE_AGENT_STARTUP_SCENARIO,
  SMALL_AGENT_WARMUP_SCENARIO,
  seedPassiveAgentStartupWorkspaces,
} from "./test/e2e/helpers/passive-agent-startup-fixture.js";
import { seedSessionHistoryFirstFixture } from "./test/e2e/helpers/session-history-first-fixture.js";
import { seedTaskIndexRowAuthorityFixture } from "./test/e2e/helpers/task-list-row-authority-fixture.js";
import { seedDeleteAllArchivedTasksFixture } from "./test/e2e/helpers/delete-all-archived-tasks-fixture.js";
import { seedTaskTitleMarqueeFixture } from "./test/e2e/helpers/task-title-marquee-fixture.js";
import { seedAppUsageE2EFixture } from "./test/e2e/helpers/usage-stats-app-usage-fixture.js";

const DESKTOP_DIR = import.meta.dirname;
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
const E2E_ELECTRON_SERVICE_MODULE_PATH = resolve(
  DESKTOP_DIR,
  "test/e2e/helpers/e2e-electron-service.ts",
);
const E2E_LOCAL_ENV_FILES = [
  resolve(DESKTOP_DIR, ".env.e2e.local"),
  resolve(REPO_ROOT, ".env.e2e.local"),
  // 仓库不再提供共享 key：.env.e2e.local.example 只列变量名、值留空，不作为 fallback 读取。
];
// Bug 根因：Electron 二进制预检曾早于本地 E2E env 加载，缺包修复因此绕过镜像、
// 代理、证书和缓存配置。所有读取 process.env 的 runner 初始化都必须位于该调用之后。
loadE2ELocalEnv();
const BUILD_DESKTOP_AGENT_SCRIPT = resolve(REPO_ROOT, "scripts/build-desktop-agent-cli.mjs");
const ZCODE_CLI_ENTRYPOINT = resolve(REPO_ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const E2E_HOME_DIR = resolve(
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
    // 修复原因：多个 WDIO 本地并发时会互相清理默认 .e2e-home，导致窗口白屏、
    // DevTools 断链或登录页等待失败；默认路径保持兼容，调试时允许显式隔离。
    resolve(DESKTOP_DIR, ".e2e-home"),
);
const E2E_PACKAGED_APP_BINARY_PATH = process.env.ZCODE_E2E_PACKAGED_APP_PATH?.trim()
  ? resolve(process.env.ZCODE_E2E_PACKAGED_APP_PATH)
  : null;
// 目录隔离已回滚：所有 Desktop E2E 继续使用历史 ~/.zcode 布局。
const E2E_STORAGE_ROOT = resolve(E2E_HOME_DIR, ".zcode");
const E2E_APP_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "v2");
const E2E_APP_SETTINGS_FILE = resolve(E2E_APP_CONFIG_DIR, "setting.json");
const E2E_APP_CREDENTIALS_FILE = resolve(E2E_APP_CONFIG_DIR, "credentials.json");
const E2E_APP_PROVIDER_CONFIG_FILE = resolve(E2E_APP_CONFIG_DIR, "provider_config.json");
// staged Electron app 只有 main/host/renderer 产物，不携带仓库级 config/provider。
// 若让 Host 依据 app.getAppPath() 推导 bundled config，重启后会把不存在的路径当作
// bundled release，模型配置初始化直接失败。E2E 明确注入同一份只读基线；off-peak
// spec 会在 startOffPeakE2EMock 中覆盖为带 mock endpoint 的 case-local 文件。
const E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  "config/provider/zcode-builtin.json",
);
const INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE =
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
const E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  ".cache/desktop-e2e-provider-config/official-offpeak-mock.json",
);
const E2E_AGENTS_STATE_FILE = resolve(E2E_APP_CONFIG_DIR, "agents-state.json");
const E2E_CLI_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "cli");
const E2E_CLI_CONFIG_FILE = resolve(E2E_CLI_CONFIG_DIR, "config.json");
const E2E_CLI_AGENTS_DIR = resolve(E2E_CLI_CONFIG_DIR, "agents");
const E2E_USER_AGENTS_DIR = resolve(E2E_STORAGE_ROOT, "agents");
const E2E_NETWORK_CAPTURE_DIR = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    // 修复原因：beforeSession 会清空 .e2e-home；抓包代理的 CA 必须放在
    // reset 范围之外，否则 agent 读 httpProxyCaCertPath 时会遇到 ENOENT。
    resolve(DESKTOP_DIR, ".e2e-network-capture"),
);
const E2E_CERT_CACHE_ROOT =
  process.env.ZCODE_E2E_CERT_CACHE_DIR?.trim() || resolve(REPO_ROOT, ".cache");
const E2E_NETWORK_CAPTURE_CA_DIR = resolve(E2E_CERT_CACHE_ROOT, "desktop-e2e-network-capture-ca");
const E2E_CODING_PLAN_DATA_PLANE_CA_DIR = resolve(
  E2E_CERT_CACHE_ROOT,
  "desktop-e2e-coding-plan-data-plane-ca",
);
const E2E_BROWSER_DRIVER_CACHE_DIR = resolve(REPO_ROOT, ".cache/wdio-browser-drivers");
const DESKTOP_BUILD_OUTPUT_DIR = resolve(DESKTOP_DIR, "out");
const DESKTOP_BUILD_ENTRY_POINT = resolve(DESKTOP_BUILD_OUTPUT_DIR, "main/index.js");
const E2E_RENDERER_ASSETS_DIR = resolve(DESKTOP_DIR, "out/renderer/assets");
const UPSTREAM_CAPTURE_ARTIFACT_PATH = resolve(E2E_NETWORK_CAPTURE_DIR, "upstream-provider.json");
const CODING_PLAN_DATA_PLANE_ARTIFACT_PATH = resolve(
  E2E_NETWORK_CAPTURE_DIR,
  "coding-plan-data-plane.json",
);
const E2E_PROVIDER_RUNTIME_FILE = resolve(E2E_NETWORK_CAPTURE_DIR, "upstream-runtime.json");
const UPSTREAM_REPLAY_FIXTURE_ROOT = resolve(DESKTOP_DIR, "test/e2e/fixtures/upstream");
const UPSTREAM_COMMON_REPLAY_FIXTURE_PATH = resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "common.json");
const UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR = resolve(
  UPSTREAM_REPLAY_FIXTURE_ROOT,
  "conversation-session",
);
const UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR = resolve(
  DESKTOP_DIR,
  "test/e2e/fixtures/cases/conversation-session",
);
const LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS = [
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-conversation-tool-cross-product.json"),
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-basic.json"),
];
const UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES = 8 * 1024 * 1024;
const UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES = 16 * 1024 * 1024;
const E2E_ELECTRON_INSTALL_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS") ??
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS;
const ELECTRON_APP_BINARY_PATH =
  E2E_PACKAGED_APP_BINARY_PATH ??
  resolveE2EElectronBinary({
    desktopDir: DESKTOP_DIR,
    environment: process.env,
    installTimeoutMs: E2E_ELECTRON_INSTALL_TIMEOUT_MS,
    repoRoot: REPO_ROOT,
  });
const UPSTREAM_PROVIDER_SPEC = "./test/e2e/infrastructure/smoke/upstream-provider.test.ts";
const PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC = "plugin-no-git-github-archive.test.ts";
const GIT_COMMIT_DIALOG_UI_FLOW_SPEC = "git-commit-dialog-ui-flow.test.ts";
const OAUTH_CREDENTIAL_RECOVERY_SPEC = "oauth-credential-recovery.test.ts";
const JWT_EXPIRY_REAUTHENTICATION_SPEC = "jwt-expiry-reauthentication.test.ts";
const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC =
  "subagent-coding-plan-login-catalog-stale.test.ts";
const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE = "subagent-login-catalog-stale";
const SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID = "e2e-subagent-bigmodel-flow";
const SUBAGENT_CODING_PLAN_OAUTH_STATE = "e2e-subagent-bigmodel-state";
const PROVIDER_READINESS_AGENT_STARTUP_SPEC = "provider-readiness-agent-startup.test.ts";
const CONTEXT_WINDOW_COLD_RESUME_SPEC = "conversation-session-context-window-cold-resume.test.ts";
const PASSIVE_AGENT_STARTUP_SPEC = "workspace-passive-agent-startup.test.ts";
const AGENT_WARMUP_LIFECYCLE_SPEC = "workspace-agent-warmup-lifecycle.test.ts";
const AGENT_WARMUP_SMALL_SET_SPEC = "workspace-agent-warmup-small-set.test.ts";
const PROVIDER_SAVE_DORMANT_AGENT_SPEC = "workspace-provider-save-dormant-agent.test.ts";
const MODEL_PROVIDER_REGRESSION_GAPS_SPEC =
  "conversation-session-model-provider-regression-gaps.test.ts";
// 只借用这套 fixture 的「多 workspace 已恢复」启动态来做 workspace 切换，不断言 agent 预热行为。
const BROWSER_CROSS_WORKSPACE_CLOSE_SPEC = "browser-tab-close-cross-workspace.test.ts";
const BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC =
  "browser-tab-attachment-restore-cross-workspace.test.ts";
const WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC = "workspace-removal-runtime-release.test.ts";
const AGENT_WARMUP_FIXTURE_SPECS = [
  PASSIVE_AGENT_STARTUP_SPEC,
  AGENT_WARMUP_LIFECYCLE_SPEC,
  AGENT_WARMUP_SMALL_SET_SPEC,
  PROVIDER_SAVE_DORMANT_AGENT_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
/** 只需要两个 workspace 的 spec，用小号 scenario 少 seed 7 个目录。 */
const SMALL_AGENT_WARMUP_SPECS = [
  AGENT_WARMUP_SMALL_SET_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  BROWSER_CROSS_WORKSPACE_ATTACHMENT_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
const TASK_INDEX_ROW_AUTHORITY_SPEC = "conversation-session-task-index-row-authority.test.ts";
const TASK_TITLE_MARQUEE_SPEC = "conversation-session-task-title-marquee.test.ts";
const GIT_REVIEW_ENTRY_SPEC = "conversation-session-git-review-entry.test.ts";
const WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC = "windows-agent-metric-probe-absence.test.ts";
const HOOKS_LIFECYCLE_SPEC = "conversation-session-hooks-lifecycle.test.ts";
const HOOK_TRUST_SPEC = "conversation-session-hook-trust.test.ts";
const E2E_PROVIDER_ID = "e2e-upstream";
const E2E_PROVIDER_ALTERNATE_PROVIDER_ID = "e2e-upstream-alt";
const E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = "Upstream E2E Alt";
// 模型名由 E2E_PROVIDER_MODEL / E2E_PROVIDER_SECONDARY_MODEL 控制，未设置时使用回放夹具的录制模型。
const { model: E2E_PROVIDER_MODEL, secondaryModel: E2E_PROVIDER_SECONDARY_MODEL } =
  resolveUpstreamModels();
const SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC =
  "conversation-session-subagent-provider-registry-cold-start.test.ts";
const BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC =
  "conversation-session-built-in-subagent-model-overrides.test.ts";
const SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC =
  "settings-subagent-create-edit-persistence.test.ts";
const SUBAGENT_REASONING_AGENT_NAME = "e2e-reasoning-reviewer";
const SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC =
  "conversation-session-subagent-runtime-catalog-reasoning.test.ts";
const SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID = "e2e-claude-runtime-catalog";
const SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME = "Claude Runtime Catalog E2E";
const SUBAGENT_RUNTIME_CATALOG_MODEL = "claude-opus-4-8";
const SUBAGENT_RUNTIME_CATALOG_AGENT_NAME = "e2e-claude-catalog-reviewer";
const OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC =
  "conversation-session-offpeak-subagent-model-inheritance.test.ts";
const OFFPEAK_INVALID_TICKET_SPEC = "conversation-session-off-peak-invalid-ticket.test.ts";
const MODEL_PROVIDER_PLAN_SURFACE_SPEC = "conversation-session-model-provider-plan-surface.test.ts";
const SUBAGENT_TEAM_SCOPE_SPEC = "conversation-session-subagent-team-scope.test.ts";
const TOOL_ERROR_SURFACE_SPEC = "conversation-session-tool-error-surface.test.ts";
const MODEL_OUTPUT_TOKEN_BUDGET_SPEC = "conversation-session-model-output-token-budget.test.ts";
const MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC = "conversation-session-model-output-token-preflight";
const OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC =
  "conversation-session-output-limit-continue-markdown-protocols.test.ts";
const SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME = "e2e-provider-registry-reviewer";
const TOOL_ERROR_SURFACE_STALE_AGENT_NAME = "e2e-stale-error-reviewer";
const TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME = "e2e-healthy-error-reviewer";
// 上游供应商地址由 E2E_PROVIDER_BASE_URL 提供，仓库不写死任何供应商；只有 capture 模式访问真实上游时需要。
// 回放模式使用本地回放服务器，实际生效的地址经 E2E_PROVIDER_RUNTIME_BASE_URL 传给各测试进程。
const E2E_PROVIDER_UPSTREAM_BASE_URL = process.env.E2E_PROVIDER_BASE_URL?.trim() ?? "";
const E2E_PROVIDER_REPLAY_API_KEY = "e2e-fixture-key";
const CODING_PLAN_MODEL_SSE_BODY =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"coding-plan-e2e","type":"message","role":"assistant","content":[],"model":"glm-e2e","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":128,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"coding-plan-e2e-ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const codingPlanDefaultDataPlaneResponse = createCodingPlanDataPlaneResponse(null, {
  fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
  title: { id: "coding-plan-e2e-title", text: '{"title":"Coding Plan E2E"}' },
});
const E2E_AUTH_PROVIDER_ID = "zai";
const E2E_AUTH_TOKEN = "e2e-oauth-token";
const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};
const GLM_HIGHSPEED_E2E_PROVIDER_ID = "e2e-glmhighspeed";
const GLM_HIGHSPEED_E2E_MODEL = "glm-5.1-highspeed";
const GLM_HIGHSPEED_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const BIGMODEL_GLM53_E2E_PROVIDER_ID = "e2e-bigmodel-glm53";
const BIGMODEL_GLM53_E2E_MODEL = "GLM-5.3";
const BIGMODEL_GLM53_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const STAGING_MODEL_E2E_PROVIDER_ID = "e2e-staging-model";
const STAGING_MODEL_E2E_MODEL = "glm-5.2";
const STAGING_MODEL_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const E2E_PROVIDER_PRESETS = {
  env: {
    apiKeyEnvNames: ["E2E_PROVIDER_API_KEY"],
    baseUrl: E2E_PROVIDER_UPSTREAM_BASE_URL,
    expectedHost: readUpstreamBaseUrlPart("host"),
    expectedProtocol: readUpstreamBaseUrlPart("protocol"),
    model: E2E_PROVIDER_MODEL,
    providerId: E2E_PROVIDER_ID,
    providerName: "Upstream E2E",
    thoughtLevel: "high",
  },
  glmhighspeed: {
    apiKeyEnvNames: [
      "GLM_HIGHSPEED_E2E_API_KEY",
      "BIGMODEL_API_KEY",
      "ZHIPUAI_API_KEY",
      "E2E_PROVIDER_API_KEY",
    ],
    baseUrl: GLM_HIGHSPEED_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: GLM_HIGHSPEED_E2E_MODEL,
    providerId: GLM_HIGHSPEED_E2E_PROVIDER_ID,
    providerName: "GLM Highspeed E2E",
    thoughtLevel: "",
  },
  bigmodel53: {
    apiKeyEnvNames: ["BIGMODEL_GLM53_E2E_API_KEY"],
    baseUrl: BIGMODEL_GLM53_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: BIGMODEL_GLM53_E2E_MODEL,
    providerId: BIGMODEL_GLM53_E2E_PROVIDER_ID,
    providerName: "BigModel GLM-5.3 E2E",
    thoughtLevel: "",
  },
  stagingmodel: {
    apiKeyEnvNames: ["STAGING_MODEL_E2E_API_KEY"],
    baseUrl: STAGING_MODEL_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: STAGING_MODEL_E2E_MODEL,
    providerId: STAGING_MODEL_E2E_PROVIDER_ID,
    providerName: "stagingModel",
    thoughtLevel: "",
  },
} as const;
type E2EProviderPresetName = keyof typeof E2E_PROVIDER_PRESETS;
const upstreamE2EContextWindowOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_CONTEXT_WINDOW",
);
const upstreamE2EMaxOutputTokensOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_MAX_OUTPUT_TOKENS",
);
const DESKTOP_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(DESKTOP_DIR, "package.json"), "utf-8"),
) as { devDependencies?: Record<string, string> };
const ELECTRON_VERSION = DESKTOP_PACKAGE_JSON.devDependencies?.electron ?? "";
let e2eChromedriverServer: Awaited<ReturnType<typeof startE2EChromedriverServer>> | undefined;
const PNPM_COMMAND = "pnpm";
const E2E_ELECTRON_APP_QUIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_APP_QUIT_TIMEOUT_MS") ?? 1000;
const E2E_ELECTRON_FORCE_KILL_GRACE_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_FORCE_KILL_GRACE_MS") ?? 3000;
const E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS") ?? 15000;
const E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS") ?? 5000;
const E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS") ?? 30000;
const E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS = Math.min(
  readPositiveIntegerEnv("ZCODE_E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS") ?? 60_000,
  5 * 60_000,
);
const E2E_WEBDRIVER_REQUEST_LIMITS = resolveE2EWebDriverRequestLimits({
  retryCount: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_RETRY_COUNT,
  timeoutMs: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS,
});
const E2E_HOME_REMOVE_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000, 5000, 8000];
const HOST_HOME_DIR = process.env.HOME?.trim();
const HOST_USERPROFILE_DIR = process.env.USERPROFILE?.trim();

interface E2ERendererBridgePreflightResult {
  bridgeMethods: Record<string, boolean>;
  candidateHandles: string[];
  currentHandle: string | null;
  documentReadyState: string | null;
  handle: string | null;
  handles: string[];
  hasSessionBridge: boolean;
  missingBridgeMethods: string[];
  missingStateMethods: string[];
  ok: boolean;
  reason: string;
  stateMethods: Record<string, boolean>;
  targets: E2EBrowserTargetInfo[];
  url: string | null;
}

const E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS = ["getState", "setState", "subscribe"];
// 修复原因：V4 store 已移除旧 renderer-local queue/message/stop 注入方法；全局 preflight
// 若继续要求这些方法，会在正式 V4 case 执行前把健康 renderer 误判成基础设施失败。
const E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS = [
  "getWorkspaceState",
  "setSlashCommands",
  "setTaskRuntimeState",
  "upsertOptimisticTaskListItem",
];

const requestedE2ESpecs = readRequestedE2ESpecs();
const requestedE2EExcludeSpecs = readRequestedE2EExcludeSpecs();
const configuredModelRetryMaxRetries = process.env.ZCODE_MODEL_RETRY_MAX_RETRIES;
const configuredE2EWorkerNetworkEnv = {
  httpProxy: process.env.ZCODE_HTTP_PROXY,
  noProxy: process.env.ZCODE_NO_PROXY,
};
const upstreamProviderSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.includes("upstream-provider.test.ts"));
const manualReviewSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.replaceAll("\\", "/").includes("/manual-review/"));
const manualReviewE2E =
  process.env.ZCODE_E2E_MANUAL_REVIEW?.trim() === "1" || manualReviewSpecRequested;
if (manualReviewE2E) {
  process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
}
const manualReviewHoldMs = readPositiveIntegerEnv("ZCODE_E2E_MANUAL_REVIEW_HOLD_MS") ?? 0;
const REQUESTED_UPSTREAM_HTTP_MODE_ENV = "ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE";
const requestedUpstreamE2EHttpMode =
  process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV] !== undefined
    ? process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV]?.trim() || undefined
    : process.env.E2E_PROVIDER_HTTP_MODE?.trim() || undefined;
const requestedAskUserQuestionClockScale =
  process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim() || undefined;
let upstreamE2EHttpMode = readUpstreamE2EHttpMode();
const e2eProviderPresetName = readE2EProviderPresetName();
const e2eProviderPreset = E2E_PROVIDER_PRESETS[e2eProviderPresetName];
const containerE2E = process.env.ZCODE_E2E_CONTAINER === "1";
const configuredE2ESpecs =
  requestedE2ESpecs.length > 0
    ? requestedE2ESpecs
    : manualReviewE2E
      ? [MANUAL_REVIEW_SPEC_GLOB]
      : upstreamProviderSpecRequested
        ? [UPSTREAM_PROVIDER_SPEC]
        : ["./test/e2e/**/*.test.ts"];
const pluginNoGitGitHubArchiveE2E = configuredE2ESpecs.some((spec) =>
  spec.includes(PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC),
);
const workspacePluginRemoteExplicitSyncE2E = configuredE2ESpecs.some((spec) =>
  spec.includes("conversation-session-plugin-remote-explicit-sync-workspace.test.ts"),
);
const e2eReporter = createE2EReporter({
  repoRoot: REPO_ROOT,
  desktopDir: DESKTOP_DIR,
  requestedSpecs: requestedE2ESpecs,
  containerE2E,
});
const e2eRunnerFinalizationGuard = createE2ERunnerFinalizationGuard({
  onTimeout: forceFinalizeE2ERunnerFromGuard,
  timeoutMs: E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS,
});
const E2E_RUN_ID = process.env.ZCODE_E2E_RUN_ID?.trim();
if (!E2E_RUN_ID) {
  throw new Error("[e2e] ZCODE_E2E_RUN_ID missing after reporter initialization");
}
const E2E_RUN_CACHE_DIR = resolve(DESKTOP_DIR, ".e2e-cache", E2E_RUN_ID);
const E2E_APP_OUTPUT_DIR = resolve(E2E_RUN_CACHE_DIR, "app");
const E2E_OFFICIAL_PLUGIN_CACHE_TEMPLATE_HOME = resolve(
  E2E_RUN_CACHE_DIR,
  "official-plugin-cache-home",
);
const E2E_APP_ENTRY_POINT = resolve(E2E_APP_OUTPUT_DIR, "main/index.js");
const E2E_APP_RENDERER_ASSETS_DIR = resolve(E2E_APP_OUTPUT_DIR, "renderer/assets");
const E2E_REMOTE_ASSET_VERSION = String(
  (
    JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
      version?: string;
    }
  ).version ?? "",
).trim();
const E2E_REMOTE_RELEASE_SOURCE_DIR = resolve(
  DESKTOP_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
const E2E_REMOTE_RELEASE_OUTPUT_DIR = resolve(
  E2E_RUN_CACHE_DIR,
  "mock-cdn",
  "releases",
  E2E_REMOTE_ASSET_VERSION,
);
const E2E_CHROMIUM_USER_DATA_ROOT_DIR = resolve(E2E_RUN_CACHE_DIR, "chromium-profiles");
const containerChromeArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--ozone-platform=x11",
  "--window-size=1440,1000",
];

process.env.HOME = E2E_HOME_DIR;
process.env.USERPROFILE = E2E_HOME_DIR;
process.env.ZCODE_E2E_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_E2E_RUN_ID = E2E_RUN_ID;
process.env.ZCODE_DATA_BASE_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_APPLICATION_NAME = "ZCode E2E";
process.env.ZCODE_DESKTOP_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = "1";
// 修复原因：从 ZCode 客户端拉起的 shell 里带有应用自身环境（ZCODE_ENV=production、
// ZCODE_BASE_URL=https://zcode.z.ai）。它们会被 onPrepare 的 agent 构建读走并固化进产物，
// 让 E2E 打到生产域、忽略 settings 里的 endpoint，fixture mock server 收不到请求。
// 桌面包的归一在 ensure-e2e-desktop-build 内完成，这里保证 WDIO 侧构建链路一致。
process.env.ZCODE_ENV = "test";
delete process.env.ZCODE_BASE_URL;
delete process.env.ZCODE_RUNTIME_ENV;
// Bugfix: renderer E2E store bridge 只能由 WDIO 进程显式打开，避免 ZCODE_ENV=test 的产品测试环境暴露全局可变 store。
process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
// Bugfix: e2e session 由 Chromedriver 管理调试端口；禁用主进程开发态固定的 9229，
// 避免和本机已打开的 ZCode Dev 冲突后出现空白窗口并卡在 session 创建阶段。
process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT = "1";

let upstreamCaptureProxy: E2ENetworkCaptureProxy | null = null;
let upstreamReplayServer: UpstreamReplayServer | null = null;
let codingPlanTeamMockServer: Server | null = null;
let offPeakTeamGateway: { port: number; origin: string; close(): Promise<void> } | null = null;
let codingPlanTeamMockBaseUrl = "";
let codingPlanDataPlaneProxy: E2ENetworkCaptureProxy | null = null;
let codingPlanUpgradeMockServer: CodingPlanUpgradeMockServer | null = null;
let modelContextBudgetConfigMockServer: ModelContextBudgetConfigMockServer | null = null;
let dynamicWorkflowConfigMockServer: DynamicWorkflowConfigMockServer | null = null;
let clientScenesMockServer: ClientScenesMockServer | null = null;
let stopOAuthCompletionRaceFixture: (() => Promise<void>) | null = null;
let stopTtftOtlpFixture: (() => Promise<void>) | null = null;
let stopWebRemoteControlAuthGateFixture: (() => Promise<void>) | null = null;
let stopAccessToken401Fixture: (() => Promise<void>) | null = null;
let stopVoiceInputFixture: (() => Promise<void>) | null = null;
let stopOfficialMcpAuthRoutingFixture: (() => Promise<void>) | null = null;
let stopMcpFailureGuidanceFixture: (() => Promise<void>) | null = null;
let pluginCdnZipFixtureServer: PluginCdnZipFixtureServer | null = null;
let upstreamE2EBaseUrl: string = e2eProviderPreset.baseUrl;
let e2eRunnerExitWatchdog: ReturnType<typeof setTimeout> | null = null;
let currentE2EElectronAppPid: number | null = null;
let currentE2EWorkerSpecs: string[] = [];
let currentE2EBeforeSessionError: unknown = null;
let e2eFailureArtifacts: E2EFailureArtifactCollector | null = null;
let currentE2EWorkerSessionSpecs: string[] = [];
let currentE2EChromiumUserDataDir: string | null = null;
const e2eWorkerLifecycleStarts = new Map<string, { specs: string[]; startedAt: Date }>();

applyE2EProviderEnv();

async function measureE2ELifecyclePhase<T>(
  phase: E2ELifecyclePhase,
  context: { cid?: string; specs?: string[] },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runMeasuredE2ELifecyclePhase(phase, context, e2eReporter.recordLifecycleEvent, run);
}

async function runE2EDiagnosticWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function loadE2ELocalEnv() {
  for (const envFile of E2E_LOCAL_ENV_FILES) {
    if (!existsSync(envFile)) {
      continue;
    }

    const parsedEnv: Record<string, string> = {};
    const result = loadDotenv({
      path: envFile,
      processEnv: parsedEnv,
      quiet: true,
    });
    if (result.error) {
      throw new Error(`Failed to load e2e env file: ${envFile}`, {
        cause: result.error,
      });
    }
    for (const [key, value] of Object.entries(parsedEnv)) {
      if (!process.env[key]?.trim()) {
        process.env[key] = value;
      }
    }
  }
}

function readRequestedE2ESpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--spec") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--spec=".length));
    }
  }

  return [...specs];
}

function readRequestedE2EExcludeSpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_EXCLUDE_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--exclude") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--exclude=".length));
    }
  }

  return [...specs];
}

function appendRequestedE2ESpecs(specs: Set<string>, value?: string) {
  if (!value?.trim()) {
    return;
  }

  // 修复原因：`pnpm test:e2e -- --spec <file>` 下 WDIO 仍会先加载配置；
  // 如果配置只读 ZCODE_E2E_SPEC，实际会回落到全量 spec，多个 worker 轮流重置
  // .e2e-home 后就会把 上游 flash 选择冲掉。
  for (const spec of value.split(",")) {
    const trimmed = spec.trim();
    if (trimmed) {
      specs.add(trimmed);
    }
  }
}

function readConfiguredUpstreamReplayFixturePaths() {
  const configured = process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim();
  if (!configured) {
    return null;
  }

  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(REPO_ROOT, item));
}

async function resolveUpstreamReplayFixturePaths(specs: string[] = []) {
  const configured = readConfiguredUpstreamReplayFixturePaths();
  const mode = readUpstreamReplayFixtureMode();
  return resolveUpstreamReplayFixturePathsFromContract({
    caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
    caseManifestDir: UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR,
    commonFixturePath: UPSTREAM_COMMON_REPLAY_FIXTURE_PATH,
    configuredFixturePaths: configured,
    legacyFixturePaths: LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS,
    mode,
    pluginFixturePaths:
      configured || mode === "strict-case-local"
        ? []
        : await resolvePluginReplayFixturePaths({
            fixtureRoot: UPSTREAM_REPLAY_FIXTURE_ROOT,
            specs,
          }),
    specs,
  });
}

function readUpstreamReplayFixtureMode(): UpstreamReplayFixtureMode {
  const mode = process.env.E2E_PROVIDER_REPLAY_FIXTURE_MODE?.trim() || "compatible";
  if (mode === "compatible" || mode === "strict-case-local") {
    return mode;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_REPLAY_FIXTURE_MODE=${mode}. Expected compatible or strict-case-local.`,
  );
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return Math.floor(parsed);
}

function readUpstreamBaseUrlPart(part: "host" | "protocol") {
  if (!E2E_PROVIDER_UPSTREAM_BASE_URL) return "";
  const url = new URL(E2E_PROVIDER_UPSTREAM_BASE_URL);
  return part === "host" ? url.host : url.protocol.replace(/:$/u, "");
}

function readE2EProviderPresetName(): E2EProviderPresetName {
  const configured =
    process.env.E2E_PROVIDER_PRESET?.trim() || process.env.LLM_E2E_PROVIDER_PRESET?.trim();
  if (!configured) {
    // 默认使用环境变量配置的上游供应商（E2E_PROVIDER_BASE_URL / API_KEY / MODEL）；
    // 修复原因：rebase 后默认曾落到 GLM highspeed，会请求 open.bigmodel.cn 且人工验收链路不一致。
    return "env";
  }
  if (
    configured === "env" ||
    configured === "glmhighspeed" ||
    configured === "bigmodel53" ||
    configured === "stagingmodel"
  ) {
    return configured;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_PRESET=${configured}. ` +
      "Expected env, glmhighspeed, bigmodel53, or stagingmodel.",
  );
}

function resolveActiveE2EProviderEnv(specs: string[] = configuredE2ESpecs) {
  return {
    providerId: e2eProviderPreset.providerId,
    providerName: e2eProviderPreset.providerName,
    model: e2eProviderPreset.model,
    thoughtLevel: readE2EThoughtLevel(),
  };
}

function applyE2EProviderEnv(specs: string[] = configuredE2ESpecs) {
  const providerEnv = resolveActiveE2EProviderEnv(specs);
  process.env.E2E_PROVIDER_PRESET = e2eProviderPresetName;
  process.env.E2E_PROVIDER_ID = providerEnv.providerId;
  process.env.E2E_PROVIDER_NAME = providerEnv.providerName;
  process.env.E2E_PROVIDER_MODEL = providerEnv.model;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_ID = E2E_PROVIDER_ALTERNATE_PROVIDER_ID;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = E2E_PROVIDER_ALTERNATE_PROVIDER_NAME;
  process.env.E2E_PROVIDER_ALTERNATE_MODEL = E2E_PROVIDER_SECONDARY_MODEL;
  process.env.E2E_PROVIDER_THOUGHT_LEVEL = providerEnv.thoughtLevel;
  // 修复原因：runnerEnv 只保证 WDIO spec 进程可见，Electron/Host 启动链继承的是
  // wdio config 进程环境。请求安全 capture 与 live-team 选择的生产控制面只写 runnerEnv
  // 会让 Agent 继续访问测试域；live-team 的生产 JWT 则会触发 401。
  Object.assign(
    process.env,
    getE2EProviderEndpointEnv(specs, e2eProviderPresetName, upstreamE2EHttpMode),
  );
}

function readE2EThoughtLevel() {
  for (const envName of ["E2E_PROVIDER_THOUGHT_LEVEL", "LLM_E2E_THOUGHT_LEVEL"]) {
    if (process.env[envName] !== undefined) {
      return process.env[envName]?.trim() ?? "";
    }
  }
  return e2eProviderPreset.thoughtLevel;
}

function readUpstreamE2EHttpMode() {
  const mode = resolveUpstreamE2EHttpMode({
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    manualReview: manualReviewE2E,
    requestedMode: requestedUpstreamE2EHttpMode,
  });
  process.env.E2E_PROVIDER_HTTP_MODE = mode;
  return mode;
}

function applyUpstreamE2EHttpModeForWorker(specs: string[]) {
  upstreamE2EHttpMode = resolveUpstreamE2EHttpModeForWorker({
    caseLocalReplayFixtureAvailable: hasUpstreamCaseLocalReplayFixtureForWorker({
      caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
      specs,
    }),
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    requestedMode: requestedUpstreamE2EHttpMode,
    specs,
  });
  // Bug 根因：combined run 的全局 manual-review 开关过去把正式 worker 也固定为
  // capture，case-local replay 因此直连真实模型并产生假失败。mode 必须在每个
  // Electron 启动前按该 worker 的 spec 与 fixture 完整性重新决策。
  process.env.E2E_PROVIDER_HTTP_MODE = upstreamE2EHttpMode;
}

function applyAskUserQuestionClockScaleForWorker(specs: string[]) {
  const scale = resolveAskUserQuestionClockScaleForWorker({
    requestedScale: requestedAskUserQuestionClockScale,
    specs,
  });
  if (scale) {
    // Bug 根因：该 pending case 的五分钟 deadline 依赖测试时钟缩放；单独跑时由
    // 人工注入，全量 worker 没有继承就会在产品启动前直接失败。按 spec 注入并在
    // 下一 worker 清理，避免缩放泄漏到普通 AskUserQuestion 行为。
    process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV] = scale;
  } else {
    delete process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV];
  }
}

function prepareDesktopAppBuild() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    if (!existsSync(E2E_PACKAGED_APP_BINARY_PATH)) {
      throw new Error(`[e2e] packaged app binary missing: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    }
    console.log(`[e2e] using packaged app: ${E2E_PACKAGED_APP_BINARY_PATH}`);
    return;
  }
  // Bug 根因：Windows 上 Agent CLI 只能经过 zcode-runtime-host.exe 启动，而下面的
  // build:no-runtime-assets 不产出它，Windows CI 全部 case 报 runtime host missing /
  // slash 目录为空。复用构建（ZCODE_E2E_SKIP_BUILD）也必须检查，产物不受 out stamp 保护。
  ensureWindowsRuntimeHost();
  // 修复原因：WDIO 配置会先被 esbuild 解析，CI 可执行字符串必须保持 ASCII 引号。
  // shard 的 mock 端口在父构建后才分配；有网页 mock 时必须按当前端口重建编译期 origin。
  if (shouldReuseDesktopE2EBuild(process.env)) {
    console.log("[e2e] ZCODE_E2E_SKIP_BUILD=1, skipping onPrepare build");
    assertDesktopE2EBuildReady("ZCODE_E2E_SKIP_BUILD=1");
    return;
  }
  // Bugfix: 直接执行 `wdio run` 会绕过 package.json 的 pretest:e2e；只检查
  // out 文件是否存在又会跑到旧 renderer，表现成”已修复但 e2e 仍白屏/没动作”。
  // 因此 WDIO 入口始终先构建，确保测试使用当前源码对应的桌面产物。
  runPnpmWorkspaceCommand(["--filter", "@zcode/desktop", "build:no-runtime-assets"]);
  assertDesktopE2EBuildReady("onPrepare build");
}

// 非 Windows 由脚本 --if-windows 跳过；--ensure 按源码摘要复用已有产物，只在缺失或过期时调用 CMake。
// 调用方持有 E2E build 锁，分片 runner 不会并发写同一个 bundled-tools 目录。
function ensureWindowsRuntimeHost() {
  execFileSync(
    process.execPath,
    [resolve(REPO_ROOT, "scripts/build-windows-runtime-host.mjs"), "--if-windows", "--ensure"],
    { cwd: REPO_ROOT, env: createPnpmChildEnv(), stdio: "inherit" },
  );
}

function runPnpmWorkspaceCommand(
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string> },
) {
  execFileSync(PNPM_COMMAND, args, {
    cwd: REPO_ROOT,
    env: { ...createPnpmChildEnv(), ...options?.env },
    stdio: "inherit",
    // Bug 根因：prepare:remote-assets 会在 CI 上下载 node 二进制并串行构建多个包，
    // 无 timeout 时一旦下载/构建挂死，wdio onPrepare 会一直占住专用 runner 直到 job
    // 全局超时。这里只给防挂死的宽裕上限（冷缓存全量 prepare 约 10 分钟），不参与限速；
    // 其余调用点（本地构建）保持无 timeout。
    ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    // 修复原因：Windows runner 上 `pnpm` 由 cmd shim 提供，直接 execFileSync("pnpm.cmd")
    // 在部分 CI 环境会报 spawnSync EINVAL，导致 WDIO 继续用缺失/旧产物启动 Electron。
    shell: process.platform === "win32",
  });
}

function assertDesktopE2EBuildReady(context: string) {
  if (!existsSync(DESKTOP_BUILD_ENTRY_POINT)) {
    throw new Error(
      `[e2e] ${context}: desktop main entrypoint missing: ${DESKTOP_BUILD_ENTRY_POINT}`,
    );
  }

  if (!isRendererE2EStoreBridgeCompiled(E2E_RENDERER_ASSETS_DIR)) {
    throw new Error(`[e2e] ${context}: renderer build is missing VITE_ZCODE_E2E_STORE_BRIDGE=1`);
  }
}

async function stageDesktopE2EAppOutput() {
  await rm(E2E_APP_OUTPUT_DIR, { force: true, recursive: true });
  // 修复原因：开发态 pre-dev/tsup watch 会重建共享 packages/desktop/out；长批次若直接
  // 从 out 启动，运行中目录被清空后后续 loadFile 会进入 chrome-error://。构建完成后
  // 按 runId 复制不可变应用产物，让 E2E 与并行开发进程彻底隔离。
  // 使用写时复制降低多 shard 的准备成本；不能使用共享 inode 的硬链接，否则类型检查
  // 原地覆盖 out/host 时会同时破坏已经启动的隔离副本。
  await stageE2EAppOutput(DESKTOP_BUILD_OUTPUT_DIR, E2E_APP_OUTPUT_DIR);
  if (
    hasRequiredSshE2EEnvironment(process.env) ||
    process.env.ZCODE_E2E_SSH_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_A_HOST?.trim() ||
    process.env.ZCODE_E2E_SSH_B_HOST?.trim()
  ) {
    // Bug 根因：CI 只有 build:remote:assets job 产出 mock-cdn/releases/<version>，且跑在通用
    // macos runner 槽位；conversation e2e 在专用 runner 上，mock-cdn 工作区持久化目录互不
    // 相通，版本 bump 后专用 runner 必然缺新版本 release，直接 fatal 会把每次升级变成
    // CI-only 失败。改为缺目录时自动跑 prepare:remote-assets（幂等），产出后仍缺失才
    // fail-closed。
    // Bug 根因：packages/desktop 的 prepare:remote-assets 已随 legacy asset pipeline 一并删除，
    // `pnpm --filter @zcode/desktop prepare:remote-assets` 会以 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
    // 失败并让所有 SSH E2E 在 onPrepare 阶段 fatal；必须调用根 package.json 的
    // prepare:remote-assets（→ @zcode/server-cli stage:remote-assets）。runPnpmWorkspaceCommand
    // 的 cwd 固定为 REPO_ROOT，直接传脚本名即可命中根脚本。
    // 本机 Docker runner 声明「只需 Linux」时，helper 改读 descriptor 判断两个 Linux 目标，
    // 并只调用 `ZCODE_ENV=test pnpm prepare:remote-assets:linux`；未声明时行为不变。
    await ensureSshRemoteReleaseAssets({
      releaseDir: E2E_REMOTE_RELEASE_SOURCE_DIR,
      scope: resolveSshRemoteReleaseScope(process.env),
      prepareReleaseAssets: (request) =>
        runPnpmWorkspaceCommand([request.script], {
          // 防挂死上限：冷缓存全量 prepare 约 10 分钟，给到 30 分钟只兑现在「彻底卡死」时
          // 让 onPrepare 失败退出，正常慢路径不受影响。
          timeoutMs: 30 * 60 * 1000,
          env: request.env,
        }),
    });
    // Bug 根因：dual-SSH case 只配置 A/B target；若这里只识别 common host，就不会把
    // 当前源码构建的 remote release 放进 runId 隔离目录，远端会继续复用同版本的旧
    // server bundle，并用旧协议 schema 拒绝 enabledSource 等新字段。
    await stageE2EAppOutput(E2E_REMOTE_RELEASE_SOURCE_DIR, E2E_REMOTE_RELEASE_OUTPUT_DIR);
  }
  if (!existsSync(E2E_APP_ENTRY_POINT)) {
    throw new Error(`[e2e] staged desktop main entrypoint missing: ${E2E_APP_ENTRY_POINT}`);
  }
  if (!isRendererE2EStoreBridgeCompiled(E2E_APP_RENDERER_ASSETS_DIR)) {
    throw new Error("[e2e] staged renderer is missing VITE_ZCODE_E2E_STORE_BRIDGE=1");
  }
}

function isRendererE2EStoreBridgeCompiled(rendererAssetsDir: string) {
  if (!existsSync(rendererAssetsDir)) {
    return false;
  }

  return readdirSync(rendererAssetsDir, { withFileTypes: true }).some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      return false;
    }

    const source = readFileSync(resolve(rendererAssetsDir, entry.name), "utf-8");
    return /["'\x60]?VITE_ZCODE_E2E_STORE_BRIDGE["'\x60]?\s*:\s*["'\x60]1["'\x60]/u.test(source);
  });
}

function createPnpmChildEnv() {
  // Bugfix: WDIO 为加载 TypeScript config 会通过 NODE_OPTIONS 注入 tsx loader。
  // pnpm 11 继承该 loader 后会误尝试加载仓库根不存在的 .pnpmfile.mjs，
  // 导致 onPrepare 构建报错；子 pnpm 只负责执行 workspace script，不需要继承它。
  const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  return {
    ...env,
    // Bugfix: WDIO 会把 HOME/USERPROFILE 改到 .e2e-home 隔离应用数据；
    // 但 onPrepare 的子 pnpm 需要真实用户目录里的 corepack/nvm 缓存，否则
    // CI 清理 .e2e-home 后会找不到 corepack 管理的 pnpm.mjs。
    ...(HOST_HOME_DIR ? { HOME: HOST_HOME_DIR } : {}),
    ...(HOST_USERPROFILE_DIR ? { USERPROFILE: HOST_USERPROFILE_DIR } : {}),
    // Bugfix: agent 构建脚本会进入 apps/zcode-cli 子 workspace；pnpm 11 的
    // verify-deps-before-run 会触发子 workspace install，但该 workspace 运行时
    // 依赖根仓库 @zcode/shared，自动 install 无法解析，必须在 E2E 构建链路关闭。
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    // 修复原因：E2E 依赖 renderer 暴露 store bridge；只在 WDIO 构建链路显式注入，
    // 避免普通 production/test 产品构建意外暴露可变全局 store。
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_DESKTOP_AGENT_BUILD_MODE: env.ZCODE_DESKTOP_AGENT_BUILD_MODE ?? "pnpm",
  };
}

function prepareZCodeAgentServer() {
  if (E2E_PACKAGED_APP_BINARY_PATH) {
    // 真正的 Preview 包必须使用随包 Agent，禁止测试 runner 注入源码入口掩盖漏打包。
    configureZCodeAgentServerEnv();
    return;
  }
  if (process.env.ZCODE_E2E_SKIP_AGENT_BUILD === "1") {
    // 修复原因：Windows 全量 E2E 分片由父 runner 统一构建一次 agent；子 WDIO 若再次构建，
    // 会并发覆盖同一 dist 目录。跳过时仍校验入口，避免旧或缺失产物静默启动。
    console.log("[e2e] ZCODE_E2E_SKIP_AGENT_BUILD=1, skipping agent build");
    if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
      throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
    }
    configureZCodeAgentServerEnv();
    return;
  }

  // Bugfix: e2e 还在找仓库外的旧原生 zcode-agent binary，并调用已经删除的
  // `build:agent-exe`。当前桌面端统一通过 zcode-cli 的 app-server JS bundle
  // 暴露 ZCode Protocol，这里复用正式开发入口的构建脚本，之后由 bundled resolver
  // 选择已校验的 bundle，保留存储准备能力和正式桌面启动契约。
  execFileSync(process.execPath, [BUILD_DESKTOP_AGENT_SCRIPT], {
    cwd: REPO_ROOT,
    env: createPnpmChildEnv(),
    stdio: "inherit",
  });

  if (!existsSync(ZCODE_CLI_ENTRYPOINT)) {
    throw new Error(`ZCode CLI entrypoint not found: ${ZCODE_CLI_ENTRYPOINT}`);
  }

  configureZCodeAgentServerEnv();
}

function configureZCodeAgentServerEnv() {
  // 数据库准备只信任 bundled resolver 确认的入口。E2E 即使把本轮 bundle 填进自定义
  // command，也会按 unsupported_runtime 拒绝；清除继承的覆盖，复用正式桌面解析链。
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_ARGS_JSON;
  delete process.env.ZCODE_AGENT_SERVER_CWD;
}

function assertUpstreamCaptureConfig() {
  if (!e2eProviderPreset.baseUrl) {
    throw new Error(
      `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires E2E_PROVIDER_BASE_URL.`,
    );
  }
  const apiKey = readE2EProviderApiKey();
  if (apiKey && apiKey !== "xxx") {
    return;
  }

  // 修复原因：默认 e2e 已切成 fixture replay；只有显式 capture 才会访问真实
  // 上游。采集 fixture 时必须提前校验真实 key，避免把失败响应固化进仓库。
  throw new Error(
    `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires one of: ${e2eProviderPreset.apiKeyEnvNames.join(", ")}.`,
  );
}

function readE2EProviderApiKey() {
  for (const envName of e2eProviderPreset.apiKeyEnvNames) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function ensureUpstreamReplayConfig() {
  process.env.E2E_PROVIDER_API_KEY = E2E_PROVIDER_REPLAY_API_KEY;
}

async function startUpstreamE2EHttp(specs: string[] = []) {
  await stopUpstreamE2EHttp();
  if (
    upstreamE2EHttpMode === "capture" ||
    specs.some((spec) => spec.includes("conversation-session-toolsearch"))
  ) {
    applyE2EWorkerReplayProxyEnv(process.env, [], "", configuredE2EWorkerNetworkEnv);
    await startUpstreamCaptureProxy(specs);
    return;
  }

  ensureUpstreamReplayConfig();
  upstreamReplayServer = await startUpstreamReplayServer({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    fixtureVariables: createE2EReplayFixtureVariables(E2E_HOME_DIR),
    fixturePaths: await resolveUpstreamReplayFixturePaths(specs),
  });
  upstreamE2EBaseUrl = upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
  process.env.E2E_PROVIDER_CAPTURE_PATH = upstreamReplayServer.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = `${upstreamReplayServer.host}:${upstreamReplayServer.port}`;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = upstreamReplayServer.baseUrl;
  process.env.NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  process.env.no_proxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  applyE2EWorkerReplayProxyEnv(
    process.env,
    specs,
    upstreamReplayServer.baseUrl,
    configuredE2EWorkerNetworkEnv,
  );
  writeUpstreamE2ERuntimeFile("replay", upstreamReplayServer.baseUrl);
}

function shouldUseCodingPlanTeamMock(specs: string[] = []) {
  return shouldPrepareCodingPlanTeamMock(specs);
}

async function startCodingPlanTeamMockIfNeeded(specs: string[] = []) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    await stopCodingPlanTeamMock();
    return;
  }

  const preparedBaseUrl = process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim();
  if (!codingPlanTeamMockServer && preparedBaseUrl) {
    // Bugfix：采用前必须探活。launcher 若从 shell 继承了残留的死 URL、或 worker 拿到的
    // runnerEnv 指向已退出的 launcher server，静默采用会让控制面与数据面同时失联。
    if (await isCodingPlanTeamMockAlive(preparedBaseUrl)) {
      codingPlanTeamMockBaseUrl = preparedBaseUrl;
      applyCodingPlanTeamMockEnv(process.env, preparedBaseUrl);
      return;
    }
    delete process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  }
  if (codingPlanTeamMockServer) {
    applyCodingPlanTeamMockEnv(process.env, codingPlanTeamMockBaseUrl);
    return;
  }
  if (process.env.WDIO_WORKER_ID !== undefined) {
    // Fail fast：worker 内新起的 server 只有测试代码可达，Electron/Host 仍会指向
    // launcher 在 onPrepare 分配的地址（见 onPrepare 注释）。走到这里说明 runnerEnv
    // 没有携带存活的 mock 地址，静默降级只会让 waitForMockRequest 超时更难排查。
    throw new Error(
      "coding plan reset mock 未在 onPrepare 准备（runnerEnv 缺少存活的 ZCODE_E2E_CODING_PLAN_MOCK_URL）",
    );
  }

  let caseMode:
    | "default"
    | typeof SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    | "model-provider-plan-surface" = "default";
  let subagentOAuthTokenIssued = false;
  let modelProviderCatalogMode: "full" | "partial" | "unavailable" = "full";
  let presentation: EntitlementPresentation | undefined;
  let scenario: "personalOnly" | "teamOnly" | "both" = "both";
  // Bug 回归：Start Plan 独立 case 需要 billing/balance 返回 Start Plan 权益与模型，
  // 让体验套餐和 Coding Plan 从首启就真实共存；mock 只在 onPrepare 创建一次，
  // 必须在创建时固定该模式，后续 worker 共享同一个 server 状态。
  const startIndependent = workerSpecsContain(
    specs,
    "conversation-session-start-plan-independent.test.ts",
  );
  const offPeakTeam = isOffPeakTeamPlanSpec(specs);
  if (offPeakTeam) {
    // 通用产品 mock 会替换成个人假凭证，无法验证 Team。只在测试进程替代 HTTP 服务端。
    const { startOffPeakMockGateway, createServiceLogger } = await import("@zcode/services/node");
    offPeakTeamGateway = await startOffPeakMockGateway(
      {
        logger: createServiceLogger("e2e-offpeak-team", { isDebugEnabled: false }),
        resolveUpstream: async () => {
          throw new Error("Team E2E 不允许访问真实上游");
        },
      },
      {
        port: 0,
        readyDelayMs: 0,
        readyTtlMs: 600000,
        activeMs: 600000,
        scenario: "foreground-subagents",
      },
    );
    process.env.ZCODE_OFFPEAK_MOCK_PORT = String(offPeakTeamGateway.port);
  }
  let providerResponsive = startIndependent;
  let faultMode:
    | "none"
    | "optionalActivity"
    | "quotaBusinessFailure"
    | "quotaFailure"
    | "startBalance"
    | "startBalanceFailure"
    | "unavailableTeam"
    | "expiredTeam"
    | "twoTeams" = "none";
  let resetScenario:
    | "none"
    | "emptyThenGrant"
    | "existingMultiple"
    | "fiveHourUse"
    | "multiFiveHourUse"
    | "multiFiveHourUseLagging"
    | "urgentOpportunity"
    | "weekToggle" = "none";
  let resetScenarioStartedAt = Date.now();
  let resetOpportunityGranted = false;
  let resetUseAccepted = false;
  let resetUseConfirmed = false;
  // Bugfix：used_at 必须在确认时刻锁存。若每次 /status 都返回新的 Date.now()，
  // 客户端会把每轮轮询当成新完成，重复 history/read、entitlement 强刷甚至重播动效。
  let resetUsedAt: number | null = null;
  // multiFiveHourUse（QR-E2E-14）：FIVE_HOUR 持有 2 张机会，/use 即时核销最早一张（无 confirm
  // 步骤）。按 idempotency_key 幂等计数，与真实服务端一致：客户端重复发送旧 key 不会再核销一张。
  const resetMultiUsedKeys = new Set<string>();
  let resetMultiUnread = false;
  // multiFiveHourUseLagging（QR-E2E-15）：在 multiFiveHourUse 基础上，/use 核销结果延迟
  // RESET_USE_VISIBLE_LAG_MS 才在 /status 可见；窗口内 /status 返回核销前快照（上一张 used_at）。
  const RESET_USE_VISIBLE_LAG_MS = 600;
  // weekToggle（QR-E2E-16）：FIVE_HOUR、WEEK 各 1 张；WEEK 是否在 /status 里可见由测试经
  // /__e2e/coding-plan/reset-week-available 切换，模拟周机会被别处核销后又重新发放。
  let resetWeekAvailable = true;
  let resetMultiLag: {
    usedAt: number | null;
    usedCount: number;
    unread: boolean;
    visibleAt: number;
  } | null = null;
  const requests: Array<{
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
    method: string;
    path: string;
    query: Record<string, string>;
  }> = [];
  const shareMockRoute = createConversationShareMockRoute();
  codingPlanTeamMockServer = createServer(async (request, response) => {
    if (await shareMockRoute(request, response)) return;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (offPeakTeamGateway && url.pathname.startsWith("/api/v1/off-peak/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" && !["host", "connection", "content-length"].includes(key)
            ? [[key, value]]
            : [],
        ),
      );
      const upstream = await fetch(new URL(request.url!, offPeakTeamGateway.origin), {
        method: request.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/case-mode" && request.method === "POST") {
      presentation = undefined;
      const body = await readRequestJson<{ mode?: typeof caseMode }>(request);
      caseMode =
        body.mode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          : body.mode === "model-provider-plan-surface"
            ? "model-provider-plan-surface"
            : "default";
      subagentOAuthTokenIssued = false;
      modelProviderCatalogMode = "full";
      scenario =
        caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ? "personalOnly" : "both";
      faultMode = "none";
      resetScenario = "none";
      resetScenarioStartedAt = Date.now();
      resetOpportunityGranted = false;
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      requests.length = 0;
      writeJson(response, { mode: caseMode, ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/team-health" && request.method === "GET") {
      writeJson(response, { ok: true, mock: "team" });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/catalog-mode" && request.method === "POST") {
      const body = await readRequestJson<{ mode?: string }>(request);
      if (body.mode !== "full" && body.mode !== "partial" && body.mode !== "unavailable") {
        writeJson(response, { code: 400, msg: "invalid catalog mode" }, 400);
        return;
      }
      modelProviderCatalogMode = body.mode;
      writeJson(response, { mode: modelProviderCatalogMode, ok: true });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        scenario?: typeof scenario;
        faultMode?: typeof faultMode;
        providerResponsive?: boolean;
        presentation?: EntitlementPresentation;
      }>(request);
      providerResponsive = body.providerResponsive === true;
      presentation = body.presentation;
      if (
        body.scenario === "personalOnly" ||
        body.scenario === "teamOnly" ||
        body.scenario === "both"
      ) {
        scenario = body.scenario;
      }
      faultMode =
        body.faultMode === "optionalActivity" ||
        body.faultMode === "quotaBusinessFailure" ||
        body.faultMode === "quotaFailure" ||
        body.faultMode === "startBalance" ||
        body.faultMode === "unavailableTeam" ||
        body.faultMode === "expiredTeam" ||
        body.faultMode === "twoTeams" ||
        body.faultMode === "startBalanceFailure"
          ? body.faultMode
          : "none";
      requests.length = 0;
      writeJson(response, { faultMode, ok: true, scenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        resetScenario?: typeof resetScenario;
      }>(request);
      resetScenario =
        body.resetScenario === "emptyThenGrant" ||
        body.resetScenario === "existingMultiple" ||
        body.resetScenario === "fiveHourUse" ||
        body.resetScenario === "multiFiveHourUse" ||
        body.resetScenario === "multiFiveHourUseLagging" ||
        body.resetScenario === "urgentOpportunity" ||
        body.resetScenario === "weekToggle"
          ? body.resetScenario
          : "none";
      resetOpportunityGranted = false;
      resetScenarioStartedAt = Date.now();
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      resetWeekAvailable = true;
      requests.length = 0;
      writeJson(response, { ok: true, resetScenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-week-available" && request.method === "POST") {
      const body = await readRequestJson<{ available?: unknown }>(request);
      resetWeekAvailable = body.available === true;
      writeJson(response, { ok: true, available: resetWeekAvailable });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-confirm-use" && request.method === "POST") {
      resetUseConfirmed = true;
      resetUsedAt ??= Date.now();
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/requests") {
      writeJson(response, { ok: true, requests });
      return;
    }

    const isResetMutation =
      request.method === "POST" &&
      (url.pathname.endsWith("/coding-plan/reset/opportunity") ||
        url.pathname.endsWith("/coding-plan/reset/use"));
    const requestBody = isResetMutation ? await readRequestJson<unknown>(request) : undefined;
    requests.push({
      ...(requestBody === undefined ? {} : { body: requestBody }),
      headers: {
        // reset 四接口的双 JWT 契约（Authorization=zcode JWT / X-Bigmodel-Authorization=MaaS JWT）
        // 由用例断言，必须一并记录。
        authorization: request.headers.authorization,
        "bigmodel-organization": request.headers["bigmodel-organization"],
        "bigmodel-project": request.headers["bigmodel-project"],
        "x-bigmodel-authorization": request.headers["x-bigmodel-authorization"],
      },
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/oauth/profile" &&
      request.headers.authorization === `Bearer ${CN_UNLINKED_E2E_ZCODE_JWT}`
    ) {
      // 国内新账号没有注册 BigModel：profile 成功返回主体，但没有 bigmodel 关联块。
      writeJson(response, buildCnUnlinkedProfileResponse());
      return;
    }

    if (presentation) {
      const fixture = presentationResponse(url.pathname, presentation);
      if (fixture) {
        writeJson(response, fixture);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/cli/init"
    ) {
      writeJson(response, {
        code: 0,
        data: {
          authorize_url: `https://bigmodel.cn/login?appId=zcode&redirect=${encodeURIComponent("https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel")}&state=${SUBAGENT_CODING_PLAN_OAUTH_STATE}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
          flow_id: SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID,
          poll_interval_sec: 30,
        },
        msg: "",
      });
      return;
    }

    if (caseMode === "model-provider-plan-surface" && request.method === "GET") {
      if (url.pathname === "/api/v2/releases/latest") {
        writeJson(response, {
          config_version: "e2e-model-provider-catalog-v1",
          version: "3.8.1-e2e",
        });
        return;
      }
      if (url.pathname === "/api/v1/client/configs") {
        if (modelProviderCatalogMode === "unavailable") {
          writeJson(
            response,
            { code: 503, data: null, msg: "catalog temporarily unavailable" },
            503,
          );
          return;
        }
        // 原因：模型目录与团队套餐目录是两份事实；缺少套餐静态目录会让 Composer
        // 隐去已订阅团队，Automation 的原始 Registry 菜单却仍然可见。
        const catalogPayload = {
          ...MODEL_PROVIDER_CATALOG_PAYLOAD,
          data: {
            ...MODEL_PROVIDER_CATALOG_PAYLOAD.data,
            configs: {
              ...requestSecurityClientConfig(),
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                  {
                    productId: "product-team-a",
                    productName: "Team",
                    tier: "PRO",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "Monthly",
                    priceCurrency: "CNY",
                    payAmount: 598,
                  },
                ],
              },
            },
          },
        };
        if (modelProviderCatalogMode === "partial") {
          writeJson(response, {
            ...catalogPayload,
            data: {
              ...catalogPayload.data,
              builtinModels: catalogPayload.data.builtinModels.slice(0, 1),
              builtinProviders: catalogPayload.data.builtinProviders.slice(0, 1),
            },
          });
          return;
        }
        writeJson(response, catalogPayload);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === `/api/v1/oauth/cli/poll/${SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID}`
    ) {
      writeJson(response, {
        code: 0,
        data: { status: "pending" },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/token"
    ) {
      subagentOAuthTokenIssued = true;
      writeJson(response, {
        code: 0,
        data: {
          token: "e2e-subagent-login-zcode-jwt",
          bigmodel: {
            access_token: "e2e-subagent-login-bigmodel-token",
            refresh_token: "e2e-subagent-login-bigmodel-refresh-token",
          },
        },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v2/releases/latest"
    ) {
      writeJson(response, {
        config_version: resolveSubagentLoginCatalogConfigVersion(subagentOAuthTokenIssued),
        version: "3.8.1-e2e",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/client/configs"
    ) {
      writeJson(
        response,
        resolveSubagentLoginCatalogPayload({
          configVersion: url.searchParams.get("config_version"),
          oauthTokenIssued: subagentOAuthTokenIssued,
        }),
      );
      return;
    }

    if (
      faultMode === "startBalanceFailure" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, { code: 429, msg: "Too many requests" }, 429);
      return;
    }

    if (
      providerResponsive &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(
        response,
        // 推荐依赖目标模型的真实额度；与 SIP 使用的当前模型保持一致。
        // GLM-5-Turbo 已退役，Start balance 固定返回 GLM-5.3，不再按本轮 specs 切换模型。
        buildProviderResponsiveStartBalance("GLM-5.3"),
      );
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, {
        code: 0,
        data: { balances: [], plans: [] },
        msg: "",
        success: true,
      });
      return;
    }

    if (
      caseMode === "model-provider-plan-surface" &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      // 计划交叉用例需要一份确定的 Start Plan 权益；普通 Coding Plan 用例仍按
      // 自己的订阅接口判定，不把 Start 权益泄漏到其他 spec。
      // 仅有 plan 元信息、没有模型额度不会形成可执行 Start 候选。
      writeJson(response, buildProviderResponsiveStartBalance("GLM-5.2"));
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/status") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const lag =
          resetMultiLag !== null && Date.now() < resetMultiLag.visibleAt ? resetMultiLag : null;
        const usedCount = lag ? lag.usedCount : resetMultiUsedKeys.size;
        const usedAt = lag ? lag.usedAt : resetUsedAt;
        writeJson(response, {
          code: 0,
          data: {
            available_five_hour_resets: [
              { expire_at: resetScenarioStartedAt + 3_600_000 },
              { expire_at: resetScenarioStartedAt + 7_200_000 },
            ].slice(usedCount),
            available_week_resets: [{ expire_at: resetScenarioStartedAt + 86_400_000 }],
            latest_five_hour_reset_history:
              usedCount > 0 && usedAt !== null ? { used_at: usedAt } : null,
            latest_week_reset_history: null,
            has_unread_history: lag ? lag.unread : resetMultiUnread,
          },
        });
        return;
      }
      const useConfirmed = resetUseAccepted && resetUseConfirmed;
      const hasGrantedOpportunity = resetScenario !== "emptyThenGrant" || resetOpportunityGranted;
      const availableFiveHourResets =
        resetScenario === "none" || !hasGrantedOpportunity || useConfirmed
          ? []
          : resetScenario === "existingMultiple"
            ? [
                { expire_at: resetScenarioStartedAt + 3_600_000 },
                { expire_at: resetScenarioStartedAt + 7_200_000 },
              ]
            : resetScenario === "urgentOpportunity"
              ? // E2E mock must remain urgent after the Electron restart/build barrier;
                // anchoring to scenario setup made the opportunity expire before the
                // renderer finished its first status poll on slower Air runs.
                [{ expire_at: Date.now() + 120_000 }]
              : [{ expire_at: resetScenarioStartedAt + 3_600_000 }];
      const availableWeekResets =
        resetScenario === "existingMultiple" ||
        resetScenario === "fiveHourUse" ||
        (resetScenario === "weekToggle" && resetWeekAvailable)
          ? [{ expire_at: resetScenarioStartedAt + 86_400_000 }]
          : [];
      writeJson(response, {
        code: 0,
        data: {
          available_five_hour_resets: availableFiveHourResets,
          available_week_resets: availableWeekResets,
          latest_five_hour_reset_history:
            useConfirmed && resetUsedAt !== null ? { used_at: resetUsedAt } : null,
          latest_week_reset_history: null,
          has_unread_history: useConfirmed,
        },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/opportunity") {
      const granted = resetScenario === "emptyThenGrant" || resetScenario === "existingMultiple";
      resetOpportunityGranted ||= granted;
      writeJson(response, {
        code: granted ? 0 : 3301,
        data: granted ? { granted: true } : { granted: false, next_try_at: Date.now() + 60_000 },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/use") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const idempotencyKey = (requestBody as { idempotency_key?: unknown } | null | undefined)
          ?.idempotency_key;
        if (
          typeof idempotencyKey === "string" &&
          idempotencyKey &&
          !resetMultiUsedKeys.has(idempotencyKey)
        ) {
          if (resetScenario === "multiFiveHourUseLagging") {
            resetMultiLag = {
              usedAt: resetUsedAt,
              usedCount: resetMultiUsedKeys.size,
              unread: resetMultiUnread,
              visibleAt: Date.now() + RESET_USE_VISIBLE_LAG_MS,
            };
          }
          resetMultiUsedKeys.add(idempotencyKey);
          // used_at 严格递增：客户端以 used_at 变化识别“又完成了一次”。
          resetUsedAt = Math.max(Date.now(), (resetUsedAt ?? 0) + 1);
          resetMultiUnread = true;
        }
        writeJson(response, { code: 0, data: { used: true } });
        return;
      }
      resetUseAccepted = true;
      resetUseConfirmed = false;
      writeJson(response, { code: 0, data: { used: true } });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/history/read") {
      resetMultiUnread = false;
      writeJson(response, { code: 0, data: null });
      return;
    }

    // Composer 切换会刷新 Built-in；缺省下载地址保留本轮已种入的目录，不能返回 404。
    if (url.pathname === "/api/v1/client/configs") {
      writeJson(response, {
        code: 0,
        success: true,
        data: {
          configs: {
            ...requestSecurityClientConfig(),
            ...(offPeakTeam ? { offPeak: { enable_offpeak_task: true } } : {}),
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/agent/configs") {
      writeJson(response, {
        code: 0,
        data: requestSecurityAgentConfig(),
      });
      return;
    }

    if (url.pathname === "/api/anthropic/v1/messages") {
      const body = JSON.stringify(await readRequestJson(request));
      response.writeHead(200, codingPlanDefaultDataPlaneResponse.headers(body));
      response.end(codingPlanDefaultDataPlaneResponse.body(body));
      return;
    }

    if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
      writeJson(response, {
        code: 200,
        data: {
          productList:
            scenario === "personalOnly"
              ? []
              : [
                  {
                    productId: "product-team-a",
                    tier: "PRO",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "连续包月",
                    subscribed: true,
                  },
                ],
        },
      });
      return;
    }

    if (url.pathname === "/api/biz/customer/getCustomerInfo") {
      writeJson(response, {
        code: 200,
        data: {
          ...(caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
            ? {
                avatar: "",
                customerName: "Subagent Login E2E",
                customerNumber: "subagent-login-e2e-user",
                nickName: "Subagent Login E2E",
              }
            : {}),
          organizations: [
            ...(["expiredTeam", "twoTeams"].includes(faultMode)
              ? [
                  {
                    organizationId: "org-team-b",
                    organizationName: "Active Team",
                    projects: [{ projectId: "proj-team-b", projectName: "Team B", projectType: 2 }],
                  },
                ]
              : []),
            ...(faultMode === "unavailableTeam"
              ? [
                  {
                    organizationId: "org-unavailable",
                    organizationName: "Unavailable Team",
                    projects: [
                      { projectId: "proj-unavailable", projectName: "Unavailable", projectType: 2 },
                    ],
                  },
                ]
              : []),
            {
              organizationId: "org-team-a",
              organizationName: providerResponsive ? PROVIDER_RESPONSIVE_TEAM_NAME : "Team Org",
              projects: [
                ...(scenario !== "teamOnly" ||
                caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ||
                caseMode === "model-provider-plan-surface"
                  ? [
                      {
                        projectId: "proj-personal-a",
                        projectName: "Personal Project",
                        projectType: 1,
                      },
                    ]
                  : []),
                {
                  projectId: "proj-team-a",
                  projectName: "Team A",
                  projectType: 2,
                },
              ],
            },
          ],
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/access_tokens")) {
      // 原因：账号 Provider 已改用项目 Token；旧夹具只返回长期 Key，使个人权益一直 unknown。
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
      writeJson(response, {
        code: 200,
        data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn: 600, expiresAt },
      });
      return;
    }

    if (url.pathname.endsWith("/api_keys")) {
      // Bug 根因：Provider 重构后个人 Coding Plan 会从 customerInfo 的个人项目解析
      // 项目 Key。旧 mock 仅按全局 scenario 返回 Team Key，both 场景即使明确选择
      // 个人 Provider 也拿不到对应凭据。fixture 必须和服务端一样按项目身份返回 Key。
      const personal = url.pathname.includes("/projects/proj-personal-a/");
      if (faultMode === "unavailableTeam" && url.pathname.includes("/projects/proj-unavailable/")) {
        writeJson(
          response,
          request.method === "POST"
            ? { code: 200, success: false, msg: "暂无有效的团队套餐授权记录", data: null }
            : { code: 200, data: [] },
        );
        return;
      }
      writeJson(response, {
        code: 200,
        data: [
          {
            apiKey: personal ? "personal-ak" : "team-ak",
            keyType: personal ? 1 : 2,
            name: personal ? "zcode-api-key" : "zcode-team-api-key",
          },
        ],
      });
      return;
    }

    if (
      request.method === "POST" &&
      /^\/api\/biz\/v1\/organization\/org-team-a\/projects\/proj-(personal|team)-a\/api_keys\/(personal|team)-ak\/access_tokens$/.test(
        url.pathname,
      )
    ) {
      // 项目鉴权已改为短期 Token；缺少签发响应会让模型目录在工具请求之前被判不可用。
      const body = await readRequestJson<{ clientType?: string }>(request);
      if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
        writeJson(response, { code: 400, msg: "invalid_token_request" }, 400);
        return;
      }
      const expiresIn = 600;
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
      writeJson(response, {
        code: 200,
        data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn, expiresAt },
      });
      return;
    }

    if (
      url.pathname.endsWith("/api_keys/copy/team-ak") ||
      url.pathname.endsWith("/api_keys/copy/personal-ak")
    ) {
      const personal = url.pathname.endsWith("/api_keys/copy/personal-ak");
      writeJson(response, {
        code: 200,
        data: { secretKey: personal ? "personal-secret" : "team-secret" },
      });
      return;
    }

    if (url.pathname === "/api/biz/team/subscribe/product/querySubscribeDetail") {
      writeJson(response, {
        code: 200,
        success: true,
        data:
          scenario === "personalOnly"
            ? { hasSubscription: false }
            : {
                hasSubscription: true,
                status:
                  faultMode === "expiredTeam" &&
                  request.headers["bigmodel-project"] !== "proj-team-b"
                    ? "EXPIRED"
                    : "EFFECTIVE",
                memberGrantStatus: "VALID",
                productId: "product-team-a",
                productName: "Team Org",
                subscribeEndTime: "2027-08-25",
                subscribePeriod: "YEARLY",
              },
      });
      return;
    }

    if (url.pathname === "/api/biz/subscription/list") {
      writeJson(response, {
        code: 200,
        data:
          scenario === "teamOnly"
            ? []
            : [
                {
                  productId: "personal-coding",
                  productName: "Coding Plan",
                  // Bugfix: provider 可用性校验会要求订阅处于有效期；只给 renewTime 会被判成无个人权益。
                  inCurrentPeriod: true,
                  status: "VALID",
                  renewTime: "2026-08-01T00:00:00.000Z",
                },
              ],
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/quota/limit") {
      if (faultMode === "quotaBusinessFailure") {
        // CTP-11 第一阶段用业务失败生成 provider/unavailable 快照，验证入口稳定；
        // 随后的详情 fatal 会显式切换 quotaFailure，避免两种语义互相覆盖。
        writeJson(response, { code: 500, msg: "e2e quota business failure" });
        return;
      }
      if (faultMode === "quotaFailure") {
        writeJson(response, { code: 500, msg: "e2e quota transport failure" }, 500);
        return;
      }
      const isTeam = url.searchParams.get("type") === "2";
      const hasPlan = isTeam ? scenario !== "personalOnly" : scenario !== "teamOnly";
      if (!hasPlan) {
        writeJson(response, {
          code: 500,
          success: false,
          msg: "当前用户不存在coding plan",
        });
        return;
      }
      writeJson(response, {
        code: 200,
        data: {
          level: isTeam ? "team" : "pro",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              remaining: isTeam ? 900 : 700,
              percentage: isTeam ? 10 : 30,
              nextResetTime: Date.UTC(2026, 6, 4, 10, 0),
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              remaining: isTeam ? 8000 : 6000,
              percentage: isTeam ? 20 : 40,
              nextResetTime: Date.UTC(2026, 6, 10, 0, 0),
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/credit-usage/activity") {
      if (faultMode === "optionalActivity") {
        writeJson(response, { code: 500, msg: "e2e optional activity failure" }, 500);
        return;
      }
      writeJson(response, {
        code: 200,
        data: {
          summary: {
            totalTokens: 350720,
            peakDailyTokens: 120000,
            peakDailyTokensDate: "2026-08-16",
            totalUsageDurationMs: 5400000,
            currentStreakDays: 2,
            longestStreakDays: 4,
          },
          series: [
            {
              date: "2026-08-16",
              totalTokens: 350720,
              modelCallCount: 7,
              mcpCalls: 3,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/credit-usage/usage-detail") {
      const isModel = url.searchParams.get("usageType") === "MODEL";
      writeJson(response, {
        code: 200,
        data: isModel
          ? {
              summary: {
                cacheHitRate: { value: 0.893, trend: 0.12 },
                totalCredits: { value: 28.95, trend: -0.2 },
                averageDailyCredits: { value: 4.13, trend: 0 },
              },
              modelUsage: {
                xTime: ["2026-08-16"],
                modelDataList: [
                  {
                    modelName: "glm-credit-e2e",
                    totalTokens: 350720,
                    totalCredits: 28.95,
                    totalCreditsUsage: [28.95],
                    totalTokensUsage: [350720],
                    cachedInputCreditsUsage: [17.68],
                    uncachedInputCreditsUsage: [8.63],
                    outputCreditsUsage: [2.64],
                    cachedInputTokensUsage: [200000],
                    uncachedInputTokensUsage: [100000],
                    outputTokensUsage: [50720],
                    sortOrder: 1,
                  },
                ],
              },
            }
          : {
              summary: {
                cacheHitRate: { value: null },
                totalCredits: { value: 1, trend: 0.5 },
                averageDailyCredits: { value: 0.2, trend: 0.1 },
              },
              mcpUsage: {
                xTime: ["2026-08-16"],
                mcpDataList: [
                  {
                    mcpCode: "e2e-search",
                    mcpName: "E2E Search MCP",
                    creditsUsage: [1],
                    mcpCallCount: [3],
                    totalUsageCount: 3,
                    totalCredits: 1,
                    sortOrder: 1,
                  },
                ],
              },
            },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/model-performance-day") {
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-08-16"],
          proMaxDecodeSpeed: [125.4],
          liteDecodeSpeed: [55.2],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/model-usage") {
      const isTeam = url.searchParams.get("type") === "2";
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-07-01", "2026-07-02"],
          granularity: "daily",
          totalUsage: {
            totalModelCallCount: 2,
            totalTokensUsage: isTeam ? 3210 : 1230,
          },
          modelDataList: [
            {
              modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
              sortOrder: 1,
              tokensUsage: isTeam ? [1200, 2010] : [500, 730],
              totalTokens: isTeam ? 3210 : 1230,
            },
          ],
          modelSummaryList: [
            {
              modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
              sortOrder: 1,
              totalTokens: isTeam ? 3210 : 1230,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === "/api/monitor/usage/tool-usage") {
      const isTeam = url.searchParams.get("type") === "2";
      writeJson(response, {
        code: 200,
        data: {
          x_time: ["2026-07-01", "2026-07-02"],
          granularity: "daily",
          toolDataList: [
            {
              toolCode: isTeam ? "team-search" : "personal-search",
              toolName: isTeam ? "Team Search" : "Personal Search",
              sortOrder: 1,
              usageCount: isTeam ? [2, 3] : [1, 1],
              totalUsageCount: isTeam ? 5 : 2,
            },
          ],
          toolSummaryList: [
            {
              toolCode: isTeam ? "team-search" : "personal-search",
              toolName: isTeam ? "Team Search" : "Personal Search",
              sortOrder: 1,
              totalUsageCount: isTeam ? 5 : 2,
            },
          ],
        },
      });
      return;
    }

    writeJson(response, { code: 404, msg: `Unhandled mock path: ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolveStart) => {
    codingPlanTeamMockServer?.listen(0, "127.0.0.1", resolveStart);
  });
  const address = codingPlanTeamMockServer.address() as AddressInfo;
  codingPlanTeamMockBaseUrl = `http://127.0.0.1:${address.port}`;
  applyCodingPlanTeamMockEnv(process.env, codingPlanTeamMockBaseUrl);
}

async function isCodingPlanTeamMockAlive(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/__e2e/coding-plan/team-health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function configureCodingPlanTeamMockForSpecs(specs: string[]) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    return;
  }
  const baseUrl =
    codingPlanTeamMockBaseUrl || process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim() || "";
  if (!baseUrl) {
    throw new Error("coding plan mock case mode 配置失败：mock URL 未初始化");
  }
  const mode = isSubagentCodingPlanLoginCatalogStaleSpec(specs)
    ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    : isModelProviderPlanSurfaceSpec(specs)
      ? "model-provider-plan-surface"
      : "default";
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/case-mode`, {
    body: JSON.stringify({ mode }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`coding plan mock case mode 配置失败：status=${response.status} mode=${mode}`);
  }
}

async function stopCodingPlanTeamMock() {
  await offPeakTeamGateway?.close();
  offPeakTeamGateway = null;
  if (codingPlanTeamMockServer) {
    await new Promise<void>((resolveStop) => {
      codingPlanTeamMockServer?.close(() => resolveStop());
    });
    codingPlanTeamMockServer = null;
  }
  if (codingPlanDataPlaneProxy) {
    await codingPlanDataPlaneProxy.stop();
    codingPlanDataPlaneProxy = null;
  }
  // Bugfix：不能无条件删除共享 env。beforeSession 里 budget/catalog mock 先于本函数
  // 注入的 ZCODE_BASE_URL 等会被误删，导致那些 spec 的 Electron 打真实域名。
  // 只清除“当前值仍指向本 mock”的键：既撤掉 runnerEnv 播种到非 team worker 的污染，
  // 又不碰其他 mock 家族刚写入的值。
  const ownedBaseUrl =
    codingPlanTeamMockBaseUrl || process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim() || "";
  codingPlanTeamMockBaseUrl = "";
  if (!ownedBaseUrl) {
    return;
  }
  clearCodingPlanTeamMockEnv(process.env, ownedBaseUrl);
}

const HIGHSPEED_DATA_PLANE_FIXTURE_PATHS = [
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-timeout.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-miss.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-fallback-unlocks-model.json",
  "test/e2e/fixtures/upstream/auth-config/highspeed-owner-ui-race.json",
];

async function readDataPlaneTurnFixtures(path: string): Promise<DataPlaneTurnFixture[]> {
  return (
    JSON.parse(await readFile(resolve(DESKTOP_DIR, path), "utf8")) as {
      fixtures: DataPlaneTurnFixture[];
    }
  ).fixtures;
}

async function startCodingPlanDataPlaneProxy(specs: readonly string[]) {
  // 数据面按当前 worker 启动；混合批次中的 ToolSearch 不影响其他账号用例。
  if (!shouldPrepareCodingPlanTeamMock(specs)) return;
  // ToolSearch 的多轮应答使用主 capture proxy，避免两个代理覆盖同一网络设置。
  if (specs.some((spec) => spec.includes("conversation-session-toolsearch"))) return;
  if (codingPlanDataPlaneProxy) {
    for (const [key, value] of Object.entries(codingPlanDataPlaneProxy.env)) {
      process.env[key] = value;
    }
    return;
  }
  const startIndependentFixtures = specs.some((spec) =>
    spec.includes("conversation-session-start-plan-independent.test.ts"),
  )
    ? await readDataPlaneTurnFixtures(
        "test/e2e/fixtures/upstream/conversation-session/conversation-session-start-plan-independent.json",
      )
    : null;
  // Highspeed 抽卡 case 的每轮请求都走 Team Coding Plan 内建 HTTPS Endpoint（spec §7）；
  // 静态 body 无法区分轮次，多轮 case 会在首轮就误判完成，必须按轮次标记回放。
  const highspeedFixtures = specs.some(
    (spec) =>
      spec.includes("conversation-session-highspeed-card") ||
      spec.includes("highspeed-owner-ui-race.test.ts"),
  )
    ? (
        await Promise.all(
          HIGHSPEED_DATA_PLANE_FIXTURE_PATHS.map((path) => readDataPlaneTurnFixtures(path)),
        )
      ).flat()
    : null;
  codingPlanDataPlaneProxy = await startE2ENetworkCaptureProxy({
    artifactPath: CODING_PLAN_DATA_PLANE_ARTIFACT_PATH,
    caDir: E2E_CODING_PLAN_DATA_PLANE_CA_DIR,
    // SR87 直接取首条正文会绕过 matcher，把标题也返回为主请求 SSE；与受控流共用真实回放入口。
    requestRedirects: specs.some(
      (spec) =>
        spec.includes("conversation-session-highspeed-queue-edit.test.ts") ||
        spec.includes("conversation-session-model-provider-effective-selection.test.ts"),
    )
      ? [
          {
            host: "open.bigmodel.cn",
            path: "/api/anthropic/v1/messages",
            targetUrl: `${upstreamE2EBaseUrl}/messages`,
          },
        ]
      : [],
    responseMocks: [
      // 签名默认开启后，Account 用例的测试凭据也会发起握手；本地响应避免访问线上。
      {
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/paas/c1f3a7e2/v2/client",
        body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
      },
      ...(startIndependentFixtures
        ? [
            {
              host: "start154-e2e.invalid",
              method: "POST",
              path: "/v1/messages",
              ...createCodingPlanDataPlaneResponse(startIndependentFixtures, {
                fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
                title: { id: "start154-title", text: "Start154 checks" },
              }),
            },
          ]
        : []),
      {
        ...(highspeedFixtures
          ? createCodingPlanDataPlaneResponse(highspeedFixtures, {
              fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
              title: { id: "highspeed-title", text: '{"title":"Highspeed draw"}' },
            })
          : codingPlanDefaultDataPlaneResponse),
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/anthropic/v1/messages",
      },
    ],
  });
  for (const [key, value] of Object.entries(codingPlanDataPlaneProxy.env)) {
    process.env[key] = value;
  }
}

async function readRequestJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveRead) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveRead());
  });
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function writeJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function startUpstreamCaptureProxy(specs: readonly string[]) {
  const toolSearchFixture = specs.some((spec) => spec.includes("conversation-session-toolsearch"));
  if (!toolSearchFixture) assertUpstreamCaptureConfig();
  const toolSearchSpec = specs.find((spec) => spec.includes("conversation-session-toolsearch"));
  const toolSearchResponses = toolSearchSpec
    ? await loadToolSearchResponses(
        toolSearchSpec
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)!
          .replace(/\.test\.ts$/, ""),
      )
    : undefined;
  const apiKey = toolSearchFixture ? E2E_PROVIDER_REPLAY_API_KEY : readE2EProviderApiKey();
  const responseMocks = requestSecurityCaptureMocks(process.env, e2eProviderPresetName);
  upstreamCaptureProxy = await startE2ENetworkCaptureProxy({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    // Bugfix: beforeSession 会在启动 capture proxy 后重置 .e2e-home；
    // CA 若放在 .e2e-home 下会被删掉，agent 随后读取 ZCODE_AGENT_CA_CERT 就会 ENOENT。
    caDir: E2E_NETWORK_CAPTURE_CA_DIR,
    recordResponseChunkTimeline: true,
    responseChunkTimelineLimitBytes: UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES,
    responsePreviewLimitBytes: UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES,
    responseMocks: toolSearchFixture
      ? [
          ...(responseMocks ?? []),
          // 签名默认开启后，ToolSearch 的假凭据也会握手；与 Account 用例共用本地失败响应边界。
          {
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/paas/c1f3a7e2/v2/client",
            body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
          },
          {
            body: (body) =>
              toolSearchResponses!.get(
                toolSearchResponseStage(JSON.parse(body) as ToolSearchRequest),
              ).response.body,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/anthropic/v1/messages",
          },
        ]
      : responseMocks,
  });
  process.env.E2E_PROVIDER_API_KEY = apiKey;
  upstreamE2EBaseUrl = e2eProviderPreset.baseUrl;

  // 修复原因：capture 模式用于更新固定 fixture，需要真实上游响应和请求抓包；
  // 默认 replay 模式不会走这里，避免固定回归受网络、余额、限流影响。
  for (const [key, value] of Object.entries(upstreamCaptureProxy.env)) {
    process.env[key] = value;
  }
  process.env.E2E_PROVIDER_CAPTURE_MODE = "capture";
  process.env.E2E_PROVIDER_CAPTURE_PATH = upstreamCaptureProxy.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = upstreamCaptureProxy.proxyUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = e2eProviderPreset.expectedHost;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = e2eProviderPreset.expectedProtocol;
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = e2eProviderPreset.baseUrl;
  recordRequestSecurityCaptureMode(process.env, Boolean(responseMocks));
  writeUpstreamE2ERuntimeFile("capture", e2eProviderPreset.baseUrl);
}

function writeUpstreamE2ERuntimeFile(mode: "capture" | "replay", baseUrl: string) {
  // 修复原因：WDIO hook 内设置的 env 不一定能被所有 spec 代码稳定读取；
  // 用 runtime 文件暴露本轮代理地址，避免自定义 provider case 误读旧 CLI config 端口。
  mkdirSync(E2E_NETWORK_CAPTURE_DIR, { recursive: true });
  writeFileSync(
    E2E_PROVIDER_RUNTIME_FILE,
    JSON.stringify(
      {
        artifactPath: process.env.E2E_PROVIDER_CAPTURE_PATH ?? "",
        baseUrl,
        mode,
      },
      null,
      2,
    ),
  );
}

async function stopUpstreamE2EHttp() {
  if (!upstreamCaptureProxy) {
    if (upstreamReplayServer) {
      await upstreamReplayServer.stop();
      upstreamReplayServer = null;
    }
    return;
  }
  await upstreamCaptureProxy.stop();
  upstreamCaptureProxy = null;
  if (upstreamReplayServer) {
    await upstreamReplayServer.stop();
    upstreamReplayServer = null;
  }
}

async function startCodingPlanUpgradeE2EMock(
  specs: string[] = [],
  options: { prepareForBuild?: boolean } = {},
) {
  const resolvedScenario = resolveCodingPlanUpgradeMockScenario(specs);
  const scenario =
    resolvedScenario ??
    (options.prepareForBuild && shouldPrepareCodingPlanUpgradeMockForBuild(specs)
      ? "webview-refresh-provider"
      : null);
  if (!scenario) {
    await stopCodingPlanUpgradeE2EMock();
    return;
  }
  const preparedBaseUrl = process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
  const mockOptions = { marketingTouch: specs.some((spec) => spec.includes("marketing-touch-")) };
  if (!codingPlanUpgradeMockServer && preparedBaseUrl) {
    await resetCodingPlanUpgradeMockServer(preparedBaseUrl, scenario, mockOptions);
    applyCodingPlanUpgradeMockEnv(process.env, preparedBaseUrl);
    return;
  }
  if (codingPlanUpgradeMockServer) {
    await resetCodingPlanUpgradeMockServer(
      codingPlanUpgradeMockServer.baseUrl,
      scenario,
      mockOptions,
    );
    applyCodingPlanUpgradeMockEnv(process.env, codingPlanUpgradeMockServer.baseUrl);
    return;
  }
  codingPlanUpgradeMockServer = await startCodingPlanUpgradeMockServer(scenario, mockOptions);
  process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] = codingPlanUpgradeMockServer.baseUrl;
  applyCodingPlanUpgradeMockEnv(process.env, codingPlanUpgradeMockServer.baseUrl);
}

// 闲时任务 E2E：off-peak spec 命中时开进程内 mock 网关（ZCODE_OFFPEAK_MOCK=1），
// host 继承 worker env 后自动起网关、灰度强制开启；管理类 GUI spec 保持票据短暂 queued，
// 避免创建落库唤醒 scheduler 后在 UI 来得及操作前就派发模型请求。
async function startOffPeakE2EMock(specs: string[] = []): Promise<void> {
  const isOffPeakSpec = specs.some((spec) => spec.includes("off-peak") || spec.includes("offpeak"));
  if (isOffPeakTeamPlanSpec(specs)) {
    delete process.env.ZCODE_OFFPEAK_MOCK;
    const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT);
    if (!port) throw new Error("Team 闲时 E2E 网关未由 launcher 准备");
    await materializeOffPeakMockZCodeBuiltinProviderConfig(port, "GLM-5.3");
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    return;
  }
  if (isOffPeakSpec) {
    process.env.ZCODE_OFFPEAK_MOCK = "1";
    process.env.ZCODE_OFFPEAK_MOCK_PORT = "45197";
    const isSubagentInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
    const isInvalidTicketSpec = isOffPeakInvalidTicketSpec(specs);
    // 管理类 case 延后 ready；OP10 必须真跑 scheduler→turn→child，因此取号即 ready。
    process.env.ZCODE_OFFPEAK_MOCK_READY_DELAY_MS =
      isSubagentInheritanceSpec || isInvalidTicketSpec ? "0" : "60000";
    process.env.ZCODE_OFFPEAK_MOCK_READY_TTL_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_ACTIVE_MS = "600000";
    process.env.ZCODE_OFFPEAK_MOCK_NEXT_POLL_S = "1";
    if (isSubagentInheritanceSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else if (isInvalidTicketSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "invalid-ticket";
    } else if (
      specs.some((spec) =>
        spec.includes("conversation-session-offpeak-create-existing-session.test.ts"),
      )
    ) {
      // 绑定会话复用已有固定文本响应，保留 queued 编辑窗口；capture 模式会继续
      // 转发上游，不适合作为此例的离线应答。fixture 只匹配一个 child marker，不创建子任务。
      process.env.ZCODE_OFFPEAK_MOCK_SCENARIO = "foreground-subagents";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    }
    // D39 回归 spec：专用 availability 返回 false + next_take_at，验证 renderer
    // 使用服务端快照提前置灰；其余 off-peak spec 保持 availability=true。
    const isLimitPreGateSpec = specs.some((spec) => spec.includes("off-peak-limit-pre-gate"));
    if (isLimitPreGateSpec) {
      process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS = "3600000";
    } else {
      delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    }
    await materializeOffPeakMockZCodeBuiltinProviderConfig(
      Number(process.env.ZCODE_OFFPEAK_MOCK_PORT),
      isSubagentInheritanceSpec ? "GLM-5.3" : "GLM-5.2",
    );
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  } else {
    delete process.env.ZCODE_OFFPEAK_MOCK;
    delete process.env.ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS;
    delete process.env.ZCODE_OFFPEAK_MOCK_PORT;
    delete process.env.ZCODE_OFFPEAK_MOCK_SCENARIO;
    if (INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    } else {
      delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    }
  }
}

async function materializeOffPeakMockZCodeBuiltinProviderConfig(
  port: number,
  modelId: string,
): Promise<void> {
  const sourcePath = resolve(REPO_ROOT, "config/provider/zcode-builtin.json");
  const document = JSON.parse(await readFile(sourcePath, "utf8")) as {
    config?: {
      providerConfigRules?: {
        providerRules?: Array<{
          providerId: string;
          config: { api?: { baseUrl?: string }; builtinModelIds?: string[] };
        }>;
      };
    };
  };
  const offPeakProviderIds = [
    "account:zai-offpeak-idle-plan",
    "account:bigmodel-offpeak-idle-plan",
  ];
  for (const providerId of offPeakProviderIds) {
    // Built-in 已收敛到规则列表；旧夹具读 providers 会在启动前报缺少 api。
    const offPeakProvider = document.config?.providerConfigRules?.providerRules?.find(
      (rule) => rule.providerId === providerId,
    )?.config;
    if (!offPeakProvider?.api) {
      throw new Error(`ZCode Built-in Config 缺少 ${providerId}.api`);
    }
    offPeakProvider.api.baseUrl = `http://127.0.0.1:${port}/api/v1/off-peak/anthropic`;
    // 原闲时 fixture 的单模型白名单应迁到当前 Built-in 输入，不能继续依赖已退役的
    // client-config models 字段；仅修改本次 E2E 隔离文件，生产名单不变。
    offPeakProvider.builtinModelIds = [modelId];
  }
  await mkdir(resolve(E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, ".."), {
    recursive: true,
  });
  await writeFile(
    E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

// Highspeed E2E 使用 Host 内置的确定性 transport；按 spec 注入场景，避免普通会话
// 在默认测试套件里意外抽到卡。该变量必须在 Electron 启动前设置，Host 才能装配 mock。
function configureHighspeedE2EMock(specs: string[] = []): void {
  const scenario = resolveHighspeedE2EMockScenario(specs);
  if (scenario) {
    process.env[HIGHSPEED_MOCK_SCENARIO_ENV] = scenario;
  } else {
    delete process.env[HIGHSPEED_MOCK_SCENARIO_ENV];
  }
}

async function stopCodingPlanUpgradeE2EMock() {
  const ownedBaseUrl =
    codingPlanUpgradeMockServer?.baseUrl ??
    process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim() ??
    "";
  if (!codingPlanUpgradeMockServer) {
    if (ownedBaseUrl) {
      clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
    }
    restoreE2EProviderEndpointEnv();
    return;
  }
  await codingPlanUpgradeMockServer.stop();
  codingPlanUpgradeMockServer = null;
  clearCodingPlanUpgradeMockEnv(process.env, ownedBaseUrl);
  restoreE2EProviderEndpointEnv();
}

function restoreE2EProviderEndpointEnv() {
  const endpointEnv = getE2EProviderEndpointEnv(
    configuredE2ESpecs,
    e2eProviderPresetName,
    upstreamE2EHttpMode,
  );
  if (Object.keys(endpointEnv).length > 0) {
    // 修复原因：每轮 beforeSession 都会执行 mock 清理；请求安全 capture 与 live-team
    // 的生产控制面选择必须恢复，否则生产凭据会被送到测试域。
    Object.assign(process.env, endpointEnv);
    return;
  }
  restoreRequestSecurityEndpointEnv(process.env, e2eProviderPresetName, upstreamE2EHttpMode);
}

async function startModelContextBudgetConfigE2EMock(specs: string[] = []) {
  const scenario = resolveModelContextBudgetConfigMockScenario(specs);
  if (!scenario) {
    await stopModelContextBudgetConfigE2EMock();
    return;
  }
  if (modelContextBudgetConfigMockServer?.scenario !== scenario) {
    await stopModelContextBudgetConfigE2EMock();
    modelContextBudgetConfigMockServer = await startModelContextBudgetConfigMockServer(scenario);
  }
  process.env.ZCODE_BASE_URL = modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_TEST_BASE_URL = modelContextBudgetConfigMockServer.baseUrl;
  process.env.ZCODE_ENDPOINT_ORIGIN = modelContextBudgetConfigMockServer.baseUrl;
}

async function stopModelContextBudgetConfigE2EMock() {
  if (!modelContextBudgetConfigMockServer) {
    return;
  }
  await modelContextBudgetConfigMockServer.stop();
  modelContextBudgetConfigMockServer = null;
  delete process.env.ZCODE_BASE_URL;
  delete process.env.ZCODE_TEST_BASE_URL;
  delete process.env.ZCODE_ENDPOINT_ORIGIN;
}

async function startDynamicWorkflowConfigE2EMock(specs: string[] = []) {
  const scenario = resolveDynamicWorkflowConfigMockScenario(specs);
  if (!scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    return;
  }
  if (dynamicWorkflowConfigMockServer?.scenario !== scenario) {
    await stopDynamicWorkflowConfigE2EMock();
    dynamicWorkflowConfigMockServer = await startDynamicWorkflowConfigMockServer(scenario);
  }
  applyDynamicWorkflowConfigMockEnv(process.env, dynamicWorkflowConfigMockServer.baseUrl);
}

async function stopDynamicWorkflowConfigE2EMock() {
  if (!dynamicWorkflowConfigMockServer) {
    return;
  }
  const baseUrl = dynamicWorkflowConfigMockServer.baseUrl;
  await dynamicWorkflowConfigMockServer.stop();
  dynamicWorkflowConfigMockServer = null;
  clearDynamicWorkflowConfigMockEnv(process.env, baseUrl);
}

async function startClientScenesE2EMockIfNeeded(specs: string[] = []) {
  if (!shouldUseClientScenesMock(specs)) {
    await stopClientScenesE2EMock();
    return;
  }
  clientScenesMockServer ??= await startClientScenesMockServer();
  applyClientScenesMockEnv(process.env, clientScenesMockServer.baseUrl);
}

async function stopClientScenesE2EMock() {
  if (!clientScenesMockServer) {
    return;
  }
  const baseUrl = clientScenesMockServer.baseUrl;
  await clientScenesMockServer.stop();
  clientScenesMockServer = null;
  clearClientScenesMockEnv(process.env, baseUrl);
}

async function startPluginCdnZipFixtureIfNeeded(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  pluginCdnZipFixtureServer ??= await startPluginCdnZipFixtureServer(specs);
}

async function stopPluginCdnZipFixture() {
  await stopPluginCdnZipFixtureServer(pluginCdnZipFixtureServer ?? undefined);
  pluginCdnZipFixtureServer = null;
}

async function armCurrentElectronAppQuit(stage: string) {
  currentE2EElectronAppPid = null;
  try {
    const result = (await browser.electron.execute((electron) => {
      const currentAppPid = process.pid;
      const appName = electron.app.getName();
      if (appName !== "ZCode E2E") {
        return {
          appName,
          appPid: currentAppPid,
          armedWindowCount: 0,
        };
      }

      const appWindows = electron.BrowserWindow.getAllWindows();
      let quitRequested = false;
      const requestQuitAfterDriverClose = () => {
        if (quitRequested || electron.BrowserWindow.getAllWindows().length > 0) {
          return;
        }
        quitRequested = true;
        electron.app.quit();
      };

      // 修复原因：after 里直接 app.quit 会让 renderer 先于 ChromeDriver 的
      // deleteSession 消失，ChromeDriver 随后会对失效 browsing context 等待超时。
      // 这里只给当前进程、当前窗口挂一次性监听；由 deleteSession 先关闭窗口，
      // 再走 app.quit 的 before-quit 链路回收 host/agent。没有跨 session 的 timer。
      for (const appWindow of appWindows) {
        appWindow.once("closed", requestQuitAfterDriverClose);
      }
      return {
        appName,
        appPid: currentAppPid,
        armedWindowCount: appWindows.length,
      };
    })) as {
      appName?: string;
      appPid?: number;
      armedWindowCount?: number;
    };

    currentE2EElectronAppPid = typeof result.appPid === "number" ? result.appPid : null;
    if (!result.armedWindowCount) {
      writeE2ECleanupWarning(
        `${stage}: skip app quit barrier because current Electron app is ${result.appName ?? "unknown"} or has no windows`,
      );
      return;
    }
  } catch (error) {
    writeE2ECleanupWarning(`${stage}: app quit barrier failed: ${formatErrorMessage(error)}`);
  }
}

async function cleanupE2EElectronProcesses(
  stage: string,
  {
    requireExit = false,
    waitForGracefulExit = false,
  }: { requireExit?: boolean; waitForGracefulExit?: boolean } = {},
) {
  try {
    // 修复原因：after 已记录当前 Electron 主 PID；常规路径先按已知根进程等待/回收，
    // 避免每个 worker 在高并发下重复启动 PowerShell/CIM 扫描整机进程树。
    // 最后的 runId/HOME 扫描仍是严格屏障，会捕获主进程退出后遗留的 host/agent。
    let targetPids =
      currentE2EElectronAppPid !== null && isProcessAlive(currentE2EElectronAppPid)
        ? [currentE2EElectronAppPid]
        : listCurrentE2EProcessPids();
    if (waitForGracefulExit && targetPids.length > 0) {
      // 修复原因：app.quit 发出时 ChromeDriver 仍持有 session，主进程通常要到
      // deleteSession 后才能退出；afterSession 才是等待自然退出的正确屏障位置。
      await waitForProcessesExit(targetPids, E2E_ELECTRON_APP_QUIT_TIMEOUT_MS);
      targetPids = targetPids.filter((pid) => isProcessAlive(pid));
      if (targetPids.length === 0) {
        targetPids = listCurrentE2EProcessPids();
      }
    }
    if (targetPids.length === 0) {
      return;
    }

    writeE2ECleanupWarning(
      `${stage}: force terminating leftover Electron e2e pids=${targetPids.join(",")}`,
    );
    if (process.platform === "win32") {
      forceTerminateWindowsProcesses(targetPids);
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    } else {
      terminatePosixProcesses(targetPids, "SIGTERM");
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
      const remainingAfterTerm = targetPids.filter((pid) => isProcessAlive(pid));
      terminatePosixProcesses(remainingAfterTerm, "SIGKILL");
      await waitForProcessesExit(remainingAfterTerm, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    }

    const remainingPids = listCurrentE2EProcessPids();
    if (remainingPids.length > 0) {
      throw new Error(`E2E process exit barrier failed, remaining pids=${remainingPids.join(",")}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: leftover Electron cleanup failed: ${formatErrorMessage(error)}`,
    );
    if (requireExit) {
      throw error;
    }
  }
}

function listCurrentE2EProcessPids() {
  const detectedPids = listE2EProcessTreePids({
    chromiumProfileRootDir: E2E_CHROMIUM_USER_DATA_ROOT_DIR,
    homeDir: E2E_HOME_DIR,
    runId: E2E_RUN_ID,
  });
  if (
    currentE2EElectronAppPid !== null &&
    currentE2EElectronAppPid !== process.pid &&
    isProcessAlive(currentE2EElectronAppPid)
  ) {
    detectedPids.push(currentE2EElectronAppPid);
  }
  return [...new Set(detectedPids)];
}

async function cleanupE2EDirectory(stage: string, userDataDir: string, requireRemoved = false) {
  try {
    await rm(userDataDir, {
      force: true,
      maxRetries: process.platform === "win32" ? 3 : 1,
      recursive: true,
      retryDelay: 300,
    });
    if (existsSync(userDataDir)) {
      throw new Error(`E2E directory still exists: ${userDataDir}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: E2E directory cleanup failed (${userDataDir}): ${formatErrorMessage(error)}`,
    );
    if (requireRemoved) {
      throw error;
    }
  }
}

function forceTerminateWindowsProcesses(pids: number[]) {
  if (pids.length === 0) {
    return;
  }
  try {
    // 修复原因：目标集合包含同一 Electron 树的父子 PID；逐 PID 执行 `/T`
    // 会重复递归终止同一棵树，并在多 shard 下放大 taskkill 进程创建开销。
    execFileSync("taskkill", buildWindowsTaskkillArgs(pids), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    const alivePids = pids.filter((pid) => isProcessAlive(pid));
    if (alivePids.length > 0) {
      writeE2ECleanupWarning(
        `taskkill failed for pids=${alivePids.join(",")}: ${formatErrorMessage(error)}`,
      );
    }
  }
}

function terminatePosixProcesses(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (isProcessAliveError(error)) {
        writeE2ECleanupWarning(`${signal} failed for pid=${pid}: ${formatErrorMessage(error)}`);
      }
    }
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    await waitE2EDelay(100);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

async function runE2ERendererBridgePreflight(specs: string[] = []) {
  const attempt = await waitForE2ERendererBridgePreflight();
  if (!attempt.error) {
    return;
  }

  // Bug 根因：hook 内 reloadSession 不会先等待旧 Electron 进程树退出，旧 target 与
  // 新 session 会再次争用 ContextId。启动失败必须交给 worker/afterSession 完整清理。
  throw createE2ERendererBridgePreflightError(attempt.latest, specs, attempt.error, false);
}

async function waitForE2ERendererBridgePreflight(): Promise<{
  error: unknown | null;
  latest: E2ERendererBridgePreflightResult | null;
}> {
  let latest: E2ERendererBridgePreflightResult | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await inspectE2ERendererBridgePreflight();
        return latest.ok;
      },
      {
        interval: 250,
        timeout: E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS,
        timeoutMsg: "E2E renderer bridge preflight timed out",
      },
    );
    return { error: null, latest };
  } catch (error) {
    return { error, latest: latest as E2ERendererBridgePreflightResult | null };
  }
}

function createE2ERendererBridgePreflightError(
  lastResult: E2ERendererBridgePreflightResult | null,
  specs: string[],
  cause: unknown,
  recoveryAttempted: boolean,
): Error {
  return new Error(
    [
      "e2e-bridge-preflight infra failure",
      `reason=${lastResult?.reason ?? "unknown"}`,
      `url=${lastResult?.url ?? "unknown"}`,
      `readyState=${lastResult?.documentReadyState ?? "unknown"}`,
      `currentHandle=${lastResult?.currentHandle ?? "unknown"}`,
      `handles=${JSON.stringify(lastResult?.handles ?? [])}`,
      `candidateHandles=${JSON.stringify(lastResult?.candidateHandles ?? [])}`,
      `targets=${JSON.stringify(lastResult?.targets ?? [])}`,
      `missingBridgeMethods=${JSON.stringify(lastResult?.missingBridgeMethods ?? [])}`,
      `missingStateMethods=${JSON.stringify(lastResult?.missingStateMethods ?? [])}`,
      `recoveryAttempted=${recoveryAttempted}`,
      `specs=${JSON.stringify(specs)}`,
      `cause=${formatErrorMessage(cause)}`,
    ].join("; "),
  );
}

async function inspectE2ERendererBridgePreflight(): Promise<E2ERendererBridgePreflightResult> {
  const handles = await browser.getWindowHandles();
  const targets = await getE2EBrowserTargetInfo().catch(() => []);
  const candidates = collectE2EWebDriverPageHandleCandidates(handles, targets);
  const fallback: E2ERendererBridgePreflightResult = {
    bridgeMethods: {},
    candidateHandles: candidates.map((candidate) => candidate.handle),
    currentHandle: await browser.getWindowHandle().catch(() => null),
    documentReadyState: null,
    handle: null,
    handles,
    hasSessionBridge: false,
    missingBridgeMethods: E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS,
    missingStateMethods: E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS,
    ok: false,
    reason:
      handles.length === 0
        ? "renderer-handle-missing"
        : candidates.length === 0
          ? "renderer-page-handle-intersection-missing"
          : "renderer-url-missing",
    stateMethods: {},
    targets,
    url: null,
  };

  let latest = fallback;
  for (const candidate of candidates) {
    const handle = candidate.handle;
    try {
      await browser.switchToWindow(handle);
      const currentHandle = await browser.getWindowHandle().catch(() => null);
      if (currentHandle !== handle) {
        latest = {
          ...fallback,
          currentHandle,
          handle,
          reason: "renderer-handle-switch-mismatch",
        };
        continue;
      }
      const result = (await browser.execute(
        (requiredBridgeMethods, requiredStateMethods) => {
          const bridge = (
            window as typeof window & {
              __zcodeSessionStoreE2E?: Record<string, unknown> & {
                getState?: () => Record<string, unknown>;
                setState?: (...args: unknown[]) => unknown;
                subscribe?: (...args: unknown[]) => unknown;
              };
            }
          ).__zcodeSessionStoreE2E;
          const bridgeMethods = Object.fromEntries(
            requiredBridgeMethods.map((method) => [method, typeof bridge?.[method] === "function"]),
          ) as Record<string, boolean>;
          const missingBridgeMethods = requiredBridgeMethods.filter(
            (method) => !bridgeMethods[method],
          );
          const state =
            typeof bridge?.getState === "function"
              ? (() => {
                  try {
                    return bridge.getState?.() ?? null;
                  } catch {
                    return null;
                  }
                })()
              : null;
          const stateMethods = Object.fromEntries(
            requiredStateMethods.map((method) => [
              method,
              Boolean(state && typeof state[method] === "function"),
            ]),
          ) as Record<string, boolean>;
          const missingStateMethods = requiredStateMethods.filter(
            (method) => !stateMethods[method],
          );
          const url = window.location.href;
          const isRendererUrl = url.includes("/renderer/index.html");
          const hasSessionBridge = Boolean(bridge);
          const ok =
            isRendererUrl &&
            hasSessionBridge &&
            missingBridgeMethods.length === 0 &&
            missingStateMethods.length === 0;
          const reason = !isRendererUrl
            ? "renderer-url-missing"
            : !hasSessionBridge
              ? "session-bridge-missing"
              : missingBridgeMethods.length > 0
                ? "session-bridge-method-missing"
                : missingStateMethods.length > 0
                  ? "session-state-method-missing"
                  : "ok";

          return {
            bridgeMethods,
            documentReadyState: document.readyState,
            hasSessionBridge,
            missingBridgeMethods,
            missingStateMethods,
            ok,
            reason,
            stateMethods,
            url,
          };
        },
        E2E_RENDERER_BRIDGE_REQUIRED_BRIDGE_METHODS,
        E2E_RENDERER_BRIDGE_REQUIRED_STATE_METHODS,
      )) as Omit<
        E2ERendererBridgePreflightResult,
        "candidateHandles" | "currentHandle" | "handle" | "handles" | "targets"
      >;
      latest = {
        ...result,
        candidateHandles: fallback.candidateHandles,
        currentHandle,
        handle,
        handles,
        targets,
      };
      if (latest.ok || latest.url?.includes("/renderer/index.html")) {
        // 修复原因：electron service 的自动聚焦也读取该 handle；只有经过
        // ChromeDriver handle 表和实际 renderer URL 双重校验后才允许更新。
        (
          browser.electron as typeof browser.electron & {
            windowHandle?: string;
          }
        ).windowHandle = handle;
        return latest;
      }
    } catch (error) {
      latest = {
        ...fallback,
        handle,
        reason: `renderer-preflight-execute-failed:${formatErrorMessage(error)}`,
      };
    }
  }

  return latest;
}

async function getE2EBrowserTargetInfo(): Promise<E2EBrowserTargetInfo[]> {
  const puppeteer = await browser.getPuppeteer();
  return puppeteer.targets().map((target) => ({
    id: (target as unknown as { _targetId?: string })._targetId ?? null,
    type: target.type(),
    url: target.url(),
  }));
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isProcessAliveError(error);
  }
}

function isProcessAliveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code !== "ESRCH",
  );
}

function writeE2ECleanupWarning(message: string) {
  process.stderr.write(`[desktop-e2e-cleanup] ${message}\n`);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function armE2ERunnerExitWatchdog(exitCode: number) {
  if (e2eRunnerExitWatchdog) {
    clearTimeout(e2eRunnerExitWatchdog);
  }

  // 修复原因：Electron 和 replay server 都清理完后，WDIO CLI 仍可能被历史
  // handle 卡住，形成 conversation-session 这类孤儿进程；正常退出不会触发该兜底。
  e2eRunnerExitWatchdog = setTimeout(() => {
    writeE2ECleanupWarning(
      `onComplete: forcing WDIO runner exit after ${E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS}ms`,
    );
    process.exit(exitCode);
  }, E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS);
  e2eRunnerExitWatchdog.unref?.();
}

function forceFinalizeE2ERunnerFromGuard() {
  writeE2ECleanupWarning(
    `finalization guard: onComplete did not start within ${E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS}ms`,
  );
  try {
    // Bug 根因：历史 full run 在 122 个 worker 结束后静默退出 0，onComplete 没有
    // 写 summary。guard 超时先同步保全已有 NDJSON 的失败汇总，再做 best-effort 清理。
    e2eReporter.writeSummary(1);
  } catch (error) {
    writeE2ECleanupWarning(
      `finalization guard: summary recovery failed: ${formatErrorMessage(error)}`,
    );
  }
  armE2ERunnerExitWatchdog(1);

  const cleanupKeepAlive = setInterval(() => {}, 1000);
  void (async () => {
    try {
      await stopUpstreamE2EHttp();
      await stopCodingPlanTeamMock();
      await stopCodingPlanUpgradeE2EMock();
      await stopRequestSecurityFixture();
      await stopModelContextBudgetConfigE2EMock();
      await stopDynamicWorkflowConfigE2EMock();
      await stopPluginCdnZipFixture();
      await cleanupE2EElectronProcesses("finalization-guard");
      // 失败保留诊断现场（同 onComplete-home 条件）：guard 路径本身就是失败收尾。
      if (process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
        console.warn(`[e2e] finalization guard keeping failure home: ${E2E_HOME_DIR}`);
      } else {
        await cleanupE2EDirectory("finalization-guard-home", E2E_HOME_DIR);
      }
      await cleanupE2EDirectory("finalization-guard-cache", E2E_RUN_CACHE_DIR);
    } catch (error) {
      writeE2ECleanupWarning(
        `finalization guard: emergency cleanup failed: ${formatErrorMessage(error)}`,
      );
    } finally {
      clearInterval(cleanupKeepAlive);
      process.exit(1);
    }
  })();
}

async function resetE2EHome(specs: string[] = []) {
  await removeE2EHomeWithRetry();
  mkdirSync(E2E_HOME_DIR, { recursive: true });
  // 先拷官方插件缓存，再写各 spec 的 fixture，避免覆盖 fixture 自己写入的插件状态。
  await installOfficialPluginCacheTemplate({
    homeDir: E2E_HOME_DIR,
    templateHome: E2E_OFFICIAL_PLUGIN_CACHE_TEMPLATE_HOME,
  });
  seedE2EStartupState(specs);
  await seedRemoteOnboardingFixture({
    // 营销弹窗会抢占首次引导的焦点；该套件从已完成引导的账号开始，独立验证弹窗交付。
    enabled:
      process.env.ZCODE_E2E_REMOTE_PROFILE === "1" ||
      specs.some((spec) => spec.endsWith("ui-shell/marketing/marketing-touch-delivery.test.ts")),
    specs,
    appConfigDir: E2E_APP_CONFIG_DIR,
    userId: E2E_USER_PROFILE.id,
  });
  if (workerSpecsContain(specs, PROJECT_UPGRADE_ORDER_SPEC)) {
    await seedProjectUpgradeOrderFixture(E2E_HOME_DIR, E2E_APP_SETTINGS_FILE);
  }
  if (specs.some((spec) => spec.endsWith("sidebar-rich-content-performance.test.ts"))) {
    await seedSidebarRichContentFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (usesProviderReadinessColdStartFixture(specs) || usesGitReviewEntryFixture(specs)) {
    // SP13 必须在 Host 打开 tasks-index 前同时预置真实 task row 与可打开的
    // CLI session；测试内临时注入会绕过 Header 与 status panel 的真实 task/service 解析链路。
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (usesTaskIndexRowAuthorityFixture(specs)) {
    // Bug 根因：TSL23 必须在 Host 打开 tasks-index 前制造“持久行多于 session 摘要”的冷启动状态；
    // spec 的 before hook 已经太晚，因此只对该 case 在 beforeSession 的隔离 HOME 中落盘。
    await seedTaskIndexRowAuthorityFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes(TASK_TITLE_MARQUEE_SPEC))) {
    await seedTaskTitleMarqueeFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes("usage-stats-app-usage.test.ts"))) {
    await seedAppUsageE2EFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  seedE2EWorkerModelStreamConfig(specs);
  await seedE2EModelConfig(specs);
  seedE2EPluginCdnZipMarketplace(specs);
  seedE2EPluginMcpSkillInstalledPlugins(specs);
  seedE2EPluginMcpSkillState(specs);
  await seedE2EWorkspacePluginState(specs);
  await seedE2EBuiltinWorkspacePluginDisable(specs);
  seedE2EBuiltInSubagentModelOverrides(specs);
  seedE2ESubagentProfiles(specs);
  await seedE2EGitReviewEntryWorkspace(specs);
  seedE2EGitCommitDialogWorkspace(specs);
  if (
    specs.some((spec) => /conversation-session-history-first(?:-migration)?\.test\.ts$/.test(spec))
  ) {
    await seedSessionHistoryFirstFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
      providerId: e2eProviderPreset.providerId,
      modelId: e2eProviderPreset.model,
      thoughtLevel: readE2EThoughtLevel(),
      legacyTitleHandoff: specs.some((spec) =>
        spec.endsWith("conversation-session-history-first-migration.test.ts"),
      ),
    });
  }
  if (specs.some((spec) => spec.includes(HOOKS_LIFECYCLE_SPEC))) {
    // Bug 根因：spec 的 before hook 运行时 app-server 已经读取过 workspace config；
    // 测试内再写 Hooks 只能改变设置页，无法改变本轮 agent runtime。case-local fixture
    // 必须在 beforeSession 的干净 HOME 阶段落盘，确保首个 agent 进程冷启动即加载。
    await installHooksLifecycleFixture();
  }
  if (workerSpecsContain(specs, "conversation-session-stop-tool-results.test.ts")) {
    // Stop 复现的 Hook 必须在 app-server 首次读配置前落盘；spec.before 已晚于预热。
    await installStopToolResultsFixture();
  }
  if (specs.some((spec) => spec.includes(HOOK_TRUST_SPEC))) {
    // 同上：workspace 级 hook trust fixture 必须在首个 agent 进程冷启动前落盘，
    // 否则 SessionStart 软门禁不会在首轮 turn 生效（HK05 的 pending banner 前提）。
    await installHookTrustFixture();
  }
}

async function removeE2EHomeWithRetry() {
  for (let attempt = 0; attempt <= E2E_HOME_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rm(E2E_HOME_DIR, {
        force: true,
        maxRetries: process.platform === "win32" ? 3 : 1,
        recursive: true,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === E2E_HOME_REMOVE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      // 修复原因：Windows 会短暂保留 SQLite WAL/SHM 文件句柄；先兜底清掉遗留 Electron/host，
      // 再退避重试，避免 beforeSession 因上一轮 app 退出慢而重置失败。
      await cleanupE2EElectronProcesses(`beforeSession-remove-home-attempt-${attempt + 1}`);
      await waitE2EDelay(E2E_HOME_REMOVE_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

function isRetryableRemoveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String((error as { code?: unknown }).code)),
  );
}

function seedE2EPluginCdnZipMarketplace(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  if (!pluginCdnZipFixtureServer) {
    throw new Error("Plugin CDN zip fixture server must start before seeding marketplace");
  }
  seedPluginCdnZipMarketplaceFixture({
    e2eHomeDir: E2E_HOME_DIR,
    server: pluginCdnZipFixtureServer,
    lastUpdated: resolvePluginCdnZipMarketplaceLastUpdated(specs),
    localCatalog: specs.some((spec) => spec.includes("agent-plugin-discovery.test.ts")),
  });
}

// 把插件 MCP skill lifecycle spec 需要的 installed_plugins.json 写到
// `~/.zcode/cli/plugins/installed_plugins.json`；仅在 spec 命中且 state != not-installed
// 时执行。注意 storageRoot 在 agent 视角是 `<home>/.zcode`，而 pluginStorageRoot
// 是 `<home>/.zcode/cli/plugins`，installed_plugins.json 必须落在后者下面才会被
// bootstrap 的 `listInstalledPluginRecords(pluginStorageRoot)` 读到（见
// `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:347`）。
function seedE2EPluginMcpSkillInstalledPlugins(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state || state === "not-installed" || state === "workspace-root") return;
  const templateName =
    state === "installed-enabled"
      ? "installed-plugins.enabled.template.json"
      : "installed-plugins.disabled.template.json";
  const fixturePath = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill", templateName);
  const pluginRoot = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping");
  // 修复原因：Windows 路径的反斜杠直接拼进 JSON 字符串会成为非法转义（如 `\U`），
  // installed_plugins.json 解析失败后插件安装记录整体丢失；必须按 JSON 字符串编码替换。
  const template = readFileSync(fixturePath, "utf-8").replaceAll(
    '"__INSTALL_PATH__"',
    JSON.stringify(pluginRoot),
  );
  // pluginStorageRoot = <home>/.zcode/cli/plugins
  const targetDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(resolve(targetDir, "installed_plugins.json"), template, "utf-8");
}

function shouldSeedGitCommitDialogWorkspace(specs: string[] = []) {
  return specs.some((spec) => spec.includes(GIT_COMMIT_DIALOG_UI_FLOW_SPEC));
}

function seedE2EGitCommitDialogWorkspace(specs: string[] = []) {
  if (!shouldSeedGitCommitDialogWorkspace(specs)) {
    return;
  }

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  mkdirSync(resolve(workspacePath, "src"), { recursive: true });
  writeFileSync(resolve(workspacePath, "README.md"), "Git commit dialog E2E workspace\n", "utf-8");
  runGitE2ECommand(workspacePath, ["init"]);
  runGitE2ECommand(workspacePath, ["checkout", "-B", "main"]);
  runGitE2ECommand(workspacePath, ["config", "user.name", "ZCode E2E"]);
  runGitE2ECommand(workspacePath, ["config", "user.email", "zcode-e2e@example.com"]);
  runGitE2ECommand(workspacePath, ["add", "README.md"]);
  runGitE2ECommand(workspacePath, ["commit", "-m", "chore: seed git commit dialog e2e"]);
  runGitE2ECommand(workspacePath, ["branch", "e2e-target"]);

  writeFileSync(
    resolve(workspacePath, "src/staged-file.ts"),
    "export const stagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  writeFileSync(
    resolve(workspacePath, "src/unstaged-file.ts"),
    "export const unstagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  runGitE2ECommand(workspacePath, ["add", "src/staged-file.ts"]);
}

function runGitE2ECommand(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: process.env,
    stdio: "ignore",
  });
}

function seedE2EStartupState(specs: string[] = []) {
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  const useFreshConversationWorkspace = specs.some((spec) =>
    spec.includes("conversation-session-conversation-workspace.test.ts"),
  );
  const legacyDefaultProjectPath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const agentWarmupFixture = AGENT_WARMUP_FIXTURE_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  );
  const agentWarmupScenario = SMALL_AGENT_WARMUP_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  )
    ? SMALL_AGENT_WARMUP_SCENARIO
    : PASSIVE_AGENT_STARTUP_SCENARIO;
  const modelProviderRegressionFixture = workerSpecsContain(
    specs,
    MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
  );
  const passiveWorkspacePaths = agentWarmupFixture
    ? seedPassiveAgentStartupWorkspaces(E2E_HOME_DIR, agentWarmupScenario.workspaceCount)
    : [];
  if (modelProviderRegressionFixture) {
    // 模型回归缺口 spec 既需要 dormant workspace 切换，也需要 legacy 默认工作区
    // 供 provider/replay helper 初始化；两者都放进同一份 lastWorkspaceSession，避免
    // 测试直接绕过用户可见的侧栏入口注入 workspace。
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  if (!useFreshConversationWorkspace && !agentWarmupFixture) {
    // 既有 E2E 大量以一个已打开项目为前置；产品首次启动已改为 conversation，
    // 测试基线显式 seed 项目会话，避免把“老 case 的 fixture”误当成新用户默认行为。
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  const now = Date.now();
  const codingPlanTeamSpec = shouldUseCodingPlanTeamMock(specs);
  const codingPlanUpgradeE2E = isCodingPlanUpgradeE2E(specs);
  const oauthCredentialRecoverySpec = isOAuthCredentialRecoverySpec(specs);
  const jwtExpiryReauthenticationSpec = isJwtExpiryReauthenticationSpec(specs);
  const subagentLoginCatalogStaleSpec = isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const providerReadinessColdStartFixture = usesProviderReadinessColdStartFixture(specs);
  const shouldUseBigmodelAuth = codingPlanTeamSpec || codingPlanUpgradeE2E;
  const authProviderId = shouldUseBigmodelAuth ? BIGMODEL_PROVIDER_ID : E2E_AUTH_PROVIDER_ID;
  writeFileSync(
    E2E_APP_SETTINGS_FILE,
    JSON.stringify(
      {
        providerFamilyDomain: shouldUseBigmodelAuth ? "bigmodel" : "zai",
        providerFamilyDomainMigrated: true,
        providerFamilyDomainUpdatedAt: now,
        ...(modelProviderRegressionFixture
          ? {
              recentProjects: [legacyDefaultProjectPath, ...passiveWorkspacePaths],
              lastWorkspaceSession: [legacyDefaultProjectPath, ...passiveWorkspacePaths].map(
                (workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                }),
              ),
              lastActiveTabIndex: 0,
            }
          : agentWarmupFixture
            ? {
                recentProjects: passiveWorkspacePaths,
                lastWorkspaceSession: passiveWorkspacePaths.map((workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                })),
                lastActiveTabIndex: agentWarmupScenario.activeWorkspaceIndex,
              }
            : !useFreshConversationWorkspace
              ? {
                  lastWorkspaceSession: [
                    {
                      kind: "local",
                      workspacePath: legacyDefaultProjectPath,
                      workspacePurpose: "project",
                    },
                  ],
                  lastActiveTabIndex: 0,
                }
              : {}),
        ...(shouldSeedGuideInteractionBehavior(specs)
          ? {
              // steer 相关复现需要从当前 worker 的初始 settings 进入 guide 模式；
              // 运行中再改 setting.json 会被 app 启动态写回覆盖，导致实际仍跑 queue。
              zcodeInteractionBehavior: "guide",
            }
          : {}),
        providerFamilyConnectionSelections: shouldUseBigmodelAuth
          ? { bigmodel: { kind: "individual-coding-plan" } }
          : {},
        ...(upstreamCaptureProxy
          ? {
              // 修复原因：agent 子进程只信任设置页显式代理配置，不读取
              // WDIO 进程里的标准 HTTPS_PROXY；capture 模式必须预设这里才能抓到真实请求。
              httpProxy: upstreamCaptureProxy.proxyUrl,
              httpProxyCaCertPath: upstreamCaptureProxy.caCertPath,
              httpProxyNoProxy: DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
            }
          : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    E2E_APP_CREDENTIALS_FILE,
    JSON.stringify(
      // 原因：匿名回调失败用例不需要假 JWT；401 过期确认层会遮挡被测登录入口。
      providerReadinessColdStartFixture ||
        workerSpecsContain(specs, "oauth-login-failure-cancel.test.ts")
        ? {}
        : // Bug 根因：I20 不验证账号登录，却播种假 ZCode JWT；带账号身份的旁路请求
          // 会把它发往真实控制面，401 随后弹出登录过期对话框并遮挡目标交互。
          // 该 case 只保留本地 Provider 回放，不注入无关账号身份。
          builtInSubagentModelOverridesSpec
          ? {}
          : subagentLoginCatalogStaleSpec
            ? {}
            : oauthCredentialRecoverySpec
              ? createCorruptOAuthCredentialSeed(authProviderId)
              : jwtExpiryReauthenticationSpec
                ? createExpiredJwtOAuthCredentialSeed(authProviderId)
                : createE2EStartupCredentialSeed({
                    specs,
                    accountMock: codingPlanTeamSpec || codingPlanUpgradeE2E,
                    remoteProfile: process.env.ZCODE_E2E_REMOTE_PROFILE === "1",
                    legacyAuthToken: E2E_AUTH_TOKEN,
                    restoredOAuthCredentials: {
                      "oauth:active_provider": authProviderId,
                      // 账号 mock 只覆盖选定族；夹带另一个假账号会访问未接管的真实控制面。
                      [`oauth:${authProviderId}:access_token`]: shouldUseBigmodelAuth
                        ? "e2e-bigmodel-oauth-token"
                        : E2E_AUTH_TOKEN,
                      [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
                      zcodejwttoken: E2E_AUTH_TOKEN,
                    },
                  }),
      null,
      2,
    ),
    "utf-8",
  );
  if (workerSpecsContain(specs, "credential-store-recovery.test.ts")) {
    // 容器恢复专项只能在隔离 HOME 注入损坏字节，不能复用真实用户凭据。
    writeFileSync(E2E_APP_CREDENTIALS_FILE, '{"bot:fixture":"synthetic",', "utf8");
  }
}

function isOAuthCredentialRecoverySpec(specs: string[] = []) {
  return (
    workerSpecsContain(specs, OAUTH_CREDENTIAL_RECOVERY_SPEC) ||
    workerSpecsContain(specs, "credential-store-recovery.test.ts")
  );
}

function isJwtExpiryReauthenticationSpec(specs: string[] = []) {
  return workerSpecsContain(specs, JWT_EXPIRY_REAUTHENTICATION_SPEC);
}

function isSubagentCodingPlanLoginCatalogStaleSpec(specs: string[] = []) {
  return workerSpecsContain(specs, SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC);
}

function usesProviderReadinessColdStartFixture(specs: string[] = []) {
  return (
    workerSpecsContain(specs, PROVIDER_READINESS_AGENT_STARTUP_SPEC) ||
    workerSpecsContain(specs, WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC)
  );
}

function usesContextWindowColdResumeFixture(specs: string[] = []) {
  return workerSpecsContain(specs, CONTEXT_WINDOW_COLD_RESUME_SPEC);
}

function usesTaskIndexRowAuthorityFixture(specs: string[] = []) {
  return workerSpecsContain(specs, TASK_INDEX_ROW_AUTHORITY_SPEC);
}

function usesGitReviewEntryFixture(specs: string[] = []) {
  return workerSpecsContain(specs, GIT_REVIEW_ENTRY_SPEC);
}

async function seedE2EGitReviewEntryWorkspace(specs: string[] = []) {
  if (!usesGitReviewEntryFixture(specs)) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const caseRoot = resolve(workspacePath, ".zcode-e2e/conversation-session-git-review-entry");
  await mkdir(caseRoot, { recursive: true });
  await runGitReviewEntryCommand(workspacePath, ["init"]);
  await runGitReviewEntryCommand(workspacePath, ["checkout", "-B", "main"]);
  await writeFile(
    resolve(caseRoot, "status-panel-review.txt"),
    "status panel Git review e2e fixture\n",
    "utf8",
  );
}

async function runGitReviewEntryCommand(cwd: string, args: string[]) {
  await execFileAsync(process.env.ZCODE_GIT_BINARY?.trim() || "git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function createCorruptOAuthCredentialSeed(authProviderId: string): Record<string, string> {
  const corruptEncryptedValue = "enc:v1:bad.bad.bad";
  const corruptTokenProvider = process.env.ZCODE_E2E_CORRUPT_OAUTH_TOKEN_PROVIDER;
  if (corruptTokenProvider === BIGMODEL_PROVIDER_ID || corruptTokenProvider === ZAI_PROVIDER_ID) {
    // 业务 token 损坏曾绕过启动恢复的解密清理；共享 JWT 与资料正常才能隔离此路径。
    return {
      "oauth:active_provider": corruptTokenProvider,
      [`oauth:${corruptTokenProvider}:access_token`]: corruptEncryptedValue,
      [`oauth:${corruptTokenProvider}:refresh_token`]: "stale-refresh-token",
      [`oauth:${corruptTokenProvider}:user_info`]: JSON.stringify(
        corruptTokenProvider === ZAI_PROVIDER_ID
          ? { user_id: "e2e-user", name: "Fixture User" }
          : { id: "e2e-user", username: "Fixture User", displayName: "Fixture User" },
      ),
      zcodejwttoken: "e2e-valid-opaque-jwt",
      "bot:e2e:credential": "e2e-independent-bot-token",
    };
  }
  return {
    // Bugfix: 这个 spec 需要冷启动复现线上“密文存在但当前机器无法解密”的状态；
    // 只损坏 active provider 就足以触发 OAuth 会话清理，并验证用户仍能看到登录入口。
    "oauth:active_provider": corruptEncryptedValue,
    [`oauth:${authProviderId}:access_token`]: "stale-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "stale-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`]: "stale-bigmodel-access-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:refresh_token`]: "stale-bigmodel-refresh-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    zcodejwttoken: "stale-zcode-jwt-token",
    "bot:e2e:credential": "e2e-independent-bot-token",
  };
}

function createExpiredJwtOAuthCredentialSeed(authProviderId: string): Record<string, string> {
  return {
    "oauth:active_provider": authProviderId,
    [`oauth:${authProviderId}:access_token`]: "expired-session-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "expired-session-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    // Bug 回归 fixture：exp=1 明确早于任意测试运行时间；客户端只解析 exp，
    // 不验证这枚本地测试 JWT 的签名。
    zcodejwttoken: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjF9.e2e",
  };
}

function isCodingPlanUpgradeE2E(specs: string[] = []) {
  return resolveCodingPlanUpgradeMockScenario(specs) !== null;
}

function shouldSeedGuideInteractionBehavior(specs: string[] = []) {
  return specs.some(
    (arg) =>
      arg.includes("conversation-session-running-guide-steer.test.ts") ||
      arg.includes("conversation-session-background-guide-steer.test.ts"),
  );
}

// 插件 MCP skill 生命周期 spec 的 spec 名 → seed 状态映射。
// 状态 A 不写任何 plugin 记录；状态 B 装入并启用；状态 C 装入但通过
// `config.json#plugins.enabledPlugins[id] = false` 关闭。读取顺序：
// ZCODE_E2E_PLUGIN_MCP_SKILL_STATE 环境变量 > spec 文件名约定。
const PLUGIN_MCP_SKILL_SPEC_PATTERN =
  /conversation-session-plugin-mcp-skill-(not-installed|installed-enabled|installed-disabled|workspace-enabled|workspace-disabled|workspace-inherited|workspace-isolation|workspace-root|workspace-freeze)\.test\.ts/u;
const PLUGIN_MCP_SKILL_STATES = new Set([
  "not-installed",
  "installed-enabled",
  "installed-disabled",
  "workspace-enabled",
  "workspace-disabled",
  "workspace-inherited",
  "workspace-isolation",
  "workspace-root",
  "workspace-freeze",
]);

function resolvePluginMcpSkillState(
  specs: string[] = [],
):
  | "not-installed"
  | "installed-enabled"
  | "installed-disabled"
  | "workspace-enabled"
  | "workspace-disabled"
  | "workspace-inherited"
  | "workspace-isolation"
  | "workspace-root"
  | "workspace-freeze"
  | null {
  const envState = process.env.ZCODE_E2E_PLUGIN_MCP_SKILL_STATE?.trim();
  if (envState && PLUGIN_MCP_SKILL_STATES.has(envState)) {
    return envState as Exclude<ReturnType<typeof resolvePluginMcpSkillState>, null>;
  }
  for (const arg of specs) {
    if (arg.includes("conversation-session-plugin-resident-freeze-cold-resume.test.ts")) {
      return "workspace-freeze";
    }
    const match = arg.match(PLUGIN_MCP_SKILL_SPEC_PATTERN);
    if (match && match[1]) {
      return match[1] as
        | "not-installed"
        | "installed-enabled"
        | "installed-disabled"
        | "workspace-enabled"
        | "workspace-disabled"
        | "workspace-inherited"
        | "workspace-isolation"
        | "workspace-root"
        | "workspace-freeze";
    }
  }
  return null;
}

// 状态 A 不需要写任何文件；B/C 才落 fixture。
// 这一段必须在 `seedUpstreamE2EModelConfig` 之后调用，因为它要 patch
// 我们刚写好的 `~/.zcode/cli/config.json`，把 `plugins.enabledPlugins[id]`
// 置为 false 以表达"已安装但关闭"。
function seedE2EPluginMcpSkillState(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state || state === "not-installed" || state.startsWith("workspace-")) return;
  const configPath = resolve(E2E_CLI_CONFIG_DIR, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as { code?: string }).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const plugins = (config.plugins as Record<string, unknown> | undefined) ?? {};
  const enabledPlugins = (plugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const pluginId = "e2e-plugin-mcp-ping@e2e-fixture";
  // Bugfix: 安装型 plugin 在 candidate 构造时 defaultEnabled=false（见
  // apps/zcode-cli/packages/adapters/src/plugins/index.ts:resolveCandidates）；
  // resolveEnabled 用 `config.enabledPlugins[id] ?? defaultEnabled` 判定，
  // 所以 enabled 状态必须显式写 true，不能只 "delete 字段"。
  if (state === "installed-disabled") {
    enabledPlugins[pluginId] = false;
  } else {
    enabledPlugins[pluginId] = true;
  }
  plugins.enabledPlugins = enabledPlugins;
  config.plugins = plugins;
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// Provider Registry 不再写 CLI config；插件夹具必须显式创建自己的配置，不能依赖模型初始化副作用。
async function readOptionalE2ECliConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function seedE2EWorkspacePluginState(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state?.startsWith("workspace-")) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const userConfigPath = resolve(E2E_CLI_CONFIG_DIR, "config.json");
  const workspaceConfigPath = resolve(workspacePath, ".zcode", "config.json");
  const pluginId = "e2e-plugin-mcp-ping@e2e-fixture";
  const pluginRoot = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping");
  await mkdir(resolve(workspacePath, ".zcode"), { recursive: true });
  const userConfig = await readOptionalE2ECliConfig(userConfigPath);
  const userPlugins = (userConfig.plugins as Record<string, unknown> | undefined) ?? {};
  const userEnabledPlugins =
    (userPlugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const userOptions =
    (userPlugins.options as Record<string, Record<string, unknown>> | undefined) ?? {};
  userEnabledPlugins[pluginId] = state !== "workspace-isolation";
  userOptions[pluginId] = {
    label: "user-label",
    secret: "E2E_USER_PLUGIN_SECRET",
  };
  userPlugins.enabledPlugins = userEnabledPlugins;
  userPlugins.options = userOptions;
  userConfig.plugins = userPlugins;
  await mkdir(E2E_CLI_CONFIG_DIR, { recursive: true });
  await writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), "utf-8");

  const workspaceEnabledPlugins =
    state === "workspace-inherited"
      ? {}
      : {
          [pluginId]:
            state === "workspace-enabled" ||
            state === "workspace-isolation" ||
            state === "workspace-root" ||
            state === "workspace-freeze",
        };
  const workspaceDirs = state === "workspace-root" ? [pluginRoot] : undefined;
  await writeFile(
    workspaceConfigPath,
    JSON.stringify(
      {
        plugins: {
          ...(workspaceDirs ? { dirs: workspaceDirs } : {}),
          enabledPlugins: workspaceEnabledPlugins,
          options: {
            [pluginId]: {
              label: "workspace-label",
              secret: "E2E_WORKSPACE_PLUGIN_SECRET",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  if (state === "workspace-isolation") {
    await mkdir(resolve(E2E_HOME_DIR, "WorkspaceB"), { recursive: true });
  }
}

async function seedE2EBuiltinWorkspacePluginDisable(specs: string[] = []) {
  if (
    !specs.some((spec) =>
      spec.includes("conversation-session-plugin-builtin-workspace-disable.test.ts"),
    )
  ) {
    return;
  }

  const pluginId = "skill-creator@zcode-plugins-official";
  const workspaceA = resolve(E2E_HOME_DIR, "ZCodeProject");
  const workspaceB = resolve(E2E_HOME_DIR, "WorkspaceB");
  const userConfig = await readOptionalE2ECliConfig(E2E_CLI_CONFIG_FILE);
  const userPlugins = (userConfig.plugins as Record<string, unknown> | undefined) ?? {};
  const enabledPlugins = (userPlugins.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const options =
    (userPlugins.options as Record<string, Record<string, unknown>> | undefined) ?? {};
  enabledPlugins[pluginId] = true;
  options[pluginId] = { e2e: "preserve-user-option" };
  userPlugins.enabledPlugins = enabledPlugins;
  userPlugins.options = options;
  userConfig.plugins = userPlugins;
  await mkdir(E2E_CLI_CONFIG_DIR, { recursive: true });
  await writeFile(E2E_CLI_CONFIG_FILE, `${JSON.stringify(userConfig, null, 2)}\n`, "utf-8");

  await mkdir(resolve(workspaceA, ".zcode"), { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await writeFile(
    resolve(workspaceA, ".zcode", "config.json"),
    `${JSON.stringify(
      {
        plugins: {
          enabledPlugins: {
            [pluginId]: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const pluginDataDir = resolve(E2E_CLI_CONFIG_DIR, "plugins", "data", pluginId);
  await mkdir(pluginDataDir, { recursive: true });
  await writeFile(
    resolve(pluginDataDir, "state.json"),
    `${JSON.stringify({ marker: "preserve-user-data" }, null, 2)}\n`,
    "utf-8",
  );
}

async function seedE2EModelConfig(specs: string[] = []) {
  if (usesContextWindowColdResumeFixture(specs)) {
    await seedContextWindowColdResumeModelConfig();
    return;
  }
  await seedUpstreamE2EModelConfig(specs);
  await seedModelOutputTokenProviders(specs);
}

interface ModelOutputTokenProviderSeed {
  apiFormat?: "openai-chat-completions" | "openai-responses";
  id: string;
  kind?: "openai" | "openai-compatible";
  models: Array<{
    contextWindow: number;
    id: string;
    limitOutput?: number;
    maxOutputTokens?: number;
  }>;
  name: string;
  supportedFormat?: "openai" | "responses";
}

function seedE2EWorkerModelStreamConfig(specs: string[] = []) {
  const modelStreamIdleTimeoutMs = resolveE2EWorkerModelStreamIdleTimeoutMs(specs);
  if (modelStreamIdleTimeoutMs === undefined) return;
  mkdirSync(E2E_CLI_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_CLI_CONFIG_FILE,
    JSON.stringify({ modelStream: { idleTimeoutMs: modelStreamIdleTimeoutMs } }, null, 2),
    "utf-8",
  );
}

async function seedModelOutputTokenProviders(specs: string[] = []) {
  const providerSeeds: ModelOutputTokenProviderSeed[] = [];
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_BUDGET_SPEC))) {
    providerSeeds.push({
      id: "output-token-budget-e2e",
      models: [
        { contextWindow: 128_000, id: "otb-default" },
        { contextWindow: 128_000, id: "otb-16k", limitOutput: 16_000 },
        { contextWindow: 128_000, id: "otb-64k", maxOutputTokens: 64_000 },
        { contextWindow: 128_000, id: "otb-runtime-refresh" },
      ],
      name: "Output Token Budget E2E",
    });
  }
  if (specs.some((spec) => spec.includes(MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC))) {
    providerSeeds.push({
      id: "output-token-preflight-e2e",
      models: [
        {
          contextWindow: 128_000,
          id: "otb-preflight-64k",
          limitOutput: 64_000,
        },
        {
          contextWindow: 64_000,
          id: "otb-preflight-smoke-64k-48k",
          limitOutput: 48_000,
        },
        {
          contextWindow: 200_000,
          id: "otb-preflight-smoke-200k-128k",
          limitOutput: 128_000,
        },
      ],
      name: "Output Token Preflight E2E",
    });
  }
  if (specs.some((spec) => spec.includes(OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC))) {
    providerSeeds.push(
      {
        id: "otc-protocol-chat",
        models: [{ contextWindow: 128_000, id: "otc-protocol-chat" }],
        name: "OTC Chat Completions E2E",
      },
      {
        apiFormat: "openai-responses",
        id: "otc-protocol-responses",
        kind: "openai",
        models: [{ contextWindow: 128_000, id: "otc-protocol-responses" }],
        name: "OTC Responses API E2E",
        supportedFormat: "responses",
      },
    );
  }
  if (providerSeeds.length === 0) {
    return;
  }

  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("Output-token E2E 缺少可用 provider API Key");
  }
  const appProviders = providerSeeds.map(
    (provider): PersonalProviderConfigSeed => ({
      // OTC11 明确验证两种协议；不能把 Responses seed 再覆盖成 Chat Completions。
      apiFormat: provider.apiFormat ?? "openai-chat-completions",
      apiKey,
      baseURL: upstreamE2EBaseUrl,
      enabled: true,
      id: provider.id,
      label: provider.name,
      models: provider.models.map((model) => ({
        contextWindow: model.contextWindow,
        id: model.id,
        ...(model.maxOutputTokens === undefined && model.limitOutput === undefined
          ? {}
          : { maxOutputTokens: model.maxOutputTokens ?? model.limitOutput }),
      })),
    }),
  );
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
}

async function seedContextWindowColdResumeModelConfig() {
  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    throw new Error("context-window cold-resume 缺少可用 provider API Key");
  }
  const provider: PersonalProviderConfigSeed = {
    id: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    label: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_NAME,
    baseURL: upstreamE2EBaseUrl,
    apiFormat: "openai-chat-completions",
    apiKey,
    enabled: true,
    models: [
      {
        id: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
        contextWindow: CONTEXT_WINDOW_COLD_RESUME_MAX_TOKENS,
        maxOutputTokens: CONTEXT_WINDOW_COLD_RESUME_MAX_OUTPUT_TOKENS,
      },
    ],
  };
  await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: CONTEXT_WINDOW_COLD_RESUME_PROVIDER_ID,
    modelId: CONTEXT_WINDOW_COLD_RESUME_MODEL_ID,
  });
}

function isSubagentProviderRegistryColdStartSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC));
}

function isBuiltInSubagentModelSelectionOverridesSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC));
}

function isSettingsSubagentCreateEditPersistenceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC));
}

function isSubagentRuntimeCatalogReasoningSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC));
}

function isOffPeakSubagentModelInheritanceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC));
}

function isOffPeakInvalidTicketSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_INVALID_TICKET_SPEC));
}

function isModelProviderPlanSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(MODEL_PROVIDER_PLAN_SURFACE_SPEC));
}

function isToolErrorSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(TOOL_ERROR_SURFACE_SPEC));
}

function seedE2EBuiltInSubagentModelOverrides(specs: string[] = []) {
  const builtInModelSelectionOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const runtimeCatalogSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  const offPeakSubagentModelInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
  if (
    !builtInModelSelectionOverridesSpec &&
    !runtimeCatalogSpec &&
    !offPeakSubagentModelInheritanceSpec
  ) {
    return;
  }

  // Bug 根因：browser.reloadSession() 会再次触发 beforeSession。若这里无条件重写，
  // 测试刚通过设置页保存的 structured selection 会在冷启动前被初始 fixture 覆盖，
  // 使“冷恢复”实际验证的仍是 seed，而不是用户持久化结果。初始 HOME 为空时才落盘。
  if (existsSync(E2E_AGENTS_STATE_FILE)) {
    return;
  }

  const overrideSelection = runtimeCatalogSpec
    ? {
        providerId: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
        modelId: SUBAGENT_RUNTIME_CATALOG_MODEL,
      }
    : {
        providerId: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
        modelId: E2E_PROVIDER_SECONDARY_MODEL,
      };
  const initialGeneralPurposeSelection =
    runtimeCatalogSpec || offPeakSubagentModelInheritanceSpec
      ? overrideSelection
      : {
          providerId: e2eProviderPreset.providerId,
          modelId: e2eProviderPreset.model,
        };
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_AGENTS_STATE_FILE,
    JSON.stringify(
      {
        builtInModelSelectionOverrides: {
          Explore: {
            ...overrideSelection,
            ...(builtInModelSelectionOverridesSpec || runtimeCatalogSpec
              ? { options: { reasoningLevel: "invalid-e2e" } }
              : {}),
          },
          "general-purpose": {
            ...initialGeneralPurposeSelection,
            ...(runtimeCatalogSpec ? { options: { reasoningLevel: "high" } } : {}),
          },
        },
        disabledAgentIds: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function seedE2ESubagentProfiles(specs: string[] = []) {
  if (specs.some((spec) => spec.includes("conversation-session-subagent-cross-host.test.ts"))) {
    // 内置文档插件已拆分并固定模型；覆盖/清除覆盖场景使用自己的继承模型 fixture。
    const pluginDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      resolve(pluginDir, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "e2e-subagent-refresh@e2e-fixture",
            name: "e2e-subagent-refresh",
            marketplace: "e2e-fixture",
            version: "1.0.0",
            installPath: resolve(DESKTOP_DIR, "test/e2e/fixtures/subagent-refresh-plugin"),
            installedAt: "2026-09-18T00:00:00.000Z",
            updatedAt: "2026-09-18T00:00:00.000Z",
            scope: "user",
          },
        ],
      }),
    );
    const config = existsSync(E2E_CLI_CONFIG_FILE)
      ? JSON.parse(readFileSync(E2E_CLI_CONFIG_FILE, "utf8"))
      : {};
    config.plugins = {
      ...config.plugins,
      enabledPlugins: {
        ...config.plugins?.enabledPlugins,
        "e2e-subagent-refresh@e2e-fixture": true,
      },
    };
    writeFileSync(E2E_CLI_CONFIG_FILE, JSON.stringify(config));
  }
  const profileEntries: Array<{ content: string; name: string }> = [];

  if (isBuiltInSubagentModelSelectionOverridesSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_REASONING_AGENT_NAME,
      content: `---
name: ${SUBAGENT_REASONING_AGENT_NAME}
description: E2E custom subagent for reasoning effort persistence coverage.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E reasoning reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentRuntimeCatalogReasoningSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_RUNTIME_CATALOG_AGENT_NAME,
      content: `---
name: ${SUBAGENT_RUNTIME_CATALOG_AGENT_NAME}
description: E2E custom subagent for runtime reasoning catalog coverage.
model: custom:${SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID}:${SUBAGENT_RUNTIME_CATALOG_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E Claude catalog reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentProviderRegistryColdStartSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME,
      content: `---
name: ${SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME}
description: E2E subagent bound to an alternate provider for cold-start registry sync reproduction.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
thoughtLevel: high
tools: Read
maxTurns: 1
---
You are the E2E provider registry reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isOffPeakSubagentModelInheritanceSpec(specs)) {
    profileEntries.push(
      {
        name: "Code Search",
        content: `---
name: Code Search
description: E2E custom foreground subagent with an explicit alternate provider model.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
maxTurns: 1
---
You are the E2E Code Search reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Inherit Reviewer",
        content: `---
name: E2E OffPeak Inherit Reviewer
description: E2E custom foreground subagent that normally inherits the session model.
tools: Read
maxTurns: 1
---
You are the E2E inherited-model reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Background Reviewer",
        content: `---
name: E2E OffPeak Background Reviewer
description: E2E custom profile configured to run in the background.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
background: true
maxTurns: 1
---
This E2E profile must be rejected before any provider request during an idle-plan turn.
`,
      },
    );
  }

  if (isToolErrorSurfaceSpec(specs)) {
    profileEntries.push(
      {
        name: TOOL_ERROR_SURFACE_STALE_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_STALE_AGENT_NAME}
description: E2E subagent intentionally bound to a stale provider/model for tool error surface coverage.
model: custom:e2e-stale-provider:e2e-stale-model
tools: Read
maxTurns: 1
---
You are the stale E2E reviewer. This profile should fail before any child model request.
`,
      },
      {
        name: TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME}
description: E2E subagent used as the healthy sibling when another Agent tool fails.
tools: Read
maxTurns: 1
---
You are the healthy E2E reviewer. Reply only with the requested marker.
`,
      },
    );
  }

  if (specs.some((spec) => spec.includes(SUBAGENT_TEAM_SCOPE_SPEC))) {
    profileEntries.push({
      name: "e2e-team-scope-reviewer",
      content: `---
name: e2e-team-scope-reviewer
description: E2E custom subagent bound to a Team connection without organization/project scope.
model: custom:team-plan:e2e-missing-scope:team-model
tools: Read
maxTurns: 1
---
This child must fail before sending a provider request when the Team scope is unavailable.
`,
    });
  }

  if (profileEntries.length === 0) {
    return;
  }

  for (const agentsDir of [E2E_USER_AGENTS_DIR, E2E_CLI_AGENTS_DIR]) {
    // 修复原因：CLI runtime 从 storageRoot/agents 加载用户 subagent profile，
    // 而设置页/历史路径曾使用 .zcode/cli/agents。双写只作用于本复现 spec，
    // 避免路径差异让 case 停在 agent type not found，而不是 provider registry 缺失。
    mkdirSync(agentsDir, { recursive: true });
    for (const profile of profileEntries) {
      const profilePath = resolve(agentsDir, `${profile.name}.md`);
      // 同 agents-state：reloadSession 不能覆盖设置页已经保存的当前 Markdown。
      if (!existsSync(profilePath)) {
        writeFileSync(profilePath, profile.content, "utf-8");
      }
    }
  }
}

async function seedUpstreamE2EModelConfig(specs: string[] = []) {
  if (isOAuthCredentialRecoverySpec(specs) || usesProviderReadinessColdStartFixture(specs)) {
    // Bugfix: OAuth 凭据恢复及 provider-readiness 冷启动 fixture 必须保持
    // 无可用本地模型配置，避免默认 上游 回放 provider 绕过登录/执行门禁。
    return;
  }

  const apiKey =
    upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    return;
  }

  // 修复原因：固定 e2e 默认回放真实采集 fixture，capture 模式才访问线上
  // 上游；baseURL 必须在每个 session 重置前跟随当前 HTTP 模式写入配置。
  const anthropicBaseURL = buildUpstreamE2EAnthropicBaseUrl();
  const modelProviderListFilteringSpec = specs.some((spec) =>
    spec.includes("conversation-session-model-provider-list-filtering.test.ts"),
  );
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const settingsSubagentCreateEditPersistenceSpec =
    isSettingsSubagentCreateEditPersistenceSpec(specs);
  const exposeSubagentReasoningMetadata =
    // 模型配置隔离和 Edit/Fork 继承直接检查请求参数；空映射会吞掉所选档位。
    specs.some((spec) =>
      /conversation-session-(model-config|model-switch-tool-edit-fork|model-switch-compact|model-switch-auto-compact|goal-session-model|new-session-inherits-model|draft-model-switch-first-send|model-provider-session-isolation|upstream-workspace-smoke|model-switch-edit-fork|model-switch-queue|same-model-provider-identity)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    // SHR 回归检查 child 的真实 wire 参数；仅给菜单 high/max 而把 map 设为 {}
    // 会把所选档位从请求中删掉，导致配置更新用例在第一轮就误报参数丢失。
    specs.some((spec) =>
      /conversation-session-subagent-(runtime-refresh|catalog-refresh|profile-fields|context-boundaries|multi-workspace|cross-host)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    // 思考隔离专项需要核对真实 wire；空 Map 会让参数缺席，无法验证 session 隔离。
    specs.some((spec) =>
      /conversation-session-(thought-level-session-isolation|readstate-model-isolation|v4-goal)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    builtInSubagentModelOverridesSpec ||
    settingsSubagentCreateEditPersistenceSpec ||
    specs.some((spec) => spec.includes("plugin-subagent-override-cold.test.ts")) ||
    isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const subagentRuntimeCatalogReasoningSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  // 原因：pending 目录曾统一使用 240/80，导致普通续发插入无关 Compact，
  // 并在转正移动文件后改变测试语义。只有显式自动压缩场景使用小窗口。
  const autoCompactSpec = specs.some((spec) =>
    /conversation-session-(compact-auto|compact-auto-actions|goal-run-cases|model-switch-auto-compact|subagent-runtime-refresh)\.test\.ts$/.test(
      spec,
    ),
  );
  const contextWindow = upstreamE2EContextWindowOverride ?? (autoCompactSpec ? 240 : 128000);
  const maxOutputTokens = upstreamE2EMaxOutputTokensOverride ?? (autoCompactSpec ? 80 : undefined);
  // 菜单只设置下次发送意图；App 和 Agent 使用相同窗口，不再伪造 1 token 触发旧 guard。
  const appContextWindow = contextWindow;
  const appMaxOutputTokens = maxOutputTokens;
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  // 工具栏用例实际选择 high/max；只声明 disabled 会在进入交互断言前失败。
  const composerToolbarSpec = specs.some((spec) =>
    spec.includes("conversation-session-v4-composer-toolbar.test.ts"),
  );
  // 通用 fixture 自带完整 Option Spec，SSH 目标不依赖本机 E2E Built-in 补全。
  // Registry 以末项作为最高档；旧夹具将默认值放首项，导致 alternate 的 max 被 high 覆盖。
  const reasoning = (): PersonalProviderConfigSeed["models"][number]["reasoningLevel"] => ({
    values: specs.some((spec) => spec.endsWith("conversation-session-v4-goal.test.ts"))
      ? ["high", "low", "max"]
      : // 默认 env 的准备步骤选择 high；只声明 disabled 会在进入被测流程前失败。
        e2eProviderPresetName === "env" ||
          e2eProviderPresetName === "stagingmodel" ||
          composerToolbarSpec
        ? builtInSubagentModelOverridesSpec
          ? ["off", "low", "high", "max"]
          : ["high", "max"]
        : ["disabled"],
    // 只有专项 wire 用例注入思考参数；普通 replay 的响应节奏由 fixture 控制。
    map: exposeSubagentReasoningMetadata
      ? '{"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":reasoningLevel}}'
      : "{}",
  });
  const model = (
    id: string,
    visibility?: "visible" | "hidden",
  ): PersonalProviderConfigSeed["models"][number] => ({
    id,
    contextWindow: appContextWindow,
    // 图片布局和 Stop 收尾用例必须检查真实图片 wire 内容，限定这些 fixture 支持图片输入。
    ...(specs.some(
      (spec) =>
        spec.includes("conversation-session-v4-attachment-layout.test.ts") ||
        spec.includes("conversation-session-stop-tool-results.test.ts"),
    )
      ? { inputModalities: ["text", "image"] as const }
      : {}),
    ...(appMaxOutputTokens !== undefined ? { maxOutputTokens: appMaxOutputTokens } : {}),
    reasoningLevel: reasoning(),
    ...(visibility ? { enabled: visibility !== "hidden" } : {}),
  });
  const provider = (params: {
    apiKey?: string;
    baseURL?: string;
    enabled?: boolean;
    id: string;
    label: string;
    models: PersonalProviderConfigSeed["models"];
    visibility?: "visible" | "hidden";
  }): PersonalProviderConfigSeed => ({
    apiFormat: "anthropic-messages",
    apiKey: params.apiKey ?? apiKey,
    baseURL: params.baseURL ?? anthropicBaseURL,
    enabled: params.enabled ?? true,
    id: params.id,
    label: params.label,
    models: params.models,
    ...(params.visibility ? { visibility: params.visibility } : {}),
  });
  const appProviders: PersonalProviderConfigSeed[] = [
    provider({
      id: e2eProviderPreset.providerId,
      label: e2eProviderPreset.providerName,
      models: [
        model(e2eProviderPreset.model),
        ...(e2eProviderPresetName === "env" ? [model(E2E_PROVIDER_SECONDARY_MODEL)] : []),
      ],
    }),
    ...(e2eProviderPresetName === "env"
      ? [
          provider({
            id: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
            label: E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
            models: [model(E2E_PROVIDER_SECONDARY_MODEL)],
          }),
        ]
      : []),
    ...(subagentRuntimeCatalogReasoningSpec
      ? [
          provider({
            id: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
            label: SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME,
            // I68 验证四档父子请求隔离；通用 high/max 夹具不能代替其明确的 Option Spec。
            models: [
              {
                ...model(SUBAGENT_RUNTIME_CATALOG_MODEL),
                maxOutputTokens: 32_000,
                reasoningLevel: {
                  values: ["low", "medium", "high", "xhigh"],
                  map: '{"thinking":{"type":"enabled","budget_tokens":reasoningLevel == "low" ? 4000 : reasoningLevel == "medium" ? 8000 : reasoningLevel == "high" ? 16000 : 31999},"output_config":{"effort":reasoningLevel}}',
                },
              },
            ],
          }),
        ]
      : []),
    ...(modelProviderListFilteringSpec
      ? [
          provider({
            id: "e2e-hidden-provider",
            label: "Hidden Provider",
            models: [model("hidden-provider-model")],
            visibility: "hidden",
          }),
          provider({
            id: "e2e-visible-provider-hidden-model",
            label: "Visible Provider With Hidden Model",
            models: [model("visible-companion-model"), model("hidden-model", "hidden")],
          }),
          provider({
            enabled: false,
            id: "e2e-hidden-disabled",
            label: "Hidden Disabled Provider",
            models: [model("hidden-disabled-model")],
          }),
          provider({
            apiKey: "",
            id: "e2e-hidden-no-key",
            label: "Hidden No Key Provider",
            models: [model("hidden-no-key-model")],
          }),
          provider({
            baseURL: "",
            id: "e2e-hidden-no-endpoint",
            label: "Hidden No Endpoint Provider",
            models: [model("hidden-no-endpoint-model")],
          }),
          provider({
            baseURL: `${anthropicBaseURL}/builtin-personal-conflict`,
            id: "e2e-zai-template-provider",
            label: "Z.ai Template Provider E2E",
            models: [model("glm-5.3")],
          }),
        ]
      : []),
  ];
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: e2eProviderPreset.providerId,
    modelId: e2eProviderPreset.model,
    // 远端 Provisioning 只接受完整模型选择；默认模型缺少思考档位会使 SSH 首连与
    // OP10 新建会话退回 Registry 推荐。无思考能力的模型也显式选择 disabled。
    options: { reasoningLevel: readE2EThoughtLevel() || "disabled" },
  });
}

function buildUpstreamE2EAnthropicBaseUrl() {
  const baseURL = upstreamE2EBaseUrl.replace(/\/+$/u, "");
  return baseURL.endsWith("/anthropic") ? baseURL : `${baseURL}/anthropic`;
}

export const config: WebdriverIO.Config = {
  runner: "local",
  // 修复原因：waitUntil 的 timeout 无法中断内部已经发出的 WebDriver HTTP 请求；
  // 坏 ContextId 在 hook 中会按默认 120 秒和 3 次重试卡数分钟，必须在协议层设硬边界。
  connectionRetryCount: E2E_WEBDRIVER_REQUEST_LIMITS.retryCount,
  // executeAsyncScript 的浏览器内 script timeout 与 WDIO 到 Chromedriver 的 HTTP timeout
  // 是两层独立门限；公网 Archive case 两层都必须覆盖 Agent 的 180 秒下载上限。
  connectionRetryTimeout: pluginNoGitGitHubArchiveE2E
    ? 300_000
    : E2E_WEBDRIVER_REQUEST_LIMITS.timeoutMs,
  runnerEnv: {
    E2E_PROVIDER_ALTERNATE_MODEL: E2E_PROVIDER_SECONDARY_MODEL,
    E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
    E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
    E2E_PROVIDER_HTTP_MODE: upstreamE2EHttpMode,
    [REQUESTED_UPSTREAM_HTTP_MODE_ENV]: requestedUpstreamE2EHttpMode ?? "",
    E2E_PROVIDER_MODEL: resolveActiveE2EProviderEnv().model,
    E2E_PROVIDER_ID: resolveActiveE2EProviderEnv().providerId,
    E2E_PROVIDER_NAME: resolveActiveE2EProviderEnv().providerName,
    E2E_PROVIDER_PRESET: e2eProviderPresetName,
    ...requestSecurityWorkerEnv(process.env),
    E2E_PROVIDER_THOUGHT_LEVEL: resolveActiveE2EProviderEnv().thoughtLevel,
    ...(upstreamE2EHttpMode === "replay"
      ? { E2E_PROVIDER_API_KEY: E2E_PROVIDER_REPLAY_API_KEY }
      : {}),
    HOME: E2E_HOME_DIR,
    USERPROFILE: E2E_HOME_DIR,
    ZCODE_CREDENTIAL_SECRET:
      resolveE2ECredentialSecret(configuredE2ESpecs, process.env.ZCODE_CREDENTIAL_SECRET) ?? "",
    // PLM-LC-010 使用非 ZCODE_ 前缀验证插件 MCP 的 Claude-compatible env 展开。
    // 值只供 fixture 做 hash 比对，工具结果和截图都不得回显原值。
    E2E_PLUGIN_RUNTIME_SECRET: "e2e-plugin-runtime-secret-fixture-20260718",
    ...(pluginNoGitGitHubArchiveE2E
      ? {
          // 真实公网 smoke 必须证明 Agent 没有偷偷回退开发机 Git；不存在的绝对路径会让
          // 任意 Git 调用稳定得到 ENOENT，同时不影响 WDIO runner 自身的进程清理命令。
          ZCODE_GIT_BINARY: resolve(E2E_HOME_DIR, "missing-bin", "git"),
        }
      : {}),
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_AGENT_SERVER_ARGS_JSON: "",
    ZCODE_AGENT_SERVER_COMMAND: "",
    ZCODE_DATA_BASE_DIR: E2E_HOME_DIR,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:
      INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode E2E",
    ZCODE_DESKTOP_HOME_DIR: E2E_HOME_DIR,
    ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_E2E_HOME_DIR: E2E_HOME_DIR,
    ZCODE_E2E_ARTIFACT_DIR: e2eReporter.artifactDir,
    ZCODE_E2E_DEFER_APP_DATA_CLEANUP: "1",
    ZCODE_E2E_RUN_ID: E2E_RUN_ID,
    ZCODE_ENV: "test",
    // 修复原因：普通 E2E 的 ZCODE_ENV=test 会把配置接口路由到测试域；
    // 请求安全 capture 与独立 live-team 显式覆盖生产控制面，其他用例保持原行为。
    ...getE2EProviderEndpointEnv(configuredE2ESpecs, e2eProviderPresetName, upstreamE2EHttpMode),
    ...(process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_CAPTURE_PATH: process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH,
        }
      : {}),
    ...(process.env.ZCODE_TELEMETRY_PARITY_VARIANT?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_VARIANT: process.env.ZCODE_TELEMETRY_PARITY_VARIANT,
        }
      : {}),
  },
  framework: "mocha",
  reporters: ["spec"],
  maxInstances: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),
  maxInstancesPerCapability: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),
  ...(containerE2E
    ? {
        autoXvfb: true,
        xvfbAutoInstall: false,
        xvfbMaxRetries: 5,
        xvfbRetryDelay: 1500,
      }
    : {}),
  services: [
    [
      // Bug 根因：旧 Electron service 会吞 ContextId 失败，且 reloadSession 不会重跑
      // service.before；本地 module 保留官方 launcher，同时补严格 readiness 与 onReload。
      E2E_ELECTRON_SERVICE_MODULE_PATH,
      {
        // Bugfix: rootDir 只用于让 wdio-electron-service 读取 desktop package.json；
        // Electron 可执行文件在 pnpm hoisted / isolated 布局下位置不同，不能再让
        // appEntryPoint 模式按 rootDir 硬拼 node_modules/.bin/electron。
        rootDir: DESKTOP_DIR,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "electron",
      browserVersion: ELECTRON_VERSION,
      "wdio:electronServiceOptions": {
        appArgs: [
          ...(E2E_PACKAGED_APP_BINARY_PATH ? [] : [`--app=${E2E_APP_ENTRY_POINT}`]),
          "--no-sandbox",
          // 语音输入 E2E（docs/chat/composer-voice-input.md）：用 Chromium 假麦克风设备，
          // 不访问真实设备，也不弹出系统授权；其他用例不调用 getUserMedia，不受影响。
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          // 修复原因：环境变量不会出现在进程命令行；同时传 runId 与 HOME identity，
          // 让跨平台清理优先命中当前 run，并为 Windows shard 保留路径级兜底。
          buildE2ERunIdArg(E2E_RUN_ID),
          createWindowsE2EHomeMarkerArg(E2E_HOME_DIR),
        ],
        appBinaryPath: ELECTRON_APP_BINARY_PATH,
      },
      "goog:chromeOptions": {
        // 修复原因：Electron 的 `--app=<main>` 会永久保留一个
        // chrome-error://chromewebdata/ app target。把 app 暴露给 ChromeDriver 后，
        // 长批次 session 启停期间 current handle 可能重新落到错误壳；这里只允许
        // BrowserWindow 对应的 page target，让 session 未就绪时失败而不是绑错窗口。
        windowTypes: ["page"],
        args: [...(containerE2E ? containerChromeArgs : [])],
      },
      ...(containerE2E
        ? {
            "wdio:chromedriverOptions": {
              // 修复原因：固定容器 cache，避免每轮从 /tmp 重新下载 Chromedriver。
              cacheDir: E2E_BROWSER_DRIVER_CACHE_DIR,
            },
          }
        : {}),
    },
  ],
  specs: configuredE2ESpecs,
  // 修复原因：上游 provider e2e 需要真实上游 key，默认全量 e2e 不应启动一个“跳过但仍占用浏览器”的 worker。
  // 否则它会和 smoke 共用并重置 .e2e-home，表现为临时测试窗口白屏或一直等不到默认工作区。
  exclude: [
    ...(upstreamProviderSpecRequested ? [] : [UPSTREAM_PROVIDER_SPEC]),
    ...(manualReviewE2E ? [] : [MANUAL_REVIEW_SPEC_GLOB]),
    ...resolveEnvironmentGatedFormalSpecExcludes({
      env: process.env,
      targeted: isExplicitE2ESpecSelection(requestedE2ESpecs),
    }),
    // Bugfix: MR 自动门禁可以临时 quarantine 已知不稳定正式 spec，但本地默认
    // `test:e2e` 不受影响，避免把 flaky case 从开发者回归入口永久隐藏。
    ...requestedE2EExcludeSpecs,
  ],
  mochaOpts: {
    // Bug 根因：WDIO config beforeSuite 通过 executeHooksWithArgs 执行，普通异常会被
    // 记录后 resolve，坏 session 仍会进入产品 case。Mocha 原生 root hook 才会把
    // preflight rejection 计为 hook failure，并在 test body 前停止。
    rootHooks: createE2ERendererBridgeRootHooks(
      async () => {
        await measureE2ELifecyclePhase(
          "before-suite",
          { specs: currentE2EWorkerSpecs },
          async () => {
            await runE2ERendererBridgePreflight(currentE2EWorkerSpecs);
          },
        );
      },
      () => currentE2EBeforeSessionError,
    ),
    ui: "bdd",
    // 远程 e2e 队列里有正式 spec 只包含一个远程用例（settings-ui-polish 的
    // MP-UI-05-remote）：整份跑会把同 spec 的本机用例一起拉进远程结果，失败原因
    // 与远程无关却计在远程账上（实测 MP-UI-06 拖累 MP-UI-05-remote 的通过结论）。
    // 未设置时保持全量，不影响本机回归。
    ...(process.env.ZCODE_E2E_MOCHA_GREP?.trim()
      ? { grep: process.env.ZCODE_E2E_MOCHA_GREP.trim() }
      : {}),
    // 修复原因：真实模型配置 + 首次会话预热可能超过 30s，保留更宽的单 case 上限，避免还没收到上游响应就被 Mocha 截断。
    // 真实 GitHub Archive smoke 会下载 Claude 官方市场和目标插件；E2E 抓包代理还会
    // 记录完整二进制响应，不能沿用只覆盖本地 fixture 的 120 秒上限。
    // WPL-011 会经过 SSH asset、marketplace 镜像、远端安装与 runtime refresh；
    // 固定 120 秒会在 UI 有机会报告具体同步结果前先截断 case。
    // Bug 根因：Mocha adapter 会在进入 test body 前按 config timeout 包裹用例，
    // 因此用例内的 this.timeout 无法为人工保留阶段追加预算。显式 hold 只扩展
    // manual-review 运行，不改变普通 E2E 的 120 秒上限。
    // 修复原因：旧写法是嵌套三元，按出现顺序取第一个命中；同一分片同时包含多个长预算 spec 时，
    // 排在前面的较小预算会截断后面的较长用例（例如 240s 截断 background-bash 的 360s）。
    // 改为对所有命中的预算取最大值，新增分支与顺序无关。
    timeout:
      Math.max(
        requestSecuritySpecTimeout(configuredE2ESpecs, 120000),
        ...[
          {
            // 此用例包含真实 SSH 首装、目录复用、设置定位、16 张截图和原目录重连；
            // 探测校验用例同样经过真实首装与已有设备故障恢复，不能在到达状态断言前被截断。
            // Mocha 外层须与用例的 15 分钟预算一致，不能在首装解压时被默认 120 秒截断。
            matched: configuredE2ESpecs.some(
              (spec) =>
                spec.endsWith("conversation-session-remote-sidebar-menus.test.ts") ||
                spec.endsWith("conversation-session-ssh-probe-validation.test.ts"),
            ),
            ms: 15 * 60_000,
          },
          {
            // 用例不稳定原因：RDUX15 串行走 SSH、Docker 四个入口的后台连接，用例内声明 20 分钟预算，
            // 但 this.timeout 无法覆盖外层，负载高时在 Docker 段被 120 秒截断（Error: Timeout）。
            matched: configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-background-connection.test.ts"),
            ),
            ms: 20 * 60_000,
          },
          {
            // 走查用例串行完成真实首装、失败/取消/后台、设置页与停容器掉线恢复，并全程录屏；
            // 与用例内 30 分钟预算一致。
            matched: configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-remote-ui-walkthrough.test.ts"),
            ),
            ms: 30 * 60_000,
          },
          {
            // 此用例串行完成真实 SSH 安装、两次 relay 配对和断网恢复；同步其原定预算，
            // 避免 WDIO 在手机离线期间按默认 120 秒截断，this.timeout 无法覆盖外层。
            matched: configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-r3-mobile.test.ts"),
            ),
            ms: 40 * 60_000,
          },
          {
            matched:
              pluginNoGitGitHubArchiveE2E ||
              workspacePluginRemoteExplicitSyncE2E ||
              configuredE2ESpecs.some((spec) =>
                spec.endsWith("conversation-session-subagent-cross-host.test.ts"),
              ),
            ms: 600000,
          },
          {
            // SHR14/SHR17 串行跑两个 workspace、四轮父子请求与设置保存，用例声明
            // this.timeout(240000)，但外层 Mocha 包裹先按 120 秒截断（Windows 上实测约 130 秒）。
            matched: configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-subagent-multi-workspace.test.ts"),
            ),
            ms: 240000,
          },
          {
            // 后台 Bash 冷恢复回归等待真实 child 结束、120s publisher grace 及 60s 清理节拍。
            matched: configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-background-bash-output.test.ts"),
            ),
            ms: 360000,
          },
        ]
          .filter((budget) => budget.matched)
          .map((budget) => budget.ms),
      ) + manualReviewHoldMs,
  },
  async onPrepare() {
    try {
      e2eReporter.prepare(configuredE2ESpecs);
      await measureE2ELifecyclePhase("prepare", { specs: configuredE2ESpecs }, async () => {
        await cleanupE2EElectronProcesses("onPrepare");
        await cleanupE2EDirectory("onPrepare", E2E_CHROMIUM_USER_DATA_ROOT_DIR, true);
        // Bug 根因：beforeSession 发生在 WDIO worker 内，而 Electron/ChromeDriver
        // 启动链继承的是 launcher 派生 worker 时的环境。reset mock 若到 worker 才启动，
        // Main -> Host 会继续请求真实 ZCode 域名；因此与 upgrade mock 一样在派发 worker
        // 前启动，并通过环境把同一个动态端口传给 Electron 和测试控制端。
        await startCodingPlanTeamMockIfNeeded(configuredE2ESpecs);
        if (codingPlanTeamMockBaseUrl) {
          // WDIO 配置显式提供 runnerEnv 后不会再透传 launcher 的 process.env；必须把
          // onPrepare 分配的动态端口写回 runnerEnv，worker/ChromeDriver/Electron 才会
          // 继承同一个 mock，而不是在 beforeSession 另起一份只有测试代码能访问的服务。
          if (!config.runnerEnv) {
            // Fail fast：runnerEnv 被移除时 Object.assign 到临时对象会静默丢弃端口，
            // 表现为 worker 内 mock 失联，比这里直接失败难排查得多。
            throw new Error(
              "wdio config 缺少 runnerEnv，coding plan reset mock 端口无法透传给 worker",
            );
          }
          Object.assign(config.runnerEnv, {
            [CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]: codingPlanTeamMockBaseUrl,
            ...(offPeakTeamGateway
              ? { ZCODE_OFFPEAK_MOCK_PORT: String(offPeakTeamGateway.port) }
              : {}),
          });
        }
        // Bugfix: Coding Plan webview origin 是 Vite 编译期常量；mock 必须先于
        // build 启动并注入 env，否则 renderer 会 baked 线上官网 origin。
        await startCodingPlanUpgradeE2EMock(configuredE2ESpecs, {
          prepareForBuild: true,
        });
        const codingPlanUpgradeMockBaseUrl =
          process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
        if (codingPlanUpgradeMockBaseUrl) {
          // 正式 Rewards 用例使用自托管网页，不依赖开发者的 localhost:3000 服务。
          if (configuredE2ESpecs.some((spec) => spec.includes("marketing-touch-rewards"))) {
            process.env.VITE_REWARDS_WEBVIEW_ORIGIN = codingPlanUpgradeMockBaseUrl;
          }
          if (!config.runnerEnv) {
            throw new Error(
              "wdio config 缺少 runnerEnv，coding plan upgrade mock 端口无法透传给 worker",
            );
          }
          Object.assign(config.runnerEnv, {
            [CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]: codingPlanUpgradeMockBaseUrl,
          });
        }
        const buildAndStage = async () =>
          withE2EDesktopBuildLock({}, async () => {
            prepareDesktopAppBuild();
            if (!E2E_PACKAGED_APP_BINARY_PATH) await stageDesktopE2EAppOutput();
          });
        // 旧覆盖报告只有路径，不能证明源码版本；复用构建不得追认当前工作树。
        if (process.env.ZCODE_E2E_SOURCE_EVIDENCE === "1") {
          await withE2ESourceEvidence({
            freshBuild: !E2E_PACKAGED_APP_BINARY_PATH && !shouldReuseDesktopE2EBuild(process.env),
            captureSources: () => captureWorkspaceSources(REPO_ROOT),
            build: buildAndStage,
            appOutputDir: E2E_APP_OUTPUT_DIR,
            artifactDir: e2eReporter.artifactDir,
          });
        } else await buildAndStage();
        prepareZCodeAgentServer();
        // 正式包使用随包 CLI，模板 seed 源不同，不预热；缺模板时各 HOME 照常冷 seed。
        if (!E2E_PACKAGED_APP_BINARY_PATH) {
          await prepareOfficialPluginCacheTemplate({
            cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
            templateHome: E2E_OFFICIAL_PLUGIN_CACHE_TEMPLATE_HOME,
          });
        }
      });
    } catch (error) {
      // 修复原因：WDIO 会把 onPrepare 异常记录成 hook error 后继续派发 worker，
      // 构建失败时会演变成几十个 DevToolsActivePort/bridge timeout 噪音，掩盖真正原因。
      console.error("[e2e] fatal onPrepare failure", error);
      process.exit(1);
    }
  },
  onWorkerStart(cid, _caps, specs) {
    e2eRunnerFinalizationGuard.disarm();
    e2eWorkerLifecycleStarts.set(cid, {
      specs,
      startedAt: new Date(),
    });
  },
  async beforeSession(_config, capabilities, specs, cid) {
    // Bugfix: 现有 e2e 会读写 ~/.zcode/v2；如果多个 spec 复用真实 HOME，
    // 上一个 spec 的凭据、最近项目和 localStorage 会串到下一个 spec，
    // 既污染开发者本机数据，也让“首次启动”类断言变得随机。
    // 这里为 e2e 单独准备隔离 HOME，并在每个 session 启动前重置，保证每个 spec 都从干净环境开始。
    // onPrepare 设置的 process.env 不会可靠传进 WDIO worker；Electron 启动前在
    // worker 再清除自定义 Agent 覆盖，确保数据库准备仍走 bundled resolver。
    currentE2EWorkerSessionSpecs = specs;
    applyUpstreamE2EHttpModeForWorker(specs);
    applyAskUserQuestionClockScaleForWorker(specs);
    applyE2EProviderEnv(specs);
    configureHighspeedE2EMock(specs);
    currentE2EBeforeSessionError = null;
    applyE2EWorkerModelRetryEnv(process.env, specs, configuredModelRetryMaxRetries);
    currentE2EChromiumUserDataDir = resolveE2EWorkerChromiumProfileDir(
      E2E_CHROMIUM_USER_DATA_ROOT_DIR,
      cid,
    );
    const chromeCapabilities = capabilities as {
      "goog:chromeOptions"?: { args?: string[] };
    };
    const chromeOptions = chromeCapabilities["goog:chromeOptions"] ?? {};
    // 修复原因：所有 worker 复用并反复删除同一个 profile 时，长批次中 Chromium
    // 会留下失效文档，CDP target 仍显示 file://，运行时却漂到 chrome-error://。
    // 在 session 创建前按 cid 注入独立 profile，确保 worker 生命周期互不污染。
    chromeOptions.args = replaceChromeUserDataDirArg(
      chromeOptions.args ?? [],
      currentE2EChromiumUserDataDir,
    );
    const storageDiagnostics =
      process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS === "1" &&
      specs.some((spec) =>
        spec.endsWith("conversation-session-r3-desktop-settings-authority.test.ts"),
      );
    const credentialOwnerProbe = specs.some((spec) =>
      /system-credential-owner(?:-mcp)?\.test\.ts$/.test(spec),
    );
    if (
      !E2E_PACKAGED_APP_BINARY_PATH &&
      (credentialOwnerProbe ||
        storageDiagnostics ||
        specs.some((spec) =>
          /conversation-session-subagent-(context-boundaries|multi-workspace|cross-host)\.test\.ts/.test(
            spec,
          ),
        ))
    ) {
      // ChromeDriver 会清空 NODE_OPTIONS；测试启动文件在正式 Main 导入前设置代理预加载。
      // 文件放在原 Main 旁边，保留 app 路径；正式 Host/CLI resolver 与存储准备均不替换。
      const entry = resolve(E2E_APP_OUTPUT_DIR, "main/subagent-e2e.mjs");
      const proxy = resolve(
        REPO_ROOT,
        credentialOwnerProbe
          ? "packages/desktop/test/e2e/helpers/credential-owner-probe.mjs"
          : storageDiagnostics
            ? "packages/desktop/test/e2e/helpers/storage-worker-diagnostics.mjs"
            : "packages/desktop/test/e2e/helpers/subagent-config-proxy.mjs",
      );
      // Bug 根因：Windows 上 `--import="C:\..."` 会被 ESM loader 当作协议 `c:` 拒绝
      // （ERR_UNSUPPORTED_ESM_URL_SCHEME）；Host utility process 继承 NODE_OPTIONS 后启动即
      // exit 1，用例卡在等待工作区。预加载统一传 file:// URL，macOS/Linux 行为不变。
      const preload = `--import=${JSON.stringify(pathToFileURL(proxy).href)}`;
      const diagnostics = credentialOwnerProbe
        ? `process.env.ZCODE_E2E_CREDENTIAL_OWNER_LOG = ${JSON.stringify(resolve(E2E_HOME_DIR, "credential-owner.ndjson"))};\nawait import(${JSON.stringify(pathToFileURL(proxy).href)});\n`
        : storageDiagnostics
          ? `process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS_DIR = ${JSON.stringify(resolve(e2eReporter.artifactDir, "storage-workers"))};\n`
          : "";
      await writeFile(
        entry,
        `${diagnostics}process.env.NODE_OPTIONS = ${JSON.stringify(preload)};\nawait import(${JSON.stringify(pathToFileURL(E2E_APP_ENTRY_POINT).href)});\n`,
      );
      chromeOptions.args = chromeOptions.args.map((arg) =>
        arg.startsWith("--app=") ? `--app=${entry}` : arg,
      );
    }
    chromeCapabilities["goog:chromeOptions"] = chromeOptions;
    try {
      await measureE2ELifecyclePhase("before-session", { cid, specs }, async () => {
        // 修复原因：worker 在 WebDriver session 创建前失败时不会可靠进入 afterSession；
        // 下一个 worker 必须先按本轮 run id 清理残留 Electron/host，不能让旧 target
        // 继续污染新的 launcher session。
        await cleanupE2EElectronProcesses("beforeSession-start", {
          requireExit: true,
        });
        // 原因：onPrepare 与 Electron launcher 不在同一进程，动态端口只能在
        // worker 的 beforeSession 中注入，才会被 Main -> Host 环境链继承。
        await startModelContextBudgetConfigE2EMock(specs);
        // 动态工作流灰度同样只能在 worker 的 beforeSession 注入动态端口，Main -> Host 的
        // 环境链才会继承到 case-local 的 /client/configs 网关。
        await startDynamicWorkflowConfigE2EMock(specs);
        // 此 SSH 用例验证会话归属；在 Electron 启动前设置开启前置，避免把本机 mock 的 loopback 交给远端。
        if (specs.some((spec) => spec.endsWith("conversation-session-r3-subagent.test.ts"))) {
          process.env.ZCODE_DYNAMIC_WORKFLOW_MODE = "alwaysOn";
        }
        const fixtureCredentialSecret = resolveE2ECredentialSecret(
          specs,
          process.env.ZCODE_CREDENTIAL_SECRET,
        );
        if (fixtureCredentialSecret) process.env.ZCODE_CREDENTIAL_SECRET = fixtureCredentialSecret;
        else delete process.env.ZCODE_CREDENTIAL_SECRET;
        await runE2EBeforeSessionSetup({
          cid,
          specs,
          configureAgentServerEnv: configureZCodeAgentServerEnv,
          configureCodingPlanTeamMockForSpecs,
          recordBeforeSession: e2eReporter.beforeSession,
          resetHome: resetE2EHome,
          startCodingPlanTeamMockIfNeeded,
          startCodingPlanUpgradeMockIfNeeded: startCodingPlanUpgradeE2EMock,
          startUpstreamHttpIfNeeded: startUpstreamE2EHttp,
          startCodingPlanDataPlaneProxyIfNeeded: startCodingPlanDataPlaneProxy,
          startPluginCdnZipFixtureIfNeeded,
          startOffPeakMockIfNeeded: startOffPeakE2EMock,
        });
        if (process.platform === "darwin" && specs.some(isNativeKeychainCredentialSpec)) {
          // Main 首次访问发生在界面就绪前；原生专项必须先准备隔离 HOME 的系统库入口。
          await mkdir(resolve(E2E_HOME_DIR, "Library"), { recursive: true });
          await symlink(
            resolve(userInfo().homedir, "Library/Keychains"),
            resolve(E2E_HOME_DIR, "Library/Keychains"),
            "dir",
          );
        }
        // Client Scenes 是布局 case 的远端目录依赖；必须在 resetHome 完成、Electron
        // 启动前覆盖 endpoint，确保 Main → Host 首次 import 时拿到 case-local fixture。
        await startClientScenesE2EMockIfNeeded(specs);
        await stopTtftOtlpFixture?.();
        stopTtftOtlpFixture = await prepareTtftOtlpFixture(specs);
        await startRequestSecurityFixture(specs, E2E_HOME_DIR);
        stopOAuthCompletionRaceFixture = await prepareOAuthCompletionRaceFixture(specs);
        stopAccessToken401Fixture = await prepareAccessToken401Fixture({
          specs,
          credentialsFile: E2E_APP_CREDENTIALS_FILE,
          settingsFile: E2E_APP_SETTINGS_FILE,
        });
        stopVoiceInputFixture = await prepareVoiceInputFixture(specs);
        stopWebRemoteControlAuthGateFixture = await prepareWebRemoteControlAuthGateFixture({
          specs,
          credentialsFile: E2E_APP_CREDENTIALS_FILE,
          settingsFile: E2E_APP_SETTINGS_FILE,
          workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
        });
        stopOfficialMcpAuthRoutingFixture = await prepareOfficialMcpAuthRoutingFixture({
          specs,
          credentialsFile: E2E_APP_CREDENTIALS_FILE,
          settingsFile: E2E_APP_SETTINGS_FILE,
          workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
        });
        stopMcpFailureGuidanceFixture = await prepareMcpFailureGuidanceFixture({
          specs,
          credentialsFile: E2E_APP_CREDENTIALS_FILE,
          settingsFile: E2E_APP_SETTINGS_FILE,
          workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
        });
        // resetHome 之后、Electron 启动之前安装，Main -> Host -> Agent 才会同时继承
        // case-owned PATH；其他 spec 由 helper 保持 no-op。
        await installBashPrefixPermissionPnpmShim({
          environment: process.env,
          homeDir: E2E_HOME_DIR,
          specs,
        });
        // 根因：WDIO 先探测再释放端口，随后 ChromeDriver 绑定时曾被占用；驱动自己分配并持有端口。
        // 每个 worker 独占一份，Electron 冷重启继续连接这份驱动，不增加启动重试。
        try {
          e2eChromedriverServer ??= await startE2EChromedriverServer({
            executablePath: resolveE2EChromedriverExecutable({
              explicitPath: process.env.CHROMEDRIVER_PATH,
              electronVersion: ELECTRON_VERSION,
              cacheDir: containerE2E ? E2E_BROWSER_DRIVER_CACHE_DIR : tmpdir(),
            }),
            logPath: resolve(e2eReporter.artifactDir, `chromedriver-${cid}.log`),
          });
          Object.assign(_config, {
            hostname: e2eChromedriverServer.hostname,
            port: e2eChromedriverServer.port,
          });
        } catch (error) {
          // WDIO 会吞 beforeSession 异常后继续启动；这里直接结束 worker，禁止回退到第二份驱动。
          console.error("[e2e] ChromeDriver startup failed", error);
          process.exit(1);
        }
      });
    } catch (error) {
      // Bug 根因：WDIO executeHooksWithArgs 会吞掉 beforeSession rejection；保存原始
      // 失败并交给 Mocha root hook 抛出，确保产品 test body 不在残缺环境里继续跑。
      currentE2EBeforeSessionError =
        error ?? new Error("beforeSession setup rejected without an error value");
    }
  },
  async before(_capabilities, specs) {
    // Bug 根因：WDIO 将项目与 wdio-electron-service 的 before hooks 放进 Promise.all；
    // 这里发 renderer/CDP 命令会与 service 的 ContextId、Puppeteer 和窗口初始化竞态。
    // before 只保存 worker 归属，browser 命令统一延后到 Mocha root hook 时序屏障。
    currentE2EWorkerSpecs = specs;
  },
  async beforeTest(test) {
    resetDraftRegenerationResend();
    // 修复原因：当前 Electron runner 的 before hook 阶段 `browser.electron`
    // 还没注入；等到 beforeTest 再启动采样，才能持续调用 electron.execute。
    await e2eReporter.startUICoverage(browser);
    await e2eReporter.startProcessSampling(browser, currentE2EWorkerSpecs);
    e2eFailureArtifacts ??= new E2EFailureArtifactCollector({
      artifactDir: e2eReporter.artifactDir,
      browser,
    });
    try {
      await e2eFailureArtifacts.start(test);
    } catch (error) {
      // 修复原因：诊断产物的初始化失败不能让 beforeTest 变成新的 E2E 失败根因。
      console.warn("[e2e] failure artifact collection could not start", error);
    }
  },
  async beforeCommand(commandName) {
    if (commandName !== "refresh") {
      return;
    }
    try {
      // 修复原因：renderer 刷新会重建 globalThis.__coverage__；必须在页面销毁前
      // 合并本轮 counter，否则刷新前已走过的交互会从 suite 覆盖率中消失。
      await e2eReporter.snapshotUICoverage();
    } catch (error) {
      console.warn("[e2e-coverage] renderer pre-refresh snapshot failed", error);
    }
  },
  async after(_result, _capabilities, specs) {
    await measureE2ELifecyclePhase("after", { specs }, async () => {
      try {
        await e2eReporter.stopProcessSampling(browser, specs);
        await e2eReporter.stopUICoverage();
      } finally {
        // 先让 ChromeDriver 正常关闭 renderer；同进程的 closed 监听再触发
        // app.quit，afterSession 最后验证整个进程树已经退出。
        await armCurrentElectronAppQuit("after");
        currentE2EWorkerSpecs = [];
      }
    });
  },
  async afterSession() {
    await measureE2ELifecyclePhase(
      "after-session",
      { specs: currentE2EWorkerSessionSpecs },
      async () => {
        try {
          await cleanupE2EElectronProcesses("afterSession", {
            requireExit: true,
            waitForGracefulExit: true,
          });
          if (currentE2EChromiumUserDataDir) {
            await cleanupE2EDirectory("afterSession", currentE2EChromiumUserDataDir, true);
          }
          // Electron/Host/CLI 都已退出，V8 JSON 此时完整封口；趁下一 worker 启动前
          // 就地归一化，避免全量 manual-review 把重复 source map 累积到磁盘上限。
          e2eReporter.compactNodeCoverage();
        } finally {
          await e2eChromedriverServer?.stop();
          e2eChromedriverServer = undefined;
          await stopRequestSecurityFixture();
          await stopModelContextBudgetConfigE2EMock();
          await stopDynamicWorkflowConfigE2EMock();
          currentE2EElectronAppPid = null;
          await stopOAuthCompletionRaceFixture?.();
          stopOAuthCompletionRaceFixture = null;
          await stopTtftOtlpFixture?.();
          stopTtftOtlpFixture = null;
          await stopWebRemoteControlAuthGateFixture?.();
          stopWebRemoteControlAuthGateFixture = null;
          await stopAccessToken401Fixture?.();
          stopAccessToken401Fixture = null;
          await stopVoiceInputFixture?.();
          stopVoiceInputFixture = null;
          await stopOfficialMcpAuthRoutingFixture?.();
          stopOfficialMcpAuthRoutingFixture = null;
          await stopMcpFailureGuidanceFixture?.();
          stopMcpFailureGuidanceFixture = null;
          currentE2EBeforeSessionError = null;
          e2eFailureArtifacts = null;
          currentE2EWorkerSessionSpecs = [];
          currentE2EChromiumUserDataDir = null;
        }
      },
    );
  },
  onWorkerEnd(cid, exitCode, specs) {
    e2eRunnerFinalizationGuard.arm();
    const workerLifecycle = e2eWorkerLifecycleStarts.get(cid);
    if (!workerLifecycle) {
      return;
    }
    e2eWorkerLifecycleStarts.delete(cid);
    const completedAt = new Date();
    e2eReporter.recordLifecycleEvent({
      cid,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - workerLifecycle.startedAt.getTime(),
      error: exitCode === 0 ? undefined : `worker exited with code ${exitCode}`,
      phase: "worker",
      specs: specs.length > 0 ? specs : workerLifecycle.specs,
      startedAt: workerLifecycle.startedAt.toISOString(),
      status: exitCode === 0 ? "passed" : "failed",
    });
  },
  async afterTest(test, _context, result) {
    let failureArtifacts;
    const collectionErrors: string[] = [];
    try {
      // Mocha suite after 里的 clearAppData 会先退出 Electron；afterTest 是读取
      // renderer coverage 的最后稳定时机，WDIO after 只保留失败兜底。
      await e2eReporter.stopUICoverage();
    } catch (error) {
      console.warn("[e2e-coverage] renderer snapshot failed", error);
      collectionErrors.push(
        `renderer coverage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      failureArtifacts = await runE2EDiagnosticWithTimeout(
        async () =>
          e2eFailureArtifacts?.complete(test, {
            ...result,
            errorCategory: result.passed
              ? undefined
              : classifyError(
                  result.error instanceof Error ? result.error.message : String(result.error ?? ""),
                ),
          }),
        E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS,
        "E2E failure artifact collection",
      );
    } catch (error) {
      // 修复原因：失败证据采集属于诊断补充，采集器自身异常不能掩盖原始 E2E 失败。
      console.warn("[e2e] failure artifact collection failed", error);
      collectionErrors.push(
        `failure artifacts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    e2eReporter.recordTestResult(test, result, failureArtifacts, collectionErrors);
  },
  async onComplete(exitCode) {
    e2eRunnerFinalizationGuard.disarm();
    let onCompleteError: unknown;
    try {
      await measureE2ELifecyclePhase("complete", { specs: configuredE2ESpecs }, async () => {
        try {
          await stopUpstreamE2EHttp();
          await stopCodingPlanTeamMock();
          await stopCodingPlanUpgradeE2EMock();
          await stopRequestSecurityFixture();
          await stopModelContextBudgetConfigE2EMock();
          await stopDynamicWorkflowConfigE2EMock();
          await stopClientScenesE2EMock();
          await stopOAuthCompletionRaceFixture?.();
          stopOAuthCompletionRaceFixture = null;
          await stopWebRemoteControlAuthGateFixture?.();
          stopWebRemoteControlAuthGateFixture = null;
          await stopAccessToken401Fixture?.();
          stopAccessToken401Fixture = null;
          await stopVoiceInputFixture?.();
          stopVoiceInputFixture = null;
          await stopOfficialMcpAuthRoutingFixture?.();
          stopOfficialMcpAuthRoutingFixture = null;
          await stopMcpFailureGuidanceFixture?.();
          stopMcpFailureGuidanceFixture = null;
          await stopPluginCdnZipFixture();
        } finally {
          await cleanupE2EElectronProcesses("onComplete");
          // 修复原因：逐 worker 删除同一 app data 会重复支付 SQLite 锁重试；下一
          // beforeSession 已负责重置，最后一个 worker 的 HOME 在全部进程退出后统一删除。
          // 失败保留诊断现场：批次 runner（run.mjs）注入 ZCODE_E2E_KEEP_HOME_ON_FAIL=1 时，
          // 失败 run 保留 HOME（setting.json/credentials/db 是失败定性的关键证据，
          // r3-rerun §49 曾因 home 被删只能从 run.log 反推 settings）。PASS 行为不变。
          if (exitCode !== 0 && process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
            console.warn(`[e2e] keeping failure home for diagnosis: ${E2E_HOME_DIR}`);
          } else {
            await cleanupE2EDirectory("onComplete-home", E2E_HOME_DIR, true);
          }
          await cleanupE2EDirectory("onComplete", E2E_RUN_CACHE_DIR);
        }
      });
    } catch (error) {
      onCompleteError = error;
    } finally {
      e2eReporter.writeSummary(exitCode);
      armE2ERunnerExitWatchdog(exitCode);
    }
    if (onCompleteError) {
      throw onCompleteError;
    }
  },
};
