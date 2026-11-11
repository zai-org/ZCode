import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { createWorkerSelectionIntegration } from "#e2e/helpers/worker-selection-integration";

describe("Highspeed owner 旧执行端字段兼容", () => {
  it("真实Host三入口在旧能力下只剥owner，新能力下保留", async function () {
    this.timeout(120_000);
    for (const mode of ["legacy", "current"] as const) {
      const evidence = join(getE2EAppDataPaths().homeDir, `owner-${mode}.jsonl`);
      const preload = pathToFileURL(
        resolve("test/e2e/fixtures/highspeed-owner/legacy-capability-preload.mjs"),
      );
      preload.searchParams.set("mode", mode);
      preload.searchParams.set("evidence", evidence);
      const host = await createWorkerSelectionIntegration(`owner-${mode}`, {
        cliNodeArgs: ["--import", preload.href],
      });
      try {
        const selection = {
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          modelId: "GLM-5.3-Flash",
          options: { reasoningLevel: "high" },
        };
        const created = await host.task.createTask({
          workspacePath: host.workspacePath,
          modelSelection: selection,
          deferPersistenceUntilFirstPrompt: true,
        });
        const highspeedMeta = {
          schemaVersion: 1 as const,
          cardId: "owner-probe-card",
          taskId: created.taskId,
          provider: "zai",
          model: "GLM-5.3-Flash",
          issuedAt: 1,
          expiresAt: 10000,
          regularTps: 50,
          ownerKey: `v1:${"a".repeat(64)}`,
        };
        for (const type of ["sendText", "sendQueuedNow", "editUserQuery"] as const) {
          const ack = await host.agent.sendConversationCommandV4({
            workspacePath: host.workspacePath,
            envelope: {
              clientId: "owner-compat",
              commandId: `owner-compat-probe-${mode}-${type}`,
              sessionId: created.taskId,
              type,
              issuedAt: Date.now(),
              payload: {
                text: "owner boundary",
                newText: "owner boundary",
                queueItemId: "owner-queue",
                target: { rowId: "owner-row", entityId: "owner-entity" },
                highspeedMeta,
                modelSelection: selection,
                modelExecution: {
                  selectionScope: "execution",
                  requestAuth: { headers: { "X-Highspeed-Card-ID": "owner-probe-card" } },
                },
              },
            },
          });
          expect(ack.status).toBe("noop");
          expect(ack.reasonCode).toBe("owner_compat_validated");
        }
        const observed = (await readFile(evidence, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observed).toHaveLength(3);
        expect(observed.map((entry) => entry.type)).toEqual([
          "sendText",
          "sendQueuedNow",
          "editUserQuery",
        ]);
        expect(
          observed.every(
            (entry) =>
              entry.accepted &&
              entry.strictMetadata &&
              entry.metadataPreserved &&
              entry.payloadPreserved &&
              entry.ownerPresent === (mode === "current"),
          ),
        ).toBe(true);
      } finally {
        await host.dispose();
      }
    }
  });
});
