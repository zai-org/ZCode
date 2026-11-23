/**
 * Layer 5: ProxyChannel —— 服务自动代理（杀手锏）
 *
 * 这是让 VS Code 开发者效率极高的关键抽象。
 *
 * 没有 ProxyChannel 时，你需要为每个服务手写 IServerChannel：
 *   class FileServiceChannel implements IServerChannel {
 *     call(ctx, command, arg) {
 *       switch (command) {
 *         case 'readFile': return this.service.readFile(arg[0]);
 *         case 'writeFile': return this.service.writeFile(arg[0], arg[1]);
 *         // ... 每个方法都要手动映射
 *       }
 *     }
 *   }
 *
 * 有了 ProxyChannel，一行代码搞定：
 *   const channel = ProxyChannel.fromService(fileService);
 *   // 自动把所有方法映射为 call，所有 on* 事件映射为 listen
 *
 * 客户端同样一行：
 *   const fileService = ProxyChannel.toService<IFileService>(channel);
 *   await fileService.readFile(uri);  // 就像调用本地方法！
 *
 * 原理：
 * - fromService: 遍历 service 的属性，方法 → call，on* 事件 → listen
 * - toService: 利用 ES6 Proxy 拦截属性访问，自动分派到 call/listen
 */

import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import { IChannel, IServerChannel } from "./channels.js";

// ============================================================================
// ProxyChannel
// ============================================================================

export namespace ProxyChannel {
  /**
   * 服务端：把一个 service 对象自动包装为 IServerChannel
   *
   * 约定：
   * - 以 on + 大写字母开头的属性视为事件 (如 onDidChange)
   * - 以 onDynamic + 大写字母开头的视为动态事件（方法，调用后返回事件）
   * - 其他方法视为 RPC 方法
   */
  export function fromService<TContext>(
    service: unknown,
    disposables?: DisposableStore,
  ): IServerChannel<TContext> {
    const handler = service as { [key: string]: unknown };

    // 预缓存所有事件并 buffer
    const eventMap = new Map<string, Event<unknown>>();
    for (const key in handler) {
      if (isEvent(key) && !isDynamicEvent(key) && typeof handler[key] === "function") {
        // 把事件 buffer 化：即使没人订阅，事件也不会丢失
        eventMap.set(key, bufferEvent(handler[key] as Event<unknown>));
      }
    }

    return {
      listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
        // 先查缓存
        const cached = eventMap.get(event);
        if (cached) {
          return cached as Event<T>;
        }

        const target = handler[event];
        if (typeof target === "function") {
          // 动态事件：onDynamicXxx(arg) 返回一个 Event
          if (isDynamicEvent(event)) {
            return target.call(handler, arg);
          }
          // 延迟发现的事件（Proxy 服务可能不会在 for-in 中出现）
          if (isEvent(event)) {
            eventMap.set(event, bufferEvent(handler[event] as Event<unknown>));
            return eventMap.get(event) as Event<T>;
          }
        }

        throw new Error(`Event not found: ${event}`);
      },

      call<T>(_ctx: TContext, command: string, args?: any[]): Promise<T> {
        const target = handler[command];
        if (typeof target === "function") {
          let result = target.apply(handler, args || []);
          if (!(result instanceof Promise)) {
            result = Promise.resolve(result);
          }
          return result;
        }
        throw new Error(proxyMethodNotFoundMessage(command));
      },
    };
  }

  /**
   * 客户端：把一个 IChannel 包装成类型安全的 service 对象
   *
   * 利用 ES6 Proxy 拦截所有属性访问：
   * - 访问 on* → channel.listen(propKey)
   * - 访问其他 → 返回一个函数，调用时变成 channel.call(propKey, args)
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: { context?: unknown },
  ): T {
    return new Proxy({} as T, {
      get(target: T, propKey: PropertyKey, receiver: object) {
        // React 开发态、日志工具和浏览器运行时会探测对象的 Symbol / then 等内置属性。
        // 之前这里把所有未知属性都强行当成 RPC 成员处理，读取 Symbol.toStringTag 会直接抛错，
        // 读取 then 还会把普通 service 误判成 thenable，导致远程 workspace 在选目录后重渲染时炸掉。
        // 这类运行时探测属性应该回退到普通对象语义，而不是走 RPC。
        if (typeof propKey === "symbol") {
          return Reflect.get(target as object, propKey, receiver);
        }

        if (typeof propKey === "string") {
          if (propKey === "then") {
            return undefined;
          }

          // 动态事件
          if (isDynamicEvent(propKey)) {
            return (arg: unknown) => channel.listen(propKey, arg);
          }

          // 普通事件
          if (isEvent(propKey)) {
            return channel.listen(propKey);
          }

          // 方法调用
          return async (...args: unknown[]) => {
            // 可选：注入 context 作为第一个参数
            const methodArgs = options?.context !== undefined ? [options.context, ...args] : args;
            return channel.call(propKey, methodArgs);
          };
        }

        return Reflect.get(target as object, propKey, receiver);
      },
    });
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 匹配 onXxx 事件命名约定 */
function isEvent(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= 65 && // A
    name.charCodeAt(2) <= 90
  ); // Z
}

/** 匹配 onDynamicXxx 动态事件命名约定 */
function isDynamicEvent(name: string): boolean {
  return (
    name.length >= 10 &&
    name.startsWith("onDynamic") &&
    name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90
  );
}

/**
 * 缓冲事件：确保在订阅之前触发的事件不会丢失。
 * 未订阅时事件存入队列，一有订阅者就 flush。
 */
function bufferEvent<T>(event: Event<T>): Event<T> {
  let buffer: T[] = [];
  let flushing = false;
  let listener: IDisposable | undefined;

  const emitter = new Emitter<T>({
    onWillAddFirstListener: () => {
      listener = event((e) => {
        if (flushing) {
          emitter.fire(e);
        } else {
          buffer.push(e);
        }
      });
    },
    onDidRemoveLastListener: () => {
      listener?.dispose();
      listener = undefined;
      buffer = [];
    },
  });

  // 一旦有订阅者，先 flush 缓冲区
  const originalEvent = emitter.event;
  return (listener_fn) => {
    const disposable = originalEvent(listener_fn);
    if (!flushing) {
      flushing = true;
      for (const item of buffer) {
        emitter.fire(item);
      }
      buffer = [];
    }
    return disposable;
  };
}

/** ProxyChannel 对未知方法抛出的错误消息；错误跨 IPC 只保留 message。 */
export function proxyMethodNotFoundMessage(command: string): string {
  return `Method not found: ${command}`;
}

/**
 * 判断对端是否不认识某个方法（旧版本 Host / Source 没有新增方法时）。
 * 旧对端只会抛这条固定消息，没有结构化错误码，只能按消息精确匹配。
 */
export function isProxyMethodNotFoundError(error: unknown, command: string): boolean {
  return error instanceof Error && error.message === proxyMethodNotFoundMessage(command);
}
