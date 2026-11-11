import type { IExtensionsService } from "#src/extensions/contract.js";

// Renderer 的用法：先订阅，第一条消息就是当前快照（或 detached），之后是增量与后续快照。
export function watchContributions(service: IExtensionsService): () => void {
  const subscription = service.onDynamicContributions(undefined)((message) => {
    void message.kind;
  });
  return () => subscription.dispose();
}

export async function reloadExtensions(service: IExtensionsService): Promise<void> {
  await service.reload();
}
