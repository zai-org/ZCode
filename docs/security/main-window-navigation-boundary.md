# 主窗口导航边界

> 状态：导航守卫 Implemented（2026-11-16，2026-11-17 补充更新状态窗口）；纵深防御另有内部工单
>
> 关联工单：ZP-20261105-19（主窗口导航未隔离导致 preload 滥用）、ZP-20261110-03（持久化 RCE）

## 背景

- 主窗口 `BrowserWindow` 的 `webContents` 使用 `window.zcode` preload，并通过 `contextBridge`
  暴露 MCP 用户目录读写、本地文件打开、临时文件写入等特权 IPC（`packages/desktop/src/main/desktopWindowChrome.ts`
  创建 `webPreferences.preload`；`packages/desktop/src/preload/index.ts` 的 `exposeInMainWorld("zcode", ...)`）。
- preload 绑定到 `webContents`，不随页面 origin 变化。主窗口一旦顶层导航到远程页面，该页面也能调用 `window.zcode`。
- Markdown 中 Mermaid 生成的 SVG `<a xlink:href>` 通过 `dangerouslySetInnerHTML` 注入
  （`packages/ui/src/components/ai-elements/mermaid-block.tsx`），不经过应用的链接组件。点击后 Chromium 在主窗口内
  做顶层导航，文档作者可以借此把用户带到任意页面。
- 修复前，主窗口只有 `setWindowOpenHandler` 拦截新窗口，没有任何导航守卫。

## 信任边界（预期行为）

- 挂载 `preload/index.cjs`（window.zcode）的窗口都有导航守卫，目前包括：
  - 主窗口（`createBrowserWindow`，`desktopWindowChrome.ts`）；
  - 更新状态窗口（`index.ts` 中 `windowKind: "update-status"`）。
    两者调用同一个 `guardWindowNavigation`，判定函数 `isAppOriginMainWindowUrl` 不复制。
- 上述窗口的顶层导航只允许应用自身的渲染入口：
  - 生产包：`file://` 下 `renderer` 目录内的文件；
  - 开发态（`!app.isPackaged` 且存在 `ELECTRON_RENDERER_URL`）：该地址的 origin。
    与 `desktopHostProcess.ts` 的加载条件保持一致，生产包忽略继承的开发地址。
- 其他顶层导航一律 `preventDefault`，并记录一条 warn 日志（不含 URL）。
- 子 frame 不在本守卫范围内。`nodeIntegrationInSubFrames` 未开启时 preload 不注入子 frame，应用内 iframe
  （`web-preview.tsx`、`CloudDialogHero.tsx`）保持原行为。
- `<webview>` guest（内置浏览器、Coding Plan、Rewards、插件沙箱）是独立 `webContents`，沿用各自的策略，不受本守卫影响。
- 远程链接被阻止后静默拦截，不自动外开（待决策 1 已决定）。链接如何打开由 UI 层负责，见后续工单。
- 被拦截的导航不替换页面，因此不影响依附于当前 renderer 的能力。App 控制导航（`OpenSession` 等）的 renderer 登记
  只在主框架导航真正提交（`did-navigate`）或 renderer 进程退出时失效，不以导航开始为准：Electron 44 对被
  `will-navigate` 拦截的导航仍先发出 `did-start-navigation`，按导航开始失效会让拦截之后的 App 控制导航一直返回
  `renderer-unavailable`，直到重启 App。

```text
点击外链 → did-start-navigation → will-navigate（preventDefault，记 warn）→ 不提交，页面与 renderer 登记保留
reload / 应用内页面跳转 → did-start-navigation → will-navigate（放行）→ did-navigate → 登记失效 → 新页面重新登记
```

## 已决定与后续工单

1. 远程 `http(s)` 链接被阻止后：**静默拦截**（选项 A，守卫不改）。
   Mermaid 链接点击改由 mermaid-block 拦截并走普通聊天链接的 `platform.openExternal`，另有内部工单。
   主进程守卫保持只拦不开。
2. 主进程侧的纵深防御另有内部工单，不在本规格范围内。

## 验证

- 回归检查应断言防护行为（远程 URL 导航被 `preventDefault`，应用入口导航保留），不得在仓库内保留可直接复用的攻击 PoC。
- 运行时验收：`packages/desktop/test/security/main-window-navigation-guard.runtime.test.mjs`。在真实 Electron 中加载
  生产中的 `guardWindowNavigation` 与 `isAppOriginMainWindowUrl`（从源码 AST 抽取，不复制逻辑），
  对主窗口与更新状态窗口分别断言：导航到本机外部地址被拦截且目标服务器未收到请求；应用渲染入口正常加载。
  运行：`pnpm --filter @zcode/desktop exec node --test test/security/main-window-navigation-guard.runtime.test.mjs`
  （需要已安装 electron 二进制；不需要网络，外部地址为本机回环服务。）
  反向对照：临时去掉守卫调用后该用例失败（`main 外部导航不应改变地址`），说明断言能区分有无守卫。
- 守卫与 App 控制导航：`packages/desktop/test/security/app-control-navigation-blocked-navigation.runtime.test.mjs`。
  在真实 Electron 中组合生产中的 `guardWindowNavigation`、`windowSurface`（`electronBridge.ts`）与
  `createAppControlNavigationWindow`（均从源码抽取）：外部导航被拦截后，导航请求仍送达当前 renderer，不返回
  `renderer-unavailable`；之后 reload，请求立即返回 `renderer-unavailable`。
  运行：`pnpm --filter @zcode/desktop exec node --test test/security/app-control-navigation-blocked-navigation.runtime.test.mjs`
- 未纳入本验收：完整 `createBrowserWindow` 与更新状态窗口的接线，以及 `loadURL` 发起的程序化导航（Electron 不对其触发
  `will-navigate`，应由调用方自身保证目标地址可信）。
