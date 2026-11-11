import type { IProjectService, ServiceDescriptor } from "@zcode/services";

/** 只读发现的连接证明；读取后由调用者复验，不能用于正文或写操作授权。 */
export interface AppControlDiscoverySource {
  projects: Pick<IProjectService, "readTree">;
  assertCurrent(): void;
}

/** 只依赖已在线来源的公开结构，不向解析器提供连接或身份绑定能力。 */
export interface AppControlDiscoveryRegisteredSource {
  services: {
    get(descriptor: ServiceDescriptor<IProjectService>): Pick<IProjectService, "readTree">;
  };
  capabilities?: {
    readonly virtualProjects?: boolean;
    physicalOwner?: () => object;
  };
}

export interface AppControlDiscoveryManagedSource {
  serverInfo: { capabilities: { virtualProjects?: boolean } };
  services: { projectService?: Pick<IProjectService, "readTree"> };
}

export interface AppControlDiscoverySourceResolverOptions {
  registry: {
    getOnlineSource(serverId: string): AppControlDiscoveryRegisteredSource | undefined;
  };
  getSourceServerConnectionManager():
    | {
        listStates(): ReadonlyArray<{ sourceServerId?: string }>;
        getOnlineConnection(serverId: string): AppControlDiscoveryManagedSource | undefined;
      }
    | undefined;
}
