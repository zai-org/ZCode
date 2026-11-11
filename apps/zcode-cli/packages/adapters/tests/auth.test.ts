import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  CliOAuthError,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createBigmodelOAuthClient,
  createCliOAuthClient,
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  loadSharedZCodeCredential,
} from "../src/auth/index.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "test-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared ZCode credentials", () => {
  it("clears the associated account when the current global login is cleared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-clear-associated-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "zai",
        "oauth:zai:access_token": "login",
        "oauth:linked_bigmodel": "associated",
      });
      await store.clearZaiLoginCredentials();
      expect(await store.load("oauth:linked_bigmodel")).toBeNull();
      expect(await store.load("oauth:active_provider")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces China-region credentials and associated account when starting a new global login", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-cn-replace-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "zai_cn",
        "oauth:zai_cn:access_token": "cn-token",
        "oauth:linked_bigmodel": JSON.stringify({
          customerId: "linked",
          accessToken: "linked-token",
        }),
      });
      await store.saveZaiLoginCredentials({
        accessToken: "global",
        jwtToken: "global-jwt",
        user: { user_id: "global-user" },
      });
      expect(await store.load("oauth:zai_cn:access_token")).toBeNull();
      expect(await store.load("oauth:linked_bigmodel")).toBeNull();
      expect(await store.load("oauth:active_provider")).toBe("zai");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an old snapshot after the same account logs in again with identical tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-repeat-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const login = {
      accessToken: "same-token",
      jwtToken: "same-jwt",
      user: { user_id: "same-user" },
    };
    try {
      await store.saveZaiLoginCredentials(login);
      const expected = await store.loadOAuthSessionSnapshot();
      await store.saveZaiLoginCredentials(login);
      expect(await store.updateMany({ zcodejwttoken: null }, { expected })).toBe(false);
      expect(await store.load("zcodejwttoken")).toBe("same-jwt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not decrypt inactive provider leftovers when reading the active session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-inactive-broken-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "bigmodel",
        zcodejwttoken: "valid-jwt",
        "oauth:bigmodel:access_token": "valid-token",
      });
      const raw = JSON.parse(await readFile(store.filePath, "utf8"));
      raw["oauth:zai:access_token"] = "enc:v1:broken-unused-token";
      await writeFile(store.filePath, JSON.stringify(raw));
      const snapshot = await store.loadOAuthSessionSnapshot();
      expect(snapshot["oauth:active_provider"]).toBe("bigmodel");
      expect(snapshot["oauth:zai:access_token"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stale whole-session update without deleting unchanged sibling fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-group-cas-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "zai",
        zcodejwttoken: "old",
        "oauth:zai:user_info": "same-user",
      });
      const expected = await store.loadMany([
        "oauth:active_provider",
        "zcodejwttoken",
        "oauth:zai:user_info",
        "oauth:zai:refresh_token",
      ]);
      await store.save("zcodejwttoken", "new");
      expect(
        await store.updateMany(
          { "oauth:active_provider": null, zcodejwttoken: null, "oauth:zai:user_info": null },
          { expected },
        ),
      ).toBe(false);
      expect(await store.loadMany(Object.keys(expected))).toEqual({
        ...expected,
        zcodejwttoken: "new",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("clears a previous account and stale refresh token when committing a ZAI login", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-switch-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "bigmodel",
        "oauth:bigmodel:access_token": "old-account",
        "oauth:zai:refresh_token": "old-refresh",
        "bot:independent": "keep",
      });
      await store.saveZaiLoginCredentials({
        accessToken: "new-account",
        jwtToken: "new-jwt",
        user: { user_id: "new-user" },
      });
      expect(await store.load("oauth:bigmodel:access_token")).toBeNull();
      expect(await store.load("oauth:zai:refresh_token")).toBeNull();
      expect(await store.load("bot:independent")).toBe("keep");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not clear the active BigModel JWT when removing inactive ZAI credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-inactive-clear-"));
    const store = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    try {
      await store.saveMany({
        "oauth:active_provider": "bigmodel",
        zcodejwttoken: "bigmodel-jwt",
        "oauth:zai:access_token": "old-zai",
      });
      await store.clearZaiLoginCredentials();
      expect(await store.load("oauth:active_provider")).toBe("bigmodel");
      expect(await store.load("zcodejwttoken")).toBe("bigmodel-jwt");
      expect(await store.load("oauth:zai:access_token")).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("stores ZAI login credentials with z-code compatible encrypted keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));

    try {
      const store = createSharedZCodeCredentialStore({
        baseDir: dir,
        env: TEST_ENV,
      });

      await store.saveZaiLoginCredentials({
        accessToken: "zai-access-token",
        jwtToken: "zcode-jwt-token",
        user: {
          email: "alice@example.com",
          name: "Alice",
          user_id: "u_1",
        },
      });

      const raw = JSON.parse(await readFile(store.filePath, "utf-8")) as Record<string, string>;
      expect(store.filePath).toBe(join(dir, ".zcode", "v2", "credentials.json"));
      expect(raw[SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]?.startsWith("enc:v2:")).toBe(true);
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBe("zai");
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe(
        "zai-access-token",
      );
      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken)).toBe("zcode-jwt-token");
      expect(
        await loadSharedZCodeCredential(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken, {
          baseDir: dir,
          env: TEST_ENV,
        }),
      ).toBe("zai-access-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads legacy plaintext credential values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-"));
    const credentialsDir = join(dir, ".zcode", "v2");
    const credentialsPath = join(credentialsDir, "credentials.json");

    try {
      await mkdir(credentialsDir, { recursive: true });
      await writeFile(
        credentialsPath,
        JSON.stringify({
          [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: "legacy-token",
        }),
      );

      const store = createSharedZCodeCredentialStore({
        baseDir: dir,
        env: TEST_ENV,
      });

      expect(await store.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe("legacy-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across concurrent read-modify-write mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-concurrent-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    const entries = Array.from({ length: 40 }, (_, index) => [`key-${index}`, `value-${index}`]);

    try {
      await Promise.all(entries.map(([key, value]) => store.save(key!, value!)));

      await Promise.all(
        entries.map(async ([key, value]) => {
          await expect(store.load(key!)).resolves.toBe(value);
        }),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deletes a credential only when its expected plaintext value is still current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-compare-delete-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:snapshot", "snapshot-a");

      await expect(store.deleteIfValue("oauth:snapshot", "stale-snapshot")).resolves.toBe(false);
      await expect(store.load("oauth:snapshot")).resolves.toBe("snapshot-a");
      await expect(store.deleteIfValue("oauth:snapshot", "snapshot-a")).resolves.toBe(true);
      await expect(store.load("oauth:snapshot")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("publishes a replacement credential and removes legacy keys in one mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-replace-"));
    const store = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await store.save("oauth:legacy-client", "client-a");
      await store.save("oauth:legacy-tokens", "tokens-a");

      await store.saveReplacing("oauth:canonical", "pair-a", [
        "oauth:legacy-client",
        "oauth:legacy-tokens",
      ]);

      await expect(store.load("oauth:canonical")).resolves.toBe("pair-a");
      await expect(store.load("oauth:legacy-client")).resolves.toBeNull();
      await expect(store.load("oauth:legacy-tokens")).resolves.toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves every key across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-processes-"));
    const credentialsPath = join(dir, "credentials.json");
    const processCount = 4;
    const keysPerProcess = 8;

    try {
      await runConcurrentCredentialWorkers(credentialsPath, processCount, keysPerProcess);
      const store = createSharedZCodeCredentialStore({
        env: TEST_ENV,
        filePath: credentialsPath,
      });
      await Promise.all(
        Array.from({ length: processCount }, (_, processIndex) =>
          Array.from({ length: keysPerProcess }, async (_, keyIndex) => {
            await expect(store.load(`worker-${processIndex}:key-${keyIndex}`)).resolves.toBe(
              `value-${processIndex}-${keyIndex}`,
            );
          }),
        ).flat(),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("backs up corrupt JSON and refuses to overwrite it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-"));
    const credentialsPath = join(dir, "credentials.json");
    const store = createSharedZCodeCredentialStore({
      env: TEST_ENV,
      filePath: credentialsPath,
    });

    try {
      await writeFile(credentialsPath, "{not-json", {
        encoding: "utf-8",
        mode: 0o644,
      });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          expect(store.load("safe-key")).rejects.toThrow("Shared ZCode credentials are corrupt"),
        ),
      );
      await expect(store.save("safe-key", "safe-value")).rejects.toThrow(
        "Shared ZCode credentials are corrupt",
      );
      await expect(readFile(credentialsPath, "utf-8")).resolves.toBe("{not-json");
      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
      await expect(readFile(join(dir, backups[0]!), "utf-8")).resolves.toBe("{not-json");
      if (process.platform !== "win32") {
        expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("deduplicates corrupt credential backups across independent Node processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-auth-corrupt-processes-"));
    const credentialsPath = join(dir, "credentials.json");

    try {
      await writeFile(credentialsPath, "{not-json", "utf-8");
      await runConcurrentCredentialWorkers(credentialsPath, 6, 0, "read-corrupt");

      const backups = (await readdir(dir)).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function runConcurrentCredentialWorkers(
  filePath: string,
  processCount: number,
  keysPerProcess: number,
  operation: "save" | "read-corrupt" = "save",
): Promise<void> {
  const workerUrl = new URL("./fixtures/shared-credentials-concurrent-process.ts", import.meta.url);
  const children = Array.from({ length: processCount }, (_, processIndex) =>
    fork(workerUrl, {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );

  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) =>
              reject(new Error(`credential child exited early: ${code}`)),
            );
            child.on("message", (message: { type?: unknown }) => {
              if (message.type === "ready") resolve();
            });
          }),
      ),
    );

    const results = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code !== 0) reject(new Error(`credential child exited with code ${code}`));
          });
          child.on("message", (message: { error?: unknown; type?: unknown }) => {
            if (message.type === "done") resolve();
            if (message.type === "error") reject(new Error(String(message.error)));
          });
        }),
    );

    children.forEach((child, processIndex) => {
      child.send({
        filePath,
        keysPerProcess,
        operation,
        processIndex,
        type: "start",
      });
    });
    await Promise.all(results);
  } finally {
    for (const child of children) {
      if (child.connected) child.disconnect();
      child.kill();
    }
  }
}

