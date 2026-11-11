# 会话执行公共材料

原生 V4 handler 曾从旧协议目录获取请求鉴权投影与收尾租约，导致协议依赖方向倒置。两种入口共用这里的协议无关能力，旧协议只保留重导出以兼容存量调用方。

session record 始终是 residencyFinalizationCount 的唯一 owner；租约不能替代 Core 的命令准入与 busy/idle。鉴权材料只对当前执行冻结，不能加入可持久化 intent。

```text
入口 → 拷贝本轮鉴权 → 原 record 同步持有租约 → 执行/失败 → 幂等释放
```

不创建队列、缓存、定时器或第二份会话状态。同步异常与异步失败均保留原错误。

主动重启先取消执行，然后通过 `waitForSessionResidencyFinalization` 等待原 record 的租约归零。等待者只观察原计数，不拥有第二份生命周期状态，也不通过超时判断安全释放。

## 当前任务审批切换权限

Core 的 `grantPermissionMode` 是任务授权入口，runtime 独占权限、授权事件和固定的目标队列。所选 guarded/yolo 通过同一事务写入：receipt schema 归 CLI contracts，队列入库归 SQLite adapter。原 receipt 键保持兼容，重试不能替换已提交模式。Bootstrap broker 只转交当前 session 的 interaction 并等待投影提交，不另存权限。

草稿没有 session 父行时，仅更新内存与发布授权事件；首发按当前配置保存。若外部活动已开始持久化，授权等待同一在途 Promise 后再判断路径。正式会话保留 execution/receipt 原子事务；重复审批复用原事件，不扩大目标、不覆盖后续用户选择。取消或持久化失败不发布成功；发布失败保留原授权供重试。

```text
审批 → runtime → 等待已有持久化 → 草稿内存 / 正式事务 → 授权事件 → 原投影提交
```

入口保留在 Core，复用原 runtime 内部依赖，不经 Bootstrap facade 引入反向依赖。回归见 `core/tests/permission-full-access.test.ts` 与 `bootstrap/tests/draft-permission-full-access.test.ts`。
