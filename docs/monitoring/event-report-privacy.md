# `/event/report` 登录地址与错误正文隐私边界

## 目标与取舍（2026-09-18）

旧实现将完整 OAuth authorizeUrl 写入 `app_login_ck.login_url`，并允许任意事件的
`error_msg` 原文进入 HTTP body；自动化的局部正则会漏掉 Bearer 后的值和未知格式密钥。
用户确认首期优先隐私：不加密上传错误原文，不依赖正则猜测哪些片段是秘密。

- 保留 `login_url` 字段名，仅发送 HTTP(S) URL 的小写 hostname，去掉 userinfo、端口、
  路径、query 和 fragment。无效或非 HTTP(S) URL 返回空串；已规范化 hostname 可重复处理。
- **所有事件**的 `event_extra_detail.error_msg`：非空字符串统一为 `[redacted]`；空串保持空，
  原本缺失的字段不新增。包括当前 conversation/automation 及未来新增事件。
- 对话事件保留既有 `error_type`；自动化创建失败补齐固定 `error_code`：
  `limit` / `timeout` / `network` / `auth` / `validation` / `unknown`，成功为空。
  在本地按此顺序识别已知错误码/模式；未知或缺失文本归为 `unknown`，只提供粗粒度归因，
  不回传匹配内容、不承诺恢复原文的全部诊断能力。状态、耗时和关联 ID 保持不变。
- `agent_step.error_code`（2026-11-17）：工具失败原因码，本地按白名单把 CLI 的错误码归一成
  CoreErrorType 小写值 / `h<数字>` / `other` / `unknown`，出网前再按同一白名单兜底；不带错误原文。
- `workflow_run_result`（2026-11-18）：只带 run 终态与停止原因的白名单值、子代理数和 ID；run-settled fact 的
  `errorMessage` 不进事件。
- 处理只作用于 telemetry 副本，不改 OAuth 浏览器地址、登录 state、工具结果或业务错误展示。
- UI 上报前与 Core 序列化前使用同一个纯函数；函数幂等、不修改调用方对象。
  agent_step/message_completion 调试 payload 只记录已清洗副本，改用 debug。
- 认证请求头 Authorization 仍用于正常鉴权，不移除或复制进 JSON；与错误正文的删除是两回事。

## 链路与兼容性

```text
OAuth 原 URL -> 浏览器（原值）
           `-> login_url hostname -> UI sanitize -> IPC -> Core sanitize -> POST
其他 UI 事件 -> error_msg [redacted] -> 同一链路
Host/Main 事件 ---------------------------------> Core sanitize -> POST
```

共享实现不依赖 Node、文件系统或平台 API。Windows/macOS/Linux 的路径、任意 URL、
Authorization 值、密钥（含多行 PEM）都随着非空错误正文整体移除。
Desktop continuous 和手机 web-remote-replayable 的订阅、队列、恢复、消息归属不改；
手机仍只转发既有 strict session_create。主题、语言和 UI 交互不改。
本期范围是 `/event/report` 的 login_url/error_msg；不扩展到 ARMS、OTLP、compaction.reason、
模板正文、`event_text` 或其他业务字段。既有服务端历史数据不由此客户端修复清除。

## 验收

先用旧代码运行新增用例确认失败，再验证：登录完整 URL 只用于 openExternal；
UI reporter/调试日志和直接调用 Core 的最终请求体都没有错误原文；空/缺失/重复清洗语义稳定；
未来未知事件同样清洗；原对象不变；网络重试复用清洗后的 body 和 event_id；正常 Authorization
header 保持；以本机受控 HTTP 接收器验证实际收到的 body 不含合成敏感标记。
运行相关单测、pnpm typecheck、pnpm lint；未覆盖的真实 Electron/手机/跨 OS 实机记录在提交说明。

## 验证记录

- 新增回归先在旧实现上运行：33 项失败，涵盖原 URL、原错误正文、日志和最终 HTTP body。
- 修改后相关 15 个测试文件、202 项通过，含真实本机 HTTP 接收器、重试 body、
  正常鉴权 header、OAuth 原地址、父/子代理、workflow、自动化、手机 session_create 边界。
- macOS + Node 24.14.0 执行；没有真实账号、生产网络上报或真实用户隐私样本。
- Windows/Linux 路径作为输入用例覆盖，未跑 Windows/Linux 实机、真实 Electron 登录或手机浏览器 E2E。
- architecture:check 通过；shared/ui/services 是当前策略的 legacy/unmanaged 模块，
  通过不等于自动证明其全部运行时边界。共享清洗是无 I/O 的纯函数，未改变业务状态 owner。

完整 `pnpm typecheck`、`pnpm lint`（55 条非本次修改文件警告，0 errors）、
修改文件 oxfmt 检查与 `git diff --check` 通过。

## 字段表与报表迁移

- [业务监控 agent_step / message_completion 字段表](business-monitoring.md)：使用 `error_type` 聚合失败，不再按 `error_msg` 原文聚类或搜索。
- [自动化消息 telemetry 字段表](automation-message-telemetry.md)：同一错误正文隐私语义。
- [性能 telemetry 目录](performance-telemetry-catalog.md)：这里只约束 `/event/report` 的字段，不扩大到 ARMS/OTLP。
- [定时任务管理上报](../ui/scheduled-tasks-main-view.md)：`automation_create_result` 原来的 `error_code` 恒空；本次补齐分类，报表使用该字段。分类覆盖需单独看 `unknown` 比例，不能把未知分类当成功。

修复审查 CR-01/CR-02：先同步以上既有 spec，再以实际 reporter 的失败/成功上报验证分类及隐私；缺少错误信息的失败也必须发出 `unknown`，成功不得携带过期错误分类。
