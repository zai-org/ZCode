// v4 workspace-config 只承载 workspace presentation；模型候选与首选项由目标 Host
// ModelSelectionView 提供，不能再从 live Session settings 反向建立第二份模型目录。
import { getZCodeAgentModeSelectOptions, normalizeAvailableZCodeMode } from "@zcode/shared";
import type { ZCodeSessionSettingsState, ZCodeSlashCommand } from "@zcode/shared";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSettings } from "./mapper.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Session settings 只投影非模型的 workspace mode 与 slash commands。 */
export function toV4WorkspaceConfigState(
  settings: ZCodeSessionSettingsState,
  slashCommands: readonly ZCodeSlashCommand[],
): WorkspaceConfigState {
  return {
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: normalizeAvailableZCodeMode(settings.mode.current),
        options: getZCodeAgentModeSelectOptions(),
      },
    ],
    slashCommands: slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint !== undefined ? { inputHint: command.inputHint } : {}),
      ...(command.source !== undefined ? { source: command.source } : {}),
    })),
  };
}

/**
 * 订阅时种子：只走 live session 快路径（mapSessionSettings 直接读在册 app）。
 * 刻意不建 temporary app——host 启动预热抢先读取 workspace presentation 会在无 active session 时
 * 创建临时 app 并被 MCP close 拖住协议通道（见 desktop warmUpZCodeAgent 的注释）。
 * 无在册会话时返回 null（空目录种子）；模型选择目录由 Host 自己的进程 Registry View
 * 提供，这条会话协议只在出现 live session 后发布任务级配置。
 */
export async function buildLiveWorkspaceConfigStateV4(
  context: ZCodeProtocolAgentServerContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  const record = Array.from(context.sessions.values()).find(
    (candidate) => candidate.workspace.workspaceKey === workspaceId,
  );
  if (!record) return null;
  const settings = await mapSessionSettings(record.app);
  const slashCommands = await listProtocolSlashCommands({
    // 灰度门是 Host 判定的 workspace 级事实，目录装配读进程缓存。
    dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
    env: context.deps.env,
    logger: context.logger,
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: record.workspace.workspaceIdentity,
    remoteSessionId: record.workspace.remoteSessionId,
    workingDirectory: record.workspace.workspacePath,
  });
  return toV4WorkspaceConfigState(settings, slashCommands);
}
