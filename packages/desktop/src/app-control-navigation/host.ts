import { IProjectService } from "@zcode/services";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type {
  AppControlDiscoverySource,
  AppControlDiscoverySourceResolverOptions,
} from "#src/app-control-navigation/discovery-contract.js";

export type {
  AppControlDiscoverySource,
  AppControlDiscoveryRegisteredSource,
  AppControlDiscoveryManagedSource,
  AppControlDiscoverySourceResolverOptions,
} from "#src/app-control-navigation/discovery-contract.js";
export { createAppControlNavigationBridge } from "#src/app-control-navigation/hostBridge.js";
export { appNavigationResultMessageSchema } from "#src/app-control-navigation/contract.js";

function assertVirtualProjects(virtualProjects: boolean | undefined): void {
  // 旧 Server 也可能注册兼容项目服务；必须核对握手能力，不能借兼容投影扩大只读发现范围。
  if (virtualProjects !== true) {
    throw Object.assign(new Error("App control discovery requires virtual-project support"), {
      code: "source_unsupported",
    });
  }
}

export function createAppControlDiscoverySourceResolver(
  options: AppControlDiscoverySourceResolverOptions,
): (hostId: string) => Promise<AppControlDiscoverySource> {
  return async (hostId) => {
    const serverId = parseRemoteWorkspaceIdentity(
      buildRemoteHostWorkspaceIdentity(hostId, "/"),
    )?.sourceServerId;
    const registered = serverId ? options.registry.getOnlineSource(serverId) : undefined;
    if (registered && serverId) {
      assertVirtualProjects(registered.capabilities?.virtualProjects);
      const services = registered.services;
      const physicalOwner = registered.capabilities?.physicalOwner?.();
      return {
        // 发现必须保留源身份；绑定身份的项目服务会调用 resolveWorkspace，不能在此复用。
        projects: services.get(IProjectService),
        assertCurrent() {
          // 重连保留 logical handle，但会替换 services 或物理 owner；只比较 handle 会接受旧树。
          if (
            options.registry.getOnlineSource(serverId) !== registered ||
            registered.services !== services ||
            registered.capabilities?.physicalOwner?.() !== physicalOwner
          ) {
            throw new Error("project.host-offline");
          }
          assertVirtualProjects(registered.capabilities?.virtualProjects);
        },
      };
    }
    const manager = options.getSourceServerConnectionManager();
    const source = manager?.listStates().find(
      (state) =>
        state.sourceServerId &&
        remoteHostIdFromWorkspaceIdentity(
          buildServerRemoteWorkspaceIdentity({
            serverId: state.sourceServerId,
            workspacePath: "/",
          }),
        ) === hostId,
    );
    const sourceServerId = source?.sourceServerId;
    const connection = sourceServerId ? manager?.getOnlineConnection(sourceServerId) : undefined;
    if (!connection || !sourceServerId || !manager) throw new Error("project.host-offline");
    assertVirtualProjects(connection.serverInfo.capabilities.virtualProjects);
    const projects = connection.services.projectService;
    if (!projects) throw new Error("project.host-offline");
    return {
      projects,
      assertCurrent() {
        if (
          options.getSourceServerConnectionManager() !== manager ||
          manager.getOnlineConnection(sourceServerId) !== connection
        ) {
          throw new Error("project.host-offline");
        }
        assertVirtualProjects(connection.serverInfo.capabilities.virtualProjects);
      },
    };
  };
}
