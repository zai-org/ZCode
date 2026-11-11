# Summary 文件撤销安全预检

## 背景

消息 summary 中的文件变更按钮用于撤销本轮文件修改。旧链路直接调用 workspace rewind，
只依赖 checkpoint 的 `beforeContent` 写回，无法确认用户点击时文件是否已经被其他进程改过。
当同一个文件在同一轮里被多个 tool 连续修改时，也必须按照 checkpoint 的创建顺序倒序逐次回放，
不能只使用最终聚合 diff 做一次写回。

## 目标

- 点击 summary 的文件撤销按钮时先弹出确认弹窗。
- 弹窗按文件展示哪些文件可以安全撤销、哪些文件不能安全撤销。
- bash/shell 类工具产生的文件修改不参与 summary 文件撤销，也不出现在可撤销列表中。
- 一个文件被多个非 bash tool 修改时，执行撤销必须按 checkpoint 倒序逐次回放。
- 应用撤销前必须重新预检；只要存在 unsafe 文件，本次不写任何文件。
- 桌面端和手机远控都复用当前 session host，不创建独立 runtime。

## 非目标

- 不实现“重新应用”。当前 checkpoint artifact 只可靠保存变更前内容，不能安全恢复变更后内容。
- 不做部分撤销。P0 采用 all-or-nothing：存在 unsafe 文件时禁用确认按钮。
- 不根据 UI 的 `fileChanges.snapshots` 或 tool result 推断写回内容；真正的预检和写回由 agent runtime 完成。

## 与 editUserQuery 组合重置的边界

- summary 的 `applyFileRewind` 保持 workspace-only；它可以展示 ignored shell 文件并撤销其余安全文件。
- 编辑态「对话 + 文件重置」发出的 `editUserQuery(workspaceMode=rewind)` 要求完整回滚目标轮：unsafe、ignored shell、
  unsupported 或没有安全 checkpoint 都返回结构化 blocked，不写文件、不裁 conversation、不发模型请求。
- 组合模式必须在同一 Agent command 内重新预检、写文件、提交 branch cut；UI 禁止串联两条 CAS 命令。
- 多文件写入使用补偿 journal；branch/admission 在提交点前失败时恢复命令前文件内容和旧 branch metadata。

## 协议

新增两个 ZCode Protocol session 方法：

- `session/previewFileRewind`
- `session/applyFileRewind`

参数复用 session 历史 target：

```ts
{
  sessionId: string;
  target: ZCodeSessionHistoryTarget;
  expectedRevision?: number;
}
```

preview 返回文件级结果：

```ts
{
  sessionId: string;
  target: ZCodeSessionHistoryTarget;
  canApply: boolean;
  safeFiles: Array<{
    path: string;
    action: "restore" | "delete";
    operationCount: number;
    toolNames: string[];
  }>;
  unsafeFiles: Array<{
    path: string;
    reason:
      | "external_modified"
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "unsupported_checkpoint"
      | "file_read_failed";
    operationCount: number;
    toolNames: string[];
  }>;
  ignoredFiles: Array<{
    path: string;
    reason: "bash_ignored";
    operationCount: number;
    toolNames: string[];
  }>;
}
```

`applyFileRewind` 返回重新预检后的 preview、是否 applied，以及应用后的 snapshot。

## Runtime 算法

1. 根据 target 定位 checkpoint owner。checkpoint 以本轮 user message 为 owner；
   UI 传入 assistant message 时，协议层先归一化到 parent user message，再兜底匹配同 parent 下的 raw assistant step。
   `turn` target 同样解析到对应轮次的 user message。
2. 读取该 owner 对应的 workspace/both checkpoint。若该轮有多个 checkpoint，按创建顺序保留。
3. 读取所有 checkpoint artifact；读取失败的 checkpoint 涉及文件标记为 unsafe。
4. 忽略 bash/shell/terminal 类 artifact。
5. 对非 bash artifact 构建操作序列，按 checkpoint 创建顺序倒序检查。
6. 每个文件当前内容必须等于该 checkpoint 的 after 内容，才允许把它写回 before 内容。
   after 内容优先由 artifact 显式字段提供；旧 artifact 可由 `beforeContent + structuredPatch` 重建。
7. 预检阶段只模拟写回，不改磁盘。apply 阶段重新执行同一预检；`canApply=false` 时不写文件。
8. apply 写回同样按 checkpoint 倒序逐步执行，保证多 tool 修改同一文件时恢复到本轮开始前状态。

## UI 行为

- summary header 的按钮只负责打开弹窗。
- 弹窗显示可撤销文件；只有存在 unsafe 文件时才显示不可安全撤销区块。文件行展示文件路径、动作、涉及 tool 数/操作数。
- 有 unsafe 文件时确认按钮禁用，并提示需要先手动处理这些文件。
- apply 成功后刷新 session snapshot，summary 的 `fileState` 更新为 `reverted`。

## 远控边界

该能力是 session command，不改变 task realtime 传输语义。桌面端仍保持
`desktop-continuous` 主链路；手机远控通过 shared-host attachment 调用同一 session host，
再按 replayable snapshot 恢复 UI，不把 replayable 运行态恢复逻辑扩散到桌面端。
