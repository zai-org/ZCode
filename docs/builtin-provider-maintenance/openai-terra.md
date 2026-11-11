# OpenAI GPT-6.1 Terra 配置维护

## 范围与依据（2026-11-04）

正式与测试配置升到 revision 44。只在 `openai` 模板新增 `gpt-6.1-terra`，默认启用，放在 `gpt-6.1-sol` 与 `gpt-6-luna` 之间。已有成员顺序、默认启停和个人覆盖保持原样；不替换 `gpt-5.6-terra`。OpenRouter、OpenCode 等入口需要各自的上架与协议依据，本次不扩展。

[Terra 官方模型页](https://developers.openai.com/api/docs/models/gpt-6.1-terra)声明上下文 1,050,000、最大输出 128,000、文本和图像输入、结构化输出；工具调用要求 Responses API。思考档位为 `none / low / medium / high / xhigh / max`。PDF 使用现有 Responses 文件输入链，依据[官方文件输入说明](https://developers.openai.com/api/docs/guides/file-inputs)；不声明音频或视频。上述为官方能力依据，不是本项目真实调用结果。

模板保持 `https://api.openai.com/v1` 与 `openai-responses`，无需新增协议、SDK 或认证适配。通过精确 `templateId/modelId` 规则声明能力，思考档位映射到 `reasoning.effort`，输出预算映射到 `max_output_tokens`。沿用产品以最高公开档位为默认值的行为，不修改公共预算、截断续写或错误处理。

`gpt-6-luna` 已在 revision 43 的 OpenAI 模板中默认启用。本次保留其配置，仅将其与 Terra 一起加入待执行回归清单。用户模型列表或报错摘要不能证明已加载哪个 revision，也不能证明参数不兼容；本次不据此记录故障根因或修复结论。

## 验证范围

目前真实 API 回归优先覆盖实际流量靠前且具备凭据的 Provider；不因缺少其他入口的实测而阻止符合接入范围的配置维护。流量名单由维护者提供，不能根据供应商品牌热度猜排名。该原则的完整要求见[验证规范](./validation.md#真实验证的优先级)。

本次 OpenAI **未进行真实 API 调用**，不记录模型可用、性能或 Agent 闭环通过。维护两份无密钥文件：

- [OpenAI 测试 Provider 示例](../../config/provider/regression/providers.openai.example.json)：引用当前正式内置配置，Key 为空，复制到私有目录后才填入凭据。
- [OpenAI 待执行清单](../../config/provider/regression/test-list.openai.json)：Luna、Terra 各覆盖文本、工具、图片、PDF、结构化输出、输出预算，以及同一道架构题的六个思考档位；每项 1 pass，串行执行，不设额外的全局输出上限。

图片为纯红色方块，PDF 含固定标记 `ZCODE-PDF-42`；素材随清单维护，不依赖私人文件。执行器复用 ZCode 产品链；该清单不是已经执行的报告，也不自动加入当前优先回归清单。连接探测的行为没有变更，不用 OUTPUT-001 代替设置页面连接测试。

配置交付前完成以下离线检查：

1. 正式/测试 Release 均通过产品 Decoder 与 Resolver；测试配置由现有生成脚本派生。
2. 两个模型的思考档位及预算通过现有 Option Map 编译与求值；Terra 能力与官方声明一致。
3. 已有 Provider/模型配置保持一致；用户明确设置的输出预算和思考档位仍优先于内置值。
4. 测试清单能被现有配置加载器读取，引用的模型、用例和素材有效；缺 Key 明确标记未测。

上述只证明配置与测试准备完成，不证明用户反馈已修复，也不代表 revision 44 已上线。

2026-11-04 离线检查结果：两环境均通过产品配置加载器、Decoder/Resolver、六档 Option Map 与个人覆盖检查；移除新增 Terra 条目并还原 revision 后，JSON 与维护基线完全一致。24 项清单能展开，两个模型均被识别为缺 Key。正式/测试生成一致性、27 项生成与构建工程用例、Lint、架构、格式和文档链接检查通过。此次只修改配置与文档，没有执行真实 API、整套类型检查或桌面 E2E；流量优先清单仍需维护者提供实际范围。
