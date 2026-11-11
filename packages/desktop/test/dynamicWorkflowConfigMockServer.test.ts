import { describe, expect, it } from "vitest";

import {
  resolveDynamicWorkflowConfigMockScenario,
  startDynamicWorkflowConfigMockServer,
} from "#e2e/helpers/dynamic-workflow-config-mock-server";

describe("dynamic workflow E2E config fixture", () => {
  it.each([
    ["./test/e2e/automations/workflows/automations-workflows-hub.test.ts", "alwaysOn"],
    ["./test/e2e/conversation-session/composer/conversation-session-plus-menu.test.ts", "alwaysOn"],
    ["./test/e2e/conversation-session/composer/conversation-session-plus-menu.test.ts", "alwaysOn"],
    [
      "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-holes.test.ts",
      "alwaysOn",
    ],
    [
      "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-holes.test.ts",
      "alwaysOn",
    ],
    [
      "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-always-on.test.ts",
      "alwaysOn",
    ],
    [
      "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-disabled.test.ts",
      "disabled",
    ],
    [
      "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-on-demand.test.ts",
      "onDemand",
    ],
    ["./test/e2e/automations/schedule/automations-custom-monthly-interval.test.ts", null],
  ])("selects the declared offer for %s", (spec, expected) => {
    expect(resolveDynamicWorkflowConfigMockScenario([spec])).toBe(expected);
  });

  it("rejects conflicting enabled and disabled fixtures in one worker", () => {
    expect(() =>
      resolveDynamicWorkflowConfigMockScenario([
        "./test/e2e/automations/workflows/automations-workflows-hub.test.ts",
        "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-disabled.test.ts",
      ]),
    ).toThrow("必须分属不同 worker");
  });

  it("rejects an on-demand fixture sharing a worker with another offer", () => {
    expect(() =>
      resolveDynamicWorkflowConfigMockScenario([
        "./test/e2e/automations/workflows/automations-workflows-hub.test.ts",
        "./test/e2e/conversation-session/workflows/conversation-session-dynamic-workflow-gray-on-demand.test.ts",
      ]),
    ).toThrow("必须分属不同 worker");
  });

  it.each(["alwaysOn", "onDemand", "disabled"] as const)(
    "serves the %s offer without changing the product default",
    async (scenario) => {
      const server = await startDynamicWorkflowConfigMockServer(scenario);
      try {
        const response = await fetch(`${server.baseUrl}/api/v1/client/configs`);
        const payload = (await response.json()) as {
          data: { configs: { dynamicWorkflow?: { mode: string } } };
        };
        expect(payload.data.configs.dynamicWorkflow).toEqual(
          scenario === "disabled" ? undefined : { mode: scenario },
        );
      } finally {
        await server.stop();
      }
    },
  );
});
