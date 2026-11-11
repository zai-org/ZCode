import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ISourceServerManagementService } from "@zcode/services";
import type { RemoteTarget } from "@zcode/shared";

const OPERATION_LOGS_REQUEST = -8311;

interface UpdateInflightProbe {
  updatingSeen: boolean;
  connectResult?: unknown;
  responses: number[][];
  restore(): void;
}

declare global {
  interface Window {
    __updateInflightProbe?: UpdateInflightProbe;
  }
}

/**
 * 真实 updating 事件到达时，经平台连接入口对同一设备再发起一次连接（模拟向导以外的入口），
 * 连接返回后立即读取该设备的操作日志，用来判断更新日志是否被这次连接替换。
 */
export async function connectDuringNextSourceUpdate(input: {
  sourceServerId: string;
  profileId: string;
  target: RemoteTarget;
}): Promise<void> {
  const logsWriter = new BufferWriter();
  serialize(logsWriter, [
    100,
    OPERATION_LOGS_REQUEST,
    ISourceServerManagementService.channelName,
    "getRecentOperationLogs",
  ]);
  serialize(logsWriter, [input.profileId]);
  await browser.execute(
    (channel, sourceId, target, logsRequest) => {
      const original = MessagePort.prototype.postMessage;
      let port: MessagePort | undefined;
      const probe: UpdateInflightProbe = {
        updatingSeen: false,
        responses: [],
        restore() {
          MessagePort.prototype.postMessage = original;
          port?.removeEventListener("message", receive);
          delete window.__updateInflightProbe;
        },
      };
      function receive(this: MessagePort, event: MessageEvent) {
        if (!(event.data instanceof Uint8Array)) return;
        probe.responses.push(Array.from(event.data));
        const text = new TextDecoder().decode(event.data);
        if (probe.updatingSeen || !text.includes('"state":"updating"') || !text.includes(sourceId))
          return;
        probe.updatingSeen = true;
        const bridge = (
          window as unknown as {
            zcode: { connectRemote(target: unknown, requestId: string): Promise<unknown> };
          }
        ).zcode;
        void bridge.connectRemote(target, `e2e-update-inflight-${Date.now()}`).then(
          (result) => {
            probe.connectResult = result;
            original.call(this, Uint8Array.from(logsRequest));
          },
          (error: unknown) => {
            probe.connectResult = { thrown: String(error) };
          },
        );
      }
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (!port && message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (text.includes(channel) && text.includes("updateSource")) {
            port = this;
            this.addEventListener("message", receive);
          }
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__updateInflightProbe = probe;
    },
    ISourceServerManagementService.channelName,
    input.sourceServerId,
    input.target,
    Array.from(logsWriter.buffer.buffer),
  );
}

export async function readUpdateInflightEvidence() {
  const probe = await browser.execute(() => {
    const probe = window.__updateInflightProbe;
    return probe
      ? {
          updatingSeen: probe.updatingSeen,
          connectResult: probe.connectResult,
          responses: probe.responses,
        }
      : null;
  });
  if (!probe) throw new Error("Missing update inflight probe");
  const frames = probe.responses.map((bytes) => {
    const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)));
    return { header: deserialize(reader) as [number, number], body: deserialize(reader) };
  });
  return {
    updatingSeen: probe.updatingSeen,
    connectResult: probe.connectResult as
      | { success?: boolean; reasonCode?: string; error?: string; thrown?: string }
      | undefined,
    operationLogs: frames.find(
      (frame) => frame.header[0] === 201 && frame.header[1] === OPERATION_LOGS_REQUEST,
    )?.body as
      | Array<{ operation: string; phase: string; level: string; message: string }>
      | undefined,
    states: frames
      .filter((frame) => frame.header[0] === 204 && frame.body?.state)
      .map((frame) => frame.body.state as { profileId: string; state: string; errorCode?: string }),
  };
}

export async function restoreUpdateInflightProbe(): Promise<void> {
  await browser.execute(() => window.__updateInflightProbe?.restore());
}

interface SourceManagementRpcProbe {
  ready: boolean;
  /** 已发出、尚未收到响应的受控请求；值为响应帧字节。 */
  results: Record<string, number[] | undefined>;
  /** 被暂挂的 confirmIdentityChange 请求帧；release 后按原顺序发出。 */
  heldConfirm: number[][];
  holdConfirm: boolean;
  send(key: string, request: number[], prefixes: number[][]): void;
  release(): void;
  restore(): void;
}

declare global {
  interface Window {
    __sourceManagementRpc?: SourceManagementRpcProbe;
  }
}

