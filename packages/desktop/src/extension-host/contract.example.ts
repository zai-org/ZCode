import type {
  ExtensionHostSupervisor,
  ExtensionHostSupervisorDeps,
} from "#src/extension-host/contract.js";

// Main 的用法：创建一次；每个 Window Host spawn 后登记；退出屏障里并行 dispose。
export async function useSupervisor(
  create: (deps: ExtensionHostSupervisorDeps) => ExtensionHostSupervisor,
  windowHost: Parameters<ExtensionHostSupervisor["trackWindowHost"]>[0],
): Promise<void> {
  const supervisor = create({ logger: console });
  supervisor.trackWindowHost(windowHost);
  await supervisor.dispose();
}
