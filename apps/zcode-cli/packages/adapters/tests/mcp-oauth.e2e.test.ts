import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Logger } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";
import { createMcpAdapter } from "../src/mcp/index.js";
import { publishCanonicalCredentials } from "../src/mcp/oauth-credentials.js";
import { MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE } from "../src/mcp/oauth-errors.js";
import {
  createCredentialKeyPrefix,
  createMcpAuthorizationCodeOAuthSession,
  type McpOAuthSession,
} from "../src/mcp/oauth.js";
import { createMcpOAuthTokenProvider } from "../src/mcp/oauth-provider.js";

const OAUTH_ACCESS_TOKEN = "oauth-e2e-access-token";
const OAUTH_CLIENT_ID = "zcode-client";
const OAUTH_CLIENT_SECRET = "zcode-secret";
const DYNAMIC_CLIENT_ID = "dynamic-zcode-client";
const DYNAMIC_CLIENT_SECRET = "dynamic-zcode-secret";
const MCP_SCOPE = "mcp:tools";
/** 后台授权完成后等待连接恢复的轮询上限。 */
const RECOVERY_POLL_ATTEMPTS = 100;
const RECOVERY_POLL_INTERVAL_MS = 20;

const servers: Server[] = [];

interface StrictAuthorizationServerState {
  authorizationCodes: Map<
    string,
    {
      clientId: string;
      codeChallenge: string;
      redirectUri: string;
    }
  >;
  clients: Map<
    string,
    {
      clientSecret: string;
      redirectUris: string[];
    }
  >;
  refreshTokens: Map<string, string>;
}

