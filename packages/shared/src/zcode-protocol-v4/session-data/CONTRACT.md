# protocol-session-data

`v4/storage/sessionData/measure` 与 `v4/storage/sessionData/purge` 的载荷 schema：Host 为「设置 → 项目」的彻底删除数据向 CLI 测量、删除会话与目录记忆。规格见 `docs/superpowers/specs/2026-10-24-project-management.md`「彻底删除数据」。

不变量：

- CLI 不感知项目：载荷只有会话根 ID 与目录（`workspacePath` + 可选 `workspaceIdentity`）。后代会话由 CLI 按 `parent_id` 的自有类型与 `session_task_link` 查找，fork 不算后代。
- 大小只统计从磁盘真实删除的文件；数据库行删除不计入（库文件不收缩）。
- purge 幂等：已不存在的会话按 0 字节删除成功。运行中的会话整棵保留并以 `kept`（`reason: "running"`）返回；附件仍被本次不删除的会话引用的会话整棵保留（`reason: "referenced"`）；文件删不掉的会话保留行，以 `failed` 返回错误码，供重试。
- 方法名在 `transport.ts` 的 `V4_METHODS` 冻结；旧 CLI 返回 method-not-found，Host 据此隐藏选项。
- 归档永久删除另有 `deletionPreview` / `deletionPreviewBatch` / `deletionExecute`。批量预检入参 `{ items }`（1–100 项），结果按顺序为 `{ preview }` 或 `{ error: { code } }`，与逐项预检结果一致；规格见 `docs/superpowers/specs/2026-09-11-archive-management.md`「预检按批一次扫描」。