let managementRequestId = -8500;

/**
 * 复用 Window Host 的 source-server-management 端口发出受控请求（模拟设置页、更新提示或另一窗口），
 * 并可暂挂向导发出的 confirmIdentityChange，制造“确认身份进行中”的稳定窗口。
 */
export async function installSourceManagementRpc(): Promise<void> {
  await browser.execute((channel) => {
    if (window.__sourceManagementRpc) return;
    const original = MessagePort.prototype.postMessage;
    let port: MessagePort | undefined;
    const probe: SourceManagementRpcProbe = {
      ready: false,
      results: {},
      heldConfirm: [],
      holdConfirm: false,
      send(key, request, prefixes) {
        if (!port) throw new Error("source-server-management port unavailable");
        const target = port;
        probe.results[key] = undefined;
        const receive = (event: MessageEvent) => {
          if (!(event.data instanceof Uint8Array)) return;
          if (!prefixes.some((prefix) => prefix.every((byte, i) => event.data[i] === byte))) return;
          target.removeEventListener("message", receive);
          probe.results[key] = Array.from(event.data);
        };
        target.addEventListener("message", receive);
        original.call(target, Uint8Array.from(request));
      },
      release() {
        probe.holdConfirm = false;
        const frames = probe.heldConfirm.splice(0);
        if (port) for (const frame of frames) original.call(port, Uint8Array.from(frame));
      },
      restore() {
        probe.release();
        MessagePort.prototype.postMessage = original;
        delete window.__sourceManagementRpc;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channel)) {
          // RPC 端口由平台回调的 this 提供，受控请求必须复用同一端口。
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          port = this;
          probe.ready = true;
          if (probe.holdConfirm && text.includes("confirmIdentityChange")) {
            probe.heldConfirm.push(Array.from(message));
            return;
          }
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__sourceManagementRpc = probe;
  }, ISourceServerManagementService.channelName);
}

export async function waitForSourceManagementRpcReady(caseMarker: string): Promise<void> {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__sourceManagementRpc?.ready)),
    { timeout: 60_000, timeoutMsg: `${caseMarker}: 没有捕获 source-server-management 端口` },
  );
}

/** 发出请求但不等待（更新可能持续数分钟，不能占住 WebDriver 脚本超时）；返回读取结果用的 key。 */
export async function startSourceManagementCall(method: string, args: unknown[]): Promise<string> {
  const id = managementRequestId--;
  const writer = new BufferWriter();
  serialize(writer, [100, id, ISourceServerManagementService.channelName, method]);
  serialize(writer, args);
  const prefixes = [201, 202, 203].map((type) => {
    const prefix = new BufferWriter();
    serialize(prefix, [type, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const key = String(id);
  await browser.execute(
    (requestKey, request, responsePrefixes) =>
      window.__sourceManagementRpc!.send(requestKey, request, responsePrefixes),
    key,
    Array.from(writer.buffer.buffer),
    prefixes,
  );
  return key;
}

type SourceManagementCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

/** 读取受控请求的结果：未返回时为 undefined；失败时 ok=false 并带错误消息与 Host 透传的错误码。 */
export async function readSourceManagementCall<T>(
  key: string,
): Promise<SourceManagementCallResult<T> | undefined> {
  const bytes = await browser.execute(
    (requestKey) => window.__sourceManagementRpc?.results[requestKey],
    key,
  );
  if (!bytes) return undefined;
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] === 201) return { ok: true, value: body as T };
  return {
    ok: false,
    error: typeof body === "string" ? body : String(body?.message ?? body),
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
  };
}

export async function callSourceManagement<T>(method: string, args: unknown[] = []): Promise<T> {
  const key = await startSourceManagementCall(method, args);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await readSourceManagementCall<T>(key);
    if (result) {
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
    if (Date.now() > deadline) throw new Error(`source-server-management.${method} 没有返回`);
    await browser.pause(200);
  }
}

export async function holdConfirmIdentityChange(): Promise<void> {
  await browser.execute(() => {
    window.__sourceManagementRpc!.holdConfirm = true;
  });
}

export async function readHeldConfirmIdentityChangeCount(): Promise<number> {
  return browser.execute(() => window.__sourceManagementRpc?.heldConfirm.length ?? 0);
}

export async function releaseConfirmIdentityChange(): Promise<void> {
  await browser.execute(() => window.__sourceManagementRpc?.release());
}

export async function restoreSourceManagementRpc(): Promise<void> {
  await browser.execute(() => window.__sourceManagementRpc?.restore());
}
