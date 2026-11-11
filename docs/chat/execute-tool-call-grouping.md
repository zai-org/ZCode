> 已退役：会话工具聚合能力已移除。当前行为见 [Tool Display Rendering](../ui/tool-display-rendering.md)。下文仅保留设计历史。

# Execute 工具分组

## 发布状态

功能当前用户设置默认开启。Settings 中的“分组终端命令”持久化为应用级
`toolGroupingTerminalEnabled`；缺失时由 `ENABLE_TERMINAL_TOOL_CALL_GROUPING=true` 兜底。关闭时非只读
Shell 保持原始独立工具行，分类、command、output/error、协议和 session 持久化均不改变。

## Feature Summary

| Field                 | Value                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Change                | 聚合连续非只读 Shell，并让 `Execute` 父级使用可见阶段边界和滚动 command 摘要                           |
| User-visible surfaces | 桌面 `desktop-continuous`、普通 Web、手机 `/remote` 的 `web-remote-replayable` conversation work items |
| Existing behavior     | 只读 Shell 进入 `Explore`；其他连续 Shell 聚合为 `Execute`                                             |
| State owner           | CLI v4 projection 持有原始 `ToolCallRow`；renderer 派生分组、摘要与父级状态                            |
| Out of scope          | 不修改协议、工具执行、permission、session 持久化、snapshot、relay/main 或 runtime                      |

## Clarification Log

| Round | Question         | User answer                                | Boundary fixed                                                                                    | Follow-up needed |
| ----- | ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------- |
| 1     | 第一版范围       | 先修改第一版                               | 只聚合未被 Explore 吸收的连续 Shell；不包含 Write/Edit/ApplyPatch                                 | no               |
| 1     | 父子 summary     | 父级负责整体进度和统计，子级保留单命令摘要 | 运行中父级显示最新命令；结束后显示命令数及失败/停止计数                                           | no               |
| 1     | 父级终态         | 参考 Explore                               | 父级是 UI 容器；子项失败不把父级标成 failed                                                       | no               |
| 2     | 父级运行态与摘要 | 使用 Explore 的阶段边界判断，同时需要滚动  | 位于 running segment 可见尾部时保持 in_progress；运行中滚动最新 command，阶段结束立即收敛最终统计 | no               |

## Boundary Decisions

| Boundary   | Decision                                                                                                                                                                                              | Includes                                            | Excludes / prunes                                                  | Source                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| 分类       | `identity.family === "shell"` 且 `isExploreToolCall(...) === false`                                                                                                                                   | Bash/Shell/execute 的非只读或未命中只读白名单命令   | Read/Search/Explore、Write/Edit、Agent、Todo、blocking interaction | user + current code           |
| 连续性     | 只聚合用户当前可见 row 序列中的连续 Execute                                                                                                                                                           | 隐藏的非首条 reasoning 可跨越                       | 可见 reasoning、Explore、文本及其他工具均截断                      | existing Explore contract     |
| 状态       | Execute 位于 running work segment 的可见尾部时父级 `in_progress`；出现可见边界或 segment 终态后 completed/stopped                                                                                     | children 全部完成后的模型间隔                       | 子项生命周期不再决定父级 running；error 不冒泡 failed              | user + Explore stage contract |
| 摘要       | 运行阶段纵向滚动完整的 `Running <command>`；样式与 Explore 对齐，动作词使用 `text-foreground-subtle`，command 使用 `text-foreground-subtlest`；`Execute` 与摘要之间固定显示 `·`；阶段结束立即显示统计 | `Execute · Running <command>`、`Execute · N 个命令` | stdout/stderr 和具体错误只留在子项；不在终态补播旧 command         | user                          |
| Permission | permission dialog 继续渲染单条 Execute                                                                                                                                                                | conversation work item 聚合                         | 不聚合审批身份                                                     | architecture invariant        |
| 分组标题   | 父分组使用跨平台类别名 `Terminal` / `终端`                                                                                                                                                            | PowerShell、cmd.exe、Git Bash、WSL、Unix shell      | 不指代 Windows Terminal 应用；单条 Execute 子工具文案不变          | user                          |

## State And Event Flow

```text
ToolCallRow(shell)
        |
        +-- nonterminal + command absent --> defer render
        |
        `-- command classifiable
                 |
                 +-- readonly/explore --> Explore group
                 |
                 `-- other shell ------> Execute group
                                                |
                                  append while next visible row
                                  is also Execute-compatible

Execute parent status
        |
        +-- visible group tail + segment running ------> in_progress
        +-- visible boundary / segment terminal
        |       `-- any cancelled ---------------------> stopped
        `----------------------------------------------> completed
```

