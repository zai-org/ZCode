// 统一 runner 与旧手工入口均使用隔离 HOME；不能因 runId 前缀不同拒绝安全夹具。
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { basename, join } from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

describe("虚拟项目多目录冷恢复", () => {
  after(async () => {
    const capture = process.env.E2E_PROVIDER_CAPTURE_PATH;
    if (capture)
      await copyFile(capture, join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP16-network.json"));
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP16-final.png"));
    await clearAppData();
  });
  it("VP16：运行实例保持旧 roots，完整进程重建才采用新 roots，cwd 与主目录配置链不变", async function () {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const home = process.env.ZCODE_E2E_HOME_DIR!;
    if (
      !home ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(home).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const roots = ["A", "B", "C"].map((name) => join(home, `E2E_VP16_${name}`));
    for (const [i, root] of roots.entries()) {
      const name = ["A", "B", "C"][i];
      await mkdir(join(root, ".agents", "skills", "probe"), { recursive: true });
      await mkdir(join(root, ".zcode", "agents"), { recursive: true });
      await writeFile(
        join(root, ".agents", "skills", "probe", "SKILL.md"),
        `---\nname: probe\ndescription: E2E_VP16_SKILL_${name}\n---\nFixture skill.\n`,
      );
      await writeFile(
        join(root, ".zcode", "agents", "review.md"),
        `---\nname: review\ndescription: E2E_VP16_SUBAGENT_${name}\n---\nFixture agent.\n`,
      );
      await writeFile(
        join(root, "AGENTS.md"),
        `This workspace carries marker E2E_VP16_INSTRUCTIONS_${name}.\n`,
      );
    }
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP16_PROJECT");
    for (const root of roots.slice(0, 2)) {
      await chooseProjectRoot(root);
    }
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const project = $('[data-project-name="E2E_VP16_PROJECT"]');
    await project.waitForDisplayed();
    await project.$('[data-testid="virtual-project-create-task"]').click();
    const readTask = () =>
      browser.execute((cwd) => {
        const store = (
          window as Window & {
            __zcodeSessionStoreE2E?: {
              getState(): { getWorkspaceState(path: string): { activeTaskId: string | null } };
            };
          }
        ).__zcodeSessionStoreE2E;
        return store?.getState().getWorkspaceState(cwd).activeTaskId ?? null;
      }, roots[0]!);
    const inspect = async (phase: string, expectedExtra: "B" | "C") => {
      const marker = `E2E_VP16_${phase}`;
      await setInputValueByTestIdDom(
        TID_V4_COMPOSER_INPUT,
        `${marker}: Reply with ${marker}_READY.`,
      );
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
      await $(`//*[normalize-space(.)="${marker}_READY" and not(*)]`).waitForDisplayed({
        timeout: 60_000,
      });
      const capture = await waitForUpstreamNetworkCapture(marker);
      const body = JSON.stringify(capture.requestJson);
      const wire = (text: string) => JSON.stringify(text).slice(1, -1);
      // 首个完整环境块列出本次运行的附加目录 B；冷恢复后原块不改写（保持缓存前缀），
      // 只追加目录增量。
      expect(body).toContain(wire(` - Primary working directory: ${roots[0]}\n`));
      expect(body).toContain(wire(` - Additional working directories:\n  - ${roots[1]}\n`));
      if (expectedExtra === "B") {
        expect(body).not.toContain("Additional working directories added");
      } else {
        expect(body).toContain(
          wire(
            `# Environment update\n - Additional working directories added:\n  - ${roots[2]}\n - Additional working directories removed:\n  - ${roots[1]}`,
          ),
        );
      }
      expect(body).toContain("E2E_VP16_SKILL_A");
      expect(body).toContain(`E2E_VP16_SKILL_${expectedExtra}`);
      expect(body).toContain("E2E_VP16_SUBAGENT_A");
      expect(body).toContain(`E2E_VP16_SUBAGENT_${expectedExtra}`);
      expect(body).toContain("E2E_VP16_INSTRUCTIONS_A");
      expect(body).not.toContain("E2E_VP16_INSTRUCTIONS_B");
      expect(body).not.toContain("E2E_VP16_INSTRUCTIONS_C");
      expect(body).not.toContain(`E2E_VP16_SKILL_${expectedExtra === "B" ? "C" : "B"}`);
      expect(body).not.toContain(`E2E_VP16_SUBAGENT_${expectedExtra === "B" ? "C" : "B"}`);
      process.stderr.write(
        `VP16 ${phase}: actual model request includes A+${expectedExtra} capabilities and only A instructions\n`,
      );
    };
    await inspect("CREATE", "B");
    const taskId = await readTask();
    expect(taskId).toBeTruthy();
    await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
    await $('[data-testid="virtual-project-edit"]').click();
    const removed = $(`[role="dialog"] span[title="${roots[1]}"]`);
    await removed.parentElement().$('[data-testid="virtual-project-remove-folder"]').click();
    await chooseProjectRoot(roots[2]!);
    await $('[data-testid="virtual-project-save"]').click();
    await inspect("LIVE", "B");
    expect(await readTask()).toBe(taskId);
    // 既有 helper 等待旧 Electron/Host/CLI 整棵进程树退出；renderer reload 不能代替此边界。
    await restartIntoWorkspacePreservingProfile(roots[0]!);
    await $('[data-project-name="E2E_VP16_PROJECT"]').waitForDisplayed();
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskId!)}"]`).click();
    await inspect("COLD", "C");
    expect(await readTask()).toBe(taskId);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP16-cold-roots.png"));
  });
});

async function openLocalProjectEditor() {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function chooseProjectRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}
