# 会话活动退出确认

## 范围

单窗口桌面沿用现有原生退出确认，默认取消。真正退出前，在生产后端环境有活动 session 就先提示，
确认后才进入既有退出清理屏障；取消不停止任务，也不保留托盘显式退出标记。Windows/Linux 关闭到
托盘和 macOS 关窗隐藏仍保持运行，不改成退出；worktree 创建保护不变。不恢复 Wiki。

每个 session 最多计一次，条件为 `phase` 是 `prewarming`/`running`、`hasBackgroundWork` 为 true，
或 `hasCompactWork` 为 true。后台子 Agent、后台 Bash、工作流沿用 session 的后台工作摘要；
独立 compact 从 `activeWorks` 派生。仅有 pending interactions、pending commands 或其他
activeWorks 不新增保护。独立终端、暂停队列、未来的自动任务不参与。

## 状态与生命周期

CLI 是运行事实 owner。Host 复用 task-index syncer 的现有 sessions-index 订阅，不另建 tracker，
不靠 RPC 返回、页面是否打开或进程是否存活推断。完整 snapshot/delta 应用后发布去重活动数；
同代恢复保留最近已知贡献，新 runtime 代际在新 snapshot 前不沿用旧摘要。CLI unavailable、
service dispose 和 Host exit 分别撤销对应贡献，旧订阅消息不能复活。只在计数变化时上报。

```text
桌面输入 / 手机 shared-host 输入 -> 同一 CLI owner -> sessions-index
  -> 已有 Host syncer -> AgentRunningTaskCountChanged -> Main -> confirmAppQuit
```

本次接通本机 Window Host 执行的 v4 session；独立 SSH/WSL/Docker Source 上的任务不因退出本机
而停止，其退出计数转发不在此次接线范围。更新窗口、退出登录等既有活动数消费者会读到同一结果，
不重新设计其确认和重启入口。

## 验收

- SAC01：前台运行时退出弹确认，取消后窗口和任务存活；结束后活动数归零。
- SAC02：父回合已结束、后台 Bash/子 Agent/工作流仍运行，仍计一个活动 session；后台结束归零。
- SAC03：终态 phase 下独立 compact 开始/结束使活动数 0→1→0，其他 activeWorks 不计入。
- SAC04：snapshot/delta/remove、同代恢复、CLI 退出/换代、旧帧与 dispose 不漏计、不重复、不复活。
- SAC05：只存在排队输入或阻塞交互不新增活动计数；旧 CLI 缺 compact 字段仍可解析。

CLI 投影由既有 bootstrap 测试回归；桌面验收候选与运行状态见 conversation case catalog/matrix。
未实跑的平台、手机或远端不能据此声明覆盖。
