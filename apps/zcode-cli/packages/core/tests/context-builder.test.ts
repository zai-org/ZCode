import { formatMemoryIndexContent } from "../src/memory/index-content.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContextBuilder } from "../src/context/index.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

import { buildMemorySection } from "../src/context/sections/memory.js";
import {
  buildCliPrefixSection,
  buildEnvInfoSection,
  buildGitSystemContextSection,
  buildIdentitySection,
  buildSkillsSection,
} from "../src/context/index.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ContextBuildResult, ContextMetaUserAttachmentSource } from "../src/context/types.js";

const contextTestModel = createTestRuntimeModel({
  providerId: "openai",
  modelId: "gpt-5",
  generateText: async () => {
    throw new Error("context rendering must not execute the model");
  },
});

const DEFAULT_COMMUNICATION_PROMPT =
  "Write code that reads like the surrounding code: match its comment density, naming, and idiom.";

const EXPECTED_PRONOUNS_PROMPT =
  "When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.";

const DEFAULT_CONTEXT_MANAGEMENT_PROMPT = [
  "# Context management",
  "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue \u2014 you don't need to wrap up early or hand off mid-task.",
].join("\n");

const ADDITIONAL_ACT_DONT_REDERIVE_PROMPT =
  "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey";

const TOTAL_TOKENS_LINE = "<total_tokens>15000000 tokens left</total_tokens>";

const REMOVED_AUTONOMY_PARAGRAPHS = [
  "You are operating autonomously.",
  "Exception: when the user is describing a problem",
  "Before ending your turn, check your last paragraph.",
  "Before running a command that changes system state",
];

const EXPECTED_ACTION_CAUTION_PROMPT =
  "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.";

// 环境、模型、日期只产出 section，由运行时宣告；其余来源读 meta user carrier。
const RUNTIME_ANNOUNCED_SECTIONS = {
  environment: "env_info",
  model: "model",
  date: "current_date",
} as const;

function metaAttachment(
  result: ContextBuildResult,
  source: ContextMetaUserAttachmentSource | keyof typeof RUNTIME_ANNOUNCED_SECTIONS,
): string {
  if (source in RUNTIME_ANNOUNCED_SECTIONS) {
    const sectionSource =
      RUNTIME_ANNOUNCED_SECTIONS[source as keyof typeof RUNTIME_ANNOUNCED_SECTIONS];
    return result.sections.find((section) => section.source === sectionSource)?.content ?? "";
  }
  return (
    result.metaUserAttachments.find((attachment) => attachment.source === source)?.content ?? ""
  );
}

