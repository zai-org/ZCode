# App 会话控制反向客户端

`createAppSessionControlBinding` 在可信协议启动边界绑定根 session 和 workspace。它实现核心 `AppSessionControl`，只把十二个有限动作映射到 shared `appControlProtocol`，不在 CLI 建立 App runtime、产品队列或缓存。

```text
根工具 → shared 严格 RPC schema → existing requestClient → Host 连接校验 → App owner
取消 → appControl/cancel → 释放该 call 的订阅；不停止目标执行
```

只在 `session/requestRuntimePreferences` 的 Host 响应明确声明 `appControlEnabled: true` 时注入。旧 Host、无 Host、显式关闭均不注册 App 工具。subagent、workflow child、nested workflow child 和 selection side chat 不继承端口；fork 的 parentID 仅表示历史来源，仍可作为独立根绑定。

callerSessionId 固定取启动绑定，callId/turnId/traceId 来自工具执行上下文。Host 通过实际连接重新建立授权和 Source；客户端不传权限模式或替目标审批。错误保持核心稳定 code；传输断开与未知响应不自动回落。

工具取消或 310 秒等待预算结束只清理当前调用。写请求可能已经被接纳，调用者需保留 requestId 对账。读取不导航、不标已读。桌面 continuous 与手机 replayable 继续由原 Host owner 交付。
