# CLI Headless 浏览器登录态注入规格

> 状态：已实现。
>
> 日期：2026-11-17。
>
> 上位规格：`2026-07-13-cli-headless-cdp-backend-spec.md`。

## 1. 功能摘要

`--browser-use=headless` 启动的 Chromium 使用临时 profile，每个 ZCode session 使用一个隔离的
BrowserContext。所以任务开始时浏览器没有任何登录态；需要扫码登录的网站在 headless 下很难完成登录。

本功能让 CLI 在创建 BrowserContext 时注入一份只读的登录态快照（Playwright storage state 文件）。
Chromium 进程模型、临时 profile、session 隔离和生命周期都不变。

```text
storage state 文件（只读）
  -> CLI 参数边界：解析来源、读取、校验
  -> managed CDP adapter：每个 session 创建 context 时重新读取
  -> browser.newContext({ storageState, acceptDownloads: false, viewport })
  -> 该 session 的 tab 带着登录态访问网站
```

## 2. 澄清记录与固定边界

| 问题               | 用户确认                 | 固定边界                                                                                 |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------------- |
| 怎样复用登录态     | 用户选定注入快照         | 不共享 Chromium，不使用持久 profile；取舍见 §3                                           |
| 会话中的登录变化   | 采用建议方案             | 不写回文件；CLI 对文件只读                                                               |
| 文件格式           | 采用建议方案             | Playwright storage state，不自定义格式                                                   |
| 怎样把文件传给 CLI | 用户确认两种都实现       | 显式 `--browser-state <path>`；不传时自动加载默认文件；`--no-browser-state` 关闭默认加载 |
| 文件从哪里来       | 采用建议方案             | 本规格不提供登录或导出命令；用户用 Playwright 工具生成，见 §5.4                          |
| 什么时候读取文件   | 采用建议方案             | 启动时读取并校验一次；每个 session 创建 context 时重新读取                               |
| 真实网站验收       | 用户选定先做真实网站实验 | 实验已通过（§10）；本规格不修改 User-Agent 等浏览器特征                                  |

## 3. 方案取舍

| 方案              | 做法                                                     | 结论     | 原因                                                                     |
| ----------------- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| A 持久 profile    | `launchPersistentContext` 使用固定目录                   | 放弃     | 同一时刻只有一个进程能打开 profile；用户经常同时运行多个使用浏览器的 CLI |
| B 快照并写回      | session 开始时注入，结束时写回                           | 放弃     | 多个写入方互相覆盖；写回合并也无法表达"已退出登录"                       |
| C1 共享 Chromium  | 第一个 CLI 开调试端口，其他 CLI 用 `connectOverCDP` 连接 | 放弃     | 多客户端互相影响，见下方实验；调试端口无鉴权                             |
| C2 浏览器宿主进程 | 单实例宿主持有 profile，CLI 通过 IPC 发浏览器命令        | 暂不做   | 能解决并发，但要新增进程类型、IPC 协议和版本兼容，改动大                 |
| 注入只读快照      | `newContext({ storageState })`                           | **采用** | 不改进程模型；只有一个写入方，没有竞态；没有新的攻击面；改动小           |

选定方案的代价：

- 会话中产生的登录变化（例如 Agent 在任务中登录了新网站）不会保存。
- 文件不会自动更新。网站登录过期后，用户要重新生成文件。
- 如果网站轮换 refresh token 并检测旧 token 被重复使用，多个 CLI 共用同一份旧快照可能导致登出。
  这一点因网站而异，要逐个网站验证。

C1 的实验记录（Playwright 1.59.1 + macOS 本机 Chrome，2026-11-17）：

- 启动 Chrome 后等待 `DevToolsActivePort` 约 0.6s；同一 profile 再启动一个 Chrome，第二个立刻以退出码 21 退出。
- 客户端 B 没有 dialog 监听器时，Playwright 会自动 dismiss A 页面上的 confirm（`client/browserContext.js:122`）；
  B 加一个空监听器后，A 能正常处理自己的弹窗。
