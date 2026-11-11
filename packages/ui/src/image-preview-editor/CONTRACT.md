# 图片预览编辑

图片原字节只读；transform 和标注历史由当前预览唯一持有，有修改时关闭或切图必须先确认，明确放弃或成功添加后才销毁。
保存捕获 focused Composer receiver 后异步导出自然尺寸 PNG；接收方释放 scope 后必须拒绝旧 receiver。
`registerImageComposerTarget` 由 Composer 的附件 hook 注册，仍以既有 `addAttachmentFiles` 为唯一入队路径。
编辑器不持有上传队列，不发送消息，不调用主进程。缩放、选择和标注均在自然像素坐标中进行。
图片编辑不提供橡皮擦；保存按钮位于工具栏下方的独立区域，桌面和手机均保持间隔。
松手后先到达的 `lostpointercapture(buttons=0)` 与 `pointerup` 共用一次性提交路径；真正取消及按住时失去捕获仍丢弃草稿。
详见 [spec](../../../../docs/ui/shared-image-preview-dialog.md)。

## 预览入口与平台动作

本模块同时拥有图片文件引用的读取 hook、引用按钮、原图下载和剪贴板复制。
这些入口暂保留在 `hooks`、`lib` 和 `v4` 原路径，由策略的精确 root 登记；不接管这些目录里的其他 UI。
共享对话框仍负责图库显示，用户消息正文组合属于 `conversation-user-input-presentation`。

- `useImageFilePreview` 只通过当前 ServiceProvider 的 fileService 读取图片，不自行建立 Host。
  工作区、远程 session、目标路径或服务变化以及关闭预览都会使旧请求失效。
- `copyPreviewImage` 和 `imagePreviewDownload` 是展示层浏览器操作，不是纯领域计算。
  原图复制与下载不包含未保存标注；读取有大小限制，复制受浏览器剪贴板和 CORS 权限约束。
- 平台能力类型来自 `shared`；打开方式复用 `ui-file-menu` 的公开入口。
  本地副本仅以平台返回的实际保存路径为准，Web 下载开始不产生本地路径。
- 图库、下载与文件引用不改变 task/session、上传队列或 continuous/replayable 边界。

`onNavigationGuardChange` 向图库注册离开请求入口；dirty、待离开动作、导出及原图添加的忙态由编辑器持有。图库只转交关闭/切图意图。确认期间禁用背景快捷键；导出/原图添加期间拒绝离开，失败保留内容。
