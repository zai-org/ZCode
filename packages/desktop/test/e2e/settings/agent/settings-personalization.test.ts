import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_PERSONALIZATION_CANCEL,
  TID_SETTINGS_PERSONALIZATION_EDITOR,
  TID_SETTINGS_PERSONALIZATION_SAVE,
  TID_SETTINGS_PERSONALIZATION_SIZE_HINT,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { sel } from "#e2e/helpers/selectors";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const PERSONALIZATION_INSTRUCTIONS = "E2E_PZ_INSTRUCTIONS 永远用中文回复，先给结论。";

/** 个性化编辑的文件就是 Agent 读取的 ~/.zcode/AGENTS.md；e2e 的 HOME 已指向隔离目录。 */
function personalizationAgentsFile(): string {
  return join(getE2EAppDataPaths().storageRoot, "AGENTS.md");
}

async function readAgentsFile(): Promise<string | null> {
  try {
    return await readFile(personalizationAgentsFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 用测试进程自己持有 AGENTS.md 的文件锁（owner pid 存活，宿主无法回收），
 * 让桌面 Host 的 saveUserInstructions 阻塞到锁超时（默认 8s）后失败。
 * 用于构造「保存 in-flight → 切走分区 → 写入失败」的确定性时序。
 */
async function holdAgentsFileLock(): Promise<() => Promise<void>> {
  const lockDir = `${personalizationAgentsFile()}.lock`;
  await mkdir(lockDir);
  await writeFile(
    join(lockDir, "owner-e2e-holder.json"),
    `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "e2e-holder" })}\n`,
  );
  return async () => {
    await rm(lockDir, { recursive: true, force: true });
  };
}

async function openSettingsSection(sectionId: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, sectionId), {
    timeout: 15000,
    timeoutMsg: `设置页没有出现分区入口：${sectionId}`,
  });
}

describe("设置页个性化（自定义指令）E2E", () => {
  before(async () => {
    await rm(personalizationAgentsFile(), { force: true });
  });

  after(async () => {
    await clearAppData();
  });

  beforeEach(async () => {
    // 上一个用例可能停在设置页，先真实关闭遮挡层再进入本用例。
    const back = $(sel(TID_SETTINGS_BACK_BUTTON));
    if (await back.isDisplayed()) await back.click();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  });

  it("PZ-00: 个性化是「Agent 能力」组的第一项", async () => {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

    const groupSections = await browser.execute(() => {
      const group = document.querySelector(
        '[aria-labelledby="settings-sidebar-group-agentCapabilities"]',
      );
      if (!group) return null;
      return Array.from(group.querySelectorAll<HTMLElement>("[data-settings-section-nav]")).map(
        (item) => item.dataset.settingsSectionNav ?? "",
      );
    });
    expect(groupSections).not.toBeNull();
    expect(groupSections?.[0]).toBe("personalization");
    expect(groupSections).toContain("memory");
  });

  it("PZ-01: 点击个性化直达编辑器，保存后落盘 AGENTS.md", async () => {
    await openSettingsSection("personalization");

    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "点击个性化分区后没有直接出现编辑器",
    });
    // 单层交互：不经过任何二级入口，编辑器直接铺在内容区。
    expect(await readAgentsFile()).toBeNull();
    expect(await editor.getValue()).toBe("");
    expect(await editor.getAttribute("placeholder")).toMatch(
      /添加自定义指令|Add custom instructions/u,
    );
    await editor.setValue(PERSONALIZATION_INSTRUCTIONS);
    expect(await readAgentsFile()).toBeNull();
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE, {
      timeout: 15000,
      timeoutMsg: "个性化保存按钮没有出现",
    });
    await browser.waitUntil(async () => (await readAgentsFile()) === PERSONALIZATION_INSTRUCTIONS, {
      timeout: 15000,
      timeoutMsg: "保存后没有把内容写入 ~/.zcode/AGENTS.md",
    });
  });

  it("PZ-02: 文件是唯一事实源，重新进入回显且取消丢弃修改", async () => {
    const seeded = "E2E_PZ_SEEDED 回显校验";
    await writeFile(personalizationAgentsFile(), seeded);

    await openSettingsSection("personalization");
    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === seeded, {
      timeout: 15000,
      timeoutMsg: "进入分区后没有回显 AGENTS.md 的既有内容",
    });

    // 未修改时保存/取消均不可用。
    expect(await $(sel(TID_SETTINGS_PERSONALIZATION_SAVE)).isEnabled()).toBe(false);
    expect(await $(sel(TID_SETTINGS_PERSONALIZATION_CANCEL)).isEnabled()).toBe(false);

    // 取消丢弃修改：编辑器回到基线，文件不变。
    await editor.setValue("E2E_PZ_DISCARDED");
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_CANCEL, { timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === seeded, {
      timeout: 15000,
      timeoutMsg: "取消后没有恢复到已保存内容",
    });
    expect(await readAgentsFile()).toBe(seeded);

    // 切走再切回，内容仍来自文件。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "personalization"), {
      timeout: 15000,
    });
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === seeded, {
      timeout: 15000,
      timeoutMsg: "重新进入分区后没有回显 AGENTS.md 的内容",
    });
  });

  it("PZ-03: 清空并保存后文件内容被清空", async () => {
    await writeFile(personalizationAgentsFile(), "E2E_PZ_TO_CLEAR");

    await openSettingsSection("personalization");
    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ_TO_CLEAR", {
      timeout: 15000,
    });

    // 不能用 setValue("")：chromedriver 的 clear 路径不触发 React 可见的 input 事件，
    // 受控组件的草稿不更新、脏态门控不会放行保存。改用真实键盘全选删除。
    await editor.click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE, { timeout: 15000 });
    await browser.waitUntil(async () => (await readAgentsFile()) === "", {
      timeout: 15000,
      timeoutMsg: "清空保存后 AGENTS.md 内容没有被清空",
    });
  });

  it("PZ-04: 超过 Agent 读取上限（100KB）的内容被阻断保存并提示", async () => {
    await writeFile(personalizationAgentsFile(), "E2E_PZ_SIZE_BASE");

    await openSettingsSection("personalization");
    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ_SIZE_BASE", {
      timeout: 15000,
    });

    // Agent 只读前 100KB（UTF-8 字节）；超限内容必须被 UI 阻断，不能保存成功后静默截断。
    // 128KB 文本走 chromedriver 的 element/value 会超时；改用原生 value setter +
    // input 事件注入，React 受控组件可感知且瞬时完成。
    const oversized = `${"z".repeat(50 * 1024)}${"\u4e2d".repeat(25 * 1025)}`;
    await browser.execute(
      (editorTestId: string, text: string) => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          `[data-testid="${editorTestId}"]`,
        )!;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      },
      TID_SETTINGS_PERSONALIZATION_EDITOR,
      oversized,
    );
    await $(sel(TID_SETTINGS_PERSONALIZATION_SIZE_HINT)).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "超限提示没有出现",
    });
    // 超限时保存按钮不可用，文件保持基线内容。
    expect(await $(sel(TID_SETTINGS_PERSONALIZATION_SAVE)).isEnabled()).toBe(false);
    expect(await readAgentsFile()).toBe("E2E_PZ_SIZE_BASE");

    // 删回限内后保存恢复可用。
    await editor.click();
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    await editor.setValue("E2E_PZ_SIZE_OK");
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE, { timeout: 15000 });
    await browser.waitUntil(async () => (await readAgentsFile()) === "E2E_PZ_SIZE_OK", {
      timeout: 15000,
      timeoutMsg: "回到限内后保存没有恢复",
    });
  });

  it("PZ-05: 未保存草稿跨分区切换存活", async () => {
    await writeFile(personalizationAgentsFile(), "E2E_PZ5_BASE");

    await openSettingsSection("personalization");
    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ5_BASE", {
      timeout: 15000,
    });

    await editor.setValue("E2E_PZ5_DRAFT");
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "personalization"), {
      timeout: 15000,
    });
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ5_DRAFT", {
      timeout: 15000,
      timeoutMsg: "切走再切回后未保存草稿没有存活",
    });
    // 草稿只是存活，未被自动写入文件。
    expect(await readAgentsFile()).toBe("E2E_PZ5_BASE");
  });

  it("PZ-06: 保存中切走分区且写入失败后，草稿仍可恢复重试", async function () {
    this.timeout(60000);
    await writeFile(personalizationAgentsFile(), "E2E_PZ6_BASE");

    await openSettingsSection("personalization");
    const editor = $(sel(TID_SETTINGS_PERSONALIZATION_EDITOR));
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ6_BASE", {
      timeout: 15000,
    });
    await editor.setValue("E2E_PZ6_DRAFT");

    // 持锁令宿主保存阻塞到超时（默认 8s）；点保存后立刻切走分区，
    // 构造「保存 in-flight → 卸载 → 写入失败」的确定性时序。
    const releaseLock = await holdAgentsFileLock();
    try {
      await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE, { timeout: 15000 });
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15000 });
      // 等待锁超时失败落到已卸载组件的 store 收口（无 UI 可断言，按超时上限等）。
      await browser.pause(9000);
    } finally {
      await releaseLock();
    }

    // 重新进入：草稿仍在（模块级 store 存活），可再次保存成功。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "personalization"), {
      timeout: 15000,
    });
    await editor.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await editor.getValue()) === "E2E_PZ6_DRAFT", {
      timeout: 15000,
      timeoutMsg: "保存失败于卸载态后，草稿没有被恢复",
    });
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE, { timeout: 15000 });
    await browser.waitUntil(async () => (await readAgentsFile()) === "E2E_PZ6_DRAFT", {
      timeout: 15000,
      timeoutMsg: "恢复后的草稿重试保存没有落盘",
    });
  });
});
