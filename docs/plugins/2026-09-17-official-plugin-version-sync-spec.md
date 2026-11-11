# 官方插件版本同步规格：node-repl-host / Browser Use 0.5.0 与 Computer Use 0.6.0

> 日期：2026-09-17
> 状态：已实现并验证
> 关联改动：Computer Use 换成 node_repl SDK 重建，node_repl 宿主从 Browser Use 抽成独立
> 官方插件 `@zcode/node-repl-host`。

本规格同时覆盖三个包，因为这次它们的版本事实源清单**结构性地变了**：Browser Use 原本的
五处事实源里，第五处 `NODE_REPL_SERVER_VERSION` 随宿主迁出，成了 node-repl-host 自己的
记录。此前每版一份的 `docs/browser-use/*-browser-use-plugin-version-*-spec.md` 系列只描述
单插件，无法表达迁出后的归属。

## 1. 版本决策

| 包 | 旧版本 | 新版本 | 决策依据 |
| --- | --- | --- | --- |
| `@zcode/browser-use-plugin` | 0.4.2 | 0.5.0 | 发布单元内容变了：node_repl MCP server 不再由本插件携带（`dist/mcp/server.js` 移出 seed 清单），插件只剩 skill、client runtime 与文档。这是发布物构成的变化，不是缺陷修复，取 minor。 |
| `@zcode/node-repl-host` | 0.4.2 | 0.5.0 | 宿主契约本身变了：从 Browser Use 内部抽成独立 seed 单元，工具面随 Computer Use 的 node_repl SDK 重建调整。抽出时它继承了 Browser Use 的 0.4.2，本次按同一 minor 台阶抬到 0.5.0。 |
| `zcode-cua` / `@zcode/zcode-cua-plugin` | 0.5.14 | 0.6.0 | producer 侧是破坏性重建（`feat(cua)!`：工具面、后台输入与观察面破坏性重构），patch 号不足以让下游区分新旧 producer。 |

node-repl-host 与 Browser Use 数字相同**只是同源历史的巧合**，不构成耦合：两者各自独立升版，
`NODE_REPL_SERVER_VERSION` 的注释里已就地记录这一点。

## 2. 版本事实源

### 2.1 Browser Use（四处，手工维护）

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`；
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `browser-use` 条目；
4. SEA `officialSeaPlugins` 里 `browser-use` 条目。

原第五处 `NODE_REPL_SERVER_VERSION` 已不属于本插件——它随宿主迁到 node-repl-host。

### 2.2 node-repl-host（五处，手工维护）

1. `apps/zcode-cli/packages/node-repl-host/package.json`；
2. `apps/zcode-cli/packages/node-repl-host/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `node-repl-host` 条目；
4. SEA `officialSeaPlugins` 里 `node-repl-host` 条目；
5. `src/tool-contract.ts` 的 `NODE_REPL_SERVER_VERSION`，即 MCP `serverInfo.version`。

`dist-types/` 是 `tsc` 的声明产物，不入 git（与 browser-use-plugin 一致）。包的 `exports`
直接指向 `src/*.ts`，没有消费方读取它；曾经入库时每次改 src 都会让构建产生脏改动，且容易落后 src。

node-repl-host 不是面向用户的插件：无 skill、无市场 listing、无图标，但必须始终随发布物嵌入，
否则 Browser Use 或 Computer Use 任一启用时都没有宿主可跑。

### 2.3 Computer Use（机器派生，**不要手改**）

CUA 的版本真相源是 workspace 包 `packages/zcode-cua/package.json` 的 `version`（2026-09 起
CUA 并入 monorepo，git SHA pin、`bump-zcode-cua-producer.mjs`、`upstream.json` 已删除，见
`docs/cua/zcode-cua-monorepo-migration.md`）。下列记录由 `check-version-coherence.mjs` 写回，
手改任一处都会被 `--check` 判为漂移：

- producer `plugin/.zcode-plugin/plugin.json`；
- wrapper `package.json` 与 `.zcode-plugin/plugin.json`；
- Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS` 里 `computer-use` 条目；
- 各消费方（desktop / services / node-repl-host / core / adapters / wrapper）对 `@zcode/zcode-cua`
  的依赖声明必须是 `workspace:*`。

`dist/` 不入 git：版本经 esbuild define `__ZCODE_CUA_VERSION__` 注入 bundle，改版本号后必须
重跑 `pnpm build:cua`（根 `prepare` 与 CI 安装后都会执行），否则本地 dist 仍是旧版本号。

## 3. 发布与缓存链路

```text
browser-use:     package / manifest / Bootstrap / SEA            = 0.5.0
node-repl-host:  package / manifest / Bootstrap / SEA / serverInfo = 0.5.0
computer-use:    workspace package -> wrapper / Bootstrap         = 0.6.0
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> <plugin>/<version>
                         |
                         v
 新 runtime 与其版本身份一起生效
```

官方 cache 目录名带版本号，因此升版后 seed 进新目录；旧目录可作为历史缓存保留，但官方
discovery 只应指向新版本。

## 4. 兼容边界

- 不改协议、不改 `ToolResultPayload` 等既有数据形态；本次只改版本身份与其同步点。
- 历史版本规格（`0.4.1`、`0.4.2` 等）继续记录旧版本事实，**不回写为新版本**。
- Browser Use 的 SEA 条目注释此前硬编码了当时的版本号，本次改为版本中立表述，去掉一个多余的
  漂移点（同文件 document-skills 条目的注释本来就是中立的）。

## 5. 防漂移的机械校验

| 校验点 | 覆盖范围 |
| --- | --- |
| `plugins.test.ts`「keeps every bundled plugin package, manifest, and seed version aligned」 | 逐个官方插件比对 package / manifest / Bootstrap definition |
| `build-sea.test.mjs`「keeps SEA official plugin versions aligned with package and plugin manifests」 | 逐个 SEA 条目比对 package / manifest / SEA 清单 |
| `node-repl-host/test/mcp-server.test.ts` | 钉住 `serverInfo.version` == 本包 `package.json.version` |
| `check-version-coherence.mjs --check` | 钉住 CUA 全链（workspace producer / producer manifest / wrapper / 官方定义 / 消费方 `workspace:*`） |

## 6. 验证

见本次提交的验证记录：producer 侧 typecheck / lint / 单测；消费侧
`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测与 CLI 子
workspace 单测。
