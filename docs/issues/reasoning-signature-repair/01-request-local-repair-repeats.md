# 签名修复只改本次请求副本，之后的请求可能每次先失败一次

Status: done

## 现象

Anthropic Messages 请求因 thinking 块被拒（HTTP 400，`not created in this conversation` / `bound to a different conversation` / 签名无效）时，adapter 去掉已签名的 reasoning 后重发一次。原 spec 规定这次修复只作用于本次请求的副本，不改 MessageHistory 和持久化消息（[anthropic-reasoning-history-replay.md](../../../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md)「Signature rejection」）。

历史里的 thinking 块不变，之后每个请求都会带上它们：

```text
请求 N   → 400（thinking 块被拒）→ 本地副本去掉 reasoning → 重发成功
请求 N+1 → 400（历史未变，同样被拒）→ 再去掉一次     → 重发成功
...
```

后果：每轮多一次失败请求和一次零延迟重试；模型每轮都看不到之前的 thinking。

## 已确认

- 确定的触发条件（Anthropic 官方文档「Preserved thinking」）：5.1 及以后的 Anthropic 模型只在 `system`、`tools` 和它之前的所有 message 都不变时接受回放的 thinking 块。客户端自己写摘要、原样保留最近几轮（auto/reactive compaction 的保留段）时，保留段里的 thinking 一定失效。2026-08-31 及以后创建的账号默认返回 400，更早的账号默认放行。
- 文档还写明：去掉的块不能再放回；放回后，它不在期间生成的 thinking 也会失效。所以只改本次请求副本时，下一个请求必然再 400。
- 修复方式保留：去掉本次请求里全部已签名 reasoning 后重发。第三方兼容端点不一定返回出错块的位置，只去掉一块的做法不通用。
- 选定方案：修复成功后，在这次请求产出的 assistant 消息上记 `signedReasoningReset`（live entry 和 `AssistantMessageInfo.metadata`）；之后的请求投影去掉最后一个标记之前的全部已签名 reasoning，与修复那次发出的前缀逐字节一致。spec 见「Keeping removed reasoning out」。

## Comments
