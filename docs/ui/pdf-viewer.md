# PDF Viewer

`packages/ui/src/components/ui/pdf-viewer.tsx` 是通用 `PdfViewer` 只读 PDF 预览组件，基于依赖 `react-pdf` 封装。组件只负责渲染与浏览交互，不承担编辑、批注能力；PDF 数据由调用方传入。

## 渲染

- pdf.js worker 通过 Vite `?url` 导入 `pdfjs-dist/build/pdf.worker.min.mjs`，在模块加载时设置一次 `GlobalWorkerOptions.workerSrc`；`?url` 的类型声明由 `packages/ui/src/assets.d.ts` 提供
- Desktop 使用 pdf.js 默认构建。Web 构建在 `packages/web/vite.config.ts` 中把 `pdfjs-dist` 主入口和上述 Worker 路径 alias 到同版本的 `pdfjs-dist/legacy/build/`，让旧浏览器的主线程和 Worker 都具备 pdf.js 需要的运行时 API；组件源码不感知该切换。原因与范围见 `docs/web-remote-control/web-browser-support.md`
- Desktop 与 Web 的 Vite 构建都必须把 `pdfjs-dist/cmaps` 发布到当前构建基址下的 `pdfjs/cmaps/`。`PdfViewer` 对所有 source（整档与 range）使用同一组模块级稳定 options，传入 `cMapUrl` 与 `cMapPacked: true`；否则使用 `UniGB-UCS2-H` 等预定义 CMap、且未嵌入字符映射的 CJK PDF 会在 pdf.js 中丢失非拉丁文本。CMap 请求只读取应用自身静态资源，不进入 workspace file service、Host/relay 或 task continuous/replayable 消息链路
- `source` prop 接受 `string`（URL / data URL）、`Blob`、`ArrayBuffer`、`Uint8Array`，以及大文件按需分段加载用的 range 变体 `{ totalBytes, initialData?, requestRange(offset, length) }`；内部 memoize 归一化为 react-pdf 的 `file` 入参，避免引用变化触发文档重新加载。二进制输入会复制一份再交给 pdf.js，防止 worker transfer 把调用方持有的 buffer 置为 detached
- range 变体内部构造 pdf.js `PDFDataRangeTransport`（`requestDataRange` → `requestRange` → `onDataRange`），并以模块级常量 options 开启 `disableAutoFetch` / `disableStream`、`rangeChunkSize = 256KB`（与 service 层 `readFileRange` 的默认分段大小对齐），只按需拉取当前页所需的字节段；分段请求失败时展示加载失败文案并回调 `onLoadError`，文档切换/卸载时 `abort()` 传输
- 单页模式：一次只渲染当前页；页面尺寸超过容器时内容区自身滚动，页面小于容器时水平居中
- 文本层保持开启，支持选中复制；批注/链接层关闭，避免 PDF 内链接在桌面端触发整窗导航
- 加载中、加载失败、空文档均渲染文案提示；文案通过 `labels` prop 注入（默认英文），组件不直接依赖 intl
- 切换 `source` 后重置到第 1 页、缩放 100%
- 组件由 `packages/ui/src/previewPanePdfContent.tsx` 懒加载接入 preview pane，react-pdf 不进入主 bundle

## 底部操作区

- 布局：`border-t` 分隔，控件居中排列：上一页按钮、页码输入 + `/ 总页数`、下一页按钮、分隔线、缩小按钮、缩放百分比、放大按钮
- 缩放：默认 `100%`，按钮步长 `25%`，范围 `25%`–`400%`，到达边界时对应按钮禁用
- 翻页按钮：第 1 页禁用上一页，最后一页禁用下一页
- 页码输入：受控草稿值，Enter 或失焦提交；解析失败还原为当前页，越界时 clamp 到有效范围
- 文档未加载完成时操作区控件整体禁用

## 翻页交互

- 键盘：组件容器 `tabIndex=0`，获得焦点后 `ArrowLeft` / `ArrowRight` 前后翻页；焦点在页码输入框内时不拦截方向键，保留输入框光标语义
- 滚轮只滚动当前页内容，不参与翻页
- 翻页后（按钮、键盘、页码跳转）滚动位置回到页首

## 缩放交互

- 修饰键 + 滚轮连续缩放：macOS 绑定 `command`，其余平台（Windows/Linux）绑定 `ctrl`，平台判定复用 `isAppleKeyboardPlatform`
- 缩放按 `exp(-deltaY * 0.002)` 连续变化（兼容触控板高频小 delta 与鼠标滚轮一格大 delta），与按钮共用 `25%`–`400%` 范围
- 修饰键 + 滚轮独占为缩放手势并 `preventDefault`，不再滚动页面内容；React 的 `onWheel` 委托是 passive 监听无法 `preventDefault`，因此在滚动容器上挂非 passive 的原生 wheel 监听
- 文档加载完成前不注册缩放监听，与操作区控件禁用状态保持一致
- **预览-提交两段式渲染（防闪动）**：react-pdf 在 `scale` 变化时会隐藏并清空画布直到异步渲染完成，连续提交会导致画面持续闪动。因此倍率拆为 `displayScale`（用户看到的目标值，滚轮/按钮实时更新）与 `renderScale`（真正传给 `<Page>` 的值）：手势期间页面布局盒先按 `displayScale` 预留最终宽高，内部已渲染画布再用 `transform: scale(displayScale / renderScale)`、`transform-origin: top left` 做即时预览；停顿 `200ms` 后一次性把 `displayScale` 提交为 `renderScale`。目标布局盒在提交前后尺寸不变，避免页面从居中态跨到横向滚动态时因布局基准切换而抖动。缩放百分比展示绑定 `displayScale`。
- **提交阶段双缓冲**：`<Page>` 的 scale key 会卸载旧 canvas，而新 canvas 在异步绘制完成前是隐藏的。提交前把当前已绘制的 canvas 复制到覆盖层，并直接使用目标布局盒宽高；新 canvas 的 `onRenderSuccess` 到达后才移除覆盖层。旧位图覆盖层与新画布共享同一个左上角和目标尺寸，按钮缩放、连续滚轮缩放以及快速改变目标倍率时都不出现空白帧或明显错位。
- **指针滚动锚定**：修饰键 + 滚轮缩放前记录指针下方 PDF 内容点的归一化坐标；`displayScale` 更新、目标布局盒完成重排后，在 `useLayoutEffect` 中按新位置修正 `scrollLeft` / `scrollTop`，保证同一内容点尽量留在指针下方。缩放按钮没有指针坐标时使用视口中心。真实画布提交不再使用 `scrollWidth` 差值的一半做事后补偿，因为布局盒在提交前后保持稳定。

## 相关文件

- `packages/ui/src/components/ui/pdf-viewer.tsx`：组件实现（含 `PdfViewerRangeSource` 与 `PDFDataRangeTransport` 适配）
- `packages/ui/src/components/ui/usePdfZoomOverlay.ts`：缩放布局、指针锚定与提交阶段的 canvas 双缓冲覆盖层
- `packages/ui/src/previewPanePdfContent.tsx`：preview pane 的懒加载接入层
- `packages/ui/src/assets.d.ts`：Vite `?url` 资源导入的类型声明
- `packages/services/src/file/fileService.ts`：`readFileRange` 分段读取与 `stat` 的 `size` 字段（range 加载的数据来源）
- `docs/ui/preview-pane.md`：preview pane 的 `pdf` source 分派与数据加载策略约定
