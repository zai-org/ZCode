# 插件发布：从插件商店下载带扩展的插件

> 状态：§4 与 §6.3 的 z-code 一侧已实现（商店挡不兼容版本、安装前显示扩展信息、示例迁出，2026-11-07）；其余是设计。上位规格是[扩展进程](./extension-host.md)。z-code 代码位置按 staging `0e7fd207a2` 核对；市场仓库 `zcode-plugins` 按 staging `b67164f9` 核对。
>
> 前提：MR !3556（扩展回答审批与提问、切换权限模式、已有授权重新确认、context-inspector 总量对齐、dot 改名 Jarvis）已合入 staging（2026-11-07）。本文的 Jarvis、插件 API `1.4.0` 都来自这个 MR。

## 1. 问题

- 带扩展的示例插件 Jarvis 与 context-inspector 写在 z-code 的 `examples/plugins/` 里（2026-11-07 已迁出，§6.3），只能用开发配置 `plugins.dirs` 加载。用户想从插件商店下载它们。
- 插件作者写扩展代码要用类型包。类型包现在是 `private`，只在仓库里用（[extension-host.md](./extension-host.md) §17.9）。
- 市场目录没有版本门槛：每个插件只列最新版，ZCode 不检查自己能不能运行这个版本。旧 ZCode 会被「更新」成跑不起来的新版插件，也装不回旧版。

## 2. 决策

| 决策                                                                                                   | 状态                   |
| ------------------------------------------------------------------------------------------------------ | ---------------------- |
| Jarvis 与 context-inspector 的源码迁到市场仓库 `zcode-plugins`，以那边为准；两个都上架                 | 用户决策，2026-11-06   |
| 迁走以后，z-code 只留测试用插件                                                                        | 用户决策，2026-11-06   |
| 类型包发布为 `@zcode-dev/plugin-api`（`@zcode` 已被别人占用）；由用户手动发布，要发时先通知用户        | 用户决策，2026-11-06   |
| 官方插件与社区插件都可以带扩展代码                                                                     | 用户决策，2026-11-06   |
| 插件与宿主是否兼容只看版本号，不做能力判断                                                             | 用户决策，2026-11-06   |
| 只有一份 `marketplace.json`。已经装在用户机器上的旧版 ZCode 看到、装上用不了的插件，接受               | 用户决策，2026-11-06   |
| 版本号用插件 API 版本，不用 App 版本（§3.1）                                                           | 用户决策，2026-11-07   |
| 目录只列最新版；新版插件不兼容时商店挡住：不能装，也不提示更新（§4.3）                                 | 用户决策，2026-11-07   |
| 社区扩展不加专门的防护（§7）                                                                           | 用户决策，2026-11-07   |
| 插件自己只做构建与清单校验，不写插件自己的自动化测试；上架前人工验收（§6.1）                           | 用户决策，2026-11-07   |
| 只有 MCP Apps 页面、没有扩展的 UI 插件，现在不声明插件 API 版本（§3.1）                                | 用户决策，2026-11-07   |
| 商店详情页在安装前显示「含常驻代码」和申请的权限（§4.4）                                               | 用户决策，2026-11-07   |
| context-inspector 照常上架。市场仓库 2026-10-22 撤下过两个上下文插件（含 `zcode-context`），原因没记录 | 用户决策，2026-11-07   |
| 测试市场可以先于 ZCode 发版上架；正式市场等发版（§3.4）                                                | 按推荐写入，用户未确认 |
| 带扩展的插件源码放市场仓库的 `ui-plugins/<名字>`，不改构建流水线（§8）                                 | 按推荐写入，用户未确认 |

## 3. 版本

### 3.1 一个号：插件 API 版本

- App 在构建时固定一个常量：它实现的插件 API 版本。现在叫 `EXTENSION_API_VERSION`（`packages/shared/src/extension-host/manifest.ts:14`；staging 为 `1.3.0`，MR !3556 为 `1.4.0`）。它不是 App 版本。
- 类型包的版本号等于这个常量。工程测试已经钉住两者相等（`packages/plugin-api/test/version.test.ts`）。
- 插件在清单 `extension.engines.zcode` 写它需要的范围，例如 `^1.4.0`。只支持 `^x.y.z` 与精确版本（[extension-host.md](./extension-host.md) §5）。
- 只有带扩展的插件声明版本。只有 MCP Apps 页面的 UI 插件现在不声明、不判断，以后出现不兼容再加（用户决策，2026-11-07）。
- 不用 App 版本的原因：
  - App 版本只能表示「最低版本」，不能表示接口有没有破坏性变化。宿主删掉或改掉一个能力时，没法靠它挡住旧插件。
  - App 发版频繁。作者要查「哪个 App 版本开始有这个能力」；用 API 版本时，作者用哪个版本的类型包就写哪个。

