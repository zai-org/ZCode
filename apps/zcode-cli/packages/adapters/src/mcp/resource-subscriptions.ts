/**
 * MCP 资源订阅登记表（纯内存，无 IO）。
 * 键 = (serverName, uri) → subscriberKey 登记；同一连接被多个 session 共享时只向 server 订阅一次。
 * 已成功的登记与每次调用的待确认申请分开计数，取消不能删除此前成功或其它在途调用的登记。
 * 向 server 的实际请求、重连重放与日志都在 adapter；这里只管计数与快照。
 */
interface SubscriptionRegistration {
  committed: boolean;
  pending: number;
}

export class McpResourceSubscriptionRegistry {
  private readonly byServer = new Map<string, Map<string, Map<string, SubscriptionRegistration>>>();

  /** 在等待连接前登记本次申请；完成回调只能结算自己，不能复活被明确删除的登记。 */
  begin(
    serverName: string,
    uri: string,
    subscriberKey: string,
  ): {
    commit: () => void;
    release: () => boolean;
  } {
    const byUri =
      this.byServer.get(serverName) ?? new Map<string, Map<string, SubscriptionRegistration>>();
    this.byServer.set(serverName, byUri);
    const subscribers = byUri.get(uri) ?? new Map<string, SubscriptionRegistration>();
    const entry = subscribers.get(subscriberKey) ?? { committed: false, pending: 0 };
    entry.pending++;
    subscribers.set(subscriberKey, entry);
    byUri.set(uri, subscribers);
    let settled = false;
    const finish = (committed: boolean): boolean => {
      if (settled) return false;
      settled = true;
      if (subscribers.get(subscriberKey) !== entry) return false;
      entry.pending--;
      entry.committed ||= committed;
      if (entry.committed || entry.pending > 0) return false;
      return this.remove(serverName, uri, subscriberKey)?.last ?? false;
    };
    return {
      commit: () => {
        finish(true);
      },
      release: () => finish(false),
    };
  }

  /** 撤销一个订阅者；未登记返回 null，否则返回它是不是最后一个（此时该 uri 已从表中移除）。 */
  remove(serverName: string, uri: string, subscriberKey: string): { last: boolean } | null {
    const byUri = this.byServer.get(serverName);
    const subscribers = byUri?.get(uri);
    if (!byUri || !subscribers || !subscribers.delete(subscriberKey)) return null;
    if (subscribers.size > 0) return { last: false };
    byUri.delete(uri);
    return { last: true };
  }

  /** 按 subscriberKey 前缀清理（会话关闭）；返回因此归零、需要向 server 退订的 (server, uri)。 */
  removeByPrefix(subscriberKeyPrefix: string): Array<{ serverName: string; uri: string }> {
    const released: Array<{ serverName: string; uri: string }> = [];
    for (const [serverName, byUri] of this.byServer) {
      for (const [uri, subscribers] of byUri) {
        for (const key of subscribers.keys()) {
          if (key.startsWith(subscriberKeyPrefix)) subscribers.delete(key);
        }
        if (subscribers.size === 0) {
          byUri.delete(uri);
          released.push({ serverName, uri });
        }
      }
    }
    return released;
  }

  /** 某 uri 的订阅者（通知 resources/updated 时附上）。 */
  subscribers(serverName: string, uri: string): string[] {
    return [...(this.byServer.get(serverName)?.get(uri)?.keys() ?? [])];
  }

  /** 某 server 全部订阅者去重（通知 resources/list_changed 时附上）。 */
  allSubscribers(serverName: string): string[] {
    const out = new Set<string>();
    for (const keys of this.byServer.get(serverName)?.values() ?? []) {
      for (const key of keys.keys()) out.add(key);
    }
    return [...out];
  }

  /** 某 server 登记过的 uri（重连后重放）。 */
  uris(serverName: string): string[] {
    return [...(this.byServer.get(serverName)?.keys() ?? [])];
  }

  /** 快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [serverName, byUri] of this.byServer) {
      out[serverName] = Object.fromEntries(
        [...byUri].map(([uri, subscribers]) => [uri, subscribers.size]),
      );
    }
    return out;
  }
}
