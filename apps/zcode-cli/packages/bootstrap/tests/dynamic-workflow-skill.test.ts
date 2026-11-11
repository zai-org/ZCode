// ============================================================
// bundled-skills: builtin /workflow command + dynamic-workflows skill tripwire
// ============================================================
// 契约见 docs/dynamic-workflow/authoring.md「The `/workflow` command and the skill」。
//
// 这套断言守的是一件事：**技能正文与 facade 同步，且 facade 只出现一次**。2026-09-21 起 facade 的
// .d.ts 不再随 CreateWorkflow 的描述每次请求重发（那是约 4.4k token），而是逐字嵌在 SKILL.md
// §16.2 的标记块里，由 resolveInput 上的技能门保证模型写脚本之前读过。标记块之外的正文不得再抄
// 任何一段签名——第二份必然漂移。因此这里（1）钉住标记块与 FACADE_DTS 逐字相等，（2）从
// FACADE_DTS 派生正文允许的成员集合——facade 一改，本文件就红，而不是让正文默默烂掉。
//
// 另有一条负向断言：另一套常见的 Workflow 工具 API（pipeline/parallel/
// budget.total…）与本 facade 形近而实不同。它的词汇一旦漏进正文，模型会写出编译不过的脚本，且诊断信息
// 指向的是"不存在的标识符"而非"你用错了 API"，极难自查。`phase` 是这份名单里唯一被撤下的：
// dwf 自己有了 `phase("名字")` 阶段标注（docs/dynamic-workflow/presentation.md），黑名单
// 因此变成假阳性，改由「marker 形态」正向断言接管。
//
// 2026-09-21 起命令与技能都不再随 zcode-guide 插件发布：命令编进 CLI（builtin-workflow-command.ts），
// 技能进 packages/bundled-skills（bundled-skills.ts）。插件一被卸载/停用，入口就整体消失的事故形态
// 由此关闭；本文件同时钉住两件资产的新住址。

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import { analyzeWorkflowScript, compileWorkflowScript, FACADE_DTS } from "@zcode/dynamic-workflow";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  resolveBundledSkillRoots,
} from "../src/app/bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "../src/app/dynamic-workflow-gate.js";
import {
  resolveZCodeBuiltinPromptCommand,
  resolveZCodeBuiltinPromptCommandInvocation,
} from "../src/builtin-prompt-command.js";
import {
  BUILTIN_WORKFLOW_COMMAND,
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "../src/builtin-workflow-command.js";

const PACKAGES_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACK_ROOT = join(PACKAGES_ROOT, "bundled-skills");
const SKILL_NAME = DYNAMIC_WORKFLOW_SKILL_NAME;
const SKILL_DIR = join(PACK_ROOT, "skills", SKILL_NAME);
/** zcode-guide 仍是一个普通插件技能根：用来证明灰度门不会连坐技能包之外的技能。 */
const GUIDE_PLUGIN_SKILLS_ROOT = join(PACKAGES_ROOT, "zcode-guide-plugin", "skills");

/** 技能正文三件套：SKILL.md 常驻，另两份由模型按需 Read。 */
const SKILL_FILES = ["SKILL.md", "patterns.md", "examples.md"] as const;

/** adapters/src/skills/index.ts:20 —— 超长直接丢弃技能，不是警告。 */
const MAX_DESCRIPTION_LENGTH = 1024;
/** core/src/context/sections/skills.ts:10 —— 会话清单里每条描述只露出这么多字符。 */
const LISTING_DESCRIPTION_CHARS = 250;
/**
 * core/src/tool/handlers/skill.ts 的 WORKFLOW_SKILL_MAX_BYTES —— 这份技能专有的上限（其余技能是
 * 100 000）。超出即截断，而截掉的会是 §16 的契约。
 */
const SKILL_TOOL_MAX_BYTES = 200_000;
/** SKILL.md §16.2 里逐字嵌入 FACADE_DTS 的标记块。 */
const FACADE_BLOCK_START = "<!-- facade-dts:start -->";
const FACADE_BLOCK_END = "<!-- facade-dts:end -->";
const FACADE_BLOCK_PATTERN = /<!-- facade-dts:start -->[\s\S]*?<!-- facade-dts:end -->/g;

/** 负向断言（declare / phase 形态 / 外来词汇）看的是正文，不看那一块 ambient 声明。 */
function stripFacadeBlock(text: string): string {
  return text.replace(FACADE_BLOCK_PATTERN, "");
}

async function readSkillFile(name: string): Promise<string> {
  return readFile(join(SKILL_DIR, name), "utf8");
}

async function readAllContent(): Promise<{ name: string; text: string }[]> {
  const skills = await Promise.all(
    SKILL_FILES.map(async (name) => ({ name, text: stripFacadeBlock(await readSkillFile(name)) })),
  );
  return [...skills, { name: "builtin /workflow", text: BUILTIN_WORKFLOW_COMMAND.content }];
}

/** 抽 `---` 包裹的 flat frontmatter；解析规则对齐 adapters 的 parseFlatYaml（只认顶层标量）。 */
function parseFlatFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end === -1) return {};
  const entries: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    entries[key] = raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  }
  return entries;
}

