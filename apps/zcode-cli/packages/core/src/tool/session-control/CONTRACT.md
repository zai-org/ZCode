# 会话控制工具边界

可信启动装配注入 `SessionControlBinding`。CLI 与 App 分别使用核心包的 facade、输入 schema 和结果 schema。工具只做校验、调用与结果映射，不访问存储、网络或 runtime 实现。

```text
启动绑定 → 根 runtime → registry / executor → 工具 → 核心 facade → 生产端口
```

工具名不带运行位置前缀：独立 CLI 注册共有 8 个（ListSessions、ReadSession、CreateSession、ForkSession、SendToSession、WaitSessions、InterruptSession、RenameSession），App 另注册 ListProjects、OpenSession、SetSessionArchived、SetSessionPinned。同名工具按可信绑定选择 CLI 或 App 变体（`sessionControlToolsByKind`），首次装配与分支刷新使用同一个 runtime 记录的运行位置，不回落到另一种。权限规则名为 `session_control.<method>`。指向已有会话的参数可传完整引用或 `sessionId`。模型不能选择来源、调用者或授权范围。handler 再次核对根 session 与 runtimeScope；子代理不注入控制权。

全部工具 deferred 并有 searchHint。读取和 wait 为 readOnly / none；其余为 system 且 needsApproval，由现有 executor 权限流程裁决。结果预算 32 KiB，超限走 artifact。取消 wait 不停止目标；可能已接纳的写请求必须使用原 requestId 对账。

测试入口为 `packages/core/tests/session-control/tools.test.ts`；同目录 contract.test.ts 验证有限集合。