- A 页面的弹窗开着时，B 的 `connectOverCDP` 会阻塞，直到弹窗被处理；A 被 SIGKILL 后，B 连接一直超时。
  先用浏览器级 `Target.closeTarget` 关掉孤儿页，B 11ms 就能连上。
- 客户端被 SIGKILL 后，它创建的 tab 仍然留在浏览器里。

## 4. CLI 合同

新增全局参数：

```text
--browser-state <path>
--no-browser-state
```

默认文件：`<home>/.zcode/cli/browser-state.json`。`<home>` 和 `os.homedir()` 规则相同：Windows 取
`USERPROFILE`，其他平台取 `HOME`，为空时回退 `os.homedir()`。这样默认文件和 `~/.zcode/cli/db/db.sqlite`
等 CLI 文件位置一致；Windows 上 Git Bash 等环境设置的 `HOME` 不会改变默认位置。

示例：

```bash
zcode --browser-use=headless --browser-state ./app-state.json \
  --prompt "打开 https://app.example.com/docs/123 并总结内容"

# 默认文件存在时，本次不加载它
zcode --browser-use=headless --no-browser-state --prompt "..."
```

来源解析（在 `run.ts` 中，和 `--browser-executable` 的校验放在同一处）：

```text
带了 --browser-use=headless 吗？
 ├─ 没带 → 不解析来源，不访问任何登录态文件
 │         带了 --browser-state 或 --no-browser-state → 报错退出
 └─ 带了
     ├─ --browser-state 和 --no-browser-state 同时出现 → 报错退出
     ├─ --no-browser-state → source = none
     ├─ --browser-state <path> → source = explicit
     │     相对路径按 CLI 启动时的当前目录解析（和 --cwd 自身的解析规则一致，不受 --cwd 影响）
     │     文件不存在、不是普通文件、不可读、JSON 无效或 schema 校验失败 → 报错退出
     └─ 两个参数都没有 → 检查默认文件
           不存在 → source = none（和现在的行为一致）
           存在 → 读取并校验
                  失败 → 报错退出，提示修复文件或使用 --no-browser-state
                  成功 → source = default
```

规则：

- 所有参数和文件错误都发生在 app/session 创建前：退出码 1，不发送模型请求，不启动 Chromium。
- 启动时有三类提示：已加载默认登录态文件（`source = default`，同时说明可以用 `--no-browser-state` 关闭）、
  未知字段警告（§5.2）、文件权限警告（§5.3）。三类提示在所有入口都写 stderr，同时写日志。
  TUI 使用 alternate screen，这些提示在会话中看不到，退出后才出现在终端里；本规格不为此给 TUI
  新增启动通知通道。
- `zcode app-server` 拒绝这两个参数，和 `--browser-use` 的作用域规则一致；Desktop、Web Remote
  不受影响。
- 不新增环境变量，不新增配置文件键。
- `--no-browser` 仍然只表示 OAuth 登录时不打开浏览器，和本功能无关。

## 5. 文件合同

### 5.1 格式

