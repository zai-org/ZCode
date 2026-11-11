// BPR01/BPR02：Bash 项目始终允许使用 AST command prefix，而不是完整命令字符串。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  approveV4PermissionAlways,
  getV4PaneSnapshot,
  getV4PermissionRuleScopes,
  hasV4PermissionDialog,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const BPR_PROJECT_DIR = resolveE2ERuntimePath(
  "conversation-session-v4-bash-command-prefix-permission",
);

describe("v4 Bash command prefix 项目权限", () => {
  before(async () => {
    // beforeSession 已在 case 目录安装 pnpm shim；这里只补 package fixture，不能整目录删除。
    await mkdir(BPR_PROJECT_DIR, { recursive: true });
    await writeFile(
      join(BPR_PROJECT_DIR, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          lint: "node -e \"console.log('lint-ok')\"",
          test: "node -e \"console.log('test-ok')\"",
        },
      }),
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(BPR_PROJECT_DIR, { recursive: true, force: true });
  });

  it("展示并持久化 script prefix；同 script 复用，sibling script 继续询问", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_BPR_PREFIX_FIRST 执行 lint 脚本");
    await waitForV4PermissionDialog();
    const firstScopes = await getV4PermissionRuleScopes();
    expect(firstScopes).toHaveLength(1);
    expect(firstScopes[0]?.kind).toBe("prefix");
    expect(firstScopes[0]?.text).toContain("pnpm run lint …");
    expect(await approveV4PermissionAlways()).toBe(true);
    await waitForV4TimelineContaining("E2E_BPR_PREFIX_FIRST_DONE", 60000);

    let sameScriptPrompted = false;
    await sendV4Prompt("E2E_BPR_PREFIX_SAME 同一脚本使用不同参数");
    await browser.waitUntil(
      async () => {
        sameScriptPrompted ||= await hasV4PermissionDialog();
        return (await getV4PaneSnapshot()).timelineText.includes("E2E_BPR_PREFIX_SAME_DONE");
      },
      { timeout: 60000, timeoutMsg: "同 script 不同参数没有自动执行并收口" },
    );
    expect(sameScriptPrompted).toBe(false);

    await sendV4Prompt("E2E_BPR_PREFIX_SIBLING 执行 sibling test 脚本");
    await waitForV4PermissionDialog();
    const siblingScopes = await getV4PermissionRuleScopes();
    expect(siblingScopes[0]?.kind).toBe("prefix");
    expect(siblingScopes[0]?.text).toContain("pnpm run test …");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_BPR_PREFIX_SIBLING_DONE", 60000);
  });
});
