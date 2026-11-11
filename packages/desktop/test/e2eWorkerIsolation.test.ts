import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyE2EWorkerModelRetryEnv,
  applyE2EWorkerReplayProxyEnv,
  replaceChromeUserDataDirArg,
  resolveE2EWorkerModelStreamIdleTimeoutMs,
  resolveE2EWebDriverRequestLimits,
  resolveE2EWorkerChromiumProfileDir,
  workerSpecsContain,
} from "./e2e/helpers/e2e-worker-isolation.js";

describe("desktop e2e worker isolation", () => {
  it("bounds a broken WebDriver request before the renderer preflight can stall", () => {
    expect(resolveE2EWebDriverRequestLimits({})).toEqual({
      retryCount: 0,
      timeoutMs: 30_000,
    });
    expect(resolveE2EWebDriverRequestLimits({ retryCount: "2", timeoutMs: "45000" })).toEqual({
      retryCount: 2,
      timeoutMs: 45_000,
    });
    expect(resolveE2EWebDriverRequestLimits({ retryCount: "99", timeoutMs: "999999" })).toEqual({
      retryCount: 3,
      timeoutMs: 300_000,
    });
    expect(resolveE2EWebDriverRequestLimits({ retryCount: "-1", timeoutMs: "invalid" })).toEqual({
      retryCount: 0,
      timeoutMs: 30_000,
    });
  });

  it("matches fixture markers against the current worker specs only", () => {
    const requestedBatch = ["smoke.test.ts", "oauth-credential-recovery.test.ts"];
    const currentWorkerSpecs = [requestedBatch[0] as string];

    // Bugfix: launcher 的完整请求列表不能决定当前 worker 的 credential/provider fixture。
    expect(workerSpecsContain(currentWorkerSpecs, "oauth-credential-recovery.test.ts")).toBe(false);
    expect(
      workerSpecsContain([requestedBatch[1] as string], "oauth-credential-recovery.test.ts"),
    ).toBe(true);
  });

  it("disables model retries only for terminal projection workers and restores the value", () => {
    const env: Record<string, string | undefined> = {};

    applyE2EWorkerModelRetryEnv(
      env,
      [
        "./test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts",
      ],
      undefined,
    );
    expect(env.ZCODE_MODEL_RETRY_MAX_RETRIES).toBe("0");

    applyE2EWorkerModelRetryEnv(env, ["./test/e2e/conversation-session/smoke.test.ts"], undefined);
    expect(env.ZCODE_MODEL_RETRY_MAX_RETRIES).toBeUndefined();

    applyE2EWorkerModelRetryEnv(
      env,
      [
        "./test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts",
      ],
      "4",
    );
    expect(env.ZCODE_MODEL_RETRY_MAX_RETRIES).toBe("0");

    applyE2EWorkerModelRetryEnv(
      env,
      [
        "./test/e2e/conversation-session/models/conversation-session-model-switch-restore-repro.test.ts",
      ],
      "4",
    );
    expect(env.ZCODE_MODEL_RETRY_MAX_RETRIES).toBe("0");

    applyE2EWorkerModelRetryEnv(env, ["./test/e2e/conversation-session/smoke.test.ts"], "4");
    expect(env.ZCODE_MODEL_RETRY_MAX_RETRIES).toBe("4");
  });

  it("routes BG25 and I55 through replay proxy while keeping BG26 direct", () => {
    const env: Record<string, string | undefined> = {
      ZCODE_HTTP_PROXY: "http://configured-proxy:8080",
      ZCODE_NO_PROXY: "localhost",
    };

    applyE2EWorkerReplayProxyEnv(
      env,
      [
        "./test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts",
      ],
      "http://127.0.0.1:43123",
      {
        httpProxy: "http://configured-proxy:8080",
        noProxy: "localhost",
      },
    );
    expect(env.ZCODE_HTTP_PROXY).toBe("http://configured-proxy:8080");
    expect(env.ZCODE_NO_PROXY).toBe("localhost");

    applyE2EWorkerReplayProxyEnv(
      env,
      [
        "./test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts",
      ],
      "http://127.0.0.1:43126",
      {
        httpProxy: "http://configured-proxy:8080",
        noProxy: "localhost",
      },
    );
    expect(env.ZCODE_HTTP_PROXY).toBe("http://127.0.0.1:43126");
    expect(env.ZCODE_NO_PROXY).toBe("");

    applyE2EWorkerReplayProxyEnv(
      env,
      [
        "./test/e2e/conversation-session/models/conversation-session-thought-level-session-isolation.test.ts",
      ],
      "http://127.0.0.1:43125",
      {
        httpProxy: "http://configured-proxy:8080",
        noProxy: "localhost",
      },
    );
    expect(env.ZCODE_HTTP_PROXY).toBe("http://127.0.0.1:43125");
    expect(env.ZCODE_NO_PROXY).toBe("");

    applyE2EWorkerReplayProxyEnv(
      env,
      ["./test/e2e/conversation-session/smoke.test.ts"],
      "http://127.0.0.1:43124",
      {
        httpProxy: "http://configured-proxy:8080",
        noProxy: "localhost",
      },
    );
    expect(env.ZCODE_HTTP_PROXY).toBe("http://configured-proxy:8080");
    expect(env.ZCODE_NO_PROXY).toBe("localhost");

    applyE2EWorkerReplayProxyEnv(
      env,
      ["./test/e2e/conversation-session/smoke.test.ts"],
      "http://127.0.0.1:43124",
      { httpProxy: undefined, noProxy: undefined },
    );
    expect(env.ZCODE_HTTP_PROXY).toBeUndefined();
    expect(env.ZCODE_NO_PROXY).toBeUndefined();
  });

  it("shortens stream idle recovery only for BG25 and I55 replay workers", () => {
    expect(
      resolveE2EWorkerModelStreamIdleTimeoutMs([
        "./test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts",
      ]),
    ).toBe(10_000);
    expect(
      resolveE2EWorkerModelStreamIdleTimeoutMs([
        "./test/e2e/conversation-session/models/conversation-session-thought-level-session-isolation.test.ts",
      ]),
    ).toBe(10_000);
    expect(
      resolveE2EWorkerModelStreamIdleTimeoutMs([
        "./test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts",
      ]),
    ).toBeUndefined();
    expect(
      resolveE2EWorkerModelStreamIdleTimeoutMs(["./test/e2e/conversation-session/smoke.test.ts"]),
    ).toBeUndefined();
  });

  it("assigns each worker a separate Chromium profile and replaces stale profile args", () => {
    const rootDir = "/tmp/zcode-e2e/chromium-profiles";
    const firstProfile = resolveE2EWorkerChromiumProfileDir(rootDir, "0-1");
    const secondProfile = resolveE2EWorkerChromiumProfileDir(rootDir, "0/2");

    expect(firstProfile).not.toBe(secondProfile);
    expect(secondProfile).toBe(resolve(rootDir, "0-2"));
    expect(
      replaceChromeUserDataDirArg(
        ["--no-sandbox", "--user-data-dir=/tmp/stale-profile"],
        firstProfile,
      ),
    ).toEqual(["--no-sandbox", `--user-data-dir=${firstProfile}`]);
  });
});
