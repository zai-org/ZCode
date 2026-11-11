# 当前配置与维护状态

当前 Git 配置为 revision 44，OpenAI 官方模板新增并默认启用 `gpt-6.1-terra`，Luna 配置保持原样；两者新增独立待执行回归清单，真实 API 本轮未测，见[Terra 维护规格](./openai-terra.md)。revision 43 澄清 TokenHub 为中国站账号下的广州 / 新加坡 API；revision 42 关闭 Coding Plan 与加速卡入口 GLM-5.3 标准版的视频，保留图片与 Flash；此前新增默认启用 `doubao-seed-evolving`。方舟普通 API 的 Pro/Lite/Turbo 三个成员默认关闭视频输入，原因是当前 Messages 入口拒绝视频内容块；其余能力保持不变。2026-10-27 经确认统一关闭 OpenCode Go Chat 的原生 JSON Schema 声明，模板成员及同站点自建供应商沿用该策略，其他能力和入口不变。2026-10-26 新增 MiniMax M3.1 Flash 的四个入口成员并默认启用；原厂 M2.7 两项及套餐 Preview 默认关闭，删除原厂明确下线的 M2/M2.1 三个成员，精确差异与证据见[M3.1 Flash 规格](./minimax-m31-flash.md)。revision 37 已整理模板品牌顺序；revision 36 已新增八条 Kimi K3.1 Pro/Highspeed，见[K3.1 Pro 规格](./kimi-k3-1-pro.md)。此前的主流供应商、套餐扩展见[实施规格](./expansion-2026-10-15.md)。账号配置与共享模型规则保持不变；下文为 Git 状态，不代表上线或全部真实调用通过。

## 历史问题处置（2026-10-27）

以下结论对应 2026-10-27 批次，不覆盖本次新增 Terra，也不等于全部能力和服务稳定性已验证。

| 项目                         | 当前证据与处置                                                                                                            | 是否阻塞本轮默认配置   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 方舟普通 API 权限与视频      | 四个已开通型号均能调用；Messages 视频统一 400。内置三个日期型号及 Evolving 关闭视频，其余适用用例通过                     | 否，按实际入口收窄声明 |
| GLM-5.3 视频                 | 已确认 Coding Plan 标准版不支持视频，内置站点声明已关闭；图片和 Flash 保持原值                                            | 否，按已确认能力收口   |
| StepFun 3.7 Flash medium     | 新一轮单次复测成功，原始流与产品计数一致：思考 10,567 字符、回答 2,603 字符、总耗时约 86.5 秒。保留三档；旧空回答根因未定 | 否，不因旧失败删档位   |
| Go Chat 原生 JSON Schema     | 经确认统一关闭声明；不扩大为所有模型完全不支持 JSON                                                                       | 否                     |
| GLM MCS、图片与 Go Flash PDF | 修正测试链路或经产品实测后通过；撤回不成立的适配故障判断                                                                  | 否                     |
| Kimi 容量问题                | 按已确认范围暂不追查，不据此删除模型或改变能力声明                                                                        | 否                     |
| Seed Evolving                | 已加入普通 API 内置目录并默认启用，关闭视频；通过其余适用用例，不替换现有日期型号                                         | 否                     |

外部已反馈的问题只有出现新证据或需要产品侧调整时再恢复调查。一次成功可以排除大概率的静态适配问题，但不能证明此前故障根因或长期稳定性。回归工具代码的工程检查与提交收尾独立记录，不把既有无关测试失败解释为供应商不可用，也不把它们隐去或宣称全量验证通过。

## 基线与口径

- 检查日期：2026-11-04。维护基线为 staging `7f3165500d`，产品源码版本 3.17.1；下文为本轮工作分支配置，不表示该版本已发布。
- 正式/测试均为 schemaVersion 1、revision 44；测试文件由正式文件生成。
- 34 个普通 API/套餐模板，10 个固定账号 Provider；模板成员共 315 条，其中默认启用 128 条，包含跨模板重复型号。相对最初 revision 33 累计新增 13 个模板、72 条成员（其中 Preview 已转一般维护）；累计 22 条默认关闭变更，删除 3 条原厂已下线成员。
- Model 规则 83、Model+API 规则 73、正式 Site 规则 58、测试 Site 规则 70、模板精确规则 317、固定 Provider 精确规则 30。
- 正式文件 SHA-256：`2af7b0cac658e9507413f5b1f5f9754e17c18fd29745522592d8b6ae699030ab`。
- 测试文件 SHA-256：`5a2ba4d7bf05eef50b479196a198cbe493c908a75fbc80d3db6d2acd80e459df`。hash 针对 Git 内容（LF）；本地 CRLF checkout 需要按仓库换行归一后比较。

