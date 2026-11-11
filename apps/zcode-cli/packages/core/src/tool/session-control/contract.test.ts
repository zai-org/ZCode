import { describe, expect, it } from "vitest";
import { sessionControlTools, sessionControlToolsByKind } from "./index.js";

describe("session control tool contract", () => {
  it("keeps one finite name set where App is a superset of the standalone CLI", () => {
    const cli = sessionControlToolsByKind.cli.map((entry) => entry.metadata.name);
    const app = sessionControlToolsByKind.app.map((entry) => entry.metadata.name);
    expect(cli).toHaveLength(8);
    expect(app).toHaveLength(12);
    expect(cli.every((name) => app.includes(name))).toBe(true);
    expect(new Set(sessionControlTools.map((entry) => entry.metadata.name)).size).toBe(12);
  });
});
