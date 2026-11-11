import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkSessionReady(
  env: Environment,
  root: string,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  await check("cold session restore and App opening share readiness without reload", async () => {
    const scope = await env.agent.session(join(root, "session-ready"), "session-ready");
    // 空白会话关闭后不会保留；先经真实发送链路写入一轮历史，再模拟闲置卸载。
    const turnOffset = env.agent.notifications.history.length;
    const ack = await env.agent.call("v4/command", {
      commandId: randomUUID(),
      clientId: "fixture-client",
      sessionId: scope.sessionId,
      type: "sendText",
      payload: {
        text: "E2E_PLUGIN_UI_SESSION_READY",
        modelSelection: env.model.selection,
        mode: "build",
      },
      issuedAt: Date.now(),
    });
    assert.equal(ack.status, "accepted");
    const terminal = await env.agent.notifications.wait(
      (e) =>
        e.method === "v4/telemetry/event" &&
        e.params.kind === "turn.terminal" &&
        e.params.sessionId === scope.sessionId,
      turnOffset,
    );
    assert.equal(terminal.params.status, "success");
    await env.agent.call("session/lifecycle/stop", { sessionId: scope.sessionId });
    assert.equal(
      (await env.agent.call("session/lifecycle/getState", { sessionId: scope.sessionId })).state,
      "unloaded",
    );
    // 控制真实冷恢复的反向请求，保证插件在 starting 窗口打开；不用固定等待碰竞态。
    const gate = Promise.withResolvers<void>();
    env.agent.runtimePreferenceGates.set(scope.sessionId, gate.promise);
    const offset = env.events.history.length;
    const runtimeOffset = env.agent.runtimePreferences.history.length;
    const notificationOffset = env.agent.notifications.history.length;
    const mcpOffset = env.agent.events.history.length;
    const restoring = env.agent.call("session/resume", {
      sessionId: scope.sessionId,
      workspace: scope.workspace,
      mcpServers: env.agent.mcpServers("session-ready"),
    });
    void restoring.catch(() => {});
    let owner: BrowserWindow | undefined;
    try {
      await env.agent.runtimePreferences.wait(
        (r) => r.params.sessionId === scope.sessionId,
        runtimeOffset,
      );
      const opening = env.createWindow(scope);
      void opening.catch(() => {});
      const arrived = await Promise.race([
        env.events.wait(
          (e) => e.type === "bridge-arrived" && e.method === "prepareSandbox",
          offset,
        ),
        opening.then(() => {
          throw new Error("App opened before session readiness");
        }),
      ]);
      owner = env.windows.find((win) => win.webContents.id === arrived.owner)!;
      assert.equal(
        (await env.agent.call("session/lifecycle/getState", { sessionId: scope.sessionId })).state,
        "starting",
      );
      assert.equal(
        (await owner.webContents.executeJavaScript("window.managedState()")).phase,
        "preparing",
      );
      assert.equal(env.handles.has(owner.webContents.id), false);
      assert.equal(env.guests.has(owner.webContents.id), false);
      await writeFile(
        join(root, "session-ready-preparing.png"),
        (await owner.webContents.capturePage()).toPNG(),
      );
      gate.resolve();
      await Promise.all([restoring, opening]);
      const events = env.events.history
        .slice(offset)
        .filter((e) => e.owner === owner!.webContents.id);
      assert.equal(
        events.some((e) => e.type === "phase" && e.phase === "error"),
        false,
      );
      assert.equal(events.filter((e) => e.type === "registered").length, 1);
      assert.equal(
        (await owner.webContents.executeJavaScript("window.managedState()")).phase,
        "running",
      );
      assert.equal(
        env.agent.events.history
          .slice(mcpOffset)
          .filter(
            (e) => e.type === "read" && e.source === "session-ready" && e.uri === "ui://fixture",
          ).length,
        1,
      );
      const lifecycle = env.agent.notifications.history
        .slice(notificationOffset)
        .filter(
          (e) => e.method === "session/lifecycle/changed" && e.params.sessionId === scope.sessionId,
        );
      assert.deepEqual(
        lifecycle.map((e) => e.params.state),
        ["starting", "ready"],
      );
      await writeFile(
        join(root, "session-ready-running.png"),
        (await owner.webContents.capturePage()).toPNG(),
      );
    } finally {
      gate.resolve();
      env.agent.runtimePreferenceGates.delete(scope.sessionId);
      if (owner && !owner.isDestroyed()) {
        await owner.webContents.executeJavaScript(
          "window.setAnchors(false,false).then(() => window.clearManaged())",
        );
        owner.destroy();
      }
    }
  });
}

export async function checkLate(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  await check(
    "retry while prepare reply is withheld discards old handle and serializes replacement",
    async () => {
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      env.gates.set("return:prepareSandbox", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait((e) => e.type === "bridge" && e.method === "prepareSandbox", offset);
      const stale = env.handles.get(win.webContents.id);
      await ui("window.retryManaged(); window.retryManaged()");
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "registered").length,
        1,
      );
      env.gates.delete("return:prepareSandbox");
      gate.resolve();
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await env.evalPage(win, "window.fixtureReady");
      const replacement = env.handles.get(win.webContents.id);
      assert.notEqual(replacement.instance.token, stale.instance.token);
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale.instance }),
      );
      await ui(`window.harness.dispose(${JSON.stringify(stale.sandboxId)}, ${stale.initId})`);
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check("late project-wide permission answer cannot grant replacement page", async () => {
    const oldCall = env
      .evalPage(win, "window.callTool('project-stale')")
      .catch((error) => ({ error: String(error) }));
    const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "project-stale");
    const project = pending.params.options.find(
      (option: any) => option.optionId === "allow_project",
    );
    assert.ok(project?.response.permissionUpdates?.length);
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
    await env.evalPage(win, "window.fixtureReady");
    await env.agent.client.respond(pending.id, project.response);
    assert.ok((await oldCall).error);
    const next = env.evalPage(win, "window.callTool('project-replacement')");
    const nextPermission = await env.agent.approvals.wait(
      (r) => r.params.input?.key === "project-replacement",
    );
    await env.agent.respond(nextPermission, "deny");
    assert.ok((await next).error);
    assert.equal(
      env.agent.events.history.some((e) => e.type === "executed" && e.key.startsWith("project-")),
      false,
    );
  });
  await check(
    "withheld app tool registration cannot resurrect replaced page or unregister its successor",
    async () => {
      const offset = env.events.history.length;
      const gate = Promise.withResolvers<void>();
      env.gates.set("registerAppTools", gate.promise);
      await ui("window.retryManaged()");
      await env.events.wait(
        (e) => e.type === "app-tools-arrived" && e.method === "registerAppTools",
        offset,
      );
      const stale = env.handles.get(win.webContents.id).instance;
      env.gates.delete("registerAppTools");
      const after = env.events.history.length;
      await ui("window.retryManaged()");
      const registered = await env.events.wait((e) => e.type === "registerAppTools", after);
      assert.notEqual(registered.params.instance.token, stale.token);
      gate.resolve();
      await env.evalPage(win, "window.fixtureReady");
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: stale }),
      );
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
}
