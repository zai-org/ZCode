import { expect, it } from "vitest";
import { parsePluginManifest, pluginManifestName } from "../../src/plugins/discovery/index.js";
it("rejects invalid plugin identities at the shared discovery boundary", () => {
  expect(() => parsePluginManifest({ name: "../outside" })).toThrow("Invalid plugin name");
  expect(pluginManifestName({ name: "../outside" })).toBeUndefined();
  expect(parsePluginManifest({ name: "example", mcpServers: "./mcp.json" })).toMatchObject({
    name: "example",
    mcpServers: "./mcp.json",
    version: "0.0.0",
  });
});
