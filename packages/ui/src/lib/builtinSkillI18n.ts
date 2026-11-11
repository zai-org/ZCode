import type { Locale, SkillScope } from "@zcode/shared";
import { toZhOrEnLocale } from "@zcode/shared";

interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "design",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "restore-legacy-sessions",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/design-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/restore-legacy-sessions-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

// 内置 Skill 描述只有中英两套；其它界面语言用英文。
const BUILTIN_SKILL_DESCRIPTIONS: Record<string, Record<"zh-CN" | "en-US", string>> = {
  "android-dev": {
    "zh-CN": "通过 android-emulator MCP 工具构建、运行、检查并轻量自动化 Android 应用。",
    "en-US": "Build, run, inspect, and lightly automate Android apps through the android-emulator MCP tools.",
  },
  "brainstorming": {
    "zh-CN": "在任何创造性工作前使用：创建功能、构建组件、增加能力或修改行为；先探索用户意图、需求和设计。",
    "en-US": "Use before any creative work, including creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.",
  },
  "control-browser": {
    "zh-CN": "控制 ZCode 内置浏览器，用于打开、检查、点击、输入、截图或验证网页和本地开发页面。",
    "en-US": "Control ZCode's built-in browser to open, inspect, click, type, screenshot, or verify webpages and local development targets.",
  },
  "design": {
    "zh-CN": "设计工作流：交付物是写入工作区的 HTML 设计稿、可交互原型或 HTML 演示稿时使用，覆盖需求理解、新建与改版、品牌配色、视觉探索与审查。对话内的交互视图用 visualize，.pptx 文件交给 presentations。",
    "en-US": "Design workflow for workspace deliverables: HTML design files, interactive prototypes, and HTML slide decks, covering intake, new designs and redesigns, color and brand, exploration, and review. Use visualize for in-chat views and presentations for .pptx files.",
  },
  "dispatching-parallel-agents": {
    "zh-CN": "面对 2 个以上彼此独立、无共享状态或顺序依赖的任务时使用。",
    "en-US": "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
  },
  "docx": {
    "zh-CN": "完整的 DOCX 文档创建、编辑与分析能力，支持修订、批注、格式保持和文本提取。适用于创建新文档、修改内容、处理修订、添加批注或其它专业 Word 文档任务。",
    "en-US": "Create, edit, and analyze DOCX documents with revisions, comments, formatting preservation, and text extraction. Use for new documents, edits, revision handling, comments, and professional Word document work.",
  },
  "docx-viewer": {
    "zh-CN": "在 Word 文档侧栏与用户一起查看和讨论 .docx 文件。适用于打开、阅读、审阅或询问工作区中的 Word 文档，用户提到在查看器中选中或引用的内容，或需要检查刚生成的文档。",
    "en-US": "View and discuss Word (.docx) files with the user in the Documents side panel. Use to open, read, review, or ask about a workspace Word document, when the user refers to a selection or reference in the viewer, or to check a document you just produced.",
  },
  "executing-plans": {
    "zh-CN": "已有书面实现计划，并要在带评审检查点的独立会话中执行时使用。",
    "en-US": "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
  },
  "finishing-a-development-branch": {
    "zh-CN": "实现已完成、测试通过、需要决定如何合并、发 PR 或清理分支时使用。",
    "en-US": "Use when implementation is complete, tests pass, and you need to decide how to integrate the work through merge, PR, or cleanup.",
  },
  "ios-dev": {
    "zh-CN": "通过 ios-simulator MCP 工具构建、运行、检查并轻量自动化 iOS 模拟器应用。",
    "en-US": "Build, run, inspect, and lightly automate iOS Simulator apps through the ios-simulator MCP tools.",
  },
  "pdf": {
    "zh-CN": "专业 PDF 工具集，覆盖报告、创意视觉、学术 LaTeX 和现有 PDF 处理四条生产线。可按文档类型自动路由，支持报告、海报、论文、简历、提取、合并、拆分、表单填写和格式转换等任务。",
    "en-US": "Professional PDF toolkit for reports, creative visuals, academic LaTeX, and existing-PDF workflows. Supports reports, posters, papers, resumes, extraction, merge, split, forms, and conversion.",
  },
  "pdf-viewer": {
    "zh-CN": "在 PDF 侧栏与用户一起查看和讨论 PDF 文件。适用于打开、阅读、审阅或询问工作区中的 PDF，用户提到在查看器中选中或引用的内容，或需要检查刚生成的 PDF。",
    "en-US": "View and discuss PDF files with the user in the PDF side panel. Use to open, read, review, or ask about a workspace PDF, when the user refers to a selection or reference in the viewer, or to check a PDF you just produced.",
  },
  "pptx": {
    "zh-CN": "检查并窄范围更新从 PPTX 预览区选择的元素。通过完整文件指纹和 OOXML 定位校验 shape 文本或表格单元格，冲突时停止而不猜测。",
    "en-US": "Inspect and narrowly update elements selected in PPTX Preview Pane. Verifies the whole-file fingerprint and OOXML locator for shape or table-cell text, and stops on conflicts instead of guessing.",
  },
  "pptx-viewer": {
    "zh-CN": "在演示文稿侧栏与用户一起查看和讨论 .pptx 演示文稿。适用于一起打开、审阅或询问工作区中的演示文稿，用户提到在查看器中选中或引用的幻灯片或元素，或需要检查刚生成的演示文稿。",
    "en-US": "View and discuss PowerPoint (.pptx) decks with the user in the Presentations side panel. Use to open, review, or ask about a workspace deck together, when the user refers to a slide or shape selected or referenced in the viewer, or to check a deck you just produced.",
  },
  "receiving-code-review": {
    "zh-CN": "收到代码评审反馈、准备实现建议前使用；尤其当反馈不清楚或技术上可疑时，需要严谨验证而非盲目同意。",
    "en-US": "Use when receiving code review feedback before implementing suggestions, especially when feedback is unclear or technically questionable.",
  },
  "requesting-code-review": {
    "zh-CN": "完成任务、实现重大功能或合并前，用于请求代码评审以确认满足需求。",
    "en-US": "Use when completing tasks, implementing major features, or before merging to verify work meets requirements.",
  },
  "restore-legacy-sessions": {
    "zh-CN": "检查、规划或执行 ACP 时代 ZCode 旧 session 恢复到新的 ZCode 任务与会话库。",
    "en-US": "Inspect, plan, or restore old ACP-era ZCode sessions into the new ZCode task and session stores.",
  },
  "plugin-creator": {
    "zh-CN": "创建、校验 ZCode 插件，并指导本地安装与更新。",
    "en-US": "Create and validate ZCode plugins, and guide local installation and updates.",
  },
  "skill-creator": {
    "zh-CN": "创建新技能、编辑现有技能并迭代措辞。适用于从零编写 SKILL.md、改进已有技能、把重复工作流沉淀为可复用技能，或优化技能描述以提升触发可靠性。",
    "en-US": "Create new skills, edit existing skills, and iterate wording. Use for writing SKILL.md from scratch, improving skills, capturing repeated workflows, or tuning descriptions for reliable triggering.",
  },
  "subagent-driven-development": {
    "zh-CN": "在当前会话中执行包含独立任务的实现计划时使用。",
    "en-US": "Use when executing implementation plans with independent tasks in the current session.",
  },
  "systematic-debugging": {
    "zh-CN": "遇到任何 bug、测试失败或异常行为时，在提出修复前使用。",
    "en-US": "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
  },
  "test-driven-development": {
    "zh-CN": "实现任何功能或 bugfix 时，在编写实现代码前使用。",
    "en-US": "Use when implementing any feature or bugfix, before writing implementation code.",
  },
  "using-git-worktrees": {
    "zh-CN": "开始需要隔离的功能工作或执行实现计划前使用，确保存在隔离 workspace，优先使用原生工具，否则回退 git worktree。",
    "en-US": "Use when starting feature work that needs isolation or before executing implementation plans. Ensures an isolated workspace exists via native tools or git worktree fallback.",
  },
  "using-superpowers": {
    "zh-CN": "开始任何对话时使用；说明如何查找和使用技能，并要求在任何回复包括澄清问题前调用 Skill 工具。",
    "en-US": "Use when starting any conversation. Establishes how to find and use skills, requiring Skill tool invocation before any response including clarifying questions.",
  },
  "verification-before-completion": {
    "zh-CN": "准备声明工作完成、已修复或测试通过前使用；要求先运行验证命令并确认输出，先有证据再下结论。",
    "en-US": "Use before claiming work is complete, fixed, or passing. Requires running verification commands and confirming output before success claims.",
  },
  "web-gui-tester": {
    "zh-CN": "使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试，通过真实用户交互、DOM 语义证据和截图验证功能、交互与响应式布局。",
    "en-US": "Run pure GUI black-box tests against websites and local web frontends with ZCode Browser Use, combining real user interactions, semantic DOM evidence, and inspected screenshots.",
  },
  "writing-plans": {
    "zh-CN": "已有规格或多步骤任务需求，在动代码前用于编写实现计划。",
    "en-US": "Use when you have a spec or requirements for a multi-step task, before touching code.",
  },
  "writing-skills": {
    "zh-CN": "创建新技能、编辑现有技能或在发布前验证技能是否有效时使用。",
    "en-US": "Use when creating new skills, editing existing skills, or verifying skills work before deployment.",
  },
  "xlsx-viewer": {
    "zh-CN": "在电子表格侧栏与用户一起查看和讨论 .xlsx 工作簿。适用于一起打开、浏览或询问工作区中的工作簿，用户提到在查看器中选中或引用的单元格，或需要检查刚生成的工作簿。",
    "en-US": "View and discuss Excel (.xlsx) workbooks with the user in the Spreadsheets side panel. Use to open, browse, or ask about a workspace workbook together, when the user refers to cells selected or referenced in the viewer, or to check a workbook you just produced.",
  },
};

export function resolveSkillSourceLabel(scope: SkillScope, locale?: Locale): string {
  if (locale === "zh-CN") {
    if (scope === "workspace") return "工作区";
    if (scope === "plugin") return "插件";
    return "用户";
  }
  if (scope === "workspace") return "Workspace";
  if (scope === "plugin") return "Plugin";
  return "User";
}

export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
  locale?: Locale,
): string {
  const localized = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]?.[toZhOrEnLocale(locale)]
    : undefined;
  return localized ?? skill.description;
}

function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
