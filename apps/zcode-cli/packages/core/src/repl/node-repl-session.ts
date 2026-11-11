import { createContext, runInContext, type Context } from "node:vm";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { IifeContextExecutor, type ReplExecutor } from "./executors.js";
import {
  PROCESS_MODULE_IDS,
  createReplRequire,
  createProtocolSafeProcessFacade,
  normalizeReplError,
  stringifyReplResult,
} from "./node-repl-runtime-helpers.js";

/** REPL 收集的图片（nodeRepl.emitImage）。 */
export interface NodeReplImage {
  base64: string;
  mimeType: string;
}

/** SDK/bridge 结果块；保持 MCP 的结构化字段，但不让 core 依赖 MCP SDK 类型。 */
export interface NodeReplStructuredResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * 本次 cell 操作的目标应用身份（Computer Use）。
 *
 * 只由宿主的 CUA bridge 在收到 broker 响应时记录 —— 它不在 cell 可写的 REPL globals 上，模型改不到。
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 都是模型可写通道，经它们到达的
 * producer 应用元数据不可信，必须在 toMcpRunResult 里丢弃。
 */
export interface NodeReplCuaAppIdentity {
  appKey: string;
  displayName?: string;
}

/** 输出 sink：REPL 内 nodeRepl.write / console 汇聚到这里；emitImage 收集图片。 */
export interface NodeReplWriteSink {
  write(text: string): void;
  images: NodeReplImage[];
  browserScreenshots: NodeReplImage[];
  structuredResults: NodeReplStructuredResult[];
  responseMeta: Record<string, unknown>;
  cuaApps: NodeReplCuaAppIdentity[];
}

export interface NodeReplRunResult {
  /** 最后值/返回值的字符串化（可能为 undefined）。 */
  result?: string;
  /** 本次 run 期间 nodeRepl.write + console 收集的输出。 */
  logs: string;
  /** 抛错时的结构化错误（不崩进程）。 */
  error?: { name: string; message: string; stack?: string };
  /** 本次 run 期间 nodeRepl.emitImage 收集的图片（如截图）。 */
  images?: NodeReplImage[];
  /** images 中确认来自本次显式 tab.screenshot() 的索引。 */
  browserScreenshotImageIndices?: number[];
  /** SDK 通过专用通道写入的结构化结果；优先级高于 console/REPL 回显。 */
  structuredResults?: NodeReplStructuredResult[];
  /** 本次 run 期间 nodeRepl.setResponseMeta 设置的元数据。 */
  responseMeta?: Record<string, unknown>;
  /** 本次 cell 最后一个确立身份的 CUA 调用所操作的应用；由宿主 bridge 记录，模型不可写。 */
  cuaApp?: NodeReplCuaAppIdentity;
}

export type NodeReplRequestMeta = Record<string, unknown>;

export interface NodeReplSessionOptions {
  /** 注入到 REPL globals 的额外全局（如 browser execute 桥、agent 对象）。 */
  injectedGlobals?: Record<PropertyKey, unknown> | (() => Record<PropertyKey, unknown>);
  /** MCP stdio runtime 使用协议保护 process facade，防止 cell 关闭进程或写坏协议 stdout；不限制 cell 的能力。 */
  protectProtocolStdio?: boolean;
}

function browserScreenshotIndexResult(
  images: readonly NodeReplImage[],
  browserScreenshots: readonly NodeReplImage[],
): Pick<NodeReplRunResult, "browserScreenshotImageIndices"> {
  const browserScreenshotImageIndices = matchBrowserScreenshotImageIndices(images, browserScreenshots);
  return browserScreenshotImageIndices.length > 0 ? { browserScreenshotImageIndices } : {};
}

/**
 * images 中哪些下标是真实浏览器截图：按 mimeType + 字节逐个匹配，同一张截图只能认领一次。
 * node-repl-host 主线程用它把账本里记下的截图对应到 cell 输出的图片上
 * （apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「结果组装」）。
 */
export function matchBrowserScreenshotImageIndices(
  images: readonly NodeReplImage[],
  browserScreenshots: readonly NodeReplImage[],
): number[] {
  if (images.length === 0 || browserScreenshots.length === 0) return [];

  const remainingByPayload = new Map<string, number>();
  for (const screenshot of browserScreenshots) {
    const key = `${screenshot.mimeType}\u0000${screenshot.base64}`;
    remainingByPayload.set(key, (remainingByPayload.get(key) ?? 0) + 1);
  }

  const browserScreenshotImageIndices: number[] = [];
  images.forEach((image, index) => {
    const key = `${image.mimeType}\u0000${image.base64}`;
    const remaining = remainingByPayload.get(key) ?? 0;
    if (remaining <= 0) return;
    browserScreenshotImageIndices.push(index);
    remainingByPayload.set(key, remaining - 1);
  });
  return browserScreenshotImageIndices;
}