清单直接从[正式 JSON](../../config/provider/zcode-builtin.json)提取。下面的启停是模板精确规则，不包含用户覆盖或实际 Key/权益；存在于列表不等于该入口在本轮已真实验证。

## 模板摘要

| templateId                       | 协议                      | 成员数 | 默认启用数 |
| -------------------------------- | ------------------------- | ------ | ---------- |
| `zai-api`                        | `anthropic-messages`      | 2      | 2          |
| `zai-standard-api`               | `openai-chat-completions` | 25     | 3          |
| `bigmodel-api`                   | `anthropic-messages`      | 2      | 2          |
| `bigmodel-standard-api`          | `openai-chat-completions` | 24     | 2          |
| `moonshot-kimi`                  | `anthropic-messages`      | 8      | 5          |
| `kimi-code-cn`                   | `openai-chat-completions` | 6      | 6          |
| `kimi-code-intl`                 | `openai-chat-completions` | 6      | 6          |
| `minimax`                        | `anthropic-messages`      | 6      | 2          |
| `minimax-m-plan-cn`              | `anthropic-messages`      | 2      | 1          |
| `deepseek`                       | `anthropic-messages`      | 2      | 2          |
| `qwen-alibaba-model-studio-cn`   | `anthropic-messages`      | 13     | 2          |
| `qwen-alibaba-model-studio-intl` | `openai-chat-completions` | 14     | 2          |
| `qwen-coding-plan-cn`            | `openai-chat-completions` | 1      | 1          |
| `qwen-token-plan-team-cn`        | `openai-chat-completions` | 2      | 2          |
| `xiaomi-mimo`                    | `anthropic-messages`      | 4      | 2          |
| `xiaomi-mimo-token-plan`         | `anthropic-messages`      | 2      | 2          |
| `tencent-tokenhub-cn`            | `openai-chat-completions` | 2      | 2          |
| `tencent-tokenhub-intl`          | `openai-chat-completions` | 2      | 2          |
| `volcengine-ark`                 | `anthropic-messages`      | 4      | 4          |
| `volcengine-coding-plan`         | `anthropic-messages`      | 2      | 2          |
| `volcengine-agent-plan`          | `anthropic-messages`      | 2      | 2          |
| `stepfun`                        | `anthropic-messages`      | 2      | 2          |
| `stepfun-step-plan`              | `anthropic-messages`      | 2      | 2          |
| `openai`                         | `openai-responses`        | 13     | 5          |
| `anthropic`                      | `anthropic-messages`      | 8      | 4          |
| `xai`                            | `openai-responses`        | 4      | 2          |
| `siliconflow-cn`                 | `openai-chat-completions` | 3      | 3          |
| `openrouter`                     | `anthropic-messages`      | 70     | 18         |
| `opencode-go-responses`          | `openai-responses`        | 4      | 2          |
| `opencode-go-messages`           | `anthropic-messages`      | 9      | 4          |
| `opencode-go-chat`               | `openai-chat-completions` | 19     | 10         |
| `opencode-zen-responses`         | `openai-responses`        | 17     | 4          |
| `opencode-zen-messages`          | `anthropic-messages`      | 18     | 7          |
| `opencode-zen-chat`              | `openai-chat-completions` | 15     | 11         |

## 完整成员与默认启停

清单直接由正式配置生成。完整能力及参数按[配置规范](./configuration.md)解析，不在本页维护第二套规则。

### zai-api

- Base URL：`https://api.z.ai/api/anthropic`；Access：`zhipu-coding-plan-api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：无。

### zai-standard-api

- Base URL：`https://api.z.ai/api/paas/v4`；Access：`api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`、`glm-5.3-flashx`。
- 默认关闭：`GLM-5V-Turbo`、`GLM-5.1`、`GLM-5.1-Highspeed`、`GLM-5`、`GLM-5-Turbo`、`GLM-4.7`、`GLM-4.7-FlashX`、`GLM-4.7-Flash`、`GLM-4.6`、`GLM-4.5-Air`、`GLM-4.5`、`GLM-4.6V`、`GLM-4.6V-Flash`、`GLM-4.6V-FlashX`、`GLM-4.1V-Thinking-FlashX`、`GLM-4.1V-Thinking-Flash`、`GLM-4-FlashX-250414`、`GLM-4-Flash-250414`、`GLM-4V-Flash`、`codegeex-4`、`charglm-4`、`emohaa`。

