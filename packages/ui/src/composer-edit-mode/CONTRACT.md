# Composer 编辑态

编辑最后一条消息与排队消息都复用底部 composer（产品规则见 [composer-edit-mode.md](../../../../docs/ui/composer-edit-mode.md)）。
本模块只拥有发起端 renderer 的编辑态：编辑目标、edit scope 与状态条；不新增权威数据源。

- **单一 owner**：失效只读 CLI 投影（`row.actions.canEdit`、queue item、`queueItem.editLock`）；队列冻结锁由 CLI 裁决，
  本模块只发 `lockQueueItemEdit` / `releaseQueueItemEdit`，提交由 SessionPane 路由到 `editUserQuery` / `editQueueItem`。
- **edit scope**：每次进入编辑态生成新的 scope（`createComposerEditScopeId`），编辑内容只在内存；原草稿 scope 从不被改写，
  退出编辑态即切回原 scope 恢复草稿；提交成功时原草稿换入编辑态的模型与 mode（Plan 不换），由 `useDraftConfigControl` 在同一次渲染合成。
- **应用到其他排队消息**：编辑提交被接纳后，`useQueueConfigApplyPrompt` 按当前投影派生候选项与变化字段
  （`planQueueConfigApply`），只在发起端提示；确认时重算并发 `applyQueueItemsConfig`。
- **时序**：排队消息先等 lock ACK 再进入编辑态；ACK 前切走 task 则立即释放锁。刷新后投影中属于本编辑器（`editorId`，
  sessionStorage）但本地无编辑态的锁立即释放，不使用超时。编辑态在 composer 结算（附件 adopt）后才退出。
- **多端**：编辑态不进入 snapshot/relay；其他端只看到 `editLock`。
