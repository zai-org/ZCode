# Claude Marketplace 三件套插件兼容验证规格

## 背景

在 `docs/hooks-implementation-analysis.md` 之后，需要继续验证 Claude Code marketplace
中同时包含 **skills、commands、MCP servers** 的插件，确认 ZCode 当前插件发现、安装、
runtime projection 与下游 skill/command/MCP adapter 是否能完整兼容。

本轮只验证低风险资源投影：不启动真实 MCP server、不执行 command、不运行 hook。

## 样本来源

样本来自本机 Claude CLI 已缓存的 `claude-plugins-official` marketplace manifest：

```text
~/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json
```

筛选方式：读取 marketplace entry 的 GitHub `tree`，确认插件根目录同时存在：

- `skills/*/SKILL.md`
- `commands/*.md`
- `.mcp.json` 或 manifest `mcpServers` 指向的 MCP 配置

固定 10 个样本如下：

| 插件 | source 形态 | skills | commands | MCP |
| --- | --- | ---: | ---: | --- |
| `appwrite` | repo root | 11 | 2 | `.mcp.json` |
| `aws-agents-for-devsecops` | `git-subdir` | 13 | 9 | `.mcp.json` |
| `bigdata-com` | `git-subdir` | 1 | 27 | `.mcp.json` |
| `cloudflare` | repo root | 11 | 2 | `.mcp.json` |
| `confidence` | repo root | 11 | 5 | `.mcp.json` |
| `convex` | repo root + manifest paths | 2 | 1 | `.mcp.json` |
| `dominodatalab` | repo root | 23 | 4 | `.mcp.json` |
| `fiftyone` | repo root | 16 | 2 | `.mcp.json` |
| `legalzoom` | `git-subdir` | 1 | 1 | `.mcp.json` |
| `logfire` | `git-subdir` | 3 | 4 | `.mcp.json` / `mcp.json` |

候补样本：`mercadopago`、`nimble`、`notion`。

## 本地测试策略

新增 adapter 层离线 fixture 测试，不依赖网络、不读取真实 marketplace cache：

1. 在临时目录构造一个 marketplace manifest，包含上述 10 个插件。
2. 每个插件写入 `.claude-plugin/plugin.json`、`skills/`、`commands/`、`.mcp.json`。
3. 通过 `addMarketplace()` + `installMarketplacePlugin()` 模拟 marketplace 安装。
4. 通过 `createNodePluginAdapter().discoverPlugins()` 启用 10 个插件。
5. 验证插件层输出：
   - 10 个插件都 enabled。
   - 每个插件都有 `skillRoots`、`commandRoots`、`mcpServers`。
   - MCP server key 被命名空间化为 `plugin:<plugin-name>:<server-name>`。
6. 继续调用下游 adapter 验证：
   - `createNodeSkillAdapter().discoverSkills({ roots })` 能发现每个插件的 skill。
   - `createNodeCustomCommandAdapter().discoverCommands({ roots })` 能发现每个插件的 command。

## 兼容判据

认为兼容：

- `.claude-plugin/plugin.json` 可被读取。
- 默认 `skills/` / `commands/` 目录可投影到 runtime roots。
- manifest path 形式（例如 `skills: "./skills/"`、`commands: "./commands/"`、
  `mcpServers: "./.mcp.json"`）可投影。
- `.mcp.json` 可被读取并转换为 ZCode `McpServerConfig`。
- MCP env 中 `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、`${ZCODE_PROJECT_DIR}`
  等变量可替换。

认为不兼容或需单独诊断：

- 只有根目录 `mcp.json` 且 manifest 未通过 `mcpServers` 指向时，ZCode 当前不会自动读取。
- 真实 MCP server 是否能启动不在本轮测试范围内；本轮只验证配置投影。

## skills 字段语义（已修复差一层目录问题）

插件 manifest `skills` 支持字符串或路径数组。显式声明时只使用声明路径，空数组
表示不加载技能；只有未声明字段时才使用默认 `skills/`。路径可以指向单技能或
技能集合，由共享扫描规则（`apps/zcode-cli/packages/adapters/src/skills/scan.ts`）处理：

- 技能根自身有可加载的 `SKILL.md` 时，只加载自身，不再枚举子目录；需要其中其他
  技能时必须另行声明路径。用户级、项目级技能扫描不受本规则影响；
- 自身没有可加载的 `SKILL.md` 时，按集合扫描一层子目录，子目录命中
  需校验 `SKILL.md` 真实存在，分类目录（如 `skills/engineering/`）不会误计；
- 多个声明根命中同一个 `SKILL.md` 时按文件路径去重，计数与发现结果不翻倍；
- manifest 显式声明的 skills 路径扫描为 0 个技能时发 `plugin_skill_root_empty`
  warning 诊断（声明路径写进 message；协议 wire schema 不携带 path 字段），插件
  详情页「警告」区展示，不再静默。message 区分原因：`does not exist`（manifest
  配错，只认 ENOENT/ENOTDIR）与 `does not contain any skills`（内容为空，含
  链接被安全拒绝后扫描为空的情形）。
- 信任边界：插件内容不可信，plugin-scope 扫描**一律不跟随符号链接**（含 Windows
  junction）——根自身、子目录候选、`SKILL.md` 文件三个粒度全部拒绝链接，目录级
  逃逸（`skills/evil-link -> ../../outside`）与文件级逃逸（`SKILL.md -> ~/.aws/
  credentials`）同标准封堵；拒绝链接即无逃逸，不依赖判定链接指向（无跨盘符
  `relative` 谓词，无平台分支）。组件枚举（`collectSkillComponents`）对插件根
  无条件适用同一规则，不依赖 manifest 是否解析成功。词法防线（`resolveInside`
  拒绝绝对路径与 `..` 穿越）继续生效。用户级技能根（`~/.zcode/skills` 的
  symlink 导入是受支持功能）保持默认跟随，行为不变。

## 验证命令

```bash
pnpm --filter @zcode/adapters test plugins
pnpm typecheck
pnpm lint
```
