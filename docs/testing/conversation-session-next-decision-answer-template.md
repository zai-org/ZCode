# Conversation Session Decision Answer Template

目标：给产品确认使用的可填写模板。回复时保留 `Case` 和 `Question` 编号，我会按编号回写 worksheet、catalog、coverage matrix，再进入 E2E。

生成命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md
```

## 当前状态

| 指标 | 当前值 |
| --- | ---: |
| Product case 总数 | 232 |
| 已覆盖 | 126 |
| 待产品决策 / 自动化 | 36 |
| 当前模板范围 | 下一批 review：N01, N02, N03 |
| 当前模板 case | 3 |

## 填写规则

1. 每个 `Question` 都要给明确产品结论；不要继续写 `待确认`。
2. 如果选候选答案之外的方案，写在 `补充` 里。
3. 结论要能转成 UI / network / runtime / file 的稳定断言。
4. 如果某个问题要剪枝，写清楚“不需要覆盖”的原因。

## Answer Template

### N01

- worksheet: `networkSse`

#### N01.1

- 需要确认：401/403 后最终状态、设置引导、user message 与 queue 是否保留
- 候选答案/验证关键词：auth error、settings entry、queue snapshot
- 回写目标：fault N01、fault coverage N01
- 产品结论：
- 补充：

### N02

- worksheet: `networkSse`

#### N02.1

- 需要确认：provider/API Key 缺失是发送前阻止还是发送后失败，draft 是否保留
- 候选答案/验证关键词：no network request、composer draft、settings entry
- 回写目标：fault N02、fault coverage N02
- 产品结论：
- 补充：

### N03

- worksheet: `networkSse`

#### N03.1

- 需要确认：429 retry 策略、retry 期间入队、最终失败后的状态与 queue
- 候选答案/验证关键词：retry count、toolbar retry、queue
- 回写目标：fault N03、fault coverage N03
- 产品结论：
- 补充：

## 可直接回复的精简格式

```text
N01:
- N01.1 = 

N02:
- N02.1 = 

N03:
- N03.1 = 

```
