# CUA AX 动作回执与按需观察契约

## Feature Summary

| Field            | Value                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Developer intent | 让 ZCode consumer 只消费 producer 的动作回执，避免在 consumer 侧维护第二套 post-state 屏障        |
| Capability       | Computer Use action receipt authority                                                           |
| Change layer     | result projection / retry safety / media authority                                               |
| Operating mode   | planning + implementation-handoff                                                               |
| Primary seeds    | Core MCP bridge、tool result serialization、media budget、official CUA bundled skill/provenance |
| Out of scope     | conversation session 状态语义、remote owner/queue、Windows/Linux native 读回、人工接管 UI       |

当前 consumer 契约不再要求 action outcome 与 post-state 原子配对。producer 只通过公开
MCP result 暴露 `action_receipt`；ZCode 不镜像 AX native 实现，也不在 consumer 侧合成
`refresh_required` 或 post-state。

## 状态与时序

```text
模型持有 s-N
    |
    v
element write -> producer native dispatch
    |                |
    | not_sent       +-- accepted / possibly_sent
    |                |          |
    |                |          v
    |                |   action_receipt only
    |                |          |
    |                |          +-- model needs UI? -> explicit get_app_state -> s-N+1
    v                v
action_sent=false   never replay from native error

zcode-cua MCP result -> official authority gate
    |
    +-- image_ref + image: final-raster protection remains special and fail-closed
    +-- action_receipt/text/structuredContent: generic MCP result projection and budget
    +-- hooks: may append ordinary bounded context after receipt text
```

## Consumer Contract

- 模型判断动作派发只看 `action_receipt.action_sent`、`dispatch_status` 与
  `retry_action`；不得从 native success/error 或整棵 AX tree 变化猜测业务成功。
- `dispatch_status="possibly_sent"` 与 `retry_action=false` 必须原样保留；同一非幂等动作
  不得自动重放。
- 动作后没有隐式 post-state。需要 UI 事实时由模型显式调用 `get_app_state`，并使用新
  `state_id` 继续操作。
- official CUA receipt、普通文本和 structuredContent 走通用 MCP formatter、resultBudget
  与 hook 追加路径；consumer 不再校验 matching post-state，不再合成 `refresh_required`。
- 图片仍遵守 final-raster `image_ref + image` 原子契约。媒体预算移除图片时必须连同
  image_ref 一起移除；不得只保留可点击 frame credential。
- 仅 authority-verified official CUA 可以启用 final-raster 特殊投影。第三方 MCP、同名
  Skill 和普通工具结果预算保持不变。

## UI Surface Matrix

| User scenario         | UI entry                  | Shared implementation                        | Display/draft owner                    | Validation/gating                           | Commit action      | Authority                 | Mode boundary                                     | Isolation                                |
| --------------------- | ------------------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------- | ------------------ | ------------------------- | ------------------------------------------------- | ---------------------------------------- |
| 主 Agent 操作桌面元素 | conversation CUA tool row | official MCP bridge + generic tool lifecycle | CLI model history / UI tool projection | official authority + receipt pass-through | MCP element write  | producer session + Helper | desktop local；mobile only attaches existing Host | 不修改 conversation snapshot/queue/owner |
| 动作后需要确认        | 下一轮模型输入            | explicit `get_app_state`                     | CLI provider projection                | no replay unless `action_sent=false`       | full get_app_state | producer session          | continuous/replayable 共用既有工具结果            | relay/main 不拥有状态屏障                |

## State Owners And Commit Sinks

| State/fact                            | Display owner                | Authoritative owner           | Commit sink                            | Persistence/cache                |
| ------------------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- | -------------------------------- |
| `state_id` 与 mutation epoch          | explicit observation result  | `zcode-cua` transport session | `get_app_state` / frame-producing tools | producer in-memory session       |
| broker/Helper dispatch fact           | CUA action receipt           | `zcode-cua` + signed Helper   | per-server MCP/Broker RPC               | 既有 tool result/session history |
| receipt 文本/structuredContent 投影   | provider tool-result history | generic MCP bridge            | tool executor serialization             | 既有 tool result/session history |
| UI tool lifecycle                     | conversation row             | 既有 session event/projection | generic MCP tool lifecycle             | 既有 conversation persistence    |

## Must-Preserve Invariants

- desktop `continuous` 与 mobile `replayable` 的 session 恢复语义不变。
- mobile/remote 不创建独立 Helper；broker token 不扩散到其他 MCP/Bash/hook。
- 对 receipt-only 官方 CUA 结果，PostToolUse hook 按普通 MCP 结果有界追加；仍会过滤
  hook 中伪造的 CUA frame credential。
