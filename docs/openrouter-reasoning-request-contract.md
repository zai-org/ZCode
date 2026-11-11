# OpenRouter Messages 推理参数修复

## 范围与依据

2026-09-14：Air 的 GLM-5.3 连接测试发送 `thinking.type=enabled`，但没有
`thinking.budget_tokens`，被 OpenRouter 的 Messages 请求校验拒绝（400）。
相同提示词、Key、模型改用 `adaptive + output_config.effort=low` 后返回 200 并完整结束。

- [OpenRouter Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)：
  `enabled` 必须携带整数 `budget_tokens`；`adaptive` 不要求预算。
- [OpenRouter Claude 4.6 迁移说明](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-4-6)：
  adaptive 与预算模式是不同机制，不可使用缺预算的 enabled 代替 adaptive。

## 决策

- 仅修复 OpenRouter Messages 上 GLM、DeepSeek、Kimi K2、Qwen、MiMo 的同类映射。
  这些型号的厂商兼容 Map 会产生没有预算的 enabled；不能直接套用到 OpenRouter。
- 使用站点专用规则：关闭档位发送 `thinking.type=disabled`；其余使用 adaptive，
  effort 原样传递，布尔开启档位 `enabled` 映射到 `high`。不新增任意固定预算。
- 保留原有档位值域、输出上限、模型成员、启停和其他能力；GPT、Claude、Kimi K3 等
  现有专用映射不改。本次不重新设计旧 Claude 的预算策略。
- 规则只匹配 `https://openrouter.ai/api`、可选 `/v1` 和末尾斜杠，且 API 必须是
  `anthropic-messages`。自建 Provider 同样生效，不依赖 Provider ID/模板 ID。
- 不更改其他站点、Chat/Responses、个人 Map 或固定手工配置，不做数据迁移。
  不在 Runtime 增加模型名分支。桌面/远程复用相同配置解析链，无新增状态或协议。
- Fable 已使用 adaptive；本机 403 明确来自地区限制，不通过改 Map 绕过。

## 验收

- 从发布 JSON 解析完整有效配置，枚举 OpenRouter 模板所有模型和合法档位：
  不允许 enabled 缺少合法预算；关闭不变成开启。
- 明确断言受影响型号 adaptive + effort；检查其他站点/API 与 Personal 覆盖不变。
- 保留真实 SDK 序列化后 Map 的 wire 验证和低输出上限（1 token）兼容断言。
- 不把地区受限模型写成真实调用通过，不自动发布远端配置或修改用户配置。

## 验证记录（2026-09-14）

- 新增配置测试修改前 12 项失败、2 项通过；修复后 14 项全部通过。
- 配置、目录、历史 Map、排版与发布结构相关 7 个文件共 133 项通过。
- 真实 SDK 的新模型 wire 与第二批目录 wire 共 88 项通过；新增 8 个 OpenRouter
  案例覆盖五类模型及关闭档位。仅拦截网络，不以 mock 的 200 证明服务端支持。
- Typecheck、格式、架构检查通过；Lint 0 错误、42 条既有警告。
- Air 直连 OpenRouter，使用上述发布配置解析出的请求形态、原连接测试提示词，
  `low`、`max_tokens=1000`；两次均 HTTP 200、`end_turn`、`message_stop`：

| 模型                         | 验证结果           |
| ---------------------------- | ------------------ |
| z-ai/glm-5.3-flash           | HTTP 200，完整结束 |
| deepseek/deepseek-v4.1-flash | HTTP 200，完整结束 |

此前 GLM-5.3 adaptive 对照也完整成功。
其余模型未逐个线上请求；Fable 地区限制仍在。未安装新包、修改 Air 的个人配置或发布线上配置。
