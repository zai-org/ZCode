// Composer Skill 只读 catalog。
// 与 Skills Settings 管理接口分离：这里的 sessionId 决定 authority，不提供启停/删除能力。
import {
  zcodeSkillsReferenceCatalogParamsSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { listZCodeSkills } from "../skills.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSkillsReferenceCatalogResult> {
  const params = parseParams(zcodeSkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult("session", outcome);
  }

  // 旧 UI cache 只在 workspace 首次挂载时扫描，用户从文件系统手动新增
  // Skill 后，新建对话仍停在旧快照。草稿请求在 Agent 侧复用 CLI 正式发现配置，
  // 每次新打开引用面板都读取当前 workspace catalog。
  const outcome = await listZCodeSkills({
    env: context.deps.env,
    includeVisualize: true,
    logger: context.logger,
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult("workspace", outcome);
}

function toResult(
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): ZCodeSkillsReferenceCatalogResult {
  return {
    authority,
    // 内置技能包（bundled-skills.ts）不进引用面板：它由内置命令（`/workflow`）加载，不是用户
    // 管理或引用的对象；协议的 scope 是封闭枚举，旧客户端严格校验，这里不为它扩枚举。
    skills: outcome.skills
      .filter((skill) => skill.source !== "bundled")
      .map(toReferenceCatalogEntry),
  };
}

function toReferenceCatalogEntry(skill: SkillMetadata): ZCodeSkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` 是现有 UI provider 过滤契约；路径使同名不同来源仍有稳定行身份。
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
