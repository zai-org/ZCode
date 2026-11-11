/// <reference types="node" />
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";

describe("independent Node test project", () => {
  it("does not load the root application setup or its operating-system mock", () => {
    expect(vi.isMockFunction(homedir)).toBe(false);
    expect(typeof globalThis.document).toBe("undefined");
  });
});