### 3.2 App 怎么判断

```text
App 构建时固定：插件 API 版本 1.4.0
插件清单：     extension.engines.zcode = "^1.2.0"
判断：         主版本相同，并且 App 的版本不低于范围下限 → 兼容
```

| 插件要求 | App 的插件 API 版本 | 结果                         |
| -------- | ------------------- | ---------------------------- |
| `^1.2.0` | `1.4.0`             | 兼容                         |
| `^1.4.0` | `1.4.0`             | 兼容                         |
| `^1.5.0` | `1.4.0`             | 不兼容：要更新 ZCode         |
| `^2.0.0` | `1.4.0`             | 不兼容：要更新 ZCode         |
| `^1.4.0` | `2.0.0`             | 不兼容：要等插件作者更新插件 |

- 判断只在 App 里做。扩展只在 App 里运行，只有 App 知道自己实现的 API 版本。现在扩展进程加载插件时已经这样判断（[extension-host.md](./extension-host.md) §5：不兼容判 `incompatible`，不加载）。本文把同一个判断加到商店与更新提示上。
- 界面只说「需要更新 ZCode」，不写具体的 App 版本号。不维护「API 版本 → App 版本」的对照表。
- 没有 `extension` 的插件不判断，行为不变。

### 3.3 定版规则

| 变化                                 | 版本               |
| ------------------------------------ | ------------------ |
| 新增能力、新增可选字段、新增可选入参 | 升 minor           |
| 删除能力、改变含义、可选改必填       | 升 major，尽量不做 |
| 只修类型定义的错误，运行时行为不变   | 升 patch           |

- 要淘汰的能力先标弃用。弃用的能力和替代它的新能力至少并存一个 minor。
- 升 major 时，所有插件都要更新 `engines`。所以只有在不能用弃用过渡时才升 major。
- npm 上的版本号不能重发。类型包发出某个版本后，这个版本就冻结，再加内容要升 minor。还没发类型包的版本号可以继续加内容，不用再升。例：MR !3556 给 `ContextComposition` 加了可选字段 `providerContextTokens`，仍在 `1.4.0` 里。

### 3.4 发布顺序

两个市场来自市场仓库的两个分支（市场仓库 `docs/marketplace-channels.md`）：

| 市场仓库分支 | 市场 id                  | 目录                                       | ZCode 读不读                                                    |
| ------------ | ------------------------ | ------------------------------------------ | --------------------------------------------------------------- |
| `main`       | `zcode-plugins-official` | `…/zcode/official-plugin/marketplace.json` | 内置，默认读（`packages/shared/src/plugin-marketplaces.ts:48`） |
| `staging`    | `zcode-plugins-test`     | `…/zcode/test-plugin/marketplace.json`     | 默认不读；在「插件市场 → 新增」里手动填地址才看得到             |

```text
① 宿主改动合入 z-code staging，插件 API 升到 1.N.0
        │
② 用户发布 @zcode-dev/plugin-api@1.N.0（之后 1.N.0 冻结，§3.3）
        │
        ├─► 测试市场可以先上（按推荐，未确认）：插件 engines 写 ^1.N.0，合入市场仓库 staging。
        │     只有手动添加了测试市场、用 z-code staging 构建的人能装；版本不够的 ZCode 商店显示「需要更新 ZCode」。
        │
③ ZCode 正式版发出，带插件 API 1.N.0
        │
④ 正式市场上架（插件合入市场仓库 main）
```