/**
 * 一个 cell 里多次 CUA 调用时取最后一个确立身份的那个，与 `_meta` 既有的 last-write-wins 一致。
 * 不产生 primary 的调用（list_apps 的 items 模式、request_access / stop 的 none）根本不会
 * 进入这个数组，所以不会把前面动作的身份覆盖掉。
 */
function latestCuaAppResult(
  cuaApps: readonly NodeReplCuaAppIdentity[],
): Pick<NodeReplRunResult, "cuaApp"> {
  const cuaApp = cuaApps.at(-1);
  return cuaApp ? { cuaApp } : {};
}

/**
 * NodeReplSession：调用方进程内的持久 JavaScript 执行引擎。
 *
 * 每个 session 一个实例；REPL globals 即模型看到的 globalThis，并在多次 run() 之间保持状态。
 * 顶层 await 由 async IIFE 执行，动态加载通过注入的 importModule() 完成，结果统一结构化返回。
 *
 * 能力说明：cell 以 agent 的权限运行、没有沙箱，可加载任意模块、读写文件、启动子进程。
 * vm context 只隔离每次调用的全局状态；协议保护 process facade 只保护 MCP stdio 与宿主进程生命周期。
 * MCP 入口的 js 按 high/system 审批，不经过 Bash 的 guarded 危险命令匹配。
 */
export class NodeReplSession {
  private context: Context;
  private readonly createInjectedGlobals: () => Record<PropertyKey, unknown>;
  private readonly protocolSafeProcess: Readonly<Record<string, unknown>> | undefined;
  private currentSink: NodeReplWriteSink | null = null;
  private nodeReplApi: {
    requestMeta: NodeReplRequestMeta;
    emitStructuredResult: (result: unknown) => void;
  } | null = null;
  private disposed = false;
  private cleanupContextResources: () => void = () => undefined;
  /** 执行+持久策略（默认路线 B）；切换 executor 即切换路线，run 主体不变。 */
  private readonly executor: ReplExecutor;

  constructor(options: NodeReplSessionOptions = {}) {
    const injectedGlobals = options.injectedGlobals;
    this.createInjectedGlobals =
      typeof injectedGlobals === "function" ? injectedGlobals : () => injectedGlobals ?? {};
    this.protocolSafeProcess = options.protectProtocolStdio
      ? createProtocolSafeProcessFacade()
      : undefined;
    this.executor = new IifeContextExecutor();
    this.context = this.buildContext();
  }

