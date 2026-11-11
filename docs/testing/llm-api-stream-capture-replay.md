# LLM API Stream Capture Replay

## 背景

流式性能问题不能只靠最终 Markdown 文本复现。真实链路里的 provider SSE chunk 数量、chunk
间隔、agent/protocol 合并、renderer IPC、UI chunk batch、Markdown 渲染和动画都会影响 CPU。
只保存完整 response body 再一次性回放，会改变通信节奏，无法稳定复现 renderer 层压力。

## 目标

- e2e capture 继续通过本地 MITM 代理访问真实 provider。
- capture artifact 在保留请求/响应预览的同时，记录 response chunk 时间线。
- replay server 支持按照 chunk 时间线流式写回响应，保持首 chunk 延迟和后续 chunk 间隔。
- DeepSeek provider e2e 默认固定回放行为不变；性能采样可通过环境变量覆盖 prompt 和 replay fixture。

## 非目标

- 不录制或回放 renderer IPC、ZCode Protocol event、UI store mutation。
- 不把真实 API key 或鉴权 header 写入 artifact。
- 不保证跨 provider 通用语义解析；本阶段只在 e2e 网络层保真 HTTP/SSE 响应节奏。

## Artifact 扩展

`E2ENetworkCaptureRecord` 新增可选字段：

- `responseChunkTimeline`：response body chunk 列表。
- `responseChunkTimelineTruncated`：chunk 时间线达到本地大小上限时置为 `true`。

每个 chunk 包含：

- `offsetMs`：从请求进入 capture proxy 到该 chunk 到达 proxy 的毫秒偏移。
- `byteLength`：原始 chunk 字节数。
- `base64`：记录到 artifact 的 chunk bytes。

`responseTextPreview` 仍然用于人工查看和现有 usage 解析；性能回放优先使用
`responseChunkTimeline`。

## 回放语义

replay fixture 的 `response.chunks` 存在时：

- replay server 不写 `content-length`，让 Node 以 chunked response 流式发送。
- 第一个 chunk 等待其 `offsetMs` 后写出。
- 后续 chunk 按相邻 `offsetMs` 差值等待后写出。
- `response.body` 仍保留为完整响应文本，用于报告和旧断言。

没有 `response.chunks` 的旧 fixture 继续一次性返回 `response.body`。

## 使用

采集真实 GLM highspeed 响应：

```bash
E2E_PROVIDER_HTTP_MODE=capture \
E2E_PROVIDER_PRESET=glmhighspeed \
GLM_HIGHSPEED_E2E_API_KEY=... \
E2E_PROVIDER_PROMPT='输出一篇很长的 Markdown，末尾包含 PERF_TRACE_DONE' \
E2E_PROVIDER_EXPECT_REPLY_TEXT=PERF_TRACE_DONE \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

`glmhighspeed` preset 使用 Anthropic-compatible endpoint
`https://open.bigmodel.cn/api/anthropic` 和模型 `glm-5.1-highspeed`。capture 模式在未显式指定
provider preset 时默认仍使用 DeepSeek v4 flash；只有显式设置
`E2E_PROVIDER_PRESET=glmhighspeed` / `LLM_E2E_PROVIDER_PRESET=glmhighspeed`
时才会切到 GLM highspeed。GLM highspeed preset 默认不强制选择思考深度；如需覆盖，可显式设置
`E2E_PROVIDER_THOUGHT_LEVEL`。

capture artifact 默认写入：

```text
packages/desktop/.e2e-home/.zcode/e2e-network-capture/upstream-provider.json
```

后续回放自定义 fixture 或 capture-derived fixture：

```bash
E2E_PROVIDER_PRESET=glmhighspeed \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=/absolute/path/to/replay-fixture-or-capture.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/infrastructure/smoke/upstream-provider.test.ts
```

## 风险与边界

- response chunk timing 是网络层观测，不能代表 provider 内部 token 生成时间。
- capture artifact 可能包含大响应正文，只保存在本地 e2e artifact 目录，不提交。
- 如果响应超过 chunk 时间线上限，artifact 会标记 truncated；这类记录不能用于完整流式回放。
