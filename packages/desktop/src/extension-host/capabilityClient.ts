import {
  ExtensionError,
  capabilitySubscriptionMessageSchema,
  getCapabilityDef,
  isExtensionError,
  type CapabilitySubscriptionErrorListener,
  type IExtensionWindowChannel,
} from "@zcode/shared/extension-host";
import { hostLog, runAsPlugin } from "#src/extension-host/runtime.js";

// 能力部分的通用包装（docs/plugins/extension-host.md §7.2）：
// call 包成 (input) => Promise<output>；subscribe 包成 (listener, onError?) => Disposable。
// 第一个监听注册时向 Window Host 订阅，最后一个回收时退订；Window Host 重连后自动重新订阅。
// 订阅的事件是信封（§17.3「订阅的错误」）：error 结束这条订阅，通知每个监听的 onError，之后不再重订。

interface Subscription {
  key: string;
  pluginId: string;
  capabilityId: string;
  input: unknown;
  /** 监听 → 它的 onError（没有给时为 undefined）。 */
  listeners: Map<(event: unknown) => void, CapabilitySubscriptionErrorListener | undefined>;
  remote: { dispose(): void } | null;
}

export class CapabilityClient {
  private channel: IExtensionWindowChannel | null = null;
  private readonly subscriptions = new Map<string, Subscription>();

  /** 新连上一个 Window Host：重新订阅仍在监听的能力。 */
  attach(channel: IExtensionWindowChannel): void {
    this.detach();
    this.channel = channel;
    for (const subscription of this.subscriptions.values()) this.openRemote(subscription);
  }

  /** Window Host 断开：能力调用返回 host-unavailable，订阅暂停，监听保留。 */
  detach(): void {
    this.channel = null;
    for (const subscription of this.subscriptions.values()) {
      subscription.remote?.dispose();
      subscription.remote = null;
    }
  }

  async call(pluginId: string, capabilityId: string, input: unknown): Promise<unknown> {
    const def = getCapabilityDef(capabilityId);
    if (!def || def.kind !== "call") {
      throw new ExtensionError("not-declared", `unknown capability: ${capabilityId}`);
    }
    const parsed = def.input.safeParse(input);
    if (!parsed.success) {
      throw new ExtensionError("invalid-input", `${capabilityId}: ${parsed.error.message}`);
    }
    const channel = this.channel;
    if (!channel) throw new ExtensionError("host-unavailable", "no Window Host is connected");
    try {
      return await channel.call({ pluginId, capabilityId, input: parsed.data });
    } catch (error) {
      if (isExtensionError(error)) throw new ExtensionError(error.code, error.message);
      throw new ExtensionError("internal", `${capabilityId} failed`);
    }
  }

  subscribe(
    pluginId: string,
    capabilityId: string,
    input: unknown,
    listener: (event: unknown) => void,
    onError?: CapabilitySubscriptionErrorListener,
  ): { dispose(): void } {
    const def = getCapabilityDef(capabilityId);
    if (!def || def.kind !== "subscribe") {
      throw new ExtensionError("not-declared", `unknown capability: ${capabilityId}`);
    }
    const parsed = def.input.safeParse(input);
    if (!parsed.success) {
      throw new ExtensionError("invalid-input", `${capabilityId}: ${parsed.error.message}`);
    }
    const key = JSON.stringify([pluginId, capabilityId, parsed.data ?? null]);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = {
        key,
        pluginId,
        capabilityId,
        input: parsed.data,
        listeners: new Map(),
        remote: null,
      };
      this.subscriptions.set(key, subscription);
    }
    subscription.listeners.set(listener, onError);
    if (!subscription.remote) this.openRemote(subscription);
    const current = subscription;
    return {
      dispose: () => {
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        current.remote?.dispose();
        current.remote = null;
        // 已因错误结束的订阅不在表里（或表里已是同键的新订阅）：只删自己。
        if (this.subscriptions.get(key) === current) this.subscriptions.delete(key);
      },
    };
  }

  private openRemote(subscription: Subscription): void {
    if (!this.channel || subscription.remote) return;
    const event = this.channel.onDynamicSubscribe({
      pluginId: subscription.pluginId,
      capabilityId: subscription.capabilityId,
      input: subscription.input,
    });
    let ended = false;
    const remote = event((raw) => {
      if (ended) return;
      const message = capabilitySubscriptionMessageSchema.safeParse(raw);
      if (!message.success) {
        hostLog(
          "warn",
          `dropped an invalid ${subscription.capabilityId} event`,
          subscription.pluginId,
        );
        return;
      }
      if (message.data.kind === "error") {
        ended = true;
        this.fail(subscription, new ExtensionError(message.data.code, message.data.message));
        return;
      }
      const payload = message.data.event;
      for (const listener of subscription.listeners.keys()) {
        try {
          runAsPlugin(subscription.pluginId, () => listener(payload));
        } catch (error) {
          hostLog(
            "error",
            `listener of ${subscription.capabilityId} threw: ${error instanceof Error ? error.message : String(error)}`,
            subscription.pluginId,
          );
        }
      }
    });
    // 错误可能在 event() 返回之前同步到达（准入被拒）：此时 fail 已把 remote 清掉，这里补释放。
    if (ended) remote.dispose();
    else subscription.remote = remote;
  }

  /**
   * 订阅以错误结束：从表里删掉（重连后不重订），通知每个监听的 onError。
   * 没给 onError 的按插件记一条 warn，错误不会无声消失。
   */
  private fail(subscription: Subscription, error: ExtensionError): void {
    subscription.remote?.dispose();
    subscription.remote = null;
    if (this.subscriptions.get(subscription.key) === subscription) {
      this.subscriptions.delete(subscription.key);
    }
    const listeners = [...subscription.listeners.values()];
    subscription.listeners.clear();
    if (listeners.every((onError) => !onError)) {
      hostLog(
        "warn",
        `subscription ${subscription.capabilityId} ended: ${error.code} ${error.message}`,
        subscription.pluginId,
      );
      return;
    }
    for (const onError of listeners) {
      if (!onError) continue;
      try {
        runAsPlugin(subscription.pluginId, () => onError(error));
      } catch (thrown) {
        hostLog(
          "error",
          `onError of ${subscription.capabilityId} threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
          subscription.pluginId,
        );
      }
    }
  }
}
