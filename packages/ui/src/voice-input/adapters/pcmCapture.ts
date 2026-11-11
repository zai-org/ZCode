/**
 * 麦克风 PCM 采集：getUserMedia → AudioWorklet → 16kHz 单声道 PCM16LE，每 100ms（3200 字节）一块。
 *
 * AudioContext 直接以 16kHz 创建，由 Chromium 完成重采样，worklet 只做 Float32 → Int16 和分块。
 * 第一版只在桌面端（Electron/Chromium）启用，不需要兼容不支持自定义采样率的浏览器。
 */
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600;

// worklet 必须是独立脚本；用 Blob URL 加载，桌面 file:// 与开发服务器下行为一致。
const WORKLET_SOURCE = `
class ZCodePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(${CHUNK_SAMPLES});
    this.offset = 0;
    this.peak = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data !== "flush" || !this.running) return;
      this.running = false;
      if (this.offset > 0) this.post(this.buffer.slice(0, this.offset));
      this.port.postMessage({ type: "flushed" });
    };
  }
  post(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice();
    this.port.postMessage({ type: "audio", bytes, peak: this.peak }, [bytes.buffer]);
    this.peak = 0;
  }
  process(inputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (let c = 0; c < channels.length; c++) value += channels[c][i];
      value /= channels.length;
      const abs = value < 0 ? -value : value;
      if (abs > this.peak) this.peak = abs;
      const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
      this.buffer[this.offset++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      if (this.offset === ${CHUNK_SAMPLES}) {
        this.post(this.buffer);
        this.buffer = new Int16Array(${CHUNK_SAMPLES});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("zcode-pcm-capture", ZCodePcmCapture);
`;

export interface PcmCaptureStats {
  /** 本次录音的峰值电平，满量程为 1 */
  peak: number;
  durationMs: number;
  /** 本次采集并交给 onChunk 的 PCM 总字节数（含 flush 出的尾块） */
  bytes: number;
}

export interface PcmCapture {
  /** 停止采集，发出剩余音频后返回统计 */
  stop(): Promise<PcmCaptureStats>;
  /** 立即释放设备，不再发出音频 */
  abort(): void;
}

export async function startPcmCapture(handlers: {
  /** chunk：100ms PCM16；peak：该块的峰值电平（满量程 1），用于音量点阵 */
  onChunk: (chunk: Uint8Array, peak: number) => void;
  /** 录音中设备断开（音轨 ended） */
  onEnded: () => void;
}): Promise<PcmCapture> {
  // getUserMedia 的 DOMException 原样抛出，由调用方按 name 分类。
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let released = false;
  let peak = 0;
  let samples = 0;
  const release = () => {
    if (released) return;
    released = true;
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    release();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "zcode-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  let resolveFlushed: (() => void) | null = null;
  node.port.onmessage = (
    event: MessageEvent<{ type: string; bytes?: Uint8Array; peak?: number }>,
  ) => {
    if (released) return;
    if (event.data.type === "audio" && event.data.bytes) {
      peak = Math.max(peak, event.data.peak ?? 0);
      samples += event.data.bytes.byteLength / 2;
      handlers.onChunk(event.data.bytes, event.data.peak ?? 0);
    } else if (event.data.type === "flushed") {
      resolveFlushed?.();
    }
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (!released) handlers.onEnded();
    });
  }
  source.connect(node);
  return {
    async stop() {
      if (!released) {
        const flushed = new Promise<void>((resolve) => {
          resolveFlushed = resolve;
        });
        node.port.postMessage("flush");
        await flushed;
      }
      release();
      return { peak, durationMs: (samples / SAMPLE_RATE) * 1000, bytes: samples * 2 };
    },
    abort: release,
  };
}
