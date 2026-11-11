// 选区“批注”入口只对声明 conversationQuoteComment 的 CLI 开放：旧 CLI 会静默剥掉引用上的
// comment / agent，用户看到批注而模型收不到。查询失败、旧 Host 或远端未实现时一律按不支持隐藏。
import { useEffect, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useSelectionCommentSupport(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  enabled: boolean,
): boolean {
  const { zcodeAgentService } = useServices();
  const key = `${workspaceIdentity?.trim() ?? ""}\0${workspacePath}`;
  const [state, setState] = useState<{ key: string; supported: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const query = zcodeAgentService.supportsConversationQuoteComment;
    if (typeof query !== "function") return;
    query
      .call(zcodeAgentService, {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then(
        (supported) => {
          if (!disposed) setState({ key, supported: supported === true });
        },
        (error: unknown) => {
          logger.warn("[selection-comment] 读取批注能力失败，隐藏批注入口", { error });
          if (!disposed) setState({ key, supported: false });
        },
      );
    return () => {
      disposed = true;
    };
  }, [enabled, key, workspaceIdentity, workspacePath, zcodeAgentService]);
  return enabled && state?.key === key && state.supported;
}
