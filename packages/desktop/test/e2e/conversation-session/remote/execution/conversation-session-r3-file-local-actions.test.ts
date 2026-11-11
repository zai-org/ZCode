import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, resolve } from "node:path";
import {
  createCodeCommandRecorder,
  readCodeCommandCalls,
  type CodeCommandCall,
} from "#e2e/helpers/code-command-recorder";
import {
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  hoverTestIdByWebDriver,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

const CASE_MARKER = "E2E_R3_FILE_LOCAL_ACTIONS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-file-local-actions",
);
const REMOTE_FILE_NAME = "r3-dev10-remote-note.md";
const REMOTE_FILE_MARKER = `R3_DEV10_REMOTE_CONTENT_${Math.random().toString(36).slice(2, 8)}`;

async function openRemoteFileTree(workspacePath: string): Promise<void> {
  await openProjectFileTree(workspacePath, {
    timeoutMsg: `${CASE_MARKER}: 没有远端工作区文件树入口`,
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: `${CASE_MARKER}: 文件树面板没有打开`,
  });
}

async function openRowContextMenu(
  path: string,
): Promise<Array<{ label: string; disabled: boolean }>> {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    () =>
      browser.execute((currentRowTestId) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) => element.dataset.testid === currentRowTestId,
        );
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY: rect.top + rect.height / 2,
            button: 2,
          }),
        );
        return true;
      }, rowTestId),
    { timeout: 30_000, interval: 300, timeoutMsg: `${CASE_MARKER}: 文件树没有目标行 ${path}` },
  );
  let items: Array<{ label: string; disabled: boolean }> = [];
  await browser.waitUntil(
    async () => {
      items = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="menuitem"], [role="menuitemcheckbox"], [data-radix-collection-item]',
          ),
        )
          .filter((node) => node.getClientRects().length)
          .map((node) => ({
            label: node.innerText.trim(),
            disabled:
              node.getAttribute("aria-disabled") === "true" || node.hasAttribute("data-disabled"),
          })),
      );
      return items.length > 0;
    },
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 右键菜单没有出现` },
  );
  return items;
}

async function clickMenuItem(label: string): Promise<boolean> {
  return browser.execute((expected) => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
    ).find((node) => node.innerText.trim() === expected && node.getClientRects().length);
    if (!item) return false;
    item.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
    item.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
    item.click();
    return true;
  }, label);
}

describe(`${CASE_MARKER}: 远端文件的本机动作边界与原生编辑器 URI`, () => {
  const facts: Record<string, unknown> = {};
  let restoreEditorEnvironment: (() => Promise<unknown>) | undefined;

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "file-local-actions.json"),
      JSON.stringify(facts, null, 2),
    );
    await restoreEditorEnvironment?.();
    await browser.execute(() => {
      const w = window as Window & { __r3Clip?: string; __r3RestoreClip?: () => void };
      w.__r3RestoreClip?.();
      delete w.__r3RestoreClip;
      delete w.__r3Clip;
    });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-10 远端文件读取/复制与文件管理器门禁；原生平台通过 VS Code CLI 验证 Remote-SSH 文件 URI", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const [workspaceA] = config.workspacePaths;
    await runSSHCommand(
      config,
      `printf '# %s\\n\\n%s\\n' "${CASE_MARKER}" "${REMOTE_FILE_MARKER}" > "${workspaceA}/${REMOTE_FILE_NAME}"`,
    );
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);
    const openPathMock = await browser.electron.mock("shell", "openPath");
    await openPathMock.mockResolvedValue("");
    const showItemMock = await browser.electron.mock("shell", "showItemInFolder");
    await showItemMock.mockReturnValue(undefined);

    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: workspaceA,
    });
    expect(tab.remoteSessionId).toBeTruthy();
    await openRemoteFileTree(workspaceA);
    const remoteFilePath = `${workspaceA}/${REMOTE_FILE_NAME}`;
    const menu = await openRowContextMenu(remoteFilePath);
    facts.contextMenu = menu;
    const reveal = menu.find((item) => /文件管理器|访达|Finder|Reveal/u.test(item.label));
    facts.revealDisabledForRemote = reveal?.disabled ?? null;
    expect(reveal?.disabled).toBe(true);
    facts.hasDownloadOrExportEntry = menu.some((item) =>
      /下载|导出|Download|Export/u.test(item.label),
    );
    // 复制绝对路径 → 剪贴板应是远端路径。
    await browser.execute(() => {
      const w = window as Window & { __r3Clip?: string; __r3RestoreClip?: () => void };
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      w.__r3RestoreClip = () => {
        navigator.clipboard.writeText = original;
      };
      navigator.clipboard.writeText = async (text: string) => {
        w.__r3Clip = text;
      };
    });
    expect(await clickMenuItem("复制绝对路径")).toBe(true);
    await browser.waitUntil(
      () =>
        browser.execute(
          (expected) => (window as Window & { __r3Clip?: string }).__r3Clip === expected,
          remoteFilePath,
        ),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 复制没有写入正确的远端路径` },
    );
    const copied = await browser.execute(() => {
      const w = window as Window & { __r3Clip?: string; __r3RestoreClip?: () => void };
      const value = w.__r3Clip ?? "";
      w.__r3RestoreClip?.();
      delete w.__r3RestoreClip;
      delete w.__r3Clip;
      return value;
    });
    facts.copiedAbsolutePath = copied;
    expect(copied).toBe(remoteFilePath);

    // 打开（主动作）：代码查看器显示远端内容（远端读取）。
    await openRowContextMenu(remoteFilePath);
    expect(await clickMenuItem("打开")).toBe(true);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.body?.innerText ?? "")).includes(REMOTE_FILE_MARKER),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 打开后没有显示远端文件内容` },
    );
    facts.openShowsRemoteContent = true;

    // 编辑器已直接列在文件菜单；不再查找旧“打开方式”子菜单。
    const menu2 = await openRowContextMenu(remoteFilePath);
    if (!["darwin", "win32"].includes(process.platform)) {
      expect(menu2.some((item) => item.label === "VS Code" && !item.disabled)).toBe(false);
      facts.editorCoverage = { status: "unsupported-host-platform", platform: process.platform };
      await browser.keys(["Escape"]);
    } else {
      // 录制夹具只替代外部进程；菜单检测与 Main 的 URI 生成仍走产品实现。
      let binDir: string;
      let logPath: string;
      if (process.platform === "win32") {
        binDir = process.env.R3_CODE_STUB_DIR?.trim() ?? "";
        if (!binDir)
          throw new Error(`${CASE_MARKER}: Windows 需要 R3_CODE_STUB_DIR 的 code.exe 录制夹具`);
        logPath = resolve(binDir, "code-calls.jsonl");
        await rm(logPath, { force: true });
      } else {
        ({ binDir, logPath } = await createCodeCommandRecorder(artifactDir));
      }
      const key = `__r3EditorPath_${randomUUID()}`;
      await browser.electron.execute(
        (_electron, input) => {
          const state = globalThis as unknown as Record<string, unknown>;
          state[input.key] = process.env.PATH;
          process.env.PATH = input.binDir + input.delimiter + (process.env.PATH ?? "");
        },
        { key, binDir, delimiter },
      );
      restoreEditorEnvironment = () =>
        browser.electron.execute((_electron, savedKey) => {
          const state = globalThis as unknown as Record<string, unknown>;
          const previous = state[savedKey];
          if (typeof previous === "string") process.env.PATH = previous;
          else delete process.env.PATH;
          delete state[savedKey];
        }, key);
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some(
              (node) =>
                node.getClientRects().length &&
                node.innerText.trim() === "VS Code" &&
                node.getAttribute("aria-disabled") !== "true" &&
                !node.hasAttribute("data-disabled"),
            ),
          ),
        { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有可用的 VS Code 直接菜单项` },
      );
      expect(await clickMenuItem("VS Code")).toBe(true);
      let calls: CodeCommandCall[] = [];
      await browser.waitUntil(
        async () => {
          calls = await readCodeCommandCalls(logPath);
          return calls.length > 0;
        },
        { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: Main 没有调用 code CLI` },
      );
      const userHost = `${config.username}@${config.host}${config.port === 22 ? "" : `:${config.port}`}`;
      const encodedPath = remoteFilePath
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      const expectedArgs = [
        "--file-uri",
        `vscode-remote://ssh-remote+${encodeURIComponent(userHost)}${encodedPath}`,
      ];
      expect(calls).toEqual([
        {
          argumentCount: 2,
          argumentHashes: expectedArgs.map((arg) => createHash("sha256").update(arg).digest("hex")),
        },
      ]);
      facts.editorCoverage = {
        status: "verified",
        platform: process.platform,
        editor: "VS Code",
        calls,
        rawArgumentsRetained: false,
      };
    }
    await browser.keys(["Escape"]);
    await openExternalMock.update();
    await openPathMock.update();
    expect(openExternalMock.mock.calls).toHaveLength(0);
    expect(openPathMock.mock.calls).toHaveLength(0);
    await showItemMock.update();
    facts.showItemInFolderCalls = (showItemMock.mock.calls as unknown[][]).length;
    expect(facts.showItemInFolderCalls).toBe(0);
    expect(await readHostProcesses()).toEqual(initialHosts);
    await runSSHCommand(config, `rm -f "${remoteFilePath}"`);
  });
});
