# CUA 最终图像与像素坐标完整性契约

状态：实现契约

冻结基线：`3ee0eadbe3dfda41a65bf2ac1a0d4ab761311060`
（`origin/feat/cua-merge`）

上游设计：CUA 设计文档，revision 75（V3）。

producer 实现：workspace 包 `packages/zcode-cua`（导入基线 `zcode-cua@4a3c507dd16f3ed840e87bc92e709ce339e6a4f3`；包含 image-first、transport 内部 frame 绑定与 raster-only 恢复指引）。

revision 同时包含 0.5.7 producer surface 简化、最终栅格/Zoom 权威、WindowServer
截图点击、window-event Ghost Cursor 反馈、Helper 更名及 `PERMISSION_REQUIRED` 授权指引，
以及 0.5.8 CUA 目标应用展示元数据，不得回退到任一分叉 SHA。

## 目标

官方 CUA 把图像交给模型后，模型只回传：

```json
{ "type": "coordinate", "x": 496, "y": 331 }
```

`x/y` 是模型实际收到的那张图的整数像素。模型不选择 Retina、DPI、
逻辑点、物理像素、crop、缩放、窗口原点或显示器坐标系；这些差异全部由
`@zcode/zcode-cua` 和 Helper 内部处理。

该约束只定义“模型从图像选点”这条路径。模型直接使用可访问性树中的
`state_id/index` 时仍可传 element target；element target 不携带图像坐标，也不得作为
图像选点的替代编码。两条路径在公开 schema 中保持显式区分。

## 跨进程时序

```text
Helper capture
    │ 原始 raster + capture/pointer/topology provenance
    ▼
zcode-cua 最终 crop/resize/encode
    │ 注册不可变内部 frame，并返回 image + image_ref + hint
    ▼
ZCode MCP bridge
    │ 官方 CUA 图像必须保持字节、尺寸、方向和 block 邻接关系
    ▼
模型 provider 请求
    │ 模型按收到的 raster 只选择整数 x/y
    ▼
zcode-cua transport 同步绑定当前 frame → registry → 像素中心投影
    → Helper 二次 provenance 校验 → 原生输入
```

任何一层无法证明该链路时，坐标动作必须拒绝；不得退回 `screen`、
`normalized`、`state_image`、`screenshot` 或“最新图像”推断。

## 最后一公里约束

通用 MCP bridge 当前会对超过 inline budget 的图片执行省略、artifact 化或
特定来源压缩。这对普通 MCP 合理，但对已签发 `frame_id` 的官方 CUA raster
会破坏坐标契约：模型看到的图可能不再是 descriptor 指向的图。

因此官方 CUA 需要独立的完整性门禁：

1. raster 必须是 tool result 首块，`image_ref` 文本块紧随其后；bridge 不得把任何
   diagnostic/hook 文本放到 raster 前面，也不得重排或拆散该原子对。
2. raster 在 zcode-cua 已经按 190 KiB 预算编码，ZCode 不得再次 resize、crop、
   rotate、重编码或替换为 artifact 文本。
3. 若 raster 仍超过 provider 明确上限，结果整体 fail-closed，不能只保留
   `image_ref` 后继续允许该 frame 动作。
4. 每个结果只允许一张最终 raster；模型可见 block 的 image bytes 必须原样保持，
   MIME、宽高必须与 `image_ref` 一致。producer 内部用于 frame 签发的字节摘要不扩展
   公开 `image_ref`，bridge 通过原字节不变与 raster header 独立校验承担最后一公里证明。
   校验边界如实声明：字节/形状校验在 MCP bridge（入站）与 executor attestation
   （出站、fail-closed）完成；下游 provider 投影不重复校验 attestation，而是通过
   通用"相邻配对文本"结构规则（延后媒体投影、媒体预算、压缩占位）保证
   `image_ref` 与 raster 相邻到达模型、或被一起移除。
5. 上述特殊路径只允许在不可伪造的 official CUA authority gate 成立时启用；
   同名第三方 MCP 不能获得该豁免。
   Host 内部只用 `modelContentProtection=official_cua_frame_v1` 表示这项授权；不得再维护
   第二个需要同步设置的 preserve boolean。缺失该 protection 的结构化媒体一律走通用预算。
6. `PostToolUse` hook 只能在受保护媒体对之后追加有界文本；不得替换、重排、
   删除或在 image 与 `image_ref` 之间插入内容。
7. 任一引用、MIME、base64、文件头、尺寸、预算或重复 `frame_id` 校验失败时，
   bridge 必须原子移除本次结果中的全部 CUA image/image_ref，并把结果标记为错误；
   不得把残缺媒体继续发送给模型。
8. `structuredContent` 里不得出现真 JSON `image_ref` 权威——权威只属于紧贴 raster
   的那个 content 块，它绑定的是模型真正收到的那张图。producer 侧派生
   `structuredContent`（例如给 `nodeRepl.write(state.text)` 用的 AX 文本）时必须把
   权威块排除在外，否则同一份权威出现在两处，第 7 条会把每一次带截图的观察全部拒掉。
9. 拒绝面分两路，且不可合并：模型只拿到一句不含 `frame_id`、不含落盘路径的通用
   「重新截图」提示（被拒的帧不能反过来成为可用权威）；具体判据放在结果 `_meta`
   的 `zcode.cua/frame-integrity-rejections-v1` 上。宿主 `formatMcpToolResult` 只读
   一个特定 `_meta` 键、从不整体序列化 `_meta`，所以判据可诊断而不进模型上下文。
   判据不得只存在于函数局部变量：2026-09-11 真机上第 8 条被违反，判据被拒绝后即
   丢弃，于是「每一次带截图的观察都被自己的门禁否决」这种整条通道故障静默了一整天。

## Helper provenance 契约

Helper 必须显式声明 `frame_pixel_projection_v1`，capture 返回用于构造
FrameDescriptor 的权威字段：捕获 raster 尺寸/crop、pointer rect/unit、应用
owner、window_id/bounds、display identity 和 topology fingerprint。

动作 RPC 携带投影后的 point 与捕获时 provenance。Helper 在原生输入前重新
读取当前 owner/window/display/topology；不一致返回 `stale_frame` 且
`actuated=false`。旧 Helper、字段缺失、Wayland 或无法证明 1:1 root grid 的
X11 环境只拒绝 frame coordinate；element/AX 路径保持可用。

## 验收

- 官方 CUA 小图和接近/超过通用 200 KiB 阈值的图都保持 raster 不变；
- 相邻 `image_ref` 与 image block 经 MCP bridge 后仍相邻；
- 非官方 MCP 仍遵循通用 inline/artifact 预算；
- `returnedBytes` 是模型可见文本与真实 raster payload 的唯一 aggregate；不得暴露或依赖
  第二份 `mediaBytes` 状态。追加 hook 只把实际新增的 UTF-8 bytes 加到既有 aggregate；
- capture capability/provenance 缺失时坐标动作零 actuation；
- macOS Retina、Windows DPI-aware physical pixels、Linux X11 可证明范围有
  marker-grid 证据；Wayland 与歧义 X11 fail-closed；
- `pnpm typecheck`、`pnpm lint` 和相关 package tests 全绿。
- producer pin 必须通过 frame-contract 导出与实现存在性门禁，并在候选 provenance 中记录
  最低基线的合入关系；版本号一致但缺少像素契约时必须判为 packaging failure。
