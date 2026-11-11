# Preview Pane

## 目标

右侧 Preview Pane 用于在 side pane tab 中预览工具调用、文件链接和工作区文件。它只负责展示，不直接解析业务语义；预览数据由 `packages/ui/src/lib/codeViewer.ts` 和调用方构造成 `CodeViewerSource` 后传入。

## 支持的预览类型

- `file`：按路径读取真实文件内容；不超过 `256KB` 的文本文件一次完整读取，超过上限时显示本地化的大文件提示；二进制文件按文件类型分派专门的预览适配（当前为图片、媒体、PDF、PPTX），未适配的类型仍显示不可预览提示
- `text`：直接渲染内存中的文本内容，按 `language` 使用代码高亮
- `patch`：渲染 unified diff / patch，保留增删行语义
- `image`：读取媒体预览并显示图片；当前识别 `apng`、`avif`、`bmp`、`gif`、`ico`、`jpeg`、`jpg`、`png`、`svg`、`webp`
- `media`：使用原生 `video` / `audio` 控件预览 MP4、MOV、WebM、M4V、MP3、WAV、M4A、OGG、Opus、FLAC 和 WEBA；Desktop 本地文件通过授权 `zcode-media://` URL，Desktop SSH/WSL/Docker 文件通过 Host loopback HTTP Range Proxy，手机 `/remote` 仅使用 workspace-scoped 小文件 inline 读取
- `pdf`：渲染 PDF 只读预览；当前识别 `pdf`，只提供预览能力，不提供编辑能力。所有入口统一创建 `file` source，由 PreviewPane 的 `resolvePreviewPanePdfSource` 惰性升级为 `pdf`（与 image 的升级模式一致），保证 tab key 全部走 `file:{path}` 去重。数据加载走 `fileService` 的分段读取（`stat` 拿 size；小于 `2MB` 循环 `readFileRange` 拉全量，超过则交给 pdf.js range 按需分段加载），无整档大小上限；旧远端（`stat` 不返回 `size`）回退整档 base64 的 `readMediaPreview` 旧通道，保留其 8MB 上限
- `office`：以只读模式预览 `.xlsx`、`.xlsm`、`.xls`、`.docx` 和 `.doc`；Excel 以 `.xlsx` 为完整支持路径，`.xlsm` / `.xls` 仅展示渲染库能够解析的数据，`.docx` / `.doc` 统一交给 Word 渲染器。`.xlsx` 在插件面板可用时优先分流到内置 `spreadsheets` 查看面板，Preview Pane 只承接 `.xlsm` / `.xls` 与回退路径，分流规则见 [office-file-preview](office-file-preview.md) 的入口路由章节
- `pptx`：渲染 PPTX 只读预览；当前识别 `.pptx`，以左侧垂直缩略图列表和右侧单页预览展示，底部工具栏提供翻页、页码跳转和缩放。所有入口仍创建 `file` source，由 PreviewPane 惰性升级为 `pptx`，保证 tab key 继续走 `file:{path}` 去重。第一期只实现 `PresentationPreviewEngine`，编辑、导出、写回仅保留分层接口。新 Host 使用 `64MB` 上限；旧远端缺少 `stat.size/readFileRange` 时保留 `8MB` base64 兼容上限，并显示独立的本地化提示而不是误报 `64MB` 或透出远端路径。详见 `docs/ui/pptx-preview.md`

## 文件与文本渲染规则

### 原生媒体控件主题

- `video[controls]` / `audio[controls]` 统一跟随应用已有的 `.dark` 主题类设置 `color-scheme`：浅色为 `light`，深色为 `dark`。沿用 `applyTheme` 对 Zai、旧版偏好和 System 的解析，不单独读取系统偏好。
- 规则由 UI 公共样式入口加载，覆盖 Preview Pane、聊天附件弹窗、共享媒体预览及云端媒体 Hero；无 `controls` 的缩略图不在范围内。
- 样式定义在 `packages/ui/src/nativeMediaControls.css`，由 `packages/ui/src/styles.css` 导入；主题解析仍由 `packages/ui/src/useTheme.ts` 的 `applyTheme` 负责。
- 桌面和手机 Web 共用样式。只改变浏览器原生菜单及控件的外观，保留播放、速度选择、媒体加载及远控数据路径。
- macOS 视频菜单本地化依赖打包时保留 `en.lproj` / `zh_CN.lproj`；主题样式不能替代语言包修复。
- 验证要求：单测读取实际媒体样式，覆盖深浅主题与 System、Desktop/Web 表面及无控件缩略图；真实 Electron 验证中英文溢出菜单和速度子菜单，并在桌面/窄屏下检查明暗主题切换。

### 通用渲染规则

