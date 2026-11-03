import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mapClientScenesToDraftSuggestedPromptItems } from "@/v4/draftSuggestedPromptItems.js";
import { prepareWebRemoteControlAuthGateFixture } from "#e2e/helpers/web-remote-control-auth-gate-fixture";

it("keeps cached-account business requests inside the auth-gate fixture and restores its environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-auth-fixture-"));
  const credentialsFile = join(root, "credentials.json");
  const settingsFile = join(root, "setting.json");
  const previous = process.env.ZAI_BUSINESS_BASE_URL;
  process.env.ZAI_BUSINESS_BASE_URL = "https://business.example.invalid";
  let close: (() => Promise<void>) | null = null;
  try {
    await writeFile(settingsFile, "{}");
    close = await prepareWebRemoteControlAuthGateFixture({
      specs: ["web-remote-control-auth-gate.test.ts"],
      credentialsFile,
      settingsFile,
      workspacePath: root,
    });
    expect(close).not.toBeNull();
    expect(process.env.ZAI_BUSINESS_BASE_URL).toBe(process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL);
    await close!();
    close = null;
    expect(process.env.ZAI_BUSINESS_BASE_URL).toBe("https://business.example.invalid");
  } finally {
    await close?.();
    if (previous === undefined) delete process.env.ZAI_BUSINESS_BASE_URL;
    else process.env.ZAI_BUSINESS_BASE_URL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "command-center-history-search.test.ts",
  "conversation-session-virtual-project-mobile.test.ts",
  "conversation-session-composer-settlement.test.ts",
  "conversation-session-new-task-missing-root-mobile.test.ts",
  "conversation-session-web-remote-project-directory.test.ts",
  "conversation-session-remote-draft-prewarm.test.ts",
  "conversation-session-web-remote-unread.test.ts",
  "conversation-session-web-remote-terminal.test.ts",
  "conversation-session-workspace-mcp-trust.test.ts",
  "conversation-session-id-compatibility.test.ts",
])(
  "provides %s with an isolated authenticated relay and the current Web frontend",
  async (spec) => {
    const root = await mkdtemp(join(tmpdir(), "remote-mobile-fixture-"));
    const credentialsFile = join(root, "credentials.json");
    const settingsFile = join(root, "setting.json");
    const previousUrl = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    const previousForceColor = process.env.FORCE_COLOR;
    // wdio CLI 会给 worker 注入 FORCE_COLOR（非 TTY 为 "0"，TTY 为 "1"），fixture 必须在该环境下识别 Web 就绪。
    process.env.FORCE_COLOR = "0";
    let close: (() => Promise<void>) | null = null;
    try {
      await writeFile(settingsFile, "{}");
      close = await prepareWebRemoteControlAuthGateFixture({
        specs: [spec],
        credentialsFile,
        settingsFile,
        workspacePath: root,
        webUrl: "http://127.0.0.1:0/remote/v4",
      });
      expect(close).not.toBeNull();
      const webUrl = new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!);
      expect(webUrl.hostname).toBe("127.0.0.1");
      expect(Number(webUrl.port)).toBeGreaterThan(0);
      expect(webUrl.pathname).toBe("/remote/v4");
      const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL!;
      expect(new URL(origin).hostname).toBe("127.0.0.1");
      expect(process.env.ZAI_BUSINESS_BASE_URL).toBe(origin);
      const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
      expect(credentials["oauth:active_provider"]).toBe("zai");
      const token = await fetch(new URL("/api/v1/remote/token", origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.zcodejwttoken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "terminal" }),
      });
      expect(token.status).toBe(200);
      expect((await token.json()).data.token).toEqual(expect.any(String));
      const scenes = await (await fetch(new URL("/api/v1/client/scenes", origin))).json();
      expect(mapClientScenesToDraftSuggestedPromptItems(scenes.data)).toEqual([]);
      await close!();
      close = null;
      expect(process.env.ZCODE_WEB_REMOTE_CONTROL_URL).toBe(previousUrl);
      await expect(fetch(new URL("/api/v1/remote/device", origin))).rejects.toThrow();
    } finally {
      await close?.();
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
      await rm(root, { recursive: true, force: true });
    }
  },
);
