import {
  TopicWireFrameAssembler,
  type TopicWireAssemblyEvent,
  type TopicWireAssemblyFault,
  type TopicFrameDeliveryKind,
  type TopicWireFrameCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

export interface TopicWireDecoder {
  accept(wire: TopicWireFrameCandidate): void;
  /** same-sub recovery：只清 fail-closed flag，保留 assembler ordinal tombstone。 */
  recover(topic: string, subscriptionId: string): void;
  discard(topic: string, subscriptionId: string): void;
  clear(): void;
}

/**
 * renderer 侧 physical → logical 原子边界。assembler 只在齐片且校验通过时
 * 产出 logical frame；30s timeout 用单个最近到期 timer 驱动，避免每片建 timer。
 */
export function createTopicWireDecoder<F extends { topic: string; subscriptionId: string }>(
  assembler: TopicWireFrameAssembler<F>,
  deliver: (frame: F, deliveryKind: TopicFrameDeliveryKind) => void,
  onFault?: (fault: TopicWireAssemblyFault) => void,
): TopicWireDecoder {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const faultedRoutes = new Set<string>();
  const routeKey = (topic: string, subscriptionId: string) => `${topic}\0${subscriptionId}`;

  const handleEvents = (events: TopicWireAssemblyEvent<F>[]): void => {
    const faults = events.filter((event) => event.kind === "fault");
    const failedInBatch = new Set<string>();
    const healingRoutes = new Set<string>();
    for (const event of events) {
      if (event.kind === "complete" && event.deliveryKind === "recovery") {
        healingRoutes.add(routeKey(event.frame.topic, event.frame.subscriptionId));
      }
    }
    for (const { fault } of faults) {
      const key = routeKey(fault.topic, fault.subscriptionId);
      // assembler.accept 会先 expire 旧 assembly，再处理当前 wire。若当前 wire 是
      // 已完整校验的更高 ordinal recovery，同批旧 online timeout 已被它权威覆盖，
      // 不得先上报 fault 再把 recovery 丢掉。
      if (healingRoutes.has(key)) continue;
      failedInBatch.add(key);
      faultedRoutes.add(key);
      assembler.abort(fault.topic, fault.subscriptionId);
      // Bug 根因：这里原来是 logger.warn，而生产构建下 renderer 的 logger.warn 是完全的
      // no-op（见 logger.ts 的 isRendererProductionBuild）。组装拒收是 fail-closed 链路的
      // **第一环**——后面 contentRejected 的终态由它衍生——但打包版里它一行都不落盘，用户
      // 报 `fault.subscription.contentRejected` 时无从查起（2026-11-03 现场即如此：dev 构建
      // 可证未触发，打包版无法证实也无法排除）。改走 lifecycle 通道，让打包版保留这条诊断。
      logger.lifecycle.warn("v4 topic wire physical assembly rejected", {
        deliveryKind: fault.deliveryKind,
        event: "v4.topic_wire.physical_assembly.rejected",
        logicalFrameId: fault.logicalFrameId,
        logicalFrameOrdinal: fault.logicalFrameOrdinal,
        module: "ui.v4.topic_wire_decoder",
        reasonCode: fault.reasonCode,
        subscriptionId: fault.subscriptionId,
        topic: fault.topic,
      });
      onFault?.(fault);
    }
    for (const event of events) {
      if (event.kind !== "complete") continue;
      const key = routeKey(event.frame.topic, event.frame.subscriptionId);
      if (event.deliveryKind === "recovery") faultedRoutes.delete(key);
      // 同一次 accept 可能是 [superseded fault(A), complete(A)]，同 route 必须
      // fail closed；但 accept(B) 也会顺带 expire 其他 route A，不能因此误丢健康 B。
      if (failedInBatch.has(key) || faultedRoutes.has(key)) continue;
      deliver(event.frame, event.deliveryKind);
    }
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        handleEvents(assembler.expire(Date.now()));
        scheduleExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
  };

  return {
    accept(wire) {
      const key = routeKey(wire.topic, wire.subscriptionId);
      if (faultedRoutes.has(key)) {
        // resync 在途时迟到旧 online 残片仍可能 fault 并关闭 route；
        // 真正 recovery 随后会被旧 gate 永久吞掉。deliveryKind 是 publisher
        // 权威信封事实，因此只有 exact recovery 可原子解 gate，绝不按 RPC 时序猜测。
        if (wire.deliveryKind !== "recovery") return;
        faultedRoutes.delete(key);
        assembler.abort(wire.topic, wire.subscriptionId);
      }
      handleEvents(assembler.accept(wire));
      scheduleExpiry();
    },
    recover(topic, subscriptionId) {
      // faultedRoutes 不能只靠 unsubscribe/discard 清理：否则 same-sub
      // recovery 的更高 ordinal 会被永久吞掉。这里只解 fail-closed 门，assembler
      // 的 settled ordinal 保留，迟到旧 fragment 仍会静默丢弃。
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.abort(topic, subscriptionId);
      scheduleExpiry();
    },
    discard(topic, subscriptionId) {
      faultedRoutes.delete(routeKey(topic, subscriptionId));
      assembler.discard(topic, subscriptionId);
      scheduleExpiry();
    },
    clear() {
      faultedRoutes.clear();
      assembler.clear();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
    },
  };
}
