import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  readRemoteContainerFile,
  readRemoteDockerContainer,
  remoteContainerPathExists,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-04：设置 → 数据同步 → 设备 → 推送技能（docs/remote/data-sync.md）。
// 远端为本机 Docker runner（或服务器队列）提供的真实 Linux 容器；远端断言用 docker exec 读容器内 ~/.zcode。
const CASE_MARKER = "E2E_DSYNC_04_SKILL_PUSH";
const NEW_SKILL = "e2e-dsync-new";
const DIFF_SKILL = "e2e-dsync-diff";
const REMOTE_SKILLS = "/home/dev/.zcode/skills";
const BATCH_OK_SKILL = "e2e-dsync-batch-a";
const BATCH_FAIL_SKILL = "e2e-dsync-batch-b";
// 技能每批不超过 20MB：小技能 + 接近 20MB 的技能超过上限，分成两批。第二批含不可读文件，在本机导出时
// 就失败，不需要传输大归档。
const BATCH_FAIL_PAYLOAD_BYTES = 20 * 1024 * 1024 - 1024;
const LOCAL_MARKER = `${CASE_MARKER}_LOCAL`;
const REMOTE_MARKER = `${CASE_MARKER}_REMOTE`;
// DSYNC-04-03：嵌套技能。子技能名称按字母排在父技能前面，弹窗默认顺序里子技能先导入。
const NESTED_DIR = "e2e-dsync-nest";
const NESTED_PARENT = "e2e-dsync-nest-parent";
const NESTED_CHILD = "e2e-dsync-nest-child";
const NESTED_MARKER = `${CASE_MARKER}_NESTED`;
// DSYNC-04-05：从数据同步页打开、最小化后在技能设置页推送；设置页列表随推送结果刷新。
const REFRESH_SKILL = "e2e-dsync-refresh";
const REMOTE_ONLY_SKILL = "e2e-dsync-remote-only";

function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} for data sync e2e\n---\n${body}\n`;
}

async function writeLocalSkill(name: string, body: string): Promise<void> {
  const dir = join(getE2EAppDataPaths().homeDir, ".zcode", "skills", name);
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMarkdown(name, body));
  await writeFile(join(dir, "references", "note.md"), `${body} reference\n`);
}

/** 在本机技能根下按相对目录写技能（目录名可以与 name 不同，例如嵌套技能）。 */
async function writeLocalSkillAt(directoryName: string, name: string, body: string) {
  const dir = join(getE2EAppDataPaths().homeDir, ".zcode", "skills", ...directoryName.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMarkdown(name, body));
}

/** 从设置页任意位置打开在线设备的数据同步弹窗并切到技能分类。 */
async function openDeviceSkills(): Promise<void> {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
  });
  await waitForTestIdByDom("remote-sync-device-list", {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
  });
  await clickTestIdByDom("remote-sync-device-action");
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
  await clickTestIdByDom("remote-sync-tab-skills");
}

async function readRowState(key: string) {
  return await browser.execute((rowTestId) => {
    const row = document.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
    return row
      ? {
          status: row.dataset.syncStatus ?? null,
          checked: row.getAttribute("aria-checked"),
          disabled: row.disabled,
          text: row.textContent ?? "",
        }
      : null;
  }, `remote-sync-row-${key}`);
}

async function waitForRowStatus(key: string, status: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readRowState(key))?.status === status, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
  return (await readRowState(key))!;
}

async function readButtonText(buttonTestId: string): Promise<string> {
  return await browser.execute(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? "",
    buttonTestId,
  );
}

/** 设置页三个分区共用插件容器且 forceMount；只看当前可见的技能名。 */
async function isSkillNameVisible(name: string): Promise<boolean> {
  return await browser.execute(
    (skillName) =>
      Array.from(document.querySelectorAll("span")).some(
        (element) =>
          element.textContent?.trim() === skillName && element.getClientRects().length > 0,
      ),
    name,
  );
}

async function pushSkillsAndWait(): Promise<void> {
  await clickTestIdByDom("remote-sync-push", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 推送技能按钮不可用`,
  });
  await browser.waitUntil(async () => (await readButtonText("remote-sync-push")) === "再次同步", {
    timeout: 120_000,
    timeoutMsg: `${CASE_MARKER}: 推送技能没有完成`,
  });
}