function memoryFixture(
  name: "main-memory-default-index.md" | "main-memory-index.md" | "main-memory-semantic-recall.md",
): string {
  const content = readFileSync(new URL(`./fixtures/memory/${name}`, import.meta.url), "utf8");
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

describe("ContextBuilder meta user context", () => {
  it("renders CLI prefix, stable body, and dynamic system sections as separate system messages", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["Read", "Edit", "Bash", "Agent", "TodoWrite", "AskUserQuestion"],
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.systemMessages.map((message) => String(message.content).endsWith("\n"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(result.systemMessages[0]?.content).toBe("You are ZCode, an interactive agent");

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toMatch(/^\n?You are an agent working with the user toward their goals/);
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).not.toContain("You are ZCode, an interactive agent");
    expect(stableBody).toContain("# Harness");
    const harnessBullets = stableBody.split("# Harness\n")[1]?.split("\n") ?? [];
    expect(harnessBullets).toHaveLength(5);
    expect(harnessBullets.every((line) => line.startsWith(" - "))).toBe(true);
    expect(stableBody).not.toContain(EXPECTED_PRONOUNS_PROMPT);
    expect(stableBody).not.toContain("# Session-specific guidance");
    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("Write code that reads like the surrounding code");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");
    expect(stableBody).not.toContain("## Current Environment");

    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    expect(dynamicSystem.startsWith(`\n\n${DEFAULT_COMMUNICATION_PROMPT}`)).toBe(true);
    expect(dynamicSystem).toContain(
      `${DEFAULT_COMMUNICATION_PROMPT}\n\n${EXPECTED_PRONOUNS_PROMPT}\n\nFor actions that are hard to reverse or outward-facing`,
    );
    expect(dynamicSystem.split(DEFAULT_COMMUNICATION_PROMPT)).toHaveLength(2);
    expect(dynamicSystem.split(EXPECTED_PRONOUNS_PROMPT)).toHaveLength(2);
    const behavior = result.sections.find((section) => section.source === "dynamic_behavior");
    expect(behavior?.content).toBe(
      `${DEFAULT_COMMUNICATION_PROMPT}\n\n${EXPECTED_PRONOUNS_PROMPT}\n\n${EXPECTED_ACTION_CAUTION_PROMPT}`,
    );
    expect(dynamicSystem).not.toContain("# Communicating with the user");
    expect(dynamicSystem).not.toContain("Only write a code comment");
    expect(dynamicSystem).not.toContain("if what you find contradicts how it was described");
    expect(result.systemMessages[2]?.content).toContain(
      "For actions that are hard to reverse or outward-facing",
    );
    expect(
      result.systemMessages[2]?.content.indexOf("For actions that are hard to reverse"),
    ).toBeLessThan(result.systemMessages[2]?.content.indexOf("# Context management") ?? -1);
    expect(result.systemMessages[2]?.content).not.toContain("# Session-specific guidance");
    expect(result.systemMessages[2]?.content).not.toContain("`! <command>`");
    expect(result.systemMessages[2]?.content).not.toContain(
      "Use the Agent tool with specialized agents when the task at hand matches the agent's description.",
    );
    expect(result.systemMessages[2]?.content).not.toContain(
      "spawn Agent with subagent_type=Explore",
    );
    expect(result.systemMessages[2]?.content).not.toContain("# Environment");
    expect(result.systemMessages[2]?.content).toContain("# Context management");
    expect(result.systemMessages[2]?.content).not.toContain("# Language");
    expect(result.systemMessages[2]?.content).not.toContain("# Function Result Clearing");
    expect(result.systemMessages[2]?.content).not.toContain("# Summarize Tool Results");
    expect(result.systemMessages[2]?.content).not.toContain("# Session Guidance");
    expect(result.systemMessages[2]?.content).not.toContain("# Agent Identity");
  });

  it("keeps act guidance after context management and ends with the token budget line", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    const contextManagement = result.sections.find(
      (section) => section.source === "context_management",
    );
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(contextManagement?.content).toBe(
      `${DEFAULT_CONTEXT_MANAGEMENT_PROMPT}\n\n${ADDITIONAL_ACT_DONT_REDERIVE_PROMPT}`,
    );
    expect(
      dynamicSystem.endsWith(`${ADDITIONAL_ACT_DONT_REDERIVE_PROMPT}\n\n${TOTAL_TOKENS_LINE}`),
    ).toBe(true);
    expect(dynamicSystem.split(ADDITIONAL_ACT_DONT_REDERIVE_PROMPT)).toHaveLength(2);
    expect(dynamicSystem.split(TOTAL_TOKENS_LINE)).toHaveLength(2);
    for (const paragraph of REMOVED_AUTONOMY_PARAGRAPHS) {
      expect(dynamicSystem).not.toContain(paragraph);
    }
  });

  it("keeps the ZCode Desktop Context as a runtime-announced section outside the system prompt", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      presentationSurface: "zcode_desktop",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    const desktopSections = result.sections.filter(
      (section) => section.source === "desktop_context",
    );
    expect(desktopSections).toHaveLength(1);
    // 修复原因：Desktop 段原来在 system 里；system 由 prompt 快照冻结，呈现面或灰度在两次启动之间变化时
    // 仍发旧的段。现在正文随环境公告发送，builder 只保留 section 作开关与用量统计。
    expect(desktopSections[0]).toMatchObject({
      name: "ZCode Desktop Context",
      source: "desktop_context",
      injectionTarget: "meta_user",
      cacheHint: "dynamic",
    });
    expect(desktopSections[0]?.content).toBe(
      [
        "# ZCode Desktop Context",
        "",
        "### Files & URLs",
        "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
        "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
        "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).",
        "",
        "### Inline Code Comments",
        "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
        "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
        "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
        "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
        "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
        "- Keep line ranges tight; end defaults to start.",
        '- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
      ].join("\n"),
    );

    expect(JSON.stringify(result.systemMessages)).not.toContain("ZCode Desktop Context");
    expect(JSON.stringify(result.metaUserAttachments)).not.toContain("ZCode Desktop Context");
  });

  it("does not inject the Desktop context for the default terminal surface", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.sections.some((section) => section.source === "desktop_context")).toBe(false);
    expect(
      result.systemMessages.some((message) => String(message.content).includes("Desktop Context")),
    ).toBe(false);
  });

  it("keeps the CLI prefix fixed even if legacy config passes an override", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      cliPrefixPrompt: "legacy override",
    } as any).build();

    expect(result.systemMessages[0]?.content).toBe("You are ZCode, an interactive agent");
  });

  it("covers default body safety, runtime, and tool-guidance semantic anchors", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["AskUserQuestion", "Agent", "TodoWrite", "Read", "Edit", "Bash"],
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(stableBody).toContain(
      "working with the user toward their goals, using your own judgment along the way.",
    );
    expect(stableBody).not.toContain("software engineering tasks");
    expect(stableBody).toContain("mid-conversation system turns");
    expect(stableBody).toContain("Hooks may intercept tool calls");
    expect(stableBody).toContain("Prefer the dedicated file/search tools");
    expect(stableBody).toContain("Independent tool calls can run in parallel");
    expect(stableBody).toContain("Reference code as `file_path:line_number`");
    expect(stableBody).not.toContain("match local style, naming, patterns, and comment density");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    expect(stableBody).not.toContain("Sending content to an external service publishes it");
    expect(stableBody).not.toContain("Before deleting or overwriting, look at the target");
    expect(stableBody).not.toContain("Report outcomes faithfully");
    expect(stableBody).not.toContain("`! <command>`");
    expect(stableBody).not.toContain("When the user types `/<skill-name>`");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");

    expect(dynamicSystem).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamicSystem).toContain("match its comment density, naming, and idiom");
    expect(dynamicSystem).toContain("For actions that are hard to reverse or outward-facing");
    expect(dynamicSystem).toContain("Sending content to an external service publishes it");
    expect(dynamicSystem).toContain("Before deleting or overwriting, look at the target");
    expect(dynamicSystem).toContain("Report outcomes faithfully");
    expect(dynamicSystem.indexOf("For actions that are hard to reverse")).toBeLessThan(
      dynamicSystem.indexOf("# Context management"),
    );
    expect(dynamicSystem).not.toContain("# Session-specific guidance");
    expect(dynamicSystem).not.toContain("`! <command>`");
    expect(dynamicSystem).not.toContain("Use the Agent tool with specialized agents");
    expect(dynamicSystem).not.toContain("When the user types `/<skill-name>`");
    expect(dynamicSystem).not.toContain("Use AskUserQuestion");
    expect(dynamicSystem).not.toContain("spawn Agent with subagent_type=Explore");
    expect(dynamicSystem).not.toContain("Use TodoWrite");
    expect(dynamicSystem).not.toContain("Prefer Read");
    expect(dynamicSystem).not.toContain("Prefer dedicated edit/write tools");
    expect(dynamicSystem).not.toContain("Use Bash");
    expect(dynamicSystem).not.toContain("Call independent tools in parallel in a single response");
    expect(dynamicSystem).not.toContain("# Environment");
    expect(dynamicSystem).toContain("# Context management");
    expect(dynamicSystem).not.toContain("not a git repository");
    expect(dynamicSystem).not.toContain("- **Git**:");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    expect(dynamicSystem).not.toContain("# Session Guidance");
  });

  it("uses customSystemPrompt as a custom prompt without default system sections", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      presentationSurface: "zcode_desktop",
      customSystemPrompt: "You are concise for this task.",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
        gitBranch: "main",
        gitStatus: "dirty",
        gitStatusLines: [" M package.json"],
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          test: "vitest",
        },
      },
      currentDate: "2026-06-04",
      language: "Chinese",
      outputStyle: {
        name: "Terse",
        prompt: "Keep responses short.",
        keepCodingInstructions: false,
      },
      compact: {
        enabled: true,
        microcompact: {
          enabled: true,
          keepRecentToolResults: 3,
        },
      },
      guidanceToolNames: ["Read", "Edit", "Bash", "TodoWrite"],
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "Project instruction should stay as userContext.",
        bytesRead: 47,
        sizeBytes: 47,
        truncated: false,
      },
    }).build();

    expect(result.sections.some((section) => section.source === "desktop_context")).toBe(false);

    expect(result.systemMessages.map((message) => message.role)).toEqual(["system", "system"]);
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "context_prefix",
    ]);
    expect(result.systemMessages[0]?.content).toBe("You are ZCode, an interactive agent");
    expect(result.systemMessages[1]?.content).toBe("\nYou are concise for this task.");
    expect(result.sections.some((section) => section.source === "env_info")).toBe(true);
    const meta = metaAttachment(result, "context_prefix");
    expect(meta).not.toContain("<system-reminder>");
    expect(meta).toContain("Project instruction should stay as userContext.");
    expect(meta).toContain("Codebase and user instructions are shown below.");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain(
      "Contents of /workspace/AGENTS.md (project instructions, checked into the codebase):",
    );
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("- Package manager: pnpm");
    expect(meta).not.toContain("- `test`: vitest");
    expect(metaAttachment(result, "date")).toMatch(/^Today's date is /);
    const providerText = [
      ...result.systemMessages.map((message) => message.content),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");
    expect(providerText).not.toContain("# Session Guidance");
    expect(providerText).not.toContain("# Session-specific guidance");
    expect(providerText).not.toContain("## Memory");
    expect(providerText).not.toContain("# Memory");
    expect(providerText).not.toContain("## Current Environment");
    expect(providerText).not.toContain("# Environment");
    expect(providerText).not.toContain("# Context management");
    expect(providerText).not.toContain("# Language");
    expect(providerText).not.toContain("# Output Style: Terse");
    expect(providerText).not.toContain("# Function Result Clearing");
    expect(providerText).not.toContain("# Summarize Tool Results");
    expect(providerText).not.toContain("M package.json");
    expect(providerText).not.toContain("## 项目信息");
    expect(providerText).not.toContain("# user_instructions");
  });

  it("renders first-batch dynamic system sections in reference relative order", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      language: "Chinese",
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
        keepCodingInstructions: true,
      },
      compact: {
        enabled: true,
        microcompact: {
          enabled: true,
          keepRecentToolResults: 3,
        },
      },
      memoryRoot: "/workspace/.zcode/memory",
      guidanceToolNames: ["AskUserQuestion", "Agent", "Skill", "TodoWrite", "Read", "Edit", "Bash"],
    }).build();

    const stable = String(result.systemMessages[1]?.content ?? "");
    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(stable).not.toContain("# Session-specific guidance");
    expect(stable).not.toContain("# Memory");
    expect(stable).not.toContain("# Environment");
    expect(stable).not.toContain("# Context management");
    expect(stable).not.toContain("Write code that reads like the surrounding code");
    expect(stable).not.toContain("For actions that are hard to reverse");
    expect(dynamic).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamic.indexOf("For actions that are hard to reverse")).toBeLessThan(
      dynamic.indexOf("# Memory"),
    );
    expect(dynamic).not.toContain("# Session-specific guidance");
    expect(dynamic).not.toContain("`! <command>`");
    expect(dynamic).not.toContain("spawn Agent with subagent_type=Explore");
    expect(dynamic).not.toContain("# Environment");
    expect(dynamic.indexOf("# Memory")).toBeLessThan(dynamic.indexOf("# Context management"));
    expect(dynamic).not.toContain("# Session Guidance");
    // output style 指令改由输入附件 output_style_instructions 宣告，system 不再携带。
    expect(dynamic).not.toContain("# Output Style");
    expect(dynamic).not.toContain("Explain tradeoffs while solving the task.");
    expect(dynamic).not.toContain("# Language");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
    expect(dynamic).not.toContain("Respond in the primary language of the user's current prompt");
    expect(dynamic).not.toContain("old tool results may be cleared");
    expect(dynamic).not.toContain("compactable tool results");
  });

  it("renders the Memory section exactly as the frozen provider fixture", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryRoot: rootDir,
    }).build();

    const expected = memoryFixture("main-memory-default-index.md").replace(
      "<MEMORY_ROOT>",
      rootDir,
    );
    const memorySection = result.sections.find((section) => section.source === "memory");
    expect(memorySection?.content).toBe(expected);
    expect(String(result.systemMessages[2]?.content ?? "").match(/# Memory/g)).toHaveLength(1);
  });

  it("renders the two project Memory retrieval prompts from the same branch contract", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const defaultContent = buildMemorySection(rootDir, "default-index")?.content;
    const semanticContent = buildMemorySection(rootDir, "semantic-recall")?.content;
    const pointerParagraph =
      "After writing the file, add a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`). `MEMORY.md` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there.";

    expect(defaultContent).toBe(
      memoryFixture("main-memory-default-index.md").replace("<MEMORY_ROOT>", rootDir),
    );
    expect(semanticContent).toBe(
      memoryFixture("main-memory-semantic-recall.md").replace("<MEMORY_ROOT>", rootDir),
    );
    expect(defaultContent?.replace(`\n${pointerParagraph}\n`, "")).toBe(semanticContent);
  });

  it("renders the Main MEMORY.md index as the exact provider-visible user context source", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-07-22",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryIndexContent:
        "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
      memoryRoot: rootDir,
    }).build();

    const expected = memoryFixture("main-memory-index.md").replace(
      "<MEMORY_INDEX_PATH>",
      join(rootDir, "MEMORY.md"),
    );
    const contextPrefix = metaAttachment(result, "context_prefix");
    expect(contextPrefix).toContain(expected);
    expect(contextPrefix).not.toContain("# claudeMd");
    expect(contextPrefix.indexOf("Codebase and user instructions")).toBeLessThan(
      contextPrefix.indexOf("Contents of "),
    );
    expect(contextPrefix).not.toContain("Today's date");
    expect(metaAttachment(result, "date")).toBe("Today's date is 2026-07-22.");
    expect(contextPrefix.match(/user's auto-memory, persists across conversations/g)).toHaveLength(
      1,
    );
  });

  it("removes leading frontmatter and top-level HTML comments from Main MEMORY.md", () => {
    const rootDir = "/storage/memories/projects/project-0123456789abcdef/memory";
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-07-22",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      memoryIndexContent: [
        "---",
        "internal: hidden-index-metadata",
        "---",
        "<!-- hidden top-level note -->",
        "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
        "  <!-- nested list comment remains -->",
        "- [Deployment policy](deployment-policy.md) — approval is required",
        "Keep this inline marker <!-- inline comment remains --> in the index.",
        "```markdown",
        "<!-- fenced comment remains -->",
        "```",
        "",
      ].join("\n"),
      memoryRoot: rootDir,
    }).build();

    const contextPrefix = metaAttachment(result, "context_prefix");
    expect(contextPrefix).not.toContain("hidden-index-metadata");
    expect(contextPrefix).not.toContain("hidden top-level note");
    expect(contextPrefix).toContain(
      "- [Database test policy](database-test-policy.md) — integration tests use isolated databases",
    );
    expect(contextPrefix).toContain("  <!-- nested list comment remains -->");
    expect(contextPrefix).toContain("Keep this inline marker <!-- inline comment remains -->");
    expect(contextPrefix).toContain("```markdown\n<!-- fenced comment remains -->\n```");
  });

  it("renders Git in session_context while retaining the initial system behavior", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      model: contextTestModel,
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
        gitBranch: "feature/alignment",
        gitMainBranch: "main",
        gitUser: "ZCode Tester <tester@example.com>",
        gitStatus: "dirty",
        gitStatusLines: [" M package.json"],
        recentCommits: ["abc123 test commit"],
      },
      language: "Chinese",
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);

    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    const stableBody = String(result.systemMessages[1]?.content ?? "");

    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("**Current model**: openai/gpt-5");
    expect(stableBody).not.toContain("**Is a git repository**: yes");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("Write code that reads like the surrounding code");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    expect(dynamicSystem).not.toContain("## Current Environment");
    expect(dynamicSystem).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamicSystem).toContain("For actions that are hard to reverse or outward-facing");
    expect(dynamicSystem).not.toContain("# Environment");
    expect(metaAttachment(result, "model")).toBe(
      "You are powered by the model named openai/gpt-5.",
    );
    expect(metaAttachment(result, "environment")).toContain(" - Is a git repository: true");
    expect(dynamicSystem).toContain("# Context management");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    const sessionContext = metaAttachment(result, "session_context");
    expect(dynamicSystem).not.toContain("# gitStatus");
    expect(sessionContext).toContain("# gitStatus");
    expect(dynamicSystem.indexOf("# Context management")).toBeLessThan(
      dynamicSystem.indexOf(ADDITIONAL_ACT_DONT_REDERIVE_PROMPT),
    );
    expect(sessionContext).toContain("This is the git status at the start of the conversation");
    expect(sessionContext).toContain("Current branch: feature/alignment");
    expect(sessionContext).toContain("Main branch (you will usually use this for PRs): main");
    expect(sessionContext).toContain("Git user: ZCode Tester <tester@example.com>");
    expect(sessionContext).toContain("Status:\n M package.json");
    expect(sessionContext).toContain("Recent commits:\nabc123 test commit");
  });

  it("changes stable intro framing when an output style is active", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
        keepCodingInstructions: true,
      },
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    expect(stableBody).toContain(
      'You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.',
    );
    expect(stableBody).not.toContain("You are an agent working with the user toward their goals");
    expect(stableBody).toContain("# Harness");
    expect(stableBody).not.toContain("# Session-specific guidance");
    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("Write code that reads like the surrounding code");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");
    expect(dynamicSystem).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamicSystem).toContain("For actions that are hard to reverse or outward-facing");
    expect(dynamicSystem).not.toContain("# Session-specific guidance");
    expect(dynamicSystem).not.toContain("# Environment");
    expect(dynamicSystem).toContain("# Context management");
  });

  it("keeps the stable harness and communication when an output style replaces coding instructions", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      outputStyle: {
        name: "Custom",
        prompt: "Use the custom response style.",
        keepCodingInstructions: false,
      },
    }).build();

    const stableBody = String(result.systemMessages[1]?.content ?? "");
    const dynamicSystem = String(result.systemMessages[2]?.content ?? "");

    expect(stableBody).toContain("# Harness");
    expect(stableBody).toContain("Tools run behind a user-selected permission mode");
    expect(dynamicSystem.startsWith(`\n\n${DEFAULT_COMMUNICATION_PROMPT}`)).toBe(true);
    expect(dynamicSystem).toContain("For actions that are hard to reverse or outward-facing");
    expect(dynamicSystem).toContain(EXPECTED_PRONOUNS_PROMPT);
    expect(dynamicSystem).not.toContain("# Output Style");
  });

  it("does not render legacy language guidance in the default dynamic block", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      language: "日本語",
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Language");
    expect(dynamic).not.toContain("Respond in the primary language of the user's current prompt");
    expect(dynamic).not.toContain("Respond in 日本語");
    expect(dynamic).not.toContain("Respond in English");
    expect(dynamic).not.toContain("Respond in Chinese");
  });

  it("does not render legacy compact guidance when global compact is disabled", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      compact: { enabled: false },
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
  });

  it("does not render legacy compact guidance when only microcompact is disabled", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      compact: { enabled: true, microcompact: { enabled: false } },
    }).build();

    const dynamic = String(result.systemMessages[2]?.content ?? "");
    expect(dynamic).not.toContain("# Function Result Clearing");
    expect(dynamic).not.toContain("# Summarize Tool Results");
  });

  it("renders stable system sections before dynamic sections and emits meta user context after system", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "local AGENTS payload",
        bytesRead: 20,
        sizeBytes: 20,
        truncated: false,
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          test: "vitest",
        },
      },
    }).build();

    expect(result.systemMessages).toHaveLength(3);
    expect(result.systemMessages[0]?.role).toBe("system");
    expect(result.systemMessages[0]?.cacheControl).toBeUndefined();
    expect(result.systemMessages[1]?.role).toBe("system");
    expect(result.systemMessages[1]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(result.systemMessages[2]?.role).toBe("system");
    expect(result.systemMessages[2]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "context_prefix",
    ]);

    const cliPrefix = result.systemMessages[0]?.content ?? "";
    const stableBody = result.systemMessages[1]?.content ?? "";
    const dynamicSystem = result.systemMessages[2]?.content ?? "";
    const meta = metaAttachment(result, "context_prefix");
    expect(cliPrefix).toBe("You are ZCode, an interactive agent");
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).toMatch(/^\n?You are an agent working with the user toward their goals/);
    expect(stableBody).not.toContain("You are ZCode, an interactive agent");
    expect(stableBody).toContain("# Harness");
    expect(stableBody).not.toContain("# Session-specific guidance");
    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("# Communication Style");
    expect(stableBody).not.toContain("## Current Environment");
    expect(dynamicSystem).not.toContain("## Current Environment");
    expect(dynamicSystem).toMatch(/^\n\nWrite code that reads like the surrounding code/);
    expect(dynamicSystem).toContain("For actions that are hard to reverse or outward-facing");
    expect(dynamicSystem).not.toContain("# Session-specific guidance");
    expect(dynamicSystem).not.toContain("# Environment");
    expect(dynamicSystem).toContain("# Context management");
    expect(stableBody).not.toContain("local AGENTS payload");
    expect(meta).not.toContain("<system-reminder>");
    expect(meta).toContain("Codebase and user instructions are shown below.");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).toContain("local AGENTS payload");
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("Project type: Node.js");
    expect(meta).not.toContain("Package manager: pnpm");
    expect(meta).not.toContain("`test`: vitest");
    expect(meta).not.toContain("## 项目信息");
    expect(metaAttachment(result, "date")).toBe("Today's date is 2026-05-04.");
    expect(meta).not.toContain("</system-reminder>");
    expect(meta).not.toContain("Today's date");

    const sectionTargets = result.sections.map((section) => ({
      name: section.name,
      injectionTarget: section.injectionTarget,
      cacheHint: section.cacheHint,
    }));
    expect(sectionTargets.slice(0, 4)).toEqual([
      { name: "CLI Prefix", injectionTarget: "system", cacheHint: "stable" },
      { name: "Agent Identity", injectionTarget: "system", cacheHint: "stable" },
      { name: "Dynamic Behavior", injectionTarget: "system", cacheHint: "dynamic" },
      { name: "Context Management", injectionTarget: "system", cacheHint: "dynamic" },
    ]);
    expect(sectionTargets).toEqual(
      expect.arrayContaining([
        { name: "Environment Info", injectionTarget: "meta_user", cacheHint: "dynamic" },
        { name: "Context Management", injectionTarget: "system", cacheHint: "dynamic" },
        { name: "Request User Context", injectionTarget: "meta_user", cacheHint: "dynamic" },
        { name: "Current Date", injectionTarget: "meta_user", cacheHint: "dynamic" },
      ]),
    );
  });

  it("renders merged user default and workspace instructions in request user context", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "default instructions\n\nworkspace instructions",
        bytesRead: 43,
        sizeBytes: 43,
        truncated: false,
        sources: [
          {
            scope: "user",
            filePath: "/Users/test/.zcode/AGENTS.md",
            fileName: "AGENTS.md",
            content: "default instructions",
            bytesRead: 20,
            sizeBytes: 20,
            truncated: false,
          },
          {
            scope: "workspace",
            filePath: "/workspace/AGENTS.md",
            fileName: "AGENTS.md",
            content: "workspace instructions",
            bytesRead: 22,
            sizeBytes: 22,
            truncated: false,
          },
        ],
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).toContain("Codebase and user instructions are shown below.");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain(
      "Contents of /Users/test/.zcode/AGENTS.md (user's private global instructions for all projects):",
    );
    expect(meta).toContain(
      "Contents of /workspace/AGENTS.md (project instructions, checked into the codebase):",
    );
    expect(meta.indexOf("default instructions")).toBeLessThan(
      meta.indexOf("workspace instructions"),
    );
    expect(meta.indexOf("Codebase and user instructions")).toBeLessThan(
      meta.indexOf("default instructions"),
    );
    expect(meta).not.toContain("Today's date");
  });

  it("keeps date separate when request user context has no content", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments).toEqual([]);
    const meta = metaAttachment(result, "context_prefix");
    expect(metaAttachment(result, "date")).toBe("Today's date is 2026-05-04.");
    expect(meta).toBe("");
    expect(meta).not.toContain("IMPORTANT: this context may or may not be relevant");
    expect(meta).not.toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).not.toContain("Project context:");
  });

  it("does not render projectContext-only content without user instructions", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      projectContext: {
        type: "node",
        packageManager: "pnpm",
        scripts: {
          build: "pnpm build",
        },
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).not.toContain("# agentsMd");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).not.toContain("Project context:");
    expect(meta).not.toContain("Project type: Node.js");
    expect(meta).not.toContain("Package manager: pnpm");
    expect(meta).not.toContain("`build`: pnpm build");
    expect(meta).not.toContain("Contents of ");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).not.toContain("## 项目信息");
    expect(metaAttachment(result, "date")).toMatch(/^Today's date is /);
  });

  it("renders a resolved instruction source under the instruction preamble", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      userInstructions: {
        filePath: "/workspace/CLAUDE.md",
        fileName: "CLAUDE.md",
        content: "Workspace resolved instruction payload",
        bytesRead: 35,
        sizeBytes: 35,
        truncated: false,
      },
    }).build();

    const meta = metaAttachment(result, "context_prefix");
    expect(meta).toContain("Codebase and user instructions are shown below.");
    expect(meta).not.toContain("# claudeMd");
    expect(meta).toContain(
      "Contents of /workspace/CLAUDE.md (project instructions, checked into the codebase):",
    );
    expect(meta).toContain("Workspace resolved instruction payload");
    expect(meta).not.toContain("# user_instructions");
    expect(meta).not.toContain("Today's date");
  });

  it("does not emit an empty meta user message", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments).toEqual([]);
    expect(result.systemMessages[0]?.content).toBe("You are ZCode, an interactive agent");
    expect(result.systemMessages[1]?.content).not.toContain("# Agent Identity");
    expect(result.systemMessages[1]?.content).toMatch(
      /^\n?You are an agent working with the user toward their goals/,
    );
    expect(result.systemMessages[1]?.content).toContain("# Harness");
    expect(result.systemMessages[1]?.content).not.toContain("# Session-specific guidance");
    expect(result.systemMessages[1]?.content).not.toContain("# Environment");
    expect(result.systemMessages[1]?.content).not.toContain("# Context management");
    expect(result.systemMessages[1]?.content).not.toContain("# Communication Style");
    expect(result.systemMessages[1]?.content).not.toContain(
      "Write code that reads like the surrounding code",
    );
    expect(result.systemMessages[1]?.content).not.toContain("For actions that are hard to reverse");
    expect(result.systemMessages[2]?.content).toMatch(
      /^\n\nWrite code that reads like the surrounding code/,
    );
    expect(result.systemMessages[2]?.content).toContain(
      "For actions that are hard to reverse or outward-facing",
    );
    expect(result.systemMessages[2]?.content).not.toContain("# Session-specific guidance");
    expect(result.systemMessages[2]?.content).not.toContain("# Language");
    expect(result.systemMessages[2]?.content).not.toContain("# Function Result Clearing");
    expect(result.systemMessages[2]?.content).not.toContain("# Summarize Tool Results");
    expect(result.systemMessages[2]?.content).not.toContain("## Current Environment");
    expect(result.systemMessages[2]?.content).not.toContain("# Environment");
    expect(result.systemMessages[2]?.content).toContain("# Context management");
  });

  it("does not mirror registered tools into prompt context", () => {
    const registry = createToolRegistry();
    registry.register(readToolEntry);

    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
    })
      .setToolRegistry(registry)
      .build();

    const promptContext = [
      ...result.systemMessages.map((message) => String(message.content ?? "")),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");

    expect(result.sections.map((section) => section.source)).not.toContain("tools");
    expect(promptContext).not.toContain("## Available Tools");
    expect(promptContext).not.toContain("### Read");
    expect(promptContext).not.toContain("Read-only:");
  });

  it("renders skills as a separate meta user system reminder", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      guidanceToolNames: ["Skill"],
      skills: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "demo-skill",
            description: "Use this for demos",
            path: "/workspace/.zcode/skills/demo/SKILL.md",
            directory: "/workspace/.zcode/skills/demo",
            rootPath: "/workspace/.zcode/skills",
            scope: "project",
            source: "zcode",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    }).build();

    expect(result.systemMessages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
    ]);
    expect(result.metaUserAttachments.map((attachment) => attachment.source)).toEqual([
      "skills_listing",
    ]);
    expect(result.systemMessages[0]?.content).not.toContain("demo-skill");
    expect(result.systemMessages[2]?.content).toContain("# Session-specific guidance");
    expect(result.systemMessages[2]?.content).toContain(
      "# Session-specific guidance\n - When the user types `/<skill-name>`",
    );
    expect(result.systemMessages[2]?.content).not.toContain("`! <command>`");
    expect(result.systemMessages[2]?.content).not.toContain(
      "spawn Agent with subagent_type=Explore",
    );
    expect(result.systemMessages[2]?.content).not.toContain(
      "Use the Agent tool with specialized agents",
    );
    expect(metaAttachment(result, "skills_listing")).not.toContain("<system-reminder>");
    expect(metaAttachment(result, "skills_listing")).toContain(
      "The following skills are available",
    );
    expect(metaAttachment(result, "skills_listing")).toContain("demo-skill");
    expect(metaAttachment(result, "context_prefix")).toBe("");
    expect(metaAttachment(result, "date")).toMatch(/^Today's date is /);
  });

  it("does not mirror available subagents into meta user context", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux 6.6.0",
        nodeVersion: "v24.14.0",
      },
      agentProfiles: [
        {
          name: "zcode-reviewer",
          description: "检查实现边界。",
          source: "user",
          systemPrompt: "只输出中文。",
          tools: ["Read"],
        },
      ],
    }).build();

    const providerContextText = [
      ...result.systemMessages.map((message) => String(message.content)),
      ...result.metaUserAttachments.map((attachment) => attachment.content),
    ].join("\n");

    expect(result.metaUserAttachments.map((attachment) => attachment.source)).not.toContain(
      "subagents" as ContextMetaUserAttachmentSource,
    );
    expect(providerContextText).not.toContain("Available agent types");
    expect(providerContextText).not.toContain("zcode-reviewer");
  });

  it("lists additional working directories after the repository bullet", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      additionalDirectories: ["/work/backend", "C:\\work\\shared folder"],
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "v24",
      },
    }).build();

    const environment = result.sections.find((section) => section.source === "env_info");
    expect(environment?.content).toContain(
      " - Primary working directory: /workspace\n - Is a git repository: false\n - Additional working directories:\n  - /work/backend\n  - C:\\work\\shared folder\n - Platform: linux",
    );
    // 环境由运行时公告下发（见 runtime-context-announcements），builder 不再放进 system。
    expect(
      result.systemMessages.some((message) =>
        String(message.content).includes(environment!.content),
      ),
    ).toBe(false);
  });

  it("keeps the environment prompt unchanged for an absent or empty additional directory list", () => {
    const config = {
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "v24",
      },
    };
    const original = createContextBuilder(config).build();
    const empty = createContextBuilder({ ...config, additionalDirectories: [] }).build();

    expect(empty).toEqual(original);
    expect(
      original.sections.find((section) => section.source === "env_info")?.content,
    ).not.toContain("Additional working directories");
  });

  it("renders environment info copy in English", () => {
    const section = buildEnvInfoSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "main",
      gitMainBranch: "main",
      gitUser: "ZCode Tester <tester@example.com>",
      gitStatus: "clean",
      gitStatusLines: [],
      recentCommits: ["abc123 test commit"],
    });

    expect(section.content).toContain("# Environment");
    expect(section.content).toContain("- Primary working directory: /workspace");
    expect(section.content).not.toContain("Node version");
    expect(section.content).not.toContain("You are powered by");
    expect(section.content).toContain(" - Is a git repository: true");
    expect(section.content).not.toContain("**Git status snapshot**");
    expect(section.content).not.toContain("**Main branch**: main");
    expect(section.content).not.toContain("**Git user**");
    expect(section.content).not.toContain("### Recent commits");
    expect(section.content).not.toContain("当前环境");
    expect(section.content).not.toContain("工作目录");

    const nonGitSection = buildEnvInfoSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: false,
    });
    expect(nonGitSection.content).toContain(" - Is a git repository: false");
    expect(nonGitSection.content).not.toContain("not a git repository");
    expect(nonGitSection.content).not.toContain("- **Git**:");
  });

  it("renders git snapshot text as session_context", () => {
    const section = buildGitSystemContextSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory",
      gitMainBranch: "staging",
      gitUser: "Dev User",
      gitStatus: "dirty",
      gitStatusLines: [
        "M docs/notes/prompt-assembly-notes.md",
        " M docs/notes/tool-descriptions-notes.md",
        " M packages/contracts/src/tools/ask-user-question.ts",
        "?? docs/plan/tool-prompt-plan.md",
      ],
      recentCommits: [
        "ed2cac59d Merge branch 'feat/trajectory' of https://example.com/team/project into feat/trajectory",
        "07957b58c chore: update doc",
      ],
    });

    expect(section?.content).toBe(
      [
        "As you answer the user's questions, you can use the following context:",
        "# gitStatus",
        "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
        "",
        "Current branch: feat/trajectory",
        "",
        "Main branch (you will usually use this for PRs): staging",
        "",
        "Git user: Dev User",
        "",
        "Status:\nM docs/notes/prompt-assembly-notes.md\n M docs/notes/tool-descriptions-notes.md\n M packages/contracts/src/tools/ask-user-question.ts\n?? docs/plan/tool-prompt-plan.md",
        "",
        "Recent commits:\ned2cac59d Merge branch 'feat/trajectory' of https://example.com/team/project into feat/trajectory\n07957b58c chore: update doc",
        "",
        "ZCode attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
      ].join("\n"),
    );
    expect(
      buildGitSystemContextSection({
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
        isGitRepository: true,
      })?.content,
    ).toContain("Status:\n(unknown)");
    expect(
      buildGitSystemContextSection({
        cwd: "/workspace",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 25.4.0",
        nodeVersion: "v24.14.0",
        isGitRepository: false,
        gitStatus: "not_repo",
      }),
    ).toBeNull();
  });

  it("renders an empty recent commits block without placeholder text", () => {
    const section = buildGitSystemContextSection({
      cwd: "/workspace",
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory",
      gitMainBranch: "main",
      gitStatus: "clean",
      gitStatusLines: [],
      recentCommits: [],
    });

    expect(section?.content).toContain("Recent commits:\n");
    expect(section?.content).not.toContain("Recent commits:\n(none)");
  });

  it("renders the fixed ZCode CLI prefix and identity body without duplication", () => {
    const prefixSection = buildCliPrefixSection();
    const identitySection = buildIdentitySection();

    expect(prefixSection.content).toBe("You are ZCode, an interactive agent");
    expect(identitySection.content).toMatch(
      /^\n?You are an agent working with the user toward their goals/,
    );
    expect(identitySection.content).not.toContain("# Agent Identity");
    expect(identitySection.content).not.toContain("You are ZCode, an interactive agent");
    expect(`${prefixSection.content}\n${identitySection.content}`).not.toContain("${");
    expect(`${prefixSection.content}\n${identitySection.content}`).not.toContain("an AI assistant");
  });

  it("describes system-reminder delivery in the Harness when MCS is unavailable", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "24",
      },
      midConversationSystem: false,
    }).build();
    const stableBody = result.systemMessages[1]?.content;

    expect(stableBody).toContain(
      " - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.",
    );
    expect(stableBody).not.toContain("mid-conversation system turns");
  });

  it("includes compact stable body boundaries", () => {
    const section = buildIdentitySection();

    expect(section.content).toMatch(
      /^\n?You are an agent working with the user toward their goals/,
    );
    expect(section.content).not.toContain("# Agent Identity");
    expect(section.content).toContain("# Harness");
    expect(section.content).toContain("IMPORTANT:");
    expect(section.content).toContain("authorized security testing");
    expect(section.content).toContain("Tools run behind a user-selected permission mode");
    expect(section.content).toContain(
      "The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    );
    expect(section.content).not.toContain(
      "<system-reminder> tags in messages and tool results are injected by the harness",
    );
    expect(section.content).not.toContain("Write code that reads like the surrounding code");
    expect(section.content).not.toContain("For actions that are hard to reverse");
    expect(section.content).not.toContain("Report results plainly");
    expect(section.content).not.toContain("# Session-specific guidance");
    expect(section.content).not.toContain("`! <command>`");
    expect(section.content).not.toContain("`/<skill-name>`");
    expect(section.content).not.toContain("# Task Behavior");
    expect(section.content).not.toContain("# Risky Actions");
    expect(section.content).not.toContain("# Communication Style");
  });

  it("includes slash skill guidance in the available-skills metadata", () => {
    const section = buildSkillsSection({
      outcome: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "demo-skill",
            description: "Use this for demos",
            path: "/workspace/.zcode/skills/demo/SKILL.md",
            directory: "/workspace/.zcode/skills/demo",
            rootPath: "/workspace/.zcode/skills",
            scope: "project",
            source: "zcode",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    });

    expect(section?.content).not.toContain("`/<skill-name>`");
    expect(section?.content).not.toContain("Do not guess missing skill names.");
  });

  it("shows plugin-qualified skill names in the available-skills metadata", () => {
    const section = buildSkillsSection({
      outcome: {
        diagnostics: [],
        totalDiscovered: 1,
        skills: [
          {
            name: "test-driven-development",
            description: "Use this for TDD workflows",
            pluginName: "superpowers",
            qualifiedName: "superpowers:test-driven-development",
            path: "/plugins/superpowers/skills/test-driven-development/SKILL.md",
            directory: "/plugins/superpowers/skills/test-driven-development",
            rootPath: "/plugins/superpowers/skills",
            scope: "system",
            source: "plugin",
            safeToAutoLoad: true,
            frontmatterKeys: [],
            policy: { allowImplicitInvocation: true },
          },
        ],
      },
    });

    expect(section?.content).toContain("superpowers:test-driven-development");
    expect(section?.content).toContain("also loadable as test-driven-development");
  });
});

