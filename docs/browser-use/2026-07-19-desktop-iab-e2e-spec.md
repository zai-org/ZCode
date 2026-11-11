# Desktop IAB Browser Use E2E 规格

> 日期：2026-07-19
> 状态：产品边界已确认，首批自动化已进入 `manual-review/pending`。
> 关联：`docs/testing/browser-use-coverage-matrix.md`、
> `docs/conversation-session-case-catalog.md`、
> `docs/testing/conversation-session-e2e-coverage-matrix.md`。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 为 Desktop 本地 IAB Browser Use 增加可重复执行的 Electron WDIO E2E，不再把 unit test 或一次性人工 smoke 当成正式 E2E |
| User-visible surfaces | conversation、Browser/browser-use side pane、真实 `<webview>` guest、Node REPL 图片与轮尾截图、自由尺寸 viewport |
| Existing owners | CLI runtime/browser-client、host/main BrowserControl、`BrowserGuestManager`、renderer side pane、conversation projection |
| First batch | 本地 Desktop `desktop-continuous` + IAB；provider 使用 case-local deterministic replay；视觉断言以几何/CDP 指标为主 |
| Deferred | SSH/WSL/Docker、mobile replayable 正式恢复、Windows UAC/App-Bound 实机、extension 正向路径、未闭环 Browser safety confirmation |

## Clarification Log

| Round | Question | User answer | Boundary fixed |
| --- | --- | --- | --- |
| 1 | 首批是否限定本地 Desktop IAB | 按建议继续 | Desktop IAB 为本轮正式目标；远端与手机只登记缺口 |
| 1 | 是否允许 synthetic provider replay 驱动真实 `mcp__node_repl__js` | 按建议继续 | replay 只固定模型选择，Browser 命令仍走真实 host/main/webview/CDP |
| 1 | 视觉证据采用像素 diff 还是几何/CDP 指标 | 按建议继续 | 几何、guest metrics、PNG 尺寸为主，少量截图作 review 证据 |
| 1 | Windows 原生导入是否为本轮硬门禁 | 按建议继续 | 协议/unit 保持；签名 Chrome、UAC、服务清理进入 Windows 专用后续门禁 |
| 1 | 未实现安全确认/deny 防绕过是否写成正式断言 | 按建议继续 | 保持 undefined/deferred；不根据当前实现猜产品语义 |
| 2 | 是否补“多 session 同时对话、同时操作多个 tab” | 用户明确要求补充 | 取同 workspace 的 A/B 两个 running session、每个 session 两个 IAB tab，验证权限、provider continuation、tab/guest/page state 与 side pane 隔离 |
| 2 | 是否补 subagent Browser Use 边界 | 用户明确要求补充；2026-10-09 改为 subagent 可用 | foreground built-in child 可使用普通 Node REPL 与 Browser，与对话共用 Tab，新开 Tab 在面板可见且结束后保留；返回主 Agent 后原 binding 继续可用 |
| 2 | 并发权限顺序如何取代表 | 按高风险状态组合剪枝 | 先批准前台 B，再切回批准 A；不排列 3+ session/tab、deny/allowAlways 与所有 subagent method |

## Domain Scope And State Owners

```text
case-local provider replay
  -> V4 conversation send
  -> mcp__node_repl__js
  -> browser-client / BrowserControlPort
  -> host process
  -> Electron main BrowserGuestManager
  -> renderer <webview> ready/attach
  -> guest CDP / trusted input / screenshot
  -> tool result + response meta
  -> conversation projection
  -> normal completion 前轮尾截图
  -> TurnComplete
```

| State / fact | Authority | E2E evidence |
| --- | --- | --- |
| Browser API 与 REPL binding | CLI runtime + browser-client | provider request、tool result、structured error |
| tab scope、selected、pending command、generation | `BrowserGuestManager` | main-side guest registry、command result、真实 guest URL |
| tab 可见性与后台挂载 | renderer side-pane registry | DOM test id、webContentsId、切换前后网页 JS state |
| viewport、DPR、截图背压 | guest CDP + main manager | `innerWidth/innerHeight/devicePixelRatio`、PNG dimensions、capture count |
| conversation 图片事实 | CLI event log/projection | live UI、cold hydration、row source/order/count |

## Dimensions And Equivalence Classes

