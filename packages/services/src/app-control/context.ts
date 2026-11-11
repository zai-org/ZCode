import { SessionControlError, type AppTrustedContext } from "@zcode/session-control/contracts";
import type {
  AppControlBinding,
  AppControlClientBinding,
  AppControlDiscoveryBatch,
} from "#src/app-control/contract.js";

export const appControlBindingKey = Symbol("app-control-binding");
/** 会话类（模型工具）或客户端类（§17.2）的连接事实，外加本次调用捕获的发现来源。 */
export type BoundAppBinding = (AppControlBinding | AppControlClientBinding) & {
  discovery?: AppControlDiscoveryBatch;
};
export type BoundAppContext = AppTrustedContext & { [appControlBindingKey]?: BoundAppBinding };
export function getAppControlBinding(context: AppTrustedContext): BoundAppBinding {
  const binding = (context as BoundAppContext)[appControlBindingKey];
  if (!binding) throw new SessionControlError("forbidden", "Missing trusted App binding");
  binding.assertCurrent();
  if (context.signal?.aborted || binding.signal.aborted)
    throw new SessionControlError("cancelled", "App control call cancelled");
  return binding;
}
