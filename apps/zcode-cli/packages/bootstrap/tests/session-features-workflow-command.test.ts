import { describe, expect, it } from "vitest";

import { withApp, featureEntries } from "./session-features-workflow-command-fixture.js";

describe("`/workflow` 展开时打 workflow_cmd", () => {
  it("首轮就是 `/workflow`：打点先于会话落盘，entry 由首次持久化补写", async () => {
    await withApp({ dynamicWorkflowEnabled: true }, async ({ app, seen, sessionStore }) => {
      await app.submitPrompt("/workflow ship it");
      expect(seen).toEqual([["workflow_cmd"]]);
      expect(await featureEntries(sessionStore, app.sessionId)).toEqual([
        { features: ["workflow_cmd"] },
      ]);
    });
  });

  it("灰度关闭时命令不展开，也不打标签", async () => {
    await withApp({ dynamicWorkflowEnabled: false }, async ({ app, seen, sessionStore }) => {
      await app.submitPrompt("/workflow ship it");
      expect(seen).toEqual([undefined]);
      expect(await featureEntries(sessionStore, app.sessionId)).toEqual([]);
    });
  });
});
