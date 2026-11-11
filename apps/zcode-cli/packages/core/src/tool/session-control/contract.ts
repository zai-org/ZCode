import type {
  AppSessionControl,
  AppSessionTrustedContext,
  CliSessionControl,
  CliTrustedContext,
} from "@zcode/session-control/contracts";
import type { SessionTaskType } from "@zcode/contracts";

export function sessionControlForRuntime(
  binding: SessionControlBinding | undefined,
  taskType: SessionTaskType | undefined,
  sessionId: string,
): SessionControlBinding | undefined {
  // taskType 的子会话种类并不都使用 runtimeScope=subagent，必须从同一入口收口注册与执行。
  if (
    taskType !== undefined &&
    taskType !== "interactive" &&
    taskType !== "fork" &&
    taskType !== "workflow_parent"
  )
    return undefined;
  if (binding?.context().rootSession.sessionId !== sessionId) return undefined;
  return binding;
}

/** 启动装配绑定来源与权限；工具 JSON 不能选择 surface 或重建调用者。 */
export type SessionControlBinding =
  | { kind: "cli"; control: CliSessionControl; context(): CliTrustedContext }
  // 模型工具只构造会话类调用方（有根会话）；客户端类调用方只由 App Host 构造。
  | { kind: "app"; control: AppSessionControl; context(): AppSessionTrustedContext };
