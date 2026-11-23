import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ISourceServerManagementService, type UpdateConnectionProfileInput } from "@zcode/services";

const DISCONNECT_REQUEST = -8301;
const UPDATE_REQUEST = -8302;
const SAVE_PROFILE_REQUEST = -8303;
interface UpdateDisconnectProbe {
  sent: boolean;
  requests: number[][];
  responses: number[][];
  restore(): void;
}

function decodeFrame(bytes: number[]) {
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)));
  return { header: deserialize(reader) as [number, number], body: deserialize(reader) };
}

interface UpdateDisconnectEvidence {
  sent: boolean;
  savedProfile?: ReturnType<typeof decodeFrame>;
  update?: ReturnType<typeof decodeFrame>;
  cancellation?: ReturnType<typeof decodeFrame>;
  states: Array<Record<string, unknown>>;
}

let evidence: UpdateDisconnectEvidence = { sent: false, states: [] };
declare global {
  interface Window {
    __updateDisconnectProbe?: UpdateDisconnectProbe;
  }
}

/** 更新 UI 会禁用同卡按钮；在真实 updating 事件到达时提交并发 RPC，覆盖 Host 必须兑现的断开终态。 */
export async function disconnectDuringNextSourceUpdate(sourceServerId: string): Promise<void> {
  await observeUpdateCancellation(sourceServerId, "disconnectSource", sourceServerId);
}

/** 两条真实 SSH 线路已建立；经同一 Host RPC 更新 B，并在 A 的物理连接失效时删除 B。 */
export async function updateAndRemoveNonCurrentProfile(
  sourceServerId: string,
  ownerProfileId: string,
  profile: UpdateConnectionProfileInput,
): Promise<void> {
  await observeUpdateCancellation(
    sourceServerId,
    "removeProfile",
    profile.profileId,
    ownerProfileId,
    profile,
  );
}

async function observeUpdateCancellation(
  sourceServerId: string,
  command: "disconnectSource" | "removeProfile",
  removedId: string,
  ownerProfileId?: string,
  profile?: UpdateConnectionProfileInput,
): Promise<void> {
  evidence = { sent: false, states: [] };
  const writer = new BufferWriter();
  serialize(writer, [100, DISCONNECT_REQUEST, ISourceServerManagementService.channelName, command]);
  serialize(writer, [removedId]);
  const updateWriter = new BufferWriter();
  serialize(updateWriter, [
    100,
    UPDATE_REQUEST,
    ISourceServerManagementService.channelName,
    "updateSource",
  ]);
  serialize(updateWriter, [{ profileId: removedId }]);
  // 复用已在线 Source 的线路可能没有独立保存密码；经正式设置命令准备可静默更新的 B 线路。
  const profileWriter = new BufferWriter();
  serialize(profileWriter, [
    100,
    SAVE_PROFILE_REQUEST,
    ISourceServerManagementService.channelName,
    "updateProfile",
  ]);
  serialize(profileWriter, [profile]);
  const savedHeader = new BufferWriter();
  serialize(savedHeader, [201, SAVE_PROFILE_REQUEST]);
  await browser.execute(
    (
      channel,
      sourceId,
      disconnectRequest,
      ownerId,
      updateRequest,
      saveProfileRequest,
      savedPrefix,
    ) => {
      const original = MessagePort.prototype.postMessage;
      let removeListener: (() => void) | undefined;
      const probe: UpdateDisconnectProbe = {
        sent: false,
        requests: [],
        responses: [],
        restore() {
          MessagePort.prototype.postMessage = original;
          removeListener?.();
          delete window.__updateDisconnectProbe;
        },
      };
      function receive(this: MessagePort, event: MessageEvent) {
        if (!(event.data instanceof Uint8Array)) return;
        probe.responses.push(Array.from(event.data));
        if (
          saveProfileRequest.length &&
          savedPrefix.every((byte, index) => event.data[index] === byte)
        )
          original.call(this, Uint8Array.from(updateRequest));
        const text = new TextDecoder().decode(event.data);
        if (
          !probe.sent &&
          text.includes('"state":"updating"') &&
          text.includes(sourceId) &&
          (!ownerId || (text.includes('"state":{') && text.includes(`"profileId":"${ownerId}"`)))
        ) {
          probe.sent = true;
          original.call(this, Uint8Array.from(disconnectRequest));
        }
      }
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        let startUpdate = false;
        if (message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (!ownerId && removeListener && text.includes(channel) && text.includes("updateSource"))
            throw new Error("Unexpected second update request");
          if (
            text.includes(channel) &&
            text.includes(ownerId ? "getSnapshot" : "updateSource") &&
            !removeListener
          ) {
            removeListener = () => this.removeEventListener("message", receive);
            probe.requests.push(ownerId ? updateRequest : Array.from(message));
            this.addEventListener("message", receive);
            startUpdate = Boolean(ownerId);
          }
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
        if (startUpdate)
          original.call(
            this,
            Uint8Array.from(saveProfileRequest.length ? saveProfileRequest : updateRequest),
          );
      };
      window.__updateDisconnectProbe = probe;
    },
    ISourceServerManagementService.channelName,
    sourceServerId,
    Array.from(writer.buffer.buffer),
    ownerProfileId,
    Array.from(updateWriter.buffer.buffer),
    profile ? Array.from(profileWriter.buffer.buffer) : [],
    Array.from(savedHeader.buffer.buffer),
  );
}

export async function readUpdateDisconnectEvidence() {
  const probe = await browser.execute(() => {
    const probe = window.__updateDisconnectProbe;
    return probe
      ? { sent: probe.sent, requests: probe.requests, responses: probe.responses.splice(0) }
      : null;
  });
  if (!probe) throw new Error("Missing update disconnect probe");
  const updateId = probe.requests[0] ? decodeFrame(probe.requests[0]).header[1] : undefined;
  // 重传全部历史帧会使长时间恢复等待的 WDIO worker 堆耗尽；原始帧只读一次，累计保留断言证据。
  evidence.sent ||= probe.sent;
  for (const bytes of probe.responses) {
    const frame = decodeFrame(bytes);
    if (frame.header[1] === SAVE_PROFILE_REQUEST) evidence.savedProfile ??= frame;
    if (frame.header[1] === updateId && [201, 202, 203].includes(frame.header[0]))
      evidence.update ??= frame;
    if (frame.header[1] === DISCONNECT_REQUEST) evidence.cancellation ??= frame;
    if (frame.header[0] === 204 && frame.body?.state) evidence.states.push(frame.body.state);
  }
  return { ...evidence, states: [...evidence.states] };
}

export async function restoreUpdateDisconnectProbe(): Promise<void> {
  try {
    await browser.execute(() => window.__updateDisconnectProbe?.restore());
  } finally {
    evidence = { sent: false, states: [] };
  }
}
