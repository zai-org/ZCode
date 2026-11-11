# sqlite-migrations

CLI 与 Host 共用的 SQLite 升级基础设施；不理解 session、project 或业务归属。

- 只由启动 composition 调用，业务服务不能自行触发恢复。调用时数据库不在事务中，连接已设置 busy_timeout。
- BEGIN IMMEDIATE 先串行化迁移 admission，取得锁后重读版本；备份通过独立连接落盘，读取来源仍在同一快照内，失败回滚不丢备份。
- 历史 checksum 只由 SQL.trim() 计算。新增 apply 必须以对应 sql 记录不可变版本，声明所有写入表，且加列步骤可在表级恢复后重入。
- 只备份 touchedTables；调用者负责完整声明，fixture 哈希测试机械验证。schema_migration 由 runner 独占。
- 备份、校验、恢复逐行处理；仅单行数据进入 JS，排序使用有界页缓存的临时 SQLite 文件。新备份 version=2 按排序后的行 SHA-256 摘要增量哈希，保留重复行；恢复兼容 version=1 的原排序/哈希格式。格式与大表验收见 [启动规格](../../../../docs/desktop/database-migration-startup-gate-plan.md)。
- touchedTables 缺失、为空或含非法表名在任何 SQL 写入前拒绝。Host 可指定 tasks_schema_migration，保留其 time_applied 与无 app_version 的历史形状；备份元数据记录 journal，恢复只清理对应账本。
- previousIds 仅用于开发分支迁移后移：所有已存在 ID 校验同一 SQL checksum，旧 ID 已完成时复制记账到新 ID，不重跑转换，不改旧记录。
- 空间不足尝试后续卷；全部不足记录 skipped，调用者必须提示。正常读取及正常降级不消费备份。
- 恢复保留加法 schema，新列取默认；恢复后删除相应 migration 记录。未知迁移 ID 保留。
- 唯一副作用入口为 migrate / restore；index.ts 是启动组合入口，contract.ts 是稳定端口。SQLite 使用 Node 唯一可用的同步 API，文件系统操作均异步。

启动进程共用 storage-migrate 命令名及 version=1 的严格 JSON 完成 schema；SQL 仍只由持库 CLI 的 runner 执行。完成结果传 applied / backupPath / backupSkipped，错误以非零退出呈现，不伪造完成帧。
