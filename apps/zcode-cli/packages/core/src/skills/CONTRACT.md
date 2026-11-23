# skill-live-catalog

完整规格见 `docs/skills-live-catalog.md`。

意图：打开的会话跟随 skill 目录变化，模型可见的列表只追加，prompt 前缀保持字节稳定。

不变量：

- 唯一事实是进程级目录快照；列表公告、Skill tool、会话引用目录读同一份，step 内不做 IO。
- 已公告集合只从有效历史的 `skillsListingDelta` 回放；没有它的旧记录不计入，升级后补一次完整列表。
- 新增或内容变化的行追加公告，删除不通知；已发送的列表不改写（冷恢复、rewind 也不改写）。
- 公告先持久化，成功后才提交到历史；`skillsListingDelta` 是宽松字段，不新增顶层 source。
- Skill tool 未命中时 flush 一次再判定，不靠等待。
