# Conversation materialization

本模块从已有 ProductProjection 生成可传输视图，并在未发布的候选投影上执行批量 hydration。它不拥有 session、订阅、accepted queue、delta 日志或时钟，也不执行 IO。

- publisher 保留唯一投影引用、订阅 registry、保留日志、帧 reservation 和背压水位。
- wire snapshot、rows/range 与 plans 读取同一份投影快照；行过滤、尾窗及游标语义保持原合同。
- admission 测量构造临时候选 QueueItem，只返回字节数，不接纳输入。
- hydration 只能修改调用方明确传入的未发布候选。返回字节数表示可提交；返回 null 表示必须丢弃候选并沿原严格重放路径重建。
- 16 MiB 上限、terminal reserve、批量 actions 预留和真实 UTF-8 测量保持不变。
- publisher 的公开 class、导入路径及导出函数兼容；本模块不产生新的运行状态 owner。
