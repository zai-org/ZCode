# Skill Integration Plan

## 文档定位

本文是 ZCode v2 接入 skill 的实现级规划。它遵循当前 v2 架构原则：

- spec 先行，再进入 contracts 和实现。
- core 不直接读文件、扫目录、访问网络或读取环境变量。
- skill 和 MCP、plugin、subagent 一样，必须通过 capability、schema、权限和 trace 边界进入 agent runtime。
- skill 首先服务 NL -> Code 的专业知识按需加载，不在第一版承担远程市场、插件安装和子代理编排。

## 设计要点

模型入口与上下文：

- skill 入口是 `Skill` tool。启动时只给模型可用 skill 列表，不把完整正文塞进 system prompt；模型必须先调用 tool 才能获得完整指令。
- skill 列表有预算控制，并对单个描述做硬截断；超过预算时截断描述、降级或发 warning。
- `Skill` tool 输入是 skill name 和可选 args；输出完整内容和 base directory，帮助模型按需读取 references/scripts。
- 已加载 skill 会被记录，便于 compaction 后恢复 skill 内容。

能力域与权限：

- skill 作为独立能力域，有 `SkillMetadata`、`SkillLoadOutcome`、`SkillRoot`、`SkillPolicy`、`SkillDependencies` 等明确模型。
- root 有 scope：repo、user、system、admin；配置规则可按 name 或 path enable/disable。
- 发现路径覆盖自有目录和兼容目录，project-local discovery 从当前目录向上扫到 worktree root。
- skill frontmatter 可携带 `allowed-tools`、`model`、`effort`、`disable-model-invocation`、`when_to_use` 等运行时影响项。
- 权限不是只看 “读取 SKILL.md 是否安全”，而是看 skill 是否会改变工具白名单、模型、hook、fork 执行等行为：只有安全属性的简单 skill 自动放行，其它情况走 permission；规则可以按 skill name pattern 表达 allow/deny/ask。
- loader 用 filesystem abstraction，不把本地 I/O 暴露给 core。

第一版不做：

- 不把 skill 和 slash command 合流，只做 `SKILL.md` 指令包。
- forked skill（`context: fork`）依赖成熟 subagent runtime，第一版只预留 schema。
- remote / URL skill discovery 需要网络、缓存、签名/校验和审计，不进第一阶段。
- 不长期保留大正文，优先 metadata snapshot + 按需读取正文。
- product gating、env dependency prompt、root alias 渲染作为 Phase 2+；第一版只保留字段和诊断，不实现完整依赖补全。

## ZCode 设计选择

## 当前实现核对（2026-05-08）

本轮核对确认 skill P0 主线已经落地，本文后续条目仍作为契约基准，但不应再把以下能力当作未实现缺口：

- Contracts：`packages/contracts/src/skills/index.ts` 已定义 `SkillRoot`、`SkillScope`、`SkillMetadata`、`SkillDiagnostic`、`SkillContent`、`SkillLoadOutcome`、`SkillPort` 和 `SkillConfig`；`packages/contracts/src/tools/skill.ts` 已提供 `Skill` tool 的运行时 schema 与 provider JSON schema。
- Adapter loader：`packages/adapters/src/skills/index.ts` 已通过 Node adapter 发现从 cwd 向上到 worktree root 的 `.zcode/skills`、`.agents/skills`、`.claude/skills` 及对应 user roots，支持 config extra roots、flat YAML frontmatter、未知字段 diagnostics、同名优先级去重、正文按需读取和 100KB 截断。
- Core runtime：`packages/core/src/context/sections/skills.ts` 已把 skill metadata 渲染为 `meta_user` section，不把正文放进 system prompt；`packages/core/src/tool/handlers/skill.ts` 已通过 `SkillPort` 加载正文，并声明只读、session side effect、runtime input/output schema、result budget、timeout、取消和 trace 传播。
- Bootstrap / CLI / ZCode app-server：`packages/bootstrap/src/index.ts` 已按 feature gate 和 `skills.*` config 注入 `SkillPort`；`listZCodeSkills()` 复用同一 adapter；`zcode skills` / `zcode skills list` 支持 human、`--json` 和 `--verbose` diagnostics；TUI/command-center 的裸 `/skill` 只读列举 skills，`/skill <name> [task]` 会改写为必须先调用 `Skill` tool 的 prompt；ZCode app-server 暴露 `/skill <skill-name> [task]`，裸 `/skill` 在 ZCode app-server 中返回 usage，不启动模型 turn。
- Tests：`packages/adapters/tests/skills.test.ts` 覆盖 discovery、正文加载和重复名优先级；`packages/core/tests/skill-tool.test.ts` 与 `packages/core/tests/context-builder.test.ts` 覆盖 metadata 注入和 `Skill` tool；`packages/cli/tests/cli.unit.test.ts` 覆盖 CLI/TUI `/skill`；`packages/bootstrap/tests/zcode-protocol.test.ts` 覆盖 ZCode app-server command 暴露、禁用和 prompt rewrite。