| Dimension | Included values | Pruned/deferred values | Reason |
| --- | --- | --- | --- |
| Backend | IAB；已有 CLI managed CDP smoke 作为独立代表 | extension 正向动作 | extension 尚未实现，不能用 stub 证明可用 |
| Client | Desktop local `desktop-continuous` | mobile `web-remote-replayable` 正式恢复 | 手机不创建 Browser runtime/pane；后续只通过 shared-host 验证恢复 |
| Session | 同 workspace 双 session同时 running、各双 tab；后台 session；单 session 双 turn | 3+ session/tab 与全 lifecycle 笛卡尔积 | 2 × 2 已跨越 conversation、interaction、broker、renderer 与 guest ownership 边界 |
| Tab | agent-created、双 tab、后台保活、跨 turn stable id | human claimed、blank、closed/stale 重入、应用重启恢复 | 产品只承诺进程内 tab 持久；human/blank/stale 进入独立 lifecycle case |
| API | `tabs.new/list/get/finalize`、`tab.close/goto`、`domSnapshot`、locator `count/fill/click`、CUA `type`、`screenshot` | `press`、dialog、其余 method × OS | 按输入、pointer、视觉、lifecycle 等价类取代表 |
| Viewport | normal/free、Fit/50%、zoom `0/+2/-2`、边界/越界 | UA/touch/network/device emulation | 当前只定义 CSS viewport |
| Completion | normal、conversation 图片 cold restore | stop/failure、超预算、连续两轮、每种失败码 | 首批先守住正常完成双图事实；负向终态继续留在 BTA gap |
| Security | replay 动态 URL 只接受 loopback 并 fail closed；subagent Browser Use 与对话共用 Tab | URL scheme 产品拒绝、payment/delete/upload/secret confirmation 与跨 API deny | subagent tab 归属（父会话）已确认；Browser safety 产品实现尚未闭环 |

## Candidate Decisions

| ID | Setup / action | Expected assertions | Status |
| --- | --- | --- | --- |
| BU-E2E-001 | A 有 loaded Browser/browser-use tab，切到无 tab 的 B，再切回 A | B 收起；A guest 始终 mounted；webContentsId、URL、history/JS state 不变；切回主动展开 | accepted |
| BU-E2E-002 | replay 令模型执行 `tabs.new -> goto local fixture -> domSnapshot -> locator fill/click/press -> screenshot` | 真实 IAB pane 激活；trusted input 改变 guest；tool/meta 正确；截图为非空 PNG | accepted |
| BU-E2E-003 | 同 session 两 tab跨两轮，执行 `turnEnded` 与 `finalize({keep:[A]})`，随后 `list -> get(B)` | A/B 都保留；未列 tab 不关闭；get(B) 同时激活 manager 与 UI；显式 close 只关闭目标 | accepted |
| BU-E2E-004 | A/B 同 workspace，A 拥有 human tab；混合空白 human tab 与 agent-created blank | B `user.openTabs=[]` 且不可 claim；A 仍可恢复；human blank 被过滤，agent blank 仍在 `tabs.list` | accepted |
| BU-E2E-005 | 网页 input 聚焦后强制 host Composer 抢焦，再调用 locator fill、CUA/DOM CUA type | 文本只进入 guest，Composer 保持空；focus token 漂移 fail closed | accepted |
| BU-E2E-006 | 动画/hidden duplicate/overlay/iframe/navigation race 页面执行 fill/click | fill 不等待 click stable/hit-target；unique-visible 成功；真正歧义给候选；失败不泄漏 AbortError、TypeError 或 `undefined.count` | accepted |
| BU-E2E-007 | Agent new/show/activate/set/reset viewport 触发多帧布局，稳定后用户 resize | 模型布局稳定期 0 warning；稳定后用户 resize 仅提示一次并 dim，不阻塞页面 | accepted |
| BU-E2E-008 | 自由尺寸 `393x852`、`393x1200`、`3840x2160`、越界草稿，退出/重入 | strict range；失败不部分应用；同一 guest；tab-local size 保留；重入 zoom 回 Fit | accepted |
| BU-E2E-009 | 同一 tab 在 Desktop zoom `0/+2/-2`，分别使用 Fit/50% | frame/native guest 四边重合；viewport/DPR=1 不变；无裁切/额外 scroll extent；中心 pointer 映射正确 | accepted |
| BU-E2E-010 | qualifying Browser API 正常完成、显式 `emitImage`、discovery/failure/stop、连续两轮与 cold restore | 正常轮尾追加；显式图不抑制尾图；负向不追加；超预算压缩；恢复后只一次且顺序稳定 | accepted |
| BU-E2E-011 | human top/iframe alert/confirm；Agent `getDialog/handleDialog` | human 只出现一个可信 `<host> says` 系统框；自动化继续走 Chromium/CDP dialog | accepted |
| BU-E2E-012 | 主 Agent 缓存 Browser 对象，subagent 列出对话 Tab 并新开 Tab 操作，再回主 Agent | subagent Browser 调用成功、能看到主 Agent 的 Tab，新 Tab 在当前对话面板可见；普通 Node REPL 可用；child 结束后其 Tab 保留；主 Agent binding 继续可用 | accepted |
| BU-E2E-013 | window B 上报 window A 的 guest webContentsId | 必须 fail closed，B 不能操作 A guest | bug-candidate；当前实现疑似缺少 `hostWebContents` 校验，不加入通过门禁 |
| BU-E2E-014 | SSH/mobile/Windows signed Chrome/UAC | 按各端真实链路回归 | deferred；需要专用环境 |
| BU-E2E-015 | payment/delete/upload/secret confirmation 后换 evaluate/CUA/backend 绕过 | 同一意图仍拒绝 | undefined；等待 Browser safety 产品实现确认 |
| BU-E2E-016 | A/B 同时 running，各自产生 Browser 权限请求并各创建两个 IAB tab；操作期间来回切 session | 每张权限只路由到来源 session；A/B 的 `tabs.list`、tab id、URL、页面状态和 side pane 可见性互不串线；后台完成不抢前台 | accepted |

