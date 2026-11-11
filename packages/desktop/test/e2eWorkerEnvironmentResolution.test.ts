import { describe, expect, it } from "vitest";

import {
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
});
