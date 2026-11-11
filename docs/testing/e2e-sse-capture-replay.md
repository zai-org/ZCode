# E2E SSE Capture And Replay

目标：桌面 E2E 的外部模型接口必须能先录制、再在完全隔离环境中按流式语义回放。普通 JSON 响应可以继续按完整 body 回放；`text/event-stream` 必须保留 SSE event 的顺序和相对时间。

## Artifact 协议

网络抓包记录继续写入 `E2ENetworkCaptureArtifact.records`。当响应是 SSE 时，单条 record 额外包含：

```json
{
  "responseEvents": [
    {
      "sequence": 0,
      "offsetMs": 0,
      "byteLength": 356,
      "text": "event: message_start\ndata: {...}\n\n"
    }
  ]
}
```

- `sequence`：同一响应内的 SSE event 顺序。
- `offsetMs`：从第一段 SSE 响应数据到该 event 完整可用时的相对时间。
- `byteLength`：该 event UTF-8 字节数。
- `text`：完整 SSE event 文本，包含末尾空行分隔符。

抓包层按 SSE event 分隔符解析，而不是按 TCP chunk 记录。原因是 chunk 边界不稳定，产品语义真正关心的是 `message_start`、`content_block_delta`、`message_stop` 等 event 的出现顺序和节奏。

## Fixture 协议

回放 fixture 的 `response` 支持两种形态：

```json
{
  "response": {
    "statusCode": 200,
    "headers": { "content-type": "text/event-stream; charset=utf-8" },
    "closeMode": "end",
    "events": [
      { "sequence": 0, "offsetMs": 0, "byteLength": 100, "text": "event: ...\n\n" }
    ],
    "body": "event: ...\n\n"
  }
}
```

- 有 `events` 时，replay server 按 `offsetMs` 分段写入响应，不设置 `content-length`。
- 没有 `events` 时，保持旧行为，一次性写入 `body`。
- `body` 可以保留作为人工查看和旧工具兼容字段，但自动化应优先使用 `events`。
- `closeMode` 只对 `events` 流式回放有意义。默认 `end` 表示正常 EOF；`destroy` 表示写完已声明 events 后销毁 socket，用来构造 SSE 中途异常断开。`destroy` 产出的 network artifact 会把该 record 标为 `status="error"`，并写入 `replay.closeMode="destroy"`。

fixture 顶层还支持可选的 `maxMatches`：

```json
{
  "id": "upstream-auto-compact-retry-empty-1",
  "maxMatches": 1,
  "match": {
    "bodyIncludes": ["CRITICAL: Respond with TEXT ONLY"]
  }
}
```

`maxMatches` 只影响本地 replay server 的匹配顺序，用来表达“同一类请求前 N 次返回 A，之后继续匹配后续 fixture 返回 B”的测试序列。例如自动 compact retry 会让前两次 summary 请求返回空文本，第三次返回成功 summary。它不是产品协议字段，也不会进入线上请求。

replay server 还会把命中的 fixture 写进抓包 artifact：

```json
{
  "replay": {
    "fixtureId": "upstream-sse-disconnect-after-delta",
    "closeMode": "destroy"
  }
}
```

这用于排查 fixture 匹配顺序和故障注入类型，不是线上 capture 字段。

artifact 写入合同：

- 唯一数据源是 replay server 内存中的 records；artifact 文件只是它的全量快照投影。运行中的测试（如 `waitForUpstreamRequest`）直接轮询该文件，不会触发写入。
- 每次 record 变化只标记“待写”，由单一串行写入循环在写入时从最新 records 生成快照；多次变化合并为一次写入，旧快照不会覆盖新快照。
- 运行中写入遇到 Windows 文件占用冲突（`EBUSY` / `EACCES` / `EPERM`）时，请求照常回放，写入循环保持“待写”并退避后重试，直到文件落到最新快照；补写不依赖下一次模型请求或 `stop()`。
- 非占用冲突的写入错误按原合同结束当前请求。`stop()` 先关闭 listener，再等待写入循环收口并做最终写入；最终写入失败时抛错。

## 运行模式

- `replay`：默认模式，所有 DeepSeek 请求打到本地 replay server，使用 fixture 响应。适合 Docker 完全隔离运行。
- `capture`：显式设置 `E2E_PROVIDER_HTTP_MODE=capture` 后启用 MITM proxy，真实访问上游并输出带 `responseEvents` 的 artifact。录制产物经过 review 后再转成 fixture。

## Docker 回放

容器入口是 `pnpm test:e2e:container`，由 `scripts/test-desktop-e2e-container.sh` 调度。默认网络模式是 `E2E_NETWORK_MODE=replay-isolated`：

```bash
E2E_NETWORK_MODE=replay-isolated \
E2E_SPEC=./test/e2e/conversation-session/context/conversation-session-compact.test.ts \
pnpm test:e2e:container
```

`replay-isolated` 会给测试容器加 `--network none`，并强制 `E2E_PROVIDER_HTTP_MODE=replay`。此时 WDIO、Electron、app、agent、DeepSeek replay server 都在同一个容器内运行，外部模型接口不会出网。

DeepSeek capture/replay JSON 会挂载到本次报告目录的 `network-capture/` 下，默认文件是 `network-capture/upstream-provider.json`。这份 JSON 记录了 app 对 DeepSeek 的请求、响应以及 SSE `responseEvents` 时间线，可作为 fixture review 和后续回放依据。

可选模式：

- `E2E_NETWORK_MODE=replay-isolated`：默认，断网回放，只允许容器内 loopback。
- `E2E_NETWORK_MODE=bridge`：使用 Docker 默认网络，但 DeepSeek 默认仍为 replay。
- `E2E_NETWORK_MODE=capture`：受控出网录制，脚本会强制 `E2E_PROVIDER_HTTP_MODE=capture`，并要求提供真实 `E2E_PROVIDER_API_KEY`。

录制命令示例：

```bash
E2E_NETWORK_MODE=capture \
E2E_PROVIDER_API_KEY=sk-... \
E2E_SPEC=./test/e2e/conversation-session/context/conversation-session-compact.test.ts \
pnpm test:e2e:container
```

`capture` 产物会输出到 `network-capture/upstream-provider.json`，review 后再转成 fixture；CI 和日常回归应使用 `replay-isolated`。