当前仍未落地，继续作为后续范围：

- TUI/debug projection 的 skill diagnostics 页面，以及显式 `$skill-name` / `skill://...` mention。
- 按具体 skill name 或 wildcard 的 allow/deny/ask 规则；当前 `Skill` tool 的权限声明仍是 tool-level low-risk 自动允许，没有根据 unsafe frontmatter、remote/plugin source 或 runtime modifier 字段动态升级为 ask。
- skill lifecycle 事件（`SkillRootsResolved` / `SkillLoaded` 等）、loaded-skill session snapshot、compact 后恢复完整 skill body，以及 diagnostics 的结构化观测面。
- bundled/system/plugin/admin/remote roots、dependency/env prompt、`context: fork`、`model` / `effort` runtime modifier、`allowed-tools` scoped suggestion 等 P1/P2 能力。

### 核心原则

ZCode skill 采用“两层加载”：

1. **metadata discovery**：进程级实时 skill 目录扫描 skill roots，只把 name、description、source、scope、path、policy 等轻量信息进入 context。文件监听更新内存快照，每次普通输入准备只读快照，listing 只追加新增或变化的行；规则见根目录 `docs/skills-live-catalog.md`。
2. **content load**：模型显式调用 `Skill` tool 后，按会话快照解析名称，才读取对应 `SKILL.md` 正文并注入当前会话。

这能同时满足 token 控制、权限可见、trace 可追踪和跨平台 I/O 收口。

### 分层边界

`contracts` 增加 skill contract：

- `SkillRoot`
- `SkillScope`
- `SkillMetadata`
- `SkillPolicy`
- `SkillLoadOutcome`
- `SkillDiagnostic`
- `SkillContent`
- `SkillPort`
- `SkillConfig`

`adapters` 实现 Node skill loader：

- 扫描目录。
- 解析 YAML frontmatter。
- 读取正文。
- 处理 symlink、权限错误、路径规范化、大小写差异和 max bytes。
- 返回结构化 diagnostics。

`core` 增加 skill registry / manager：

- 保存当前 session 的 skill metadata snapshot。
- 供 `skills_listing` 收集器渲染可用 skill 列表（ContextBuilder 不再渲染，见根目录 `docs/skills-live-catalog.md`）。
- 注册 `Skill` tool contract。
- `Skill` tool 只通过 `SkillPort` 加载正文，不直接读文件。

`bootstrap` 负责组装：

- 根据 config 生成 skill roots。
- 注入 `SkillPort` 到 runtime/tool executor。
- 把 skill feature gate、权限配置和 context budget 传给 core。

## 文件格式

P0 只要求每个 skill 目录包含 `SKILL.md`：

```text
my-skill/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` 必须有 YAML frontmatter：

```markdown
---
name: my-skill
description: When this skill should be used
---

# My Skill

Workflow instructions.
```

P0 frontmatter：

- `name`：必填。建议 `^[a-z0-9]+(-[a-z0-9]+)*$`，长度 1-64。
- `description`：必填，长度 1-1024。
- `when_to_use`：可选，追加到描述预算中。
- `license`：可选，仅 metadata。
- `metadata`：可选，string map。

P1/P2 预留字段：

- `allowed-tools`
- `model`
- `effort`
- `context: inline | fork`
- `disable-model-invocation`
- `policy.allow_implicit_invocation`
- `dependencies.tools`
- `interface`

P0 对未知字段不报错，但写入 diagnostics，避免未来字段被静默误用。

