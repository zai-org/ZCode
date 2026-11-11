import { describe, expect, it } from "vitest";
import { createInitialConversationSnapshot } from "../projection-state.js";
import { ProductProjection } from "../product-projection.js";
import { measureWireExample } from "./contract.example.js";
import { hydrateConversationCandidate, measureInputAdmissionBytes } from "./index.js";

describe("conversation materialization contract", () => {
  it("measures an input without changing the canonical snapshot or accepting a queue item", () => {
    const snapshot = createInitialConversationSnapshot("session", "epoch");
    const before = structuredClone(snapshot);
    const bytes = measureInputAdmissionBytes(
      snapshot,
      {
        commandId: "command",
        clientId: "client",
        sessionId: "session",
        type: "sendText",
        payload: { text: "hello" },
        issuedAt: 1,
      },
      { queueItemId: "queue-command", admissionSeq: 1, admittedAt: 1 },
      measureWireExample,
    );
    expect(bytes).toBeGreaterThan(measureWireExample(snapshot));
    expect(snapshot).toEqual(before);
  });

  it("hydrates only the supplied candidate and reports its exact final wire size", () => {
    const owner = new ProductProjection("session", "epoch");
    const candidate = new ProductProjection("session", "epoch");
    const before = structuredClone(owner.getSnapshot());
    expect(
      hydrateConversationCandidate({
        projection: candidate,
        events: [],
        initialBytesUpperBound: measureWireExample(candidate.getSnapshot()),
        measureWireSnapshot: measureWireExample,
      }),
    ).toBe(measureWireExample(candidate.getSnapshot()));
    expect(owner.getSnapshot()).toEqual(before);
  });
});