使用 Playwright storage state 格式，示例：

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "…",
      "domain": ".example.com",
      "path": "/",
      "expires": -1,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": [
    {
      "origin": "https://app.example.com",
      "localStorage": [{ "name": "token", "value": "…" }],
      "indexedDB": []
    }
  ]
}
```

浏览器按 cookie 自身的 `domain`、`path`、`secure`、`sameSite`、`expires` 决定每个请求带哪些 cookie；
localStorage 和 IndexedDB 按 `origin`（协议 + 主机 + 端口）精确匹配。文件不需要额外标注"属于哪个网站"。

### 5.2 运行时 schema

schema 放在 adapters，使用 zod，CLI 启动校验和 adapter 读取共用同一份：

- 顶层是对象；`cookies`、`origins` 都是可选数组。两者都为空也合法，等于没有登录态，只写日志。
- cookie：`name`、`value` 是必填字符串；必须提供 `url`，或者同时提供 `domain` 和 `path`；
  `expires` 是数字；`httpOnly`、`secure` 是布尔值；`sameSite` 只能是 `Strict` / `Lax` / `None`；
  `partitionKey` 是可选字符串。
- origin：`origin` 必须是 http 或 https 的 origin，也就是按 URL 解析后的 origin 和原值相同；
  `localStorage` 是 `{ name, value }` 字符串对组成的数组；`indexedDB` 可选，这里只检查它是数组，
  内部结构交给 Playwright 校验。
- Playwright 自己导出的字段都算已知字段，包括 `_crHasCrossSiteAncestor`，不触发未知字段警告。
- 未知字段：不拒绝。启动时打印一次警告，列出字段路径（例如 `cookies[].sourcePort`），不打印值。
  Playwright 的校验器会直接丢弃未知字段（`protocol/validatorPrimitives.js:139`），所以要给用户提示。
- 错误信息只包含文件路径和出错的字段位置，不包含 cookie、localStorage 或 IndexedDB 的值。

### 5.3 安全

- 文件内容等同明文凭证。
- POSIX：`(mode & 0o077) !== 0`，也就是组用户或其他用户有任何权限时，启动时在 stderr 警告，并建议
  `chmod 600`。只警告，不阻止启动。Windows 不检查。
- 日志只记录来源类型（`explicit` / `default`）和数量摘要：cookie 数、其中已过期的数量、origin 数。
  不记录文件路径，也不记录任何值。
- descriptor `metadata` 不包含文件路径或来源，沿用上位规格 §4 的规定。

### 5.4 生成文件（不在本功能范围内）

- `playwright open --save-storage <file> <url>`：用户登录后关闭最后一个 tab，或者按 Ctrl+C 时导出。
- Playwright 脚本：`context.storageState({ path, indexedDB: true })`。
- 导出必须在浏览器还在运行时进行。Chrome 重启会丢弃会话 cookie（`expires: -1`），之后再从 profile
  导出会缺少这部分 cookie。
- 替换已有文件时要原子替换：先写临时文件，再 rename。否则正在创建的 session 可能读到不完整的文件而失败。

## 6. 注入时序与生命周期

```text
CLI 启动
  解析来源 → 读取并校验（失败即退出）
  → 打印警告：未知字段、文件权限
  → 只把 { source, path } 传给 adapter（source = none 时不传 path）

Agent 第一次在 session S 中使用浏览器
  ensureBrowser()                         不变
  ensureSession(S)
    source ≠ none → 重新读取并校验文件
    → newContext({ storageState: 解析后的对象, acceptDownloads: false, viewport })
        Playwright 内部：addCookies
                         → 每个 origin 打开一个隐藏页面（请求被拦截，不访问网络）
                         → 写入 localStorage / IndexedDB → 关闭隐藏页面
    → new ManagedCdpSession(context)      隐藏页面已经关闭，不会被登记成 tab

S 中的 cookie 和 storage 变化
  只存在于 S 的 context 里，closeSession 时随 context 丢弃，不写回文件

同一个 TUI 进程里新开 session S2
  重新读取文件 → 用户替换后的文件对 S2 生效；S 已经建好的 context 不变
```

- 运行中文件被删除或替换成无效内容：之后新建 context 的 session，其浏览器请求返回
  `backend_unavailable`，消息说明登录态文件不可用，但不包含文件路径。不回退为无登录态。
  其他 session 和 Chromium 进程不受影响。该 session 的下一次浏览器请求会重新尝试创建 context，
  所以用户修好文件后不用重开 session。
- 子会话（subagent）也通过 `ensureSession` 创建 context，所以注入同一个文件。
- origin 越多、IndexedDB 越大，session 第一次使用浏览器的耗时越长。本功能不设大小上限。
- Chromium 进程、generation、取消和 close 语义都不变。

## 7. 代码落点

| 位置                                                                      | 改动                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/zcode-cli/packages/cli/src/arguments.ts`                            | 新增 `browser-state`（string）和 `no-browser-state`（boolean）                                         |
| `apps/zcode-cli/packages/cli/src/run.ts`                                  | 在 `--browser-executable` 校验旁解析来源、调用校验、处理报错和默认文件提示                             |
| `apps/zcode-cli/packages/shared-types/src/index.ts`                       | `GlobalOptions` 增加登录态来源字段                                                                     |
| `apps/zcode-cli/packages/cli/src/headless-browser.ts`                     | 把来源传给 `createManagedCdpBrowserRuntime`                                                            |
| `apps/zcode-cli/packages/adapters/src/browser/storage-state.ts`（新文件） | 默认路径、zod schema、异步读取与校验、未知字段收集、POSIX 权限检查                                     |
| `apps/zcode-cli/packages/adapters/src/browser/index.ts`                   | `ManagedCdpBrowserRuntimeOptions` 增加 `storageStatePath`；`ensureSession` 读取后注入                  |
| 文档                                                                      | `apps/zcode-cli/docs/design/v2/commands.md`、`apps/zcode-cli/docs/usage/02-cli-reference.md`、上位规格 |

