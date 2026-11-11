import { describe, expect, it } from "vitest";
import { PLUGIN_DISCOVERY_INPUT } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  inputIntentMetadata,
  inputIntentMetadataFromCanonical,
} from "../src/zcode-protocol-v4/commands/input-intent.js";

describe("plugin discovery input admission", () => {
  it.each(["createSession", "sendText"] as const)(
    "keeps %s support on the initiating input only",
    (type) => {
      const command: CommandEnvelope = {
        type,
        commandId: "cmd",
        sessionId: type === "createSession" ? null : "s",
        issuedAt: 0,
        clientId: "app",
        payload: {},
      };
      const options = { text: "mail", requestedDelivery: "startNow" as const };
      const supported = inputIntentMetadata({ ...command, pluginDiscoveryUi: true }, options);
      const legacy = inputIntentMetadata(command, options);
      expect(supported[PLUGIN_DISCOVERY_INPUT]).toBe(true);
      expect(legacy[PLUGIN_DISCOVERY_INPUT]).toBeUndefined();
      expect(JSON.parse(JSON.stringify(supported))).toEqual(JSON.parse(JSON.stringify(legacy)));
      expect(
        inputIntentMetadataFromCanonical(command, {
          ...supported,
          text: "retry",
          kind: "sendText",
        })[PLUGIN_DISCOVERY_INPUT],
      ).toBeUndefined();
    },
  );
});
