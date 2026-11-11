import { describe, expect, it, vi } from "vitest";
import { mcpUiInstances } from "../src/zcode-protocol/mcp-ui/instances.js";
import { openMcpUiInstance } from "../src/zcode-protocol/mcp-ui/protocol.js";
import { SessionLifecycleController } from "../src/session-lifecycle/index.js";

import { binding } from "./mcp-ui-connection-ready-fixture.js";

describe("MCP App connection readiness", () => {
  it.each(["missing"])(
    "shares session readiness before opening concurrent pages: %s",
    async (outcome) => {
      const source = { identity: "resumed-source", generation: 1 };
      const gate = Promise.withResolvers<void>();
      const activating = Promise.withResolvers<void>();
      const record = {
        app: {
          getMcpAppConnectionSnapshot: () => source,
          waitForMcpAppConnection: vi.fn(async () => source),
          onMcpAppConnectionInvalidated: () => () => {},
          unsubscribeMcpResourcesForUi: async () => {},
        },
      };
      const sessions = new Map<string, typeof record>();
      const activate = vi.fn(async () => {
        activating.resolve();
        await gate.promise;
        sessions.set(binding.sessionId, record);
      });
      const sessionLifecycle = new SessionLifecycleController({
        exists: async () => outcome !== "missing",
        hasRuntime: (id) => sessions.has(id),
        activate,
        assertCanStop: () => {},
        release: async () => {
          sessions.clear();
        },
      });
      const context = { sessions, sessionLifecycle } as unknown as Parameters<
        typeof openMcpUiInstance
      >[0];
      const params = {
        ...binding,
        workspace: { workspacePath: binding.workspace, workspaceKey: binding.workspace },
      };
      const restoring =
        outcome === "already-starting"
          ? sessionLifecycle.ensureReady(binding.sessionId)
          : undefined;
      const settled = vi.fn();
      const openings = [openMcpUiInstance(context, params), openMcpUiInstance(context, params)];
      for (const opening of openings) void opening.then(settled, settled);
      if (outcome === "missing") {
        for (const opening of openings) await expect(opening).rejects.toThrow("Session not found");
        expect(activate).not.toHaveBeenCalled();
        return;
      }
      await activating.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(record.app.waitForMcpAppConnection).not.toHaveBeenCalled();
      if (outcome === "failed") {
        gate.reject(new Error("fixture session restore failed"));
        for (const opening of openings)
          await expect(opening).rejects.toThrow("fixture session restore failed");
        expect(record.app.waitForMcpAppConnection).not.toHaveBeenCalled();
        expect((await sessionLifecycle.getState(binding.sessionId)).state).toBe("unloaded");
      } else {
        gate.resolve();
        const [first, second] = await Promise.all(openings);
        await restoring;
        expect(first).toEqual(second);
        expect(mcpUiInstances.validate(first!, params, source).lease).toEqual(first);
        mcpUiInstances.close(first!);
      }
      expect(activate).toHaveBeenCalledTimes(1);
    },
  );
});