### bigmodel-api

- Base URL：`https://open.bigmodel.cn/api/anthropic`；Access：`zhipu-coding-plan-api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：无。

### bigmodel-standard-api

- Base URL：`https://open.bigmodel.cn/api/paas/v4`；Access：`api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：`GLM-5V-Turbo`、`GLM-5.1`、`GLM-5.1-Highspeed`、`GLM-5`、`GLM-5-Turbo`、`GLM-4.7`、`GLM-4.7-FlashX`、`GLM-4.7-Flash`、`GLM-4.6`、`GLM-4.5-Air`、`GLM-4.5`、`GLM-4.6V`、`GLM-4.6V-Flash`、`GLM-4.6V-FlashX`、`GLM-4.1V-Thinking-FlashX`、`GLM-4.1V-Thinking-Flash`、`GLM-4-FlashX-250414`、`GLM-4-Flash-250414`、`GLM-4V-Flash`、`codegeex-4`、`charglm-4`、`emohaa`。

### moonshot-kimi

- Base URL：`https://api.moonshot.cn/anthropic`；Access：`api-key`。
- 默认启用：`kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`。
- 默认关闭：`kimi-k2.7-code-highspeed`、`k3`、`k3-256k`。

### minimax

- Base URL：`https://api.minimaxi.com/anthropic`；Access：`api-key`。
- 默认启用：`MiniMax-M3.1-Flash`、`MiniMax-M3`。
- 默认关闭：`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M2.5`、`MiniMax-M2.5-highspeed`。

### deepseek

- Base URL：`https://api.deepseek.com/anthropic`；Access：`api-key`。
- 默认启用：`deepseek-flash`、`deepseek-v4-pro`。
- 默认关闭：无。

### qwen-alibaba-model-studio-cn

- Base URL：`https://dashscope.aliyuncs.com/apps/anthropic`；Access：`api-key`。
- 默认启用：`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`、`qwen3.5-plus`、`qwen3.5-flash`、`qwen3-max`、`qwen-plus`、`qwen-flash`、`qwen3-vl-plus`。

### qwen-alibaba-model-studio-intl

- Base URL：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`；Access：`api-key`。
- 默认启用：`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：`qwen3.8-omni-flash`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`、`qwen3.5-plus`、`qwen3.5-flash`、`qwen3-max`、`qwen-plus`、`qwen-flash`、`qwen3-vl-plus`。

### xiaomi-mimo

- Base URL：`https://api.xiaomimimo.com/anthropic`；Access：`api-key`。
- 默认启用：`mimo-v2.6-pro`、`mimo-v2.6-flash`。
- 默认关闭：`mimo-v2.5-pro`、`mimo-v2.5`。

### xiaomi-mimo-token-plan

- Base URL：`https://token-plan-cn.xiaomimimo.com/anthropic`；Access：`api-key`。
- 默认启用：`mimo-v2.6-pro`、`mimo-v2.6-flash`。
- 默认关闭：无。

### openai

- Base URL：`https://api.openai.com/v1`；Access：`api-key`。
- 默认启用：`gpt-6-astra`、`gpt-5.6-terra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`。
- 默认关闭：`gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.6`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.3-codex`。

### anthropic

- Base URL：`https://api.anthropic.com/v1`；Access：`api-key`。
- 默认启用：`claude-fable-5-1`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`。
- 默认关闭：`claude-fable-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5-20251001`。

### xai

- Base URL：`https://api.x.ai/v1`；Access：`api-key`。
- 默认启用：`grok-build-0.1`、`grok-4.7`。
- 默认关闭：`grok-4.6`、`grok-4.3`。

### openrouter