  private buildContext(): Context {
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const scopedSetTimeout = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        callback(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    };
    const scopedClearTimeout = (handle: ReturnType<typeof setTimeout>) => {
      timeouts.delete(handle);
      clearTimeout(handle);
    };
    const scopedSetInterval = (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setInterval(callback, delay, ...args);
      intervals.add(handle);
      return handle;
    };
    const scopedClearInterval = (handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle);
      clearInterval(handle);
    };
    this.cleanupContextResources = () => {
      for (const handle of timeouts) clearTimeout(handle);
      for (const handle of intervals) clearInterval(handle);
      timeouts.clear();
      intervals.clear();
    };
    // console tee 到当前 sink（每次 run 前设置），同时保留原始 console 便于调试。
    const teeConsole = {
      log: (...args: unknown[]) => this.emit(args),
      info: (...args: unknown[]) => this.emit(args),
      warn: (...args: unknown[]) => this.emit(args),
      error: (...args: unknown[]) => this.emit(args),
      debug: (...args: unknown[]) => this.emit(args),
    };
    // 用当前工作目录作 require 基准。
    const req = createReplRequire(createRequire(`${process.cwd()}/`), this.protocolSafeProcess);
    const nodeReplApi = {
      cwd: process.cwd(),
      homeDir: homedir(),
      tmpDir: tmpdir(),
      requestMeta: {} as NodeReplRequestMeta,
      write: (text: string) => this.emit([text]),
      // 把图片（如 tab.screenshot 结果）作为 image 内容块回给模型；接受 bytes/base64/dataUrl。
      emitImage: (image: unknown) => this.emitImage(image),
      // SDK 结果必须走结构化通道；否则模型的 console.log 会把 image/image_ref 拆成普通文本，
      // 官方 CUA 的精确帧校验就无法确认这两块仍然相邻且未被改写。
      emitStructuredResult: (result: unknown) => this.emitStructuredResult(result),
      setResponseMeta: (meta: unknown) => this.setResponseMeta(meta),
    };
    this.nodeReplApi = nodeReplApi;
    const replGlobals: Record<PropertyKey, unknown> = {
      console: teeConsole,
      process: this.protocolSafeProcess ?? process,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: scopedSetTimeout,
      clearTimeout: scopedClearTimeout,
      setInterval: scopedSetInterval,
      clearInterval: scopedClearInterval,
      queueMicrotask,
      structuredClone,
      require: req,
      // 动态加载模块。用注入函数而非裸 import()：vm 里的 import() 需要 --experimental-vm-modules
      // 启动 flag（agent 是打包 binary，不便加 flag）；importModule 直通宿主 import()，无需 flag。
      // 模型与 browser skill 使用标准 await import("...")；executor 会按 AST 安全改写到该 loader。
      importModule: (specifier: string) => this.importModule(specifier),
      nodeRepl: nodeReplApi,
      // 每次 kernel reset 都重建 browser-client facade；旧 context 中的 browser/tab binding
      // 不能跨 reset 漂移到新 generation，保持新会话 bootstrap 边界一致。
      ...this.createInjectedGlobals(),
    };
    const context = createContext(replGlobals);
    // globalThis 自引用，让模型可用 globalThis.x = ... 显式持久化。
    runInContext("globalThis.globalThis = globalThis;", context);
    return context;
  }

  private emit(args: unknown[]): void {
    if (!this.currentSink) {
      return;
    }
    const text = args
      .map((a) => (typeof a === "string" ? a : (stringifyReplResult(a) ?? "undefined")))
      .join(" ");
    this.currentSink.write(text);
  }

  /**
   * 收集一张图片到本次 run 输出（供 formatModelContent 转成 image 内容块给模型）。
   * 接受 Uint8Array/Buffer/number[]、data URL，或 { base64 | bytes, mimeType }。
   * 入参非法时抛 TypeError，让模型直接看到用法错误。
   */
  private emitImage(image: unknown): void {
    if (!this.currentSink) {
      return;
    }
    const directBytes =
      (ArrayBuffer.isView(image) && !(image instanceof DataView)) || Array.isArray(image)
        ? (image as Uint8Array | number[])
        : null;
    const rec =
      directBytes !== null
        ? { bytes: directBytes }
        : ((image ?? {}) as {
            base64?: unknown;
            bytes?: unknown;
            dataUrl?: unknown;
            mimeType?: unknown;
          });
    let base64: string | null = null;
    let dataUrlMimeType: string | undefined;
    if (typeof rec.dataUrl === "string") {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(rec.dataUrl);
      if (match) {
        dataUrlMimeType = match[1];
        base64 = match[2];
      }
    } else if (typeof rec.base64 === "string" && rec.base64.length > 0) {
      base64 = rec.base64;
    } else if (rec.bytes != null) {
      try {
        base64 = Buffer.from(rec.bytes as Uint8Array | readonly number[]).toString("base64");
      } catch {
        base64 = null;
      }
    }
    if (!base64) {
      throw new TypeError(
        "nodeRepl.emitImage requires bytes, dataUrl, { base64 }, or { bytes }; e.g. emitImage(await tab.screenshot())",
      );
    }
    const mimeType =
      typeof rec.mimeType === "string" && rec.mimeType
        ? rec.mimeType
        : (dataUrlMimeType ?? "image/png");
    this.currentSink.images.push({ base64, mimeType });
  }

  private setResponseMeta(meta: unknown): void {
    if (!this.currentSink) return;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new TypeError("nodeRepl.setResponseMeta requires a plain object");
    }
    Object.assign(this.currentSink.responseMeta, meta as Record<string, unknown>);
  }

  private emitStructuredResult(result: unknown): void {
    if (!this.currentSink) return;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a result object");
    }
    const candidate = result as { content?: unknown };
    if (!Array.isArray(candidate.content)) {
      throw new TypeError("nodeRepl.emitStructuredResult requires a content array");
    }
    for (const block of candidate.content) {
      if (!block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string") {
        throw new TypeError("nodeRepl.emitStructuredResult content blocks require a type");
      }
    }
    this.currentSink.structuredResults.push(result as NodeReplStructuredResult);
  }

  /** browser-client transport 在同一次 js run 内把 backend meta 合并进工具结果。 */
  mergeResponseMeta(meta: Record<string, unknown>): void {
    if (!this.currentSink) return;
    const currentSurface = this.currentSink.responseMeta["zcode/toolSurface"];
    const nextSurface = meta["zcode/toolSurface"];
    // 工具结果需保留同一 cell 内最后一次成功 side-effect 的 openTabIds/sessionEnded。ZCode 不做
    // 自动 preview，但同一 cell 后续 title/url/domSnapshot 读取不能把先前动作 meta 覆盖掉。
    if (
      currentSurface &&
      typeof currentSurface === "object" &&
      !Array.isArray(currentSurface) &&
      nextSurface &&
      typeof nextSurface === "object" &&
      !Array.isArray(nextSurface)
    ) {
      this.setResponseMeta({
        ...meta,
        "zcode/toolSurface": {
          ...(currentSurface as Record<string, unknown>),
          ...(nextSurface as Record<string, unknown>),
        },
      });
      return;
    }
    this.setResponseMeta(meta);
  }

  /** browser transport 记录模型显式 screenshot 的原始图片，供 emitImage 结果做来源对应。 */
  recordBrowserScreenshot(image: NodeReplImage): void {
    if (!this.currentSink) return;
    this.currentSink.browserScreenshots.push(image);
  }

  /**
   * CUA bridge 从 broker 响应记录本次调用的目标应用身份。
   *
   * 刻意不放进 REPL globals（对比 write/emitImage/emitStructuredResult/setResponseMeta）：
   * 工具卡据此显示 App 图标，模型能写就能声称自己操作了别的应用。
   */
  recordCuaAppIdentity(app: NodeReplCuaAppIdentity): void {
    if (!this.currentSink) return;
    this.currentSink.cuaApps.push(app);
  }

  /** 执行一段代码；signal 支持取消（超时/停止）。 */
  async run(
    code: string,
    options: {
      signal?: AbortSignal;
      requestMeta?: NodeReplRequestMeta;
      syncTimeoutMs?: number;
    } = {},
  ): Promise<NodeReplRunResult> {
    if (this.disposed) {
      return {
        logs: "",
        error: { name: "DisposedError", message: "REPL session 已释放" },
      };
    }
    let buffer = "";
    const images: NodeReplImage[] = [];
    const browserScreenshots: NodeReplImage[] = [];
    const structuredResults: NodeReplStructuredResult[] = [];
    const responseMeta: Record<string, unknown> = {};
    const cuaApps: NodeReplCuaAppIdentity[] = [];
    if (this.nodeReplApi) {
      this.nodeReplApi.requestMeta = { ...options.requestMeta };
    }
    this.currentSink = {
      write: (text: string) => {
        buffer += (buffer ? "\n" : "") + text;
      },
      images,
      browserScreenshots,
      structuredResults,
      responseMeta,
      cuaApps,
    };
    try {
      // 执行委托给 executor（默认路线 B：instrument 顶层声明 → async-IIFE → runInContext），
      // 使顶层 const/let/var/function/class 跨 js 调用持久（复制到 globalThis）。
      const value = await this.executor.run(
        code,
        this.context,
        options.signal,
        options.syncTimeoutMs,
      );
      return {
        result: stringifyReplResult(value),
        logs: buffer,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } catch (error) {
      // 注意：vm context 内抛出的 Error 属于不同 realm，host 侧 `instanceof Error` 为 false。
      // 因此按 error-like 结构（有 name/message/stack 字段）鸭子提取，而非包装成新 Error
      // （包装会把 message 变成 "Error: boom" 丢失原始 message）。
      const normalized = normalizeReplError(error);
      const mustResetKernel =
        normalized.name === "AbortError" ||
        normalized.name === "TimeoutError" ||
        normalized.message.includes("Script execution timed out");
      if (mustResetKernel && !this.disposed) {
        // Promise.race 只能停止等待，旧 async continuation/timer 仍可能在同一 global 上
        // 继续写状态。取消或 VM timeout 后废弃整个 context，并清掉该 generation 的 timers；
        // 后续调用只能看到 fresh kernel，不能观察到迟到 mutation。
        this.cleanupContextResources();
        this.context = this.buildContext();
        // 静默重建 context 会让模型继续调用已清除的 browser/tab 变量，
        // 将一次 timeout 扩大成连续 ReferenceError。错误本身必须暴露 reset 语义和恢复动作。
        normalized.message = `${normalized.message}; kernel reset, all previous bindings were cleared; reinitialize browser/tab bindings before rerunning`;
      }
      return {
        logs: buffer,
        error: normalized,
        ...(images.length > 0 ? { images } : {}),
        ...browserScreenshotIndexResult(images, browserScreenshots),
        ...(structuredResults.length > 0 ? { structuredResults } : {}),
        ...(Object.keys(responseMeta).length > 0 ? { responseMeta } : {}),
        ...latestCuaAppResult(cuaApps),
      };
    } finally {
      this.currentSink = null;
      if (this.nodeReplApi) {
        this.nodeReplApi.requestMeta = {};
      }
    }
  }

  private async importModule(specifier: string): Promise<unknown> {
    if (this.protocolSafeProcess && PROCESS_MODULE_IDS.has(specifier)) {
      return { ...this.protocolSafeProcess, default: this.protocolSafeProcess };
    }
    return await import(specifier);
  }

  /** 释放资源。 */
  dispose(): void {
    this.disposed = true;
    this.cleanupContextResources();
    this.currentSink = null;
  }
}
