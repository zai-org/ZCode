/* eslint-disable max-lines -- workspace 模型协议与兼容请求处理仍集中在本文件。 */
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import type { ModelSelection } from "@zcode/contracts";
import {
  zcodeProviderTestModelConnectivityParamsSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProviderRuntimeHeadersPort } from "./provider-runtime-headers.js";
import { offPeakLifecycleNotificationSchema } from "@zcode/shared";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";

export async function readWorkspacePresentation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReadPresentationParamsSchema, rawParams);
  return {
    workspace: params.workspace,
    mode: "build" as const,
    slashCommands: await listProtocolSlashCommands({
      // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
      pluginPreparation: context.deps?.pluginPreparation,
      pluginDiscovery: context.deps?.pluginDiscovery,
      workspaceIdentity: params.workspace.workspaceIdentity,
      remoteSessionId: params.workspace.remoteSessionId,
      workingDirectory: params.workspace.workspacePath,
    }),
  };
}

export async function testProviderModelConnectivity(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeProviderTestModelConnectivityParamsSchema, rawParams);
  // 旧 Personal Config 跨进程 watcher 可能永久漏掉原子写事件；连接测试若不先
  // 主动刷新，会反复查询旧 Registry。这里复用正式 Registry refresh，不旁路创建配置事实。
  await context.deps.refreshProviderRegistry?.("provider-connectivity");
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: createInMemorySessionEventStore(),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  try {
    await app.testModelConnectivity(
      { selection: params.selection as ModelSelection },
      { abortSignal },
    );
    return { success: true as const };
  } finally {
    if (!active) await app.close?.();
  }
}

export async function createWorkspaceZCodeApp(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
  options: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<ZCodeApp> {
  const providerRuntimeHeadersPort =
    options.providerRuntimeHeadersPort ?? createProviderRuntimeHeadersPort(context, workspace);
  return context.deps.createZCodeApp({
    ...options,
    // Hook Trust 等对外字段用会话所属 workspace 的 key；受管 worktree 会话 = 项目 key。
    workspaceKey: workspace.workspaceKey,
    onOffPeakLifecycleEvent: (event) =>
      context.notify({
        method: V4_NOTIFICATIONS.offPeakLifecycle,
        params: offPeakLifecycleNotificationSchema.parse(event),
      }),
    includeVisualize: true,
    platform: context.deps.platform,
    providerRuntimeHeadersPort,
    runtimeConfig: {
      ...options.runtimeConfig,
      // createZCodeApp 会把 workingDirectory 规范化为执行 cwd。把协议入口的
      // workspacePath 单独注入 runtime，session 持久化才能保留本地 workspaceKey 的路径表示。
      workspacePath: workspace.workspacePath,
      // 远端 session 是 shared-host CUA 的第二层隔离边界：不能只传 workspacePath/identity，
      // 否则同一远端 workspace 的不同 attachment 会复用 Accessibility frame/action 状态。
      // 放在这个 helper 里而不是各调用点，是为了两条 session 创建路径都拿到同一份隔离键。
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      ...(workspace.workspaceIdentity
        ? {
            memory: {
              ...options.runtimeConfig?.memory,
              workspaceIdentity: workspace.workspaceIdentity,
            },
          }
        : {}),
      // Electron/Protocol 主会话之前没有像 CLI/TUI 那样显式开启模型流式，
      // 导致主 turn 退回 generateText 非流式请求，遇到返回 SSE 的兼容端点会按 JSON 解析失败。
      modelStreaming: options.runtimeConfig?.modelStreaming ?? "on",
    },
  });
}

export function hasSessionModelProvider(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace">,
  providerId: string,
): boolean {
  return record.app.listModels().some((model) => model.ref.providerId === providerId);
}

export function resolveSessionModelContextWindow(
  _context: ZCodeProtocolAgentServerContext,
  record: Pick<ZCodeProtocolSessionRecord, "app" | "workspace" | "restoredModelSelection">,
): number | undefined {
  // 缺档位会让恢复选择暂不绑定 Runtime，但模型身份仍可只读查询容量，不能伪造 20 万。
  const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
  const value = selection && record.app.getModelOption?.(selection)?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
