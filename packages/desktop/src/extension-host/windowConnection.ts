import type { MessagePortMain } from "electron";
import {
  ChannelClient,
  ChannelServer,
  MessagePortProtocol,
  ProxyChannel,
  type Event,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import {
  EXTENSION_HOST_CHANNEL,
  EXTENSION_WINDOW_CHANNEL,
  closeViewInputSchema,
  commandInvocationSchema,
  extensionDeclarationsSchema,
  openViewInputSchema,
  viewRequestInputSchema,
  type ContributionMessage,
  type IExtensionHostChannel,
  type IExtensionWindowChannel,
  type ViewNotification,
} from "@zcode/shared/extension-host";
import type { CapabilityClient } from "#src/extension-host/capabilityClient.js";
import type { ExtensionRegistry } from "#src/extension-host/registry.js";
import type { ViewHost } from "#src/extension-host/viewHost.js";
import { hostLog } from "#src/extension-host/runtime.js";

// L1 连接（docs/plugins/extension-host.md §3.2）：Main 牵线的端口上跑双向 @zcode/rpc。
// 本进程提供 extension-host 频道，并代理 Window Host 的 extension-window 频道。

function wrapPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener: (_type, listener: (e: { data: MessagePortPayload }) => void) =>
      port.on("message", listener),
    removeEventListener: (_type, listener: (e: { data: MessagePortPayload }) => void) =>
      port.off("message", listener),
    postMessage: (data) => port.postMessage(data),
    start: () => port.start(),
    close: () => port.close(),
  };
}

export interface WindowConnection {
  dispose(): void;
}

export function connectWindowHost(params: {
  port: MessagePortMain;
  gen: number;
  registry: ExtensionRegistry;
  views: ViewHost;
  capabilities: CapabilityClient;
  onClosed: (connection: WindowConnection) => void;
}): WindowConnection {
  const protocol = new MessagePortProtocol(wrapPort(params.port));
  const server = new ChannelServer(protocol, "extension-host");
  const client = new ChannelClient(protocol);
  const hostChannel: IExtensionHostChannel = {
    setDeclarations: (declarations) =>
      params.registry.setDeclarations(extensionDeclarationsSchema.parse(declarations)),
    executeCommand: (input) => params.registry.executeCommand(commandInvocationSchema.parse(input)),
    // 新连上的一方先收一份快照，再收增量。
    onDynamicContributions: () =>
      ((listener: (message: ContributionMessage) => void) => {
        listener(params.registry.snapshot());
        return params.registry.onMessage(listener);
      }) satisfies Event<ContributionMessage>,
    openView: (input) => params.registry.openView(openViewInputSchema.parse(input)),
    viewRequest: (input) => params.views.request(viewRequestInputSchema.parse(input)),
    closeView: (input) => params.views.close(closeViewInputSchema.parse(input).instanceId),
    onDynamicViewNotifications: () =>
      ((listener: (notification: ViewNotification) => void) =>
        params.views.onNotification(listener)) satisfies Event<ViewNotification>,
  };
  server.registerChannel(EXTENSION_HOST_CHANNEL, ProxyChannel.fromService(hostChannel));
  const windowChannel = ProxyChannel.toService<IExtensionWindowChannel>(
    client.getChannel(EXTENSION_WINDOW_CHANNEL),
  );
  params.capabilities.attach(windowChannel);
  let disposed = false;
  const connection: WindowConnection = {
    dispose() {
      if (disposed) return;
      disposed = true;
      params.capabilities.detach();
      // 视图实例是替这个 Window Host 的页面开的；换了 Window Host 后没有人再用它们。
      void params.views.closeAll();
      server.dispose();
      client.dispose();
      protocol.disconnect();
    },
  };
  params.port.once("close", () => {
    if (disposed) return;
    hostLog("info", `window host disconnected gen=${params.gen}`);
    connection.dispose();
    params.onClosed(connection);
  });
  hostLog("info", `window host connected gen=${params.gen}`);
  return connection;
}
