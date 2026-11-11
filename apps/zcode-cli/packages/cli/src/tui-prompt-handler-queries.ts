// tui-prompt-handler.ts 顶到 oxlint max-lines 上限（400 行），把 submitPrompt 上
// 那组「拿到当前 App 就只读转发」的查询方法拆到本文件；公开面仍从 tui-prompt-handler.ts 导出。
import type { CommandCenterApp } from "./command-center.js";
import { listAppEffortOptions } from "./command-center/effort-options.js";
import type { TuiPromptHandler } from "./tui-command-state.js";
import type { TuiSessionMetadata } from "@zcode/tui";

export async function readTuiSessionMetadata(app: CommandCenterApp): Promise<TuiSessionMetadata> {
  const modelOptions = (await app.listModels?.()) ?? [];
  return {
    locale: app.getLocale?.(),
    model: app.getModel?.(),
    theme: app.getTheme?.(),
    thoughtLevel: app.getThoughtLevel?.(),
    modelOptions,
    effortOptions: (await listAppEffortOptions(app)) ?? [],
    loginRequired: !modelOptions.some((model) => !model.disabledReason),
  };
}

export const attachTuiAppQueries = (
  submitPrompt: TuiPromptHandler,
  getApp: () => Promise<CommandCenterApp>,
): void => {
  submitPrompt.readSubagents = async (input) => {
    const app = await getApp();
    return (
      app.readSubagents?.(input) ?? {
        revision: 0,
        childSessionIds: [],
        running: [],
        ended: { total: 0, items: [] },
      }
    );
  };
  submitPrompt.readSubagentTranscript = async (childSessionId) => {
    const app = await getApp();
    if (!app.readSubagentTranscript) throw new Error("Subagent transcript is unavailable.");
    return app.readSubagentTranscript(childSessionId);
  };
  submitPrompt.recallPreviousInput = async (skip) => {
    const activeApp = await getApp();
    return (await activeApp.recallPreviousInputHistory?.(skip)) ?? null;
  };

  submitPrompt.getSessionMetadata = async () => {
    const activeApp = await getApp();
    return readTuiSessionMetadata(activeApp);
  };

  submitPrompt.listModelOptions = async () => {
    const activeApp = await getApp();
    return activeApp.listModels?.() ?? [];
  };

  submitPrompt.listEffortOptions = async () => {
    const activeApp = await getApp();
    return (await listAppEffortOptions(activeApp)) ?? [];
  };

  submitPrompt.listMcpServers = async () => {
    const activeApp = await getApp();
    return (await activeApp.listMcpServers?.()) ?? {};
  };

  submitPrompt.listWorkflowRuns = async () => {
    const activeApp = await getApp();
    // 会话级摘要；服务端已按「最近更新在前」给序，读侧不重排（端口注释的裁定）。
    return (await activeApp.listDynamicWorkflowRuns?.({})) ?? [];
  };

  submitPrompt.replayWorkflowRuns = async (input) => {
    const activeApp = await getApp();
    // 与 v4 冷物化同一条链：journal → 与 live
    // 同一种进度载荷 → 镜像的共享 reducer。
    return (await activeApp.replayDynamicWorkflowRuns?.(input)) ?? [];
  };
};
