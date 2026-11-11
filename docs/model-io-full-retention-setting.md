# ModelIO 全量保留设置

## 状态

- 本文定义 Settings 中 ModelIO 全量保留开关的产品与实现边界。
- 这是 App 全局诊断偏好，不属于 conversation/session 恢复状态。
- 默认关闭；未出现该字段的历史 `setting.json` 按关闭处理。

## 用户语义

Settings / Agent 能力 / 行为与工具 提供“完整保留模型 I/O”开关：

- 关闭：保持当前 bounded 模式。生产态最多保留 3 个 session 文件，单 session 达到 64 MiB 后重置；开发态单 session 达到 256 MiB 后重置；请求消息使用 `full` / `delta` / `tail` 压缩，生产态裁剪重复的大字段。
- 开启：从下一次模型 attempt 开始写完整记录，不淘汰旧 session 文件，不按单 session 容量重置，不生成 `delta` / `tail`，也不执行生产态字段裁剪。
- 切换不重写、恢复或删除已经存在的记录。重新关闭后，从下一次写入开始恢复 bounded 策略。
- 开启后会完整保存 prompt、tool input/result 和模型输出；该设置只改变保留策略，不改变安全脱敏边界。
- Header 与 Anthropic request metadata 的凭据脱敏属于安全边界，任何模式都不能关闭。

## 状态与同步链路

```text
Settings Switch
  |
  | ISettingService.update({ modelIoFullRetentionEnabled })
  v
~/.zcode/v2/setting.json                    authoritative app preference
  |
  +--> current Local Host ------------------+
  |                                         |
  +--> active Remote/Bot Host --------------+ App runtime preference sync
                                            |
                                            v
                              workspace/updateModelIoPreferences
                                            |
                                            v
                              workspace-scoped zcode-cli process
                                            |
                          +-----------------+-----------------+
                          |                                   |
                    resident apps                      future apps
                    update adapter                     inherit snapshot
                          |                                   |
                          +-----------------+-----------------+
                                            v
                                  ModelIO write boundary
```

同步约束：

- 本地、SSH、WSL、Docker、Server remote 均使用桌面 App 的同一个全局偏好；远端 workspace 不读取远端自己的 `setting.json` 作为权威值。
- Host 缓存最新偏好，并在新建或重启 workspace CLI 后、允许 session 工作前补发。
- 新协议方法对旧 CLI 采用 method-not-found 兼容：设置仍持久化，旧 CLI 继续 bounded 模式；不能影响既有 AskUserQuestion 偏好同步。
- 手机 `/remote` 仍附着既有 Host/CLI，不新增独立 runtime，不改变 `desktop-continuous` / `web-remote-replayable` 交付语义。

## Writer 行为

```text
write model_io record
  |
  v
sanitize headers / request metadata       always
  |
  +-- fullRetention = true --> append complete sanitized record
  |
  `-- fullRetention = false
         |
         +--> production duplicate-field pruning
         +--> full / delta / tail compaction
         +--> session-count rotation
         `--> per-session size reset
```

开关值在一次模型 attempt 开始时取快照；切换发生在请求中途时，当前 attempt 沿用开始时的模式，下一 attempt 生效，避免一条记录内部出现不确定语义。

## Impact Brief

### Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 增加默认关闭的 ModelIO 全量保留开关 |
| Capability | ModelIO diagnostics retention |
| Change layer | presentation / draft-default / commit-effect / persistence |
| Operating mode | planning |
| Primary seeds | `AgentBehaviorSectionContent`, `appSettingsSchema`, `syncAppRuntimePreferences`, `AiSdkModelAdapter`, `writeModelIODebugRecord` |
| Out of scope | conversation 内容、task snapshot、queue、stream replay、ModelIO 读取 UI、日志导出策略 |

### UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 保留完整模型诊断轨迹 | Settings / Agent 能力 / 行为与工具 | `AgentBehaviorSectionContent` + `Switch` | `useSettings` shared snapshot | `appSettingsSchema` default `false` | boolean schema | `ISettingService.update` + runtime preference sync | `~/.zcode/v2/setting.json` + active CLI runtime snapshot | desktop/web UI 共用；local/remote Host 同步 | conversation/session recovery、provider 配置、日志脱敏 |

### Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters for this change |
| --- | --- | --- | --- |
| UI/component | 复用 SettingsRow/Switch | 无第二入口 | 避免多个草稿 owner |
| Default/inheritance | 所有 workspace 读取 App 全局默认 false | 旧 CLI 不支持热同步时继续 bounded | 保持向后兼容 |
| Commit effect | 本地与远端活动 CLI 都接收偏好 | standalone CLI 无 UI，继续默认 false | 不扩张 CLI config 合同 |
| Persistence/recovery | App setting 持久化 | 不进入 session/task snapshot | 避免诊断偏好污染恢复状态 |

### Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | Settings switch | persists-to | App settings | always | 默认值与历史兼容 | `validationAppSettings.ts`, `settingService.ts` |
| must-inspect | App settings | syncs-to | active local/remote CLI | active workspace | 切换需即时生效 | `useSettingService.ts`, `zcodeAgentService.ts`, `botRemoteWorkspaceBridge.ts` |
| must-inspect | CLI preference | controls | ModelIO writer | every model attempt | 定义 full 与 bounded 分支 | `runner.ts`, `runner-debug.ts` |
| should-inspect | full retention | increases | retained diagnostic volume | enabled | 脱敏不能关闭 | `runner-debug-redaction.ts`, i18n copy |
| invariant-only | full retention | must-not-mutate | conversation delivery/recovery | all modes | 仅诊断持久化变化 | architecture docs |
| evidence-only | capability | covered-by | schema/UI/protocol/adapter tests | implementation | 证明端到端边界 | listed tests below |

### State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| 用户选择 | Settings React snapshot | `ISettingService` | `update()` | `setting.json` | UI/service tests |
| 活动 CLI 偏好 | Host latest preference snapshot | workspace CLI protocol context | `workspace/updateModelIoPreferences` | process memory only | protocol/service tests |
| 单次写入模式 | `AiSdkModelAdapter` | adapter attempt snapshot | runner input | none | adapter tests |

### Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --- | --- | --- | --- |
| 默认关闭完全保持旧 bounded 行为 | all | existing rotation/size/delta tests continue passing | adapters tests |
| 凭据脱敏始终开启 | full + bounded | full record headers remain redacted | adapters tests |
| 不启动 dormant workspace | local/remote | runtime preference sync only targets active clients | service implementation/tests |
| 不改变 desktop/mobile delivery | continuous/replayable | no realtime schema/state change | static boundary review |

### Codegraph Evidence

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| repository root | settings/runtime/modelIO impact | codegraph index unavailable; used focused `rg` fallback | 0 | graph drift must be checked by text/type/test evidence |
| `AgentBehaviorSectionContent` | callers | `SettingsPage` | 1 | single UI entry |
| `syncAppRuntimePreferences` | callers | Root/useSettings/Bot remote bridge | 2 | local and remote runtime sync owner |
| `writeModelIODebugRecord` | callers | generate/stream recorder | 2 | single persistence boundary |

### Graph Drift And Delta

当前 graph 没有 ModelIO retention capability。实现前补充 capability、Settings surface、Host/CLI sync service、ModelIO JSONL persistence、测试 evidence 及其语义边；codegraph 未建立索引，seed 有效性通过 `rg`、typecheck 与测试验证。

## Case Planning

### Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 全量定义 | 禁止所有自动删除、重置、delta/tail 与生产字段裁剪 | request/response 完整诊断字段 | 安全脱敏 | user intent + security invariant |
| 生效范围 | App 全局，活动 local/remote CLI 即时同步 | future and resident apps | standalone CLI UI | app settings architecture |
| 历史处理 | 不回填、不重写 | future attempts | 恢复已淘汰数据 | append-only boundary |
| conversation E2E | 不新增 | schema/UI/protocol/adapter integration tests | session state matrix | no conversation behavior change |

### Candidate And Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers |
| --- | --- | --- | --- | --- |
| MIO-FR-01 | empty historical settings | load settings | switch/default is false | schema |
| MIO-FR-02 | bounded production writer | write multiple sessions and growing context | max 3 files; delta/tail and size reset unchanged | adapter/files |
| MIO-FR-03 | full retention enabled | write multiple sessions and repeated context | all files remain; each record is full; production duplicate fields remain | adapter/files |
| MIO-FR-04 | full retention enabled with oversized session file | append next record | existing file is not reset and no `modelIOReset` marker is emitted | adapter/files |
| MIO-FR-05 | active local/remote services | toggle switch | setting persists, active Host ACKs, cross-window payload includes full snapshot | UI/service/protocol |
| MIO-FR-06 | full retention record contains credentials in headers | write record | sensitive headers remain `[redacted]` | adapter/files |

### Pruning Decisions

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| MIO-PR-01 | session phase × queue × delivery kind | writer mode does not read or write these states | avoid false conversation coupling | static review |
| MIO-PR-02 | provider/model Cartesian product | retention branch is provider-neutral after record construction | one generate/stream representative is sufficient | adapter unit tests |
| MIO-PR-03 | theme × locale × viewport screenshots | standard SettingsRow/Switch only, no new layout primitive | bilingual copy + component render test | UI unit test |
