import { afterEach, describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";

import { cleanup, fixture, answer } from "./runtime-fixture.js";

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("CLI session control runtime", () => {
  it("reads non-owned persisted history by ID but never restores or writes it", async () => {
    const f = await fixture(async () => answer);
    const external = await createRegistryBackedTestApp({
      sessionId: createSessionId(),
      sessionStore: f.store,
      skipUserConfig: true,
      env: { ZCODE_STORAGE_DIR: f.cwd },
      modelExecutor: { generateText: async () => answer },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: { workingDirectory: f.cwd },
    });
    cleanup.push(async () => {
      await external.close?.();
    });
    await external.submitPrompt("external app or CLI owner");
    const ref = { ...f.ctx.rootSession, sessionId: external.sessionId };
    // 没有读范围的调用者只看到本进程托管的根。
    expect(
      (await f.manager.control.listSessions(f.ctx, {})).sessions.map(
        (item) => item.session.sessionId,
      ),
    ).not.toContain(external.sessionId);
    // 独立 CLI 装配声明可读本机会话库：其他进程的历史可列出、按 ID 读取正文，但只宣称可读。
    const reader = { ...f.ctx, readAnyLocalSession: true };
    const listed = (await f.manager.control.listSessions(reader, {})).sessions.find(
      (item) => item.session.sessionId === external.sessionId,
    );
    expect(listed).toMatchObject({ status: "unknown", availableActions: ["readSession"] });
    const read = await f.manager.control.readSession(reader, {
      sessionId: external.sessionId,
      view: "messages",
    });
    expect(read).toMatchObject({ view: "messages", session: { sessionId: external.sessionId } });
    expect(read.view === "messages" && read.messages.map((message) => message.text)).toContain(
      "external app or CLI owner",
    );
    for (const ctx of [f.ctx, reader])
      await expect(
        f.manager.control.sendToSession(ctx, {
          sessionId: external.sessionId,
          prompt: "do not restore",
          requestId: "external",
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      f.manager.control.sendToSession(reader, {
        session: ref,
        prompt: "do not restore",
        requestId: "external-ref",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    // 读取不恢复 runtime，也不为目标创建 owner。
    expect(f.createRootApp).toHaveBeenCalledTimes(1);
  });
});