并发代表的状态与权限顺序固定为：

```text
A running -> Browser permission A pending -----------+-> approve A -> A1/A2 -> A completes
                 switch session                      |
B running -> Browser permission B pending -> approve B -> B1/B2 -> B completes
                 ^                    |              |
                 +---- foreground ----+---- switch --+

期望：permission/task、provider continuation、tab registry、guest/page state、side pane
      全部按 session 隔离；后台 ready/show/completion 不改变前台 session。
```

后台执行的 viewport 语义固定为：

```text
renderer inactive / display:none
  -> 只表示用户当前看不到该 pane
  -> main 仍须为 Browser command 提供稳定、非零的执行 viewport
  -> tabs.new/list/get 与后续 DOM / Playwright 命令可以在后台完成
  -> session 再次前台可见时恢复宿主自然 viewport

禁止：把隐藏 guest 的 0×0 宿主布局作为 BrowserTabSummary viewport 返回或直接抛错；
禁止：为修 viewport 而激活后台 session、抢占前台 side pane 或跨 session 复用 tab。
```

subagent 边界固定为：

```text
main: bootstrap -> cache Browser/Tab -> parent-before
  -> child: ordinary Node REPL succeeds
  -> child: documentation/capabilities/tabs/cached Tab/re-bootstrap all denied
  -> main: same Browser/Tab -> parent-after
```

## Pruning Decisions

| Decision | Guard / invariant | Representative coverage |
| --- | --- | --- |
| 不把 Playwright 当 backend | Playwright 是 tab API family | IAB full chain + CLI managed CDP smoke |
| 不为手机另起 runtime | `/remote` 必须 shared-host attachment | 后续 mobile replayable 只恢复 conversation fact |
| 不测应用重启恢复 tab | IAB 只承诺当前 ZCode 进程内持久 | BU-E2E-003 |
| 不做全部 method × OS × zoom | 高风险等价类和 pairwise 足够区分行为 | BU-E2E-005/006/008/009 |
| 不用 stub 声称 extension 可用 | unavailable member/backend 必须隐藏 | discovery contract/unit；正向 deferred |
| 不固化未确认 safety 行为 | 当前矩阵仍为待实现 | BU-E2E-015 保持 undefined |
| 不排列 3+ session、3+ tab 与全部权限响应顺序 | 2 × 2 已同时跨越 conversation、interaction、broker、renderer 与 guest ownership 边界 | BU-E2E-016 |
| 不把 subagent × 所有 Browser method 做全排列 | 初始化、tabs.new/list、goto、fill 与读取覆盖初始化、transport 与 tab 归属等价类 | BU-E2E-012 |

## E2E Handoff

- `BU-E2E-001/002/003/005/006/007/008/009/010` 的首批代表进入 conversation `manual-review/pending`，使用 case-local replay；每个 case 仍按矩阵标注 partial，不代表完整候选已覆盖。
- 纯 Browser UI/guest lifecycle case 进入 Browser Use 专项 manual-review spec；本地 HTTP fixture 由测试进程启动，URL 通过 replay marker 注入，禁止依赖公网。
- 本轮先实现 `BU-E2E-002` 的真实全链、`BU-E2E-003` 的跨 turn 多 tab 独立 case，并合入 `BU-E2E-001/005/006/007/008/009/010` 的高风险代表；第二批补 `BU-E2E-012` 的 subagent 运行时边界和 `BU-E2E-016` 的双 session × 双 tab × 权限路由。`BU-E2E-004/011` 及各 partial case 的剩余分支保留 `missing`，不得从 unit 或人工 smoke 推断正式 WDIO 覆盖。
- 正式转正前必须完成 manual review、fixture check、isolated replay；需要进入 Docker preset 时再做单 spec 容器准入。

