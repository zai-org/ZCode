import {
  telemetryInputOrigin,
  backgroundBatchTelemetryAttributes,
  TELEMETRY_INPUT_ORIGIN_ATTRIBUTE,
} from "../src/runtime/methods/input-intent-persistence.js";
import { describe, expect, it } from "vitest";
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import { buildPersistedConversationInputIntent } from "../src/runtime/methods/input-intent-persistence.js";

describe("persisted conversation input intent", () => {
  it.each(["build", "guarded", "yolo"] as const)(
    "persists %s with canonical goal text and queue intent",
    (mode) => {
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: "command-goal",
        queueItemId: "queue-goal",
        clientId: "desktop-goal",
        kind: "sendGoalCommand",
        text: "X",
        admissionSeq: 3,
        admittedAt: 999,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        modelSelection: {
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "high" },
        },
        mode,
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "context-1" }],
        genUiContext: [{ path: "/project/example.html", state: { stage: "entry" } }],
      };

      expect(
        buildPersistedConversationInputIntent("/GoAl replace X", intent, "queued"),
      ).toMatchObject({
        kind: "sendGoalCommand",
        text: "X",
        modelSelection: intent.modelSelection,
        mode,
        sharedContextRefs: intent.sharedContextRefs,
        genUiContext: intent.genUiContext,
      });
    },
  );

  it("persists retry provenance with the rebuilt command intent", () => {
    const intent: TurnInputIntentMetadata = {
      sourceCommandId: "command-retry",
      queueItemId: "queue-retry",
      clientId: "desktop-new",
      kind: "sendText",
      text: "original text",
      source: { kind: "session", sessionId: "source-session", title: "来源会话" },
      admissionSeq: 4,
      admittedAt: 1000,
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      provenance: {
        sourceCommandId: "command-original",
        queueItemId: "queue-original",
        clientId: "desktop-original",
      },
    };

    expect(buildPersistedConversationInputIntent("original text", intent, "drained")).toMatchObject(
      {
        sourceCommandId: "command-retry",
        source: intent.source,
        provenance: {
          sourceCommandId: "command-original",
          queueItemId: "queue-original",
          clientId: "desktop-original",
        },
      },
    );
  });
});

it("后台因果来源按整批判定，新输入覆盖旧来源", () => {
  const mobile = { attributes: { [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: "mobile" } };
  const desktop = { attributes: { [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: "desktop" } };
  expect(
    telemetryInputOrigin(undefined, backgroundBatchTelemetryAttributes([mobile, mobile])),
  ).toBe("mobile");
  expect(
    telemetryInputOrigin(undefined, backgroundBatchTelemetryAttributes([mobile, desktop])),
  ).toBe("mobile");
  expect(telemetryInputOrigin(undefined, backgroundBatchTelemetryAttributes([mobile, {}]))).toBe(
    "mobile",
  );
  expect(
    telemetryInputOrigin({ inputOrigin: "desktop" } as TurnInputIntentMetadata, mobile.attributes),
  ).toBe("desktop");
});