describe("MCP OAuth client credentials e2e", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("authenticates a protected HTTP MCP server after a 401 challenge", async () => {
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthServerRequest(req, res, {
          authBaseUrl,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const adapter = createMcpAdapter();
    const status = await adapter.connectServer("protected", {
      type: "http",
      url: mcpUrl,
      oauth: {
        type: "client_credentials",
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        scope: MCP_SCOPE,
      },
    });

    expect(status).toMatchObject({
      status: "connected",
      toolCount: 1,
      transport: "http",
    });
    await expect(adapter.listTools()).resolves.toMatchObject([
      {
        serverName: "protected",
        toolName: "oauth_ping",
      },
    ]);
    expect(authTokenRequests).toEqual([
      expect.objectContaining({
        grant_type: "client_credentials",
        resource: mcpUrl,
        scope: MCP_SCOPE,
      }),
    ]);
    expect(mcpAuthorizations).toContain(`Bearer ${OAUTH_ACCESS_TOKEN}`);

    await adapter.close();
  });

  it("completes interactive authorization_code OAuth and reconnects the MCP server", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: {
        ZCODE_CREDENTIAL_SECRET: "mcp-oauth-e2e-secret",
      },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const adapter = createMcpAdapter({
      mcpOAuth: {
        authorizationTimeoutMs: 5_000,
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          const authorizationResponse = await fetch(authorizationUrl, {
            redirect: "manual",
          });
          expect(authorizationResponse.status).toBe(302);
          const location = authorizationResponse.headers.get("location");
          if (!location) {
            throw new Error("Authorization server did not redirect to callback URL");
          }
          const callbackResponse = await fetch(location);
          expect(callbackResponse.status).toBe(200);
        },
      },
    });

    try {
      const status = await adapter.connectServer("figma", {
        type: "http",
        url: mcpUrl,
        oauth: {
          type: "authorization_code",
          clientName: "ZCode Test",
          scope: MCP_SCOPE,
        },
      });

      expect(status).toMatchObject({
        status: "connected",
        toolCount: 1,
        transport: "http",
      });
      await expect(adapter.listTools()).resolves.toMatchObject([
        {
          serverName: "figma",
          toolName: "oauth_ping",
        },
      ]);
      expect(registrationRequests).toHaveLength(1);
      expect(registrationRequests[0]).toMatchObject({
        client_name: "ZCode Test",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: MCP_SCOPE,
      });
      expect(registrationRequests[0]?.redirect_uris).toEqual([
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/mcp\/figma$/),
      ]);
      expect(authorizationRequests).toEqual([
        expect.objectContaining({
          client_id: DYNAMIC_CLIENT_ID,
          code_challenge_method: "S256",
          redirect_uri: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/mcp\/figma$/,
          ),
          resource: mcpUrl,
          response_type: "code",
          scope: MCP_SCOPE,
        }),
      ]);
      expect(authorizationRequests[0]?.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(authorizationRequests[0]?.state).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(authTokenRequests).toEqual([
        expect.objectContaining({
          code: "interactive-code-1",
          grant_type: "authorization_code",
          redirect_uri: expect.stringMatching(
            /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/mcp\/figma$/,
          ),
          resource: mcpUrl,
        }),
      ]);
      expect(authTokenRequests[0]?.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(pkceChallenges.size).toBe(0);
      expect(mcpAuthorizations).toContain(`Bearer ${OAUTH_ACCESS_TOKEN}`);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("runs a single interactive authorization transaction for concurrent adapters sharing one credential file", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();
    const strictAuthorizationState = createStrictAuthorizationServerState();

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          strictAuthorizationState,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-race-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-race-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const authorizationUrls: string[] = [];
    const driveAuthorization = async ({ authorizationUrl }: { authorizationUrl: string }) => {
      authorizationUrls.push(authorizationUrl);
      await followAuthorizationRedirect(authorizationUrl);
    };
    const adapterA = createMcpAdapter({
      mcpOAuth: {
        authorizationTimeoutMs: 5_000,
        credentialStore,
        openAuthorizationUrl: driveAuthorization,
      },
    });
    const adapterB = createMcpAdapter({
      mcpOAuth: {
        authorizationTimeoutMs: 5_000,
        credentialStore,
        openAuthorizationUrl: driveAuthorization,
      },
    });
    const config = {
      type: "http" as const,
      url: mcpUrl,
      oauth: {
        type: "authorization_code" as const,
        clientName: "ZCode Concurrent Test",
        scope: MCP_SCOPE,
      },
    };

    try {
      const [statusA, statusB] = await Promise.all([
        adapterA.connectServer("exa", config),
        adapterB.connectServer("exa", config),
      ]);

      // 修复原因（根因 2）：过去两个并发 adapter 各跑一套授权事务，产生两个 DCR client、两个
      // state、两个授权 URL；用户会点到已超时或非目标事务的链接，且每个 client 的 redirect_uris
      // 都锁死在各自的随机端口。现在授权由跨进程 lease 单飞，follower 观察 canonical 换代后
      // 复用同一份凭据。
      expect(statusA).toMatchObject({ status: "connected", toolCount: 1 });
      expect(statusB).toMatchObject({ status: "connected", toolCount: 1 });
      expect(authorizationUrls).toHaveLength(1);
      expect(authorizationRequests).toHaveLength(1);
      expect(registrationRequests).toHaveLength(1);
      expect(authTokenRequests).toHaveLength(1);
      expect(authTokenRequests[0]).toMatchObject({
        client_id: `${DYNAMIC_CLIENT_ID}-1`,
        code: "interactive-code-1",
        grant_type: "authorization_code",
      });
      // fresh DCR 的 redirect_uri 必须与本次授权请求实际使用的回调地址一致。
      expect(registrationRequests[0]?.redirect_uris).toEqual([
        authorizationRequests[0]?.redirect_uri,
      ]);
      expect(pkceChallenges.size).toBe(0);
    } finally {
      await Promise.all([adapterA.close(), adapterB.close()]);
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("re-registers a fresh client instead of reusing a stored client bound to a dead callback port", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();
    const strictAuthorizationState = createStrictAuthorizationServerState();
    const STALE_CLIENT_ID = "stale-exa-client";
    const STALE_REDIRECT_URI = "http://127.0.0.1:54735/oauth/callback/mcp/exa";

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          // 精确匹配 redirect_uri（含端口），模拟对 loopback 不做 RFC 8252 端口豁免的授权服务器。
          exactRedirectUriMatch: true,
          pkceChallenges,
          registrationRequests,
          strictAuthorizationState,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-stale-client-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-stale-client-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const oauthConfig = {
      type: "authorization_code" as const,
      clientName: "ZCode exa",
      scope: MCP_SCOPE,
    };
    const keyPrefix = createCredentialKeyPrefix("exa", mcpUrl, oauthConfig);

    // 现场复现：client 注册于历史端口 54735，之后每次授权都换新的随机端口。
    strictAuthorizationState.clients.set(STALE_CLIENT_ID, {
      clientSecret: "stale-exa-secret",
      redirectUris: [STALE_REDIRECT_URI],
    });
    await credentialStore.save(
      `${keyPrefix}:client_information`,
      JSON.stringify({
        client_id: STALE_CLIENT_ID,
        client_secret: "stale-exa-secret",
        token_endpoint_auth_method: "client_secret_basic",
      }),
    );

    const adapter = createMcpAdapter({
      mcpOAuth: {
        authorizationTimeoutMs: 5_000,
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          await followAuthorizationRedirect(authorizationUrl);
        },
      },
    });

    try {
      const status = await adapter.connectServer("exa", {
        type: "http",
        url: mcpUrl,
        oauth: oauthConfig,
      });

      // 修复原因（根因 2）：过去这条路径会发出「旧 client_id + 新 redirect_uri」的授权请求。
      // 授权服务器按 RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页（用户看到的 Exa
      // "Server Components render error"），回调永不到达，且重试永不自愈。
      expect(status).toMatchObject({ status: "connected", toolCount: 1 });
      expect(registrationRequests).toHaveLength(1);
      expect(authorizationRequests).toHaveLength(1);
      expect(authorizationRequests[0]?.client_id).toBe(`${DYNAMIC_CLIENT_ID}-1`);
      expect(authorizationRequests[0]?.client_id).not.toBe(STALE_CLIENT_ID);
      expect(authorizationRequests[0]?.redirect_uri).not.toBe(STALE_REDIRECT_URI);
      // fresh DCR 注册的 redirect_uri 必须正是本次授权实际使用的存活 listener 地址。
      expect(registrationRequests[0]?.redirect_uris).toEqual([
        authorizationRequests[0]?.redirect_uri,
      ]);
      expect(authTokenRequests).toHaveLength(1);
      expect(authTokenRequests[0]?.client_id).toBe(`${DYNAMIC_CLIENT_ID}-1`);
      // 发布后的 canonical pair 必须是本次授权的 client，而不是历史 client。
      const canonicalRaw = await credentialStore.load(`${keyPrefix}:authorization_credentials`);
      expect(canonicalRaw).toBeTruthy();
      const canonical = JSON.parse(canonicalRaw ?? "{}") as {
        client_information?: { client_id?: string };
        generation?: string;
      };
      expect(canonical.client_information?.client_id).toBe(`${DYNAMIC_CLIENT_ID}-1`);
      expect(canonical.generation).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("performs zero discovery, zero DCR and opens zero listeners for a passive connect with valid credentials", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();
    let authServerRequests = 0;

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        authServerRequests += 1;
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-passive-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-passive-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("passive", mcpUrl, oauthConfig);
    // 现成可用的凭据：还没临期，因此连接期不需要任何 OAuth 动作。
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "passive-client" },
      publishedBy: "passive-seed",
      tokens: {
        access_token: OAUTH_ACCESS_TOKEN,
        expires_in: 3600,
        refresh_token: "passive-refresh-token",
        token_type: "Bearer",
      },
    });

    const adapter = createMcpAdapter({ mcpOAuth: { credentialStore } });
    const listenersBefore = countTcpServers();

    try {
      const status = await adapter.connectServer("passive", {
        type: "http",
        url: mcpUrl,
        oauth: oauthConfig,
      });

      expect(status).toMatchObject({ status: "connected", toolCount: 1 });
      expect(mcpAuthorizations).toContain(`Bearer ${OAUTH_ACCESS_TOKEN}`);
      // 修复原因：过去任何没有 Authorization header 的 HTTP/SSE MCP 在建连前就会创建完整 OAuth
      // session,而 session 返回前就 listen(0) 起了一个 callback server——即使凭据完全有效。
      // 纯 AuthProvider 让被动连接彻底不碰 discovery / DCR / listener。
      expect(authServerRequests).toBe(0);
      expect(registrationRequests).toHaveLength(0);
      expect(authorizationRequests).toHaveLength(0);
      expect(countTcpServers()).toBe(listenersBefore);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("recovers a tool call whose refresh token was revoked by running Phase 2 and reconnecting", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    // 前 N 次工具调用返回 401,模拟运行期 access token 失效。
    let rejectToolCalls = true;
    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        if (rejectToolCalls && req.method === "POST") {
          const body = await readRequestBody(req);
          if (body.includes('"tools/call"')) {
            res.writeHead(401, {
              "WWW-Authenticate": [
                `Bearer resource_metadata="${new URL(resourceMetadataPath, mcpUrl).href}", scope="${MCP_SCOPE}"`,
              ],
            });
            res.end();
            return;
          }
          await handleProtectedMcpRequest(req, res, {
            authBaseUrl,
            authorizations: mcpAuthorizations,
            body,
            mcpUrl,
            resourceMetadataPath,
          });
          return;
        }
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-runtime-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-runtime-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("runtime", mcpUrl, oauthConfig);
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "revoked-client" },
      publishedBy: "runtime-seed",
      tokens: {
        access_token: OAUTH_ACCESS_TOKEN,
        expires_in: 3600,
        // 该 refresh token 在 fake AS 上不存在 → 刷新时收到 invalid_grant。
        refresh_token: "revoked-refresh-token",
        token_type: "Bearer",
      },
    });

    const adapter = createMcpAdapter({
      mcpOAuth: {
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          rejectToolCalls = false;
          await followAuthorizationRedirect(authorizationUrl);
        },
      },
    });

    try {
      const status = await adapter.connectServer("runtime", {
        type: "http",
        url: mcpUrl,
        oauth: oauthConfig,
      });
      expect(status).toMatchObject({ status: "connected", toolCount: 1 });

      // Bugfix 回归：建连后 token 被撤销时,过去 callTool 的 401/403 原样冒泡,用户看到裸错误且
      // 永不自愈——OAuth 自愈只存在于 startup connect 路径。现在运行期共用 Phase 2 → Phase 1 编排。
      // 授权链接一发布,触发授权的这次调用就结束（由 core 改写为 needs-auth）;授权在后台完成后连接恢复。
      await expect(
        adapter.callTool({ serverName: "runtime", toolName: "oauth_ping" }),
      ).rejects.toThrow();
      for (
        let attempt = 0;
        attempt < RECOVERY_POLL_ATTEMPTS &&
        adapter.getToolSnapshot().runtime?.status.status !== "connected";
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_INTERVAL_MS));
      await expect(
        adapter.callTool({ serverName: "runtime", toolName: "oauth_ping" }),
      ).resolves.toMatchObject({ isError: false });
      expect(registrationRequests).toHaveLength(1);
      expect(authorizationRequests).toHaveLength(1);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("steps up authorization scope with the union of configured, granted, and challenged scopes", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();
    const STEP_UP_SCOPE = "admin:tools";

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    let stepUpRequired = true;
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
          ...(stepUpRequired ? { stepUpScope: STEP_UP_SCOPE } : {}),
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-stepup-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-stepup-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const oauthConfig = { type: "authorization_code" as const, scope: MCP_SCOPE };
    const keyPrefix = createCredentialKeyPrefix("stepup", mcpUrl, oauthConfig);
    // 现存凭据：token 有效、已授予 mcp:tools,但服务端现在要求 admin:tools。
    await publishCanonicalCredentials(credentialStore, keyPrefix, {
      clientInformation: { client_id: "stepup-client" },
      publishedBy: "stepup-seed",
      tokens: {
        access_token: OAUTH_ACCESS_TOKEN,
        expires_in: 3600,
        scope: MCP_SCOPE,
        token_type: "Bearer",
      },
    });

    const adapter = createMcpAdapter({
      mcpOAuth: {
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          stepUpRequired = false;
          await followAuthorizationRedirect(authorizationUrl);
        },
      },
    });

    try {
      const status = await adapter.connectServer("stepup", {
        type: "http",
        url: mcpUrl,
        oauth: oauthConfig,
      });

      expect(status).toMatchObject({ status: "connected", toolCount: 1 });
      // 修复原因（spec §5.2,复核 P1）：只带 challenge scope 重新授权时,授权服务器可能按新请求
      // 收回先前授予的 scope,下一个请求换个 challenge 又 403,形成重授权乒乓。重新授权请求
      // 必须携带 config ∪ token.scope ∪ challenge 的并集,且 DCR 注册同一个值。
      expect(authorizationRequests).toHaveLength(1);
      expect(authorizationRequests[0]?.scope).toBe(`${MCP_SCOPE} ${STEP_UP_SCOPE}`);
      expect(registrationRequests).toHaveLength(1);
      expect(registrationRequests[0]?.scope).toBe(`${MCP_SCOPE} ${STEP_UP_SCOPE}`);
      // challenge 携带的 resource_metadata 要传导为授权请求的 resource 受众参数。
      expect(authorizationRequests[0]?.resource).toBe(mcpUrl);
      expect(authTokenRequests).toHaveLength(1);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("binds dynamically registered client information to each OAuth transaction", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-client-transaction-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-client-transaction-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];

    try {
      const sessionA = await createTestOAuthSession(credentialStore, "transaction-a");
      const sessionB = await createTestOAuthSession(credentialStore, "transaction-b");
      sessions.push(sessionA, sessionB);
      const clientA = dynamicClientInformation("transaction-client-a");
      const clientB = dynamicClientInformation("transaction-client-b");

      await saveDynamicClientInformation(sessionA, clientA);
      await saveDynamicClientInformation(sessionB, clientB);

      await expect(sessionA.provider.clientInformation()).resolves.toEqual(clientA);
      await expect(sessionB.provider.clientInformation()).resolves.toEqual(clientB);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("restores dynamically registered client information after provider reconstruction", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-client-recovery-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-client-recovery-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];

    try {
      const registered = await createTestOAuthSession(credentialStore, "recovery-registered");
      sessions.push(registered);
      const client = dynamicClientInformation("recovery-client");
      await saveDynamicClientInformation(registered, client);
      await registered.close();
      sessions.splice(sessions.indexOf(registered), 1);

      const reconstructed = await createTestOAuthSession(credentialStore, "recovery-reconstructed");
      sessions.push(reconstructed);
      await expect(reconstructed.provider.clientInformation()).resolves.toEqual(client);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("retries credential snapshots after a transient load failure", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-load-retry-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-load-retry-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];

    try {
      const publisher = await createTestOAuthSession(credentialStore, "load-retry-publisher");
      sessions.push(publisher);
      const client = dynamicClientInformation("load-retry-client");
      const tokens = oauthTokens("load-retry-client");
      await saveDynamicClientInformation(publisher, client);
      await publisher.provider.saveTokens(tokens);

      let loadAttempts = 0;
      const transientFailure = new Error("injected transient credential load failure");
      const retryingStore: SharedZCodeCredentialStore = {
        ...credentialStore,
        async loadMany(keys: string[]): Promise<Record<string, string | null>> {
          loadAttempts += 1;
          if (loadAttempts === 1) throw transientFailure;
          return await credentialStore.loadMany(keys);
        },
      };
      const reader = await createTestOAuthSession(retryingStore, "load-retry-reader");
      sessions.push(reader);

      await expect(reader.provider.tokens()).rejects.toThrow(transientFailure.message);
      await expect(reader.provider.tokens()).resolves.toEqual(tokens);
      await expect(reader.provider.clientInformation()).resolves.toEqual(client);
      expect(loadAttempts).toBe(2);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("does not fail session close when verifier cleanup fails", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-close-cleanup-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-close-cleanup-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const cleanupError = new Error("injected verifier cleanup failure");
    const failingStore: SharedZCodeCredentialStore = {
      ...credentialStore,
      async delete(key: string): Promise<void> {
        if (key.includes(":code_verifier:")) throw cleanupError;
        await credentialStore.delete(key);
      },
    };
    const { logger, warn } = createTestLogger();
    const session = await createMcpAuthorizationCodeOAuthSession({
      adapterInstanceId: "close-cleanup",
      config: testAuthorizationCodeConfig(),
      logger,
      options: { credentialStore: failingStore },
      serverName: "credential-pair-test",
      serverUrl: "https://mcp.example.test/mcp",
    });

    try {
      await session.provider.saveCodeVerifier("close-cleanup-verifier");

      await expect(session.close()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "MCP OAuth verifier cleanup failed",
        expect.objectContaining({
          error: cleanupError.message,
          event: "mcp.oauth.verifier.cleanup_failed",
          mcpServerName: "credential-pair-test",
        }),
      );
    } finally {
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("publishes client information and tokens as one credential snapshot", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-client-token-pair-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-client-token-pair-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];

    try {
      const sessionA = await createTestOAuthSession(credentialStore, "pair-a");
      const sessionB = await createTestOAuthSession(credentialStore, "pair-b");
      sessions.push(sessionA, sessionB);
      const clientA = dynamicClientInformation("pair-client-a");
      const clientB = dynamicClientInformation("pair-client-b");
      const tokensA = oauthTokens("pair-client-a");
      const tokensB = oauthTokens("pair-client-b");

      await saveDynamicClientInformation(sessionA, clientA);
      await saveDynamicClientInformation(sessionB, clientB);
      await sessionB.provider.saveTokens(tokensB);
      await sessionA.provider.saveTokens(tokensA);

      const reader = await createTestOAuthSession(credentialStore, "pair-reader");
      sessions.push(reader);
      await expect(reader.provider.clientInformation()).resolves.toEqual(clientA);
      await expect(reader.provider.tokens()).resolves.toEqual(tokensA);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("preserves v1 canonical credentials across legacy migration states", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-v1-migration-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-v1-migration-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const config = testAuthorizationCodeConfig();
    const serverUrl = "https://mcp.example.test/mcp";
    const keyPrefix = createCredentialKeyPrefix("credential-pair-test", serverUrl, config);
    const canonicalKey = `${keyPrefix}:authorization_credentials`;
    const legacyClientKey = `${keyPrefix}:client_information`;
    const legacyTokensKey = `${keyPrefix}:tokens`;
    const canonicalClient = dynamicClientInformation("v1-canonical-client");
    const canonicalTokens = oauthTokens("v1-canonical-client");
    const canonicalRaw = JSON.stringify({
      client_information: canonicalClient,
      expires_at: Date.now() + 3_600_000,
      published_by: "v1-publisher",
      tokens: canonicalTokens,
      version: 1,
    });

    try {
      // v1 发布时会删除 legacy 镜像；无镜像是正常稳态，不能因此丢弃 canonical token。
      await credentialStore.save(canonicalKey, canonicalRaw);
      const canonicalReader = await createTestOAuthSession(credentialStore, "v1-canonical-reader");
      sessions.push(canonicalReader);
      await expect(canonicalReader.provider.clientInformation()).resolves.toEqual(canonicalClient);
      await expect(canonicalReader.provider.tokens()).resolves.toEqual(canonicalTokens);

      const phaseOneProvider = createMcpOAuthTokenProvider({
        config,
        credentialStore,
        keyPrefix,
        serverName: "credential-pair-test",
        serverUrl,
      });
      await expect(phaseOneProvider.token()).resolves.toBe(canonicalTokens.access_token);

      // 旧 provider 可能只写回 refresh 后的 tokens；缺少 legacy client 时复用 canonical 身份。
      const tokenOnlyRefresh = {
        ...canonicalTokens,
        access_token: "v1-token-only-refreshed-access-token",
      };
      await credentialStore.save(legacyTokensKey, JSON.stringify(tokenOnlyRefresh));
      const tokenOnlyReader = await createTestOAuthSession(credentialStore, "v1-token-only-reader");
      sessions.push(tokenOnlyReader);
      await expect(tokenOnlyReader.provider.clientInformation()).resolves.toEqual(canonicalClient);
      await expect(tokenOnlyReader.provider.tokens()).resolves.toEqual(tokenOnlyRefresh);

      // legacy client 与 canonical 身份一致时，可以确认 tokens 属于同一 client 的更新。
      const matchingRefresh = {
        ...canonicalTokens,
        access_token: "v1-matching-refreshed-access-token",
      };
      await credentialStore.saveMany({
        [legacyClientKey]: JSON.stringify(canonicalClient),
        [legacyTokensKey]: JSON.stringify(matchingRefresh),
      });
      const matchingReader = await createTestOAuthSession(credentialStore, "v1-matching-reader");
      sessions.push(matchingReader);
      await expect(matchingReader.provider.clientInformation()).resolves.toEqual(canonicalClient);
      await expect(matchingReader.provider.tokens()).resolves.toEqual(matchingRefresh);

      // legacy client 身份不一致时无法确认 token 归属，必须保留完整 canonical pair。
      const mismatchedClient = dynamicClientInformation("v1-mismatched-client");
      const mismatchedTokens = oauthTokens("v1-mismatched-client");
      await credentialStore.saveMany({
        [legacyClientKey]: JSON.stringify(mismatchedClient),
        [legacyTokensKey]: JSON.stringify(mismatchedTokens),
      });
      const mismatchedReader = await createTestOAuthSession(
        credentialStore,
        "v1-mismatched-reader",
      );
      sessions.push(mismatchedReader);
      await expect(mismatchedReader.provider.clientInformation()).resolves.toEqual(canonicalClient);
      await expect(mismatchedReader.provider.tokens()).resolves.toEqual(canonicalTokens);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("keeps legacy readers and writers coherent during the canonical migration window", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-mixed-version-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-mixed-version-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const config = testAuthorizationCodeConfig();
    const keyPrefix = createCredentialKeyPrefix(
      "credential-pair-test",
      "https://mcp.example.test/mcp",
      config,
    );
    const legacyClientKey = `${keyPrefix}:client_information`;
    const legacyTokensKey = `${keyPrefix}:tokens`;
    const client = dynamicClientInformation("mixed-version-client");
    const initialTokens = oauthTokens("mixed-version-client");
    const reauthorizedClient = dynamicClientInformation("mixed-version-reauthorized-client");
    const reauthorizedTokens = oauthTokens("mixed-version-reauthorized-client");
    const refreshedByLegacy = {
      ...reauthorizedTokens,
      access_token: "mixed-version-reauthorized-client-legacy-refreshed-access-token",
    };

    try {
      const publisher = await createTestOAuthSession(credentialStore, "mixed-version-publisher");
      sessions.push(publisher);
      await saveDynamicClientInformation(publisher, client);
      await publisher.provider.saveTokens(initialTokens);

      // 目标分支旧 provider 只认识这两个 legacy key，发布后必须仍能读取同一 pair。
      await expect(credentialStore.load(legacyClientKey)).resolves.toBe(JSON.stringify(client));
      await expect(credentialStore.load(legacyTokensKey)).resolves.toBe(
        JSON.stringify(initialTokens),
      );

      // 旧 provider 的 DCR 与 token exchange 不是同一次写入；只更新 client 时仍须读取旧 canonical pair。
      await credentialStore.save(legacyClientKey, JSON.stringify(reauthorizedClient));
      const pendingReader = await createTestOAuthSession(
        credentialStore,
        "mixed-version-pending-reader",
      );
      sessions.push(pendingReader);
      await expect(pendingReader.provider.clientInformation()).resolves.toEqual(client);
      await expect(pendingReader.provider.tokens()).resolves.toEqual(initialTokens);

      // legacy 没有 generation；client/token 都变化时无法区分已完成重授权与跨事务交错。
      // 新 provider 保留 client 但丢弃不可信 token，完成自己的 token exchange 后再发布 pair。
      await credentialStore.save(legacyTokensKey, JSON.stringify(reauthorizedTokens));
      const reauthorizedReader = await createTestOAuthSession(
        credentialStore,
        "mixed-version-reauthorized-reader",
      );
      sessions.push(reauthorizedReader);
      await expect(reauthorizedReader.provider.clientInformation()).resolves.toEqual(
        reauthorizedClient,
      );
      await expect(reauthorizedReader.provider.tokens()).resolves.toBeUndefined();
      await reauthorizedReader.provider.saveTokens(reauthorizedTokens);

      // 模拟旧 provider refresh：它只更新 legacy tokens，新 provider 不得继续读取 stale canonical。
      await credentialStore.save(legacyTokensKey, JSON.stringify(refreshedByLegacy));
      const refreshedReader = await createTestOAuthSession(
        credentialStore,
        "mixed-version-refreshed-reader",
      );
      sessions.push(refreshedReader);
      await expect(refreshedReader.provider.clientInformation()).resolves.toEqual(
        reauthorizedClient,
      );
      await expect(refreshedReader.provider.tokens()).resolves.toEqual(refreshedByLegacy);

      // 模拟旧 provider invalidate tokens：canonical 不能把已失效 token 复活。
      await credentialStore.delete(legacyTokensKey);
      const invalidatedReader = await createTestOAuthSession(
        credentialStore,
        "mixed-version-invalidated-reader",
      );
      sessions.push(invalidatedReader);
      await expect(invalidatedReader.provider.clientInformation()).resolves.toEqual(
        reauthorizedClient,
      );
      await expect(invalidatedReader.provider.tokens()).resolves.toBeUndefined();
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("does not combine a pending legacy client with another legacy refresh", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-legacy-race-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-legacy-race-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const config = testAuthorizationCodeConfig();
    const keyPrefix = createCredentialKeyPrefix(
      "credential-pair-test",
      "https://mcp.example.test/mcp",
      config,
    );
    const clientA = dynamicClientInformation("legacy-race-client-a");
    const tokensA = oauthTokens("legacy-race-client-a");
    const pendingClientB = dynamicClientInformation("legacy-race-client-b");
    const refreshedTokensA = {
      ...tokensA,
      access_token: "legacy-race-client-a-refreshed-access-token",
    };

    try {
      const publisher = await createTestOAuthSession(credentialStore, "legacy-race-publisher");
      sessions.push(publisher);
      await saveDynamicClientInformation(publisher, clientA);
      await publisher.provider.saveTokens(tokensA);

      // 旧 provider B 只完成动态注册；旧 provider A 随后只刷新 token。两次独立写入
      // 没有 generation 可证明归属，新 reader 不能把 client B 与 token A2 拼成一对。
      await credentialStore.save(`${keyPrefix}:client_information`, JSON.stringify(pendingClientB));
      await credentialStore.save(`${keyPrefix}:tokens`, JSON.stringify(refreshedTokensA));

      const reader = await createTestOAuthSession(credentialStore, "legacy-race-reader");
      sessions.push(reader);
      await expect(reader.provider.clientInformation()).resolves.toEqual(pendingClientB);
      await expect(reader.provider.tokens()).resolves.toBeUndefined();
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("does not invalidate a credential snapshot replaced by another transaction", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-compare-delete-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-compare-delete-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];

    try {
      const publisherA = await createTestOAuthSession(credentialStore, "publisher-a");
      const staleReader = await createTestOAuthSession(credentialStore, "stale-reader");
      const publisherB = await createTestOAuthSession(credentialStore, "publisher-b");
      sessions.push(publisherA, staleReader, publisherB);
      const clientA = dynamicClientInformation("published-client-a");
      const tokensA = oauthTokens("published-client-a");
      const clientB = dynamicClientInformation("published-client-b");
      const tokensB = oauthTokens("published-client-b");

      await saveDynamicClientInformation(publisherA, clientA);
      await publisherA.provider.saveTokens(tokensA);
      await expect(staleReader.provider.clientInformation()).resolves.toEqual(clientA);
      await expect(staleReader.provider.tokens()).resolves.toEqual(tokensA);

      await saveDynamicClientInformation(publisherB, clientB);
      await publisherB.provider.saveTokens(tokensB);
      await staleReader.provider.invalidateCredentials?.("tokens");

      // 同一个失败 provider 的 SDK 重试也必须丢弃旧 client 缓存并读取获胜事务的 pair。
      await expect(staleReader.provider.clientInformation()).resolves.toEqual(clientB);
      await expect(staleReader.provider.tokens()).resolves.toEqual(tokensB);

      const verifier = await createTestOAuthSession(credentialStore, "compare-delete-verifier");
      sessions.push(verifier);
      await expect(verifier.provider.clientInformation()).resolves.toEqual(clientB);
      await expect(verifier.provider.tokens()).resolves.toEqual(tokensB);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("refreshes the last concurrently published canonical pair with one client identity", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const tokenRequests: Array<Record<string, string>> = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();
    const strictAuthorizationState = createStrictAuthorizationServerState();
    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          strictAuthorizationState,
          tokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-refresh-pair-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-refresh-pair-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const clientA = dynamicClientInformation("refresh-pair-client-a");
    const tokensA = oauthTokens("refresh-pair-client-a");
    const clientB = dynamicClientInformation("refresh-pair-client-b");
    const tokensB = oauthTokens("refresh-pair-client-b");
    for (const [client, tokens] of [
      [clientA, tokensA],
      [clientB, tokensB],
    ] as const) {
      strictAuthorizationState.clients.set(client.client_id, {
        clientSecret: client.client_secret ?? "",
        redirectUris: [],
      });
      strictAuthorizationState.refreshTokens.set(tokens.refresh_token ?? "", client.client_id);
    }

    try {
      const publisherA = await createTestOAuthSession(
        credentialStore,
        "refresh-publisher-a",
        `${authBaseUrl}/mcp`,
      );
      const publisherB = await createTestOAuthSession(
        credentialStore,
        "refresh-publisher-b",
        `${authBaseUrl}/mcp`,
      );
      sessions.push(publisherA, publisherB);
      await saveDynamicClientInformation(publisherA, clientA);
      await saveDynamicClientInformation(publisherB, clientB);
      await publisherB.provider.saveTokens(tokensB);
      await publisherA.provider.saveTokens(tokensA);

      const reader = await createTestOAuthSession(
        credentialStore,
        "refresh-reader",
        `${authBaseUrl}/mcp`,
      );
      sessions.push(reader);
      await expect(auth(reader.provider, { serverUrl: `${authBaseUrl}/mcp` })).resolves.toBe(
        "AUTHORIZED",
      );

      expect(authorizationRequests).toHaveLength(0);
      expect(registrationRequests).toHaveLength(0);
      expect(tokenRequests).toEqual([
        expect.objectContaining({
          client_id: clientA.client_id,
          grant_type: "refresh_token",
          refresh_token: tokensA.refresh_token,
        }),
      ]);
      await expect(reader.provider.clientInformation()).resolves.toEqual(clientA);
      await expect(reader.provider.tokens()).resolves.toMatchObject({
        access_token: `${clientA.client_id}-refreshed-access-token`,
        refresh_token: tokensA.refresh_token,
      });
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("preserves a canonical credential snapshot written by a newer version", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-future-credentials-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-future-credentials-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const keyPrefix = createCredentialKeyPrefix(
      "credential-pair-test",
      "https://mcp.example.test/mcp",
      testAuthorizationCodeConfig(),
    );
    const futureSnapshot = JSON.stringify({
      client_information: dynamicClientInformation("future-client"),
      published_by: "future-publisher",
      tokens: oauthTokens("future-client"),
      version: 3,
    });

    try {
      await credentialStore.save(`${keyPrefix}:authorization_credentials`, futureSnapshot);
      const session = await createTestOAuthSession(credentialStore, "future-reader");
      sessions.push(session);

      // 未知版本必须保留原值：CLI 与 desktop 独立升级、共享同一份凭据文件，旧版本不能把新版本
      // 写入的 canonical pair 当损坏数据删除。没有可用 client 时改为要求交互授权（PR2 过渡 seam），
      // 而不是返回 undefined 让 SDK 自行做一次动态注册。
      await expect(session.provider.clientInformation()).rejects.toMatchObject({
        code: MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE,
        reason: "no_credentials",
      });
      await expect(session.provider.tokens()).resolves.toBeUndefined();
      await expect(credentialStore.load(`${keyPrefix}:authorization_credentials`)).resolves.toBe(
        futureSnapshot,
      );
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("removes both legacy credential halves when the legacy client is invalid", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-legacy-invalidation-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-legacy-invalidation-secret" },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const sessions: McpOAuthSession[] = [];
    const config = testAuthorizationCodeConfig();
    const keyPrefix = createCredentialKeyPrefix(
      "credential-pair-test",
      "https://mcp.example.test/mcp",
      config,
    );

    try {
      await credentialStore.save(
        `${keyPrefix}:client_information`,
        JSON.stringify(dynamicClientInformation("legacy-client")),
      );
      await credentialStore.save(
        `${keyPrefix}:tokens`,
        JSON.stringify(oauthTokens("legacy-client")),
      );
      const session = await createTestOAuthSession(credentialStore, "legacy-invalidation");
      sessions.push(session);

      await expect(session.provider.clientInformation()).resolves.toBeDefined();
      await expect(session.provider.tokens()).resolves.toBeDefined();
      await session.provider.invalidateCredentials?.("client");

      await expect(credentialStore.load(`${keyPrefix}:client_information`)).resolves.toBeNull();
      await expect(credentialStore.load(`${keyPrefix}:tokens`)).resolves.toBeNull();
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("discovers authorization_code OAuth for a bare HTTP MCP config", async () => {
    const authorizationRequests: Array<Record<string, string>> = [];
    const authTokenRequests: Array<Record<string, string>> = [];
    const mcpAuthorizations: string[] = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const pkceChallenges = new Map<string, string>();

    let authBaseUrl = "";
    const authServer = await listen(
      createServer(async (req, res) => {
        await handleAuthorizationCodeAuthServerRequest(req, res, {
          authBaseUrl,
          authorizationRequests,
          pkceChallenges,
          registrationRequests,
          tokenRequests: authTokenRequests,
        });
      }),
    );
    authBaseUrl = serverBaseUrl(authServer);

    let mcpUrl = "";
    const resourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
    const mcpServer = await listen(
      createServer(async (req, res) => {
        await handleProtectedMcpRequest(req, res, {
          authBaseUrl,
          authorizations: mcpAuthorizations,
          mcpUrl,
          resourceMetadataPath,
        });
      }),
    );
    mcpUrl = `${serverBaseUrl(mcpServer)}/mcp`;

    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-auto-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: {
        ZCODE_CREDENTIAL_SECRET: "mcp-oauth-e2e-secret",
      },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const adapter = createMcpAdapter({
      mcpOAuth: {
        authorizationTimeoutMs: 5_000,
        credentialStore,
        openAuthorizationUrl: async ({ authorizationUrl }) => {
          const authorizationResponse = await fetch(authorizationUrl, {
            redirect: "manual",
          });
          expect(authorizationResponse.status).toBe(302);
          const location = authorizationResponse.headers.get("location");
          if (!location) {
            throw new Error("Authorization server did not redirect to callback URL");
          }
          const callbackResponse = await fetch(location);
          expect(callbackResponse.status).toBe(200);
        },
      },
    });

    try {
      const status = await adapter.connectServer("notion", {
        type: "http",
        url: mcpUrl,
      });

      expect(status).toMatchObject({
        status: "connected",
        toolCount: 1,
        transport: "http",
      });
      await expect(adapter.listTools()).resolves.toMatchObject([
        {
          serverName: "notion",
          toolName: "oauth_ping",
        },
      ]);
      expect(registrationRequests).toHaveLength(1);
      expect(registrationRequests[0]).toMatchObject({
        client_name: "ZCode notion",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: MCP_SCOPE,
      });
      expect(authorizationRequests).toEqual([
        expect.objectContaining({
          client_id: DYNAMIC_CLIENT_ID,
          resource: mcpUrl,
          response_type: "code",
          scope: MCP_SCOPE,
        }),
      ]);
      expect(authTokenRequests).toEqual([
        expect.objectContaining({
          code: "interactive-code-1",
          grant_type: "authorization_code",
          resource: mcpUrl,
        }),
      ]);
      expect(mcpAuthorizations).toContain(`Bearer ${OAUTH_ACCESS_TOKEN}`);
    } finally {
      await adapter.close();
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });

  it("isolates persisted authorization_code credentials by authorization config", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-"));
    const credentialStore = createSharedZCodeCredentialStore({
      env: {
        ZCODE_CREDENTIAL_SECRET: "mcp-oauth-e2e-secret",
      },
      filePath: join(credentialsDir, "credentials.json"),
    });
    const serverName = "figma";
    const serverUrl = "https://mcp.example.test/mcp";
    const keyPrefixA = createCredentialKeyPrefix(serverName, serverUrl, {
      type: "authorization_code",
      clientName: "ZCode Test",
      scope: MCP_SCOPE,
    });
    const keyPrefixB = createCredentialKeyPrefix(serverName, serverUrl, {
      type: "authorization_code",
      clientName: "ZCode Test",
      scope: "mcp:tools:readonly",
    });

    try {
      await credentialStore.save(
        `${keyPrefixA}:client_information`,
        JSON.stringify({
          client_id: DYNAMIC_CLIENT_ID,
          client_secret: DYNAMIC_CLIENT_SECRET,
        }),
      );
      await credentialStore.save(
        `${keyPrefixA}:tokens`,
        JSON.stringify({
          access_token: OAUTH_ACCESS_TOKEN,
          refresh_token: "oauth-e2e-refresh-token",
          token_type: "Bearer",
        }),
      );

      expect(keyPrefixB).not.toBe(keyPrefixA);
      await expect(credentialStore.load(`${keyPrefixA}:client_information`)).resolves.toContain(
        DYNAMIC_CLIENT_ID,
      );
      await expect(credentialStore.load(`${keyPrefixA}:tokens`)).resolves.toContain(
        OAUTH_ACCESS_TOKEN,
      );
      await expect(credentialStore.load(`${keyPrefixB}:client_information`)).resolves.toBeNull();
      await expect(credentialStore.load(`${keyPrefixB}:tokens`)).resolves.toBeNull();
    } finally {
      await rm(credentialsDir, { force: true, recursive: true });
    }
  });
});

async function handleAuthServerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authBaseUrl: string;
    tokenRequests: Array<Record<string, string>>;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: options.authBaseUrl,
      authorization_endpoint: `${options.authBaseUrl}/authorize`,
      token_endpoint: `${options.authBaseUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/token") {
    if (!isValidClientSecretBasic(req.headers.authorization)) {
      sendJson(res, 401, {
        error: "invalid_client",
      });
      return;
    }
    const body = new URLSearchParams(await readRequestBody(req));
    options.tokenRequests.push(Object.fromEntries(body.entries()));
    sendJson(res, 200, {
      access_token: OAUTH_ACCESS_TOKEN,
      expires_in: 3600,
      scope: body.get("scope") ?? MCP_SCOPE,
      token_type: "Bearer",
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

async function handleAuthorizationCodeAuthServerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authBaseUrl: string;
    authorizationRequests: Array<Record<string, string>>;
    /**
     * 要求 redirect_uri 与注册值完全一致（含端口）。
     *
     * 默认的 loopback 比较按 RFC 8252 忽略端口，这恰好掩盖了根因 2：真实授权服务器（如
     * auth.exa.ai）可能做精确匹配，失配时按 RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页。
     */
    exactRedirectUriMatch?: boolean;
    pkceChallenges: Map<string, string>;
    registrationRequests: Array<Record<string, unknown>>;
    strictAuthorizationState?: StrictAuthorizationServerState;
    tokenRequests: Array<Record<string, string>>;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: options.authBaseUrl,
      authorization_endpoint: `${options.authBaseUrl}/authorize`,
      token_endpoint: `${options.authBaseUrl}/token`,
      registration_endpoint: `${options.authBaseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_SCOPE],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/register") {
    const body = JSON.parse(await readRequestBody(req)) as Record<string, unknown>;
    options.registrationRequests.push(body);
    const registrationIndex = options.registrationRequests.length;
    const clientId = options.strictAuthorizationState
      ? `${DYNAMIC_CLIENT_ID}-${registrationIndex}`
      : DYNAMIC_CLIENT_ID;
    const clientSecret = options.strictAuthorizationState
      ? `${DYNAMIC_CLIENT_SECRET}-${registrationIndex}`
      : DYNAMIC_CLIENT_SECRET;
    if (options.strictAuthorizationState) {
      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((entry): entry is string => typeof entry === "string")
        : [];
      options.strictAuthorizationState.clients.set(clientId, { clientSecret, redirectUris });
    }
    sendJson(res, 201, {
      ...body,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: 1,
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_basic",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/authorize") {
    options.authorizationRequests.push(Object.fromEntries(url.searchParams.entries()));
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const registeredClient = options.strictAuthorizationState?.clients.get(clientId);
    if (
      !redirectUri ||
      !codeChallenge ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      (options.strictAuthorizationState &&
        (!registeredClient ||
          !registeredClient.redirectUris.some((registeredUri) =>
            options.exactRedirectUriMatch
              ? redirectUri === registeredUri
              : matchesRegisteredRedirectUri(redirectUri, registeredUri),
          )))
    ) {
      sendJson(res, 400, {
        error: "invalid_request",
      });
      return;
    }
    const authorizationCode = `interactive-code-${options.authorizationRequests.length}`;
    options.pkceChallenges.set(authorizationCode, codeChallenge);
    options.strictAuthorizationState?.authorizationCodes.set(authorizationCode, {
      clientId,
      codeChallenge,
      redirectUri,
    });
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", authorizationCode);
    const state = url.searchParams.get("state");
    if (state) callbackUrl.searchParams.set("state", state);
    res.writeHead(302, {
      Location: callbackUrl.toString(),
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/token") {
    const body = new URLSearchParams(await readRequestBody(req));
    const clientCredentials = parseClientSecretBasic(req.headers.authorization);
    options.tokenRequests.push({
      ...Object.fromEntries(body.entries()),
      ...(clientCredentials ? { client_id: clientCredentials.clientId } : {}),
    });
    if (body.get("grant_type") === "refresh_token") {
      const refreshToken = body.get("refresh_token") ?? "";
      const refreshClientId = options.strictAuthorizationState?.refreshTokens.get(refreshToken);
      const refreshClient = refreshClientId
        ? options.strictAuthorizationState?.clients.get(refreshClientId)
        : undefined;
      if (
        !refreshClientId ||
        !refreshClient ||
        clientCredentials?.clientId !== refreshClientId ||
        clientCredentials.clientSecret !== refreshClient.clientSecret
      ) {
        sendJson(res, 400, { error: "invalid_grant" });
        return;
      }
      sendJson(res, 200, {
        access_token: `${refreshClientId}-refreshed-access-token`,
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: MCP_SCOPE,
        token_type: "Bearer",
      });
      return;
    }
    const authorizationCode = body.get("code") ?? "";
    const codeVerifier = body.get("code_verifier") ?? "";
    const expectedChallenge = options.pkceChallenges.get(authorizationCode);
    const actualChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const strictAuthorization =
      options.strictAuthorizationState?.authorizationCodes.get(authorizationCode);
    const strictClient = strictAuthorization
      ? options.strictAuthorizationState?.clients.get(strictAuthorization.clientId)
      : undefined;
    const hasValidClient = options.strictAuthorizationState
      ? Boolean(
          strictAuthorization &&
          strictClient &&
          clientCredentials?.clientId === strictAuthorization.clientId &&
          clientCredentials.clientSecret === strictClient.clientSecret &&
          body.get("redirect_uri") === strictAuthorization.redirectUri,
        )
      : isValidClientSecretBasic(
          req.headers.authorization,
          DYNAMIC_CLIENT_ID,
          DYNAMIC_CLIENT_SECRET,
        );
    if (!hasValidClient) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    if (!expectedChallenge || actualChallenge !== expectedChallenge) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    options.pkceChallenges.delete(authorizationCode);
    options.strictAuthorizationState?.authorizationCodes.delete(authorizationCode);
    sendJson(res, 200, {
      access_token: OAUTH_ACCESS_TOKEN,
      expires_in: 3600,
      refresh_token: "oauth-e2e-refresh-token",
      scope: MCP_SCOPE,
      token_type: "Bearer",
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

async function followAuthorizationRedirect(authorizationUrl: string): Promise<void> {
  const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorizationResponse.status).toBe(302);
  const location = authorizationResponse.headers.get("location");
  if (!location) throw new Error("Authorization server did not redirect to callback URL");
  const callbackResponse = await fetch(location);
  expect(callbackResponse.status).toBe(200);
}

async function handleProtectedMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authBaseUrl: string;
    authorizations: string[];
    /** 调用方已经消费过请求体时传入,避免二次读取空流。 */
    body?: string;
    mcpUrl: string;
    resourceMetadataPath: string;
    /** 403 insufficient_scope challenge 的 scope;置位时对 tools/list 生效。 */
    stepUpScope?: string;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === options.resourceMetadataPath) {
    sendJson(res, 200, {
      authorization_servers: [options.authBaseUrl],
      resource: options.mcpUrl,
      resource_name: "ZCode OAuth E2E MCP",
      scopes_supported: [MCP_SCOPE],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/mcp") {
    res.writeHead(405);
    res.end();
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }

  const authorization = req.headers.authorization;
  if (authorization) options.authorizations.push(authorization);
  if (authorization !== `Bearer ${OAUTH_ACCESS_TOKEN}`) {
    res.writeHead(401, {
      "WWW-Authenticate": [
        `Bearer resource_metadata="${new URL(options.resourceMetadataPath, options.mcpUrl).href}", scope="${MCP_SCOPE}"`,
      ],
    });
    res.end();
    return;
  }

  const message = JSON.parse(options.body ?? (await readRequestBody(req))) as {
    id?: string | number;
    method?: string;
  };
  // 403 insufficient_scope：Bearer 合法但 scope 不足。challenge 同时带 resource_metadata，
  // 验证编排层把 challenge 的发现线索传进 Phase 2（spec §5.2 / §8 item 15）。
  if (options.stepUpScope && message.method === "tools/list") {
    res.writeHead(403, {
      "WWW-Authenticate": [
        `Bearer error="insufficient_scope", scope="${options.stepUpScope}", resource_metadata="${new URL(options.resourceMetadataPath, options.mcpUrl).href}"`,
      ],
    });
    res.end();
    return;
  }
  if (message.method === "initialize") {
    sendJson(res, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-11-25",
        serverInfo: {
          name: "oauth-e2e-mcp",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    sendJson(res, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        tools: [
          {
            description: "OAuth protected ping",
            inputSchema: {
              properties: {},
              type: "object",
            },
            name: "oauth_ping",
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    sendJson(res, 200, {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        content: [{ type: "text", text: "pong" }],
        isError: false,
      },
    });
    return;
  }

  if (message.method === "server/discover") {
    sendJson(res, 200, {
      error: {
        code: -32601,
        message: "Method not found",
      },
      id: message.id,
      jsonrpc: "2.0",
    });
    return;
  }

  sendJson(res, 202, {});
}

function isValidClientSecretBasic(
  value: string | undefined,
  clientId = OAUTH_CLIENT_ID,
  clientSecret = OAUTH_CLIENT_SECRET,
): boolean {
  if (!value?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  return decoded === `${clientId}:${clientSecret}`;
}

function createStrictAuthorizationServerState(): StrictAuthorizationServerState {
  return {
    authorizationCodes: new Map(),
    clients: new Map(),
    refreshTokens: new Map(),
  };
}

async function createTestOAuthSession(
  credentialStore: SharedZCodeCredentialStore,
  adapterInstanceId: string,
  serverUrl = "https://mcp.example.test/mcp",
): Promise<McpOAuthSession> {
  return await createMcpAuthorizationCodeOAuthSession({
    adapterInstanceId,
    config: testAuthorizationCodeConfig(),
    options: { credentialStore },
    serverName: "credential-pair-test",
    serverUrl,
  });
}

function testAuthorizationCodeConfig() {
  return {
    type: "authorization_code" as const,
    clientName: "ZCode Credential Pair Test",
    scope: MCP_SCOPE,
  };
}

function dynamicClientInformation(clientId: string): OAuthClientInformationMixed {
  return {
    client_id: clientId,
    client_secret: `${clientId}-secret`,
    token_endpoint_auth_method: "client_secret_basic",
  };
}

function oauthTokens(clientId: string): OAuthTokens {
  return {
    access_token: `${clientId}-access-token`,
    refresh_token: `${clientId}-refresh-token`,
    token_type: "Bearer",
  };
}

function createTestLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn,
  };
  return { logger, warn };
}

async function saveDynamicClientInformation(
  session: McpOAuthSession,
  clientInformation: OAuthClientInformationMixed,
): Promise<void> {
  if (!session.provider.saveClientInformation) {
    throw new Error("OAuth provider does not support dynamic client registration");
  }
  await session.provider.saveClientInformation(clientInformation);
}

function parseClientSecretBasic(
  value: string | undefined,
): { clientId: string; clientSecret: string } | undefined {
  if (!value?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(value.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) return undefined;
  return {
    clientId: decoded.slice(0, separatorIndex),
    clientSecret: decoded.slice(separatorIndex + 1),
  };
}

function matchesRegisteredRedirectUri(requestedValue: string, registeredValue: string): boolean {
  try {
    const requested = new URL(requestedValue);
    const registered = new URL(registeredValue);
    const isLoopback =
      requested.protocol === "http:" &&
      registered.protocol === "http:" &&
      requested.hostname === registered.hostname &&
      (requested.hostname === "127.0.0.1" || requested.hostname === "[::1]");
    if (!isLoopback) return requested.href === registered.href;
    return (
      requested.pathname === registered.pathname &&
      requested.search === registered.search &&
      requested.hash === registered.hash
    );
  } catch {
    return false;
  }
}

/** 统计当前活跃的 TCP server handle 数,用来断言连接期没有新开 callback listener。 */
function countTcpServers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "TCPSERVERWRAP").length;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<Server> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server is not listening on a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
