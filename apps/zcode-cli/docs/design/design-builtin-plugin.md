# 内置插件：design（设计工作流）

> Spec v1 · 2026-11-04

## 目标

`design` 随 ZCode 桌面端与 CLI 一起发布、默认关闭（可启用、可停用、不可卸载），源码在本仓库
`apps/zcode-cli/packages/design-plugin/`，不依赖 CDN 插件市场。交付物是写入工作区的 HTML 设计稿、
交互原型或 HTML 演示稿时，Agent 加载 `design` 技能按工作流执行。

## 默认状态与浏览器入口

- 缺少显式设置时 Design 关闭，不注入技能和 SessionStart hook。已有用户/项目的显式启用或停用配置继续生效。
- 内置资源继续随应用分发；“选择元素”依赖当前工作区的有效 Design 启用状态。未安装或未启用时显示安装提示，确认后打开 `design@zcode-plugins-official` 的插件详情页，由该页执行安装或启用；取消不进入点选。
- 插件状态来自 CLI 插件管理服务；界面复用其按工作区隔离的查询投影与变更通知，不额外保存启用开关。
- 交互与验收边界见[内置浏览器设计模式](../../../../docs/browser-use/2026-11-03-browser-design-mode-spec.md)。

## 内容

纯内容型插件：无 MCP、无系统依赖。

| 路径 | 作用 |
|---|---|
| `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json` | 两份宿主清单，逐字节一致；ZCode 读前者，后者供使用 `.claude-plugin` 清单格式的宿主原生加载 |
| `skills/design/SKILL.md`、`references/*.md`（7 份） | 入口技能与按需读取的规则文件 |
| `skills/design/scripts/*.mjs` | 画布适配、资源目录生成、设计系统导入、design-lint（零依赖 Node 脚本） |
| `skills/design/design-resources/` | 第三方设计资源（骨架、设计系统、craft、子技能），按上游字节保留 |
| `hooks/` | SessionStart hook：`run-hook.cmd`（sh/cmd 双写法）调 POSIX sh 脚本 `design-rules` |
| `test/` | 插件内容与脚本测试，不随包发布（SEA、桌面 staging、远端复制的白名单都不含 `test/`） |

## SessionStart 注入预算

用户启用后每个会话都带这段注入，所以只放一句指针和路径基准：

```
For an HTML design, prototype, HTML deck or redesign, load the `design` skill first. Its paths are relative to: <skill dir>
```

去掉路径约 110 字节（原 0.7.0 市场版约 285 字节）。`test/design-plugin.test.ts` 钉住上限 160 字节，
入口正文缺失或路径错误时 hook 静默退出 0，不阻塞会话。

## 注册点

内置插件有多个读取入口，漏一处就会出现「列表里有、会话里找不到」（见
[zcode-guide 内置插件](zcode-guide-builtin-plugin.md) 的 c0120fa 教训）。

| 文件 | 改动 |
|---|---|
| `packages/bootstrap/src/app/official-plugin-definitions.ts` | 定义条目，不声明 `defaultEnabled`，listing「Design / 设计」，`OFFICIAL_DESIGN_REQUIRED_SEED_PATHS` 钉入口、7 份规则、3 个脚本与 hook |
| `packages/cli/scripts/sea-official-plugin-assets.mjs` | SEA 资源，`requiresRuntime: false`，必需文件同上 |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs` | Electron 生产包 staging（`packages/desktop/test/runtime-asset-scripts.test.ts` 名单同步） |
| `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts` | 远端 Agent 官方插件复制名单与必需文件 |
| `packages/shared/src/plugin-marketplaces.ts`、`packages/services/src/plugins/officialPluginCache.ts` | Settings / services 侧默认启用集合不包含 design |
| `packages/ui/src/lib/builtinSkillI18n.ts` | `design` 技能中英描述、内置插件名与路径标记 |
| `docker/plugin-eval/Dockerfile` | 评测镜像 stage 的纯内容型内置插件 |
| `.gitattributes` | `design-resources/**` 按字节保存；两个 hook 脚本固定 LF |

版本在 `package.json`、两份 `plugin.json`、definitions、SEA 清单五处一致，由 bootstrap 与 build-sea 测试机械对照。

## 与 CDN 同名条目

官方市场的内置分片与 CDN 分片同名时，合并目录以 CDN 条目为准，内置缓存不删除
（`adapters/src/plugins/official-marketplace.ts`）。2026-11-04 核对正式 CDN 的 `marketplace.json`：没有 `design` 条目，
只有另一个设计插件 `designcraft`，所以当前老用户升级后只会拿到内置版本（当前 0.7.2）。之后不要往 CDN 发同名 `design`。
装过 `designcraft` 的用户会同时有两套设计技能，是否下架或合并 `designcraft` 由插件 owner 决定。

## 第三方许可与竞品词

- `design-resources` 的上游（open-design、html-ppt、Zara Zhang 模板、frontend-slides、gstack 子技能、
  brand-guidelines、frontend-design、taste-skill）登记在 `third-party/copied-components.json`，各条目按文件
  Git blob 比对固定了上游 revision，许可原文快照在 `third-party/upstream/`；本地改过的文件带 `Modified by ZCode:`
  并列入 `modifiedFiles`，来源与改动汇总在 `design-resources/NOTICE.md`。open-design 主体是 Apache-2.0（早先误记为
  MIT）。competitive-ads-extractor 的上游从没有许可原文，已移除。
- 第三方原文里的品牌名、工具名按字节保留，按精确路径登记在 `opensource/approved-terms.d/design-plugin.json`；
  本仓库自有文件（测试、规则）使用中性表述。

## 验证

- `pnpm --filter @zcode/design-plugin test`：插件结构、规则体量与链接、hook 输出、catalog 新鲜度、design-lint、
  设计系统导入。
- bootstrap `plugins.test.ts` / `bundled-plugins-resilience.test.ts`、cli `build-sea.test.mjs`、
  `pnpm test:engineering packages/desktop/test/runtime-asset-scripts.test.ts`。
- 实机：`zcode plugins list --json` 能看到 `design` 且默认 `enabled: false`；用户启用后真实会话里设计类请求会加载 `design` 技能。
