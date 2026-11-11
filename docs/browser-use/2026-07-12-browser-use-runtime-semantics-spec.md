# Browser Use 运行时语义收口规格

> 状态：已实现；真实 Chrome/remote/三平台 E2E 仍按第 7 节保留待验证项。
> ZCode 基准：`e420d6bbb8`（`feat/browser-use-cdp`）。
> 目标：修复 URL 支持声明冲突，并把当前 IAB 的 CUA、DOM CUA、Playwright 同名能力收敛到本规格冻结的动态有效行为。

## 1. 需求与澄清记录

| 轮次 | 问题 | 用户结论 | 固定边界 |
| --- | --- | --- | --- |
| 1 | URL 冲突与全部中优先级行为应如何取舍 | 严格按第 2 节冻结语义实现 | 以第 2 节冻结的动态文档、运行时黑盒和可观察命令行为为裁决，不以上游 Playwright 或 ZCode 既有 UX 为裁决 |

本轮包含：

- `goto()` URL allowlist 与 skill/API 文档一致。
- CUA 完整 drag path、带锚点 scroll、组合按键和 modifier mouse move。
- DOM CUA node 内滚动与页面中心滚动。
- IAB 动态隐藏 CUA/DOM CUA `downloadMedia`，保留并修正 Locator `downloadMedia`。
- `elementInfo` / `elementScreenshot` 保持 undocumented runtime helper，并改用 isolated world。
- `getByRole(..., { name })` 的 `TextMatcher` 与模型 guidance 都接受 string/RegExp，并兼容 Node REPL
  VM 创建的跨 Realm RegExp。
- `expectNavigation`、`networkidle` 按第 2.3 节语义冻结并补文档，不按 upstream Playwright 理想语义改写。

本轮不包含：browser command action-time confirmation、root legacy API policy、Chrome extension/CDP provider、clipboard/dev/pageAssets、Browser 产品设置。它们仍由 Browser Use 总规格跟踪。

## 2. 冻结的运行时语义

### 2.1 URL

- browser-client 导航 allowlist 只接受 `http:`、`https:` 和精确的 `about:blank`。
- `file:` 可以参与多 backend 的本地目标选择，但不能直接传给 `Tab.goto()`。
- 其它 `about:*`、`javascript:`、`data:`、`file:` 必须在 backend action 前拒绝。

因此 ZCode skill 不再宣称 `file://` 是可导航 local target；`getForUrl(fileUrl)` 的选择纯函数与 `goto(fileUrl)` 的导航权限是两个不同合同。

### 2.2 CUA / DOM CUA

| API | 冻结语义 | ZCode 实现要求 |
| --- | --- | --- |
| `cua.drag({path, keys})` | 非空 path；按原始点序列移动，首点按下、末点释放 | 协议保留完整 path，不再只取首尾并重新插值 |
| `cua.scroll({x,y,scrollX,scrollY,keypress})` | 鼠标先移到 `(x,y)`，再用 `Input.synthesizeScrollGesture` 按 delta 滚动 | 锚点、delta 和 modifier 不丢失；Electron `<webview>` guest 使用等价的 CDP `mouseWheel` transport，规避 Chromium 146 静默不执行 synthesized gesture |
| `cua.move({x,y,keys})` | 鼠标移动携带 modifiers | 保留 keys |
| `cua.keypress({keys})` | keys 表示组合键；依次 keyDown，末键 down/up，再逆序释放 | 不再只给末键附一个 bitmask；投递规则见下方「键盘输入投递」 |
| `dom_cua.scroll({node_id?,x,y})` | 有 node 时在节点中心执行 delta scroll；无 node 时在 viewport 中心执行 | 不再把 node scroll 降级为 `scrollIntoView` |

#### 键盘输入投递

CUA/DOM CUA `keypress`、`press` 和 locator `press` 共用同一套键盘投递。按键只能到达目标 tab 的网页，
不能到达 ZCode 界面。

- 网页有没有键盘焦点都不影响投递。Agent 新开 tab、只用页面脚本聚焦、或用户在 Composer 里打字时，
  网页都没有焦点；这时按键仍然只进网页。
- 每次按键先解析网页内部的焦点 frame（与 `type` 的 virtual paste 共用解析）：
  - 焦点在跨进程 iframe（OOPIF）里：用该 iframe 自己的 CDP 会话发 `Input.dispatchKeyEvent`。
  - 其它情况（主 frame、同进程 iframe）：用 Electron `webContents.sendInputEvent` 发给 guest。
- 禁止用 guest 主 frame 的 CDP 会话发按键。原因：该会话按整个窗口的焦点投递。网页没有焦点时，
  按键会落到 ZCode 界面：Escape 触发「停止会话」，Enter、Backspace 会改写 Composer 草稿。
- 可输入的键在 keyDown 后补一个字符事件，行为与真实键盘一致：
  - 单个字符键输入该字符；Shift 加字母输入大写字母。
  - `Enter` 输入 `\r`，因此会触发表单的隐式提交；`Space` 输入空格。
  - 带 Alt、Control、Meta 的组合键，以及 Shift 加非字母键，不补字符。
