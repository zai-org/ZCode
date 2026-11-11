# Conversation Session Next Decision Review

目标：把当前仍待产品决策的会话区 case 按固定顺序展开，产品确认后再回写 catalog、coverage matrix 和 E2E。

生成命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-next-md
```

## 当前状态

| 指标 | 当前值 |
| --- | ---: |
| Product case 总数 | 232 |
| 已覆盖 | 126 |
| 待产品决策 / 自动化 | 36 |
| 协议题总数 | 36 |
| 协议题 unanswered | 36 |
| Ready case | 0 |
| Blocked case | 36 |
| 下一批 review | N01, N02, N03 |
| 当前输出范围 | 下一批 review：N01, N02, N03 |
| 当前输出 case | 3 |

## 使用方式

1. 按本文件顺序 review case。
2. 对每个 `Question` 写下明确产品结论。
3. 回到对应 decision worksheet，把 `产品结论` 从 `待确认` 改成明确结论，并把 `Status` 改成 `answered`。
4. 按 `回写目标` 更新源 catalog / fault catalog / coverage matrix。
5. 产品语义明确后，再写对应 E2E，最后运行 `pnpm audit:conversation-session-coverage`。

## Review Queue

### P0-2 模型/API 请求故障

#### N01

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N01.1 | 401/403 后最终状态、设置引导、user message 与 queue 是否保留 | auth error、settings entry、queue snapshot | fault N01、fault coverage N01 |

#### N02

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N02.1 | provider/API Key 缺失是发送前阻止还是发送后失败，draft 是否保留 | no network request、composer draft、settings entry | fault N02、fault coverage N02 |

#### N03

- worksheet: `networkSse`
- unanswered questions: 1

| Question | 需要确认 | 候选答案摘要 / 验证关键词 | 回写目标 |
| --- | --- | --- | --- |
| N03.1 | 429 retry 策略、retry 期间入队、最终失败后的状态与 queue | retry count、toolbar retry、queue | fault N03、fault coverage N03 |