// ── 工作流子代理身份（docs/dynamic-workflow/authoring.md「The system prompt」）──
//
// persona 不再整段替换子代理的系统提示：基座段（CLI prefix、安全行、Harness、memory）保留，
// 交互式身份换成工作流子代理契约，persona 叠加其上；面向「与用户对话」的三段（desktop、
// Dynamic Behavior、session guidance）跳过。
describe("context builder — workflow actor identity", () => {
  const envInfo = {
    cwd: "/workspace",
    platform: "linux",
    shell: "bash",
    osVersion: "Linux 6.6.0",
    nodeVersion: "v24.14.0",
  } as const;

  function systemText(config: Parameters<typeof createContextBuilder>[0]): string {
    return createContextBuilder(config)
      .build()
      .systemMessages.map((message) => String(message.content))
      .join("\n");
  }

  it("stacks the persona on the harness contract instead of replacing the base prompt", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      presentationSurface: "zcode_desktop",
      guidanceToolNames: ["Skill", "Read"],
      workflowActor: { name: "reviewer", persona: "You are a strict reviewer." },
    }).build();
    const text = result.systemMessages.map((message) => String(message.content)).join("\n");

    // 开场句 → persona → 安全行 → Harness → 契约，且顺序固定。
    const opening = text.indexOf(
      'You are a subagent inside a dynamic workflow run, named "reviewer".',
    );
    const persona = text.indexOf("You are a strict reviewer.");
    const security = text.indexOf("IMPORTANT: Assist with authorized security testing");
    const harness = text.indexOf("# Harness");
    const contract = text.indexOf("# Working inside a workflow");
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(opening).toBeLessThan(persona);
    expect(persona).toBeLessThan(security);
    expect(security).toBeLessThan(harness);
    expect(harness).toBeLessThan(contract);

    // 基座里保住的纪律。
    expect(text).toContain("Reference code as `file_path:line_number`");
    expect(text).toContain("Report outcomes faithfully");
    expect(text).toContain("call `escalate`");
    expect(text).toContain("`submit_result`");

    // 交互式身份与面向用户对话的三段不在。
    expect(text).not.toContain("agent working with the user toward their goals");
    expect(text).not.toContain("# Communicating with the user");
    expect(text).not.toContain(EXPECTED_PRONOUNS_PROMPT);
    expect(text).not.toContain("For actions that are hard to reverse");
    expect(text).not.toContain("# Session-specific guidance");
    expect(text).not.toContain("ZCode Desktop");
    // 后续段照常。
    expect(text).not.toContain("# Environment");
  });

  it("omits the named clause and the persona block when the actor has neither", () => {
    const text = systemText({
      workingDirectory: "/workspace",
      envInfo,
      workflowActor: {},
    });
    expect(text).toContain(
      "You are a subagent inside a dynamic workflow run. A script created you",
    );
    expect(text).not.toContain('named "');
    expect(text).toContain("# Working inside a workflow");
    expect(text).not.toContain("agent working with the user toward their goals");
  });

  // 产物（docs/dynamic-workflow/authoring.md「The system prompt」）：子代理仍然没有任何产物工具
  // （只有脚本能发布），但被指名输出路径时必须写到那里并把路径交回来——脚本据此发布给用户。
  it("routes a named output path back through the result instead of forbidding files outright", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo, workflowActor: {} });

    expect(text).toContain(
      "Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
    );
    // 旧句子（无条件劝阻）不得残留：它与「按 ask 指名的路径写文件」直接冲突。
    expect(text).not.toContain("Do not write report or summary files unless the ask tells you to");
    // 子代理仍然没有产物工具：提示里不出现任何 `artifact.*` 的调用面。
    expect(text).not.toContain("artifact.file");
    expect(text).not.toContain("PublishArtifact");
  });

  // 2026-09-05 追记（docs/dynamic-workflow/authoring.md）：实盘零工具的子代理被
  // 「cite what you read or ran」逼去找它没有的工具，发出 `escalate("placeholder")`。修法：先说死
  // 工具面，再说证据从哪来。2026-09-12 起 persona 没有工具档位（docs/dynamic-workflow/authoring.md），
  // 契约只有一份文本。
  it("drops the interactive CLI prefix: the subagent identity is the first system line", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      workflowActor: { name: "judge" },
    }).build();
    const first = String(result.systemMessages[0]?.content);
    expect(
      first.startsWith('You are a subagent inside a dynamic workflow run, named "judge".'),
    ).toBe(true);
    expect(result.sections.map((section) => section.source)).not.toContain("cli_prefix");
    expect(result.systemMessages.map((m) => String(m.content)).join("\n")).not.toContain(
      "You are ZCode, an interactive agent",
    );
  });

  it("states the tool surface and the read-or-ran standard for every actor", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo, workflowActor: {} });
    expect(text).toContain("You have the regular working tools");
    expect(text).toContain("There is no tool that asks a person anything.");
    expect(text).toContain(
      "Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which",
    );
    expect(text).toContain("A check counts as passed only if you executed it here");
    // 2026-09-08 追记：跑 ask 点名的检查，不拿更快的替身顶替。
    expect(text).toContain("Run the check an ask names rather than a faster substitute");
    // 档位时代的两句不得残留（docs/dynamic-workflow/authoring.md）。
    expect(text).not.toContain("read-only");
    expect(text).not.toContain("a capability your tools do not give you");
  });

  it("lists skills only when the Skill tool is actually registered", () => {
    const skills = {
      skills: [
        {
          name: "demo-skill",
          description: "Demo skill",
          path: "/workspace/.zcode/skills/demo/SKILL.md",
          directory: "/workspace/.zcode/skills/demo",
          rootPath: "/workspace/.zcode/skills",
          scope: "project" as const,
          source: "zcode" as const,
          safeToAutoLoad: true,
          frontmatterKeys: [],
          policy: { allowImplicitInvocation: true },
        },
      ],
      diagnostics: [],
      totalDiscovered: 1,
    };
    const sources = (guidanceToolNames: readonly string[] | undefined) =>
      createContextBuilder({
        workingDirectory: "/workspace",
        envInfo,
        skills: skills as never,
        workflowActor: { name: "judge" },
        ...(guidanceToolNames === undefined ? {} : { guidanceToolNames }),
      })
        .build()
        .metaUserAttachments.map((attachment) => attachment.source);

    // 工具表里没有 Skill → 不列技能（列了只会让它相信自己有一个没有的工具）。
    expect(sources(["submit_result", "escalate"])).not.toContain("skills_listing");
    // Skill 在表里 → 照列。
    expect(sources(["Skill", "submit_result", "escalate"])).toContain("skills_listing");
    // 工具表缺席（旧调用方 / 测试）→ 维持旧行为。
    expect(sources(undefined)).toContain("skills_listing");
  });

  it("sends the custom system prompt as given without trimming", () => {
    const custom = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      customSystemPrompt: "  Keep it short.\n",
    }).build();
    // 自定义 prompt 原样发送；开头的 \n 是本块左边界（OpenAI 兼容拼接）。
    expect(custom.systemMessages[1]?.content).toBe("\n  Keep it short.\n");

    const blank = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo,
      customSystemPrompt: " \n",
    }).build();
    expect(blank.sections.some((section) => section.source === "custom_system_prompt")).toBe(false);
  });

  it("refuses workflowActor together with customSystemPrompt", () => {
    expect(() =>
      createContextBuilder({
        workingDirectory: "/workspace",
        envInfo,
        customSystemPrompt: "You are concise.",
        workflowActor: { persona: "You review." },
      }).build(),
    ).toThrow(/mutually exclusive/);
  });

  it("keeps the general-purpose main identity before the security and harness sections", () => {
    const text = systemText({ workingDirectory: "/workspace", envInfo });
    expect(text).toContain(
      "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized security testing",
    );
    expect(text).toContain("\n\n# Harness\n - Text you output outside of tool use");
  });
});