## Discovery Roots

P0 默认 roots：

1. configured extra roots：`skills.roots[]`，按配置顺序优先。
2. project native：从 cwd 开始逐级向上到 worktree root 的 `<dir>/.zcode/skills/*/SKILL.md`。
3. project agent-compatible：从 cwd 开始逐级向上到 worktree root 的 `<dir>/.agents/skills/*/SKILL.md`。
4. project Claude-compatible：从 cwd 开始逐级向上到 worktree root 的 `<dir>/.claude/skills/*/SKILL.md`。
5. user native：`~/.zcode/skills/*/SKILL.md`
6. user agent-compatible：`~/.agents/skills/*/SKILL.md`
7. user Claude-compatible：`~/.claude/skills/*/SKILL.md`

Project discovery 使用 nearest-first 语义：先检查当前 working directory 的 native / agent-compatible / Claude-compatible roots，再检查父目录，直到包含 `.git` marker 的 worktree root；如果找不到 worktree root，则只使用传入 working directory 的 project roots，避免意外扫描到用户目录或文件系统根。

已实现的额外 roots：

- **bundled skill pack**（`bootstrap/src/app/bundled-skills.ts`）：随 CLI 内置的技能包
  `apps/zcode-cli/packages/bundled-skills/skills/`，以 `source: "bundled"`、`scope: "system"`
  进入发现，与 plugin roots 并列注入 runtime、`zcode skills list` 与协议 skill catalog。它不是
  插件：不进市场目录、没有启停开关、不能卸载、不出现在 Settings 与 `$` 引用面板
  （`skills/referenceCatalog` 过滤 `bundled`）。开发态/桌面态/ZCode Server 发行包沿官方插件同款
  候选目录在入口旁原地读取（Server 发行包 stage 在 `runtime/packages/bundled-skills`）；SEA
  按内容 hash 一次性解压到 `~/.zcode/cli/bundled-skills/<hash>/`。包内每个
  文件都是必需资产，缺一拒绝整包并告警。首个成员是 `dynamic-workflows`
  （`docs/dynamic-workflow/authoring.md`）。
- plugin-provided skill roots。

Plugin-provided skill roots are defined by
[`plugin-compat.md`](plugin-compat.md). They use the same `SKILL.md` file
format and enter discovery as `source: "plugin"` roots. Plugin loading does not
inline skill bodies; the existing `Skill` tool remains the only P0 path for
loading full plugin skill content into the model context.

P2 增加：

- remote URL discovery/cache。
- admin/managed policy roots。

优先级：

1. session override / configured extra roots
2. nearest project native
3. nearest project compatible
4. ancestor project native / compatible，按目录从近到远
5. user native
6. user compatible
7. bundled/system
8. admin/managed

同名 skill 默认取高优先级项，重复项进入 diagnostics。后续如果引入 plugin namespace，可支持 `plugin:skill-name`。

## Context 注入

当前实现：列表作为 `skills_listing` 附件进入会话（不在 system prompt），首发为完整列表，之后只追加新增或内容变化的行，删除不通知；格式、指纹与持久化见根目录 `docs/skills-live-catalog.md`。下文为最初的规划格式。

ContextBuilder 增加 `Skills` section，位于 user/project context 之后。工具说明不再作为
ContextBuilder section 注入 system prompt，而是随 model request 的 `tools` 数组提供。

内容只包含 metadata，不包含正文。初始格式：

```text
## Skills

A skill is a set of local instructions stored in SKILL.md. Use the Skill tool to load full instructions only when relevant.

### Available Skills
- my-skill: When this skill should be used (file: /abs/path/to/SKILL.md)

### How To Use Skills
- If the task matches a skill description, call Skill with the skill name before doing the task.
- If the user types `/<skill-name>`, call Skill only when that exact skill appears in the available skills list. Do not guess missing skill names.
- After loading a skill, read only the referenced files you need.
- Resolve relative references from the skill base directory.
```

预算策略：

- P0：默认 1% context window 或 8k chars fallback。
- 单条 description 最大 250 chars。
- 超预算时先截断 description，再降级到 names-only，并记录 diagnostic/log。
- P1：引入 root alias（用短别名代替 skill root 绝对路径），减少长绝对路径成本。