// CLI 浏览器登录的轮询客户端按 providerId 泛化（zai/bigmodel），ready 数据统一为 accessToken。
describe("CLI OAuth client", () => {
  it("initializes and polls the backend device flow", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-1",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=state",
          expires_at: 1735000000,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "ready",
          token: "jwt-token",
          user: {
            user_id: "u_1",
            email: "alice@example.com",
            name: "Alice",
          },
          zai: {
            access_token: "zai-access-token",
          },
        },
      }),
    ]);
    const client = createCliOAuthClient({
      baseUrl: "https://zcode.example/api/v1/",
      httpClient,
      providerId: "zai",
    });

    const init = await client.init({ pollToken: "poll-token" });
    const poll = await client.poll({
      flowId: init.flow_id,
      pollToken: "poll-token",
    });

    expect(httpClient.requests[0]).toMatchObject({
      method: "POST",
      url: "https://zcode.example/api/v1/oauth/cli/init",
      headers: {
        Authorization: "Bearer poll-token",
        "Content-Type": "application/json",
      },
    });
    expect(new TextDecoder().decode(httpClient.requests[0]?.body)).toBe('{"provider":"zai"}');
    expect(httpClient.requests[1]).toMatchObject({
      method: "GET",
      url: "https://zcode.example/api/v1/oauth/cli/poll/flow-1",
      headers: {
        Authorization: "Bearer poll-token",
      },
    });
    expect(poll).toMatchObject({
      status: "ready",
      token: "jwt-token",
      providerId: "zai",
      accessToken: "zai-access-token",
    });
  });

  it("surfaces backend business errors", async () => {
    const client = createCliOAuthClient({
      httpClient: new FakeHttpClient([
        jsonResponse({
          code: 3004,
          msg: "invalid_flow",
          data: {},
        }),
      ]),
      providerId: "zai",
    });

    await expect(client.init({ pollToken: "poll-token" })).rejects.toMatchObject({
      businessCode: 3004,
      message: "invalid_flow",
      name: "CliOAuthError",
    } satisfies Partial<CliOAuthError>);
  });
});

