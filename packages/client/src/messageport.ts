import { MessagePortProtocol, ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // 生产构建下 renderer 连接日志不输出，避免窗口启动和重连路径产生同步 console 成本。
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(message);
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

/**
 * 创建一个带明确生命周期的 MessagePort service connection。
 *
 * scoped remote session 换代时必须同时释放 ChannelClient 和底层 port，
 * 否则旧 attachment 上的挂起 RPC 无法 settle，并会继续占用上层去重状态。
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
  options: {
    sourceServerManagementService?: boolean;
    deviceSyncStateService?: boolean;
    extensionsService?: boolean;
    managedWorktreeService?: boolean;
  } = {},
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client, options);
  let disposed = false;
  return {
    services,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * 通过 MessagePort 连接服务。
 *
 * Desktop 模式下，utilityProcess（或 main 进程的远程代理）通过 MessagePort
 * 暴露 ChannelServer，renderer 用此函数建立 ChannelClient 连接。
 */
export function connectViaMessagePort(
  port: MessagePort,
  options: {
    sourceServerManagementService?: boolean;
    deviceSyncStateService?: boolean;
    extensionsService?: boolean;
    managedWorktreeService?: boolean;
  } = {},
): IServiceAccessor {
  return createMessagePortServiceConnection(port, options).services;
}