## 首批实现与验证记录

- 候选 spec：`packages/desktop/test/e2e/conversation-session/browser-use/manual-review/pending/conversation-session-browser-use-iab-full-chain.test.ts`
- 多 tab lifecycle spec：`packages/desktop/test/e2e/conversation-session/browser-use/conversation-session-browser-use-iab-multitab-lifecycle.test.ts`
- provider replay：标题、bootstrap、action、final 共 4 条 case-local fixture；本地 HTTP 端口由用户 marker 动态回填，且只接受 loopback URL。
- replay continuation 按最新 `user/tool_result` 匹配成功 marker，禁止从 assistant tool code 的同名字符串制造假阳性；权限 helper 每个阶段只点击一次唯一 `allowOnce`，禁止快速连续调用时误批下一张权限卡。
- 2026-07-19 已通过 fixture check、E2E TypeScript 检查和 macOS Electron isolated replay。真实链路包含两次 build-mode MCP“允许一次”、真实 IAB guest、moving input 的 unique-visible fill、strict duplicate/overlay 拒绝、宿主 Composer 抢焦后的 CUA type、DOM locator 点击、显式图与轮尾图、会话切换保活、自由尺寸、50%、Desktop zoom `+2/-2` 以及 conversation 图片 cold restore。
- 多 tab case 使用 6 条 case-local fixture，覆盖首轮 A/B + `finalize({keep:[A]})` handoff、正常 `turnEnded`、第二轮独立 `tabs.list()`、按 URL/稳定 id `tabs.get(A)`、页面状态连续与显式 `close(B)`。isolated replay 的产品断言连续通过（最新报告 `1 passed / 0 failed`）；WDIO 删除 session 的 teardown 仍超时并令进程退出码为 1，作为 runner 基建问题保留，不将其写成产品 case 失败或完整通过门禁。
- 双 session × 双 tab case 已完成 fixture/typecheck 并进入 isolated replay：A/B 两张 Browser permission 都能随 task 切换恢复；先批准前台 B 后，B 真实创建两个 IAB tab、返回两个稳定 id/正确 URL 并完成。2026-07-19 的运行时日志与 provider capture 进一步确认：切回批准 A 后，权限路由、Node REPL 和 tool result 注入均正常；真正失败点是测试随即切回 B 后，后台 A 的首个 `tabs.new()` 已 attach guest，但 `summary()` 读取隐藏 `<webview>` 的 `window.innerWidth/innerHeight=0` 并抛 `invalid viewport`。fixture 只接受成功 marker，错误 tool result 的 continuation 随后表现为 `Missing Fixture` 重试，掩盖了原始故障。
- 修复后 `BrowserGuestManager` 在自然 viewport 为 0×0 时使用同窗口最近有效自然尺寸（无历史时 800×600）作为 transient CDP viewport；renderer 真实 `attachGuest(active=true)` 后恢复宿主自然尺寸，且 transient clear 与显式 viewport set/reset 串行。isolated replay 报告 `desktop-e2e-20260719-092055-600` 的产品结果为 `1 passed / 0 failed`（4.89s），A/B 各双 tab、四个不同 guest webContentsId、URL/页面状态和 side pane 隔离全部通过；WDIO `DELETE session` teardown 仍超时并令命令退出码为 1，与产品断言分开记录。
- subagent boundary case 使用 8 条 case-local fixture，isolated replay 产品断言 `1 passed / 0 failed`（2.38s）：child 的普通 Node REPL 返回 42；主 Agent 缓存 Browser 的 documentation、capabilities、tabs、cached Tab 与 re-bootstrap 在 child scope 全部统一拒绝，首个真实 provider-visible error 不含内部 stack；child 完成后主 Agent 复用同一 renderer webContents/Tab 成功写入。WDIO `DELETE session` teardown 仍超时并令命令退出码为 1，与产品断言分开记录。
- 该双图 case 显式使用正常 context window：manual-review 的 240-token 自动 compact 会按既有媒体预算移除历史工具图，与“显式图 + 轮尾图均持久化”的语义互斥。Browser compact 连续性仍需独立 case，不在这里伪覆盖。
- 当前仍留在 `manual-review/pending`：尚未完成人工视觉 review；BU-E2E-003 的 human/stale/异常终态分支、BU-E2E-004/011，以及 BU-E2E-002 的 `press/response meta`、BU-E2E-005 的 iframe/OOPIF 与 focus-token drift、BU-E2E-006 的 iframe/navigation race、BU-E2E-007 的 show/activate/reset、BU-E2E-008 的极值/退出重入、BU-E2E-009 的 pointer/四边像素人审、BU-E2E-010 的失败/stop/超预算/连续两轮仍待后续用例。
