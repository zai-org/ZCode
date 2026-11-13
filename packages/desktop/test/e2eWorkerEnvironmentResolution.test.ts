import { describe, expect, it } from "vitest";

import {
  isNativeKeychainCredentialSpec,
  resolveAskUserQuestionClockScaleForWorker,
  resolveE2ECredentialSecret,
} from "./e2e/helpers/e2e-worker-environment.js";

describe("E2E worker environment resolution", () => {
  it("injects the accelerated clock only for the auto-resolution case", () => {
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        specs: [
          "./test/e2e/conversation-session/permissions/conversation-session-ask-user-question-auto-resolution-setting.test.ts",
        ],
      }),
    ).toBe("20");
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        specs: ["./test/e2e/conversation-session/editing/conversation-session-v4-edit.test.ts"],
      }),
    ).toBeUndefined();
  });

  it("preserves an explicitly requested valid clock scale", () => {
    expect(
      resolveAskUserQuestionClockScaleForWorker({
        requestedScale: "25",
        specs: [
          "./test/e2e/conversation-session/permissions/conversation-session-ask-user-question-auto-resolution-setting.test.ts",
        ],
      }),
    ).toBe("25");
  });
});

it("keeps synthetic credential tests independent from OS keychain availability", () => {
  expect(resolveE2ECredentialSecret([], undefined)).toBe("e2e-credential-storage");
  expect(resolveE2ECredentialSecret([], "custom-fixture")).toBe("custom-fixture");
  expect(
    resolveE2ECredentialSecret(
      ["/auth-config/credentials/manual-review/pending/system-credential-storage.test.ts"],
      undefined,
    ),
  ).toBeUndefined();
  // 数据存储路径切换后的密钥登记只在真实系统库上有意义，同样不能注入托管密钥。
  expect(
    resolveE2ECredentialSecret(
      ["/auth-config/credentials/manual-review/pending/system-credential-data-root.test.ts"],
      undefined,
    ),
  ).toBeUndefined();
});

it("prepares the macOS keychain link only for native credential storage specs", () => {
  const pending = "/auth-config/credentials/manual-review/pending";
  expect(isNativeKeychainCredentialSpec(`${pending}/system-credential-storage.test.ts`)).toBe(true);
  expect(isNativeKeychainCredentialSpec(`${pending}/system-credential-data-root.test.ts`)).toBe(
    true,
  );
  expect(isNativeKeychainCredentialSpec(`${pending}\\system-credential-data-root.test.ts`)).toBe(
    true,
  );
  // owner 专项使用原生 API 边界替身，不访问开发者钥匙串。
  expect(isNativeKeychainCredentialSpec(`${pending}/system-credential-owner.test.ts`)).toBe(false);
  expect(isNativeKeychainCredentialSpec("/auth-config/login/oauth-completion-race.test.ts")).toBe(
    false,
  );
});