文件 I/O 只出现在 CLI 入口层和 adapters，符合 CLI 的外部 I/O 边界规则。

## 8. 状态空间与剪枝

| Candidate | 组合                                | 分类              | 理由                                      |
| --------- | ----------------------------------- | ----------------- | ----------------------------------------- |
| BST-001   | headless，无参数，无默认文件        | accepted          | 和现在的行为一致                          |
| BST-002   | headless + 显式文件                 | accepted          | 主路径                                    |
| BST-003   | headless + 默认文件                 | accepted          | 主路径                                    |
| BST-004   | 默认文件存在 + `--no-browser-state` | accepted          | 关闭开关                                  |
| BST-005   | 未开 headless + 任一新参数          | accepted          | 参数边界报错                              |
| BST-006   | 显式参数与关闭参数同时出现          | accepted          | 参数边界报错                              |
| BST-007   | 文件缺失或无效（显式 / 默认）       | accepted          | 启动前失败                                |
| BST-008   | 运行中文件被替换或删除              | accepted          | 新 session 使用新文件；无效时失败，不回退 |
| BST-009   | TUI 多 session                      | accepted          | 每个 context 独立注入，tab 仍不互见       |
| BST-010   | subagent                            | accepted pairwise | 和父 session 注入同一文件                 |
| BST-011   | app-server + 新参数                 | accepted          | 拒绝                                      |
| BST-012   | 写回或合并                          | pruned            | 不写回                                    |
| BST-013   | 其他格式（cookies.txt、扩展导出）   | pruned            | 非目标                                    |
| BST-014   | Windows 权限检查                    | pruned            | 没有 POSIX mode                           |

## 9. 验收用例

| Case    | Setup / action                                                                                               | Assertions                                                                                                                     | Evidence                                       |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| BST-001 | 临时 HOME 下没有默认文件                                                                                     | context 创建时不带 storageState                                                                                                | CLI unit + adapter unit                        |
| BST-002 | `--browser-state` 指向有效文件                                                                               | 每个 session 的 newContext 都收到解析后的对象                                                                                  | adapter unit（fake Playwright）                |
| BST-003 | 临时 HOME 下有有效默认文件                                                                                   | 自动注入；`--prompt` 在 stderr 打印一行提示                                                                                    | CLI unit                                       |
| BST-004 | 默认文件存在 + `--no-browser-state`                                                                          | 不读取文件，不注入                                                                                                             | CLI unit                                       |
| BST-005 | 未开 headless + 任一新参数                                                                                   | 退出码 1；无 app/session                                                                                                       | CLI unit                                       |
| BST-006 | 两个新参数同时出现                                                                                           | 退出码 1                                                                                                                       | CLI unit                                       |
| BST-007 | 文件缺失、JSON 无效、schema 错误（显式 / 默认）                                                              | 退出码 1；无 Chromium；错误不含 cookie 值                                                                                      | CLI unit + schema unit                         |
| BST-008 | 两个 session 之间替换文件；再把文件改成无效内容                                                              | 第二个 session 用新内容；之后的 session 返回 `backend_unavailable`                                                             | adapter unit                                   |
| BST-009 | 未知字段、权限 0644                                                                                          | 警告列出字段路径和权限建议；不阻止启动                                                                                         | schema unit + CLI unit                         |
| BST-010 | 本地 HTTP fixture：`/echo` 返回请求的 Cookie 头，页面读取 localStorage；运行时生成指向 fixture origin 的文件 | 经过 `mcp__node_repl__js` → browser-client → broker → port → Chromium，cookie 和 localStorage 都生效；未带文件的运行看不到它们 | `test:browser-headless` real Chromium E2E      |
| BST-011 | 同一 TUI 两个 session                                                                                        | 都有登录态，tab 互不可见                                                                                                       | adapter integration                            |
| BST-012 | 真实网站：用户导出登录态后，用实现后的 `zcode --browser-use=headless --browser-state` 打开需要登录的页面     | 页面停在目标页，不跳转登录页                                                                                                   | 人工验收记录（§10 的实验已用同等启动方式通过） |

