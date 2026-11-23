import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handlePlainHttpMcpRequest } from "./mcp-plain-http-fixture.js";

const ACCESS_TOKEN = "e2e-mcp-oauth-access-token";
const REFRESH_TOKEN = "e2e-mcp-oauth-refresh-token";
const AUTHORIZATION_CODE = "e2e-mcp-oauth-code";
const CLIENT_ID = "e2e-mcp-oauth-client";
const CLIENT_SECRET = "e2e-mcp-oauth-secret";
const SCOPE = "mcp:tools";
const OAUTH_TOOL_NAME = "oauth_ping";
/** OAuth 工具调用的返回前缀；调用方用 `${前缀}:${marker}` 断言真实执行。 */
export const MCP_OAUTH_PONG_PREFIX = "E2E_MCP_OAUTH_PONG";
const INVALID_GRANT = "invalid_grant";
const GRANT_TYPE_AUTHORIZATION_CODE = "authorization_code";
const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";

export interface McpOAuthInitializeRecord {
  at: number;
  /** 0 是首次授权签发的 token；每次吊销后重新授权加 1。 */
  tokenGeneration: number;
}

export interface McpOAuthToolCallRecord {
  at: number;
  marker: string | null;
  tokenGeneration: number;
}

export interface McpOAuthStatusIsolationSnapshot {
  authorizationRequestCount: number;
  authorizedInitializeCount: number;
  authorizedInitializes: McpOAuthInitializeRecord[];
  oauthToolCalls: McpOAuthToolCallRecord[];
  plainHttpInitializeCount: number;
  plainHttpToolCallMarkers: string[];
  registrationRequestCount: number;
  /** 吊销后 refresh_token 换 token 被拒（invalid_grant）的次数。 */
  rejectedRefreshCount: number;
  tokenGeneration: number;
  tokenRequestCount: number;
  /** 吊销后被 401 拒绝的 tools/call 时间。 */
  unauthorizedToolCallAt: number[];
  unauthorizedMcpRequestCount: number;
}

export interface McpOAuthStatusIsolationServer {
  close: () => Promise<void>;
  completeAuthorization: (authorizationUrl: string) => Promise<void>;
  mcpUrl: string;
  plainHttpMcpUrl: string;
  /**
   * 吊销当前 token：旧 access token 之后一律 401，refresh_token 换 token 返回 invalid_grant，
   * 只能走交互授权；下一次授权码换 token 签发新一代 token。
   */
  revokeTokens: () => void;
  snapshot: () => McpOAuthStatusIsolationSnapshot;
}

interface McpOAuthTokenState {
  revoked: boolean;
}

