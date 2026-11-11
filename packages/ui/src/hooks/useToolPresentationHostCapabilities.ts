import { useMemo } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import type { ToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";

/** 宿主能力只在 App 装配；公开 renderer 不读取用户配置或平台服务。 */
export function useToolPresentationHostCapabilities(
  workspacePath: string,
): ToolPresentationCapabilities {
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const modelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  // 独立展示入口没有服务或 Tab Provider；配置加载留在 SessionPane 宿主。
  const { agentColor } = useToolPresentationCapabilities();
  return useMemo(
    () => ({
      readMediaPreview: services
        ? (path: string) => services.fileService.readMediaPreview({ path })
        : undefined,
      getApplicationIcon: platform?.getApplicationIcon
        ? (request) => platform.getApplicationIcon!(request)
        : undefined,
      modelProviderName,
      agentColor,
    }),
    [services, platform, modelProviderName, agentColor],
  );
}