- Base URL：`https://openrouter.ai/api`；Access：`api-key`。
- 默认启用：`minimax/minimax-m3.1-flash`、`moonshotai/kimi-k3.1-pro`、`anthropic/claude-fable-5.1`、`openai/gpt-6-astra`、`deepseek/deepseek-v4-pro`、`moonshotai/kimi-k3`、`z-ai/glm-5.3`、`qwen/qwen3.8-max`、`minimax/minimax-m3`、`openai/gpt-6.1-sol`、`openai/gpt-6-luna`、`anthropic/claude-opus-5.5`、`anthropic/claude-sonnet-5.5`、`anthropic/claude-haiku-5.5`、`x-ai/grok-4.7`、`z-ai/glm-5.3-flashx`、`xiaomi/mimo-v2.6-pro`、`xiaomi/mimo-v2.6-flash`。
- 默认关闭：`openai/gpt-5.6-sol`、`anthropic/claude-opus-5`、`xiaomi/mimo-v2.5-pro`、`x-ai/grok-4.6`、`deepseek/deepseek-v4.1-flash`、`qwen/qwen3.8-max-0902`、`openai/gpt-5.6-terra`、`openai/gpt-5.6-luna`、`openai/gpt-5.6`、`openai/gpt-5.4`、`openai/gpt-5.4-pro`、`openai/gpt-5.4-mini`、`openai/gpt-5.4-nano`、`openai/gpt-5.3-codex`、`anthropic/claude-sonnet-5`、`anthropic/claude-haiku-4.5`、`anthropic/claude-opus-4.8`、`anthropic/claude-opus-4.7`、`anthropic/claude-opus-4.6`、`anthropic/claude-opus-4.5`、`anthropic/claude-sonnet-4.6`、`anthropic/claude-sonnet-4.5`、`deepseek/deepseek-v4-flash`、`moonshotai/kimi-k2.7-code`、`moonshotai/kimi-k2.6`、`moonshotai/kimi-k2.5`、`z-ai/glm-5.3-flash`、`z-ai/glm-5.2`、`z-ai/glm-5.1`、`z-ai/glm-5v-turbo`、`z-ai/glm-5`、`z-ai/glm-5-turbo`、`z-ai/glm-4.7`、`z-ai/glm-4.7-flash`、`z-ai/glm-4.6`、`z-ai/glm-4.6v`、`z-ai/glm-4.5-air`、`z-ai/glm-4.5`、`qwen/qwen3.8-flash`、`qwen/qwen3.7-max`、`qwen/qwen3.7-plus`、`qwen/qwen3.7-flash`、`qwen/qwen3.6-plus`、`qwen/qwen3.6-flash`、`qwen/qwen3.5-plus-20260420`、`qwen/qwen3-vl-plus`、`qwen/qwen3-vl-flash`、`minimax/minimax-m2.7`、`minimax/minimax-m2.5`、`xiaomi/mimo-v2.5`、`x-ai/grok-build-0.1`、`x-ai/grok-4.3`。

### opencode-go-chat

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`minimax-m3.1-flash`、`kimi-k3.1-pro`、`glm-5.3-flash`、`glm-5.3`、`kimi-k3`、`kimi-k2.7-code`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`mimo-v2.6-pro`、`mimo-v2.6-flash`。
- 默认关闭：`mimo-v2.5`、`mimo-v2.5-pro`、`glm-5.2`、`glm-5.1`、`kimi-k2.6`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`hy4-preview`、`hy3`。

### opencode-go-messages

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`minimax-m3`、`qwen3.8-max`、`qwen3.8-flash`、`claude-haiku-5-5`。
- 默认关闭：`minimax-m2.7`、`minimax-m2.5`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.6-plus`。

### opencode-go-responses

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`gpt-6-luna`、`grok-4.7`。
- 默认关闭：`gpt-5.6-luna`、`grok-4.6`。

### opencode-zen-responses

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-luna`、`grok-4.7`。
- 默认关闭：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.3-codex`、`gpt-5.3-codex-spark`、`gpt-5.2`、`gpt-5.1`。

### opencode-zen-messages

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`claude-fable-5-1`、`qwen3.7-max`、`qwen3.6-plus`、`qwen3.5-plus`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`。
- 默认关闭：`claude-fable-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-6`、`claude-opus-4-5`、`claude-sonnet-4-6`、`claude-sonnet-4-5`、`qwen3.7-plus`。

### opencode-zen-chat

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`kimi-k3`、`minimax-m3`、`deepseek-v4-pro`、`glm-5.2`、`big-pickle`、`mimo-v2.5-free`、`hy3-free`、`ling-3.0-flash-fin-free`、`nemotron-3-ultra-free`、`muse-spark-1.2-contributor-free`、`mimo-v2.6-flash-free`。
- 默认关闭：`minimax-m2.7`、`deepseek-v4-flash`、`glm-5.1`、`nemotron-3.5-lightning-free`。

