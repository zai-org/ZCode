# 内置浏览器设备预设与导出

日期：2026-10-16
状态：已实现

本文只描述在 [内置浏览器自由尺寸视口](2026-07-15-responsive-browser-viewport-spec.md) 之上的增量；
坐标、缩放、metrics 重放、截图 surface 与 Agent Browser Use 隔离等既有语义全部沿用该文，不在此重复。

## 背景

设计稿常以工作区里的 HTML 文件交付，用户点击预览卡后在内置 Browser 侧栏查看。
看设计稿最常见的两个动作，现在都缺一个人工入口：

- **按设备尺寸看**：只能在自由尺寸模式下手动输入宽高。
- **把设计稿发给别人**：Browser 侧栏没有截图或打印出口，只能再让 Agent 去导。

两者都只服务人类用户的浏览器显示，不新增 Agent 工具，不改 Browser Use 协议。

## 一、设备预设

在自由尺寸工具栏（`BrowserViewportToolbar`）的宽高输入左侧增加一个预设下拉：

| 预设   | 宽 × 高     |
| ------ | ----------- |
| 手机   | 390 × 844   |
| 平板   | 834 × 1112  |
| 桌面   | 1440 × 900  |
| 幻灯片 | 1920 × 1080 |

- 选中预设等价于用户在输入框里提交该宽高：调用既有 `onViewportSizeChange`，走 `updateResponsiveViewportSize`
  同一路径，同样写入人类用户浏览器显示偏好。不新增 IPC、不新增 viewport 状态。
- 预设值都在 `BROWSER_VIEWPORT_LIMITS`（320–3840 × 320–2160）之内；预设表放在 shared，与 limits 同处定义。
- 下拉显示当前宽高命中的预设名；不命中任何预设时显示「自定义」。宽高输入保持原行为，手动改值后下拉随之变为「自定义」。
- 选择预设不改变当前预览缩放档位（Fit / 百分比），沿用自由尺寸模式内「仅模式开启时重置缩放」的规则。
- 不做按文件名或 slide 标记自动选档：选择权留给用户，避免与 Agent `setViewportSize` 的结果互相覆盖。

## 二、导出 PNG / PDF

在 Browser 工具栏「更多」菜单（`BrowserToolbarMoreMenu`）增加两项：「导出为 PNG」「导出为 PDF」。

- **执行位置**：PDF 由 renderer 直接调用当前 `<webview>` 的 `printToPDF()`；PNG 由 renderer 把 guest 的
  `webContentsId` 交给 main（`CaptureBrowserGuestPage` 通道），main 对该 guest `capturePage()` 后回传字节。
  原因：实机验证 renderer 侧 `<webview>.capturePage()` 会让 renderer 原生崩溃（`render-process-gone`
  `exitCode=5`），与 Agent 截图在 main 规避的「V8 FATAL」是同一个坑；PDF 的 `printToPDF()` 在 renderer 正常。
  main 只接受嵌入该 guest 的窗口发起（`hostWebContents` 即 sender），同一 guest 串行，等帧有界（15 s）；超时只结束这次等待，底层取帧结算前该 guest 的新请求回 `capture_in_progress`，不叠加取帧；底层结算、guest 销毁、或从发起算起超过 2× deadline（30 s，窗口最小化时 capturePage 会一直 pending）三者先到即释放，强制释放记 warn（E2E：BU-E2E-027）。
  结果经既有 `saveFile({ data, suggestedName })` 由用户选择保存位置，受其 50 MB 上限约束。
- **PNG**：导出当前可见视口的渲染结果。自由尺寸模式下即为设定宽高下的页面视口，不包含侧栏外框与工具栏；
  不做整页长截图。
- **PDF**：`printBackground: true`，页面尺寸优先使用页面自身 `@page` 声明（`preferCSSPageSize`），未声明时用默认纸张；
  HTML 演示稿模板已提供打印分页样式，按其分页输出。
- **文件名**：默认取页面标题，去掉文件系统不允许的字符后加 `.png` / `.pdf`；标题为空时用 `page`。
- **可用条件**：与「在外部打开」相同——guest 已就绪且当前 URL 为 Web URL 或 file URL；about/data 等内联协议页禁用两项。
- **互斥**：同一 tab 导出进行中时两项禁用，防止重复触发打印管线；导出不改变页面布局、DPR、viewport 或预览缩放，
  不进入 Agent 截图临界区。失败时以 toast 提示，不抛到页面。

## 不做

- 单独的设计画布侧栏：会与 Browser 侧栏形成第二套 HTML 预览。
- 元素样式编辑、设计 token 调整、演示稿翻页：由后续 Browser 侧栏内的设计模式承担，不在本文范围。
- HTML 预览卡自动打开：另行评估。
- Agent 侧导出能力：Agent 继续用 browser-use 截图与 pdf 插件的 HTML 转 PDF。

## 验收

- 预设：四个预设逐一选择后宽高输入与实际 guest viewport 一致；手动改宽高后下拉显示「自定义」；
  重启后恢复上次选择的宽高；选择预设不改变缩放档位；Agent `setViewportSize` 后下拉按新宽高显示。
- 导出：本地 HTML 与 http 页面导出 PNG / PDF 可用并能保存；about:blank 等页禁用；导出中再次点击无效；
  导出前后页面 viewport、预览缩放、滚动位置不变；自由尺寸 390 × 844 下导出的 PNG 宽高比与视口一致。
- 回归：自由尺寸既有行为（越界提示、Fit、Desktop 缩放补偿、Agent viewport 隔离）不变。
- Windows：保存对话框默认文件名含中文标题时可正常保存；file:// 中文路径页面导出可用。