## `Skill` Tool

工具名采用 `Skill`，保持与现有 `Read` / `Write` / `Edit` / `Bash` 命名风格一致。

输入：

```json
{
  "name": "my-skill",
  "args": "optional user/model supplied arguments"
}
```

P0 输出：

```text
<skill_content name="my-skill">
# Skill: my-skill

...SKILL.md body...

Base directory for this skill: /abs/path/to/my-skill
Relative paths in this skill are relative to this base directory.
</skill_content>
```

例外：动态工作流 mode 为 onDemand 且工具面尚未激活时，加载 `dynamic-workflows` 的结果在 `<skill_content>`
之前多一段固定提示，让模型请用户发送 `/workflow`；子 runtime（Agent 子代理、`/expert` 子会话）拿到的那段改为让它把限制报告给父代理（见 [Tool Change Chain](tool/00-tool-change-chain.md)
「Skill 结果的工作流工具未激活提示」）。

工具 metadata：

- `readOnly: true`
- `destructive: false`
- `concurrentSafe: true`
- `sideEffectScope: "session"`，因为它会改变当前会话上下文。
- `riskLevel: "low"` for safe inline skills。
- `maxOutputBytes` 默认 100k。
- `timeoutMs` 默认 30s。

权限策略：

- P0 只实现 inline load。
- safe skill 自动允许：只含 P0 safe frontmatter 字段，且 source 是 project/user/native/compatible。
- 出现 `allowed-tools`、`model`、`effort`、`context: fork`、`hooks`、`dependencies`、remote/plugin source 时，默认 ask。
- 明确 deny 的 skill 不出现在 available skills，也不能通过 tool load。
- 权限规则应支持 `Skill(my-skill)` 和 wildcard，例如 `Skill(internal-*)`。

P1 行为：

- `allowed-tools` 不直接绕过权限，只作为 permission suggestion 或 scoped allow rule。
- `model` / `effort` 通过 runtime context modifier 生效，并记录 event。
- `context: fork` 等 subagent runtime 稳定后再实现。

## Manual Command

P0 增加 slash command：

```text
/skill [<skill-name> [task...]]
```

语义：

- 不带参数的 `/skill` 是只读 discovery，列举当前工作目录可发现的 skills；它不创建 app/session、不加载模型、不提交 prompt，也不调用 `Skill` tool。
- `<skill-name>` 对应 `SKILL.md` frontmatter 的 `name`。
- `[task...]` 可选。存在时，表示“使用该 skill 执行这个任务”；不存在时，表示“先加载该 skill 并基于 skill 指令响应当前 turn”。
- 带 `<skill-name>` 的 command 不直接读取 skill 文件，不绕过 `Skill` tool、permission、trace 和 session persistence。
- command-center 只把用户输入改写成显式模型指令：先调用 `Skill` tool 加载 `<skill-name>`，再继续原任务。
- `--prompt "/skill"` 和 TUI 输入 `/skill` 都返回 skill 列表；`--prompt "/skill <name> ..."` 和 TUI 输入 `/skill <name> ...` 都改写成显式 Skill tool 调用要求。

P1 可增加 `$skill-name` explicit mention，但 P0 先用 slash command，避免和普通自然语言混淆。

## CLI Discovery Commands

当前已实现只读 CLI 命令：

```text
zcode skills list
zcode skills inspect <name>
```

语义：