it("separates instruction context from session, environment, model, and date announcements", () => {
  const result = createContextBuilder({
    workingDirectory: "/workspace",
    envInfo: {
      cwd: "/workspace",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux",
      nodeVersion: "24",
      isGitRepository: true,
      gitBranch: "main",
      gitStatus: "clean",
    },
    model: contextTestModel,
    currentDate: "2026-10-14",
    memoryRoot: "/memory",
    memoryIndexContent: "- [Guide](guide.md)",
    userInstructions: {
      filePath: "/workspace/AGENTS.md",
      fileName: "AGENTS.md",
      content: "Project guidance.",
      bytesRead: 17,
      sizeBytes: 17,
      truncated: false,
    },
  }).build();
  const bySource = new Map(
    result.metaUserAttachments.map((item) => [String(item.source), item.content]),
  );
  expect(bySource.get("context_prefix")).toMatch(/^Codebase and user instructions/);
  expect(bySource.get("context_prefix")).not.toMatch(
    /# agentsMd|currentDate|As you answer|attached this context/,
  );
  expect(metaAttachment(result, "environment")).toBe(
    "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /workspace\n - Is a git repository: true\n - Platform: linux\n - Shell: bash\n - OS Version: Linux\n - Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.",
  );
  expect([...bySource.keys()]).toEqual(["context_prefix", "session_context"]);
});

