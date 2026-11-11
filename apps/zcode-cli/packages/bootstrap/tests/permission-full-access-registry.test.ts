import { describe, expect, it, vi } from "vitest";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";

describe("完全访问唯一应答", () => {
  it("更新完成前不应答，重复调用共享提交，同 session 校验", async () => {
    const registry = new V4InteractionRegistry();
    let complete!: () => void;
    const operation = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const fullAccess = vi.fn(() => operation);
    const reply = vi.fn();
    registry.register("p", reply, { sessionId: "s", kind: "other", fullAccess });
    await expect(registry.resolvePermissionMode("p", "other", "yolo")).rejects.toThrow(
      "not supported",
    );
    const first = registry.resolvePermissionMode("p", "s", "yolo");
    const duplicate = registry.resolvePermissionMode("p", "s", "guarded");
    expect(registry.resolve("p", { optionId: "deny" })).toBe(false);
    expect(reply).not.toHaveBeenCalled();
    complete();
    expect(await Promise.all([first, duplicate])).toEqual([true, false]);
    expect(fullAccess).toHaveBeenCalledExactlyOnceWith("yolo");
    expect(reply).toHaveBeenCalledExactlyOnceWith({ optionId: "allowOnce" });
    expect(await registry.resolvePermissionMode("p", "s", "yolo")).toBe(false);
  });
  it("保存失败保留审批，可重试；普通问答不允许伪造能力", async () => {
    const registry = new V4InteractionRegistry();
    const fullAccess = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const reply = vi.fn();
    registry.register("p", reply, { sessionId: "s", kind: "other", fullAccess });
    await expect(registry.resolvePermissionMode("p", "s", "yolo")).rejects.toThrow("disk full");
    expect(reply).not.toHaveBeenCalled();
    expect(registry.has("p")).toBe(true);
    await registry.resolvePermissionMode("p", "s", "yolo");
    registry.register("question", vi.fn(), { sessionId: "s", kind: "other" });
    await expect(registry.resolvePermissionMode("question", "s", "yolo")).rejects.toThrow(
      "not supported",
    );
  });
});
