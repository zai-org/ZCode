# Compact 媒体能力投影

## 问题

普通模型请求会在 provider 调用前按执行模型的输入能力投影历史消息；当
`properties.input_format.support_image === false` 或 `support_pdf === false` 时，对应媒体块会替换为明确的
文本占位符。Compact summary 请求虽然复用了 MCS / system-reminder 等 provider-message
投影，但此前没有执行媒体能力投影，因此 text-only 模型会在收到历史媒体块时以
`invalid_model_request` 失败。

## 语义

```text
RuntimeMessageEntry 历史
        |
        v
prepareRuntimeProviderRequest（传入 compact prompt）
  - attachment / reminder 排序
  - MCS 或 <system-reminder> 投影
  - compact prompt 与 cache control
        |
        v
按 compact 执行模型投影媒体能力
  - support_image === false -> image 替换为标准 omitted 文本
  - support_pdf === false   -> PDF 替换为标准 omitted 文本
  - true                    -> 首次请求保留媒体
        |
        v
现有 media_too_large 降级（仅失败后重试）
        |
        v
Compact ModelRequest 事件与 provider 请求
```

- 手动、自动和 Reactive Compact 必须通过同一个投影边界。
- 能力必须取本次 `compactModel.properties`，不得回退到会话默认模型或父 turn 的旧快照。
- `ModelRequest` 事件必须记录投影后的 provider-visible 消息。
- 能力投影发生在首次请求之前；不得依赖 `invalid_model_request` 失败后重试。
- 现有 `media_too_large` 重试语义保持不变：能力为 `true` 时首次保留媒体，
  provider 明确报告媒体过大后才使用 compact 专用短占位符重试。
- Compact 继续使用独立的 stream/non-stream fallback、summary output cap、tool surface、
  cache-control 和 prompt-too-long 重选逻辑，不整体改走普通 turn 的模型请求函数。

## 验收

- text-only 模型面对含历史图片的自动 Compact 时，请求中不存在 `image` block，且包含标准
  `Media omitted from provider request` 文本，Compact 能正常完成。
- `input_format.support_image: true` 时，首次 Compact 请求仍保留图片。Active Model Properties 是完整事实，
  不存在“能力未知”的运行时状态。
- 图片和 PDF 的能力投影均使用通用 helper；现有 `media_too_large` 两阶段请求测试继续通过。
