# 12 · 排障

## 先收集最小证据

保存 `--version`、`doctor --json`、构建提交或产物 SHA-256、完整参数数组、有效工作目录、退出码、signal、stdout、stderr，以及脱敏的配置。先用隔离环境复现，避免改动日常开发的配置和会话。

## 启动或配置失败

- `Unknown option`：参数不属于该构建。确认是否把其他 CLI 的 `--model`、`--settings`、`--max-turns` 等参数带进来了；新源码的参数也可能尚未进入旧产物。
- 模型缺失或改配置无效：检查个人 provider 文件、默认模型选择、API 类型和 Key；已迁移的源码构建不会每次重读旧 `model/provider` 设置。见[配置](03-config.md)。
- 配置部分被忽略：检查 JSON 语法和字段诊断。MCP、Hook 等字段有独立校验，不要将所有问题归为凭据错误。
- 构建能启动但资源缺失：保留 bundle 相邻资源，确认依赖和准备步骤完整；`doctor` 不会验证全部插件、模型或外部程序。
- 平台或执行失败：核对 CPU 架构、系统版本和执行权限。Windows 使用 `.exe`；外部 Hook/MCP 依赖另行安装。

## 工具没有产生结果

- `… requested permissions to use <Tool>, but you haven't granted it yet.` 或 `No permission client configured`（guarded 模式）：本次调用需要审批，但 prompt 没有交互客户端。检查模式、工具及 Hook 决策。
- 只输出计划：检查是否触发了计划模式；无人值守任务按[工具配置](04-tools.md)移除不需要的计划和提问工具。
- 项目 Hook 不执行：检查 enabled、matcher、信任状态和事件是否自然发生；信任后不会补跑已跳过的 SessionStart。
- 插件清单为空：检查插件总开关、资源准备与诊断。当前版本可直接 list，不要求先发模型请求。
- MCP 注册后调用失败：分别检查服务鉴权、协议、外部依赖、权限和超时；模型列出的工具名不构成执行证据。

## 输出与运行记录

`/help` 等本地命令可能返回文本，不能用它验证普通 prompt 的 JSON 结构。`stream-json` 应逐行解析并检查最终 result 行。异常退出、被取消或输出被截断时，不要拼出一个虚假的成功结果。

调试日志可能包含任务文本、路径、工具输出和模型请求。默认 model-io 日志存在压缩、裁剪和保留上限；缺失历史不能从摘要中恢复。见[运行记录与训练轨迹](13-automation.md)。

轨迹转换出现 `model-io request.body must contain a messages array.` 时，检查原始记录是否保留了 `request.body.messages`。本次对当前默认日志已复现该错误；不能把转换失败的文件作为完整训练样本，也不能用另一层的消息结构强行补齐。需要完整数据时，在采集端保留实际 provider 请求和响应。

提交问题时提供最小可复现任务和脱敏证据。删除 API Key、登录 token、Cookie 和私人内容；保留字段结构、错误码和必要的工具结果。
