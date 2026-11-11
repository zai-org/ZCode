/* CR-01 —— 官方 MCP 身份头端口构造协议参数的定向测试（spec §7.1 / §7.2）。
 *
 * 覆盖缺口说明：officialMcpAuthRemoteRouting.test.ts 验证的是 service 层**收到** workspace
 * 之后的响应路由，不覆盖本端口把 OfficialMcpAuthHeadersPort 入参转成协议参数这一段。
 * 同路径、不同 identity 的远端 workspace 在这里如果丢掉 identity，审计上下文就无法区分。
 */
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "../src/zcode-protocol/official-mcp-auth-port.js";

const OK = { headers: { Authorization: "Bearer jwt" }, ok: true as const };

/** 与 zcode-protocol-entrypoint.ts 相同的构造口径：workspaceKey = 会话 key || identity?.trim() || path。 */
function entrypointResolveWorkspace(fallbackCwd: string) {
  return ({
    workspaceIdentity,
    workspacePath,
    workspaceKey,
  }: {
    workspaceIdentity?: string;
    workspacePath?: string;
    workspaceKey?: string;
  }) => {
    const path = workspacePath ?? fallbackCwd;
    if (!path) return undefined;
    const identity = workspaceIdentity?.trim();
    return {
      ...(identity ? { workspaceIdentity: identity } : {}),
      workspaceKey: workspaceKey || identity || path,
      workspacePath: path,
    };
  };
}

function createHarness(
  options: { resolveWorkspace?: ReturnType<typeof entrypointResolveWorkspace> } = {},
) {
  const requestClient = vi.fn(async () => OK);
  const context = { requestClient } as unknown as OfficialMcpAuthRequestContext;
  const port = createOfficialMcpAuthHeadersPort({
    resolveContext: () => context,
    resolveWorkspace: options.resolveWorkspace ?? entrypointResolveWorkspace("/fallback"),
  });
  const sentWorkspace = (call: number) =>
    (requestClient.mock.calls[call]?.[1] as { workspace: Record<string, string> }).workspace;
  return { port, requestClient, sentWorkspace };
}

const BASE_REQUEST = {
  mcpKey: "image-search",
  pluginId: "zcode-tools@zcode-plugins-official",
  targetOrigin: "https://mcp.zcode.example",
};

describe("official mcp auth headers port", () => {
  it("CR-01: keeps same-path workspaces distinguishable by workspaceIdentity", async () => {
    const { port, sentWorkspace } = createHarness();

    await port.resolveHeaders({
      ...BASE_REQUEST,
      workspaceIdentity: "remote:wsl:ubuntu:/workspace/app",
      workspacePath: "/workspace/app",
    });
    await port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/workspace/app" });

    // 同 workspacePath，但 identity 不同 -> 协议参数必须可区分
    expect(sentWorkspace(0)).toEqual({
      workspaceIdentity: "remote:wsl:ubuntu:/workspace/app",
      workspaceKey: "remote:wsl:ubuntu:/workspace/app",
      workspacePath: "/workspace/app",
    });
    expect(sentWorkspace(1)).toEqual({
      workspaceKey: "/workspace/app",
      workspacePath: "/workspace/app",
    });
  });

  it("routes a managed worktree session by its workspace key, not its working directory", async () => {
    const { port, sentWorkspace } = createHarness();

    await port.resolveHeaders({
      ...BASE_REQUEST,
      workspacePath: "/data/.zcode/worktrees/3f2a/repo",
      workspaceKey: "/projects/repo",
    });

    // Host 按 workspaceKey 路由；按工作目录重算会被拒为"未通过工作区路由"（§9.3）。
    expect(sentWorkspace(0)).toEqual({
      workspaceKey: "/projects/repo",
      workspacePath: "/data/.zcode/worktrees/3f2a/repo",
    });
  });

  it("sends the declared plugin identity and target origin unchanged", async () => {
    const { port, requestClient } = createHarness();
    await port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/repo" });
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
      expect.objectContaining({
        mcpKey: "image-search",
        pluginId: "zcode-tools@zcode-plugins-official",
        targetOrigin: "https://mcp.zcode.example",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses a distinct requestId per call", async () => {
    const { port, requestClient } = createHarness();
    await port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/repo" });
    await port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/repo" });
    const ids = requestClient.mock.calls.map(
      (call) => (call[1] as { requestId: string }).requestId,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("fails closed when the server context is not ready yet", async () => {
    const requestClient = vi.fn(async () => OK);
    const port = createOfficialMcpAuthHeadersPort({
      resolveContext: () => undefined,
      resolveWorkspace: entrypointResolveWorkspace("/fallback"),
    });
    await expect(port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/repo" })).resolves.toEqual(
      { ok: false, reason: "official_auth_unavailable" },
    );
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("fails closed when no workspace can be resolved", async () => {
    const { port, requestClient } = createHarness({
      resolveWorkspace: entrypointResolveWorkspace(""),
    });
    await expect(port.resolveHeaders({ ...BASE_REQUEST })).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("maps a transport failure to official_auth_unavailable without leaking details", async () => {
    const context = {
      requestClient: vi.fn(async () => {
        throw new Error("stdio closed: /secret/path context");
      }),
    } as unknown as OfficialMcpAuthRequestContext;
    const port = createOfficialMcpAuthHeadersPort({
      resolveContext: () => context,
      resolveWorkspace: entrypointResolveWorkspace("/fallback"),
    });
    const result = await port.resolveHeaders({ ...BASE_REQUEST, workspacePath: "/repo" });
    // 绝不降级为匿名，且不把可能含上下文的错误详情带出
    expect(result).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });
});