- 类型包在 ① 之后就发：市场仓库构建要装它，测试市场上架前必须有。
- 例外（用户决策，2026-11-07：「npm 可以先做，不着急发」，市场改动先上测试市场）：1.4.0 还没发 npm 时，市场仓库在 `vendor/` 里放一份 `pnpm pack` 打出的 tarball，两个插件用 `file:` 依赖它，`validate.py` 从 tarball 里读版本做下限检查。npm 发布后删掉 `vendor/`，依赖改回 `"1.4.0"`，重新生成锁文件。vendor 的 tarball 必须和将来发布的 1.4.0 是同一份构建（2026-11-07 核对过：d.ts 完全相同）。
  正式市场不能比 ZCode 正式版先上。否则目录里的最新版所有人都装不了，已装的用户也收不到能用的更新。

### 3.5 构建时检查

- 市场构建检查：`engines.zcode` 的下限不能低于构建时用的类型包版本。例：用 `@zcode-dev/plugin-api@1.4.0` 构建，`engines` 写 `^1.2.0`，构建失败。
- 原因：插件可能用到 1.3、1.4 才有的能力。装到 1.2 的宿主上，宿主判它兼容，调用时却报「方法不存在」。
- 只比较版本号，不分析插件用了哪些能力（§2：不做能力判断）。
- 类型包版本从哪里读（市场仓库的做法，2026-11-07）：源码包 `ui-plugins/<名字>/package.json` 里 `@zcode-dev/plugin-api` 必须写精确版本（如 `"1.4.0"`，不写 `^`、`~` 或范围）。下限检查读这个精确版本，不读锁文件。
- 例：context-inspector 在市场里的 `engines.zcode` 是 `^1.4.0`。它用了 1.4 才有的 `ContextComposition.providerContextTokens`（§3.3 的例子）。

## 4. 市场目录与商店

### 4.1 数据流

```text
plugins/<名字>/.zcode-plugin/plugin.json（extension.engines、extension 申请的权限档位）
   │ 市场构建（build_dist.py）
   ▼
marketplace.json 条目：componentTypes 含 "extension"；extensionSummary { engines, grants }
   │ CLI 读目录（adapters/src/plugins/marketplace.ts、bootstrap/src/plugins.ts）
   ▼
商店信息（protocol）：带上扩展摘要，CLI 不做判断
   │
   ▼
App：用自己的插件 API 版本判断 ──► 安装按钮、「有更新」、「全部更新」、详情页的扩展说明
```

### 4.2 目录条目

- 只有一份 `marketplace.json`，地址不变。
- 市场构建时，清单有 `extension` 就在 `componentTypes` 里加 `"extension"`，并写一份 `extensionSummary`：

```jsonc
"extensionSummary": {
  "engines": { "zcode": "^1.4.0" },
  "grants": ["sessions.fullAccess", "notifications"] // 清单里扩展申请的权限档位，原样抄
}
```

- 清单的 `extension` 没有 `grants` 时，摘要也写 `grants`，值是空数组 `[]`（不省略这个键）。CLI 读到缺 `grants` 的旧条目时同样按 `[]` 处理（§4.3「字段」）。

- 字段名不用 `extension`：没有 `plugin.json` 的插件，CLI 会用目录条目合成清单（`createManifestFromMarketplaceEntry`），一个不完整的 `extension` 键会被当成清单内容。`extensionSummary` 在合成清单时剔除，与商店信息字段同样处理。
- 旧 ZCode 不受影响：App 的 `componentTypes` 是开放的字符串数组（`packages/shared/src/zcode-protocol/index.ts` 的 `componentTypes: z.array(z.string())`）；目录里不认识的键，CLI 读目录时会忽略。
- 新 CLI 要改：现在 `inferComponentTypes`（`apps/zcode-cli/packages/bootstrap/src/plugins.ts:1376-1386`）只把目录条目里的 `"ui"` 传给 App，要同样传 `"extension"`。

### 4.3 新版 ZCode 怎么挡

- CLI 把 `extensionSummary` 放进商店信息（`zcodePluginStoreListingSchema` 的 `extensionSummary`），不自己判断。
- 兼容约束：商店信息的 schema 是 strict。新字段让旧的一端解析失败，商店就整页打不开。

#### 商店信息经过的层（实现时核对，2026-11-07）

```text
本机工作区：
Renderer ─ MessagePort RPC（不校验）─ Window Host services ─ stdio ─ 本机 CLI
                                       └ zcodeAgentService.getPluginsOverview：strict 解析

远程设备（设置页按设备选 Scope）：
Renderer ─ Window Host（@zcode/rpc 全转发，不校验）─ WS ─ 远端 Server Core services ─ stdio ─ 远端 CLI
                                                         └ strict 解析在远端，与远端 CLI 同一个发行包

Web 与手机远控：浏览器 ─ 远控 bridge 转发（不校验）─ 桌面 Host services ─ stdio ─ CLI
（Web 首页没有插件管理；packages/web/src/main.tsx 的 pluginManagementService 报不可用）
```