- conversation catalog/matrix 不增加 case：本变更不改变 conversation 产品状态，只收紧
  official MCP tool-result 的内容完整性。
- provider 文本预算不足时按普通 resultBudget 截断；不得把截断结果伪装成新的 UI 状态。

## Accepted Cases

| Case ID        | Setup                                     | Action              | Assertions                                      | Evidence                    |
| -------------- | ----------------------------------------- | ------------------- | ----------------------------------------------- | --------------------------- |
| CUA-RCPT-01 | action receipt without post-state          | bridge/serialize    | 作为普通 MCP 文本投影，不合成 refresh_required | core bridge unit            |
| CUA-RCPT-02 | receipt + structuredContent                | bridge              | 优先投影 content，结构化字段保留给应用读取        | core bridge unit            |
| CUA-RCPT-03 | receipt text 超预算                        | serialize           | 走通用 resultBudget truncation                 | core budget unit            |
| CUA-RCPT-04 | possibly_sent                              | bridge              | retry_action=false，旧动作不重放               | producer + bridge unit      |
| CUA-AX-SYNC-05 | image 被 request media budget 移除        | provider projection | 对应 image_ref 同时移除                         | media-budget unit           |
| CUA-RCPT-06 | 第三方 MCP 仿造 receipt                    | bridge              | 不获得 final-raster official 特殊保护          | authority unit              |

## Impact And Handoff

- must-inspect：official MCP bridge、result serialization、media budget、bundled skill、版本与
  producer provenance、Helper product package gates。
- invariant-only：generic tool lifecycle、desktop/mobile delivery、remote workspace identity、
  subagent official CUA boundary。
- feature graph 保留 `state.cua-action-state-authority` 节点 ID 以避免下游引用漂移，但语义
  已改为 receipt authority；不再声明 post-state 原子投影边。
- E2E：沿用 C07/Chrome/Godot 和独立 MCP 回归；本次不新增 conversation E2E 状态组合。

## 验证结果

以下结果均使用 Node `24.14.0`。producer 已通过
[`zcode-cua!533`](https://git.example.invalid/codegeex/zcode-cua/-/merge_requests/533) 合入
`main`；ZCode consumer 精确锁定合入前经过评审的 source commit
`589dc68d4127457ca3d48bb9894cabae393e9668`，不从 semver 猜测实现来源。

| 范围                         | 结果                                                                           | 结论                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| producer 全量单测            | 230 files；2806 passed、23 skipped                                             | AX mutation epoch、单次派发、forced full observe、refresh barrier 与既有 frame/Zoom 回归通过 |
| producer 静态门禁            | typecheck 通过；lint 0 error、14 条既有 warning                                | `0.5.6` 可发布代码路径通过                                                                   |
| producer 真机压力            | 后台/并发前台 churn 30 次；真模型 5/5                                          | 未重复新增、未从 native error 重放；模型状态均同步或安全要求 refresh                         |
| consumer action/frame 重点集 | 5 files；117 passed                                                            | receipt pass-through、generic budget、hook 追加与 final-raster 门禁均覆盖                   |
| consumer Helper 兼容重点集   | 8 files；277 passed、1 skipped                                                 | `0.5.6` Helper 名称与 receipt/dispatch 语义已对齐                                            |
| wrapper/provenance           | 13/13；host authority 1/1                                                      | 版本、skill bytes、producer SHA 与 runtime contract 一致                                     |
| ZCode 全量单测               | 1309 files passed、1 skipped；11475 passed、12 skipped                         | consumer 与产品链路完整回归通过                                                              |
| ZCode 静态门禁               | root typecheck 通过；CLI 24/24 typecheck；root lint 0 error、38 条既有 warning | 本次变更没有新增 lint error                                                                  |
| 独立 MCP                     | 30 个工具；initialize、request_access、list_apps、Chrome full state 成功       | `zcode-cua@0.5.6` 可脱离 ZCode wrapper 直接通过 stdio 使用                                   |

独立 MCP 还验证了失败路径：Godot AX tree 在 8 秒遍历期限内未完成时安全返回错误，未派发
动作；当前新安装的 Dev Helper 尚未获得 macOS Screen Recording 权限，因此 consumer 环境的
真实 screenshot/Zoom 被 TCC 在截图前拒绝。该项不计为通过或产品回归失败；最终栅格、C07、
Chrome/Godot 与真模型证据来自同一 producer source commit 的已授权真机回归。授予新 Helper
权限后仍应补录 consumer 包装路径的截图哈希、`frame_id` 与最终投影点。

feature graph 保留既有节点 ID 并将语义改为 receipt authority；旧 action-state barrier
边不应恢复。
