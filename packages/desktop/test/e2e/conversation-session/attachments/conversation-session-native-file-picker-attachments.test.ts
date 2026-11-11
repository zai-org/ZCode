import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TID_CHAT_ATTACHMENT_BUTTON, TID_CHAT_ATTACHMENT_MENU_ITEM } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  startNewV4Draft,
} from "#e2e/helpers/v4-conversation";

const NATIVE_FILE_PICKER_TIMEOUT_MS = 180000;
const ATTACHMENT_LIMIT = 8;

describe("会话区 native 文件选择器附件数量边界 E2E", () => {
  const fixtureRoot = join(tmpdir(), `zcode-e2e-native-file-picker-attachments-${Date.now()}`);
  before(async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await createFixtureFiles(fixtureRoot);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(fixtureRoot, { force: true, recursive: true });
    await clearAppData();
  });

  beforeEach(async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);

    await startNewV4Draft();
    await clearComposerAttachments();
    await assertAttachmentLimitWarningVisible(false);
  });

  it("T01: native picker 返回单个文件时 composer 应保留附件图标", async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);

    const selectedPaths = [fixturePath(fixtureRoot, "single-config.json")];
    const expectedFilenames = selectedPaths.map((path) => basename(path));

    await pickV4ComposerFiles(selectedPaths);
    await assertComposerAttachments(expectedFilenames, {
      iconIncludes: ["material-icons/json.svg"],
    });
    await assertAttachmentLimitWarningVisible(false);
  });

  it("T02: native picker 一次返回多个文件时应按顺序全部进入 composer", async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);

    const selectedPaths = [
      fixturePath(fixtureRoot, "multi-config.json"),
      fixturePath(fixtureRoot, "multi-notes.md"),
      fixturePath(fixtureRoot, "multi-script.ts"),
    ];
    const expectedFilenames = selectedPaths.map((path) => basename(path));

    await pickV4ComposerFiles(selectedPaths);
    await assertComposerAttachments(expectedFilenames, {
      iconIncludes: ["material-icons/json.svg", "material-icons/markdown.svg"],
    });
    await assertAttachmentLimitWarningVisible(false);
  });

  it("T03: native picker 一次返回超过 8 个文件时只接受前 8 个并提示", async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);

    const selectedPaths = Array.from({ length: 9 }, (_, index) =>
      fixturePath(fixtureRoot, `limit-${String(index + 1).padStart(2, "0")}.json`),
    );
    const acceptedFilenames = selectedPaths
      .slice(0, ATTACHMENT_LIMIT)
      .map((path) => basename(path));
    const rejectedFilename = basename(selectedPaths[ATTACHMENT_LIMIT] ?? "");

    await pickV4ComposerFiles(selectedPaths);
    await assertComposerAttachments(acceptedFilenames, {
      iconIncludes: ["material-icons/json.svg"],
      rejectedFilenames: [rejectedFilename],
    });
    await assertAttachmentLimitWarningVisible(true);
  });

  it("满 8 个后选择、重复粘贴均弹出提示，删除后可继续添加", async function () {
    this.timeout(NATIVE_FILE_PICKER_TIMEOUT_MS);
    const paths = Array.from({ length: 8 }, (_, index) =>
      fixturePath(fixtureRoot, `limit-${String(index + 1).padStart(2, "0")}.json`),
    );
    await pickV4ComposerFiles(paths);
    await assertComposerAttachments(paths.map((path) => basename(path)));
    // 满额时应在打开系统选择器前拦截，监听真实 input click 而非已清空的 files。
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("缺少附件文件输入框");
      input.dataset.e2eClickCount = "0";
      input.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          input.dataset.e2eClickCount = "1";
        },
        { capture: true, once: true },
      );
    });
    await clickAttachmentMenuItem();
    await assertAttachmentLimitWarningVisible(true);
    expect(
      await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>('input[type="file"]');
        return input?.dataset.e2eClickCount;
      }),
    ).toBe("0");

    for (let attempt = 0; attempt < 2; attempt++) {
      await assertAttachmentLimitWarningVisible(false);
      await browser.execute(() => {
        const input = document.querySelector<HTMLElement>('[data-testid="v4-composer-input"]');
        if (!input) throw new Error("缺少输入框");
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File(["extra"], "rejected-paste.txt", { type: "text/plain" }));
        input.focus();
        input.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
        );
      });
      await assertAttachmentLimitWarningVisible(true);
      await assertComposerAttachments(
        paths.map((path) => basename(path)),
        { rejectedFilenames: ["rejected-paste.txt"] },
      );
    }

    await browser.execute(() => {
      const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        /Remove attachment|移除附件/.test(button.getAttribute("aria-label") ?? ""),
      );
      if (!remove) throw new Error("缺少附件删除按钮");
      remove.click();
    });
    const replacement = fixturePath(fixtureRoot, "single-config.json");
    await pickV4ComposerFiles([replacement]);
    await assertComposerAttachments(
      [...paths.slice(1), replacement].map((path) => basename(path)),
      { rejectedFilenames: [basename(paths[0]!)] },
    );
  });
});