- 只有一层用 strict schema 解析商店信息：调用 CLI 的 services（`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `getPluginsOverview`，用 `zcodePluginsOverviewResultSchema`）。Renderer、Window Host 的远程转发、远控 bridge 都不解析，只按 TypeScript 类型读。所以 Desktop 与远端 Server 的版本差不会让解析失败：旧 Renderer 不读新键，新 Renderer 读不到时按「没有扩展摘要」处理。
- services 与它调用的 CLI 版本可能不同：环境变量 `ZCODE_AGENT_SERVER_COMMAND` 指定的 CLI，远端兜底用的已部署 CLI 二进制（`zcodeAgentProcessManager.ts` 的 `resolveDefaultZCodeAgentCommand`）。所以 CLI 不能无条件加新字段，services 也不能盲发新参数。

#### 做法：能力位 + 请求参数（选定，2026-11-07）

1. CLI 在 `runtime/capabilities` 声明 `pluginExtensionSummary: true`。能力结果的 schema 不是 strict，旧 services 收到会忽略。
2. services 取商店信息前读一次能力位：每个 CLI 连接只读一次，复用 `independentPlanSupport.ts` 的 `discoverCapabilities`。读不到（旧 CLI 没有这个方法、请求失败）按不支持处理。
3. 看到能力位，services 才在 `plugins/overview` 的参数里带 `includeExtensionSummary: true`。参数 schema 是 strict，旧 CLI 收到多出的键会整条拒绝。
4. CLI 只在参数带 `includeExtensionSummary: true` 时，才在 `availablePlugins[].listing` 与 `installedPlugins[].listing` 里写 `extensionSummary`。其他方法不带：安装、卸载、更新的结果，`plugins/resolveSuggestedReference`。
5. `componentTypes` 里的 `"extension"` 照常传。它是开放的字符串数组，旧 App 不会解析失败。

services（App 一侧）与 CLI：

| services | CLI | `plugins/overview` 请求            | 返回                  | 商店                                                     |
| -------- | --- | ---------------------------------- | --------------------- | -------------------------------------------------------- |
| 新       | 新  | 带 `includeExtensionSummary: true` | 带 `extensionSummary` | 按插件 API 版本挡                                        |
| 新       | 旧  | 没有能力位，不带                   | 不带                  | 和现在一样，不挡；装上后扩展进程判「版本不兼容」（§4.5） |
| 旧       | 新  | 旧参数没有这个键                   | 不带                  | 和现在一样                                               |
| 旧       | 旧  | 不带                               | 不带                  | 和现在一样                                               |

Desktop（Renderer）与远端 Server（services 与 CLI 同一个发行包）：

| Desktop | 远端 Server | 结果                                            |
| ------- | ----------- | ----------------------------------------------- |
| 新      | 新          | 带 `extensionSummary`，按本机 App 的 API 版本挡 |
| 新      | 旧          | 不带，不挡                                      |
| 旧      | 新          | 带，旧 Renderer 不读这个键，不挡，商店照常打开  |
| 旧      | 旧          | 和现在一样                                      |

- 远程设备的商店也按本机 App 的 API 版本判断，与本机商店一样，不另做区分。远端装的插件不运行扩展代码（[extension-host.md](./extension-host.md) §2），所以这里的判断与说明对远程设备只是提示（实现时的决定，用户未确认）。

#### 字段

```jsonc
// listing.extensionSummary（protocol）
{ "engines": { "zcode": "^1.4.0" }, "grants": ["sessions.fullAccess", "notifications"] }
```

- CLI 只在目录条目的 `extensionSummary.engines.zcode` 是非空字符串时写这个字段。`grants` 只留字符串，没有时是 `[]`。其余键丢掉，所以线上只有这两个键，schema 可以是 strict。以后要加键，再加一个能力位。
- CLI 不检查范围格式（只透传）。App 用扩展进程加载清单时的同一个函数判断：`isExtensionEngineCompatible`（`packages/shared/src/extension-host/manifest.ts`），对 App 的 `EXTENSION_API_VERSION`。
- 范围格式 App 不认识时（例如以后的新写法）判不兼容，显示「需要更新 ZCode」：新版 App 可能认识它。
- 已装插件的 `listing` 来自目录里的最新版条目，所以 `installedPlugins[].listing.extensionSummary` 说的是最新版，不是已装的版本。

#### 不兼容时

- 商店：安装按钮换成不能点的「需要更新 ZCode」（卡片与详情页是同一个按钮）。详情页简介下面另起一行，说明要先更新 ZCode。
- 已装的插件：最新版不兼容时，不显示「有更新」（卡片角标、行内更新按钮、详情页更新区），「全部更新」跳过它，「检查更新」的计数不算它。已装的版本照常运行。更新提示现在由 CLI 按版本号算（`adapters/src/plugins/version-compare.ts`），App 显示前再按兼容过滤：`packages/ui/src/settings/pluginStoreListing.ts` 的 `canUpdatePluginItem` 与 `needsPluginUpdate`。
- 范围只到商店与插件列表。其他安装入口不挡（实现时的决定，用户未确认）：会话里的插件推荐卡片（`plugins/resolveSuggestedReference` 不带扩展摘要）、Side Pane 的默认界面推荐（只推荐 MCP Apps 界面插件）、数据同步把本机插件推到远端。

### 4.4 安装前显示（用户决策，2026-11-07）

- 带扩展的插件，商店详情页在安装前显示「含常驻代码」，并列出申请的权限档位，文案沿用授权对话框的档位说明。申请了完全访问（`sessions.fullAccess`）时单独一行，写明它的含义。
- 这里只是告知。真正的授权仍在激活时的授权对话框里做（[extension-host.md](./extension-host.md) §17.7）。
- 实现（2026-11-07）：
  - 只看 `listing.extensionSummary`，兼容与不兼容都显示。位置与已装插件的「权限」区块相同（信息区之后）：未安装时显示这一区，已安装时显示「权限」区块。
  - 标题「含常驻代码」，一行说明：启用后，扩展代码在 ZCode 里常驻运行。
  - 「申请的权限」：档位先按会话档位链收窄（`normalizeGrants`：完全访问包含读写，读写包含读取），每个档位一行，用授权门面的档位名（`extensions.grants.tier.*`，如「读写会话（含完全访问）」「发送系统通知」）。App 不认识的档位显示原文。没有档位时显示「不申请权限」。
  - 申请了完全访问时另起一行，用授权对话框的完全访问原文（`extensions.grants.dialog.fullAccessBody`）。
  - 最后一行：这里只是说明，安装后要在授权对话框里授权，插件才能用这些权限。

### 4.5 存量旧版 ZCode

| 存量版本                 | 商店里               | 装上以后                                                                      |
| ------------------------ | -------------------- | ----------------------------------------------------------------------------- |
| 没有扩展进程             | 看得到，能装         | 扩展部分不运行，只剩插件的其他组件                                            |
| 有扩展进程，API 版本较低 | 看得到，能装，能更新 | 扩展显示「版本不兼容」，不加载（[extension-host.md](./extension-host.md) §5） |

用户决策（2026-11-06）：接受，不为存量版本做额外处理。

## 5. 类型包 `@zcode-dev/plugin-api`

- 包名从 `@zcode/plugin-api` 改为 `@zcode-dev/plugin-api`，import 路径跟着改。
- 去掉 `private`。LICENSE 用 Apache-2.0，与 z-code 开源版、市场仓库一致（用户 2026-11-07「做吧」，按推荐）。包里带 `LICENSE` 与面向插件作者的 `README.md`。
- 版本等于插件 API 版本（§3.1）。只有类型，没有运行时代码（[extension-host.md](./extension-host.md) §17.9）。
- 发布由用户手动做（`@zcode-dev` 是我们的 npm 组织，用户有发布权限）。要发时先通知用户。发布前在仓库里跑 `pnpm --filter @zcode-dev/plugin-api build` 与 `pnpm pack`，检查包里只有 `dist/*.d.ts`、`LICENSE`、`README.md`、`package.json`。
- 正式市场上架前必须先发布；测试市场可以先用 `vendor/` 里的临时副本（§3.4 的例外）。

## 6. 迁移

前提：MR !3556 已合入 staging（2026-11-07）。市场仓库先上测试市场（类型包用临时副本，§3.4）。z-code 里的示例随商店的 MR 一起删除（用户决策，2026-11-09）：源码已经在市场仓库，以后只在那里改；z-code 再留一份只会和它越改越不一样。验收发现的问题也在市场仓库里修。

### 6.1 验证（用户决策，2026-11-07）

- 市场仓库对这两个插件只做构建与清单校验（§8 的 `validate.py`），不写插件自己的单测或页面测试。
- 上架前人工验收：在桌面端从测试市场安装，启用、授权，走一遍主流程；深浅主题、中英文各看一遍。
  - Jarvis：发消息、回复流式显示、在页面里审批与回答提问、切换权限模式。
  - context-inspector：生成速率插槽、上下文组成视图的总量与输入框圆环一致。
- 宿主能力仍由 z-code 的 fixture E2E 覆盖（§6.3）。

### 6.2 市场仓库

见 §8。

### 6.3 z-code（已完成，2026-11-07）

- 删除 `examples/plugins/jarvis` 与 `examples/plugins/context-inspector`，根 `typecheck` 去掉这两个目录。示例现在在市场仓库的 `ui-plugins/jarvis`、`ui-plugins/context-inspector`。
- 删除用例 PLM-EXT-2C（context-inspector）、PLM-JARVIS-1、PLM-JARVIS-2，以及只给它们用的 helper（`jarvis-example.ts`）、用例清单与回放夹具。按 `git grep` 核对，没有别的用例用到这两个示例。
- 它们断言的宿主行为逐条对照 fixture 用例（[覆盖矩阵](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」），没有一项留「未覆盖」。原先只有示例用例覆盖的，补进 fixture 用例（迁移 commit 之前的两个 commit，所以迁移可以单独拿掉）：
  - PLM-EXT-2B：没有文字的插槽不显示、类别条目、final 事件的模型与 token、`providerContextTokens` 等于输入框圆环、页面跟随主题与语言、关掉视图标签与 `onDidClose`。
  - PLM-EXT-P3B：重新加载扩展后行订阅收到 `reset`；长历史的尾部窗口与 `readRows` 往前翻页（`hasMore`）。
  - PLM-EXT-P3C：流式期间行逐段到达；本轮失败（`turnHeader` 为 `failed`）；删除任务后 `sendToSession` 报 `forbidden`、已开的行订阅不结束。
  - PLM-EXT-P3E：提问的选项；完全访问后切回 build；行镜像里工具行的状态。
  - PLM-EXT-JARVISHOST：`models.list` 的第二个模型；扩展进程被杀后 App 作用域视图恢复；App 重启后 `dataPath` 数据还在；`grants.request` 申请完全访问。
  - PLM-EXT-P2D：`settings.update` 写非敏感键。
- 纯插件界面的断言删掉（§6.1：插件只做构建与清单校验，人工验收）。

### 6.4 用户看到的变化

- 插件 id 从 `jarvis@inline` 变成 `jarvis@<市场 id>`，context-inspector 同样。本地数据（大脑会话、人设、插件设置、授权）不带过去，要重新启用和授权。
- 显示名：现在宿主有几处显示清单名，所以是小写 `jarvis`，例如授权对话框、toast、插件项目名。市场条目有 `displayName`。迁移时确认这几处读不读它。

## 7. 社区扩展（用户决策，2026-11-07）

- 不加专门的防护。
- 原因：社区插件现在就能通过 MCP stdio 服务与 hooks 运行任意代码，这些代码本来就能改 `grants.json` 与配置文件。扩展在同一个进程里能冒充别的扩展（[extension-host.md](./extension-host.md) §7.3），多出来的风险很小。真正的边界是「用户信不信这个插件的代码」，对所有带代码的插件都一样。
- 保留已有的两层：商店安装后的激活确认（§17.7，P3b），授权对话框里的同进程提示。
- 市场审核：扩展代码按现有社区插件代码的审核方式处理。

## 8. 市场仓库改动

| 位置                                                  | 改动                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui-plugins/jarvis/`、`ui-plugins/context-inspector/` | 新增：源码（`src/extension.ts`、`src/view/`…）与 `package.json`（`build` 脚本；版本与清单一致；依赖 `@zcode-dev/plugin-api`）。`scripts/plugin-catalog.mjs:33` 只在 `ui-plugins/<名字>` 找源码，沿用这个目录，不改流水线（按推荐，未确认） |
| `plugins/jarvis/`、`plugins/context-inspector/`       | 新增：`.zcode-plugin/plugin.json`（`extension.main: "./dist/extension.js"`）、README、图标。`dist/` 由 `scripts/build-plugins.mjs` 构建后复制过来，不入库（`.gitignore` 已忽略）                                                           |
| `marketplace.json`                                    | 两个条目：`displayName`、`description_i18n`、`icon`、`category`、`keywords`                                                                                                                                                                |
| `scripts/build_dist.py` 的 `build_index_entry`        | 清单有 `extension` 时 `componentTypes` 加 `"extension"`，写 `extensionSummary`（§4.2；没有 `grants` 时写 `[]`）。能力只认包内清单，不接受目录条目自报，与现有 `ui` 的规则相同                                                              |
| `scripts/build_dist.py` 的 `build_zip`                | 打包时检查 `extension.main` 指向的文件在插件目录里，不在就失败。放在打包阶段的原因：CI 第一次跑 `validate.py` 时还没有构建产物（`dist/` 由 `scripts/build-plugins.mjs` 构建后才复制进来）                                                  |
| `scripts/validate.py`                                 | §3.5 与下面两项：`engines.zcode` 格式合法；下限不低于 `@zcode-dev/plugin-api` 的版本。版本读 `ui-plugins/<名字>/package.json` 里写的精确版本（§3.5：必须是精确版本），不读锁文件                                                           |
| `tests/`                                              | 给 `build_dist.py`、`validate.py` 的新规则加 python 测试。这是市场工具自己的测试，不是插件测试                                                                                                                                             |
| 文档                                                  | 新增一篇：带扩展的插件怎么开发、调试、提交（本地用 `plugins.dirs` 加载、构建、上测试市场）；README 补 `extension` 组件类型                                                                                                                 |

`scripts/build-plugins.mjs` 不用改：它按 `package.json` 的 `build` 构建、复制 `dist/`，与插件类型无关。

## 9. z-code 改动范围（估计）

| 位置       | 改动                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| shared     | 商店信息加扩展摘要；能力位 `pluginExtensionSummary` 与 `plugins/overview` 参数 `includeExtensionSummary`（§4.3） |
| CLI        | `inferComponentTypes` 传 `"extension"`；把 `extensionSummary` 放进商店信息；合成清单时剔除                       |
| UI         | 商店与插件列表按兼容判断：安装按钮、「有更新」、「全部更新」；详情页的「含常驻代码」与权限说明（§4.4）           |
| plugin-api | 改名、去掉 `private`、LICENSE                                                                                    |
| z-code E2E | 用到示例插件的用例改用测试用插件；新增商店挡不兼容版本、安装前显示的用例                                         |

## 10. 待定

1. 测试市场可以先上（§3.4）、源码目录沿用 `ui-plugins/`（§8）：按推荐写入，用户未确认。
2. LICENSE（§5）。
3. 常量 `EXTENSION_API_VERSION` 要不要改名为 `PLUGIN_API_VERSION`。现在只有扩展声明版本，先不改。
4. 商店信息新字段的兼容做法（§4.3）：已选定能力位 + 请求参数。远程设备商店也按本机 API 版本判断、其他安装入口不挡：实现时的决定，待用户确认。

## 11. 验收（实现时）

- 新版 ZCode：目录里 `engines` 要求更高 API 版本的插件，商店显示「需要更新 ZCode」，不能装。
- 已装插件的新版不兼容：不显示「有更新」，「全部更新」跳过它；已装版本照常运行。
- 没有 `extension` 的插件：商店与更新行为不变。
- 商店详情页：带扩展的插件在安装前显示「含常驻代码」和申请的权限；Jarvis 显示完全访问一行。
- 版本不同的 Desktop 与远端 Server：商店照常打开，不因新字段解析失败。
- 市场构建：`engines` 下限低于源码包 `package.json` 里类型包的精确版本时失败；打包（`build_zip`）时 `extension.main` 文件不存在就失败；`componentTypes` 含 `extension`；没有 `grants` 时摘要写 `[]`。
- 从测试市场安装 Jarvis：能启用、授权、使用，插件 id 带市场 id；§6.1 的人工验收项都过。
