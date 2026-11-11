import { describe, expect, it } from "vitest";

import { resolveHighspeedE2EMockScenario } from "./e2e/helpers/highspeed-mock-env.js";

describe("Highspeed E2E mock env", () => {
  it.each([
    ["conversation-session-highspeed-card.test.ts", "hit-fast"],
    ["conversation-session-highspeed-card-draw-timeout.test.ts", "hit-after-timeout"],
    ["conversation-session-highspeed-card-draw-miss.test.ts", "miss"],
    ["conversation-session-highspeed-card-fallback-unlocks-model.test.ts", "hit-invalid-model"],
    ["conversation-session-highspeed-card-admission-retains-draft.test.ts", "hit-invalid-model"],
  ] as const)("按 spec 文件 %s 注入 %s 场景", (spec, scenario) => {
    expect(resolveHighspeedE2EMockScenario([`./test/e2e/conversation-session/${spec}`])).toBe(
      scenario,
    );
  });

  it("兼容 Windows 路径分隔符", () => {
    expect(
      resolveHighspeedE2EMockScenario([
        ".\\test\\e2e\\conversation-session\\conversation-session-highspeed-card-draw-miss.test.ts",
      ]),
    ).toBe("miss");
  });

  it("未登记的 spec 不装配 Mock，避免普通会话意外抽到卡", () => {
    expect(
      resolveHighspeedE2EMockScenario([
        "./test/e2e/conversation-session/presentation/conversation-session-v4-scroll.test.ts",
      ]),
    ).toBeNull();
    expect(resolveHighspeedE2EMockScenario([])).toBeNull();
  });
});
