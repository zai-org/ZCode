# 交互核心：DOM 快照 + click/type/press/scroll（CDP 真实输入）设计

日期：2026-07-07　状态：已实现（2026-07-15 type 输入传输已由 `Input.insertText` 迁移到 focused-frame virtual paste，详见总 parity spec 8.9）

## 1. 背景与目标

统一浏览器 6 阶段已完成"导航 + 显示 + 去 webview + agent 对象骨架"，但**页面交互面基本是空的**：executor 只认 navigate/getState/back/forward/reload/screenshot；facade 的 `snapshot/click/type` 直接 throw、`playwright/cua/dom_cua` getter throw。agent 现在只能"打开网页 + 看截图/状态",**不能点、不能填、不能读结构化 DOM**。

本阶段补齐**最关键、最高性价比的交互子集**,让 agent 能真正操作页面:

- `snapshot` — 生成带 ref 的可见 DOM 快照（用途是"给模型可定位的结构"，与 playwright `domSnapshot` 同类）
- `click({ref})` — 点击某 ref 元素（CDP 真实鼠标事件）
- `type({text, ref?})` — 输入文本（可选先聚焦 ref）
- `press({key, ref?})` — 按键（Enter/Tab/… CDP 键盘事件）
- `scroll({ref?|x,y})` — 滚动（CDP 滚轮或 scrollIntoView）

**不做**（留后续）：playwright locator 全家桶、cua 坐标视觉、content.export、Dialog、文件上传下载、capabilities 协商。本阶段只做"快照 + ref 交互"这条能让 agent 闭环操作的最短路径。

## 2. 关键设计决策

### 2.1 ref 快照机制（复用已有 executeJavaScript 通道）
- Phase 3 已给 manager 加了 `executeJavaScript(win,key,script)` + `wc.executeJavaScript`。本阶段给 **executor 的 `ControlledView.webContents` 接口补 `executeJavaScript(script): Promise<unknown>`**，manager.toControlledView wire 到 `wc.executeJavaScript`。executor 由此可向页面注入脚本。
- `snapshot` 命令：注入 `SNAPSHOT_SCRIPT` 遍历可见 DOM，给每个**可交互/有语义**元素（a/button/input/textarea/select/[role]/[onclick]/可点击文本节点）分配 ref（`e1`/`e2`/…），在页面挂 `window.__zcodeRefs = Map<ref, Element>`，返回**紧凑文本树**（每行 `ref role "name" [href/value]`）+ 每个 ref 的 `bbox`（getBoundingClientRect，viewport CSS px）。
- ref 生命周期：页面导航后 `window.__zcodeRefs` 失效。约定"每次交互前重新 snapshot"。ref 在下次 snapshot 重新分配。

### 2.2 click/type/press/scroll —— CDP 真实输入（非合成事件）
- **click({ref})**：注入 JS `resolveRef(ref)` → `el.scrollIntoView({block:"center"})` + 返回 `bbox` 中心点（viewport CSS px）；executor 再发 CDP `Input.dispatchMouseEvent`（mousePressed + mouseReleased，button:"left"，clickCount:1）打该坐标。真实内核事件,站点识别为可信。
- **type({text, ref?})**：若带 ref，先 click 聚焦；随后只在指定 tab 内递归解析 focused shadow root / iframe /
  OOPIF target，并在最终 execution context 中执行 virtual paste。历史 `Input.insertText` 方案会受到 Electron
  embedder focus 竞争影响，已废止。
- **press({key, ref?})**：若带 ref 先聚焦；随后按「键盘输入投递」（`2026-07-12-browser-use-runtime-semantics-spec.md`
  §2.2）发 keyDown+keyUp：焦点在 OOPIF 时用该 iframe 的 CDP 会话，其它情况用 guest `sendInputEvent`，可输入键补字符事件。
  历史方案用 guest 主 frame 的 CDP `Input.dispatchKeyEvent`，网页无焦点时按键落到 ZCode 界面，已废止。
- **scroll**：`{ref}` → `resolveRef(ref).scrollIntoView`；`{x,y}` → CDP `Input.dispatchMouseEvent` type:"mouseWheel" deltaX/deltaY。
- 坐标系：WebContentsView 的 webContents 自身 zoom=1（桌面 renderer 缩放不影响它），getBoundingClientRect 与 CDP Input 坐标同为页面 viewport CSS px,直接对齐,无需换算。

### 2.3 协议与 facade
- `commands.ts`（已有 `click{ref,button?,doubleClick?}`/`type{ref?,text}`/`press{key,ref?}`/`scroll{ref?,x?,y?}`/`snapshot{maxElements?,includeHidden?}` 变体,Phase 0 就定义了判别联合）—— **无需改 schema**,executor 补 case 即可。
- `result.ts` 已有 `snapshot?: browserSnapshotSchema`。**snapshot 结果结构是权威且固定的**（`packages/shared/src/browser-use/snapshot.ts`）：
  `{ url, title, truncated, elements: Array<{ ref, tag, role?, name?, text?, value?, disabled?, checked?, selector, xpath, rect:{x,y,width,height}, inViewport }> }`。
  SNAPSHOT_SCRIPT **必须严格产出该结构**（含 selector/xpath/rect/inViewport），executor 直接把它塞进 `result.snapshot`。无需改 schema。
