import { describe, expect, it, vi } from "vitest";
import { createAppSessionControlBinding } from "./index.js";

describe("App session control client contract", () => {
  it("constructs a root bound facade without touching transport or a session runtime", () => {
    const requestClient = vi.fn();
    const binding = createAppSessionControlBinding({
      requestClient,
      sessionId: "root",
      workspacePath: "/workspace",
    });
    expect(binding.kind).toBe("app");
    expect(binding.context().rootSession.sessionId).toBe("root");
    expect(Object.keys(binding.control)).toHaveLength(12);
    expect(requestClient).not.toHaveBeenCalled();
  });
});
