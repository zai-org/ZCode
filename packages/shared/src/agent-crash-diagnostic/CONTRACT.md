# Agent 进程退出诊断契约

纯函数模块：输入 Agent runtime 的退出码、信号和 stderr 尾部，输出脱敏后的
`errorName / errorCode / errorMessage / errorStack / errorFingerprint / diagnosticClass`，
以及能由退出码确定的退出原因（目前只有 Windows `0xE0000008` → `native_out_of_memory`）。
不做 IO、不持有状态。当前调用方是 desktop 稳定性上报（`desktopStabilityTelemetry.ts`）；
后续的 Host 侧运行时意外退出提示（`fix/runtime-exit-notice`）也调用这里，不各自维护规则。
`redactAgentDiagnosticSecrets` 是 stderr / 错误文本的凭据遮盖规则，services 收集 stderr 与
desktop main 上报前共用；对已处理过的文本幂等。

规则与字段见 [Agent 进程崩溃 ARMS 上报](../../../../docs/monitoring/agent-process-crash-arms.md)。