/** 深浅主题 × 中英文 × 宽 / 窄窗口截图，供人工复核标签可读性和窄窗口横向标签。 */
async function captureDialogScreenshots(): Promise<void> {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) return;
  const dir = resolve(artifactDir, "dsync-04");
  await mkdir(dir, { recursive: true });
  for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["light", "dark"]) {
      await browser.execute(
        (language, color) => {
          const actions = (
            window as Window & {
              __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
            }
          ).__testActions;
          actions?.setLocale(language);
          actions?.setTheme(color);
        },
        locale,
        theme,
      );
      for (const width of [1440, 700]) {
        await browser.electron.execute((electron, size) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(size, 900);
        }, width);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        await browser.saveScreenshot(join(dir, `skills-${locale}-${theme}-${width}.png`));
      }
    }
  }
  await browser.execute(() => {
    const actions = (
      window as Window & {
        __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
      }
    ).__testActions;
    actions?.setLocale("zh-CN");
    actions?.setTheme("light");
  });
  await browser.electron.execute((electron) => {
    electron.BrowserWindow.getAllWindows()
      .find((window) => window.isVisible())
      ?.setSize(1440, 900);
  });
}

describe(`${CASE_MARKER}: 数据同步页推送技能`, () => {
  /** 本 spec 内已连接远端：后续用例复用同一连接；单独运行某个用例时自行连接。 */
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    connected = true;
  }

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-04-01/02 推送新技能写入远端；远端不同内容默认不覆盖，手动勾选后才覆盖", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await writeLocalSkill(NEW_SKILL, LOCAL_MARKER);
    await writeLocalSkill(DIFF_SKILL, LOCAL_MARKER);
    await writeRemoteContainerFile(
      container,
      `${REMOTE_SKILLS}/${DIFF_SKILL}/SKILL.md`,
      skillMarkdown(DIFF_SKILL, REMOTE_MARKER),
    );

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    connected = true;

    // 设置 → 数据与统计 → 数据同步（分组第一项）→ 在线设备行。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
    });
    await waitForTestIdByDom("remote-sync-device-list", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
    });
    const deviceRow = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-testid="remote-sync-device-list"] [data-source-server-id]',
      );
      return {
        text: row?.textContent ?? "",
        count: document.querySelectorAll("[data-source-server-id]").length,
      };
    });
    expect(deviceRow.count).toBe(1);
    expect(deviceRow.text).toContain("SSH");
    expect(deviceRow.text).toContain("尚未同步");

    await clickTestIdByDom("remote-sync-device-action");
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
    expect(await $('[data-testid="remote-sync-tab-sessions"]').isExisting()).toBe(false);
    expect(await $('[data-testid="remote-sync-tab-memory"]').isExisting()).toBe(false);
    expect(await $('[data-testid="remote-sync-direction"]').isExisting()).toBe(false);

    await clickTestIdByDom("remote-sync-tab-skills");
    const newRow = await waitForRowStatus(NEW_SKILL, "push", "新技能没有显示为「推送」");
    expect(newRow.checked).toBe("true");
    const diffRow = await waitForRowStatus(DIFF_SKILL, "difference", "不同内容没有显示为「差异」");
    expect(diffRow.checked).toBe("false");
    expect(diffRow.text).toContain("内容不同");

    // 最小化只收起模态层；离开数据同步页再从设备入口恢复，仍是原分类与原选择。
    await clickTestIdByDom("remote-sync-minimize");
    await waitForTestIdByDom("remote-sync-minimized");
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"));
    await clickTestIdByDom("remote-sync-device-action");
    await waitForTestIdByDom("remote-sync-dialog");
    expect(await $('[data-testid="remote-sync-tab-skills"]').getAttribute("aria-current")).toBe(
      "page",
    );
    expect((await readRowState(NEW_SKILL))?.checked).toBe("true");
    expect((await readRowState(DIFF_SKILL))?.checked).toBe("false");

    // DSYNC-04-01：默认只推送新技能，远端已有的不同内容保持不变。
    await pushSkillsAndWait();
    await waitForRowStatus(NEW_SKILL, "synced", "推送后新技能没有变为「已同步」");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${NEW_SKILL}/SKILL.md`),
    ).toContain(LOCAL_MARKER);
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${NEW_SKILL}/references/note.md`),
    ).toContain(LOCAL_MARKER);
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${DIFF_SKILL}/SKILL.md`),
    ).toContain(REMOTE_MARKER);

    await captureDialogScreenshots();

    // DSYNC-04-02：手动勾选黄色「差异」项后才覆盖远端。
    await clickTestIdByDom(`remote-sync-row-${DIFF_SKILL}`);
    expect((await readRowState(DIFF_SKILL))?.checked).toBe("true");
    await pushSkillsAndWait();
    await waitForRowStatus(DIFF_SKILL, "synced", "覆盖后差异项没有变为「已同步」");
    const overwritten = await readRemoteContainerFile(
      container,
      `${REMOTE_SKILLS}/${DIFF_SKILL}/SKILL.md`,
    );
    expect(overwritten).toContain(LOCAL_MARKER);
    expect(overwritten).not.toContain(REMOTE_MARKER);
    expect(
      await remoteContainerPathExists(
        container,
        `${REMOTE_SKILLS}/${DIFF_SKILL}/references/note.md`,
      ),
    ).toBe(true);

    // 推送结果写回设备同步状态，设备行随即更新。
    await clickTestIdByDom("remote-sync-tab-overview");
    await clickTestIdByDom("remote-sync-close");
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          (
            document.querySelector('[data-testid="remote-sync-device-status"]')?.textContent ?? ""
          ).includes("已同步"),
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设备行没有显示上次同步时间` },
    );
  });

  it("DSYNC-04-03 父子技能同时推送到空远端：两个技能都写入，两行都变为「已同步」", async function () {
    this.timeout(20 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    // 来源嵌套：父技能目录里还有一个独立的子技能；远端没有这两个技能。
    await writeLocalSkillAt(NESTED_DIR, NESTED_PARENT, `${NESTED_MARKER} parent`);
    await writeLocalSkillAt(`${NESTED_DIR}/child`, NESTED_CHILD, `${NESTED_MARKER} child`);
    expect(await remoteContainerPathExists(container, `${REMOTE_SKILLS}/${NESTED_DIR}`)).toBe(
      false,
    );

    await ensureConnected();
    await openDeviceSkills();
    const childRow = await waitForRowStatus(NESTED_CHILD, "push", "子技能没有显示为「推送」");
    const parentRow = await waitForRowStatus(NESTED_PARENT, "push", "父技能没有显示为「推送」");
    expect(childRow.checked).toBe("true");
    expect(parentRow.checked).toBe("true");

    await pushSkillsAndWait();
    await waitForRowStatus(NESTED_PARENT, "synced", "推送后父技能没有变为「已同步」");
    await waitForRowStatus(NESTED_CHILD, "synced", "推送后子技能没有变为「已同步」");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${NESTED_DIR}/SKILL.md`),
    ).toContain(`${NESTED_MARKER} parent`);
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${NESTED_DIR}/child/SKILL.md`),
    ).toContain(`${NESTED_MARKER} child`);
    expect(await $('[data-testid="remote-sync-failure-summary"]').isExisting()).toBe(false);

    // 关闭按钮在概览页底部。
    await clickTestIdByDom("remote-sync-tab-overview");
    await clickTestIdByDom("remote-sync-close");
  });

  it("DSYNC-04-04 后一批导出失败时，前一批照常写入并显示「已同步」，只有失败批的项标为失败", async function () {
    this.timeout(15 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    // 接续 DSYNC-04-01/02：仍在数据同步页，设备在线。第二个技能含一个不可读文件，导出时本机读取失败。
    await writeLocalSkill(BATCH_OK_SKILL, LOCAL_MARKER);
    await writeLocalSkill(BATCH_FAIL_SKILL, LOCAL_MARKER);
    const skillsRoot = join(getE2EAppDataPaths().homeDir, ".zcode", "skills");
    await writeFile(join(skillsRoot, BATCH_OK_SKILL, "payload.bin"), randomBytes(4096));
    const unreadable = join(skillsRoot, BATCH_FAIL_SKILL, "payload.bin");
    await writeFile(unreadable, Buffer.alloc(BATCH_FAIL_PAYLOAD_BYTES));
    await chmod(unreadable, 0o000);
    try {
      await clickTestIdByDom("remote-sync-device-action");
      await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
      await clickTestIdByDom("remote-sync-tab-skills");
      expect(
        (await waitForRowStatus(BATCH_OK_SKILL, "push", "第一批技能没有显示为「推送」")).checked,
      ).toBe("true");
      expect(
        (await waitForRowStatus(BATCH_FAIL_SKILL, "push", "第二批技能没有显示为「推送」")).checked,
      ).toBe("true");

      await clickTestIdByDom("remote-sync-push", {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 推送技能按钮不可用`,
      });
      // 第一批已写入远端：推送后刷新列表，该行变「已同步」；只有第二批的项显示失败原因。
      await waitForRowStatus(BATCH_OK_SKILL, "synced", "前一批写入的技能没有变为「已同步」");
      await browser.waitUntil(
        async () => (await readRowState(BATCH_FAIL_SKILL))?.text.includes("同步失败") ?? false,
        { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 失败批的技能没有显示失败原因` },
      );
      const summary = await browser.execute(
        () =>
          document.querySelector('[data-testid="remote-sync-failure-summary"]')?.textContent ?? "",
      );
      expect(summary).toContain("1 项失败");
      expect(await $('[data-testid="remote-sync-push-error"]').isExisting()).toBe(false);
      expect(
        await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${BATCH_OK_SKILL}/SKILL.md`),
      ).toContain(LOCAL_MARKER);
      expect(
        await remoteContainerPathExists(container, `${REMOTE_SKILLS}/${BATCH_FAIL_SKILL}`),
      ).toBe(false);
      await clickTestIdByDom("remote-sync-tab-overview");
      await clickTestIdByDom("remote-sync-close");
    } finally {
      await chmod(unreadable, 0o644);
    }
  });

  it("DSYNC-04-05 最小化后切到技能设置页，从状态条恢复并推送：技能设置页列表随推送结果刷新", async function () {
    this.timeout(15 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    await writeLocalSkill(REFRESH_SKILL, LOCAL_MARKER);
    await writeRemoteContainerFile(
      container,
      `${REMOTE_SKILLS}/${REMOTE_ONLY_SKILL}/SKILL.md`,
      skillMarkdown(REMOTE_ONLY_SKILL, REMOTE_MARKER),
    );

    await ensureConnected();
    // 从数据同步页打开：该入口不带页面刷新回调。只勾选新技能，避免推送前序用例留下的大技能。
    await openDeviceSkills();
    await waitForRowStatus(REFRESH_SKILL, "push", "新技能没有显示为「推送」");
    await clickTestIdByDom("remote-sync-clear");
    await clickTestIdByDom(`remote-sync-row-${REFRESH_SKILL}`);
    expect((await readRowState(REFRESH_SKILL))?.checked).toBe("true");
    await clickTestIdByDom("remote-sync-minimize");
    await waitForTestIdByDom("remote-sync-minimized");

    // 技能设置页读取远端用户 Scope：显示远端独有技能，还没有待推送的新技能。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "skill"), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有技能分区`,
    });
    await browser.waitUntil(() => isSkillNameVisible(REMOTE_ONLY_SKILL), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 技能设置页没有显示远端独有技能，Scope 不是远端用户`,
    });
    expect(await isSkillNameVisible(REFRESH_SKILL)).toBe(false);

    // 从状态条恢复同一弹窗并推送。
    await clickTestIdByDom("remote-sync-minimized");
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
    expect(await $('[data-testid="remote-sync-tab-skills"]').getAttribute("aria-current")).toBe(
      "page",
    );
    await pushSkillsAndWait();
    await waitForRowStatus(REFRESH_SKILL, "synced", "推送后新技能没有变为「已同步」");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_SKILLS}/${REFRESH_SKILL}/SKILL.md`),
    ).toContain(LOCAL_MARKER);

    // 关闭弹窗，不点刷新：技能设置页已按推送结果重新读取远端列表。
    await $('[data-testid="remote-sync-dialog"] [data-slot="dialog-close"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-testid="remote-sync-dialog"]').isExisting()),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 数据同步弹窗没有关闭` },
    );
    await browser.waitUntil(() => isSkillNameVisible(REFRESH_SKILL), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送结束后技能设置页没有刷新出新技能`,
    });
  });
});
