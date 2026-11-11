# App 控制反向 RPC

`appControlProtocol` 定义十二个专用方法，每个方法都有严格 input/result schema。模型只填写 input；callerSessionId 与 callId 由 CLI 工具运行上下文注入，Host 必须通过实际活跃连接核对会话身份与授权，不能把 wire 字段本身视为权限。

成功为 `{ ok: true, result }`，领域拒绝为 `{ ok: false, error: { code, message } }`。不提供任意 service/method 执行器；App/CLI 引用由各自判别 schema 隔离。

`appControl/cancel` 只取消同调用会话的在途调用与等待订阅，不停止目标执行。请求与回复沿既有 CLI requestClient 反向 RPC；普通模型输入不允许更换工具集合或自报 bypass。
