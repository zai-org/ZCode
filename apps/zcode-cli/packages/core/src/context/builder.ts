// ============================================================
// Context Builder - System prompt assembly
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import { buildEnvironmentSections, buildGitSystemContextSection } from "./sections/env-info.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildMemorySection } from "./sections/memory.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../memory/project-memory-retrieval-branch.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
  buildSessionGuidanceSection,
  buildTotalTokensSection,
} from "./dynamic-sections.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };
/** Skill 工具的注册名（与 tool/handlers/skill.ts 的 metadata.name 同字面；contracts 没有常量）。 */
const SKILL_TOOL_NAME = "Skill";

export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * 保留兼容入口。工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * 添加自定义 section（用于后续扩展）
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * 构建 context，返回结构化结果
   */
  build(): ContextBuildResult {
    const sections: ContextSection[] = [];
    const activeOutputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    // 自定义 system prompt 原样发送，不 trim；只有全空白时视为未设置。
    const customSystemPrompt = this.config.customSystemPrompt;
    const hasCustomSystemPrompt = Boolean(customSystemPrompt?.trim());
    // 工作流子代理身份：第三条路径。与
    // customSystemPrompt 互斥——两者同在只可能是接线错误（persona 该经 workflowActor 进来，
    // 不该再塞 systemPrompt），大声失败而不是默默二选一。
    const workflowActor = this.config.workflowActor;
    if (workflowActor !== undefined && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive",
      );
    }
    const isWorkflowActor = workflowActor !== undefined;
    const midConversationSystem = this.config.midConversationSystem !== false;

    // 1. CLI / 产品前缀。工作流子代理只向脚本返回结果，
    // 不使用面向用户交互的身份前缀，直接以工作流身份开头。
    if (!isWorkflowActor) {
      sections.push(buildCliPrefixSection());
    }

    // 2. Stable agent behavior or custom prompt body
    if (hasCustomSystemPrompt) {
      sections.push(
        createSection({
          name: "Custom System Prompt",
          source: "custom_system_prompt",
          injectionTarget: "system",
          cacheHint: "stable",
          content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
        }),
      );
    } else if (workflowActor !== undefined) {
      sections.push(buildWorkflowActorIdentitySection(workflowActor, midConversationSystem));
    } else {
      sections.push(buildIdentitySection(activeOutputStyle, midConversationSystem));
    }

    // 环境与模型是运行时公告（meta_user），不进 system；使用自定义 prompt 时也照常发送。
    const environmentSections = buildEnvironmentSections(
      this.config.envInfo,
      this.config.model,
      this.config.additionalDirectories,
    );

    // 3. Dynamic system context
    // custom prompt 不是只替换 stable body，而是跳过默认 system prompt 的动态段；否则用户
    // 提供 custom prompt 后仍会混入 Session Guidance 等动态 system 段。
    // 工作流子代理跳过其中面向「与用户对话」的三段（desktop、Dynamic Behavior、session
    // guidance——契约里已把 Report outcomes faithfully 搬过去），保留 memory 与其后各段。
    if (!hasCustomSystemPrompt) {
      if (!isWorkflowActor && this.config.presentationSurface === "zcode_desktop") {
        sections.push(buildDesktopContextSection(Boolean(this.config.genUiOutputDirectory)));
      }

      // behaviour part right after stable sp...
      if (!isWorkflowActor) {
        sections.push(buildDynamicBehaviorSection());
      }

      // Session-specific guidance
      const sessionGuidanceSection = isWorkflowActor
        ? null
        : buildSessionGuidanceSection(
            this.config.guidanceToolNames ?? [],
            (this.config.skills?.skills.length ?? 0) > 0,
          );
      if (sessionGuidanceSection) {
        sections.push(sessionGuidanceSection);
      }

      // Memory
      if (this.config.memoryRoot) {
        const memorySection = buildMemorySection(
          this.config.memoryRoot,
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        if (memorySection) {
          sections.push(memorySection);
        }
      }
      sections.push(...environmentSections);

      // Context Management
      sections.push(buildContextManagementSection());
      sections.push(buildTotalTokensSection());

      const gitSystemContextSection = buildGitSystemContextSection(this.config.envInfo);
      if (gitSystemContextSection) {
        sections.push(gitSystemContextSection);
      }
    } else {
      sections.push(...environmentSections);
    }

    // 4. Skills appear as a meta user system-reminder, matching provider block layout.
    // guidanceToolNames 是 runtime 当下的
    // 工具表；一个 Skill 工具未注册的工作流子代理被告知「以下技能可经 Skill 工具使用」，
    // 只会让它相信自己有一个没有的工具。表缺席（测试 / 旧调用方）时保持既有行为。
    if (this.config.skills && this.skillToolAvailable()) {
      const skillsSection = buildSkillsSection({
        outcome: this.config.skills,
        metadataBudget: this.config.skillMetadataBudget,
      });
      if (skillsSection) {
        sections.push(skillsSection);
      }
    }

    // 5. Meta user context（workspace instructions / project memory）；日期是其后的独立公告。
    const requestUserContextSection = buildRequestUserContextSection({
      userInstructions: this.config.userInstructions,
      memoryIndexContent: this.config.memoryIndexContent,
      memoryRoot: this.config.memoryRoot,
    });
    if (requestUserContextSection) {
      sections.push(requestUserContextSection);
    }

    const currentDateSection = buildCurrentDateSection(this.config.currentDate);
    if (currentDateSection) {
      sections.push(currentDateSection);
    }

    // 6. Custom sections
    sections.push(...this.customSections);

    const orderedSections = orderSectionsForInjection(sections);

    // 计算总计
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = this.assembleSystemMessages(orderedSections);
    const metaUserAttachments = buildMetaUserAttachments(orderedSections);

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    };
  }

  private skillToolAvailable(): boolean {
    const names = this.config.guidanceToolNames;
    return names === undefined || names.includes(SKILL_TOOL_NAME);
  }

  private assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
    const messages: ModelInputMessage[] = [];

    const cliPrefixContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
      ),
    );
    if (cliPrefixContent) {
      messages.push({
        role: "system",
        content: cliPrefixContent,
      });
    }

    const stableBodyContent = buildSectionContent(
      sections.filter(
        (section) =>
          section.injectionTarget === "system" &&
          section.cacheHint === "stable" &&
          section.source !== "cli_prefix",
      ),
    );
    if (stableBodyContent) {
      messages.push({
        role: "system",
        content: stableBodyContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const dynamicSystemContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
      ),
    );
    if (dynamicSystemContent) {
      messages.push({
        role: "system",
        // ZCode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致。
        content: `\n\n${dynamicSystemContent}`,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    return messages;
  }
}

// 环境（含 Desktop 段）、模型、日期由运行时按当前事实宣告；builder 只保留 section 作开关与用量统计。
const RUNTIME_ANNOUNCED_SOURCES: ReadonlySet<ContextSection["source"]> = new Set([
  "env_info",
  "desktop_context",
  "model",
  "current_date",
]);

export function buildMetaUserAttachments(sections: ContextSection[]): ContextMetaUserAttachment[] {
  // 来源明确分流；不再把日期、环境和 Git 折进指令 carrier。
  const sourceMap: Partial<Record<ContextSection["source"], ContextMetaUserAttachment["source"]>> =
    {
      skills: "skills_listing",
      request_user_context: "context_prefix",
      session_context: "session_context",
    };
  const attachments: ContextMetaUserAttachment[] = [];
  for (const attachmentSource of Object.values(sourceMap)) {
    const grouped = sections.filter(
      (section) =>
        section.injectionTarget === "meta_user" &&
        !RUNTIME_ANNOUNCED_SOURCES.has(section.source) &&
        (sourceMap[section.source] ?? "context_prefix") === attachmentSource,
    );
    const content = buildSectionContent(grouped);
    if (!content) continue;
    const files = grouped.flatMap((section) => section.instructionFiles ?? []);
    attachments.push({
      source: attachmentSource,
      content,
      ...(files.length > 0 ? { files } : {}),
    });
  }
  return attachments;
}

function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

function buildSectionContent(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

function createSection(input: {
  name: string;
  source: ContextSection["source"];
  injectionTarget: ContextSection["injectionTarget"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
