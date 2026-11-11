import { describe, expect, it, vi } from "vitest";
import {
  createSessionEvent,
  SessionEventType,
  type SessionId,
  type TurnId,
  type SessionEvent,
} from "@zcode/contracts";
import {
  conversationSnapshotSchema,
  pluginInstallRequestPayloadSchema,
  boundPluginLocalizedText,
  filterConversationDeltasForProfile,
  DELIVERY_PROFILES,
} from "@zcode/shared/zcode-protocol-v4";
import { confirmPluginInstall } from "../src/zcode-protocol/plugin-install-interaction.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const plugin = {
  pluginId: "mail@zcode-plugins-official",
  name: "mail",
  installed: false,
  enabled: false,
  action: "install" as const,
  scope: "user" as const,
};
function setup() {
  const registry = new V4InteractionRegistry();
  const projection = new ProductProjection("session", "epoch");
  let seq = 0;
  const events: SessionEvent[] = [];
  const emitEvent = async (event: SessionEvent) => {
    event.sequenceNumber = ++seq;
    events.push(event);
    projection.applyEvent(event);
  };
  void emitEvent(
    createSessionEvent(SessionEventType.SessionCreated, "session" as SessionId, {
      mode: "build",
      contextWindow: 200_000,
    }),
  );
  void emitEvent(
    createSessionEvent(SessionEventType.TurnStarted, "session" as SessionId, {
      turnNumber: 1,
      input: "email",
    }),
  );
  return {
    registry,
    projection,
    events,
    emitEvent,
    server: { v4Interactions: registry } as ZCodeProtocolAgentServerContext,
  };
}
describe("plugin installation interaction", () => {
  const locales = () =>
    Object.fromEntries([
      ...Array.from({ length: 5_000 }, (_, index) => [`x-${index}`, '\"\n🚀'.repeat(2_000)]),
      ...["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"].map((locale) => [locale, `UI ${locale}`]),
    ]);

  it.each([
    ["count", Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`x-${n}`, "ok"]))],
    ["key", { ["x".repeat(65)]: "ok" }],
    ["characters", { en: "a".repeat(4_001) }],
    ["encoded value", { en: "\n".repeat(3_000) }],
    [
      "encoded record",
      Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`x-${n}`, "a".repeat(4_000)])),
    ],
  ])("rejects localized maps exceeding the %s budget before persistence", (_kind, map) => {
    const result = pluginInstallRequestPayloadSchema.safeParse({
      kind: "pluginInstall",
      pluginId: plugin.pluginId,
      name: plugin.name,
      descriptionI18n: map,
      reason: "Read emails",
      action: "install",
      scope: "user",
      toolCallId: "tool",
    });
    expect(result.success).toBe(false);
  });

  it("keeps supported language fallbacks, ignores invalid or inherited keys and stays idempotent", () => {
    const raw: Record<string, string> = Object.assign(Object.create({ "zh-CN": "Inherited" }), {
      ["x".repeat(65)]: "Invalid key",
      "": "Empty key",
      ...Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`x-${n}`, "extra"])),
      "en-GB": "Mail",
      "zh-TW": "郵件",
      ja: "メール",
      ru: "Почта",
      ko: "메일",
    });
    const bounded = boundPluginLocalizedText(raw)!;
    expect(Object.keys(bounded)).toHaveLength(16);
    expect(bounded).toMatchObject({
      "en-GB": "Mail",
      "zh-TW": "郵件",
      ja: "メール",
      ru: "Почта",
      ko: "메일",
    });
    expect(bounded["zh-CN"]).toBeUndefined();
    expect(bounded[""]).toBeUndefined();
    expect(bounded["x".repeat(65)]).toBeUndefined();
    expect(boundPluginLocalizedText(bounded)).toEqual(bounded);
  });

  it("bounds a huge localized install request and preserves UI languages through serialized event replay", async () => {
    const { server, emitEvent, events, projection } = setup();
    const controller = new AbortController();
    const pending = confirmPluginInstall(
      server,
      {
        ...plugin,
        displayName: "Default name",
        description: "Default description",
        displayNameI18n: locales(),
        descriptionI18n: locales(),
      },
      "Read emails",
      {
        sessionId: "session",
        toolCallId: "tool",
        traceId: "trace",
        signal: controller.signal,
        emitEvent,
      },
    );
    try {
      await Promise.resolve();
      const request = projection.getSnapshot().pendingInteractions[0]?.payload;
      expect(request?.kind).toBe("pluginInstall");
      if (request?.kind !== "pluginInstall") throw new Error("Missing install request");
      expect(request.displayName).toBe("Default name");
      expect(request.description).toBe("Default description");
      for (const map of [request.displayNameI18n, request.descriptionI18n]) {
        expect(map).toBeDefined();
        expect(Object.keys(map!).length).toBeLessThanOrEqual(16);
        expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThanOrEqual(24 * 1_024);
        for (const locale of ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"]) {
          expect(map![locale]).toBe(`UI ${locale}`);
        }
        for (const text of Object.values(map!)) {
          expect(text.length).toBeLessThanOrEqual(4_000);
          expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(4_096);
          expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
        }
      }
      const replay = new ProductProjection("session", "epoch");
      for (const event of JSON.parse(JSON.stringify(events)) as SessionEvent[]) {
        replay.applyEvent({ ...event, timestamp: new Date(event.timestamp) });
      }
      const restored = replay.getSnapshot();
      expect(conversationSnapshotSchema.safeParse(restored).success).toBe(true);
      expect(restored.pendingInteractions[0]?.payload).toEqual(request);
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it("filters pending installs for legacy snapshot, live patches and gap replay while a capable phone can reconnect", async () => {
    const { server, emitEvent, events } = setup();
    const publisher = new ConversationTopicPublisher("session", "epoch");
    for (const event of events) publisher.ingest(event);
    const legacy = publisher.subscribe({ connectionId: "legacy" });
    const base = { logEpoch: "epoch", seq: publisher.getSnapshot().seq };
    const controller = new AbortController();
    const pending = confirmPluginInstall(
      server,
      { ...plugin, descriptionI18n: locales() },
      "Read emails",
      {
        sessionId: "session",
        toolCallId: "tool",
        traceId: "trace",
        signal: controller.signal,
        emitEvent: async (event) => {
          await emitEvent(event);
          publisher.ingest(event);
        },
      },
    );
    try {
      await Promise.resolve();
      const frame = (id: string, capability = false) =>
        publisher.subscribe({
          connectionId: id,
          pluginDiscoveryUi: capability,
        }).frame;
      expect(JSON.stringify(frame("phone", true))).toContain('"kind":"pluginInstall"');
      expect(JSON.stringify(frame("old"))).not.toContain('"kind":"pluginInstall"');
      expect(JSON.stringify(publisher.flush(legacy.ack.subscriptionId))).not.toContain(
        '"kind":"pluginInstall"',
      );
      const replay = publisher.subscribe({ connectionId: "legacy", base });
      expect(replay.ack.mode).toBe("resume");
      expect(JSON.stringify(replay.frame)).not.toContain('"kind":"pluginInstall"');
      const upgrade = publisher.subscribe({
        connectionId: "legacy",
        base: { logEpoch: "epoch", seq: publisher.getSnapshot().seq },
        pluginDiscoveryUi: true,
      });
      expect(upgrade.ack.mode).toBe("snapshot");
      expect(JSON.stringify(upgrade.frame)).toContain('"kind":"pluginInstall"');
      expect(server.v4Interactions.has("plugin-install:session:tool")).toBe(true);
    } finally {
      controller.abort();
      await expect(pending).rejects.toThrow();
    }
  });
  it("does not resurrect an old turn's card after a new turn starts", async () => {
    const { emitEvent, projection } = setup();
    await emitEvent(
      createSessionEvent(
        SessionEventType.TurnStarted,
        "session" as SessionId,
        { turnNumber: 2, input: "new request" },
        { turnId: "new-turn" as TurnId },
      ),
    );
    await emitEvent(
      createSessionEvent(
        SessionEventType.PluginInstallRequested,
        "session" as SessionId,
        {
          interactionId: "old-confirm",
          request: {
            kind: "pluginInstall",
            pluginId: plugin.pluginId,
            name: plugin.name,
            reason: "Old request",
            action: "install",
            scope: "user",
            toolCallId: "old-tool",
          },
        },
        { turnId: "old-turn" as TurnId },
      ),
    );
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
  });
  it("survives waiting and projects the same immutable card to both profiles, with first-answer wins", async () => {
    vi.useFakeTimers();
    try {
      const { server, registry, projection, emitEvent } = setup();
      const pending = confirmPluginInstall(server, plugin, "Read emails", {
        sessionId: "session",
        toolCallId: "tool",
        traceId: "trace",
        signal: new AbortController().signal,
        emitEvent,
      });
      await Promise.resolve();
      const snapshot = conversationSnapshotSchema.parse(projection.getSnapshot());
      const card = snapshot.pendingInteractions[0]!;
      expect(card.kind).toBe("pluginInstall");
      expect(card.autoResolution).toBeUndefined();
      const delta = [{ op: "state.updated" as const, patch: { pendingInteractions: [card] } }];
      for (const profile of Object.values(DELIVERY_PROFILES)) {
        expect(filterConversationDeltasForProfile(delta, profile)).toEqual(delta);
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(registry.has(card.interactionId)).toBe(true);
      expect(registry.resolve(card.interactionId, { optionId: "install" }, null)).toBe(false);
      expect(registry.resolve(card.interactionId, { optionId: "install" }, "wrong-session")).toBe(
        false,
      );
      expect(registry.resolve(card.interactionId, { optionId: "install" }, "session")).toBe(false);
      expect(registry.resolve(card.interactionId, { optionId: "install" }, "session", true)).toBe(
        true,
      );
      expect(registry.resolve(card.interactionId, { optionId: "install" }, "session")).toBe(false);
      expect(await pending).toBe(true);
      expect(projection.getSnapshot().pendingInteractions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["skip", "allowAlways", "unknown"])("never installs for %s", async (optionId) => {
    const { server, registry, emitEvent, events } = setup();
    const pending = confirmPluginInstall(server, plugin, "Read emails", {
      sessionId: "session",
      toolCallId: "tool",
      traceId: "trace",
      signal: new AbortController().signal,
      emitEvent,
    });
    registry.resolve("plugin-install:session:tool", { optionId }, "session", true);
    expect(await pending).toBe(false);
    expect(events.at(-1)?.payload).toMatchObject({ decision: "skip" });
  });
  it("cancellation clears the registry and pending card without approval", async () => {
    const { server, registry, emitEvent, projection } = setup();
    const controller = new AbortController();
    const pending = confirmPluginInstall(server, plugin, "Read emails", {
      sessionId: "session",
      toolCallId: "tool",
      traceId: "trace",
      signal: controller.signal,
      emitEvent,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(registry.has("plugin-install:session:tool")).toBe(false);
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
  });
});