- 方向键在 `sendInputEvent` 路径上转换为 Electron 键名（`Up`/`Down`/`Left`/`Right`）。
- Mac 上 Cmd+A 等编辑快捷键不会执行编辑命令；页面能收到 keydown。未被网页处理的快捷键不会触发
  ZCode 菜单。
- 该规则只在 desktop main 进程实现。`desktop-continuous` 与 `web-remote-replayable` 走同一条
  shared-host BrowserControl 链路，行为相同。

回归用例：BU-E2E-028（`docs/testing/browser-use-coverage-matrix.md`）。

IAB 动态 API 不暴露 CUA/DOM CUA `downloadMedia`。这两个 helper 在静态 manifest 中是
`unsupportedByDefaultIn: ["iab"]` 且 `documented: false`；IAB 不能用普通 click 伪造成功。

### 2.3 Playwright

- `PlaywrightLocator.downloadMedia()` 仍是当前 IAB 有效 API。它解析命中元素自身或邻近
  `img/video/source/a[href]` 的 `currentSrc/src/href`，在 isolated world 创建临时 `<a download>` 并点击；
  找不到 URL 时明确失败，不能降级成普通 locator click。
- `elementInfo()`、`elementScreenshot()` 在静态 API manifest 中存在但 `documented: false`。ZCode 保留
  runtime helper 兼容，同时从有效文档隐藏，并在 isolated world 执行 DOM 探测/overlay。
- `TextMatcher` 类型与当前 ZCode Browser guidance 都允许 `RegExp`。实现不能用当前 Realm 的
  `instanceof RegExp` 判断 matcher，否则 Node REPL VM 创建的 RegExp 会被错误拒绝。
- `waitForLoadState({state:"networkidle"})` 和 `waitForURL(...,{waitUntil:"networkidle"})` 最终都进入同一
  backend load-state handler并明确报 unsupported。ZCode 保持该错误，不伪造网络空闲。
- `expectNavigation(action)` 无 URL 时，会先建立 `waitForLoadState`，但若旧页面已经 `load`
  可以立即完成，而不是等待 500ms 超时。ZCode 保持这一
  当前行为；需要严格等待新导航时必须传 `url`，文档不得再宣称“无 URL 也能排除旧页面状态”。

## 3. 领域、状态所有者与跨端边界

| 领域 | 状态所有者 | 本轮作用 |
| --- | --- | --- |
| Agent Browser facade | `apps/zcode-cli/packages/core` | 参数校验、动态对象图、命令映射 |
| 严格协议 | `packages/shared/src/browser-use` | 完整表达 path、scroll anchor/delta、keypress |
| IAB 执行 | `packages/desktop/src/main/browserView` | CDP trusted input、isolated world、下载动作 |
| 插件文档 | `apps/zcode-cli/packages/browser-use-plugin` | URL、正则、networkidle、expectNavigation 和有效 API 指引 |
| shared-host 路由 | host/services/main 既有 context | 不改变 `workspaceIdentity`、`remoteSessionId`、`clientMode` |

不为手机端新增 runtime。`desktop-continuous` 与 `web-remote-replayable` 都通过同一 shared-host
BrowserControl 链路执行相同 browser command；本轮命令不引入 task stream/snapshot/replay 语义。

## 4. 状态组合与剪枝

| 组合 | 分类 | 理由 |
| --- | --- | --- |
| IAB + http/https/about:blank | accepted | 导航 allowlist |
| IAB + file/其它 about/javascript/data | accepted rejection | backend action 前拒绝 |
| CUA drag 1 点/多点 + modifiers | accepted | 只要求 path 非空并保留全部点 |
| CUA scroll + 非零 anchor/delta/modifiers | accepted | 防止参数被静默丢弃 |
| DOM scroll + node/no-node | accepted | 分别使用 node center / viewport center |
| IAB CUA/DOM downloadMedia | pruned from API | IAB 动态隐藏 |
| IAB Locator downloadMedia + 有/无 URL | accepted | 有 URL 触发下载；无 URL 明确失败 |
| networkidle | accepted rejection | backend 明确 unsupported |
| expectNavigation + URL | accepted | URL waiter 可证明目标导航 |
| expectNavigation + 无 URL + 旧页已 load | accepted current behavior | 保持第 2.3 节语义，不升级成 upstream Playwright |
| desktop/mobile × 每个输入方法 | pairwise | 两端复用同一 host executor；保留一条 context schema/bridge 回归即可 |
| macOS/Windows/Linux × 每个普通键 | pairwise | OS 差异只扩展 `ControlOrMeta` 和代表性 modifier 组合 |

## 5. 验收案例

