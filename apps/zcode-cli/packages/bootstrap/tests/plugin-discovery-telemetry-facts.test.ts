import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { PluginDiscoveryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

const PLUGIN_ID = "notion@zcode-plugins-official";
let seq = 0;
function event(type: SessionEvent["type"], payload: unknown, at = 1_000): SessionEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    sessionId: "s",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(at),
    type,
    payload,
  } as SessionEvent;
}
const scheduled = (toolName: string, toolCallId: string) =>
  event(SessionEventType.ToolCallScheduled, { toolCallId, toolName, input: { query: "secret" } });
const result = (toolCallId: string, content: unknown, at?: number) =>
  event(
    SessionEventType.ToolCallResult,
    { toolCallId, duration: 1, result: { success: true, content: JSON.stringify(content) } },
    at,
  );

describe("plugin discovery telemetry facts", () => {
  it("maps search, card, decision and install outcome without query or reason text", () => {
    const n = new PluginDiscoveryFactNormalizer();
    expect(n.normalize("s", scheduled("SearchPlugins", "search"))).toBeNull();
    const searched = n.normalize(
      "s",
      result("search", { plugins: [], stale: false }),
    );
    expect(searched).toMatchObject({ phase: "searched", result: "success", resultCount: 0 });

    n.normalize("s", scheduled("SuggestPluginInstall", "suggest"));
    const shown = n.normalize(
      "s",
      event(SessionEventType.PluginInstallRequested, {
        interactionId: "i",
        request: { pluginId: PLUGIN_ID, action: "install", toolCallId: "suggest", reason: "secret" },
      }),
    );
    expect(shown).toMatchObject({ phase: "card_shown", pluginId: PLUGIN_ID, action: "install" });
    const resolved = n.normalize(
      "s",
      event(
        SessionEventType.PluginInstallResolved,
        { interactionId: "i", pluginId: PLUGIN_ID, toolCallId: "suggest", decision: "install" },
        2_000,
      ),
    );
    expect(resolved).toMatchObject({ phase: "card_resolved", decision: "install" });
    const settled = n.normalize(
      "s",
      result("suggest", { pluginId: PLUGIN_ID, status: "installed", message: "ok" }, 5_000),
    );
    expect(settled).toMatchObject({
      phase: "install_settled",
      pluginId: PLUGIN_ID,
      action: "install",
      result: "success",
      durationMs: 3_000,
    });
    expect(JSON.stringify([searched, shown, resolved, settled])).not.toContain("secret");
  });

  it("does not report an install outcome when the user skipped or no card was shown", () => {
    const n = new PluginDiscoveryFactNormalizer();
    n.normalize("s", scheduled("SuggestPluginInstall", "skip"));
    n.normalize(
      "s",
      event(SessionEventType.PluginInstallResolved, {
        interactionId: "i",
        pluginId: PLUGIN_ID,
        toolCallId: "skip",
        decision: "skip",
      }),
    );
    expect(
      n.normalize("s", result("skip", { pluginId: PLUGIN_ID, status: "skipped", message: "" })),
    ).toBeNull();
    n.normalize("s", scheduled("SuggestPluginInstall", "nocard"));
    expect(
      n.normalize("s", result("nocard", { pluginId: PLUGIN_ID, status: "unavailable", message: "" })),
    ).toBeNull();
    n.normalize("s", scheduled("Read", "other"));
    expect(n.normalize("s", result("other", "file"))).toBeNull();
  });
});
