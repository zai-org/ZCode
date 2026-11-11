import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
} from "@zcode/contracts";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import {
  captureComputerUseRuntimeFromEnvironment,
  createInProcessNodeReplExecutor,
  createNodeReplMcpRuntime,
  main,
  type NodeReplMcpRuntime,
} from "../src/server.js";
import { toMcpRunResult } from "../src/result.js";
import type { NodeReplCallFacts } from "../src/call-ledger/contract.js";

/** 主线程账本里记下的可信事实（20-node-repl-call-ledger.md「结果组装」）。 */
function ledgerFacts(facts: Partial<NodeReplCallFacts> = {}): NodeReplCallFacts {
  return { cuaApps: [], browserScreenshots: [], browserUse: false, computerUse: false, ...facts };
}
import {
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  JS_TOOL_DESCRIPTION,
} from "../src/tool-contract.js";

describe("node_repl MCP server", () => {
  const packageVersion = (
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  let client: Client;
  let runtime: NodeReplMcpRuntime;

  const requestMeta = (
    sessionId: string,
    runtimeScope: "main" | "subagent" = "main",
    turnId = "turn-1",
  ) => ({
    "com.zcode/request-context": {
      runtime_scope: runtimeScope,
      session_id: sessionId,
      turn_id: turnId,
    },
  });

  beforeEach(async () => {
    runtime = createNodeReplMcpRuntime({ executeJs: createInProcessNodeReplExecutor() });
    client = new Client({ name: "node-repl-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    runtime.dispose();
  });

  it("exports the main entrypoint required by the packaged plugin host", () => {
    expect(main).toBeTypeOf("function");
    expect(client.getServerVersion()).toEqual({
      name: "node_repl",
      version: packageVersion,
    });
  });

  it("captures Computer Use credentials before the plugin host restores its environment", async () => {
    const capturedRuntime = captureComputerUseRuntimeFromEnvironment({
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/deferred-cua.sock",
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "deferred-cua-token",
    });
    expect(capturedRuntime).toBeDefined();

    let forwardedBroker: unknown;
    const deferredRuntime = createNodeReplMcpRuntime({
      cuaRuntime: capturedRuntime,
      executeJs: async (input) => {
        forwardedBroker = input.cuaBroker;
        return { logs: "", result: "ok" };
      },
    });
    const deferredClient = new Client({ name: "deferred-cua-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await deferredRuntime.server.connect(serverTransport);
    await deferredClient.connect(clientTransport);

    try {
      await deferredClient.callTool({
        name: "js",
        arguments: { code: "1", title: "验证 Computer Use bridge" },
        _meta: requestMeta("deferred-cua-session"),
      });
      expect(forwardedBroker).toMatchObject({
        socketPath: expect.any(String),
        token: expect.any(String),
      });
    } finally {
      await deferredClient.close();
      deferredRuntime.dispose();
    }
  });

  it("requires user-facing titles in the model schema while preserving legacy runtime input", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["js"]);

    const js = tools.find((tool) => tool.name === "js");
    expect(js?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["code", "title"],
      type: "object",
    });
    expect(Object.keys(js?.inputSchema.properties ?? {}).sort()).toEqual([
      "code",
      "timeout_ms",
      "title",
    ]);
    expect(js?.inputSchema.properties?.code).toMatchObject({
      description: "JavaScript code to execute in the Node REPL session",
    });
    expect(js?.inputSchema.properties?.timeout_ms).toMatchObject({
      description: expect.stringContaining(
        "You MUST provide this when the code is expected to run longer than 30000 ms",
      ),
    });
    expect(js?.description).toContain("required `title`");
    expect(NODE_REPL_DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(NODE_REPL_SERVER_INSTRUCTIONS).toContain("default to a 60000 ms timeout");
    expect(js?.description).toContain("after 60000 ms");
    expect(js?.description).toContain(
      "you MUST set `timeout_ms` to at least the estimated total runtime plus 15000 ms",
    );
    expect(js?.description).not.toContain("after 30000 ms");

    const legacyCall = await client.callTool({
      name: "js",
      arguments: { code: '"legacy";' },
    });
    expect(legacyCall.isError).not.toBe(true);
    expect(legacyCall.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "=> legacy" }),
    );
  });

  it("states node_repl is unsandboxed while forbidding non-skill work", async () => {
    const { tools } = await client.listTools();
    const js = tools.find((tool) => tool.name === "js");

    for (const text of [NODE_REPL_SERVER_INSTRUCTIONS, js?.description ?? ""]) {
      expect(text).toMatch(/^Browser Use and Computer Use only\./);
      expect(text).toContain("runs unsandboxed with the ZCode agent's privileges");
      expect(text).toContain("skips Bash's dangerous-command approval");
      expect(text).toContain("never use it for shell, file, package inspection, or data processing work");
      expect(text).not.toContain("start processes");
      expect(text).not.toContain("Import only");
      expect(text).not.toContain("bare package specifiers");
      expect(text).not.toContain("by absolute `file://` URL");
    }
  });

  it("keeps Browser Use and Computer Use usage rules in their skills", () => {
    expect(JS_TOOL_DESCRIPTION).toContain("`nodeRepl.write(value)`");
    expect(JS_TOOL_DESCRIPTION).toContain("`await nodeRepl.emitImage(imageLike)`");
    expect(JS_TOOL_DESCRIPTION).toContain(
      "Bootstrap the requested official capability in every call.",
    );
    for (const text of [NODE_REPL_SERVER_INSTRUCTIONS, JS_TOOL_DESCRIPTION]) {
      for (const skillRule of [
        "get_app_state",
        "state_id",
        "state.text",
        "console.log",
        "action_sent",
        "screenshot_display",
        "raster",
        "same cell",
        "earlier call",
        "BrowserControl",
        "nodeRepl.cwd",
        "setResponseMeta",
        "open_application",
      ]) {
        expect(text).not.toContain(skillRule);
      }
    }
  });

  it("creates a fresh kernel for every js call", async () => {
    const first = await client.callTool({
      name: "js",
      arguments: {
        code: "globalThis.counter = 41; counter;",
        title: "初始化计数",
      },
      _meta: requestMeta("session-1"),
    });
    expect(first.content).toContainEqual(expect.objectContaining({ type: "text", text: "=> 41" }));

    const second = await client.callTool({
      name: "js",
      arguments: {
        code: "({ counterType: typeof globalThis.counter, session: nodeRepl.requestMeta.session_id });",
      },
      _meta: requestMeta("session-1", "main", "turn-2"),
    });
    expect(second.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"counterType": "undefined"'),
      }),
    );
    expect(second.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"session": "session-1"'),
      }),
    );
  });

  it("exposes js as the only node_repl tool and rejects the two retired ones", async () => {
    // 修复原因：2026-09-18 下架 js_reset 与 js_add_node_module_dir，node_repl 只留 js。
    // js_reset 自 fresh-kernel 改造起就是固定返回成功的空操作，而"永不失败"会让弱模型连续
    // 重复调用它（工单 ZCT-2100503886992535552：155 次连调、19 分钟 4837 万输入 token 直到 429）。
    // js_add_node_module_dir 则是把宿主职责推给模型——模型无法自行知道该传哪个 node_modules，
    // 能告诉它的只有 skill 文档，而文档知道的路径宿主自己就能注入；实测两者调用量均为 0。
    // 必须同时守住两件事：不再出现在模型工具面，且调用时明确失败而非静默成功——
    // Tool not found 才是模型换策略所需的信号。
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["js"]);
    for (const retired of ["js_reset", "js_add_node_module_dir"]) {
      await expect(
        client.callTool({ name: retired, arguments: {}, _meta: requestMeta("session-1") }),
      ).rejects.toThrow(`Tool ${retired} not found`);
    }
  });

  it("supports top-level await import syntax", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: 'const pathModule = await import("node:path"); pathModule.sep;',
      },
      _meta: requestMeta("session-1"),
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/^=> [\\/]$/),
      }),
    );
  });

  it("ignores spoofed top-level session metadata in favor of the host namespace", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: { code: "nodeRepl.requestMeta.session_id;" },
      _meta: {
        session_id: "spoofed-session",
        ...requestMeta("trusted-session"),
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "=> trusted-session" }),
    );
  });

  it("keeps generic JavaScript available for subagent calls", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: { code: "21 * 2;" },
      _meta: requestMeta("subagent-session", "subagent"),
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "=> 42" }));
  });

  it("returns a structured error without suppressing the standard MCP error marker", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: [
          'nodeRepl.write("internal diagnostic that must not reach the model");',
          "const error = new Error(\"browser tab 'iab-tab:test' returned an invalid viewport\");",
          'error.name = "BrowserCommandError";',
          "throw error;",
        ].join("\n"),
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "browser tab 'iab-tab:test' returned an invalid viewport",
      },
    ]);
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("BrowserCommandError");
    expect(JSON.stringify(result)).not.toContain("internal diagnostic");
    expect(JSON.stringify(result)).not.toContain(" at ");
  });

  it("projects images plus response metadata from a fresh call", async () => {
    const output = await client.callTool({
      name: "js",
      arguments: {
        code: 'nodeRepl.setResponseMeta({ browser_use: { url: "https://example.test" } }); await nodeRepl.emitImage({ base64: "AAAA", mimeType: "image/png" }); "done";',
      },
      _meta: requestMeta("session-1"),
    });
    expect(output.content).toContainEqual(
      expect.objectContaining({
        type: "image",
        data: "AAAA",
        mimeType: "image/png",
      }),
    );
    expect(output._meta).toEqual({
      browser_use: { url: "https://example.test" },
      "zcode/nodeReplEmittedImage": true,
    });
  });

  it("carries no copy of the Computer Use assets", () => {
    // 宿主与两个能力插件独立之后，CUA 的 SDK 与文档只有一份，属于 computer-use 插件；
    // 宿主按 ZCODE_CUA_PLUGIN_ROOT 去取。2026-09-11 之前 browser-use 各存一份手工副本，
    // 其中文档那份悄悄停在重构前的 API，兜底路径会把它发给模型。
    for (const relative of [
      "../../browser-use-plugin/scripts/computer-use-client.mjs",
      "../../browser-use-plugin/docs/computer-use.md",
      "../scripts/computer-use-client.mjs",
      "../docs/computer-use.md",
    ]) {
      expect(
        existsSync(resolve(import.meta.dirname, relative)),
        `${relative} must not exist: the canonical copy lives in zcode-cua-plugin`,
      ).toBe(false);
    }
    expect(
      existsSync(
        resolve(import.meta.dirname, "../../zcode-cua-plugin/scripts/computer-use-client.mjs"),
      ),
    ).toBe(true);
  });

  it("orders image blocks before the text block so image-first providers keep the raster", () => {
    const result = toMcpRunResult({
      logs: "log line",
      result: "done",
      images: [
        { base64: "AQID", mimeType: "image/png" },
        { base64: "BAUG", mimeType: "image/jpeg" },
      ],
    });

    expect(result.content).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "image", data: "BAUG", mimeType: "image/jpeg" },
      { type: "text", text: "log line\n=> done" },
    ]);
  });

  it("drops a byte-identical emitImage duplicate so a redundant call cannot cost the whole frame", () => {
    // Bug 原因（2026-09-11 真机）：模型写
    //   const shot = await app.getScreenshot(); await nodeRepl.emitImage(shot);
    // getScreenshot 已经经 emitStructuredResult 投过「图 + 权威」，于是结果里两张图，
    // exact-raster 门按「每个结果只允许一张最终 raster」把整帧原子否决。
    //
    // 门不能放宽（frame_id 绑定像素坐标），但逐字节相同的那份是纯冗余，丢掉即可，
    // 冗余调用不再连累整帧被否决。
    const authority = JSON.stringify({
      image_ref: { actionable: true, frame_id: "frame-1", height: 2, width: 4 },
    });
    const result = toMcpRunResult({
      structuredResults: [
        {
          content: [
            { type: "image", data: "AQID", mimeType: "image/png" },
            { type: "text", text: authority },
          ],
        },
      ],
      images: [{ base64: "AQID", mimeType: "image/png" }],
    } as never);

    const images = result.content.filter((block) => block.type === "image");
    expect(images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    // 权威必须紧跟在存活的那张图后面 —— 原子对不能被去重打散。
    expect(result.content[0]?.type).toBe("image");
    expect((result.content[1] as { text?: string }).text).toBe(authority);
  });

  it("keeps a different model image so a genuine two-raster result still reaches the gate", () => {
    // 字节不同就不是冗余：那是真的两张 raster，判定权仍属完整性门，宿主不得代它放行。
    const result = toMcpRunResult({
      structuredResults: [{ content: [{ type: "image", data: "AQID", mimeType: "image/png" }] }],
      images: [{ base64: "ZZZZ", mimeType: "image/png" }],
    } as never);

    expect(result.content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("flattens an SDK CallToolResult so CUA action-state and image references stay top-level", () => {
    const embedded = {
      content: [
        { type: "text", text: "Clicked Save." },
        {
          type: "text",
          text: JSON.stringify({
            schema_version: "zcode-cua-action-outcome-v1",
            action_sent: true,
            verification_status: "verified",
            state_available: true,
          }),
        },
        { type: "text", text: '{"image_ref":"frame-1"}' },
      ],
      structuredContent: { action_state: { state_id: "state-2" } },
    };
    const result = toMcpRunResult({
      logs: "",
      result: `=> ${JSON.stringify(embedded)}`,
      images: [{ base64: "AQID", mimeType: "image/png" }],
    });

    expect(result.content).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      ...embedded.content,
    ]);
    expect(result).toMatchObject({ structuredContent: embedded.structuredContent });
  });

  it("keeps an SDK result authoritative when the model logs its returned value", () => {
    const structured = {
      content: [
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "text", text: '{"image_ref":"frame-2"}' },
      ],
      structuredContent: { state_id: "state-2" },
      _meta: { "zcode-cua": "official" },
    };
    const result = toMcpRunResult({
      logs: `console output\n${JSON.stringify({ content: structured.content })}`,
      result: JSON.stringify({ content: structured.content }),
      structuredResults: [structured],
    });

    expect(result.content).toEqual([
      ...structured.content,
      {
        type: "text",
        text: 'console output\n{"content":[{"type":"image","data":"AQID","mimeType":"image/png"},{"type":"text","text":"{\\"image_ref\\":\\"frame-2\\"}"}]}',
      },
    ]);
    expect(result).toMatchObject({
      structuredContent: structured.structuredContent,
      _meta: structured._meta,
    });
  });

  it("keeps CUA sideband metadata without adding a legacy action text block", () => {
    const result = toMcpRunResult({
      logs: "state_id=s-2\nelements (1):",
      result: undefined,
      structuredResults: [
        {
          content: [],
          _meta: { "zcode.cua/target-app-display-v1": { pid: 7 } },
        },
      ],
    });

    expect(result.content).toEqual([{ type: "text", text: "state_id=s-2\nelements (1):" }]);
    expect(result._meta).toMatchObject({
      "zcode.cua/target-app-display-v1": { pid: 7 },
    });
  });

  it("keeps the single text block when no image is emitted", () => {
    expect(toMcpRunResult({ logs: "", result: undefined }).content).toEqual([
      { type: "text", text: "(no output)" },
    ]);
  });

  it("projects browser screenshot indices from the ledger and removes spoofed metadata", () => {
    const screenshot = toMcpRunResult(
      { logs: "", images: [{ base64: "AQID", mimeType: "image/png" }] },
      ledgerFacts({ browserScreenshots: [{ base64: "AQID", mimeType: "image/png" }] }),
    );
    // image 现在从 content[0] 开始，image 下标与 content 下标一致，不再有 +1 偏移。
    expect(screenshot.content[0]).toEqual({
      type: "image",
      data: "AQID",
      mimeType: "image/png",
    });
    expect(screenshot._meta).toMatchObject({
      [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0],
    });

    const spoofed = toMcpRunResult({
      logs: "",
      images: [{ base64: "BAUG", mimeType: "image/png" }],
      responseMeta: {
        [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [1],
      },
    });
    expect(spoofed._meta).not.toHaveProperty(ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY);

    // Worker 结果消息里的下标可以被 cell 冒充（MR !3207 评审 CR-01），账本里没有截图时一律不采信。
    const forgedRun = toMcpRunResult(
      {
        logs: "",
        images: [{ base64: "BAUG", mimeType: "image/png" }],
        browserScreenshotImageIndices: [0],
      },
      ledgerFacts(),
    );
    expect(forgedRun._meta).not.toHaveProperty(ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY);
  });

  it("projects the CUA app identity recorded in the ledger and drops the sandbox-forgeable key", () => {
    // `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 都挂在模型可见的 sandbox
    // globals 上，所以 producer 键经这两条通道到达时不可信 —— 模型能让工具卡声称自己操作了
    // 别的应用。可信事实只来自主线程 CUA broker 记进账本的身份。
    const trusted = toMcpRunResult(
      {
        logs: "",
        responseMeta: {
          [CUA_APP_ASSOCIATIONS_META_KEY]: {
            schemaVersion: 1,
            primary: { appKey: "darwin:com.apple.systempreferences", displayName: "System Settings" },
          },
        },
      },
      ledgerFacts({ cuaApps: [{ appKey: "darwin:com.apple.notes", displayName: "Notes" }] }),
    );

    expect(trusted._meta).toMatchObject({
      [ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY]: {
        appKey: "darwin:com.apple.notes",
        displayName: "Notes",
      },
    });
    // 伪造的 producer 键必须整条消失，不能与可信键并存后被下游误取。
    expect(trusted._meta).not.toHaveProperty(CUA_APP_ASSOCIATIONS_META_KEY);

    // 没有可信记录时，光靠沙箱伪造拿不到任何身份。
    const forgedOnly = toMcpRunResult({
      logs: "",
      responseMeta: {
        [CUA_APP_ASSOCIATIONS_META_KEY]: {
          schemaVersion: 1,
          primary: { appKey: "darwin:com.apple.notes" },
        },
      },
    } as never);
    expect(forgedOnly._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY);
    expect(forgedOnly._meta ?? {}).not.toHaveProperty(CUA_APP_ASSOCIATIONS_META_KEY);

    // Worker 结果消息里的 cuaApp 可以被 cell 冒充（MR !3207 评审 CR-01），不采信。
    const forgedRun = toMcpRunResult(
      { logs: "", cuaApp: { appKey: "darwin:com.apple.notes" } },
      ledgerFacts(),
    );
    expect(forgedRun._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY);
  });

  // 会话能力标签的两个 key 只按账本写（session-features-header.md「BUA/CUA 标签的补充规则」）。
  it("writes the runtime-call keys only from the ledger and drops copies the cell writes", () => {
    const forged = {
      [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true,
      [ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY]: true,
    };
    // 口径是真实尝试：cell 以错误结束也写。
    const failed = toMcpRunResult(
      { logs: "", error: { name: "Error", message: "boom" } },
      ledgerFacts({ browserUse: true, computerUse: true }),
    );
    expect(failed.isError).toBe(true);
    expect(failed._meta).toMatchObject(forged);

    const browserOnly = toMcpRunResult(
      { logs: "", responseMeta: forged },
      ledgerFacts({ browserUse: true }),
    );
    expect(browserOnly._meta).toMatchObject({ [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true });
    expect(browserOnly._meta).not.toHaveProperty(ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY);

    // sandbox 通道写入的同名 key、Worker 结果消息里冒充的字段（MR !3207 评审 CR-01）一律不采信。
    for (const run of [
      { logs: "", responseMeta: forged },
      {
        logs: "",
        result: JSON.stringify({ content: [{ type: "text", text: "x" }], _meta: forged }),
      },
      { logs: "", browserUse: true, computerUse: true },
    ]) {
      const result = toMcpRunResult(run as never, ledgerFacts());
      expect(result._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY);
      expect(result._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY);
    }
  });

  it("maps screenshot indices to their real content positions when only some images are screenshots", () => {
    const result = toMcpRunResult({
      logs: "",
      images: [
        { base64: "AAAA", mimeType: "image/png" },
        { base64: "BBBB", mimeType: "image/png" },
        { base64: "CCCC", mimeType: "image/png" },
      ],
    }, ledgerFacts({
      browserScreenshots: [
        { base64: "AAAA", mimeType: "image/png" },
        { base64: "CCCC", mimeType: "image/png" },
      ],
    }));

    expect(result._meta).toMatchObject({
      [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0, 2],
    });
    // 每个声明的下标都必须真的指向 content 里的 image block（越界或指到 text 都会让原图落盘错位）。
    for (const index of [0, 2]) {
      expect(result.content[index]?.type).toBe("image");
    }
    expect(result.content[1]).toEqual({ type: "image", data: "BBBB", mimeType: "image/png" });
  });

  it("derives screenshot indices from what the browser proxy saw, end to end", async () => {
    // 真实 MCP server + 浏览器代理 broker + 假的上游浏览器 broker：可信的截图下标只来自代理在
    // 主线程记下的截图（20-node-repl-call-ledger.md「结果组装」）。
    const upstreamPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-ledger-e2e-${randomUUID()}`
        : join(tmpdir(), `zle-${randomUUID()}.sock`);
    const upstreamRequests: Array<Record<string, unknown>> = [];
    const upstream = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        upstreamRequests.push(request);
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { ok: true, elapsedMs: 1, image: { base64: "AQID", mimeType: "image/png" } },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolveListen) => upstream.listen(upstreamPath, resolveListen));
    const browserRuntime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      browserBrokerUpstream: { socketPath: upstreamPath, token: "u".repeat(64) },
    });
    const browserClient = new Client({ name: "node-repl-ledger-e2e", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await browserRuntime.server.connect(serverTransport);
    await browserClient.connect(clientTransport);
    try {
      const result = await browserClient.callTool({
        name: "js",
        arguments: {
          code: [
            'const bridge = globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];',
            'const shot = await bridge.execute("browser-1", 1, { method: "screenshot" });',
            "await nodeRepl.emitImage(shot.image);",
            '"shot";',
          ].join("\n"),
        },
        _meta: requestMeta("ledger-session"),
      });

      expect(result.content).toEqual([
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "text", text: "=> shot" },
      ]);
      expect(result._meta).toMatchObject({
        [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0],
      });
      // 上游收到的是上游 token 与本次调用来自 core 的会话信息。
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]).toMatchObject({
        op: "execute",
        token: "u".repeat(64),
        sessionId: "ledger-session",
        runtimeScope: "main",
        turnId: "turn-1",
      });
    } finally {
      await browserClient.close();
      browserRuntime.dispose();
      await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
      if (process.platform !== "win32") await rm(upstreamPath, { force: true });
    }
  });

  it("marks runtime calls that reach the real brokers, end to end, and nothing else", async () => {
    // 真实 MCP server + 两个 broker：浏览器上游拒绝命令、CUA runtime 抛错，cell 也都接住了错误；
    // 口径是真实尝试，两个 key 照样写出（session-features-header.md「BUA/CUA 标签的补充规则」）。
    const upstreamPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-runtime-use-e2e-${randomUUID()}`
        : join(tmpdir(), `zru-${randomUUID()}.sock`);
    const upstream = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id?: unknown };
        const response = { id: request.id, ok: false, error: "Browser is not connected" };
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    await new Promise<void>((resolveListen) => upstream.listen(upstreamPath, resolveListen));
    let cuaExecuted = 0;
    const useRuntime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      browserBrokerUpstream: { socketPath: upstreamPath, token: "u".repeat(64) },
      cuaRuntime: {
        execute: async () => {
          cuaExecuted += 1;
          throw new Error("Computer Use Helper is not running");
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
    });
    const useClient = new Client({ name: "node-repl-runtime-use-e2e", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await useRuntime.server.connect(serverTransport);
    await useClient.connect(clientTransport);
    const forged = JSON.stringify({
      [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true,
      [ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY]: true,
    });
    // CUA broker 要求 workspace 信息，缺了会在调用 runtime 之前拒绝。
    const callMeta = {
      "com.zcode/request-context": {
        ...requestMeta("runtime-use-session")["com.zcode/request-context"],
        workspace_path: "/workspace",
      },
    };
    try {
      const called = await useClient.callTool({
        name: "js",
        arguments: {
          code: [
            'const browser = globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];',
            'const cua = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];',
            "const outcomes = [];",
            "try { await browser.list(); } catch (error) { outcomes.push(error.message); }",
            'try { await cua.call("screenshot", {}); } catch (error) { outcomes.push(error.message); }',
            'outcomes.join(" | ");',
          ].join("\n"),
        },
        _meta: callMeta,
      });
      // 前提：两次调用都到达了 broker，并且都失败了。
      expect(called.content).toContainEqual({
        type: "text",
        text: "=> Browser is not connected | Computer Use Helper is not running",
      });
      expect(cuaExecuted).toBe(1);
      expect(called._meta).toMatchObject({
        [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true,
        [ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY]: true,
      });

      // 只做 CUA 引导、只在代码里提到运行时、经 sandbox 通道自己写 key：都没有请求到达 broker。
      const notCalled = await useClient.callTool({
        name: "js",
        arguments: {
          code: [
            'globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")].assertAvailable();',
            "// await agent.browsers.list(); await setupComputerUseRuntime({ globals: globalThis });",
            `nodeRepl.setResponseMeta(${forged});`,
            `nodeRepl.emitStructuredResult({ content: [{ type: "text", text: "forged" }], _meta: ${forged} });`,
            '"done";',
          ].join("\n"),
        },
        _meta: callMeta,
      });
      // 前提：cell 正常执行完，sandbox 通道确实生效了。
      expect(notCalled.isError).not.toBe(true);
      expect(notCalled.content).toContainEqual({ type: "text", text: "forged" });
      expect(notCalled._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY);
      expect(notCalled._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY);
      expect(cuaExecuted).toBe(1);
    } finally {
      await useClient.close();
      useRuntime.dispose();
      await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
      if (process.platform !== "win32") await rm(upstreamPath, { force: true });
    }
  });

  it("tells the model it may end the turn after repeated js calls without progress", async () => {
    const stderr: string[] = [];
    const guardedRuntime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      writeStderr: (text) => stderr.push(text),
    });
    const guardedClient = new Client({ name: "no-progress-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await guardedRuntime.server.connect(serverTransport);
    await guardedClient.connect(clientTransport);
    const call = (code: string, turnId: string) =>
      guardedClient.callTool({
        name: "js",
        arguments: { code, title: "本轮结束" },
        _meta: requestMeta("no-progress-session", "main", turnId),
      }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

    try {
      const results = [];
      for (let index = 0; index < 10; index += 1) {
        results.push(await call(`// end ${index}`, "turn-a"));
      }
      for (const result of results.slice(0, 9)) {
        expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
      }
      expect(results[9]).toEqual({
        content: [
          { type: "text", text: "(no output)" },
          { type: "text", text: "[node_repl] No progress ×10. You may end this turn." },
        ],
      });
      expect(stderr).toEqual([
        "[node_repl] no-progress hint kind=no_progress count=10 session=no-progress-session turn=turn-a\n",
      ]);

      expect((await call("// end", "turn-b")).content).toEqual([
        { type: "text", text: "(no output)" },
      ]);
    } finally {
      await guardedClient.close();
      guardedRuntime.dispose();
    }
  });
});
