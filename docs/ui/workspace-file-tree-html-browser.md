# 文件树 HTML 内置浏览器打开

## 目标

文件树右键菜单对本地 `.html` / `.htm` 文件提供“用内置浏览器打开”动作。动作使用文件的绝对路径生成 `file://` URL，并交给现有右侧 Browser side pane；浏览器在 main 将其转换为[受控 HTML 预览地址](../browser-use/local-html-preview.md)后加载。

## 行为边界

- 仅本地 desktop 文件树显示该动作；远程 workspace 不显示，避免把远端路径误当成本机 `file://` 文件。
- 仅文件类型为 `file` 且扩展名为 `.html` / `.htm` 时显示；目录、Git deleted 虚拟文件不显示。
- URL 生成复用 UI 层路径工具 `toFileUrl()`，保证 macOS/Linux `file:///...` 与 Windows `file:///C:/...` 都能被内置浏览器接收。
- 打开浏览器仍走 `handleOpenBrowserUrl()`，由现有 Browser side pane 负责创建 tab、校验 URL 和导航，不让文件树直接操作 webview。

## 验证

- 浏览器安全与资源加载由 `packages/desktop/test/e2e/browser/files/browser-local-html-preview.test.ts` 验证；文件树入口保持现有 HTML 类型判断。
- 该变更不修改 ZCode session/task realtime、snapshot、queue、replayable/continuous 语义。