async function createFixtureFiles(root: string) {
  await mkdir(root, { recursive: true });
  const files = [
    "single-config.json",
    "multi-config.json",
    "multi-notes.md",
    "multi-script.ts",
    ...Array.from({ length: 9 }, (_, index) => `limit-${String(index + 1).padStart(2, "0")}.json`),
  ];
  await Promise.all(
    files.map((filename) =>
      writeFile(
        fixturePath(root, filename),
        `E2E native file picker fixture: ${filename}\n`,
        "utf8",
      ),
    ),
  );
}

function fixturePath(root: string, filename: string) {
  return join(root, filename);
}

async function clickAttachmentMenuItem() {
  const trigger = await $(`[data-testid="${TID_CHAT_ATTACHMENT_BUTTON}"]`);
  await trigger.waitForClickable({
    timeout: 15000,
    timeoutMsg: "附件菜单按钮没有出现",
  });
  await trigger.click();
  const menuItem = await $(`[data-testid="${TID_CHAT_ATTACHMENT_MENU_ITEM}"]`);
  await menuItem.waitForClickable({
    timeout: 10000,
    timeoutMsg: "附件菜单项没有出现",
  });
  await menuItem.click();
}

async function assertComposerAttachments(
  expectedFilenames: string[],
  options: {
    iconIncludes?: string[];
    rejectedFilenames?: string[];
  } = {},
) {
  await browser.waitUntil(
    async () => {
      const snapshot = await getAttachmentDomSnapshot();
      return (
        containsAll(snapshot.bodyText, expectedFilenames) &&
        excludesAll(snapshot.bodyText, options.rejectedFilenames ?? []) &&
        containsAll(snapshot.iconSrcs.join("\n"), options.iconIncludes ?? [])
      );
    },
    {
      timeout: 15000,
      timeoutMsg: `composer 附件状态不符合预期: ${expectedFilenames.join(", ")}`,
    },
  );
  const snapshot = await getAttachmentDomSnapshot();
  expectContainsInOrder(snapshot.bodyText, expectedFilenames);
}

async function clearComposerAttachments() {
  await browser.waitUntil(
    async () => {
      const removedCount = await browser.execute(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        const removeButtons = buttons.filter((button) => {
          const label = button.getAttribute("aria-label") ?? "";
          return label.includes("Remove attachment") || label.includes("移除附件");
        });
        // startNewTask 不保证清空 composer 本地草稿附件；这里显式清理，避免数量边界 case 互相污染。
        for (const button of removeButtons) {
          button.click();
        }
        return removeButtons.length;
      });
      return removedCount === 0;
    },
    {
      timeout: 10000,
      timeoutMsg: "没有清空 composer 遗留附件",
    },
  );
}

async function assertAttachmentLimitWarningVisible(expected: boolean) {
  await browser.waitUntil(
    async () => {
      const snapshot = await getAttachmentLimitWarningSnapshot();
      return expected ? snapshot.visible : !snapshot.visible;
    },
    {
      timeout: 10000,
      timeoutMsg: expected ? "没有显示附件数量上限 warning" : "不应显示附件数量上限 warning",
    },
  );
  if (!expected) {
    return;
  }
  const snapshot = await getAttachmentLimitWarningSnapshot();
  expect(snapshot.className).toContain("bg-toast/60");
  expect(snapshot.hasInfoIcon).toBe(true);
}

async function getAttachmentDomSnapshot() {
  return browser.execute(() => ({
    bodyText: document.body.innerText.replace(/\u00a0/g, " "),
    iconSrcs: Array.from(document.querySelectorAll<HTMLImageElement>("img")).map(
      (image) => image.src,
    ),
  }));
}

async function getAttachmentLimitWarningSnapshot() {
  return browser.execute(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("#zcode-toast-host .rounded-2xl"),
    );
    const warning = candidates.find((element) => {
      const text = element.innerText.replace(/\u00a0/g, " ");
      return (
        text.includes("最多只能添加 8 个附件") ||
        text.includes("You can attach up to 8 attachments")
      );
    });
    return {
      className: warning?.className ?? "",
      hasInfoIcon: Boolean(warning?.querySelector("svg")),
      visible: Boolean(
        warning &&
        getComputedStyle(warning).opacity === "1" &&
        warning.getBoundingClientRect().top >= 0 &&
        warning.getBoundingClientRect().bottom <= window.innerHeight,
      ),
    };
  });
}

function containsAll(value: string, expected: string[]) {
  return expected.every((item) => value.includes(item));
}

function excludesAll(value: string, rejected: string[]) {
  return rejected.every((item) => !value.includes(item));
}

function expectContainsInOrder(value: string, expected: string[]) {
  let offset = 0;
  for (const item of expected) {
    const nextIndex = value.indexOf(item, offset);
    expect(nextIndex).toBeGreaterThanOrEqual(0);
    offset = nextIndex + item.length;
  }
}
