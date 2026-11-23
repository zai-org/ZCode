import { afterEach, expect, it, vi } from "vitest";
import { BufferWriter, serialize } from "@zcode/rpc";
import {
  readUpdateDisconnectEvidence,
  restoreUpdateDisconnectProbe,
} from "#e2e/helpers/source-server-update-disconnect";

function frame(header: number[], body: unknown): number[] {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return Array.from(writer.buffer.buffer);
}

afterEach(async () => {
  await restoreUpdateDisconnectProbe();
  vi.unstubAllGlobals();
});

it("transfers new frames once while retaining earlier update and state evidence", async () => {
  const transferred: number[] = [];
  const probe = {
    sent: true,
    requests: [frame([100, -8302, 0, 0], [])],
    responses: [
      frame([201, -8303], { saved: true }),
      frame([204, 1], { state: { profileId: "owner", state: "retrying" } }),
      ...Array.from({ length: 2000 }, (_, index) =>
        frame([201, index], { unrelated: "x".repeat(200) }),
      ),
    ],
    restore() {},
  };
  vi.stubGlobal("window", { __updateDisconnectProbe: probe });
  vi.stubGlobal("browser", {
    execute: async (fn: () => unknown) => {
      const result = fn();
      if (result && typeof result === "object" && "responses" in result)
        transferred.push((result.responses as unknown[]).length);
      return result;
    },
  });

  const first = await readUpdateDisconnectEvidence();
  expect(first.savedProfile?.body).toEqual({ saved: true });
  expect(first.states).toEqual([{ profileId: "owner", state: "retrying" }]);
  await readUpdateDisconnectEvidence();
  expect(transferred).toEqual([2002, 0]);

  probe.responses.push(
    frame([202, -8302], { name: "SourceServerProfileRemovedError" }),
    frame([201, -8301], { removed: true }),
    frame([204, 1], { state: { profileId: "owner", state: "online" } }),
  );
  const final = await readUpdateDisconnectEvidence();
  expect(final.savedProfile).toEqual(first.savedProfile);
  expect(final.update?.body.name).toBe("SourceServerProfileRemovedError");
  expect(final.cancellation?.body).toEqual({ removed: true });
  expect(final.states).toEqual([
    { profileId: "owner", state: "retrying" },
    { profileId: "owner", state: "online" },
  ]);
  expect(transferred).toEqual([2002, 0, 3]);

  await restoreUpdateDisconnectProbe();
  probe.sent = false;
  expect(await readUpdateDisconnectEvidence()).toEqual({ sent: false, states: [] });
});
