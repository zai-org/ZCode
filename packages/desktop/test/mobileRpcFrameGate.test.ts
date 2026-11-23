import { describe, expect, it } from "vitest";
import { encodeWebRemoteControlRpcTransportMessage } from "@zcode/shared";
import { MobileRpcFrameGate } from "#e2e/helpers/mobile-rpc-frame-gate";

const frame = (seq: number, bridge = "bridge-a", generation = 1, recoveryId = "recovery-a") =>
  JSON.stringify({
    payload: encodeWebRemoteControlRpcTransportMessage(Buffer.from(`config-${seq}`), {
      bridgeSessionId: bridge,
      bridgeGeneration: generation,
      recoveryId,
      firstPhysicalSeq: seq,
      messageSeq: seq,
    })[0],
  });

describe("mobile RPC fixture gate", () => {
  it("holds later frames in order, deduplicates replay and still forwards released replays", () => {
    const sent: string[] = [];
    let commands = 0;
    const gate = new MobileRpcFrameGate((message) => sent.push(String(message)));
    const accept = (message: string, hold: boolean) =>
      gate.receive(message, (payload) => {
        if (gate.firstMessage(payload)) commands++;
        return hold;
      });
    accept(frame(1), false);
    accept(frame(2), true);
    accept(frame(3), false);
    accept(frame(2), true);
    expect(commands).toBe(3);
    expect(gate.heldCount).toBe(2);
    expect(gate.replayedHeldFrames).toBe(1);
    expect(sent).toEqual([frame(1)]);
    gate.release();
    expect(sent).toEqual([frame(1), frame(2), frame(3)]);
    expect(gate.heldCount).toBe(0);
    accept(frame(2), false);
    expect(commands).toBe(3);
    expect(sent.at(-1)).toBe(frame(2));
    expect(sent).toHaveLength(4);
  });

  it("isolates bridge generations, recovery identities, directions and control frames", () => {
    const sent: string[] = [];
    const outbound = new MobileRpcFrameGate((message) => sent.push(String(message)));
    const inbound = new MobileRpcFrameGate((message) => sent.push(String(message)));
    outbound.receive(frame(1), () => true);
    for (const message of [
      frame(1, "bridge-b"),
      frame(1, "bridge-a", 2),
      frame(1, "bridge-a", 1, "recovery-b"),
    ]) {
      outbound.receive(message, (payload) => {
        expect(outbound.firstMessage(payload)).toBe(true);
        return false;
      });
    }
    inbound.receive(frame(1), () => false);
    const ack = JSON.stringify({
      payload: { zcode_type: "rpc-frame-ack", bridgeSessionId: "bridge-a", ackMessageSeq: 1 },
    });
    outbound.receive(ack, () => {
      throw new Error("control must not enter frame gate");
    });
    expect(sent).toHaveLength(5);
    expect(outbound.heldCount).toBe(1);
    expect(inbound.heldCount).toBe(0);
    outbound.release();
    expect(sent.at(-1)).toBe(frame(1));
  });
  it("shares logical counts across reconnects and never releases a closed connection", () => {
    const messages = new Set<string>();
    const oldSent: string[] = [];
    const newSent: string[] = [];
    const oldGate = new MobileRpcFrameGate((message) => oldSent.push(String(message)), messages);
    const newGate = new MobileRpcFrameGate((message) => newSent.push(String(message)), messages);
    let commands = 0;
    const accept = (gate: MobileRpcFrameGate, message: string) =>
      gate.receive(message, (payload) => {
        if (gate.firstMessage(payload)) commands++;
        return true;
      });
    accept(oldGate, frame(1));
    accept(oldGate, frame(2));
    oldGate.dispose();
    oldGate.dispose();
    expect(oldGate.heldCount).toBe(0);
    accept(oldGate, frame(3));
    accept(newGate, frame(1));
    accept(newGate, frame(2));
    expect(commands).toBe(2);
    oldGate.release();
    newGate.release();
    expect(oldSent).toEqual([]);
    expect(newSent).toEqual([frame(1), frame(2)]);
    accept(newGate, frame(1, "bridge-a", 2));
    accept(newGate, frame(1, "bridge-a", 1, "recovery-b"));
    expect(commands).toBe(4);
  });
});
