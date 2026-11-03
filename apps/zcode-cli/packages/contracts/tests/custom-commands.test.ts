import { describe, expect, it } from "vitest";
import {
  expandCustomCommandPrompt,
  splitCustomCommandArguments,
  type CustomCommandContent,
} from "../src/commands/index.js";

describe("custom command expansion", () => {
  it("expands all and positional arguments without shell parsing", () => {
    const command = createCommand("Review $ARGUMENTS then run $1 for $2.");
    const expanded = expandCustomCommandPrompt({
      args: '"auth flow" high',
      command,
    });

    expect(expanded.argumentCount).toBe(2);
    expect(expanded.prompt).toContain('Review "auth flow" high');
    expect(expanded.prompt).toContain("then run auth flow for high");
  });

  it("appends arguments when the template has no placeholders", () => {
    const expanded = expandCustomCommandPrompt({
      args: "src/auth.ts",
      command: createCommand("Review the code."),
    });

    expect(expanded.prompt).toContain("Review the code.");
    expect(expanded.prompt).toContain("User arguments:\nsrc/auth.ts");
  });

  it("hands shell blocks to the model instead of failing, and leaves argument text alone", () => {
    const expanded = expandCustomCommandPrompt({
      args: "!`touch arg-marker`",
      command: createCommand(
        "Run !`git status`, then summarize.\n```!\nls\npwd\n```\nShow a `Warning!` banner and a `Done` badge.\nFocus: $ARGUMENTS",
      ),
    });

    const handOff =
      "[This shell step comes from the /demo command file (project/zcode), not from ZCode. Run it with the Bash tool exactly as written and use its output here, unless it looks unsafe or unrelated to the user's request:]";
    // 行内块后面的原文另起一行，代码块的结束标记才成立。
    expect(expanded.prompt).toContain(
      `Run ${handOff}\n\`\`\`bash\ngit status\n\`\`\`\n, then summarize.`,
    );
    expect(expanded.prompt).toContain(`${handOff}\n\`\`\`bash\nls\npwd\n\`\`\`\n`);
    expect(expanded.prompt).toContain("Show a `Warning!` banner and a `Done` badge.");
    expect(expanded.prompt).toContain("Focus: !`touch arg-marker`");
  });

  it("keeps session variables for the Bash environment and holds back variables it cannot resolve", () => {
    const expanded = expandCustomCommandPrompt({
      args: "",
      command: createCommand(
        [
          '!`rm -rf "${CLAUDE_PROJECT_DIR:-.}/build" $ZCODE_SESSION_ID`',
          '!`cat "${CLAUDE_SKILL_DIR}/notes.md"`',
          '!`ls "$CLAUDE_PLUGIN_ROOT"`',
        ].join("\n"),
      ),
    }).prompt;

    // 会话 ID 与工作区目录由 Bash 环境变量提供，块里保持原文（含修饰符写法）。
    expect(expanded).toContain(
      '```bash\nrm -rf "${CLAUDE_PROJECT_DIR:-.}/build" $ZCODE_SESSION_ID\n```',
    );
    // Bash 环境里没有的变量会被 shell 展开成空串，整块只留说明。
    expect(expanded).toContain(
      "[A shell step from the /demo command file (project/zcode) was not run: it uses ${CLAUDE_SKILL_DIR}, which cannot be resolved here.]",
    );
    expect(expanded).toContain("it uses $CLAUDE_PLUGIN_ROOT, which cannot be resolved here.");
    expect(expanded).not.toContain("notes.md");
  });

  it("resolves plugin variables in plugin commands and holds back modifier forms", () => {
    const command = createCommand(
      [
        '!`"${CLAUDE_PLUGIN_ROOT}/s.sh" "$ZCODE_PLUGIN_DATA" ${ZCODE_PLUGIN_ID} $ZCODE_PLUGIN_NAME $CLAUDE_PLUGIN_ROOTS`',
        '!`ls "${CLAUDE_PLUGIN_ROOT%/}"`',
        "!`echo ${#ZCODE_PLUGIN_ROOT}`",
      ].join("\n"),
    );
    command.metadata = {
      ...command.metadata,
      plugin: { dataPath: "/data/p", id: "p@market", name: "p", rootPath: "/plugins/p" },
      scope: "user",
      source: "plugin",
    };

    const expanded = expandCustomCommandPrompt({ args: "", command }).prompt;
    // 只替换完整变量名；`$CLAUDE_PLUGIN_ROOTS` 是另一个变量，保持原文。
    expect(expanded).toContain(
      '```bash\n"/plugins/p/s.sh" "/data/p" p@market p $CLAUDE_PLUGIN_ROOTS\n```',
    );
    expect(expanded).toContain(
      "[A shell step from the /demo command file (user/plugin) was not run: it uses ${CLAUDE_PLUGIN_ROOT%/}, which cannot be resolved here.]",
    );
    expect(expanded).toContain("it uses ${#ZCODE_PLUGIN_ROOT}, which cannot be resolved here.");
  });

  it("writes Windows plugin paths with forward slashes, quoted or not", () => {
    const command = createCommand(
      ["!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh`", '!`ls "$ZCODE_PLUGIN_DATA"`'].join("\n"),
    );
    command.metadata = {
      ...command.metadata,
      plugin: {
        dataPath: "\\\\server\\share\\data\\p",
        id: "p@market",
        name: "p",
        rootPath: "C:\\Users\\dev\\.zcode\\plugins\\p",
      },
      scope: "user",
      source: "plugin",
    };

    const expanded = expandCustomCommandPrompt({ args: "", command }).prompt;
    // Git Bash 会去掉引号外的反斜杠；正斜杠写法在引号内外都保持原路径。
    expect(expanded).toContain("```bash\nbash C:/Users/dev/.zcode/plugins/p/scripts/run.sh\n```");
    expect(expanded).toContain('```bash\nls "//server/share/data/p"\n```');
  });

  it("splits quoted arguments consistently", () => {
    expect(splitCustomCommandArguments("'one two' three\\ four")).toEqual([
      "one two",
      "three four",
    ]);
  });
});

function createCommand(content: string): CustomCommandContent {
  return {
    bytesRead: content.length,
    content,
    metadata: {
      allowedTools: [],
      description: "Demo command",
      disableNonInteractive: false,
      frontmatterKeys: [],
      name: "demo",
      path: "/tmp/demo.md",
      rootPath: "/tmp",
      scope: "project",
      source: "zcode",
    },
    sizeBytes: content.length,
    truncated: false,
  };
}
