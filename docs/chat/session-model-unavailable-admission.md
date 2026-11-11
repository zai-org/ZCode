# 会话模型失效：统一准入与界面提示

更新日期：2026-11-05

## 背景

体验套餐（Start Plan）到期、活动结束或切换账号 / Team 后，账号 Provider（如
`account:bigmodel-start-plan`）从 Provider Registry 下架，但会话常驻的 `modelSelection`
仍指向它。按既有决策，失效选择保持「未绑定」，不自动改写成别的模型（见
`docs/v4-refactor/17-cold-resume-runtime-activation.md` 的 restoreWarning 边界）。

此前只有 V4 `sendText` 在 ACK 前校验 Selection 是否在 Registry。旧协议 `session/send`
（带附件的手机远控 / Bot 输入）、`/compact`、`/goal` 续跑都依赖一个已退化为空实现的
`ensureModelReady` 钩子，于是输入被接纳后才在 Core 建模阶段抛出
`Provider Registry 中不存在 Provider: account:bigmodel-start-plan`，以 TurnError 结束并进入自动上报。
界面侧，提交门禁静默禁用发送、工具栏退回「选择模型」占位，没有任何解释。

## 当前行为

```text
Registry 下架会话常驻 Provider
        │
        ├─ CLI：所有会创建 Turn 的入口共用 prompt-turn.resolveTurnModelAdmissionMessage
        │     · V4 sendText / createSession firstInput / sendQueuedNow 提升   → ACK failed, reasonCode=modelUnavailable
        │     · V4 compact / sendGoalCommand / resumeGoal                      → 同上，且在写目标、改队列之前拒绝
        │     · 旧协议 session/send、session/compact                           → -32031, data.code=ZCODE_RUNTIME_MODEL_UNAVAILABLE, data.reasonCode=modelUnavailable
        │     · 旧协议 session/goal 的 set / replace / resume                 → 同上；只有会续跑（非 Plan、无活跃 turn）的分支才准入，
        │       且准入先于 setTarget / updateTargetStatus：失败时目标与历史保持原样、不广播；show / pause / clear / 无目标 resume 语义不变
        │     · 不自动改写会话模型；Core 不再因这些入口抛 Registry 内部文案
        │
        └─ Renderer：由 Model Selection View 对会话原选择解析出的 selectionIssue 派生「模型已失效」横幅
              · provider-not-found / model-not-found / account-connection-unavailable 三种原因
              · 与 draftConfig 被清空、提交门禁返回 null 同源（effectiveSelection 为 null）
              · 文案复用 zcode.error.ZCODE_RUNTIME_MODEL_UNAVAILABLE；可关闭。关闭指纹 = 失效原因 + 会话原选择
                （composerDraft.modelSelection，即 View 的解析输入），目录 revision 等无关变化不重新弹出；
                改选另一模型后它再失效时必须重新显示
              · Composer 横幅「显示哪条」与「关闭归谁」在 SessionPane 的 composerBanner 一处派生，
                优先级：草稿无可用模型 > 本次发送失败 > 会话模型已失效 > 投影 lastError；
                模型仍失效时，投影里的 provider_not_found / model_not_found 与失效横幅是同一事实，不重复显示；
                关掉失效横幅后轮到其余投影错误，各自可关闭
              · 子代理 / 目标自动续跑等仍在 Core 建模的路径，其 TurnError 的 provider_not_found /
                model_not_found 也按同一文案本地化，不透出内部实现
```

判定只有一个来源：当前 Worker Registry 发布的模型目录（`record.app.listModels()`）。宿主不提供目录时放行给 Core。

## 实现入口

- CLI 判定与 V4 入口：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`
  （`resolveTurnModelAdmissionMessage` / `resolveModelUnavailableMessage`）、`commands/handlers/goal-compact.ts`（compact / goal）
- 旧协议入口：`zcode-protocol/server-operations.ts` 的 `assertLegacyTurnModelAvailable`
- Renderer：`packages/ui/src/v4/composer/composerSubmissionConfig.ts` 的 `resolveSessionModelUnavailable`、`SessionPane.tsx` 的 `composerError`、
  `ChatErrorBanner.tsx` 的 `MODEL_NOT_IN_REGISTRY_CODES`
- 已删除：`ensureSessionModelAvailable*` 与 `V4CommandCoreHost.ensureModelReady` 过渡钩子

## 不在范围

- 自动把失效选择映射到同 Family 的其他套餐（产品决策，未采纳）。
- 体验套餐可用性查询对业务错误码 / 401 的 last-known-good 防抖（涉及 fail-closed 语义，另行决策）。

## 验证

- CLI 单测：`v4-native-commands`、`v4-native-goal-compact`、`v4-native-queue`、`v4-native-session-mgmt`、
  `session-selection-protocol`。
- 桌面 E2E：`conversation-session-model-unavailable-reselect`（candidate，见 coverage matrix）：Provider 下架前先留一条
  400 投影错误，验证失效横幅先显示、两条横幅各自可关闭、关完后发送仍禁用、普通刷新不重新弹出、重选后恢复；
  再下架改选后的 Provider，横幅必须重新出现，第二次重选后恢复。
- 旧协议 goal 准入：`session-selection-protocol.test.ts`（set / replace / resume 在模型失效时拒绝且目标原样，重新可用后成功）。
