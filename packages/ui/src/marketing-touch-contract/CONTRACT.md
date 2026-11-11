# 活动展示控制器契约

`createMarketingTouchController` 是同步工厂。每个控制器独占其 banner/dialog、generation、待展示资源与动作状态。查询、准备、上报、执行和刷新由调用方注入；UI 观察同一个 store，不另存已确认活动列表。

```text
用户动作 → 关闭当前展示并作废旧查询 → 执行动作 → 异步上报 confirm
                                              └─ 领取成功 → 刷新资格
```

外链、导航和复制不改变资格，不立即刷新，避免异步 confirm 前重新查询并打开旧活动。以后服务端再次投放仍可展示。dispose 作废未完成查询并释放资源，旧回执不得重新打开弹窗。

现行 E2E 入口为 `packages/desktop/test/e2e/ui-shell/marketing/marketing-touch-delivery.test.ts`。原 App 单测已退役，其控制器竞态断言不再计入覆盖。本次登记保留原入口和依赖方向。
