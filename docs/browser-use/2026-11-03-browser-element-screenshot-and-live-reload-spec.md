# 内置浏览器：设计稿元素带截图、本地页面自动刷新、HTML 单击打开

日期：2026-11-03
状态：已实现

本文是内置浏览器的三项增量，前置语义见
[自由尺寸视口](2026-07-15-responsive-browser-viewport-spec.md) 与
[设备预设与导出](2026-10-16-browser-device-presets-and-export-spec.md)。三项都只服务人类用户的浏览器显示，
不新增 Agent 工具，不改 Browser Use 协议。

## 一、设计稿元素带截图

设计稿页面点选元素（[设计工具](2026-11-03-browser-design-mode-spec.md) 第四节）后，输入框正文出现元素 token；同时把这块元素的截图作为
隐藏的图片附件加入输入框，随消息发出，不出缩略图（上传失败时回到附件行显示）。普通网页的「选择元素」维持原样：只出元素卡片，不截图（11-05 反馈）。

- **取帧位置**：renderer 侧 `<webview>.capturePage()` 会让 renderer 原生崩溃，所以和「导出为 PNG」走同一条
  `CaptureBrowserGuestPage` 通道，由 main 取 guest 当前整帧，再按请求里的 `clip` 裁剪。
- **坐标换算**：`clip` 是元素 `getBoundingClientRect()` 的 guest CSS px，附带当时的 `innerWidth/innerHeight`。
  main 用「实际帧宽高 / CSS 视口宽高」作比例，不读宿主 DPR：Retina、Windows 125% / 150% 小数缩放、自由尺寸
  （DPR=1 但原生 surface 按宿主 backing scale 分配）和 Desktop 缩放补偿下都成立。边界向外取整，不缺边；
  超出视口的部分裁掉，完全不可见返回 `clip_out_of_view`。
- **高亮层**：选择脚本在返回结果前已移除高亮层；renderer 读视口尺寸前先等两帧，保证截图里没有高亮框。
- **附件**：chip 的 payload 带可选 `screenshot`（只在内存里，不进提示词文本）。composer 用
  `useContextImageAttachments`（plugin-ui 公开入口，插件上下文图片同一份实现）在 chip 加入时把它预上传为图片附件，和粘贴截图同一条链路；文件名
  `element-N.png` 的 N 与提示词里 `## Element N` 一致：都用 chip 加入时分配的稳定编号（当前最大值 + 1，同 id 覆盖保留原值），删掉前面的 chip 后仍一一对应，编号可以不连续。同 id chip 被覆盖或删除时撤掉旧附件；
  切会话时 chip 被清空，用附加当时的撤销函数删除旧会话 scope 的附件，不留下没有 chip 的旧截图。
  发送在途时（附件已冻结进本次发送、ACK 未到）用户删 chip 或切走也照常撤：截图选中即作为会话附件上传完成、
  不走跨机暂存，`useComposerAttachments.removeAttachment` 只对暂存 / 上传中的附件调 cancel，撤销只移除输入框条目，
  已发出的引用与远端文件不受影响（本地与 SSH 远端实测，见覆盖矩阵 BU-E2E-021）。发送后的撤销是空操作。
- **上限**：截图计入既有 8 个附件上限。已满时不加截图，只加文字 chip，附件区照常提示已达上限。
- **失败**：取帧失败或宿主不支持（Web 端无 `<webview>`）时只加文字 chip，不影响选择本身。

## 二、本地页面自动刷新

人类用户 tab 打开 `file://` 页面时，页面实际加载过的本地文件变化后自动刷新，滚动位置保持不变。

- **只认页面资源**：主 HTML + 页面引用的 `file://` 资源（每次 `dom-ready` 后、等 `load` 读一次，最多 200 个）。
  file:// 加载不进 Resource Timing，所以扫 DOM（link / script / img / source / video / audio / iframe / object）和
  可读的样式表（含 `@import`、`url(...)`），再并上 `performance.getEntriesByType("resource")`（fetch / XHR 等）。变化路径在清单里才刷新；同目录别的文件（桌面上别的仓库的构建输出等）不触发。
  清单外的路径变化时再读一次当前清单，认出页面 load 之后才请求的资源。`node_modules`、`.git` 下的变化不触发。
- **监听范围**：资源所在的目录，非递归，最多 16 个目录（主 HTML 目录在前）。watcher 同一防抖窗口合并了多个路径、
  不给具体路径时，对该目录下的资源重新 stat，`mtime`/`size` 与加载时不同才刷新。
  file:// 总是本机磁盘，所以监听与 stat 走本机 base host，与当前 workspace 是否远端无关。
- **刷新**：变化防抖 300 ms 后 `reload()`。reload 前读 `scrollX/scrollY`，新页面 `dom-ready` 时注入恢复脚本，
  等 `load`（图片撑开高度）后再 `scrollTo`。webview 被重建（`webviewGeneration` 变化）时挂着的恢复作废。
- **可见性**：隐藏的 tab 只记下「有变化」，重新可见时刷新一次，后台不反复刷新。
- **范围**：只对人类用户打开的 tab；Agent 的 browser-use tab 不自动刷新，避免打断 Agent 的页面操作。
  http(s) 页面不处理（开发服务器自己有热更新）。监听失败只记日志，页面照常可用、可手动刷新。

## 三、文件树单击 HTML 进内置浏览器

设置 → 浏览器 → 打开方式，新增开关「单击 HTML 文件时在内置浏览器中打开」（`fileTreeHtmlClickOpensBrowser`）。

- **默认关闭**：保持现状，单击 `.html` 打开源码预览；改变默认打开方式属于产品决定，不随本功能切换。
- **开启后**：文件树单击本地 `.html` / `.htm` 文件，走与右键「在浏览器中打开」相同的入口打开内置浏览器。
  条件也与该菜单项相同：远端 workspace 的文件不在本机磁盘，仍打开源码预览；Git 已删除的虚拟行不打开。
- **源码入口不变**：右键菜单「打开」始终是源码预览，双击行为不变。
- **存储**：本机界面偏好，固定读写本机 base host 的设置；设置页在远端 workspace 下渲染时也不写到远端。
  新字段可选、默认 false，旧版本读取时忽略未知字段（settings schema 不是 strict；校验失败会整份回到默认值，所以不能改成 strict）。E2E：BU-E2E-025。

## 验收

- 设计稿页面点选后输入框出现元素 token，并带一张隐藏的 `element-1.png`（发送后消息里有该附件）；截图只含该元素，无高亮框；Retina 下为 2x 像素。
- 删除 token 后截图同时撤掉；切到其他会话再切回，不残留截图附件。
- 已有 8 个附件时点选：只出现 token，并弹出提示。
- 普通网页「选择元素」：只出元素卡片，输入框里没有截图附件。
- 打开工作区 HTML 并滚到中部，修改它引用的 CSS：2 秒内页面刷新、样式生效、滚动位置不变。
- tab 隐藏期间改文件不刷新；切回该 tab 时刷新一次。Agent 打开的 tab 改文件不刷新。
- 默认单击 `landing.html` 打开源码预览；打开开关后单击进内置浏览器，右键「打开」仍是源码预览；重启后开关保持。
