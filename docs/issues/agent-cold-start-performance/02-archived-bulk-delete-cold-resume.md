# 归档页「删除全部」每条都冷恢复 session

Status: needs-triage

## 现象

设置 › 归档管理里删除 25 条归档任务，约需 50–75 秒。

## 证据

E2E TSL39 运行时日志：`window-controller.mutateTask` 逐条调用，每条 1.5–10 秒。每条删除前，agent 日志都有一次完整的 `bootstrap.app.startup`（解析插件、连接 7 个 MCP），删除后再关闭。

## 根因

- `useArchiveManagement` 按任务串行调用 `mutateProjectTask({ kind: "delete" })`。
- Host 经 `deleteSession` 命令删除；v4-gateway 对未加载的 session 先执行 `ensureColdReadyPublisher` 冷恢复，再由 CLI 写持久删除事实。
- Host 另有批量接口 `deleteArchivedTasks`，但它内部同样逐条走 `deleteSession`，耗时相同。

## 已做的处理

TSL39 的删除完成等待放宽到 120 秒，按当前真实耗时验证行为。

## 待决定

`deleteSession` 对未加载的 session 是否可以不冷恢复，直接写持久删除事实。这会改变 CLI 命令的执行语义，需要先更新 spec。
