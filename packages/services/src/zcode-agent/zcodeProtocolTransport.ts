import type { Event, IDisposable } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";

export type ZCodeProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface ZCodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface ZCodeProtocolTransport extends IDisposable {
  readonly kind: ZCodeProtocolTransportKind;
  readonly onMessage: Event<ZCodeProtocolMessage>;
  readonly onClose: Event<ZCodeProtocolTransportClosedEvent>;
  send(message: ZCodeProtocolMessage): Promise<void>;
  disposeAndWait?(options?: { deadlineAtMs?: number }): Promise<void>;
}
