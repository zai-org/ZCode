import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./e2e/helpers/upstream-replay-server.js";
import type { E2ENetworkCaptureArtifact } from "./e2e/helpers/network-capture-proxy.js";

const SSE_EVENT_TEXT = 'event: message_start\ndata: {"type":"message_start"}\n\n';

const activeServers: UpstreamReplayServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Upstream replay server", () => {
  it("SCT lifecycle resolves only structured successful tool results, including operation and fork boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-app-lifecycle-replay-"));
    tempDirs.push(dir);
    const fixture = join(dir, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: 1,
        fixtures: [
          {
            id: "lifecycle",
            match: { pathIncludes: "/messages" },
            response: {
              statusCode: 200,
              toolUse: {
                name: "ForkSession",
                input: {
                  session: "{{appControlResult:toolu_sct04_create.session}}",
                  sessionId: "{{appControlResult:toolu_sct04_create.session.sessionId}}",
                  operation: "{{appControlResult:toolu_sct04_create.operation}}",
                  commandId: "{{appControlResult:toolu_sct04_create.operation.commandId}}",
                  atMessage: "{{appControlResult:toolu_sct04_page.messages.firstAssistant.id}}",
                  cursor: "{{appControlResult:toolu_sct04_page.nextCursor}}",
                  execution: "{{appControlResult:toolu_sct04_summary.summary.executionId}}",
                },
              },
            },
          },
        ],
      }),
    );
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "artifact.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(server);
    const session = {
      kind: "app",
      sourceServerId: "local",
      workspacePath: "/workspace",
      sessionId: "created",
    };
    const operation = { session, commandId: "real-command" };
    const blocks = [
      {
        type: "tool_result",
        tool_use_id: "toolu_sct04_create",
        content: JSON.stringify({ session, operation }),
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_sct04_page",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              messages: [
                { id: "user", role: "user", text: "E2E_SCT04_CREATE_TARGET" },
                { id: "internal", role: "user", text: "Available agent types" },
                { id: "assistant", role: "assistant", text: "SCT04_CREATE_DONE" },
                { id: "later-assistant", role: "assistant", text: "SCT04_SEND_DONE" },
              ],
              nextCursor: "assistant",
            }),
          },
        ],
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_sct04_summary",
        content: JSON.stringify({ summary: { executionId: "real-execution" } }),
      },
    ];
    const request = (content: unknown) =>
      fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 工具调用简写只在流式请求返回 SSE；下面的断言读取 partial_json，必须声明 stream。
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content }] }),
      });
    const response = await request(blocks);
    expect(response.status).toBe(200);
    const body = await response.text();
    const inputEvent = body.split("\n").find((line) => line.includes('"partial_json"'));
    expect(JSON.parse(JSON.parse(inputEvent!.slice("data: ".length)).delta.partial_json)).toEqual({
      session,
      sessionId: "created",
      operation,
      commandId: "real-command",
      atMessage: "assistant",
      cursor: "assistant",
      execution: "real-execution",
    });
    // 用户正文不能冒充工具回执，失败回执也不能成为下一步权威身份。
    expect((await request([{ type: "text", text: JSON.stringify(blocks) }])).status).toBe(500);
    expect((await request(blocks.map((block) => ({ ...block, is_error: true })))).status).toBe(500);
    expect(
      (
        await request(
          blocks.map((block) =>
            block.tool_use_id === "toolu_sct04_page"
              ? {
                  ...block,
                  content: JSON.stringify({
                    messages: [{ id: "fake-assistant", role: "user", text: "SCT04_CREATE_DONE" }],
                    nextCursor: "user",
                  }),
                }
              : block,
          ),
        )
      ).status,
    ).toBe(500);
  });
  it.each([
    {
      marker: "E2E_SCT03",
      tool: "OpenSession",
      field: "session",
      token: "appControlTargetRef",
    },
    {
      marker: "E2E_SCT07",
      tool: "ListSessions",
      field: "project",
      token: "appControlTargetProjectRef",
    },
  ])(
    "$marker binds only the complete App reference returned by a real tool result",
    async ({ marker, tool, field, token }) => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-app-navigation-replay-"));
      tempDirs.push(dir);
      const fixture = join(dir, "fixture.json");
      await writeFile(
        fixture,
        JSON.stringify({
          version: 1,
          fixtures: [
            {
              id: "open",
              match: { pathIncludes: "/messages" },
              response: {
                statusCode: 200,
                toolUse: { name: tool, input: { [field]: `{{${token}}}` } },
              },
            },
          ],
        }),
      );
      const server = await startUpstreamReplayServer({
        artifactPath: join(dir, "artifact.json"),
        fixturePaths: [fixture],
      });
      activeServers.push(server);
      const ref = {
        kind: "app",
        sourceServerId: "local",
        workspacePath: "/workspace",
        sessionId: "target",
        project: { kind: "app", sourceServerId: "local", projectId: "project" },
      };
      const request = (content: unknown[]) =>
        fetch(`${server.baseUrl}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream: true,
            messages: [
              { role: "user", content: `${marker}_TARGET_SESSION_ID:target` },
              { role: "user", content },
            ],
          }),
        });
      const response = await request([
        {
          type: "tool_result",
          tool_use_id: "list",
          content: JSON.stringify({ sessions: [{ session: ref }] }),
        },
      ]);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("projectId");
      expect(body).not.toContain(`{{${token}}}`);
      const inputEvent = body.split("\n").find((line) => line.includes('"partial_json"'));
      const input = JSON.parse(JSON.parse(inputEvent!.slice("data: ".length)).delta.partial_json);
      expect(input).toEqual({ [field]: field === "project" ? ref.project : ref });
      const untrusted = await request([
        { type: "text", text: JSON.stringify({ sessions: [{ session: ref }] }) },
      ]);
      expect(untrusted.status).toBe(500);
    },
  );

  it("分阶段工具参数必须逐次释放，第一次释放不能越过第二个观察点", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-replay-stages-"));
    tempDirs.push(dir);
    const fixture = join(dir, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: 1,
        fixtures: [
          {
            id: "stages",
            metadata: { timingPolicy: "controlled-stream" },
            match: { pathIncludes: "/messages" },
            response: {
              statusCode: 200,
              releaseAfterChunks: [1, 2],
              chunks: [
                { offsetMs: 0, text: "partial\n" },
                { offsetMs: 45000, text: "path-ready\n" },
                { offsetMs: 90000, text: "completed\n" },
              ],
            },
          },
        ],
      }),
    );
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "artifact.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(server);
    const response = await fetch(`${server.baseUrl}/messages`, {
      signal: AbortSignal.timeout(5000),
    });
    const reader = response.body!.getReader();
    for (const text of ["partial\n", "path-ready\n"]) {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(text);
      expect(await fetch(`${server.baseUrl}/__e2e__/gates`).then((r) => r.json())).toEqual([
        "stages",
      ]);
      expect(
        (await fetch(`${server.baseUrl}/__e2e__/release/stages`, { method: "POST" })).status,
      ).toBe(204);
    }
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("completed\n");
    expect((await reader.read()).done).toBe(true);
    expect(
      (await fetch(`${server.baseUrl}/__e2e__/release/stages`, { method: "POST" })).status,
    ).toBe(409);
  });

  it("从最新真实 workflow-hole 通知绑定 run ID，缺失通知时拒绝伪造 FillWorkflowHole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-workflow-hole-replay-"));
    tempDirs.push(dir);
    const fixture = join(dir, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: 1,
        fixtures: [
          {
            id: "fill-hole",
            match: { pathIncludes: "/messages" },
            response: {
              statusCode: 200,
              toolUse: {
                name: "FillWorkflowHole",
                input: {
                  run_id: "{{latestWorkflowRunId}}",
                  hole_id: "hole#21b40fca",
                  script: "return 1;",
                },
              },
            },
          },
        ],
      }),
    );
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "artifact.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(server);
    const request = (content: string) =>
      fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }] }),
      });
    const response = await request(
      "<workflow-hole><run-id>run-old</run-id></workflow-hole>\n<workflow-hole><run-id>run-current</run-id></workflow-hole>",
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("run-current");
    expect(body).not.toContain("run-old");
    expect(body).not.toContain("{{latestWorkflowRunId}}");
    const missing = await request("no workflow notification");
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("Missing");
  });

  it("按请求的 stream 属性选择 SSE 或 JSON 响应格式", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-replay-response-format-"));
    tempDirs.push(dir);
    const fixture = join(dir, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: 1,
        fixtures: [
          {
            id: "format-text",
            match: { bodyIncludes: ["FORMAT_PROBE_TEXT"], pathIncludes: "/messages" },
            response: { statusCode: 200, text: { id: "msg_format_text", text: "FORMAT_TEXT_OK" } },
          },
          {
            id: "format-tool",
            match: { bodyIncludes: ["FORMAT_PROBE_TOOL"], pathIncludes: "/messages" },
            response: {
              statusCode: 200,
              toolUse: { id: "toolu_format_tool", input: { value: 1 }, name: "Read" },
            },
          },
        ],
      }),
    );
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "artifact.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(server);
    const request = (content: string, stream?: true) =>
      fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          ...(stream ? { stream } : {}),
          messages: [{ role: "user", content }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });

    const nonStreamText = await request("FORMAT_PROBE_TEXT");
    expect(nonStreamText.headers.get("content-type")).toContain("application/json");
    expect(await nonStreamText.json()).toMatchObject({
      id: "msg_format_text",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "FORMAT_TEXT_OK" }],
      stop_reason: "end_turn",
    });

    const streamingText = await request("FORMAT_PROBE_TEXT", true);
    expect(streamingText.headers.get("content-type")).toContain("text/event-stream");
    const streamingBody = await streamingText.text();
    expect(streamingBody).toContain("event: message_start");
    expect(streamingBody).toContain("FORMAT_TEXT_OK");

    const nonStreamTool = await request("FORMAT_PROBE_TOOL");
    expect(nonStreamTool.headers.get("content-type")).toContain("application/json");
    expect(await nonStreamTool.json()).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_format_tool", name: "Read", input: { value: 1 } }],
      stop_reason: "tool_use",
    });
  });

  it("受控流在释放前保持 running，释放后不再等待旧的 45 秒时间轴", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-replay-gate-"));
    tempDirs.push(dir);
    const fixture = join(dir, "fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: 1,
        fixtures: [
          {
            id: "controlled",
            metadata: { timingPolicy: "controlled-stream" },
            match: { pathIncludes: "/messages" },
            response: {
              statusCode: 200,
              releaseAfterChunks: 1,
              headers: { "content-type": "text/event-stream" },
              chunks: [
                { offsetMs: 0, text: "running\n" },
                { offsetMs: 45000, text: "complete\n" },
              ],
            },
          },
        ],
      }),
    );
    const server = await startUpstreamReplayServer({
      artifactPath: join(dir, "artifact.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(server);
    const response = await fetch(`${server.baseUrl}/messages`, {
      signal: AbortSignal.timeout(5000),
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("running\n");
    expect(
      (await fetch(`${server.baseUrl}/__e2e__/release/unknown`, { method: "POST" })).status,
    ).toBe(409);
    const held = await fetch(`${server.baseUrl}/__e2e__/gates`).then((result) => result.json());
    expect(held).toEqual(["controlled"]);
    expect(
      (await fetch(`${server.baseUrl}/__e2e__/release/controlled`, { method: "POST" })).status,
    ).toBe(204);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("complete\n");
    expect((await reader.read()).done).toBe(true);
    expect(
      (await fetch(`${server.baseUrl}/__e2e__/release/controlled`, { method: "POST" })).status,
    ).toBe(409);
    // 第二个 runner 使用相同 fixture ID，也必须有独立的 gate 与请求台账。
    const other = await startUpstreamReplayServer({
      artifactPath: join(dir, "other.json"),
      fixturePaths: [fixture],
    });
    activeServers.push(other);
    const second = await fetch(`${other.baseUrl}/messages`, { signal: AbortSignal.timeout(5000) });
    const secondReader = second.body!.getReader();
    await secondReader.read();
    expect(
      (await fetch(`${server.baseUrl}/__e2e__/release/controlled`, { method: "POST" })).status,
    ).toBe(409);
    expect(await fetch(`${other.baseUrl}/__e2e__/gates`).then((value) => value.json())).toEqual([
      "controlled",
    ]);
    await fetch(`${other.baseUrl}/__e2e__/release/controlled`, { method: "POST" });
    expect(new TextDecoder().decode((await secondReader.read()).value)).toBe("complete\n");
    expect((await secondReader.read()).done).toBe(true);
  });

  it("closes the listener when the initial artifact write fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-start-failure-"));
    tempDirs.push(tempDir);
    const fixturePath = join(tempDir, "fixture.json");
    const artifactPath = join(tempDir, "artifact.json");
    const port = await reserveLoopbackPort();
    const initialWriteError = new Error("initial-artifact-write-failed");
    let artifactWriteCount = 0;
    await writeFile(fixturePath, JSON.stringify({ fixtures: [], version: 1 }, null, 2), "utf-8");

    await expect(
      startUpstreamReplayServer({
        artifactPath,
        artifactWriter: async () => {
          artifactWriteCount += 1;
          throw initialWriteError;
        },
        fixturePaths: [fixturePath],
        port,
      }),
    ).rejects.toBe(initialWriteError);

    expect(artifactWriteCount).toBe(1);
    await expectLoopbackPortAvailable(port);
  });

  // 回归：Windows 上 reader 持有 capture 读句柄时 rename 会持续 EPERM。capture 是全量快照、
  // 后写覆盖前写，中途一次快照写不成不丢数据；过去这里把模型请求打成 500，台账留下一条
  // fixtureId=null 的记录（BG46 在 60MB capture 下必现）。现在请求照常回放，收尾写入补齐。
  it("keeps replaying when a mid-request artifact snapshot hits a file lock conflict", async () => {
    let locked = true;
    let lockedWrites = 0;
    const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { artifactPath, server } = await startFixtureServer("end", "events", {
        artifactWriter: async (path, value) => {
          if (locked && (value as E2ENetworkCaptureArtifact).records.length > 0) {
            lockedWrites += 1;
            throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
              code: "EPERM",
            });
          }
          await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
        },
      });
      const response = await fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({ messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(SSE_EVENT_TEXT);
      expect(lockedWrites).toBeGreaterThan(0);

      locked = false;
      await server.stop();
      activeServers.splice(activeServers.indexOf(server), 1);
      const artifact = JSON.parse(
        await readFile(artifactPath, "utf-8"),
      ) as E2ENetworkCaptureArtifact;
      expect(artifact.records).toHaveLength(1);
      expect(artifact.records[0]?.replay?.fixtureId).toBe("sse-close-mode-end");
      expect(artifact.records[0]?.status).toBe("complete");
    } finally {
      handlerWarning.mockRestore();
    }
  });

  // 回归（CR-01）：请求内所有快照都遇到占用冲突时，旧实现只告警，不保留待写状态；
  // 冲突解除后没有新请求、也没调用 stop()，capture 永远停在旧快照，轮询文件的
  // waitForUpstreamRequest 只能超时。写入循环必须自己补写到最新快照。
  it("backfills the latest snapshot after a file lock clears without a new request or stop", async () => {
    let locked = true;
    const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { artifactPath, server } = await startFixtureServer("end", "events", {
        artifactWriter: async (path, value) => {
          if (locked && (value as E2ENetworkCaptureArtifact).records.length > 0) {
            throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
              code: "EPERM",
            });
          }
          await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
        },
      });
      const response = await fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({ messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(SSE_EVENT_TEXT);

      locked = false;
      await vi.waitFor(
        async () => {
          const artifact = JSON.parse(
            await readFile(artifactPath, "utf-8"),
          ) as E2ENetworkCaptureArtifact;
          expect(artifact.records).toHaveLength(1);
          expect(artifact.records[0]?.replay?.fixtureId).toBe("sse-close-mode-end");
          expect(artifact.records[0]?.status).toBe("complete");
        },
        { interval: 50, timeout: 5000 },
      );
    } finally {
      handlerWarning.mockRestore();
    }
  });

  // 回归（CR-01）：合并写入与冲突重试不能让较旧的快照覆盖较新的快照。
  it("never lands an older snapshot after a newer one under concurrent updates and lock conflicts", async () => {
    const landed: E2ENetworkCaptureArtifact[] = [];
    let attempts = 0;
    const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const progress = (artifact: E2ENetworkCaptureArtifact) =>
      artifact.records.length * 10 +
      artifact.records.filter((record) => record.status === "complete").length;
    try {
      const { artifactPath, server } = await startFixtureServer("end", "events", {
        artifactWriter: async (path, value) => {
          attempts += 1;
          // 真实 writer 一进入就序列化；records 之后还会被原地修改，这里同样先拍下快照。
          const snapshot = structuredClone(value) as E2ENetworkCaptureArtifact;
          // 写入耗时不一，并让部分写入撞上占用冲突。
          await new Promise((resolveDelay) => setTimeout(resolveDelay, (attempts % 3) * 15));
          if (attempts % 4 === 0) {
            throw Object.assign(new Error("EBUSY: resource busy, rename"), { code: "EBUSY" });
          }
          landed.push(snapshot);
          await writeFile(path, JSON.stringify(snapshot, null, 2), "utf-8");
        },
      });
      const send = () =>
        fetch(`${server.baseUrl}/messages`, {
          body: JSON.stringify({
            messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }).then((response) => response.text());
      await Promise.all([send(), send(), send()]);

      await vi.waitFor(
        async () => {
          const artifact = JSON.parse(
            await readFile(artifactPath, "utf-8"),
          ) as E2ENetworkCaptureArtifact;
          expect(artifact.records).toHaveLength(3);
          expect(artifact.records.every((record) => record.status === "complete")).toBe(true);
        },
        { interval: 50, timeout: 5000 },
      );
      for (let index = 1; index < landed.length; index += 1) {
        expect(progress(landed[index]!)).toBeGreaterThanOrEqual(progress(landed[index - 1]!));
      }
    } finally {
      handlerWarning.mockRestore();
    }
  });

  it.runIf(process.platform === "win32")(
    "replays normally while a reader holds the artifact open on Windows",
    async () => {
      const { artifactPath, server } = await startFixtureServer("end");
      const reader = await open(artifactPath, "r");
      const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const response = await fetch(`${server.baseUrl}/messages`, {
          body: JSON.stringify({
            messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(5000),
        });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe(SSE_EVENT_TEXT);
      } finally {
        await reader.close();
        handlerWarning.mockRestore();
      }
    },
  );

  it("expands static fixture variables before matching and replaying", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-replay-vars-"));
    tempDirs.push(tempDir);
    const fixturePath = join(tempDir, "fixture.json");
    const artifactPath = join(tempDir, "artifact.json");
    const runtimeRoot = "C:/e2e-home/ZCodeProject/.zcode-e2e";
    await writeFile(
      fixturePath,
      JSON.stringify(
        {
          fixtures: [
            {
              id: "static-runtime-path",
              match: {
                bodyIncludes: ["Read {{e2eRuntimeRoot}}/shared/readonly.txt"],
                method: "POST",
                pathIncludes: "/messages",
              },
              response: {
                statusCode: 200,
                toolUse: {
                  id: "toolu_static_runtime_path",
                  input: {
                    file_path: "{{e2eRuntimeRoot}}/shared/readonly.txt",
                  },
                  name: "Read",
                },
              },
            },
          ],
          version: 1,
        },
        null,
        2,
      ),
    );
    const server = await startUpstreamReplayServer({
      artifactPath,
      fixturePaths: [fixturePath],
      fixtureVariables: { e2eRuntimeRoot: runtimeRoot },
    });
    activeServers.push(server);

    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        stream: true,
        messages: [
          {
            content: `Read ${runtimeRoot}/shared/readonly.txt`,
            role: "user",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(responseText).toContain(`\\"file_path\\":\\"${runtimeRoot}/shared/readonly.txt\\"`);
    expect(responseText).not.toContain("{{e2eRuntimeRoot}}");
  });

  it.each([
    {
      output:
        "Command running in background with ID: bash_first. Output is being written to: /tmp/first.log.\nCommand running in background with ID: bash_last. Output is being written to: /tmp/last.log.",
      expected: "bash_last",
    },
    { output: "agentId: agent_other", expected: "{{latestBashTaskId}}" },
  ])(
    "resolves Bash task IDs from actual launch results: $expected",
    async ({ output, expected }) => {
      const tempDir = await mkdtemp(join(tmpdir(), "zcode-bash-task-replay-"));
      tempDirs.push(tempDir);
      const fixturePath = join(tempDir, "fixture.json");
      await writeFile(
        fixturePath,
        JSON.stringify({
          version: 1,
          fixtures: [
            {
              id: "bash-task-output",
              match: { method: "POST", pathIncludes: "/messages" },
              response: {
                statusCode: 200,
                toolUse: {
                  id: "toolu_bash_task_output",
                  name: "TaskOutput",
                  input: { task_id: "{{latestBashTaskId}}", block: false },
                },
              },
            },
          ],
        }),
      );
      const server = await startUpstreamReplayServer({
        fixturePaths: [fixturePath],
        artifactPath: join(tempDir, "artifact.json"),
      });
      activeServers.push(server);
      const response = await fetch(`${server.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_bash_launch",
                  content: output,
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`\\"task_id\\":\\"${expected}\\"`);
    },
  );

  it("records normal SSE EOF as complete end", async () => {
    const { artifactPath, server } = await startFixtureServer("end");

    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });

    await expect(response.text()).resolves.toBe(SSE_EVENT_TEXT);

    await server.stop();
    activeServers.pop();

    const record = (await readArtifact(artifactPath)).records[0];
    expect(record?.status).toBe("complete");
    expect(record?.replay).toEqual({
      closeMode: "end",
      fixtureId: "sse-close-mode-end",
    });
    expect(record?.responseEvents).toHaveLength(1);
  });

  it.each(["events", "chunks", "body"] as const)(
    "destroys %s SSE responses when closeMode is destroy",
    async (format) => {
      const { artifactPath, server } = await startFixtureServer("destroy", format);

      let fetchFailed = false;
      try {
        const response = await fetch(`${server.baseUrl}/messages`, {
          body: JSON.stringify({
            messages: [{ role: "user", content: "SSE_CLOSE_MODE_PROBE" }],
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(5000),
        });
        await response.text();
      } catch {
        fetchFailed = true;
      }

      await server.stop();
      activeServers.pop();

      const record = (await readArtifact(artifactPath)).records[0];
      expect(fetchFailed).toBe(true);
      expect(record?.status).toBe("error");
      expect(record?.error).toBe("Replay fixture destroyed SSE response stream");
      expect(record?.replay).toEqual({
        closeMode: "destroy",
        fixtureId: "sse-close-mode-destroy",
      });
      if (format === "events") expect(record?.responseEvents).toHaveLength(1);
      if (format === "chunks") expect(record?.responseChunkTimeline).toHaveLength(1);
      expect(record?.responseBodyBytes).toBe(Buffer.byteLength(SSE_EVENT_TEXT));
    },
  );

  it("injects a loopback Browser fixture URL without trailing punctuation", async () => {
    const server = await startBrowserVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              "BROWSER_VARIABLE_PROBE E2E_BROWSER_FIXTURE_URL:http://127.0.0.1:43123/basic),",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("http://127.0.0.1:43123/basic");
    expect(body).not.toContain("{{browserFixtureUrl}}");
    expect(body).not.toContain("/basic),");
  });

  it("injects the latest automation id from a CronList tool result", async () => {
    const server = await startAutomationVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          { role: "user", content: "AUTOMATION_VARIABLE_PROBE" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_cron_list",
                content: JSON.stringify({
                  automations: [{ automationId: "automation-runtime-123" }],
                }),
              },
            ],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("automation-runtime-123");
    expect(body).not.toContain("{{latestAutomationId}}");
  });

  it("injects Browser stable tab ids from the latest tool result", async () => {
    const server = await startBrowserTabVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          { role: "user", content: "BROWSER_TAB_VARIABLE_PROBE" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_tabs_stale",
                content:
                  '=> {"e2eBrowserTabId":"tab-single-stale","e2eBrowserTabAId":"tab-a-stale","e2eBrowserTabBId":"tab-b-stale"}\n\nStructured content:\n',
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_tabs_list",
                content:
                  '=> {\n  "e2eBrowserTabAId": "tab-a-runtime",\n  "e2eBrowserTabBId": "tab-b-runtime",\n  "e2eBrowserTabId": "tab-single-runtime"\n}\n\nStructured content:\n',
              },
            ],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("tab-single-runtime");
    expect(body).toContain("tab-a-runtime");
    expect(body).toContain("tab-b-runtime");
    expect(body).not.toContain("{{latestBrowserTabId}}");
    expect(body).not.toContain("{{latestBrowserTabAId}}");
    expect(body).not.toContain("{{latestBrowserTabBId}}");
    expect(body).not.toContain("stale");
  });

  it("fails closed when the Browser fixture URL marker is not loopback", async () => {
    const server = await startBrowserVariableFixtureServer();
    const response = await fetch(`${server.baseUrl}/messages`, {
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: "BROWSER_VARIABLE_PROBE E2E_BROWSER_FIXTURE_URL:https://example.com/basic",
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain(
      "Missing E2E_BROWSER_FIXTURE_URL replay variable",
    );
  });

  it("contains a missing Browser fixture variable artifact failure in the request handler", async () => {
    let artifactWriteCount = 0;
    let failedMissingVariableArtifact = false;
    const unhandledRejections: unknown[] = [];
    const handlerWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const server = await startBrowserVariableFixtureServer({
        artifactWriter: async (path, value) => {
          artifactWriteCount += 1;
          const artifact = value as E2ENetworkCaptureArtifact;
          const containsMissingVariableResponse = artifact.records.some(
            (record) =>
              record.status === "complete" &&
              record.statusCode === 500 &&
              record.responseTextPreview?.includes(
                "Missing E2E_BROWSER_FIXTURE_URL replay variable",
              ),
          );
          if (containsMissingVariableResponse && !failedMissingVariableArtifact) {
            failedMissingVariableArtifact = true;
            throw new Error("missing-variable-artifact-write-failed");
          }
          await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
        },
      });
      const response = await fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          messages: [{ role: "user", content: "BROWSER_VARIABLE_PROBE" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain(
        "Missing E2E_BROWSER_FIXTURE_URL replay variable",
      );
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

      expect(artifactWriteCount).toBeGreaterThanOrEqual(4);
      expect(failedMissingVariableArtifact).toBe(true);
      expect(unhandledRejections).toEqual([]);
      expect(handlerWarning).toHaveBeenCalledWith(
        expect.stringContaining("missing-variable-artifact-write-failed"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      handlerWarning.mockRestore();
    }
  });

  it("matches the latest tool_result instead of a success marker inside tool code", async () => {
    const server = await startLatestToolResultFixtureServer();
    const request = (toolResult: string) =>
      fetch(`${server.baseUrl}/messages`, {
        body: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  input: { code: "return 'E2E_TOOL_RESULT_OK'" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  content: toolResult,
                },
              ],
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const failedResult = await request("E2E_TOOL_RESULT_FAILED");
    expect(failedResult.status).toBe(500);
    await expect(failedResult.text()).resolves.toContain("Missing Upstream e2e fixture");

    const successfulResult = await request("E2E_TOOL_RESULT_OK");
    expect(successfulResult.status).toBe(200);
    await expect(successfulResult.text()).resolves.toContain("tool result matched");
  });

  it("matches the background prompt when task-notification only appears in tool schema", async () => {
    const server = await startBackgroundFixtureServer();
    const response = await requestBackgroundDirectPrompt(
      server,
      "E2E_BACKGROUND_DIRECT_USER_PROMPT: send immediately. Payload: E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD.",
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("background-direct-user-prompt-received-ok");
  });

  it("rejects the background prompt when task-notification is in the latest user message", async () => {
    const server = await startBackgroundFixtureServer();
    const response = await requestBackgroundDirectPrompt(
      server,
      "<task-notification>completed</task-notification> E2E_BACKGROUND_DIRECT_USER_PROMPT_PAYLOAD",
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("Missing Upstream e2e fixture");
  });
});

async function startFixtureServer(
  closeMode: "end" | "destroy",
  format: "events" | "chunks" | "body" = "events",
  options: {
    artifactWriter?: Parameters<typeof startUpstreamReplayServer>[0]["artifactWriter"];
  } = {},
) {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-replay-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: `sse-close-mode-${closeMode}`,
            match: {
              bodyIncludes: ["SSE_CLOSE_MODE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              closeMode,
              ...(format === "body"
                ? { body: SSE_EVENT_TEXT }
                : {
                    [format]: [
                      {
                        byteLength: Buffer.byteLength(SSE_EVENT_TEXT, "utf-8"),
                        offsetMs: 0,
                        sequence: 0,
                        text: SSE_EVENT_TEXT,
                      },
                    ],
                  }),
              headers: { "content-type": "text/event-stream; charset=utf-8" },
              statusCode: 200,
              statusMessage: "OK",
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
    ...(options.artifactWriter ? { artifactWriter: options.artifactWriter } : {}),
  });
  activeServers.push(server);
  return { artifactPath, server };
}

async function startBrowserVariableFixtureServer(
  options: {
    artifactWriter?: Parameters<typeof startUpstreamReplayServer>[0]["artifactWriter"];
  } = {},
) {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-browser-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "browser-variable",
            match: {
              bodyIncludes: ["BROWSER_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_browser_variable",
                input: {
                  code: "await tab.goto('{{browserFixtureUrl}}')",
                  title: "打开测试页面",
                },
                name: "mcp__node_repl__js",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
    ...(options.artifactWriter ? { artifactWriter: options.artifactWriter } : {}),
  });
  activeServers.push(server);
  return server;
}

async function startAutomationVariableFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-automation-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "automation-variable",
            match: {
              bodyIncludes: ["AUTOMATION_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_automation_variable",
                input: { id: "{{latestAutomationId}}", title: "updated" },
                name: "CronUpdate",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startBrowserTabVariableFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-browser-tab-variable-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "browser-tab-variable",
            match: {
              bodyIncludes: ["BROWSER_TAB_VARIABLE_PROBE"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: {
              statusCode: 200,
              toolUse: {
                id: "toolu_browser_tab_variable",
                input: {
                  code: [
                    "const browser = await agent.browsers.get('iab');",
                    "const tab = await browser.tabs.get('{{latestBrowserTabId}}');",
                    "const tabA = await browser.tabs.get('{{latestBrowserTabAId}}');",
                    "const tabB = await browser.tabs.get('{{latestBrowserTabBId}}');",
                  ].join("\n"),
                  title: "恢复 Browser tab",
                },
                name: "mcp__node_repl__js",
              },
            },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startLatestToolResultFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-tool-result-"));
  tempDirs.push(tempDir);
  const fixturePath = join(tempDir, "fixture.json");
  const artifactPath = join(tempDir, "artifact.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        fixtures: [
          {
            id: "latest-tool-result",
            match: {
              lastUserMessageIncludes: ["E2E_TOOL_RESULT_OK"],
              method: "POST",
              pathIncludes: "/messages",
            },
            response: { statusCode: 200, text: "tool result matched" },
          },
        ],
        version: 1,
      },
      null,
      2,
    ),
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

async function startBackgroundFixtureServer() {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-upstream-background-fixture-"));
  tempDirs.push(tempDir);
  const artifactPath = join(tempDir, "artifact.json");
  const fixturePath = join(
    import.meta.dirname,
    "e2e/fixtures/upstream/conversation-session/conversation-session-background.json",
  );
  const server = await startUpstreamReplayServer({
    artifactPath,
    fixturePaths: [fixturePath],
  });
  activeServers.push(server);
  return server;
}

function requestBackgroundDirectPrompt(server: UpstreamReplayServer, latestUserText: string) {
  // Bug 根因：TaskOutput 的 provider schema 自身包含 notification 标签；
  // 是否已注入通知必须只看最新 user message，不能扫描整个请求体。
  return fetch(`${server.baseUrl}/messages`, {
    body: JSON.stringify({
      messages: [{ role: "user", content: latestUserText }],
      tools: [
        {
          description: "Background tasks receive a <task-notification> when the task completes.",
          name: "TaskOutput",
        },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function readArtifact(path: string): Promise<E2ENetworkCaptureArtifact> {
  return JSON.parse(await readFile(path, "utf-8")) as E2ENetworkCaptureArtifact;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await listenOnLoopback(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNetServer(server);
    throw new Error("Temporary port server did not expose an address");
  }
  await closeNetServer(server);
  return address.port;
}

async function expectLoopbackPortAvailable(port: number): Promise<void> {
  const server = createNetServer();
  try {
    await listenOnLoopback(server, port);
  } finally {
    if (server.listening) {
      await closeNetServer(server);
    }
  }
}

function listenOnLoopback(server: NetServer, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}
