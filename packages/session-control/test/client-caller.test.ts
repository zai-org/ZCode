// 调用方两类（docs/plugins/extension-host.md §17.2）：App 上下文分成 session（模型工具，有根会话）与
// client（可信的非会话客户端，例如扩展）。client 没有根会话：读与等待照常授权，只是不做 self_wait 检查。
// session 类的行为不变：self_wait 与重复 operation 仍在访问端口前拒绝。
import { describe, expect, it } from "vitest";
import { createAppSessionControl } from "#session-control/application/app/index";
import { createOperationFeed, createTestPorts } from "#session-control/testing/index";
import {
  type AppClientTrustedContext,
  type AppScope,
  type AppSessionRef,
} from "#session-control/contract";

const appRoot: AppSessionRef = {
  kind: "app",
  workspacePath: "/workspace",
  sourceServerId: "source-a",
  sessionId: "sess_root",
};
const host: AppScope = { kind: "app", scope: "host", sourceServerId: "source-a" };

function fixture() {
  const ports = createTestPorts("app", appRoot);
  // 与生产 bindClient 相同的形状：本 Host 的 host 范围，没有根会话。
  const client: AppClientTrustedContext = {
    caller: "client",
    callerId: "source-a:client:extension:demo@inline",
    allowedScopes: [host],
    discoveryScopes: [host],
  };
  ports.app.observations.open = async (_ctx, operation) =>
    createOperationFeed({ operation, epoch: "e", revision: 0, status: "completed" });
  return { ports, client, session: ports.context, control: createAppSessionControl(ports.app) };
}

describe("App caller kinds", () => {
  it("lets a client caller list projects and sessions in its discovery scope", async () => {
    const { control, client, ports } = fixture();
    await expect(control.listProjects(client, {})).resolves.toMatchObject({
      searchScope: { scopes: [host] },
    });
    await expect(control.listSessions(client, {})).resolves.toMatchObject({
      searchScope: { scopes: [host] },
    });
    const owners = ports.calls.filter((call) => call.method !== "authorize");
    expect(owners.map((call) => call.method)).toEqual(["listProjects", "listSessions"]);
    // owner 收到的仍是原可信上下文：client 判别字段在，没有伪造的根会话。
    for (const call of owners) {
      expect(call.ctx).toMatchObject({ caller: "client" });
      expect(call.ctx).not.toHaveProperty("rootSession");
    }
  });

  it("lets a client caller read a session by id through the normal authorization", async () => {
    const { control, client, ports } = fixture();
    await expect(
      control.readSession(client, { sessionId: "sess_target", view: "messages" }),
    ).resolves.toMatchObject({ view: "messages", session: { sessionId: "sess_target" } });
    expect(ports.calls.map((call) => call.method)).toEqual([
      "resolveSession",
      "authorize",
      "readSession",
    ]);
  });

  it("still rejects a client target outside its scope", async () => {
    const { control, client, ports } = fixture();
    await expect(
      control.readSession(client, {
        session: { ...appRoot, sessionId: "sess_other", sourceServerId: "source-b" },
        view: "summary",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.calls).toEqual([]);
  });

  it("does not apply self_wait to a client caller, which has no root session", async () => {
    const { control, client } = fixture();
    await expect(
      control.waitSessions(client, {
        operations: [{ sessionId: "sess_root", commandId: "c" }],
        mode: "all",
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps rejecting self_wait for the session caller", async () => {
    const { control, session, ports } = fixture();
    await expect(
      control.waitSessions(session, {
        operations: [{ sessionId: "sess_root", commandId: "c" }],
        mode: "all",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "self_wait" });
    // 只有把 sessionId 解析成完整引用的那一次查询，没有授权与观察。
    expect(ports.calls.map((call) => call.method)).toEqual(["resolveSession"]);
  });

  it("treats a session context without the caller field as a session caller", async () => {
    const { control, session } = fixture();
    expect(session).not.toHaveProperty("caller");
    await expect(
      control.waitSessions(
        { ...session, caller: "session" },
        { operations: [{ session: session.rootSession, commandId: "c" }], mode: "all" },
      ),
    ).rejects.toMatchObject({ code: "self_wait" });
  });

  it("rejects duplicate operations for both caller kinds before observation", async () => {
    const { control, client, session, ports } = fixture();
    const operation = { session: { ...appRoot, sessionId: "sess_target" }, commandId: "c" };
    for (const ctx of [client, session]) {
      await expect(
        control.waitSessions(ctx, { operations: [operation, operation], mode: "any" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(ports.calls).toEqual([]);
  });
});