### tencent-tokenhub-cn

- Base URL：`https://tokenhub.tencentmaas.com/v1`；Access：`api-key`。
- 默认启用：`hy3`、`hy4-preview`。
- 默认关闭：无。

### tencent-tokenhub-intl

- Base URL：`https://tokenhub-intl.tencentmaas.com/v1`；Access：`api-key`。
- 默认启用：`hy3`、`hy4-preview`。
- 默认关闭：无。

### volcengine-ark

- Base URL：`https://ark.cn-beijing.volces.com/api/compatible`；Access：`api-key`。
- 默认启用：`doubao-seed-evolving`、`doubao-seed-2-1-pro-260915`、`doubao-seed-2-1-lite-260915`、`doubao-seed-2-1-turbo-260628`。
- 默认关闭：无。

### volcengine-coding-plan

- Base URL：`https://ark.cn-beijing.volces.com/api/coding`；Access：`api-key`。
- 默认启用：`doubao-seed-2.1-pro`、`doubao-seed-2.1-lite`。
- 默认关闭：无。

### volcengine-agent-plan

- Base URL：`https://ark.cn-beijing.volces.com/api/plan`；Access：`api-key`。
- 默认启用：`doubao-seed-2.1-pro`、`doubao-seed-2.1-lite`。
- 默认关闭：无。

### stepfun

- Base URL：`https://api.stepfun.com`；Access：`api-key`。
- 默认启用：`step-5-preview`、`step-3.7-flash`。
- 默认关闭：无。

### stepfun-step-plan

- Base URL：`https://api.stepfun.com/step_plan`；Access：`api-key`。
- 默认启用：`step-5-preview`、`step-3.7-flash`。
- 默认关闭：无。

### siliconflow-cn

- Base URL：`https://api.siliconflow.cn/v1`；Access：`api-key`。
- 默认启用：`zai-org/GLM-5.3`、`deepseek-ai/DeepSeek-V4-Flash`、`moonshotai/Kimi-K2.7-Code`。
- 默认关闭：无。

### qwen-coding-plan-cn

- Base URL：`https://coding.dashscope.aliyuncs.com/v1`；Access：`api-key`。
- 默认启用：`qwen3.7-plus`。
- 默认关闭：无。

### qwen-token-plan-team-cn

- Base URL：`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；Access：`api-key`。
- 默认启用：`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：无。

### kimi-code-cn

- Base URL：`https://api.kimi.com/coding/v1`；Access：`api-key`。
- 默认启用：`k3.1-pro`、`k3.1-pro-highspeed`、`k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`。
- 默认关闭：无。

### kimi-code-intl

- Base URL：`https://api.kimi.ai/coding/v1`；Access：`api-key`。
- 默认启用：`k3.1-pro`、`k3.1-pro-highspeed`、`k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`。
- 默认关闭：无。

### minimax-m-plan-cn

- Base URL：`https://api.minimax.cn/anthropic`；Access：`api-key`。
- 默认启用：`MiniMax-M3.1-Flash`。
- 默认关闭：`MiniMax-M3.1-Flash-Preview`。

## 相邻固定账号配置

本轮维护主题是普通模板；固定账号 Provider 与其共享 Release 和模型规则，因此统计而不复制账号系统说明。Z.AI / BigModel 各有个人、团队、Start、闲时、加速卡，共 10 个固定 Provider。测试生成器覆盖这五种产品路径涉及的正式端点映射。

## 已知差异和后续项