- `.md` / `.markdown` 文件和 markdown 文本 source 默认进入预览模式，可在更多菜单切换到源码
- `.svg` 文件和带 `.svg` path 的文本 source 默认进入 SVG 预览，可切换到代码；切到代码模式后可继续使用自动换行开关
- 图片预览使用 4px 马赛克背景，内容区保留 `p-10`；位图默认按自然尺寸显示，文件名带 `@2x`、`@3x`、`@1.5x` 等倍率时，会按倍率折算为对应 CSS 展示尺寸，并继续受容器最大宽高约束；SVG 作为矢量图按容器 `contain` 适配，不参与位图倍率折算
- Office 文件通过 workspace-scoped `fileService` 读取完整二进制内容，跨 RPC 传输上限为 25 MB；渲染器和 WASM 资产按文件类型懒加载，避免增加普通文本、图片预览的首屏负担
- Excel 预览使用当前 Zai Light / Dark 主题；DOCX 页面保持白纸语义，桌面端与手机 Web 均可在预览容器内滚动访问完整内容
- 普通代码文件使用基于 Shiki tokens 的语法高亮，更多菜单提供自动换行开关
- 代码源码渲染为逐行结构：每行包含不可选中的 `line` 行号区和可选中的 `code` 内容区
- 横向滚动时 `line` 行号区保持 sticky 固定；开启自动换行后，仅 `code` 内容区参与换行
- 普通文本/代码文件以 `256KB` 为预览上限：上限内一次读取并作为单个完整文档渲染，保证 UTF-8 解码、行号和滚动上下文连续；超过上限时不渲染局部内容，显示本地化提示，引导用户使用其他编辑器打开
- `256KB` 上限只约束普通文本/代码预览；PDF、PPTX 和 Office 文件继续使用各自的二进制读取、大小限制和渲染链路
- `.pdf` 文件进入 PDF 只读预览，按页渲染并支持滚动浏览；不提供源码视图切换，当前版本不提供编辑、批注能力
- Word、Excel、PPTX 与 PDF 文档预览的通用顶部标题栏下方必须展示 `border-border` 横向分隔线；普通代码、图片、Markdown 等预览保持原有无分隔线标题栏。
- `.pptx` 文件进入 PPTX 只读预览，主区域只挂载选中页；不提供源码视图、内置编辑、导出或保存能力，
  但顶栏保留与 XLSX、DOCX 相同的通用“在外部编辑器打开”按钮，该操作不属于 Preview Pane 内部编辑或写回

## 路径处理

- Preview Pane 在入口处会规范化 `CodeViewerSource`，将本地路径中的 URI 转义还原，例如 `Auto%20Snake` 会显示并读取为 `Auto Snake`
- side pane 生成 tab key 前也会执行同样的规范化，避免同一个文件因为 `%20` 和空格两种写法被打开成两个 tab
- 路径只在文件读写、打开编辑器等路径语义中使用；workspace 隔离仍遵守 `workspaceIdentity?.trim() || workspacePath`

## 面包屑行为

- 顶部面包屑优先按当前 workspace 展示为 `workspace -> 目录 -> 文件`
- 长路径使用横向滚动，不压缩文件名区域
- 初次打开或切换 source 后，面包屑默认滚到最右侧，优先展示末尾目录和文件名
- 只有存在可滚动内容时才显示边缘 mask；位于左侧、中间、右侧时分别显示右侧、双侧、左侧渐隐

## 相关文件

- `packages/ui/src/PreviewPane.tsx`：pane 壳、面包屑、视图切换和文件读取生命周期
- `packages/ui/src/components/ui/code-viewer.tsx`：通用 `CodeViewer` Shiki 代码查看组件，负责逐行渲染、sticky 行号和换行策略；side pane 和后续 markdown 代码块复用同一入口
- `packages/ui/src/components/ui/pdf-viewer.tsx`：通用 `PdfViewer` PDF 只读预览组件，负责按页渲染与滚动浏览；由 preview pane 的 `pdf` source 分派使用，不承担编辑能力，详见 `docs/ui/pdf-viewer.md`
- `packages/ui/src/previewPanePdfContent.tsx`：pdf 正文薄包装，懒加载 `PdfViewer`（react-pdf 体积较大，只在首次打开 PDF 预览时进入 bundle）
- `packages/ui/src/previewPanePptxContent.tsx`：pptx 正文薄包装，懒加载 PPTX 预览组件和 `@aiden0z/pptx-renderer`
- `packages/ui/src/lib/shikiHighlighter.ts`：通用 Shiki 高亮缓存与异步 token 化入口，避免 `components/ui` 依赖 `ai-elements` 的实现细节
- `packages/ui/src/previewPaneContent.tsx`：按 `CodeViewerSource` 类型分派正文渲染
- `packages/ui/src/previewPaneOfficeContent.tsx`：Office 二进制解码、懒加载和统一错误边界
- `packages/ui/src/previewPaneOfficeXlsxContent.tsx`：Excel 只读渲染与主题适配
- `packages/ui/src/previewPaneOfficeDocxContent.tsx`：DOCX 解析、白纸主题和响应式容器
- `packages/ui/src/lib/officeFilePreview.ts`：Office 扩展名识别和 base64 解码
- `packages/ui/src/lib/codeViewer.ts`：预览 source 类型、工具调用预览提取、语言和图片类型识别
- `packages/ui/src/lib/codeViewerSource.ts`：Code Viewer source 路径规范化
- `packages/ui/src/lib/workspaceSidePane.ts`：Code Viewer tab key 生成与复用
- `packages/ui/src/plugin-ui/officeViewerOpen.ts`：`.xlsx` 文件打开到内置 spreadsheets 查看面板的路由表、能力门与文档驱动
- `docs/ui/office-file-preview.md`：Office 文件预览的边界、状态组合和验证契约
