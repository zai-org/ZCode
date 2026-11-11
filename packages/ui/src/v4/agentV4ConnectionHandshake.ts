// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    // `workflowRunDeltas` 的声明是**单向**的：只有 Host 先在 hello 里宣告，客户端才能回声明。
    // clientHello 的 capabilities 是 `.strict()` 的，向老 Host 发一个它不认识的键会让整条
    // clientHello 解析失败、连接握不上手——这不是降级，是整个会话面板打不开。
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hello.capabilities.pluginDiscovery === true ? { pluginDiscoveryUi: true } : {}),
      ...(hello.capabilities.historyFirst === true ? { historyFirst: true } : {}),
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
    };
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
      // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities,
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
