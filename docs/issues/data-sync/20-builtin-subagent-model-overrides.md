# 20: 推送内置子智能体的模型覆盖

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 用户在本机设置页给内置 `general-purpose` / `Explore` 选了模型后，远端设备仍然使用远端自己的 `agents-state.json`，本机的选择没有入口推送过去。在数据同步弹窗的「子智能体」分类中，把有覆盖的内置智能体作为条目列出，与用户子智能体放在同一个列表，沿用现有的行状态、勾选和推送流程。

**Blocked by:** [09: 子智能体分类与新同步通道](09-subagent-category-sync-channel.md)

## 决定（2026-11-02，与用户确认）

1. 只做内置智能体。插件智能体的模型覆盖不同步。
2. 不校验远端是否有对应的 Provider、模型和推理档位，与用户子智能体 frontmatter 的 `model` 相同。
3. 本机继承默认时不列出该行，也不清除远端覆盖（推送永不删除远端独有的条目）。
4. 远端 `agents-state.json` 的两个写入方（设置页子智能体服务、同步导入）这次不收口，记为已知限制。
5. 不分组，内置行与用户子智能体混排。「差异」行显示远端当前的模型。

## Acceptance criteria

- [x] 本机有覆盖、远端没有：该行为「推送」，默认勾选；说明行为「内置 · 模型 … · 推理档位 …」。
- [x] 两端覆盖不同：该行为「差异 · 内容不同」，默认不勾选；说明下方显示「远端：…」。
- [x] 两端覆盖相同：「已同步」，不可勾选。本机继承默认：不列出。
- [x] 推送只改远端 `builtInModelSelectionOverrides` 中选中的项，`disabledAgentIds`、插件覆盖、未知字段原样保留。
- [x] 本机清除覆盖后重新加载：该行消失，远端覆盖保持不变。
- [x] 列表加载后远端覆盖又被修改：推送返回 `conflict`，不写入。
- [x] 中英日韩俄文案齐全。

## Verification

- E2E：DSYNC-09-03 / 09-04（`conversation-session-remote-data-sync-subagent-push.test.ts`）覆盖行状态、冲突、状态文件损坏与字段保留；DSYNC-09-05（`conversation-session-remote-data-sync-builtin-subagent-runtime.test.ts`）覆盖推送后远端已有 task 下一轮 Explore 使用推送的模型。本机 Docker 远端 runner。

## Comments

- 2026-11-02 验证：macOS（Apple Silicon）本机 Docker 远端 runner（linux/arm64 容器，远端包重新构建）DSYNC-09-01/02/03 通过，工件 `packages/desktop/.e2e-artifacts/local-docker-20261102081334-c79be1`。
- 2026-11-02 全面验证：DSYNC-09-01～05 通过；源码切回 `8ac9fccc501` 时 09-03/04/05 失败。回归：p0 与 12 个数据同步远程 spec 通过；scope-by-device（DSYNC-15）HEAD 上 12 次中前 2 次在 15-01「打开远端子智能体编辑表单」失败、其后 10 次通过，基线 3 次通过，未抓到带诊断日志的失败样本，归因未定；r3-subagent R3A-TASK-06 在 HEAD 与基线都失败（「冷启后原子会话没有详情入口」），与本票无关。浅色 / 深色、中文 / 英文截图检查通过。
- 观察（未处理）：现有 `migrateSubagentStateFile` 在 `builtInModelSelectionOverrides` 键顺序与 Explore、general-purpose 不一致时会整份重写状态文件（内容不变）。
