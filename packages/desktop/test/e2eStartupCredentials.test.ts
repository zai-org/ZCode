import { describe, expect, it } from "vitest";
import { createE2EStartupCredentialSeed } from "#e2e/helpers/e2e-startup-credentials";

const restoredOAuthCredentials = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "fake-access-token",
  "oauth:zai:user_info": "{}",
  zcodejwttoken: "fake-zcode-jwt",
};

describe("desktop e2e startup credentials", () => {
  it.each([
    undefined,
    [],
    ["./test/e2e/**/*.test.ts"],
    ["/repo/packages/desktop/test/e2e/new-unregistered-feature.test.ts"],
    ["C:\\repo\\packages\\desktop\\test\\e2e\\new-unregistered-feature.test.ts"],
    ["/repo/packages/desktop/test/e2e/browser/design/browser-human-viewport-preference.test.ts"],
    ["/repo/packages/desktop/test/e2e/browser/permissions/browser-permission-prompt.test.ts"],
  ])("未声明账号 fixture 时默认无账号：%j", (specs) => {
    expect(
      createE2EStartupCredentialSeed({
        specs,
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it("显式账号 mock 保留 OAuth，不自动注入 JWT，也不修改输入", () => {
    const fixture = Object.freeze({ ...restoredOAuthCredentials });
    expect(
      createE2EStartupCredentialSeed({
        specs: ["coding-plan-team-usage.test.ts"],
        accountMock: true,
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials: fixture,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "fake-access-token",
      "oauth:zai:user_info": "{}",
    });
    expect(fixture.zcodejwttoken).toBe("fake-zcode-jwt");
  });

  it("远程回放优先保持匿名，不采用本地账号 mock", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["provider-family-responsive.test.ts"],
        remoteProfile: true,
        accountMock: true,
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });
  it.each([
    "automations-custom-monthly-interval.test.ts",
    "automations-custom-yearly-schedule.test.ts",
    "automations-workflows-hub.test.ts",
  ])("本地自动化 spec %s 不播种会遮挡表单的假账号", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it("侧栏关闭与恢复不播种会遮挡交互的假账号身份", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["/repo/packages/desktop/test/e2e/ui-shell/panels/side-pane-scope.test.ts"],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });
  it("远程 runner 的 Personal Provider 回放不播种会访问真实控制面的假身份", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["conversation-session-r3-ack-loss.test.ts"],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
        remoteProfile: true,
      }),
    ).toEqual({});
  });
  it.each([
    "conversation-session-r3-live-bigmodel-team.test.ts",
    "conversation-session-share-ssh-artifact.test.ts",
  ])("真实账号导入 spec %s 不混入默认假 OAuth 身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          `/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/${spec}`,
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });
  it.each([
    "conversation-session-offpeak-subagent-model-inheritance.test.ts",
    "conversation-session-off-peak-invalid-ticket.test.ts",
    "conversation-session-off-peak-team-plan.test.ts",
    "coding-plan-upgrade-webview-refresh-provider.test.ts",
    "marketing-touch-rewards.test.ts",
  ])("%s 保留本地 Start 余额/请求鉴权所需 JWT", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [spec],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }).zcodejwttoken,
    ).toBe("fake-zcode-jwt");
  });
  it("供应商响应式 spec 保留本地 balance mock 所需的 JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/settings/providers/provider-family-responsive.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }).zcodejwttoken,
    ).toBe("fake-zcode-jwt");
  });
  it("纯 Provider 冷恢复 spec 不播种会访问账号控制面的假登录态", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/runtime/conversation-session-unbound-resume.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-preview-image-actions.test.ts",
    "conversation-session-v4-composer-toolbar.test.ts",
    "conversation-session-draft-model-switch-first-send.test.ts",
    "conversation-session-composer-draft-switching.test.ts",
    "conversation-session-ssh-provisioning-failure.test.ts",
    "conversation-session-local-conversation-identity.test.ts",
    "conversation-session-empty-completion-retry.test.ts",
    "command-center-focus.test.ts",
    "project-native-directory-picker.test.ts",
    "shortcut-settings-key-search.test.ts",
    "shortcut-settings-rebind.test.ts",
    "conversation-session-settings-connection-completion.test.ts",
    "conversation-session-project-device-selection.test.ts",
    "conversation-session-project-settings-return.test.ts",
    "conversation-session-background-connection.test.ts",
    "conversation-session-remote-project-handoff.test.ts",
    "conversation-session-web-remote-project-directory.test.ts",
    "conversation-session-web-remote-unread.test.ts",

    "conversation-session-existing-remote-project.test.ts",
    "conversation-session-chat-device-return.test.ts",
  ])("本地交互 spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-automation-cron-create.test.ts",
    "conversation-session-fork-merged-assistant.test.ts",
    "conversation-session-goal-run-cases.test.ts",
    "conversation-session-running-guide-steer.test.ts",
    "conversation-session-tool-cross-product.test.ts",
    "conversation-session-assistant-preview-cards.test.ts",
    "conversation-session-v4-fork-edit-branch.test.ts",
  ])("fork/goal/tool spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it("普通会话 spec 不注入 OAuth 展示态或 JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/queue/conversation-session-v4-sendnow.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it("JWT 401 自动退出专项 spec 保留完整 restored OAuth fixture", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["/repo/packages/desktop/test/e2e/auth-config/session/jwt-401-auto-logout.test.ts"],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      ...restoredOAuthCredentials,
    });
  });

  it("Start Plan 手动领取 spec 保留调用 claim API 所需的 zcode JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/ui-shell/marketing/marketing-touch-entitlement.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      ...restoredOAuthCredentials,
    });
  });

  it("分享浮窗交互具备本地 mock 账号态", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "./test/e2e/conversation-session/sharing/conversation-session-share-popover.test.ts",
        ],
        legacyAuthToken: "legacy",
        restoredOAuthCredentials: { zcodejwttoken: "local-only" },
      }).zcodejwttoken,
    ).toBe("local-only");
  });
});
