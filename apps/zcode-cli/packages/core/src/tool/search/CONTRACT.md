# 工具发现

登记现有搜索 schema、ToolSearch/DeferredToolCall 入口和请求投影，保持既有调用路径。

- `ToolSearch` 是唯一执行身份，Local 请求名称为 `LocalToolSearch`；权限和调度由原执行器负责。
- 原始历史及 compact 元数据是发现状态来源；投影只派生当前请求，不增加共享状态。
- 请求重试复用已准备结果；新请求按当前模式配对投影调用、结果、引用和公告。
- 搜索仅返回目录中的名字，不执行目标工具；关键词不按用户提供的正则表达式解释。
- 实时目录通过 `ToolSearchExecutionContext` 读取，不修改并行批次 registry；连接与配置生命周期归 MCP。
- 旧名称增量保持严格三数组合同；MCP 状态使用独立 metadata 扩展并单独校验。

规范见 [ToolSearch spec](../../../../../docs/design/v2/tool/19-tool-search.md)。