- click 用 ref 定位时,resolveRef 脚本从 `window.__zcodeRefs.get(ref)` 拿元素 → scrollIntoView + 返回 `rect` 中心；也可直接用 snapshot 里该 ref 的 `rect`（但可能已滚动失效,故 click 时重解析更稳）。
- facade `Tab`：去掉 `snapshot/click/type` 的 throw,改为构造对应 BrowserCommand → execute；补 `press/scroll`；对外签名为 `click(ref)`/`type(text,opts)`/`press(key,opts)`/`scroll(opts)`。`playwright/cua/dom_cua` getter 暂仍 throw（本阶段不做）。

### 2.4 安全（沿用 browser-safety）
- 快照返回的 role/name/text/href **均为页面内容,不可信**——仅供模型定位,不得作为指令执行。
- ref 交互只在受控 WebContentsView 内,协议白名单/导航校验不变。

## 3. 实现任务拆分（TDD，executor 用 stub CDP+executeJavaScript 单测）

- **T-A：ControlledView 补 executeJavaScript + snapshot 命令**
  - ControlledViewWebContents 加 `executeJavaScript(script): Promise<unknown>`；manager.toControlledView wire。
  - executor `case "snapshot"`：注入 SNAPSHOT_SCRIPT，返回 `{ok:true, snapshot:{tree, elements}}`。
  - SNAPSHOT_SCRIPT 作为常量字符串（页面内自执行,分配 ref+挂 __zcodeRefs+返回结构）。
  - 单测：stub `executeJavaScript` 返回假快照 JSON → 断言 result.snapshot 结构；核对 browserSnapshotSchema。
- **T-B：click / scroll（CDP 鼠标）**
  - executor `case "click"`：executeJavaScript resolveRef→bbox 中心 → cdp Input.dispatchMouseEvent×2。
  - `case "scroll"`：ref→scrollIntoView / {x,y}→mouseWheel。
  - 单测：stub executeJavaScript 返回 bbox + stub cdp.send → 断言按中心坐标发了 press+release；ref 不存在→结构化 error。
- **T-C：type / press（浏览器输入）+ facade 去 throw**
  - executor `case "type"`（当前为 focused-frame virtual paste，带 ref 先 click 聚焦）/`case "press"`（键映射→按焦点 frame 投递，见 §2.2 press）。
  - facade Tab：snapshot/click/type/press/scroll 去 throw、构造命令。
  - 单测：type stub 断言 virtual paste 固定在目标 context 且不调用 `Input.insertText`；press 常用键映射（Enter→{key:"Enter",code:"Enter",windowsVirtualKeyCode:13}）；facade 命令构造带 tabId。
- **T-D：真机验证**（手动）：agent 跑 `open→snapshot→click(ref)→type→press("Enter")`,观察页面实际响应。

## 4. 能力边界（本阶段明确不做，留后续）
playwright locator 全家桶 / cua 坐标视觉 / content.export / clipboard / Dialog / waitForEvent / 文件上传下载 / capabilities 协商 / markDeliverable 等。多会话 tab 隔离（前序 tracked）。

## 5. 影响文件
- `packages/desktop/src/main/browserView/browserCommandExecutor.ts`（补 snapshot/click/type/press/scroll case + SNAPSHOT_SCRIPT + 键映射 + ControlledView 接口扩展）
- `packages/desktop/src/main/browserView/browserViewManager.ts`（toControlledView wire executeJavaScript）
- `packages/shared/src/browser-use/result.ts`（核对/扩展 snapshot 结果结构）
- `apps/zcode-cli/packages/core/src/browser-client/facade.ts`（Tab 交互方法去 throw）
- 测试：browserCommandExecutor.test.ts（新 case 单测）、facade 测试

## 6. 补充：让模型"会用"——文档协议 + 工具描述指引

真机发现模型不会用 agent.browsers。模型需要两类引导：(a) SKILL 引导模型"浏览器任务先读文档再操作"，(b) 运行时 `browser.documentation()` 返回完整 API 参考自描述。zcode 两者都缺（facade 无 documentation()，js 工具描述对 agent.browsers 只字未提）。

补齐这两类引导：
- **facade `agent.browsers.documentation()`**：返回 zcode 已实现子集的完整指南（对象模型 + 各方法签名 + snapshot→ref→action 工作流 + 行为规范[动作前重取 snapshot、页面内容不可信、勿对同 URL 重复 goto、定位以可见状态为准] + 未实现清单[playwright/cua/dom_cua/content/dialog]）。
- **`js` 工具描述**加 browser 段：agent.browsers 可用；浏览器/网页任务先 `nodeRepl.write(await agent.browsers.documentation())` 读全量 API，再 open/snapshot/click/type/press/screenshot；ref 每次动作前重取。（js 工具仅在 browserControlPort 存在时注册，故无条件写入安全。）