- `skills list` 只做本地 skill discovery，不创建 session，不加载模型，不提交 prompt，也不调用 `Skill` tool。
- 发现逻辑必须复用 bootstrap 注入的 `SkillPort`/Node skill adapter 契约；CLI 只负责解析子命令、格式化输出和退出码，不直接遍历 skill 目录。
- 不带子命令的 `zcode skills` 等价于 `zcode skills list`。
- 普通输出展示 skill name、scope/source、description 和 path，便于用户复制 `<skill-name>` 给 `/skill <name>` 使用。
- `--json` 输出 `{ skills, diagnostics, totalDiscovered, cwd }`，其中 `skills` 保留 name、description、whenToUse、scope、source、path、directory、rootPath。
- `--verbose` 在普通输出后追加 discovery diagnostics；默认普通输出不打印 warning，避免正常使用时被可恢复诊断刷屏。
- `skills inspect <name>` 只做本地 discovery 加单个 skill body 读取，不创建 session、不加载模型、不提交 prompt，也不调用 `Skill` tool。
- `skills inspect <name>` 必须复用 bootstrap 注入的 `SkillPort`/Node skill adapter 契约；CLI 只负责解析子命令、格式化输出和退出码，不直接读取 `SKILL.md`。
- `skills inspect <name>` 普通输出展示 name、scope/source、path、directory、description、whenToUse、safe-to-auto-load、size/truncation 和去掉 frontmatter 后的正文。
- `skills inspect <name> --json` 输出 `{ cwd, skill, diagnostics }`，其中 `skill` 保留 metadata、baseDirectory、content、bytesRead、sizeBytes 和 truncated。
- `skills inspect <name> --verbose` 在普通输出后追加 discovery diagnostics；默认普通输出不打印 warning。
- 未知 `skills` 子命令或参数数量错误返回非 0，并打印 `Usage: zcode skills [list|inspect <name>]`。

错误行为：

- discovery adapter 抛错时向 CLI 边界冒泡，由 CLI 输出 `Error: <message>`；`--verbose` 可追加 stack。
- `skills inspect <name>` 找不到 skill 时返回非 0，并输出稳定的 `Skill not found: <name>` 错误；如果 skill 功能被配置禁用，返回非 0，并输出 `Skills are disabled.`。
- 单个 skill 的 frontmatter/read 诊断不导致命令失败，按 diagnostics 返回。
- 没有发现 skill 时返回 0，并输出 `No skills found.`；JSON 中 `skills` 为空数组。

## Config

`RuntimeConfig` 增加候选字段：

```text
features.skill
skills.enabled
skills.includeInstructions
skills.metadataBudget
skills.roots
skills.compatibility.claude
skills.compatibility.agents
skills.rules
```

Skill 配置不声明环境变量入口。需要调整 skill 开关、兼容目录或 metadata budget 时，走 config file、CLI/session override 或更高层的运行时配置契约。

新增 `ZCODE_` 环境变量必须先补齐 spec，明确用途、优先级、错误行为和测试覆盖，避免把临时实现细节扩散成长期配置面。

Config 合并仍走 system/user/project/session/env/cli 优先级，core 不读取环境变量。

## Events 与 Observability

新增或复用事件语义：

- `SkillRootsResolved`
- `SkillDiscovered`
- `SkillDiscoveryWarning`
- `SkillLoadRequested`
- `SkillLoaded`
- `SkillLoadFailed`

每个事件必须携带 traceId/sessionId/turnId。日志默认不记录完整 skill 正文，只记录 name、scope、source、path hash、size、truncated、durationMs。

需要在 context diagnostics 中暴露：

- total skill count
- included skill count
- omitted skill count
- truncated description count
- duplicate names
- parse/read errors
- disabled skills

## 安全与跨平台约束

- 所有路径解析使用 `path` / `url` / `fs` adapter，不手写分隔符。
- `SkillPort` 只接受 adapter 已规范化的 absolute path 或 stable skill id。
- 禁止 `Skill` tool 读取 skill directory 之外的文件。
- references/scripts 不自动执行。模型若要运行脚本，必须显式走 `Bash`/`ExecutionPort` 和权限。
- symlink 需要 canonical identity 去重；路径显示可保留用户可读路径。
- Windows 上要处理大小写、反斜杠、路径长度和权限错误。
- 大正文超出 `maxOutputBytes` 时返回截断摘要和 diagnostic，后续进入 artifact/storage。

## 分阶段计划

### Phase 0：Spec 与测试骨架

Status: completed. 本文档、contract 边界和 CLI/core/adapter 测试骨架已经存在。

- 新增本文档。
- 为 skill contract 设计测试样例 fixture。
- 明确 P0/P1/P2 字段边界。

验收：

- 文档覆盖设计要点与取舍结论。
- 后续实现任务可以按 contract 拆分。

### Phase 1：Contracts

Status: completed for P0. `packages/contracts/src/skills/index.ts` 和 `packages/contracts/src/tools/skill.ts` 已提供共享类型、运行时 schema、provider JSON schema 和 diagnostics/error code；更细粒度 policy / dependency 字段仍保留为后续扩展。

