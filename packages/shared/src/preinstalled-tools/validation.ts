import type { z } from "zod";

export function validatePreinstalledEntries(
  resource: {
    requiredFiles: string[];
    entries: { name: string; target: string }[];
    runtimeChecks?: { entry: string }[];
    platforms?: { platform: string }[];
    rewrite?: { mode: string }[];
  },
  context: z.RefinementCtx,
) {
  if (
    resource.platforms?.some((target) => target.platform === "win32") &&
    resource.rewrite?.some((rule) => rule.mode === "binary-dir-prefix")
  ) {
    context.addIssue({
      code: "custom",
      path: ["rewrite"],
      message: "Windows resources cannot declare binary-dir-prefix",
    });
  }
  const names = new Set<string>();
  for (const [index, entry] of resource.entries.entries()) {
    if (names.has(entry.name.toLowerCase()))
      context.addIssue({ code: "custom", path: ["entries", index, "name"], message: "入口名重复" });
    names.add(entry.name.toLowerCase());
    if (!resource.requiredFiles.includes(entry.target))
      context.addIssue({
        code: "custom",
        path: ["requiredFiles"],
        message: "必需文件必须包含全部入口目标",
      });
  }
  for (const [index, check] of (resource.runtimeChecks ?? []).entries())
    if (!resource.entries.some((entry) => entry.name === check.entry))
      context.addIssue({
        code: "custom",
        path: ["runtimeChecks", index, "entry"],
        message: "运行检查必须引用本资源入口",
      });
}
export function validatePreinstalledCatalog(
  catalog: {
    toolId: string;
    resources: {
      toolId: string;
      platforms: { platform: string; arch: string }[];
      entries: { name: string }[];
    }[];
  }[],
  context: z.RefinementCtx,
) {
  const tools = new Set<string>();
  const entryOwners = new Map<string, string>();
  for (const [index, tool] of catalog.entries()) {
    if (tools.has(tool.toolId))
      context.addIssue({ code: "custom", path: [index, "toolId"], message: "工具身份重复" });
    tools.add(tool.toolId);
    const platforms = new Set<string>();
    for (const [resourceIndex, resource] of tool.resources.entries()) {
      const path = [index, "resources", resourceIndex];
      if (resource.toolId !== tool.toolId)
        context.addIssue({ code: "custom", path, message: "资源必须属于当前工具" });
      for (const target of resource.platforms) {
        const key = `${target.platform}-${target.arch}`;
        if (platforms.has(key))
          context.addIssue({ code: "custom", path, message: "同一平台只能有一个资源" });
        platforms.add(key);
      }
      for (const entry of resource.entries) {
        const name = entry.name.toLowerCase();
        const owner = entryOwners.get(name);
        if (owner && owner !== tool.toolId)
          context.addIssue({ code: "custom", path, message: "不同工具不能共用入口名" });
        entryOwners.set(name, tool.toolId);
      }
    }
  }
}
