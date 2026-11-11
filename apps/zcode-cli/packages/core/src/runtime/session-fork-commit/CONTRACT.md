# Session fork commit

依据 [会话工具设计](../../../../../../../docs/architecture/zcode-app-control-design.md) 中的稳定分叉与单 owner 规则。本次是纯职责重构，保留现有行为、运行时 owner、数据库事务、消息身份和事件顺序，不增加产品操作、协议字段或配置。

`methods/session-fork.ts` 负责 runtime 入口、active transcript 与稳定目标选择，以及既有 legacy checkpoint fork。此模块负责已选历史的 child-local 身份预分配、模型/Goal/verifier/notice 构建、完整 bundle 的权限检查与一次提交。`buildAtomicConversationForkBundle` 提供无 I/O 的同步规划器，供 SQLite 在事务内复用同一规则。公开入口为 `index.ts`，类型入口为 `contract.ts`；旧方法文件转发 `createForkIdentityMap`、`buildAtomicForkNotice`，原调用方与测试继续使用原路径。

```text
原 runtime 选择稳定历史 → commitAtomicConversationFork
  → 预分配 child 身份 → 构造完整 bundle → 检查同一份 permission/execution
  → sessionStore.commitForkBundle（唯一持久化边界）
  → parent fork event（提交后 best effort）→ 以 store 返回 child ID 报告结果
```

- 唯一 owner 仍是调用该方法的 AgentRuntime，模块不创建 runtime、队列、registry 或幂等账本。
- atomic stable、compact-edit 继续使用 `commitForkBundle`；selection-side 使用 `commitForkFromSource`，在同一事务内读取轻量元数据并调用同步规划器，正文通过 SQLite 批量复制；三者共享同一 bundle 校验与提交实现；legacy child-only 持久化仍留在旧入口，不经过原子模块。
- stable fork 继承原固定边界的模型、权限模式和 Goal 快照；selection side chat 不复制 Goal 运行态。Highspeed 临时模型不变成 child 常驻选型。
- App control 命令前缀只施加额外限制：同一待提交 bundle 含会话权限规则、非 build 权限模式或 Plan 状态时抛出带 `guard.appControlForkPermissionUnsafe` 的错误，不提交 child。它不提供身份或权限，也不改变普通 UI fork 合同。检查到提交之间无额外 await，不先检查再从另一份历史复制权限。
- `commitForkBundle` 成功是不可逆提交点：父事件失败不反转成功，去重返回的 child ID 是后续事件及结果的身份来源。原错误与日志语义保持。
- 完整 bundle 另带两项：父会话 prompt 快照的副本（session entry，见 [prompt 快照](../../../../../docs/design/v2/loop/prompt-snapshot.md)）；父会话最近一次环境公告带 Gen UI 目录、或 fork 到另一个 cwd（受管 worktree）时，在复制的消息之后、fork 提示之前写入一条子会话的环境更新：目录换成子会话的（按子会话的 cwd 计算），Desktop 段按当前运行面重新取，cwd 变化时写出新的工作目录（见 [Gen UI 输出目录](../../../../../../../docs/specs/gen-ui-output-directory.md)）。两项都由同步规划器生成，随同一次 `commitForkBundle` 或 `commitForkFromSource` 提交。
- `builders.ts` 集中原 child metadata、身份映射、notice、结构化错误与 JSON record 解析，供 atomic 与 legacy 两条原有入口复用，不建立另一套业务规则。

验证保留原 Core session-fork 31 项与 bootstrap gateway fork/edit/retry 36 项，另运行本模块契约测试和真实 App + SQLite 安全 guard 证据。所有源文件正常执行行数与依赖门禁，不增加 lint 豁免。