`Execute` 父节点不是协议工具调用，也不对应一次工具执行。它的 key 和合成 tool id 锚定首个子
`ToolCallRow`，流式追加后只更新 children，避免组件重建和展开状态丢失。

## Summary Contract

### Parent

| State                  | Primary summary                                                                  | Status |
| ---------------------- | -------------------------------------------------------------------------------- | ------ |
| running                | `Running <command>`；children 均终态时回退最新 command，并对完整动作摘要纵向滚动 | 执行中 |
| completed, all success | `N 个命令`                                                                       | 已完成 |
| completed, failures    | `N 个命令，M 个失败`                                                             | 已完成 |
| stopped                | `N 个命令，K 个已停止`，同时保留失败计数                                         | 已停止 |

父级不展示 stdout、stderr 或具体错误。失败详情继续由对应子工具卡展示，避免父子重复失败状态。

### Child

子项继续使用 `ExecuteToolCallBlock`：收起态显示执行动作和 command；展开态显示 `$ command`。
父组进行中展开时，父 summary 只显示 `Terminal · N commands`，当前命令由下方子 tool summary 表达。
以及结果或错误；无输出的终态显示既有“无输出”文案。

## Pruning Decisions

| Decision ID | Pruned combinations                   | Guard/invariant                                              | Representative coverage      |
| ----------- | ------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| ETG-P01     | Bash/execute/shell 工具名全排列       | `resolveToolCallIdentity` 已统一为 Shell family              | family 代表单测              |
| ETG-P02     | Write/Edit/ApplyPatch 与 Execute 混合 | file-write 进入独立 Changes 组，仍保留原始文件摘要和撤销语义 | 边界单测                     |
| ETG-P03     | theme/locale/OS/workspace 类型全排列  | 共享 renderer + i18n；不读平台或 workspace 状态              | zh/en 文案与 focused UI test |
| ETG-P04     | continuous/replayable 物理网络排列    | 分组只消费最终 UI rows，不修改 transport                     | renderer unit + 既有 STIP03  |
| ETG-P05     | permission/approval 组合              | PermissionDialog 不经过 conversation 分组构建器              | 既有 permission tests        |

## Accepted Cases

| Case ID | Setup                                             | Action                              | Assertions                                                                 | Evidence layers           | E2E status   |
| ------- | ------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- | ------------------------- | ------------ |
| ETG01   | 单条非只读 Shell                                  | 构建 work items                     | 保持原始 Shell 工具行，不创建单 child 父组                                 | UI unit                   | covered-unit |
| ETG02   | 连续至少两个非只读 Shell                          | 流式追加 rows                       | 第二项到达后生成父组，保持同一父 key/tool id，children 顺序不变            | UI unit                   | covered-unit |
| ETG03   | Execute 两侧出现 Explore/文本/可见 reasoning      | 构建 work items                     | 分成多个组，不跨可见边界                                                   | UI unit                   | covered-unit |
| ETG04   | Execute 两侧只有被隐藏的非首 reasoning            | 关闭 reasoning                      | 合并；开启 reasoning 时拆分                                                | UI unit                   | covered-unit |
| ETG05   | Shell command 尚未到达                            | 先构建，再补 readonly/other command | 首帧隐藏；之后只出现 Explore 或 Execute 中的一种                           | UI unit                   | covered-unit |
| ETG06   | Execute 是 running segment 的真实可见尾部         | children 全部完成或继续追加 command | 父级保持 in_progress；新增 command 摘要纵向滚动                            | UI + renderer unit        | covered-unit |
| ETG07   | Execute 展开                                      | 渲染父组                            | 子项继续显示 command、output/error                                         | renderer unit             | covered-unit |
| ETG08   | desktop/replayable 恢复得到相同最终 rows          | 构建 work items                     | 分组结果一致，不新增恢复状态                                               | shared renderer invariant | partial      |
| ETG09   | Execute 后出现可见非 Execute row，或 segment 终态 | 构建 work items                     | 父级 completed/stopped；child running 仍只在明细展示；终态立即显示聚合统计 | UI + renderer unit        | covered-unit |

## E2E Handoff Notes

- 第一版核心为 deterministic row-to-render-item 和 renderer summary，使用 focused unit tests。
- 若晋升正式 E2E，controlled-stream fixture 应依次发送两条非只读 Bash，并在中间插入可见/隐藏
  reasoning，断言父 group identity、summary 和展开后的两条命令。
- 手机 `/remote` 不用 desktop fixture 冒充 replayable 证明；沿用 STIP03 的最终 row 恢复合同。
