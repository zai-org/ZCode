import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { resolveE2ERuntimePath, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const FIRST = "E2E_LOP_ENV_BEFORE";
const NEXT = "E2E_LOP_ENV_CONTINUE";

describe("预装工具无发布目标的环境（待审核）", () => {
  it("LOP-17/30: 无目标仍注入固定入口目录，既有会话提供桌面引导", async function () {
    this.timeout(120000);
    const directory = resolveE2ERuntimePath("conversation-session-preinstalled-tools-env");
    await mkdir(directory, { recursive: true });
    await cp(
      new URL(
        "../../../fixtures/fs/conversation-session/conversation-session-preinstalled-tools-env/probe.mjs",
        import.meta.url,
      ),
      join(directory, "probe.mjs"),
    );
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        storageRoot: resolveE2EStorageRoot(),
        python: process.env.ZCODE_E2E_DOCUMENT_PYTHON || "python3",
      }),
    );
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    const observations = [];
    let sessionId: string | null = null;
    for (const [marker, tool] of [
      [FIRST, "toolu_lop_env_before"],
      [NEXT, "toolu_lop_env_continue"],
    ]) {
      await sendV4Prompt(
        `${marker}: Run the exact read-only preinstalled-tools environment probe.`,
      );
      try {
        await waitForV4AssistantMessageContaining(`${marker}_DONE`, 90000);
      } catch (error) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-env-failure-state.json"),
          JSON.stringify({ snapshot: await getV4PaneSnapshot(), text: await $("body").getText() }),
        );
        await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-env-failure.png`);
        throw error;
      }
      await waitForV4ConversationState((state) => state.state === "idle", "环境探测未结束");
      const result = await getLatestUpstreamToolResultByToolCallId(tool!);
      expect(result?.isError).toBe(false);
      const observed = JSON.parse(result!.content);
      expect(observed.available).toBe("1");
      expect(observed.pathFirst).toBe(observed.binDir);
      expect([0, 69]).toContain(observed.exitCode);
      if (observed.exitCode !== 0) expect(observed.stdout + observed.stderr).toContain("预装工具");
      if (observed.exitCode === 0) expect(JSON.parse(observed.stdout).source).toBe("system");
      else expect(observed.stdout + observed.stderr).toContain("env_setup/setup.md");
      const current = (await getV4PaneSnapshot()).sessionId;
      if (sessionId) expect(current).toBe(sessionId);
      sessionId = current;
      observations.push(observed);
    }
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-no-target-environment.json"),
      JSON.stringify(observations),
    );
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-env-continued.png`);
  });
});
