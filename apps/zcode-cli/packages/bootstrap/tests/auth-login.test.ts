import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createSharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { acquireFileLock, atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  standaloneAccountIdentityCredentialKey,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";
import {
  configureCodingPlanApiKey,
  hasConfiguredStandaloneCodingPlan,
  loginZCodeCli,
  logoutZCodeCli,
} from "../src/auth-login.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "bootstrap-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};

describe("ZCode CLI login", () => {
  it("没有任何 Standalone 账号凭据时不会误报已配置 Coding Plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-no-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    try {
      await expect(
        hasConfiguredStandaloneCodingPlan({ credentialStore, env: TEST_ENV }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses the production ZCode endpoint by default for OAuth init", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-endpoint-"));
    const filePath = join(dir, "credentials.json");
    // Bug 原因：未注入 store 时会访问真实用户目录，失败的登录也会先用测试密钥迁移旧凭据。
    // 显式绑定临时文件，避免只模拟 HTTP 却漏掉了持久化副作用。
    const credentialStore = createSharedZCodeCredentialStore({ filePath, env: TEST_ENV });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    try {
      await writeFile(filePath, JSON.stringify({ fixture: "existing-credential" }));
      await expect(
        loginZCodeCli({
          credentialStore,
          env: TEST_ENV,
          httpClient,
          noBrowser: true,
          now: () => 1_000,
          pollToken: "poll-token",
          sleep: async () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "auth_failed",
      });

      expect(httpClient.requests[0]?.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
      // 登录失败前也会读取并迁移凭据，必须确实使用此测试的临时文件。
      const persisted = JSON.parse(await readFile(filePath, "utf8"));
      expect(persisted.fixture).toMatch(/^enc:v2:env:/);
      await expect(credentialStore.load("fixture")).resolves.toBe("existing-credential");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("polls OAuth, stores account credentials, and updates the configured default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-"));
    const credentialsBaseDir = join(dir, "home");
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: credentialsBaseDir,
      env: TEST_ENV,
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-1",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=state",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "pending",
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
      jsonResponse({
        code: 0,
        data: {
          access_token: "zai-biz-token",
        },
      }),
      jsonResponse({
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
      }),
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
    const statuses: string[] = [];
    let authorizeUrl = "";

    try {
      const result = await loginZCodeCli({
        credentialStore,
        env: TEST_ENV,
        httpClient,
        noBrowser: true,
        now: () => 1_000,
        onAuthorizeUrl: (data) => {
          authorizeUrl = data.authorize_url;
        },
        onPollStatus: (data) => {
          statuses.push(data.status);
        },
        pollToken: "poll-token",
        sleep: async () => undefined,
        personalProviderConfigPath,
      });

      const modelSelectionConfig = JSON.parse(await readFile(personalProviderConfigPath, "utf-8"));
      const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountIdentity: "u_1",
      });
      expect(authorizeUrl).toBe("https://chat.z.ai/oauth/authorize?state=state");
      expect(statuses).toEqual(["pending", "ready"]);
      expect(result).toMatchObject({
        configPath: personalProviderConfigPath,
        credentialsPath: credentialStore.filePath,
        model: `${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}/GLM-5.3`,
        providerId: "zai",
        user: {
          user_id: "u_1",
          email: "alice@example.com",
          name: "Alice",
        },
      });
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe(
        "zai-access-token",
      );
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken)).toBe(
        "jwt-token",
      );
      expect(
        await credentialStore.load(
          standaloneAccountIdentityCredentialKey(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          ),
        ),
      ).toBe("u_1");
      expect(await credentialStore.load(accountProviderCredentialKey)).toBeNull();
      expect(modelSelectionConfig).toMatchObject({
        schemaVersion: 1,
        config: {
          defaultModelSelection: {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            modelId: "GLM-5.3",
          },
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("clears shared ZAI credentials and standalone account access on logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await credentialStore.saveZaiLoginCredentials({
        accessToken: "zai-access-token",
        jwtToken: "jwt-token",
        user: {
          user_id: "u_1",
        },
      });
      const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountIdentity: "u_1",
      });
      await credentialStore.saveMany({
        [standaloneAccountIdentityCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "u_1",
        [standaloneAccountAuthSourceCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "manual",
        [accountProviderCredentialKey]: "coding-plan-key",
      });

      const result = await logoutZCodeCli({ credentialStore, env: TEST_ENV });

      expect(result.credentialsPath).toBe(credentialStore.filePath);
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBeNull();
      expect(
        await credentialStore.load(
          standaloneAccountIdentityCredentialKey(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          ),
        ),
      ).toBeNull();
      expect(await credentialStore.load(accountProviderCredentialKey)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each(["oauth", undefined])("退出不解密来源为 %s 的历史旧 Key", async (source) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-legacy-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const legacyKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity: "user",
    });
    try {
      await credentialStore.saveMany({
        [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: "valid-oauth",
        [standaloneAccountIdentityCredentialKey(providerId)]: "user",
        ...(source ? { [standaloneAccountAuthSourceCredentialKey(providerId)]: source } : {}),
      });
      const raw = JSON.parse(await readFile(credentialStore.filePath, "utf8"));
      raw[legacyKey] = "enc:v1:broken-legacy-key";
      await writeFile(credentialStore.filePath, JSON.stringify(raw));
      await expect(logoutZCodeCli({ credentialStore, env: TEST_ENV })).resolves.toMatchObject({
        credentialsPath: credentialStore.filePath,
      });
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId)),
      ).toBeNull();
      expect(JSON.parse(await readFile(credentialStore.filePath, "utf8"))[legacyKey]).toBe(
        raw[legacyKey],
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("manual Coding Plan API Key uses the same Account Access and Selection facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-api-key-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: join(dir, "home"),
      env: TEST_ENV,
    });
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const zcodeBuiltinProviderConfigPath = join(dir, "zcode-builtin.json");
    const configuredProviderId = "configured-bigmodel-individual";
    await writeFile(
      zcodeBuiltinProviderConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            templateRules: [],
            providerRules: [
              {
                providerId: configuredProviderId,
                config: {
                  group: "bigmodel-family",
                  builtinModelIds: ["model-from-config"],
                  access: {
                    type: "zhipu-account",
                    accountType: "bigmodel",
                    mode: "individual-coding-plan",
                  },
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );

    try {
      const result = await configureCodingPlanApiKey({
        apiKey: "manual-key",
        credentialStore,
        env: {
          ...TEST_ENV,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
        },
        personalProviderConfigPath,
        providerId: "bigmodel",
      });

      expect(result).toEqual({
        configPath: personalProviderConfigPath,
        model: `${configuredProviderId}/model-from-config`,
        providerId: "bigmodel",
      });
      await expect(
        hasConfiguredStandaloneCodingPlan({
          credentialStore,
          env: {
            ...TEST_ENV,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  for (const providerId of ["zai", "bigmodel"] as const) {
    for (const pauseAt of ["credential-lock", "config-lock"] as const) {
      it(`${providerId} API Key 登录在 ${pauseAt} 期间恢复后不得提交旧凭据或默认配置`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "zcode-manual-login-recovery-"));
        const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
        const personalProviderConfigPath = join(dir, "provider_config.json");
        const original = JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          },
        });
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const capture = credentialStore.captureRecoveryGuard.bind(credentialStore);
        credentialStore.captureRecoveryGuard = async () => {
          const guard = await capture();
          if (pauseAt === "credential-lock") entered();
          return guard;
        };
        let observing = false;
        const stop = credentialStore.onDidChange?.(() => {
          if (observing && pauseAt === "config-lock") entered();
        });
        let unlock: (() => Promise<void>) | undefined;
        try {
          await credentialStore.save("before", "old-value");
          await writeFile(personalProviderConfigPath, original);
          unlock = await acquireFileLock(
            pauseAt === "credential-lock" ? credentialStore.filePath : personalProviderConfigPath,
            [],
            0,
            10000,
          );
          observing = true;
          const options = {
            providerId,
            apiKey: "synthetic-api-key",
            credentialStore,
            env: TEST_ENV,
            personalProviderConfigPath,
          };
          const pending = configureCodingPlanApiKey(options).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          // 配置等待由实际凭据保存确认；凭据等待由实际 guard 捕获确认，不靠睡眠猜测。
          await waiting;
          if (pauseAt === "credential-lock") {
            await atomicWritePrivateTextFile(
              `${credentialStore.filePath}.recovery-generation`,
              "recovered",
            );
            await atomicWritePrivateTextFile(credentialStore.filePath, "{}");
          } else {
            await withFileLock(credentialStore.filePath, async () => {
              await atomicWritePrivateTextFile(
                `${credentialStore.filePath}.recovery-generation`,
                "recovered",
              );
              await atomicWritePrivateTextFile(credentialStore.filePath, "{}");
            });
          }
          await unlock();
          unlock = undefined;
          expect(await pending).toMatchObject({
            error: { code: "ZCODE_CREDENTIAL_STORE_CHANGED" },
          });
          expect(await readFile(credentialStore.filePath, "utf8")).toBe("{}");
          expect(await readFile(personalProviderConfigPath, "utf8")).toBe(original);
          await expect(configureCodingPlanApiKey(options)).resolves.toMatchObject({ providerId });
          expect(await readFile(personalProviderConfigPath, "utf8")).not.toBe(original);
        } finally {
          stop?.();
          await unlock?.();
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
    for (const pauseAt of ["init", "poll", "material", "config-lock"] as const) {
      it(`${providerId} 在 ${pauseAt} 等待期间恢复凭据库后拒绝旧登录，新登录仍可成功`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "zcode-login-recovery-"));
        const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
        const personalProviderConfigPath = join(dir, "provider_config.json");
        const originalConfig = JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          },
        });
        let release!: () => void;
        let entered!: () => void;
        let paused = true;
        let unlockConfig: (() => Promise<void>) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const pause = async (stage: string) => {
          if (paused && stage === pauseAt) {
            entered();
            await gate;
          }
        };
        const options = () => {
          const http = new FakeHttpClient([
            jsonResponse({
              code: 0,
              data: {
                flow_id: "recovery-flow",
                authorize_url: "https://example.com/authorize",
                expires_at: 9999999999,
                poll_interval_sec: 1,
              },
            }),
            jsonResponse({
              code: 0,
              data: {
                status: "ready",
                token: "new-jwt",
                user: { user_id: "test-user", name: "Test" },
                [providerId]: { access_token: "new-access" },
              },
            }),
          ]);
          return {
            providerId,
            credentialStore,
            personalProviderConfigPath,
            env: TEST_ENV,
            noBrowser: true,
            pollToken: "test-poll",
            sleep: async () => undefined,
            httpClient: {
              request: async (request: HttpClientRequest) => {
                if (request.url.endsWith("/init")) await pause("init");
                if (request.url.includes("/poll/")) await pause("poll");
                return http.request(request);
              },
            },
            apiKeyResolver: {
              clear() {},
              resolve: async () => "test-pat",
              resolveMaterial: async () => {
                await pause("material");
                return {
                  token: "test-pat",
                  apiKeyId: "key",
                  organizationId: "org",
                  projectId: "project",
                };
              },
            },
          };
        };
        const stopObserving = credentialStore.onDidChange?.(async () => {
          if (
            pauseAt === "config-lock" &&
            (await credentialStore.load(
              standaloneAccountIdentityCredentialKey(
                providerId === "zai"
                  ? BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                  : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              ),
            ))
          )
            entered();
        });
        try {
          await credentialStore.save("before", "old-value");
          await writeFile(personalProviderConfigPath, originalConfig);
          if (pauseAt === "config-lock")
            unlockConfig = await acquireFileLock(personalProviderConfigPath, [], 0, 10000);
          const pending = loginZCodeCli(options()).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          await waiting;
          // 与 Desktop 恢复相同的提交边界：同一锁内先推进代次，再原子替换空库。
          await withFileLock(credentialStore.filePath, async () => {
            await atomicWritePrivateTextFile(
              `${credentialStore.filePath}.recovery-generation`,
              "recovered",
            );
            await atomicWritePrivateTextFile(credentialStore.filePath, "{}");
          });
          paused = false;
          release();
          await unlockConfig?.();
          unlockConfig = undefined;
          const completion = await pending;
          expect(completion).toMatchObject({
            error: {
              code: pauseAt === "config-lock" ? "config_update_failed" : "credential_write_failed",
              cause: { code: "ZCODE_CREDENTIAL_STORE_CHANGED" },
            },
          });
          expect(await readFile(credentialStore.filePath, "utf8")).toBe("{}");
          expect(await readFile(personalProviderConfigPath, "utf8")).toBe(originalConfig);
          await expect(loginZCodeCli(options())).resolves.toMatchObject({ providerId });
          expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBe(
            providerId,
          );
          expect(await readFile(personalProviderConfigPath, "utf8")).not.toBe(originalConfig);
        } finally {
          release();
          await unlockConfig?.();
          stopObserving?.();
          await rm(dir, { force: true, recursive: true });
        }
      });
    }
  }

  it("reports failed and expired OAuth flows as retryable login errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-failure-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const failedClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    try {
      await expect(
        loginZCodeCli({
          credentialStore,
          env: TEST_ENV,
          httpClient: failedClient,
          noBrowser: true,
          now: () => 1_000,
          pollToken: "poll-token",
          sleep: async () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "auth_failed",
      });

      const expiredClient = new FakeHttpClient([
        jsonResponse({
          code: 0,
          msg: "",
          data: {
            flow_id: "flow-expired",
            poll_token: "poll-token",
            authorize_url: "https://chat.z.ai/oauth/authorize?state=expired",
            expires_at: 1,
            poll_interval_sec: 2,
          },
        }),
      ]);

      await expect(
        loginZCodeCli({
          credentialStore,
          env: TEST_ENV,
          httpClient: expiredClient,
          noBrowser: true,
          now: () => 2_000,
          pollToken: "poll-token",
          sleep: async () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "auth_timeout",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("系统凭据库不可用时在 OAuth init 前失败，不展示授权地址", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-store-unavailable-"));
    const filePath = join(dir, "credentials.json");
    // 不配置受管密钥：空库在首次写入时才访问系统库，拒绝访问模拟锁定或缺少 Secret Service。
    const env = {};
    const keyStoreCalls: string[] = [];
    const credentialStore = createSharedZCodeCredentialStore({
      cipher: createSystemCredentialCipher({
        env,
        filePath,
        keyStore: {
          get: async () => {
            keyStoreCalls.push("get");
            throw new Error("denied");
          },
          set: async () => {
            keyStoreCalls.push("set");
            throw new Error("denied");
          },
        },
      }),
      env,
      filePath,
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-store-unavailable",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=store-unavailable",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "ready",
          token: "jwt-token",
          user: { user_id: "u_1" },
          zai: { access_token: "zai-access-token" },
        },
      }),
    ]);
    let authorizeUrlShown = false;

    try {
      await expect(
        loginZCodeCli({
          apiKeyResolver: {
            clear() {},
            resolve: async () => "test-pat",
            resolveMaterial: async () => ({
              token: "test-pat",
              apiKeyId: "key",
              organizationId: "org",
              projectId: "project",
            }),
          },
          baseUrl: "https://zcode.example/api/v1",
          credentialStore,
          env,
          httpClient,
          noBrowser: true,
          now: () => 1_000,
          onAuthorizeUrl: () => {
            authorizeUrlShown = true;
          },
          pollToken: "poll-token",
          sleep: async () => undefined,
        }),
      ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
      expect(keyStoreCalls).toEqual(["get"]);
      expect(httpClient.requests).toHaveLength(0);
      expect(authorizeUrlShown).toBe(false);
      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("aborts a ZAI OAuth login while waiting for authorization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-abort-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const abortController = new AbortController();
    let sleepStarted: (() => void) | undefined;
    const sleepPromise = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-abort",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=abort",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "pending",
        },
      }),
    ]);

    try {
      const loginPromise = loginZCodeCli({
        abortSignal: abortController.signal,
        credentialStore,
        env: TEST_ENV,
        httpClient,
        noBrowser: true,
        now: () => 1_000,
        pollToken: "poll-token",
        sleep: async () => {
          sleepStarted?.();
          await new Promise<void>(() => undefined);
        },
      });

      await sleepPromise;
      abortController.abort(new Error("login cancelled"));

      await expect(loginPromise).rejects.toThrow("login cancelled");
      expect(httpClient.requests).toHaveLength(2);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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

function jsonResponse(body: unknown): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    statusText: "OK",
    url: "https://zcode.example/api/v1",
  };
}
