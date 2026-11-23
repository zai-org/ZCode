# 窗口项目目录

`windowProjectDirectory` 是整体可选的窗口目录能力。项目读写与远端成员入口复用 owning Window Host 的现有服务；只读变化流只转发该窗口的 `state:projects`。不保存项目、成员或任务状态，不暴露完整 broadcast 写入与 claim。

三个频道为 `window-project`、`window-remote-projects`、`window-project-changes`。Host 在手机 replayable 的 remote attachment 上完整装配后暴露；原工作区服务与桌面 attachment 不变。客户端只根据 bridge 的显式能力创建整组 proxy，在发布前调用变化服务 `getCapabilities` 并验证 `version: 1`。缺能力维持旧版行为；已声明能力但缺服务或就绪失败明确拒绝，不能静默切回 Source 目录。

订阅直接沿用原窗口 broadcast；取消订阅释放原 listener。bridge 换代由调用者清理旧 proxy 与订阅，不增加独立 attachment、重试、持久化或目录缓存。

手机 attachment 的 `project` / `window-project` 的 `readTree` 由 `createWebRemoteProjectTreeActivityBridge` 装饰：叠加任务待处理交互，以及桌面 renderer 经 `window-controller.setProjectDisplayOrder` 上报的侧栏显示顺序（顶层 `projectOrder: { hostId, projectId }[]`，未上报时省略）。顺序只在 Window Host 内存，变化且有手机 attachment 时广播一次 `state:projects`；不写项目仓库或远端 position。
