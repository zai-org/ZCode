# 内置浏览器权限契约

现有 `applyEmbeddedBrowserPermissionPolicy` 是 Electron partition 的装配入口。初始化等待站点权限记录加载，再注册 request/check/device handler；每个 partition 只装配一次。

站点权限管理器持有持久授权，当前 policy 实例持有会话授权和待决请求。request 与 check 都按标准 URL origin 查询；路径和尾斜杠不改变站点，协议或主机不同则隔离。未授权敏感权限交给注入的 prompt，未知权限拒绝。

```text
Electron request/check → 标准 origin → 同一授权记录 → 允许 / 拒绝 / 用户决策
```

设备选项与持久化通过已有 desktop 模块完成。本模块不改变权限清理、主窗口路由或跨进程协议。现行 E2E 入口为 `packages/desktop/test/e2e/browser/permissions/browser-permission-prompt.test.ts`。原 App 单测已退役，其独立 policy 边界断言不再计入覆盖。