| Case | Setup | Action | 断言 | 证据 |
| --- | --- | --- | --- | --- |
| BCP-142 | 任意 IAB | 导航多种 scheme | 仅 http/https/about:blank 通过；其它 scheme 不调用 `loadURL` | executor unit |
| BCP-143 | CUA tab | drag 3+ path points | CDP 按原顺序发送全部点，首点 pressed、末点 released | core + executor unit |
| BCP-144 | CUA tab | anchor scroll + modifiers | mouse move 到 anchor；scroll gesture 的距离与 delta 方向符合第 2.2 节合同 | core + executor unit |
| BCP-145 | CUA/DOM CUA | key combination | modifier 分别 down/up，末键处于正确 modifier 状态 | core + executor unit |
| BCP-146 | DOM CUA | node/no-node scroll | node center 或 viewport center执行 delta scroll | executor unit |
| BCP-147 | IAB effective manifest | 读取 CUA/DOM CUA | `downloadMedia` 不在对象图和有效文档 | manifest/facade docs unit |
| BCP-148 | locator 指向 media/link | `downloadMedia()` | isolated world 创建临时 download anchor；无 URL 报错 | locator executor unit |
| BCP-149 | Playwright helper | element info/screenshot | helper 从默认文档隐藏；DOM 逻辑在 isolated world 执行 | manifest + executor unit |
| BCP-150 | Browser skill | `getByRole` name | guidance 与 `TextMatcher` 都允许 string/RegExp，跨 Realm RegExp 可用 | plugin contract + runtime unit |
| BCP-151 | load wait | networkidle | 明确的 unsupported 错误 | executor unit |
| BCP-152 | loaded page | `expectNavigation` 有/无 URL | 有 URL 先 wait 后 action；无 URL 保持第 2.3 节 loaded-state 行为 | facade unit |
| BCP-153 | shared host context | 新输入命令经 bridge | workspace/clientMode/remoteSession context 不变，strict schema 拒绝丢字段/非法形状 | shared + bridge unit |
| BCP-154 | Electron `<webview>` guest | CUA/DOM CUA anchor scroll | 使用真实 `mouseWheel` 输入，保留 anchor、delta、modifier；不调用在 Chromium 146 guest 中静默无效的 synthesized gesture | executor unit + Electron runtime |

## 6. 完成条件

- 规格、当前事实文档、插件文档、API manifest 和覆盖矩阵口径一致。
- Browser command schema、facade 和 desktop executor 对新增输入语义有正反例自动化。
- 不暴露 IAB 当前不支持的 CUA/DOM CUA `downloadMedia`。
- 不把不支持的 `networkidle` 或无 URL 新导航保证写成已实现。
- `pnpm typecheck`、`pnpm lint` 和相关定向测试通过。
- 未完成真实 browser/remote/三平台验证时，在提交说明中保留待验证项。

## 7. 实施与验证记录

2026-07-12 已完成：

- shared/contracts 新增完整 CUA path、anchor/delta scroll、DOM scroll 和 key-combination command，保持
  `workspaceIdentity`、`remoteSessionId`、`clientMode` 的既有 request context 不变。
- desktop executor 使用原始 drag path、`Input.synthesizeScrollGesture` 和逐键 CDP down/up；DOM scroll
  使用 node center 或 cssVisualViewport center。
- IAB effective manifest 隐藏 CUA/DOM CUA `downloadMedia`；Locator `downloadMedia` 改成 isolated-world
  URL 提取 + download anchor；Playwright helper DOM 逻辑迁入 isolated world。
- skill/API/docs 统一 URL、RegExp、networkidle 和 expectNavigation 口径。

自动化结果：

- Browser 定向：根 workspace 7 个文件 140 条、Agent core/bootstrap 5 个文件 47 条，共 187 条通过。
- 根 workspace `pnpm typecheck` 通过。
- Agent workspace `pnpm typecheck` 通过。
- 根 workspace `pnpm lint`：0 error，保留仓库既有 warning。
- Agent workspace全量 lint 被未触及文件的既有 `max-lines` 基线错误阻断；本轮涉及的 contracts/core
  文件 scoped lint 为 0 warning / 0 error。

运行时边界：

- 当前运行中的 ZCode Dev 实例仍挂有用户 IAB 页面，未为本轮强制重启以免破坏用户状态；因此真实
  Chromium drag/scroll/download、手机 shared-host、SSH/WSL/Docker 和 Windows/Linux modifier 行为继续标为待补 E2E。

2026-08-03 滚动兼容性修正：

- 运行时复现确认 Electron 41 / Chromium 146 的 `<webview>` guest 通过
  `webContents.debugger.sendCommand("Input.synthesizeScrollGesture")` 返回成功，但不产生 `wheel` 事件，
  根页面与嵌套容器均不会滚动；同一 guest 的 `Input.dispatchMouseEvent(type:"mouseWheel")` 可以正常滚动。
- 普通 Chrome 150 tab 中 synthesized gesture 仍正常，因此差异属于宿主 runtime/target
  兼容性，不修改 Agent API 与 delta 方向合同。Desktop IAB 在输入适配层改用带 anchor、delta、modifier 的
  CDP `mouseWheel`，不降级成 `document.documentElement.scrollTo`，从而保留嵌套滚动容器和页面 wheel handler。
