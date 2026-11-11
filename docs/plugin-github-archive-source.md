# 公开 GitHub 插件源无 Git 安装规格

## 状态

- 日期：2026-08-06
- 基线：`origin/staging`
- 决策：公开 GitHub HTTPS 来源优先使用 GitHub Archive；不在 Desktop 或 Agent 包内内置 Git。

## 问题与根因

当前 Marketplace 和插件 entry 的 `github`、`git`、legacy `url`、`git-subdir` 来源最终都会
进入 `execFile("git", ...)`。这使插件管理能力隐式依赖运行 ZCode Agent 的主机已安装 Git：

- Desktop 本地 workspace 依赖本机 Git；
- standalone CLI 依赖 CLI 所在主机 Git；
- SSH、WSL、Docker workspace 依赖远端 Agent Host 内的 Git，而不是 Desktop 内的 Git。

已安装插件的启动发现、启停和会话注入只读取本地 installed cache，本身不需要 Git。问题属于
“远端来源物化”边界的设计缺口，不应通过在 UI、Desktop main 或 relay 增加特殊分支解决。

## 目标

1. 所有可匿名读取的 `github.com` HTTPS Marketplace 和插件来源，在系统没有 Git 时仍可刷新、
   校验、describe、安装和更新。
2. GitHub Archive 与现有显式 ZIP 共用下载、限额、安全解压和代理能力，但不混淆两种完整性语义：
   显式 ZIP 校验 `sha256`，GitHub Archive 绑定 Git `sha` / `commit` / `ref`。
3. Marketplace snapshot 和 installed plugin cache 在失败、取消或进程异常前后始终保留一个完整、
   可离线读取的旧版本。
4. 批量刷新按 Marketplace 隔离失败；一个来源失败不能阻断其他来源，也不能删除上次成功快照。
5. 私有仓库、SSH、非 GitHub Git 服务和确实需要 Git 高级语义的来源继续走系统 Git；无 Git 时返回
   结构化、可操作的诊断。
6. 同一 adapter 实现在 macOS、Windows、Linux，以及 Desktop local、standalone CLI、
   SSH/WSL/Docker Agent Host 中生效。

## 非目标

- 不内置或下载 Git 可执行文件，不引入 libgit2/isomorphic-git。
- 不为私有 GitHub token/SSH key 新建凭据协议。
- 不改变插件启用、Hook 信任、MCP、Skill、Subagent 或会话注入语义。
- 不把插件业务状态下沉到 Desktop main、remote relay 或手机端。
- 不实现跨多个 JSON/目录的一体化分布式事务；每个被替换的 target 使用同目录恢复标记与
  确定性 backup，在下次状态加载或插件发现前恢复提交窗口。

## 目标链路

```text
Settings / CLI command
        |
        v
plugins protocol -> workspace Agent Host (local / SSH / WSL / Docker)
        |
        v
source classifier
        |
        +-- public github.com HTTPS / github shorthand
        |       |
        |       v
        |   pin = sha/commit > ref > HEAD
        |       |
        |       v
        |   GitHub Archive REST zipball (HTTPS -> codeload redirect)
        |       |
        |       v
        |   bounded download -> secure extract -> semantic validation
        |
        +-- private/auth/SSH/non-GitHub/submodule/LFS
                |
                v
             system Git
                |
                +-- unavailable -> structured actionable diagnostic

validated source tree
        |
        v
same-volume staging copy
        |
        v
write transaction marker
        |
        v
target -> backup ; staging -> target ; authority JSON writes transactionId
        |                         |                    |
        +------ failure ----------+--> backup -> target rollback
                                                   |
                                                   v
                                  finalize removes backup + marker
        |
        +------ process exit -----> next read cross-checks authority generation

startup / discovery / enable / session injection
        |
        +----------------------------> installed cache only (no HTTP, no Git)
```

## 来源分类与 pin

### GitHub Archive 候选

以下来源在仓库 URL 可规范化为 `https://github.com/<owner>/<repo>[.git]`，且 Marketplace
没有声明 `sparsePaths` 时优先使用 Archive：

- Marketplace `{source:"github", repo, ref?, path?}`；
- Marketplace `{source:"git", url, ref?, path?}`；
- plugin entry `{source:"github"}`、`{source:"git"}`、`{source:"url"}`、
  `{source:"url", type:"git"}`、`{source:"git-subdir"}`。

只接受 `github.com` / `www.github.com` 的 HTTPS URL 和 `owner/repo` shorthand。SSH、`git://`、
带 userinfo 的 URL、其他 host 不进入 Archive 路由。仓库 URL 必须恰好解析出 owner 和 repo，拒绝
额外的 tree/blob 页面路径。

Archive ref 选择顺序固定为：

```text
source.sha || source.commit || source.ref || "HEAD"
```