// 行数截断的说明文字由 persistent-agent-memory 测试覆盖（同一 formatter）。
it("keeps retained Memory index content and reports a cut within the first line", async () => {
  const lines = Array.from({ length: 205 }, (_, index) => `Entry ${index + 1}`);
  const actual = formatMemoryIndexContent(lines.join("\n"));
  expect(actual).toContain(lines.slice(0, 200).join("\n"));
  expect(formatMemoryIndexContent("x".repeat(25_001))).toContain(
    "everything after the first 25000 characters of line 1 was cut off",
  );
});

it("shortens the first omitted Memory line at a word boundary without splitting Unicode", () => {
  const prefix = Array.from({ length: 200 }, (_, i) => `Entry ${i + 1}`).join("\n");
  const longLine =
    "This is a deliberately long index entry whose first omitted line needs a readable preview rather than a broken word";
  expect(formatMemoryIndexContent(`${prefix}\n${longLine}`)).toContain(
    'starting at line 201 ("This is a deliberately long index entry whose first omitted line needs a…")',
  );
  const unicodeLine = "x".repeat(78) + "🧪" + "x".repeat(10);
  expect(formatMemoryIndexContent(`${prefix}\n${unicodeLine}`)).toContain(
    `starting at line 201 ("${"x".repeat(78)}…")`,
  );
  // 切口正好落在空白上：词边界就是这个空白，预览保留它前面的整个词。
  const spaceAtCut = `${"x".repeat(50)} ${"y".repeat(27)} ${"z".repeat(20)}`;
  expect(formatMemoryIndexContent(`${prefix}\n${spaceAtCut}`)).toContain(
    `starting at line 201 ("${"x".repeat(50)} ${"y".repeat(27)}…")`,
  );
});

it("preserves custom meta sections in the instruction carrier", () => {
  const result = createContextBuilder({
    workingDirectory: "/workspace",
    envInfo: {
      cwd: "/workspace",
      platform: "linux",
      shell: "bash",
      osVersion: "test",
      nodeVersion: "24",
    },
  })
    .addSection({
      name: "Custom guidance",
      source: "tools",
      injectionTarget: "meta_user",
      content: "custom context",
      preview: "custom",
    })
    .build();
  expect(metaAttachment(result, "context_prefix")).toBe("custom context");
});