describe("builtin /workflow command", () => {
  it("declares the skill it depends on and passes the user's request through", () => {
    // skills: 会让 contracts 的 formatCommandSkillInstructions 生成 "先调 Skill 工具" 前置指令。
    // 名字写错不会报错，只会静默失去技能加载——所以钉住它等于技能目录名。
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.name).toBe(BUILTIN_WORKFLOW_COMMAND_NAME);
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.skills).toEqual([SKILL_NAME]);
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.description).toBeTruthy();
    expect(BUILTIN_WORKFLOW_COMMAND.metadata.argumentHint).toBeTruthy();

    // 没有 $ARGUMENTS 时 expandCustomCommandTemplate 会把参数追加成 "User arguments:" 尾块，
    // 位置不受控；命令的正文要自己决定用户请求落在哪。
    expect(BUILTIN_WORKFLOW_COMMAND.content).toContain("$ARGUMENTS");

    const prompt = expandBuiltinWorkflowCommandPrompt("ship the release");
    expect(prompt).toContain(`Required skills: \`${SKILL_NAME}\`.`);
    expect(prompt).toContain(`call the Skill tool for \`${SKILL_NAME}\``);
    expect(prompt).toContain("ship the release");
    expect(prompt).toContain("`CreateWorkflow`");
    expect(prompt).not.toContain("$ARGUMENTS");
  });

  it("expands through the builtin prompt resolver, and not while the gray gate is off", () => {
    // DWG-03：目录侧剔除了它，但用户仍可手打命令名，两条路径必须给出同一个结论。
    expect(resolveZCodeBuiltinPromptCommand("/workflow ship it")).toContain("ship it");
    expect(
      resolveZCodeBuiltinPromptCommand("/workflow ship it", { dynamicWorkflowEnabled: true }),
    ).toContain("ship it");
    expect(
      resolveZCodeBuiltinPromptCommand("/workflow ship it", { dynamicWorkflowEnabled: false }),
    ).toBe(undefined);
    // 无参数也展开：模型会按技能自行向用户要任务，而不是把 "/workflow" 当普通文本。
    expect(resolveZCodeBuiltinPromptCommand("/workflow")).toContain("Required skills");
    expect(resolveZCodeBuiltinPromptCommand("please /workflow now")).toBe(undefined);
  });

  // launch.md「On demand: activation」：装配层要知道展开的是哪个命令，才能在 `/workflow` 上挂激活。
  it("invocation 形态带命令名", () => {
    expect(resolveZCodeBuiltinPromptCommandInvocation("/workflow ship it")).toMatchObject({
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
    });
    expect(resolveZCodeBuiltinPromptCommandInvocation("/WORKFLOW ship it")?.name).toBe(
      BUILTIN_WORKFLOW_COMMAND_NAME,
    );
    expect(resolveZCodeBuiltinPromptCommandInvocation("/init")?.name).toBe("init");
    expect(
      resolveZCodeBuiltinPromptCommandInvocation("/workflow x", { dynamicWorkflowEnabled: false }),
    ).toBeUndefined();
    expect(resolveZCodeBuiltinPromptCommandInvocation("/unknown")).toBeUndefined();
  });
});

