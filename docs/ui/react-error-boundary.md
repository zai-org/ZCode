# React Error Boundary

`packages/ui/src/ErrorBoundary.tsx` 现在提供共享的 `AppErrorBoundary`，由 desktop / web 两个 renderer 入口统一包裹 `ZCodeIntlProvider` 和 `Root`。

这样做的目的很简单：

- React render / lifecycle 异常不再直接把整棵树卸载成白屏
- fallback 页面统一走 `packages/ui/src/logger.ts` 记录错误
- 用户至少还能执行“重试”或“刷新应用”

当前策略是“先保命，再恢复”：

- `重试`：清空错误边界状态，重新尝试渲染当前树
- `刷新应用`：直接刷新当前 renderer，适合 Provider 或初始化状态已经损坏的情况
- Desktop 额外注入 `onRestart`，提供“重启应用”：经主进程执行紧急重启，不依赖故障树内的 Provider。Web / 手机不注入此能力，保留页面刷新。范围与验收见[崩溃重启](../desktop/crash-restart.md)。

如果后续要做更细粒度的隔离，可以继续在 workspace、侧边栏、右侧面板等局部区域增加二级 Error Boundary，但根级边界要保留，确保任何时候都不会回到白屏。