- 在 `packages/contracts/src/skills` 增加 skill schema/type。
- 给 `RuntimeConfig` 增加最小 skills 配置。
- 增加 skill diagnostics/error code。

验收：

- `contracts` 类型可被 core/adapters/bootstrap 单独引用。
- schema 覆盖 invalid frontmatter、duplicate、disabled、too large。

### Phase 2：Adapter Loader

Status: completed for P0. Node loader 已支持 native/compatible project 与 user roots、extra roots、从 cwd 向上到 worktree root 的 project discovery、frontmatter diagnostics、重复名优先级、正文截断和取消前检查；symlink canonical 去重、remote/cache 和 plugin roots 尚未实现。

- 在 `packages/adapters/src/skills` 实现 Node loader。
- 支持 P0 roots 和 frontmatter。
- 支持 max bytes、canonical path、diagnostics。

验收：

- adapter 单测覆盖 project/user/compat roots、重复 name、无权限、symlink、invalid YAML。
- 不引入 core 依赖。

### Phase 3：Core Context 与 Registry

Status: completed for P0. 内置 registry 已注册 `Skill` tool，并允许在没有 `SkillPort` 时省略该 tool；session 级 loaded-skill snapshot 和 compact 恢复仍未实现。ContextBuilder 曾把 available skills 渲染为独立 `meta_user` section；现在列表只由 `skills_listing` 收集器渲染，ContextBuilder 只按会话开始时的目录决定 skill 引导语。

- core 增加 `SkillRegistry` / `SkillManager`。
- `skills_listing` 收集器渲染 Skills 列表。
- context diagnostics 记录预算与截断。

验收：

- fake skill snapshot 能渲染到 system prompt。
- 超预算不会丢失所有 skill name。
- core 仍不 import Node I/O。

### Phase 4：`Skill` Tool

Status: completed for P0 inline load. Tool handler 已通过 `SkillPort` 读取正文并返回 `<skill_content>`，声明 output schema、result budget、timeout、取消和 trace 传播；按 skill name/policy 动态审批、unsafe frontmatter ask、runtime modifier 和 fork context 尚未实现。

- 注册 `Skill` tool。
- tool 通过 `SkillPort` 加载正文。
- tool result 注入 message history。
- permission service 支持 skill pattern。

验收：

- fake model 调用 `Skill` 后，下一轮 model 能看到 skill body。
- deny rule 下 skill 不出现在 available skills，直接调用也失败。
- unsafe frontmatter 走 ask，safe inline skill 自动 allow。

### Phase 5：CLI/TUI

Status: partially completed. `zcode skills` / `zcode skills list`、`zcode skills inspect <name>`、`--json`、`--verbose` diagnostics、TUI/command-center 裸 `/skill` list、`/skill <name> [task]` prompt rewrite、ZCode app-server `/skill <name> [task]` 已实现。TUI/debug diagnostics projection 尚未实现。

- `zcode skills list`：已实现，只读 discovery，不启动模型/session。
- `zcode skills inspect <name>`：已实现，只读 discovery 加正文读取，不启动模型/session，CLI 不直接读取 `SKILL.md`。
- TUI/debug projection 显示 skill discovery diagnostics。

验收：

- CLI 输出支持 `--json`。
- 错误包含 traceId 或 diagnostic code。

### Phase 6：Advanced

- root alias 渲染。
- explicit mention：`$skill-name` 和 `skill://.../SKILL.md`。
- bundled/system skills。
- plugin skill roots。
- skill dependency/env prompt。
- forked skill。
- remote URL discovery/cache。

## 推荐提交拆分

1. `docs: add skill integration plan`
2. `refactor(contracts): add skill contracts`
3. `feat(adapters): add node skill loader`
4. `feat(core): render available skills in context`
5. `feat(tool): add Skill tool`
6. `feat(permission): support skill permission rules`
7. `feat(cli): add skills commands`
8. `test: add skill boundary coverage`

## 暂不做

- 不在 P0 实现远程 skill 下载。
- 不在 P0 执行 skill scripts。
- 不在 P0 自动修改 tool allowlist。
- 不在 P0 实现 forked skill。
- 不在 P0 把 skill 和 slash command 合流。
