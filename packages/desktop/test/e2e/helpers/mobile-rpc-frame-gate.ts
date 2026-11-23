import {
  parseWebRemoteControlRpcTransportPayload,
  type WebRemoteControlRpcTransportFramePayload,
} from "@zcode/shared";

type WireMessage = string | Buffer;
type Frame = WebRemoteControlRpcTransportFramePayload;
export const mobileRpcFrameIdentity = (frame: Frame) =>
  JSON.stringify([frame.bridgeSessionId, frame.bridgeGeneration, frame.recoveryId]);

/** 仅供 E2E：每个方向独占门禁，保持真实 RPC 帧的顺序与重放语义。 */
export class MobileRpcFrameGate {
  private readonly held = new Map<string, Map<number, WireMessage>>();
  private disposed = false;
  replayedHeldFrames = 0;

  constructor(
    private readonly send: (message: WireMessage) => void,
    // 逻辑消息属于 bridge，不属于物理连接；同方向的新连接复用用例级去重集合。
    private readonly messages = new Set<string>(),
  ) {}

  dispose(): void {
    // 旧连接不再持有可发送帧；缺失数据由真实传输层在新连接重放。
    this.disposed = true;
    this.held.clear();
  }

  get heldCount(): number {
    return [...this.held.values()].reduce((count, frames) => count + frames.size, 0);
  }

  firstMessage(frame: Frame): boolean {
    // 同一消息可能因 ACK 未到而重放；不能把物理传输次数当成配置命令次数。
    const key = JSON.stringify([mobileRpcFrameIdentity(frame), frame.messageSeq]);
    if (this.messages.has(key)) return false;
    this.messages.add(key);
    return true;
  }

  receive(message: WireMessage, shouldHold: (frame: Frame, wire: string) => boolean): void {
    if (this.disposed) return;
    const payload = parseWebRemoteControlRpcTransportPayload(
      (JSON.parse(String(message)) as { payload?: unknown }).payload,
    );
    if (payload?.zcode_type !== "rpc-frame") {
      this.send(message);
      return;
    }
    const hold = shouldHold(payload, Buffer.from(payload.dataBase64, "base64").toString("utf8"));
    const key = mobileRpcFrameIdentity(payload);
    let frames = this.held.get(key);
    // 扣住已编号帧却放行后继帧会制造 physicalGap，导致被测配置因 bridge 断开而失败。
    if (!hold && !frames) {
      this.send(message);
      return;
    }
    if (!frames) {
      frames = new Map();
      this.held.set(key, frames);
    }
    if (frames.has(payload.seq)) this.replayedHeldFrames++;
    else frames.set(payload.seq, message);
  }

  release(): void {
    const batches = [...this.held.values()];
    this.held.clear();
    for (const frames of batches) {
      for (const [, message] of [...frames].sort(([a], [b]) => a - b)) this.send(message);
    }
  }
}