| 项目               | 已确认事实                                                                                                                                             | 处理边界                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 默认基线简化       | revision 32 已实现百万窗口/128000 最大输出基线、简化匹配及两条规则删除                                                                                 | 取舍及兼容边界见[匹配与简化](./configuration.md#匹配与简化)，不再作为待实施事项              |
| 清单漂移           | 旧维护清单部分型号、默认启停与本节不同；如普通 GLM 模板的 GLM-5V-Turbo 当前默认关闭                                                                    | 不按历史星号自动改配置；改启停另提行为 MR                                                    |
| 脱离静态成员的规则 | zai-api/bigmodel-api 各有 GLM-5-Turbo 默认关闭规则，但不是当前模板成员；四个个人/团队 Provider 各有 GLM-5.2 与 GLM-5-Turbo 精确规则，超出其静态成员    | 先核对个人同 ID 模型、动态成员与历史用途，不能直接判为孤儿删除                               |
| 历史移除意图       | 原厂 M2/M2.1 三项已按下线清单移除；M2.5/M2.7 宽限与 Preview 转发分别记录                                                                               | 仅原厂确认范围移除，聚合旧成员不受影响                                                       |
| MiMo 双产品入口    | revision 33 已包含 `xiaomi-mimo` 普通 API 与 `xiaomi-mimo-token-plan` 套餐模板；revision 35 两者均默认启用 V2.6 Pro/Flash；普通 API 的 V2.5 已默认关闭 | 已合入 staging；本轮按代码与测试核验，不等于两个产品的真实 Key 调用或线上采用已验证          |
| 新供应商/云入口    | TokenHub、方舟、StepFun、SiliconFlow 及套餐已落配置；Google 原生、Mistral 适配暂缓；Azure/Bedrock 待具体资源身份                                       | 符合范围与现有能力的新增可直接推进；Google 直连暂缓，协议/认证缺口另行讨论，候选不等于已验证 |
| 官方目录新变化     | 累计新增 70 条成员，其中 Preview 已转为默认关闭；其余型号、地区及套餐按入口继续核验                                                                    | 见[研究记录](./research.md)，新增配置及未验证边界见本轮实施规格                              |
| 线上状态           | 2026-10-26 测试控制面已下发 revision 36，3.16.2 Preview 的 Active 与日志确认采用成功；revision 37–43 尚未确认发布                                      | 正式环境未发布本次排序；后续交付分别核验两环境 revision/hash                                 |

## 验证状态

2026-10-28 revision 43：TokenHub 地域命名先由旧配置触发 4 项失败，修正后配置专项 86 项通过；受影响单测 78 文件、1444 项通过。G149-01 在 Linux Electron 中完成三个 Go 协议的创建、完整成员对账和假 Key 保存；同时修正英文获取 Key 按钮的旧大小写断言。根类型、E2E 类型、Lint、架构、格式及两环境生成同步检查通过。两份配置的 17 个 Logo key 均有本地素材，沿用深色缺省使用浅色素材的既有规则；没有恢复已退役的 Logo 单测文件。未调用计费模型或发布配置。

revision 37 排序专项：正式/测试同步检查通过；供应商配置、排序、旧内容保护及个人配置相关 7 个文件、156 项测试通过。与 revision 36 的完整结构比较确认只有模板块顺序及 revision 改变。类型检查、Lint（191 条既有 warning、0 error）与架构检查通过。未执行 UI E2E 或发布 revision 37，线上观察仅对应 revision 36。

revision 38 的测试与验证结果见[M3.1 Flash 规格](./minimax-m31-flash.md#验证与交付)。完整内容保护已接续到 revision 37 基线，只放行本次四新增、三删除、三启停；历史行为测试继续保留。

此前扩展的结构、完整成员清单和两环境派生关系按当时配置对账。专项测试覆盖累计新增 58 条成员的最终能力和各档 Map、模板实例、个人覆盖及套餐隔离；旧配置摘要仅放行显式新增、已批准的 19 条默认关闭和受影响成员稳定分组。实际命令结果与未验证项统一记录于[本轮实施规格](./expansion-2026-10-15.md#验证结果)。

早期扩展未取得 Key。本轮已观察到 Kimi 开放平台标准版真实请求成功及后续上游过载，尚未完成各入口的完整 Agent、档位、媒体和桌面/手机验收；单次成功不能推广为所有入口实测通过。排序变更只复验配置，不新增模型请求。后续按[验证规范](./validation.md)补齐凭据、产品权限、流式、工具回传、每档思考和媒体证据。

## 重新核对清单

从仓库根执行下面的只读命令，打印当前成员与对应精确规则；同时检查正式/测试派生，不把旧文档当作配置源：

```bash
node --input-type=module - <<'JS'
import { readFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('config/provider/zcode-builtin.json', 'utf8'));
const rules = release.config.modelConfigRules.templateModelRules;
for (const template of release.config.providerConfigRules.templateRules) {
  console.log(template.templateId, template.config.api);
  for (const modelId of template.config.builtinModelIds) {
    console.log(modelId, rules.filter(rule =>
      rule.templateId === template.templateId && rule.modelId === modelId));
  }
}
JS
pnpm provider:config:check-test
```