`sha` / `commit` 是 Git 对象身份；`ref` 和 `HEAD` 可能随远端变化。它们都不等于 ZIP 字节的
SHA-256，不能写入或复用 `sha256` 字段。

### 系统 Git 路由

以下来源保留系统 Git：

- SSH、非 GitHub host、带凭据或需要认证的 URL；
- 声明 `sparsePaths` 的 Marketplace；Archive 尚未实现与 Git sparse checkout 等价的路径投影，
  不能先下载整仓而破坏既有大仓库可用性；
- Archive 返回 401、403 或 404，可能是私有仓库或不可匿名读取；
- 解压后的目标路径确认依赖 submodule，或目标插件文件是 Git LFS pointer；
- 无法安全、无歧义地规范化为 GitHub 仓库的 legacy source。

Archive 的超时、连接失败、5xx、限额或安全校验失败不自动改走 Git，以免把同一网络/恶意包错误
重复执行成另一条不可预测路径。只有“需要 Git 语义/认证”的分类才 fallback。

系统 Git 不存在时诊断码为 `plugin_git_unavailable`，消息必须说明：来源、为什么该来源需要 Git，
以及在当前 Agent Host 安装 Git或改用公开 GitHub HTTPS/显式 ZIP 的恢复办法。

## 下载与解压安全

GitHub Archive 和显式 ZIP 的 GET 下载在连接重置（`ECONNRESET` 或原生 fetch 的
`UND_ERR_SOCKET`）时，等待可取消的 250ms 后仅重试当前 URL 一次。每次重定向重新计算代理，
沿用跨 origin 清除自定义 header 的规则。重试前不写入或激活插件目录；最终下载成功后仍完成
原有摘要、大小与解压校验。证书错误、取消、超时、HTTP 错误和内容校验失败不自动重试，也不
绕过代理或证书校验。持续连接中断仍返回来源诊断，旧缓存保持不变。

GitHub Archive 使用官方 `repos/{owner}/{repo}/zipball/{ref}` REST endpoint，并复用
`zip-source.ts` 的底层 HTTP ZIP materializer：

- 远端只允许 HTTPS；测试 fixture 仅允许 loopback HTTP；
- 使用统一 proxy/CA/NO_PROXY 网络环境；
- 最多 5 次重定向，跨 origin 不转发自定义 header；
- 压缩包最大 100 MB、解压后最大 250 MB、最多 20,000 entries、单文件最大 50 MB；
- 拒绝 zip-slip、绝对路径、符号链接和特殊文件；
- GitHub Archive 自动剥离唯一顶层目录，再在其内解析插件或 Marketplace `path`；
- `sparsePaths` 不进入 Archive 路由，继续由系统 Git sparse checkout 执行。

显式 `{source:"url", type:"zip"}` 继续强制 `sha256`。GitHub Archive 不要求 archive SHA-256，
但若 source 提供 commit pin，则下载 URL 必须绑定该 commit。

## 原子缓存激活

Marketplace snapshot 与 installed plugin cache 共用以下目录提交协议：

```text
prepare:  target parent/.<name>.stage-XXXXXX
validate: stage 内 manifest、目标 path、版本和兼容检查通过
intent:   写入 .<name>.transaction.json（owner + transactionId + authorityPath）
commit:   target -> .<name>.backup
          stage  -> target
state:    known/installed JSON 记录同一 cacheTransactionId
cleanup:  删除 backup 和 transaction marker
rollback: 第二次 rename 失败时 backup -> target
recovery: authority 含 transactionId 则保留 target，否则恢复 backup
```

- staging 和 target 必须在同一父目录，保证 rename 不跨文件系统；
- backup 名称确定，transaction marker 记录同目录 stage 名、进程 owner、transactionId 与权威状态
  文件；恢复代码拒绝清理不匹配该 target 前缀的路径；
- commit 前取消：删除 staging，旧 target 不变；
- commit 开始后不再把取消当作失败，完成激活和状态记录，避免“新目录已生效但 installed record 未写”；
- cleanup 失败只记录/附加诊断，不回滚已成功的新版本；
- 普通读取发现 owner 仍存活时不执行恢复：权威状态尚未记录 transactionId 时读 backup，记录后读
  target；因此 overview/runtime discovery 不会抢走 writer 的 rollback 资源，也不会看见跨代状态；
- 进程退出后，恢复读取以 `known_marketplaces.json` / `installed_plugins.json` 中的同一
  `cacheTransactionId` 为提交判据：存在则保留新 target，不存在则恢复旧 backup（首次安装则移除
  尚未提交的新 target）；
- 异步 runtime discovery 遇到已死亡事务的残留时，同样先执行上述恢复，再把 target 路径交给会话。
  不能直接返回 backup：会话会长期持有 Skill/Hook/组件路径，后续详情读取或安装触发恢复会把 backup
  改名为 target，会话里的路径随即失效；没有残留的常态路径不进入恢复；