describe("bundled dynamic-workflows skill", () => {
  it("loads: name matches the directory, description fits the loader's cap", async () => {
    const frontmatter = parseFlatFrontmatter(await readSkillFile("SKILL.md"));

    expect(frontmatter.name).toBe(SKILL_NAME);
    expect(frontmatter.description).toBeTruthy();
    expect(frontmatter.description.length).toBeLessThan(MAX_DESCRIPTION_LENGTH);

    // 自动触发只看得见前 250 字符，所以触发词必须前置——而且必须是 CreateWorkflow 这个专名，
    // 不能是泛泛的 "multi-agent"：后者会在 Agent 工具才是正解的场合把模型拽向 workflow。
    expect(frontmatter.description.slice(0, LISTING_DESCRIPTION_CHARS)).toContain("CreateWorkflow");
  });

  it("ships every file the pack contract pins, and the pack pins every file shipped", async () => {
    const contents = await Promise.all(SKILL_FILES.map((name) => readSkillFile(name)));
    for (const text of contents) expect(text.length).toBeGreaterThan(0);

    // 双向对齐：技能目录里的每个文件都是必需资产（bundled-skills.ts 缺一拒绝整包），
    // 契约里也不得残留已不存在的文件（否则 stage/SEA 构建永远失败）。
    const pinned = new Set(BUNDLED_SKILL_PACK_REQUIRED_PATHS);
    for (const name of SKILL_FILES) expect(pinned).toContain(`skills/${SKILL_NAME}/${name}`);
    expect(pinned.size).toBe(SKILL_FILES.length);
  });

  it("embeds the facade verbatim, once, and stays under the Skill tool's byte cap", async () => {
    const skill = await readSkillFile("SKILL.md");
    // docs/dynamic-workflow/authoring.md「The authoring surface」：标记块里是编译器吃的同一个常量，
    // 逐字相等——模型读到的契约不可能漂离能编译过的东西。
    const block = `${FACADE_BLOCK_START}\n\`\`\`ts\n${FACADE_DTS.trim()}\n\`\`\`\n${FACADE_BLOCK_END}`;
    expect(skill.split(block)).toHaveLength(2);
    expect(skill.match(FACADE_BLOCK_PATTERN)).toHaveLength(1);
    // 技能是 Skill 工具一次性返回的正文；超过上限会被从尾部截掉，而 §16 正在尾部。
    expect(Buffer.byteLength(skill, "utf8")).toBeLessThan(SKILL_TOOL_MAX_BYTES);
  });

  it("carries the contract the tool descriptions used to carry", async () => {
    // 描述收短后，这些句子只活在这里（core/tests/workflow-routing-hints.test.ts 钉的是描述那一侧）。
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("## 16. Tool reference");
    expect(skill).toContain("refuses\nto run until this skill has been loaded");
    expect(skill).toContain("**Three sources; pass exactly one.**");
    expect(skill).toContain(
      "Running a saved workflow\n  is the one call that does not need this skill loaded",
    );
    expect(skill).toContain("`max_concurrency`");
    expect(skill).toContain("`subagent_model`");
    expect(skill).toContain("do not imitate it");
    expect(skill).toContain("Never use the `declare` modifier");
    expect(skill).toContain("`noUncheckedIndexedAccess` off");
    expect(skill).toContain("needs no guard");
    expect(skill).toContain("No `export` statements");
    expect(skill).toContain("No `import` statements");
    expect(skill).toContain("compile-time string\n  literal");
    expect(skill).toContain("standalone\n  statement");
    expect(skill).toContain("Two markers\n  with the same name are one phase");
    expect(skill).toContain("unique within the\n  run");
    expect(skill).toContain("Model-side errors never reach the script");
    expect(skill).toContain("`ContextLimit`");
    expect(skill).toContain("Never put the same content in both");
    expect(skill).toContain("never\n  paste the script a second time");
    expect(skill).toContain("### 16.4 `AmendWorkflow`");
    expect(skill).toContain("`script_unchanged`");
    // 沿用规则按固定顺序：脚本先（两个来源字段都不给）、并发、子代理模型；就地调并发那一句紧贴并发
    // 字段（docs/dynamic-workflow/launch.md「What the model is told」，2026-09-21 起由技能承载）。
    const amend = skill.slice(skill.indexOf("### 16.4 `AmendWorkflow`"), skill.indexOf("### 16.5"));
    const keptScript = amend.indexOf("Omit both to keep the predecessor's script");
    const limit = amend.indexOf("- `max_concurrency`: omit to keep the predecessor's limit");
    const inPlace = amend.indexOf("retunes that run in place");
    const model = amend.indexOf("- `subagent_model`: omit to keep the predecessor's choice");
    expect(keptScript).toBeGreaterThan(-1);
    expect(keptScript).toBeLessThan(limit);
    expect(limit).toBeLessThan(inPlace);
    expect(inPlace).toBeLessThan(model);
    expect(amend).toContain("`path` or `script`, never both. `path` is the usual form");
    expect(skill).toContain("picks that\nask up where it left off");
    // 缓存的精确规则（docs/dynamic-workflow/launch.md「What the model is told」）：首次写工作区之后，只有
    // 读过/跑过的子代理的 ask 转为实跑，只作答的 ask 继续命中。§13 曾把它说成「之后一切都实跑」，与
    // 描述矛盾；描述收短后技能是唯一出处，两处必须同一个说法。
    expect(skill).toContain("**How the cache works.**");
    expect(skill).toContain("Asks that only\nanswered keep settling from the cache");
    expect(skill).not.toContain(
      "every ask to any subagent runs live even if its text is unchanged",
    );
    expect(skill).toContain("### 16.5 `SaveWorkflow`");
    expect(skill).toContain("Never unsolicited");
    expect(skill).toContain("`script_path`");
    expect(skill).toContain("### 16.6 `EvalWorkflowSnippet`");
    expect(skill).toContain("do not exist here and\n  fail typechecking");
  });

  it("never restates the facade outside its marked block", async () => {
    for (const { name, text } of await readAllContent()) {
      // 标记块（§16.2）是唯一的 ambient 声明来源。正文里再出现 `declare ` 意味着抄了一份签名进来，
      // 也意味着模型会看到两份、且其中一份会漂移。
      expect(text, name).not.toMatch(/\bdeclare\s/);
      // RULES 已经禁掉这三样；示例里出现就是在示范违规。
      expect(text, name).not.toMatch(/^\s*import\s/m);
      expect(text, name).not.toMatch(/^\s*export\s/m);
    }
  });

  it("mentions only facade members that actually exist", async () => {
    for (const { name, text } of await readAllContent()) {
      for (const [, container, member] of text.matchAll(
        // artifact 加入扫描面：产物成员名（file/markdown/chart/table/metrics/board）里有四个
        // 是普通英文词，正文写错一个字母不会像 `glob` 那样显眼。`artifact.*` 这种散文写法
        // 匹配不到（`*` 不是标识符首字符），所以只有真调用会被查。
        /\b(artifact|files|git|world)\.([A-Za-z_$][\w$]*)/g,
      )) {
        expect(FACADE_DTS, `${name}: ${container}.${member}`).toContain(`${member}(`);
      }
    }
  });

  it("teaches world.run and the EvalWorkflowSnippet pre-flight (amendment 1)", async () => {
    // docs/dynamic-workflow/authoring.md「The skill」：确定性门控归 world.run、片段预检归
    // EvalWorkflowSnippet。正文丢了任何一个，指导面就静默塌回「一切效应都外包给 actor」。
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("world.run");
    expect(skill).toContain("EvalWorkflowSnippet");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("world.run");
  });

  // docs/dynamic-workflow/authoring.md「The guidance」。产物是 run 交给用户的唯一通道，而
  // facade 只给签名：不写进 §9，模型会继续把子代理产出的 pdf 留在工作区，或者把同一段
  // markdown 同时塞进 return 和产物。三条正向断言分别钉住三种成员的判断依据。
  it("teaches artifact delivery: file, markdown and the report-fed dashboard (amendment 6)", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Deliver artifacts.**");
    expect(skill).toContain('report(item, "perf")');
    expect(skill).toContain("compile-time string literals");
    // 拒绝是可接的，而且拒绝那一刻正是把缺口交回子代理的时机——产物族里唯一的控制流教学点。
    expect(skill).toContain("reject catchably");
  });

  it("teaches no persona knob: neither a tool profile nor a model tier (amendments 7–8)", async () => {
    // docs/dynamic-workflow/authoring.md：`tools` 与模型档位都已退场。技能正文里再出现任何一个，
    // 就是在教一个编译不过的成员；「只读」的说法也一并禁掉——每个子代理都有完整工作工具集，
    // 不改文件是 ask 说的，不是档位保证的。2026-09-26 起 persona 可以点名一个**具体**模型
    // （「Choosing a model per subagent」），所以 `model:` 本身合法，被禁的只是档位词。
    for (const { name, text } of await readAllContent()) {
      expect(text, `${name}: persona tools`).not.toMatch(/\btools:\s*"/);
      expect(text, `${name}: persona model tier`).not.toMatch(
        /\bmodel:\s*"(lite|main|fast|strong)"/,
      );
      // `"none"` 不在表里：`let feedback = "none"` 这类普通字符串是合法示例。
      expect(text, `${name}: tool profile vocabulary`).not.toMatch(
        /ToolProfile|"readonly"|read-only subagent/,
      );
    }
  });

  // docs/dynamic-workflow/authoring.md「The skill」：流水线是默认姿态——每个条目一做完就进下一阶段，
  // 只有下一步需要全部条目的地方才等齐。2026-09-30 之前 §7 以「只在数据需要全体时 join」立题，
  // 读起来像「少设屏障」，而不是「默认流水线」；模型写出的脚本于是一阶段一屏障。
  it("teaches pipelining as the default and a join as the exception", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain(
      "## 7. Pipeline by default; join only where the next step needs every item",
    );
    expect(skill).toContain("each item moves on the moment it is ready");
    expect(skill).toContain("**Decide, at every hand-off, how an item leaves its stage:**");
    expect(skill).toContain("a join, with a comment saying what needs every item");
    // §2 把它列为拓扑决策之一，§3 把它列入提交前自查。
    expect(skill).toContain("**Where each item goes next.**");
    expect(skill).toContain("at every `Promise.all`\nask whether the next step needs every item");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("**Start with the pipeline shapes.**");
    expect(patterns).toContain("## 6. Staged handoff with typed results");
    // 路由模式（#13）曾是两道屏障：先全部分诊，再全部作答。分诊与作答一对一，所以按条串起来。
    expect(patterns).not.toContain('phase("Decide which model each question needs")');
    expect(patterns).toContain(
      'phase("Route each question to the model it needs and answer it there")',
    );
  });

  // docs/dynamic-workflow/authoring.md「Choosing a model per subagent」：两种写法、一个路由模式，
  // 技能正文与 patterns.md 各钉一处；路由脚本本身带 `<!-- compile -->`，由下面的编译守卫验。
  it("teaches the per-subagent model: a literal, a model() table, and routing by a typed key", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Per-subagent model**");
    expect(skill).toContain('agent("judge", { model: "GLM-5.3-Flash" })');
    expect(skill).toContain("`ListModels`");
    expect(skill).toContain("(`patterns.md` #13)");
    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("## 13. Model routing");
    expect(patterns).toContain("model: MODELS[route.tier]");
  });

  it("does not leak the other Workflow API's vocabulary", async () => {
    // 这些标识符属于另一套 Workflow 工具 API，不属于本 facade。漏进来的后果是脚本编译不过，
    // 而诊断只会说"找不到 pipeline"，读起来像 facade 缺功能，而不像"你记错了是哪套 API"。
    const foreign = [
      /\bpipeline\(/,
      /\bparallel\(/,
      // 已删除的 run 级 `budget` 全局（remainingTokens / remainingNodes）与另一套 API 的同名读法不该
      // 出现。persona 的 `budget: { webSearch }`（authoring.md「A subagent's search budget」）是合法
      // 写法，所以只禁这些读法，不再禁整个词。
      /\bbudget\s*\(/,
      /\bbudget\.remaining/,
      /\bremaining(Tokens|Nodes)\b/,
      /\bdeclare const budget\b/,
      /\bagentType\b/,
      /\bisolation:/,
      /\beffort:/,
      /\bschema:/,
    ];
    for (const { name, text } of await readAllContent()) {
      for (const pattern of foreign) {
        expect(text, `${name}: ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("uses phase() in the dwf marker form, never the other Workflow API's", async () => {
    // `phase(` 曾在上面的 foreign 名单里（两套 API 都有 phase），dwf 补上阶段标注后它成了
    // 真 facade 成员，黑名单变成假阳性，把唯一的分组教学面挡在门外。改成正向断言：出现即
    // 必须是 marker 形态 `phase("字面量")`。两套 API 的调用形状几乎同形，所以真正的判别力
    // 在别处——同组 foreign 项（pipeline/parallel/schema:…）仍在，且下面的编译守卫会让
    // 任何非 dwf 的 phase 用法在真编译器上炸掉。
    for (const { name, text } of await readAllContent()) {
      for (const [call] of text.matchAll(/\bphase\([^)]*\)/g)) {
        expect(call, `${name}: ${call}`).toMatch(/^phase\("[^"]+"\)$/);
      }
    }
  });

  // docs/dynamic-workflow/authoring.md「The skill」：门要与任务的验收标准同尺度——先盘点仓库的
  // 检查面，快的一层驱动循环，最强的一层决定出口；示例本身不能再是弱门（§8 只门 cargo test、
  // examples #4 把 `lake env lean` 当 real checker）。
  it("teaches gate adequacy: survey the repository's checks, strongest tier decides the exit", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("**Choose the gate before you write it.**");
    expect(skill).toContain("**Gate at the task's scale.**");
    expect(skill).toContain("Run the end-to-end suite once before handing over");
    // §8 的优化循环：单测驱动轮次，bench 决定 winner，而不是量完基线就再也不测。
    expect(skill).toContain('phase("Measure whether it is actually faster")');
    expect(skill).not.toContain('phase("Verify it actually works")');

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain('!check.stderr.includes("sorry")');
    expect(patterns).toContain("Build the whole project once before handing over");

    const examples = await readSkillFile("examples.md");
    expect(examples).toContain("Run the whole test suite once over the migrated tree");
    expect(examples).toContain("Build the whole project with the new proof");
    expect(examples).toContain("Run the property tests for real");
  });

  // docs/dynamic-workflow/authoring.md「The skill」：显式 workflow 请求默认取厚、发现必经独立确认
  // 且未确认者保留标注、最终返回值取报告形态。三条都是文字守卫，防止再平衡被下一次润色抹掉。
  it("teaches verify-before-report, the unconfirmed label, and the report shape", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain("## The bar: first-class, expert-level work");
    expect(skill).toContain("## 3. Fresh eyes");
    expect(skill).toContain("Ask for failures, not approval.");
    expect(skill).toContain("An explicit workflow request is a request for depth");
    expect(skill).toContain(
      "**Verify before you report, in proportion to what a wrong claim costs.**",
    );
    expect(skill).toContain("`unconfirmed`");
    expect(skill).toContain("interface WorkflowReport");
    expect(skill).toContain("notCovered");
    expect(skill).not.toContain("not to your ambition");

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("confirmer-");
    const examples = await readSkillFile("examples.md");
    expect(examples).toContain("conclusion:");
    expect(examples).toContain("notCovered:");
  });

  // docs/dynamic-workflow/authoring.md「The skill」：验证与代价成比例、阶段间按条流水
  // 而不是一律 Promise.all 屏障、发现脚本有错时停下当场修订。三条都曾是 skill 自己教出来的行为
  //（本机 72 个 run：0 份脚本按条流水、37 份在验证阶段前设全屏障、0 次 cancelled 前驱的修订），
  // 所以既钉住新说法，也钉住旧示例（先审全部文件、再确认全部发现）不再回来。
  it("teaches proportional verification, per-item streaming, and mid-run repair (amendment 10)", async () => {
    const skill = await readSkillFile("SKILL.md");
    // 2026-09-30 起 §7 以「默认流水线」立题（见上一条用例）；按条串接的规则住在 **Chaining.** 段。
    expect(skill).toContain("**Chaining.** When two stages map one to one");
    expect(skill).toContain("**Not inside a concurrent fan-out callback.**");
    expect(skill).toContain("Three things that look like verification and are waste.");
    expect(skill).toContain("**Repair a run while it is still going.**");
    expect(skill).toContain("`Promise.allSettled`");
    // 完整示例（2026-09-21 起在 examples.md §5）按条流水：确认者链在各自文件的评审之后，名字带路径
    // 与序号；旧的屏障式阶段名不再出现。SKILL.md §11 只留指路。
    expect(skill).toContain("## 11. A complete example");
    expect(skill).toContain("`${ZCODE_SKILL_DIR}/examples.md` §5");
    const movedExample = await readSkillFile("examples.md");
    expect(movedExample).toContain("## 5. Changed-file review with confirmation as reviews land");
    expect(movedExample).toContain("confirmer-${p}-${index}");
    expect(movedExample).not.toContain(
      'phase("Confirm each kept finding independently and report it")',
    );
    // 过时的缓存关门说法（工具档位 2026-09-12 已退场）不得回来。
    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/first subagent with tools/i);
    }

    const patterns = await readSkillFile("patterns.md");
    expect(patterns).toContain("## 10. Per-item pipeline");
    expect(patterns).toContain("A queue is not a barrier");
    const examples = await readSkillFile("examples.md");
    expect(examples).toContain(
      'phase("Judge each candidate and confirm the real ones as they are judged")',
    );
    expect(examples).not.toContain('phase("Confirm each survivor by reproducing it")');
  });

  // 脚本文件（docs/dynamic-workflow/launch.md「Script files」）：每次提交的脚本都有一个磁盘文件，
  // 内联脚本由工具写进 `.zcode/workflow-drafts/<slug>.dwf.ts`，诊断按文件行号给出，之后的每一次
  // 修订都是「改那个文件 + 用 `path` 重新提交」。这三句是承重话，必须逐字在 skill 里：模型一旦回到
  // 整段重贴，就同时踩中两个实测代价——约两万 token 的脚本重新流式输出会被部分 provider 卡死，
  // 而 run 真正出错时脚本正文往往已被 compaction 丢出上下文，只有文件还在。
  it("teaches the script-file loop: edit the file, resubmit by path", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toContain(".zcode/workflow-drafts/");
    expect(skill).toContain("{path}:L{line}:C{column} {message}");
    expect(skill).toContain(
      "**Edit that file and resubmit with `path`. Do not paste the script inline again**",
    );
    // 出错的 run 同样按文件修订：通知与 GetWorkflowRun 给出 scriptPath，AmendWorkflow 收 path。
    expect(skill).toContain("edit the run's script file, which the notification names,");
    expect(skill).toContain("**Every run remembers its script file, so a revision is an `Edit`.**");
    expect(skill).toContain("`scriptPath`");
    // 草稿目录免审批，否则模型会以为改文件也要等用户点确认，于是又回去贴脚本。
    expect(skill).toContain("**Editing a draft asks nothing.**");
    // EvalWorkflowSnippet 的第二个来源。
    expect(skill).toContain("or as `path` to a file holding it");
    // 旧的「整段重来」说法不得回流。
    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/call\s+`CreateWorkflow` again/);
      expect(text, name).not.toMatch(/resubmit with `AmendWorkflow`\./);
    }
  });

  // 2026-09-07 用户裁决（docs/dynamic-workflow/authoring.md「The skill」）：用户可见文本按
  // 「像告诉同事那样说」的一条原则 + 英中成对例子教，不列禁用词。同时钉住一处更正：分析器没有
  // 「同一子代理上无序 ask」的告警（诊断集 9001/9003/9004/9005/9006），skill 不得再声称编译器会警告。
  // 2026-09-08 用户实测：模型把 skill 里的 "cold read" / "fresh eyes" 逐字译成「冷读」「冷眼」并写进
  // 阶段名与子代理名。正文改称 independent read，§9 表格加成对例子，示例子代理不再叫 cold-reviewer。
  it("teaches writing for the user, and does not claim an analyzer warning", async () => {
    const skill = await readSkillFile("SKILL.md");
    expect(skill).toMatch(/^## \d+\. Write for the user$/m);
    expect(skill).toContain("文件评审阶段");
    expect(skill).toContain("The language travels through your asks");
    expect(skill).toContain("独立评审员");
    expect(skill).toContain("冷读方案");

    for (const { name, text } of await readAllContent()) {
      expect(text, name).not.toMatch(/compiler warns/i);
      // 表格的 Not 列故意保留这两个词作反例，只查表格之外的正文。
      expect(text.replace(/^\| .*$/gm, ""), name).not.toMatch(/cold[- ]read|cold-reviewer/i);
    }
  });

  it("names CreateWorkflow explicitly wherever it routes", async () => {
    // legacy 的 script/expert `Workflow` 工具仍在（core/src/tool/handlers/workflow.ts），
    // 与 dwf 共用 "workflow" 这个词。所以正文必须指名 CreateWorkflow，不能说"the workflow tool"。
    for (const { name, text } of await readAllContent()) {
      expect(text, name).toContain("CreateWorkflow");
      expect(text, name).not.toMatch(/\bthe workflow tool\b/i);
    }
  });

  // 最强的一条守卫：示例脚本过真编译器。标识符匹配只能证明"名字存在"，编译能证明"这段脚本真能跑"。
  // 只查显式标注 `<!-- compile -->` 的块——patterns.md 的片段刻意省略接口声明，不是完整脚本；
  // 用启发式（"含 return 就编译"）区分两者，迟早会把某个真错误当成片段放过去。
  it("compiles every script block marked as complete", async () => {
    const marked: { file: string; index: number; source: string }[] = [];
    for (const { name, text } of await readAllContent()) {
      const blocks = [...text.matchAll(/<!-- compile -->\n```ts\n([\s\S]*?)```/g)];
      blocks.forEach((match, index) => {
        marked.push({ file: name, index, source: match[1] });
      });
    }

    // SKILL.md 的完整示例 + §9 的报告形状 + §9 的产物发布例 + examples.md 的四个脚本。
    // 掉到 6 以下意味着标记被误删——那会让这条守卫静默退化成空断言。
    // 下限沿革：4（初版）→ 5（Amendment 1 的 world.run 例）→ 6（Amendment 6 的产物例）。
    expect(marked.length).toBeGreaterThanOrEqual(6);

    for (const { file, index, source } of marked) {
      const result = compileWorkflowScript(source);
      expect(result.diagnostics, `${file} block #${index}`).toEqual([]);
      expect(result.ok, `${file} block #${index}`).toBe(true);
      // 编译只跑 typecheck，看不见 authoring 诊断（world.run 字面量、phase 标记形态、actor
      // 重名 / fan-out 静态名）。而 CreateWorkflow / SaveWorkflow 的 handler 先过
      // analyzeScript，`!ok` 即拒绝提交——所以「示例能编译」曾经不等于「模型照抄能提交」。
      // 2026-08-31 amend-resume 把 actor 名变成唯一身份键后这条缝真的漏了东西：技能里每一个
      // fan-out 都写着 `agent("reviewer")`，全是 9006。补上这一趟，守卫才对齐真实的提交门。
      const analyzed = analyzeWorkflowScript(source);
      expect(analyzed.diagnostics, `${file} block #${index} (analyze)`).toEqual([]);
      expect(analyzed.ok, `${file} block #${index} (analyze)`).toBe(true);
    }
  });
});

/**
 * 灰度门（docs/dynamic-workflow/launch.md「Gray release」）按**目录名**定位技能资产，而技能包里改名
 * 不会让任何类型报错，门会静默失效。这里把名字钉死在真实文件上。
 */
describe("gray release gate names stay pinned to the real bundled assets", () => {
  function bundledRoots(): SkillRoot[] {
    return resolveBundledSkillRoots({ cliStorageRoot: join(tmpdir(), "zcode-unused-cli-storage") });
  }

  it("内置技能包解析到真实的 skills 目录，且剔除路径正好落在 dynamic-workflows SKILL.md 上", () => {
    const roots = bundledRoots();
    expect(roots).toEqual([
      {
        path: join(PACK_ROOT, "skills"),
        priority: expect.any(Number),
        scope: "system",
        source: "bundled",
      },
    ]);
    expect(collectDynamicWorkflowDisabledSkillPaths(roots)).toEqual([join(SKILL_DIR, "SKILL.md")]);
  });

  /**
   * 端到端地跑一遍真实的 NodeSkillAdapter，把 create-app 的装配复现出来：内置技能根与插件技能根并列，
   * adapter 在发现阶段按 SKILL.md 的绝对路径比对 disabledPaths。任一假设不成立，这条用例立刻红，
   * 而不是灰度门静默失效。
   */
  describe("real NodeSkillAdapter discovery", () => {
    const guidePluginRoot: SkillRoot = {
      path: GUIDE_PLUGIN_SKILLS_ROOT,
      priority: 0,
      scope: "system",
      source: "plugin",
    };

    async function discoveredSkills(
      disabledPaths: string[],
    ): Promise<Array<{ name: string; source: string }>> {
      const adapter = createNodeSkillAdapter({ disabledPaths });
      const outcome = await adapter.discoverSkills({
        workingDirectory: PACK_ROOT,
        roots: [guidePluginRoot, ...bundledRoots()],
      });
      return outcome.skills.map((skill) => ({ name: skill.name, source: skill.source }));
    }

    it("灰度开启（无门禁路径）时目录里有 dynamic-workflows，且来源是 bundled", async () => {
      await expect(discoveredSkills([])).resolves.toContainEqual({
        name: SKILL_NAME,
        source: "bundled",
      });
    });

    it("灰度关闭时 dynamic-workflows 消失，插件技能仍在", async () => {
      const skills = await discoveredSkills(
        collectDynamicWorkflowDisabledSkillPaths(bundledRoots()),
      );
      const names = skills.map((skill) => skill.name);
      expect(names).not.toContain(SKILL_NAME);
      // 反向断言：门只剔一个 SKILL.md，其他根没有被连坐。
      expect(names).toContain("zcode-configuration-guide");
      expect(names.length).toBeGreaterThan(1);
    });
  });
});