export async function startMcpOAuthStatusIsolationServer(): Promise<McpOAuthStatusIsolationServer> {
  const state: McpOAuthStatusIsolationSnapshot = {
    authorizationRequestCount: 0,
    authorizedInitializeCount: 0,
    authorizedInitializes: [],
    oauthToolCalls: [],
    plainHttpInitializeCount: 0,
    plainHttpToolCallMarkers: [],
    registrationRequestCount: 0,
    rejectedRefreshCount: 0,
    tokenGeneration: 0,
    tokenRequestCount: 0,
    unauthorizedToolCallAt: [],
    unauthorizedMcpRequestCount: 0,
  };
  const tokens: McpOAuthTokenState = { revoked: false };
  let baseUrl = "";
  let mcpUrl = "";
  let plainHttpMcpUrl = "";

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      baseUrl,
      mcpUrl,
      plainHttpMcpUrl,
      state,
      tokens,
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("MCP OAuth E2E server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  mcpUrl = `${baseUrl}/mcp`;
  plainHttpMcpUrl = `${baseUrl}/plain-mcp`;

  return {
    close: () => closeServer(server),
    async completeAuthorization(authorizationUrl) {
      const authorizationResponse = await fetch(authorizationUrl, {
        redirect: "manual",
      });
      if (authorizationResponse.status !== 302) {
        throw new Error(
          `OAuth authorization fixture expected 302, received ${authorizationResponse.status}`,
        );
      }
      const callbackUrl = authorizationResponse.headers.get("location");
      if (!callbackUrl) {
        throw new Error("OAuth authorization fixture did not return a callback URL");
      }
      const callbackResponse = await fetch(callbackUrl);
      if (!callbackResponse.ok) {
        throw new Error(`OAuth callback fixture failed with ${callbackResponse.status}`);
      }
    },
    mcpUrl,
    plainHttpMcpUrl,
    revokeTokens() {
      tokens.revoked = true;
    },
    snapshot: () => ({
      ...state,
      authorizedInitializes: [...state.authorizedInitializes],
      oauthToolCalls: [...state.oauthToolCalls],
      plainHttpToolCallMarkers: [...state.plainHttpToolCallMarkers],
      unauthorizedToolCallAt: [...state.unauthorizedToolCallAt],
    }),
  };
}

function accessTokenFor(generation: number): string {
  return generation === 0 ? ACCESS_TOKEN : `${ACCESS_TOKEN}-${generation}`;
}

function refreshTokenFor(generation: number): string {
  return generation === 0 ? REFRESH_TOKEN : `${REFRESH_TOKEN}-${generation}`;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    baseUrl: string;
    mcpUrl: string;
    plainHttpMcpUrl: string;
    state: McpOAuthStatusIsolationSnapshot;
    tokens: McpOAuthTokenState;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", context.baseUrl);

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/.well-known/oauth-authorization-server")
  ) {
    sendJson(response, 200, {
      authorization_endpoint: `${context.baseUrl}/authorize`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer: context.baseUrl,
      registration_endpoint: `${context.baseUrl}/register`,
      response_types_supported: ["code"],
      scopes_supported: [SCOPE],
      token_endpoint: `${context.baseUrl}/token`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    sendJson(response, 200, {
      authorization_servers: [context.baseUrl],
      resource: context.mcpUrl,
      resource_name: "ZCode MCP OAuth status isolation E2E",
      scopes_supported: [SCOPE],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/register") {
    context.state.registrationRequestCount += 1;
    const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
    sendJson(response, 201, {
      ...body,
      client_id: CLIENT_ID,
      client_id_issued_at: 1,
      client_secret: CLIENT_SECRET,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_basic",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/authorize") {
    context.state.authorizationRequestCount += 1;
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!redirectUri) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", AUTHORIZATION_CODE);
    const state = url.searchParams.get("state");
    if (state) callbackUrl.searchParams.set("state", state);
    response.writeHead(302, { Location: callbackUrl.toString() });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/token") {
    const body = new URLSearchParams(await readRequestBody(request));
    if (!hasValidClientCredentials(request, body)) {
      sendJson(response, 401, { error: "invalid_client" });
      return;
    }
    context.state.tokenRequestCount += 1;
    const grantType = body.get("grant_type");
    if (
      grantType === GRANT_TYPE_REFRESH_TOKEN &&
      (context.tokens.revoked ||
        body.get("refresh_token") !== refreshTokenFor(context.state.tokenGeneration))
    ) {
      // 吊销后静默 refresh 必须失败，客户端只能发起交互授权。
      context.state.rejectedRefreshCount += 1;
      sendJson(response, 400, { error: INVALID_GRANT });
      return;
    }
    if (grantType === GRANT_TYPE_AUTHORIZATION_CODE && context.tokens.revoked) {
      // 吊销后的重新授权签发新一代 token；旧 token 保持失效。
      context.state.tokenGeneration += 1;
      context.tokens.revoked = false;
    }
    sendJson(response, 200, {
      access_token: accessTokenFor(context.state.tokenGeneration),
      expires_in: 3600,
      refresh_token: refreshTokenFor(context.state.tokenGeneration),
      scope: SCOPE,
      token_type: "Bearer",
    });
    return;
  }

  if (url.pathname === "/mcp") {
    await handleMcpRequest(request, response, context);
    return;
  }

  if (url.pathname === "/plain-mcp") {
    await handlePlainHttpMcpRequest(request, response, context.state);
    return;
  }

  response.writeHead(404);
  response.end();
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    baseUrl: string;
    mcpUrl: string;
    state: McpOAuthStatusIsolationSnapshot;
    tokens: McpOAuthTokenState;
  },
): Promise<void> {
  if (request.method === "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }

  // 先读 body 才能识别被 401 拒绝的 tools/call；body 不是 JSON 时仍按原逻辑回 401。
  const message = parseMcpMessage(await readRequestBody(request));
  const tokenGeneration = context.state.tokenGeneration;
  if (
    context.tokens.revoked ||
    request.headers.authorization !== `Bearer ${accessTokenFor(tokenGeneration)}`
  ) {
    context.state.unauthorizedMcpRequestCount += 1;
    if (context.tokens.revoked && message.method === "tools/call") {
      context.state.unauthorizedToolCallAt.push(Date.now());
    }
    const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", context.baseUrl);
    response.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl.href}", scope="${SCOPE}"`,
    });
    response.end();
    return;
  }

  if (message.method === "initialize") {
    context.state.authorizedInitializeCount += 1;
    context.state.authorizedInitializes.push({ at: Date.now(), tokenGeneration });
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        serverInfo: {
          name: "mcp-oauth-status-isolation-e2e",
          version: "0.1.0",
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              readOnlyHint: true,
            },
            description: "OAuth-protected Canva fixture ping",
            inputSchema: {
              properties: {},
              type: "object",
            },
            name: OAUTH_TOOL_NAME,
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call" && message.params?.name === OAUTH_TOOL_NAME) {
    const marker =
      typeof message.params.arguments?.marker === "string" ? message.params.arguments.marker : null;
    context.state.oauthToolCalls.push({ at: Date.now(), marker, tokenGeneration });
    sendJson(response, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: `${MCP_OAUTH_PONG_PREFIX}:${marker ?? ""}`, type: "text" }],
      },
    });
    return;
  }

  if (message.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }

  sendJson(response, 200, {
    error: {
      code: -32601,
      message: `Unsupported E2E MCP method: ${message.method ?? "unknown"}`,
    },
    id: message.id,
    jsonrpc: "2.0",
  });
}

interface McpJsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: {
    arguments?: { marker?: unknown };
    name?: string;
    protocolVersion?: string;
  };
}

function parseMcpMessage(raw: string): McpJsonRpcMessage {
  try {
    return JSON.parse(raw) as McpJsonRpcMessage;
  } catch {
    return {};
  }
}

function hasValidClientCredentials(request: IncomingMessage, body: URLSearchParams): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    return decoded === `${CLIENT_ID}:${CLIENT_SECRET}`;
  }
  return body.get("client_id") === CLIENT_ID && body.get("client_secret") === CLIENT_SECRET;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