- JSON 状态文件在支持覆盖 rename 的平台直接执行同目录原子替换；Windows 目标已存在时使用同一
  确定性 backup + 读取前恢复协议；
- `known_marketplaces.json`、`installed_plugins.json`、Marketplace manifest 与 installed cache
  的同步读取入口都会解析可读代际，因此活跃提交和进程退出窗口都不会被解释为来源或插件被删除；
- Marketplace 刷新先完整加载、校验 source，再激活快照；任何下载/解析错误都不触碰旧快照。

## Marketplace 刷新状态

`KnownMarketplaceRecord` 增加可选 `lastRefreshFailure`：

```ts
interface MarketplaceRefreshFailure {
  code: "plugin_git_unavailable" | "plugin_archive_fetch_failed" | "plugin_marketplace_invalid";
  message: string;
  failedAt: string;
}
```

- 单市场刷新失败：保存 failure，保留原 `lastUpdated`、`pluginCount` 和 snapshot；
- 批量刷新：继续刷新其他市场，返回成功 summaries 和失败 diagnostics；
- 下次成功：清除 `lastRefreshFailure`，更新 `lastUpdated`；
- `plugins/overview` 返回 failure，使 UI 重载/重启后仍能展示，而不是只保留一次 toast；
- installed cache 与 Marketplace availability 分离，来源失败或移除不影响已安装插件运行。

## 协议与 UI 行为

- `zcodePluginMarketplaceSummarySchema` 增加可选 `refreshFailure`，不破坏旧 Agent payload；
- `plugins/marketplace/update` 使用现有 optional `diagnostics` 返回部分失败；
- UI 的 update operation 必须检查 error diagnostics，并在重新加载 overview 后保留 Marketplace 的
  `refreshFailure`；部分失败返回 false、写入共用 store 错误态，并在 Marketplace source 行展示
  message/failedAt；批量刷新即使部分失败也要展示已成功更新的来源；
- 新旧两套 UI store 的 update 入口遵守相同的部分成功语义；legacy `usePlugins` 即使退役也不能
  把 error diagnostic 报告为成功；
- source materialization 错误在诊断生成边界统一移除 URL username/password，并清理嵌套网络
  cause 中的 URL userinfo；持久化、日志、协议和 UI 不再各自处理敏感信息；
- 新增诊断码：`plugin_git_unavailable`、`plugin_archive_fetch_failed`；其他 manifest/依赖错误继续使用
  现有诊断码。

## 跨端与远程边界

- 来源分类、下载、解压、Git fallback 和原子激活全部位于 zcode-cli adapter；
- Desktop/Web/mobile 只经 typed plugin service 和当前 workspace Agent Host 调用；
- remote workspace 继续使用 `workspaceIdentity` / `remoteSessionId` 选择权威 Agent，不创建独立 runtime；
- remote plugin source archive sync 是另一条“本地已物化目录传远端”的路径，本功能不删除它；
- 本次不改变 desktop `continuous` 与 mobile `replayable` session/task delivery。

## 验收与测试顺序

先写失败测试，再实现：

1. loopback GitHub Archive fixture + PATH 无 Git：Marketplace add/update 和 plugin install 成功；
2. `sha/commit > ref > HEAD` URL 选择与 plugin `path` / `git-subdir` 解析；
3. 私有语义 fallback 在无 Git 时返回 `plugin_git_unavailable`；
4. Archive 网络失败不误 fallback Git；
5. 一个 Marketplace refresh 失败时另一个成功，旧 snapshot 和 failure 状态保留；
6. 下一次成功清除 failure；
7. 声明 `sparsePaths` 的公开 GitHub Marketplace 不发 Archive 请求，保留系统 Git sparse 路由；
8. 插件子目录继承祖先 `.gitattributes` 的 LFS 规则时必须 fallback Git；
9. 模拟活跃读取、未提交退出和已提交退出窗口，按 authority transaction generation 读取或恢复
   state、Marketplace 与 installed cache；
10. Marketplace 部分刷新失败仍 reload 成功来源，同时 store 返回 false、页面展示持久化失败；
11. legacy 与当前 UI store 对 error diagnostic 都返回 false；
12. 带 URL userinfo 的 Git 来源和嵌套 Archive cause 不把用户名/密码写进失败诊断；
13. 安装复制/rename 注入失败时旧 cache 和 installed record 保留；
14. 显式 ZIP 的 SHA-256、安全限额与路径防护回归；
15. 启动 discovery 在 PATH 无 Git且网络不可用时仍加载已安装 cache；
16. focused tests、`pnpm typecheck`、`pnpm lint`，再做真实公开 GitHub smoke。

对应生命周期 case：`PLM-LC-011 no-git-github-archive`、
`PLM-LC-012 isolated-refresh-atomic-cache`。