describe("Coding Plan API key resolver", () => {
  it.each(["bigmodel", "zai"] as const)(
    "creates %s keys with Coding Plan usageScene",
    async (family) => {
      const httpClient = new FakeHttpClient([
        ...(family === "zai"
          ? [jsonResponse({ code: 200, data: { access_token: "biz-token" } })]
          : []),
        customerInfoResponse(),
        jsonResponse({ code: 200, data: [] }),
        jsonResponse({
          code: 200,
          data: { apiKey: "key", name: "zcode-api-key" },
        }),
        jsonResponse({
          code: 200,
          data: {
            accessToken: "project-token",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        }),
      ]);
      await expect(
        createCodingPlanApiKeyResolver({ httpClient }).resolve({
          accessToken: "login-token",
          family,
        }),
      ).resolves.toBe("project-token");
      expect(httpClient.requests.some((request) => request.url.includes("/copy/"))).toBe(false);
      const issuance = httpClient.requests.at(-1)!;
      expect(issuance.url).toMatch(/\/api_keys\/key\/access_tokens$/);
      expect(issuance.method).toBe("POST");
      expect(JSON.parse(new TextDecoder().decode(issuance.body))).toMatchObject({
        clientType: "zcode",
      });
      const create = httpClient.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/api_keys"),
      );
      expect(create).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(create!.body))).toEqual({
        name: "zcode-api-key",
        usageScene: 1,
      });
    },
  );

  it("keeps the CLI default project even when it is a team project", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org",
              organizationName: "默认机构",
              projects: [
                { projectId: "personal", projectType: 1 },
                { projectId: "team", projectName: "默认项目", projectType: 2 },
              ],
            },
          ],
        },
      }),
      jsonResponse({ code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] }),
      jsonResponse({
        code: 200,
        data: {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        },
      }),
    ]);
    await expect(
      createCodingPlanApiKeyResolver({ httpClient }).resolve({
        accessToken: "login",
        family: "bigmodel",
      }),
    ).resolves.toBe("project-token");
    expect(httpClient.requests[1]?.url).toContain("/projects/team/api_keys");
    expect(httpClient.requests.at(-1)?.headers).toMatchObject({ authorization: "Bearer login" });
  });

  it("exchanges a ZAI OAuth access token for a short-lived project token", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        data: {
          access_token: "zai-biz-token",
        },
      }),
      customerInfoResponse(),
      jsonResponse({
        code: 200,
        data: [],
      }),
      jsonResponse({
        code: 200,
        data: {
          apiKey: "zai-api-key",
          name: "zcode-api-key",
        },
      }),
      jsonResponse({
        code: 200,
        data: {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    ]);
    const resolver = createCodingPlanApiKeyResolver({ httpClient });

    await expect(
      resolver.resolve({
        accessToken: "zai-oauth-token",
        family: "zai",
      }),
    ).resolves.toBe("project-token");
    expect(httpClient.requests[0]?.url).toBe("https://api.z.ai/api/auth/z/login");
    expect(httpClient.requests[1]?.headers).toMatchObject({
      authorization: "zai-biz-token",
    });
    for (const request of httpClient.requests.slice(2))
      expect(request.headers).toMatchObject({ authorization: "Bearer zai-biz-token" });
  });

  it("resolves a BigModel OAuth access token through project access token issuance", async () => {
    const httpClient = new FakeHttpClient([
      customerInfoResponse(),
      jsonResponse({
        code: 200,
        data: [
          {
            apiKey: "bigmodel-api-key",
            name: "zcode-api-key",
          },
        ],
      }),
      jsonResponse({
        code: 200,
        data: {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    ]);
    const resolver = createCodingPlanApiKeyResolver({ httpClient });

    await expect(
      resolver.resolve({
        accessToken: "bigmodel-oauth-token",
        family: "bigmodel",
      }),
    ).resolves.toBe("project-token");
    expect(httpClient.requests[0]?.url).toBe(
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
    );
    expect(httpClient.requests[0]?.headers).toMatchObject({
      authorization: "bigmodel-oauth-token",
    });
  });

  it("uses bigmodel.cn for BigModel API key resolution when ZCODE_ENV=test", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    const httpClient = new FakeHttpClient([
      customerInfoResponse(),
      jsonResponse({
        code: 200,
        data: [
          {
            apiKey: "bigmodel-api-key",
            name: "zcode-api-key",
          },
        ],
      }),
      jsonResponse({
        code: 200,
        data: {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    ]);
    const resolver = createCodingPlanApiKeyResolver({ httpClient });

    await resolver.resolve({
      accessToken: "bigmodel-oauth-token",
      family: "bigmodel",
    });

    expect(httpClient.requests[0]?.url).toBe(
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
    );
  });
});

describe("BigModel OAuth client", () => {
  it("builds localhost authorize URLs and exchanges auth codes", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        data: {
          accessToken: "bigmodel-access-token",
          refreshToken: "bigmodel-refresh-token",
        },
      }),
    ]);
    const client = createBigmodelOAuthClient({
      appSecret: "test-secret",
      httpClient,
    });

    const authorizeUrl = client.buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:1234/oauth/callback/bigmodel",
      state: "state-1",
    });
    const tokenSet = await client.exchangeCode({ code: "auth-code" });

    expect(authorizeUrl).toContain("https://bigmodel.cn/login?");
    expect(authorizeUrl).toContain("appId=zcode");
    expect(authorizeUrl).toContain("state=state-1");
    expect(tokenSet).toEqual({
      accessToken: "bigmodel-access-token",
      refreshToken: "bigmodel-refresh-token",
    });
    expect(new TextDecoder().decode(httpClient.requests[0]?.body)).toContain(
      '"authCode":"auth-code"',
    );
  });

  it("uses bigmodel.cn for authorize URL when ZCODE_ENV=test", () => {
    vi.stubEnv("ZCODE_ENV", "test");
    const httpClient = new FakeHttpClient([]);
    const client = createBigmodelOAuthClient({
      appSecret: "test-secret",
      httpClient,
    });

    const authorizeUrl = client.buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:1234/oauth/callback/bigmodel",
      state: "state-1",
    });

    expect(authorizeUrl).toContain("https://bigmodel.cn/login?");
  });

  it("uses bigmodel.cn for token exchange when ZCODE_ENV=test", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    const httpClient = new FakeHttpClient([
      jsonResponse({
        data: {
          accessToken: "bigmodel-access-token",
        },
      }),
    ]);
    const client = createBigmodelOAuthClient({
      appSecret: "test-secret",
      httpClient,
    });

    await client.exchangeCode({ code: "auth-code" });

    expect(httpClient.requests[0]?.url).toBe("https://bigmodel.cn/api/auth/tokenByAuthCode");
  });

  it("requires an explicit app secret before exchanging auth codes", async () => {
    const httpClient = new FakeHttpClient([]);
    const client = createBigmodelOAuthClient({ httpClient });

    await expect(client.exchangeCode({ code: "auth-code" })).rejects.toMatchObject({
      message: "BigModel OAuth appSecret is required.",
      name: "BigmodelOAuthError",
    });
    expect(httpClient.requests).toHaveLength(0);
  });
});

class FakeHttpClient implements HttpClientPort {
  readonly requests: HttpClientRequest[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response configured");
    }
    return response;
  }
}

function jsonResponse(body: unknown, status = 200): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: {
      "content-type": "application/json",
    },
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: "https://zcode.example/api/v1",
  };
}

function customerInfoResponse(): HttpClientResponse {
  return jsonResponse({
    code: 200,
    data: {
      organizations: [
        {
          organizationId: "org-1",
          organizationName: "默认机构",
          projects: [
            {
              projectId: "project-1",
              projectName: "默认项目",
            },
          ],
        },
      ],
    },
  });
}