## 10. 待验证风险

注入只证明 cookie 和 storage 写进了浏览器，不证明网站接受这个会话。导出通常在有界面的浏览器里完成，
注入后运行在 headless Chromium 里，两者有这些差别：

- headless 的 User-Agent 带 `HeadlessChrome`；
- Playwright 默认启用 `--enable-automation`，`navigator.webdriver` 为 true；
- 导出用的浏览器和 CLI 找到的 Chrome/Chromium 版本可能不同。

如果网站把会话绑定到 UA 或设备特征，注入后的会话可能失效。

真实网站实验（2026-11-17，macOS）：

- 对象：一个需要扫码登录的在线文档平台（企业租户子域名），用户手动登录后打开一篇文档。
- 导出：`playwright open --channel chrome --save-storage`，系统 Chrome 有界面窗口；关闭窗口时导出
  54 条 cookie（其中 3 条会话 cookie）和 3 个 origin 的 localStorage（共约 846KB），没有 IndexedDB。
- 注入：按 CLI 的方式启动 Chrome for Testing 147 headless（启动参数同上位规格的实现），
  `newContext({ storageState, acceptDownloads: false, viewport })` 耗时 312ms。
- 结果：不注入的对照组被跳转到登录页；注入组停在文档页，正文完整显示，账号和编辑权限正确。
  UA 带 `HeadlessChrome`、`navigator.webdriver` 为 true、导出和注入使用不同的浏览器，都没有导致会话失效。

结论：本规格不修改 User-Agent 或其他浏览器特征。其他网站仍可能拒绝，出现时另写规格处理。

## 11. 非目标

- 不提供登录或导出命令；需要时另写规格。
- 不写回，不合并。
- 不读取用户日常 Chrome 的 profile，也不读取 Desktop IAB 的分区。
- 不支持 `cookies.txt` 等其他格式。
- 不按域名过滤 cookie。单点登录可能跨多个域名，过滤容易让登录失效。
- 不修改 Desktop IAB、app-server 和 shared-host 的语义。

## 12. 实现与验证记录

- adapters：新增 `browser/storage-state.ts`（默认路径、zod schema、未知字段收集、POSIX 权限检查、
  `BrowserStateFileError`）；`ManagedCdpBrowserRuntimeOptions.storageStatePath` 在 `ensureSession`
  中注入；`BrowserStateFileError` 分类为 `backend_unavailable`。
- CLI：新增 `browser-state-option.ts`（参数互斥与作用域校验、来源解析、提示与报错文案）；`run.ts` 在
  命令分发前解析来源并写 stderr 提示和日志；prompt / target / TUI 都通过
  `createCliHeadlessBrowserRuntime` 传入 `storageStatePath`；中英文帮助文本新增两个参数。
- 自动化：加载器 10 个用例、adapter 注入 4 个用例（vitest）；CLI 参数与接线 14 个用例（node:test）；
  真实 Chromium E2E 新增"经 MCP js → browser-client → broker → port → Chromium 注入 cookie 与
  localStorage"用例。CLI 接线与 E2E 都做过反向验证：去掉 `storageStatePath` 传递后对应用例失败。
- 真实 Chromium E2E 在 macOS 上通过（Playwright 自带 Chromium，headless）。
- BST-012 人工验收：待用户用真实网站执行。
