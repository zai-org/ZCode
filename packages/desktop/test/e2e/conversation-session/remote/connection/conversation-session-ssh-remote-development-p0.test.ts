import { posix } from "node:path";
import {
  TID_GIT_PANE,
  TID_PREVIEW_PANE,
  TID_TERMINAL,
  TID_TERMINAL_TOGGLE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  type SSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

const CASE_MARKER = "SSH_P0_DEVELOPMENT";
const FILE_MARKER = "SSH_P0_REMOTE_FILE_MARKER";
const TERMINAL_MARKER = "SSH_P0_REMOTE_TERMINAL_MARKER";
const DIFF_MARKER = "SSH_P0_REMOTE_GIT_DIFF_MARKER";

describe(`${CASE_MARKER}: SSH 远端开发基础能力 P0`, () => {
  let config: SSHRuntimeConfig | null = null;
  let fixturePath = "";

  after(async () => {
    if (config && isCaseFixturePath(fixturePath, config.workspacePaths[0])) {
      await runSSHCommand(config, `rm -rf -- '${fixturePath}'`).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-DEV-01/02/03 文件树、Terminal 和 Git 均使用远端 workspace", async function () {
    this.timeout(20 * 60_000);
    config = readSSHRuntimeConfig(CASE_MARKER);
    // Bugfix：远端 E2E fixture 也必须落在专用隔离根目录，不能写入系统临时目录。
    fixturePath = posix.join(config.workspacePaths[0], ".zcode-e2e", `ssh-p0-dev-${Date.now()}`);
    if (!isCaseFixturePath(fixturePath, config.workspacePaths[0])) {
      throw new Error(`${CASE_MARKER}: 非法远端 fixture path`);
    }

    const setup = await runSSHCommand(
      config,
      [
        "set -eu",
        `mkdir -p '${fixturePath}'`,
        `cd '${fixturePath}'`,
        `printf '%s\\n' '${FILE_MARKER}' > README.txt`,
        "git init -q",
        "git config user.email 'zcode-e2e@example.invalid'",
        "git config user.name 'ZCode E2E'",
        "git add README.txt",
        "git commit -qm 'test fixture baseline'",
      ].join(" && "),
    );
    expect(setup.code).toBe(0);
    expect(setup.stderr).toBe("");

    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: fixturePath,
    });
    expect(tab.secretPersistedInTab).toBe(false);

    await assertRemoteFileTreeAndPreview(fixturePath);
    await assertRemoteTerminal(fixturePath);
    await assertRemoteGitStatus();
    expect(await readHostProcesses()).toEqual(initialHosts);

    const remote = await runSSHCommand(
      config,
      `cd '${fixturePath}' && printf '%s\\n' "$(pwd)" && cat README.txt && cat terminal-created.txt`,
    );
    expect(remote.code).toBe(0);
    expect(remote.stdout).toContain(fixturePath);
    expect(remote.stdout).toContain(FILE_MARKER);
    expect(remote.stdout).toContain(DIFF_MARKER);
    expect(remote.stdout).toContain(TERMINAL_MARKER);
  });
});

async function assertRemoteFileTreeAndPreview(workspacePath: string): Promise<void> {
  await openProjectFileTree(workspacePath, {
    timeoutMsg: `${CASE_MARKER}: 没有找到远端文件树入口`,
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: `${CASE_MARKER}: 远端文件树没有打开`,
  });

  const readmePath = `${workspacePath}/README.txt`;
  await clickWorkspaceFileTreeRow(readmePath);
  await waitForTestIdByDom(TID_PREVIEW_PANE, {
    timeoutMsg: `${CASE_MARKER}: 远端 README 没有打开预览`,
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (previewTestId, marker) => {
          const preview = document.querySelector<HTMLElement>(`[data-testid="${previewTestId}"]`);
          if (!preview) return false;
          const fragments = [preview.innerText, preview.textContent ?? ""];
          const visit = (root: ParentNode) => {
            for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
              if (!element.shadowRoot) continue;
              fragments.push(element.shadowRoot.textContent ?? "");
              visit(element.shadowRoot);
            }
          };
          visit(preview);
          return fragments.join("\n").includes(marker);
        },
        TID_PREVIEW_PANE,
        FILE_MARKER,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 文件预览没有显示远端 marker`,
    },
  );
}

async function assertRemoteTerminal(workspacePath: string): Promise<void> {
  await clickTestIdByDom(TID_TERMINAL_TOGGLE, {
    timeoutMsg: `${CASE_MARKER}: Terminal 入口不可点击`,
  });
  await waitForTestIdByDom(TID_TERMINAL, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: Terminal 没有打开`,
  });
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(
          document.querySelector<HTMLTextAreaElement>(
            '[data-testid="terminal"] .xterm-helper-textarea',
          ),
        ),
      ),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: xterm 输入框没有就绪`,
    },
  );
  // 慢机上 textarea 先于 terminal.create 完成出现；此时发出的首批按键没有 PTY 接收。
  // 等真实 Shell 提示符，不用固定延时，且保持后面的命令、输出和文件断言不变。
  await browser.waitUntil(
    () =>
      browser.execute((terminalTestId) => {
        const text =
          document.querySelector<HTMLElement>(`[data-testid="${terminalTestId}"] .xterm-rows`)
            ?.textContent ?? "";
        return /[$#]\s*$/.test(text);
      }, TID_TERMINAL),
    { timeout: 45_000, timeoutMsg: `${CASE_MARKER}: 远端 Shell 提示符没有就绪` },
  );

  const command = [
    `printf '%s\\n' '${DIFF_MARKER}' >> README.txt`,
    `printf '%s\\n' '${TERMINAL_MARKER}' > terminal-created.txt`,
    `printf '%s\\n' '${TERMINAL_MARKER}'`,
    "pwd",
    "uname -s",
  ].join(" && ");
  await browser.execute((terminalTestId) => {
    document
      .querySelector<HTMLTextAreaElement>(
        `[data-testid="${terminalTestId}"] .xterm-helper-textarea`,
      )
      ?.focus();
  }, TID_TERMINAL);
  await browser.keys([command, "Enter"]);

  await browser.waitUntil(
    () =>
      browser.execute(
        (terminalTestId, marker, expectedPath) => {
          const text =
            document.querySelector<HTMLElement>(`[data-testid="${terminalTestId}"] .xterm-rows`)
              ?.textContent ?? "";
          return text.includes(marker) && text.includes(expectedPath) && text.includes("Linux");
        },
        TID_TERMINAL,
        TERMINAL_MARKER,
        workspacePath,
      ),
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `${CASE_MARKER}: Terminal 没有显示远端 cwd/system marker`,
    },
  );

  await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON, {
    timeoutMsg: `${CASE_MARKER}: 文件树刷新按钮不可点击`,
  });
  await waitForWorkspaceFileTreeRow(`${workspacePath}/terminal-created.txt`);
}

async function assertRemoteGitStatus(): Promise<void> {
  let addTriggerClicked = false;
  for (const trigger of await $$("[data-side-pane-add-tab-trigger]")) {
    if (await trigger.isDisplayed()) {
      await trigger.click();
      addTriggerClicked = true;
      break;
    }
  }
  expect(addTriggerClicked).toBe(true);

  // 新标签页已替代旧下拉菜单；从真实审查卡片进入，不能继续查找已退役的 menuitem。
  const reviewItem = $('[data-side-pane-open-tab-item="review"]');
  await reviewItem.waitForClickable({ timeout: 30_000 });
  await reviewItem.click();
  await waitForTestIdByDom(TID_GIT_PANE, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: Git pane 没有打开`,
  });
  await browser.waitUntil(
    () =>
      browser.execute((gitPaneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
        return (
          pane?.innerText.includes("README.txt") && pane.innerText.includes("terminal-created.txt")
        );
      }, TID_GIT_PANE),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: Git pane 没有显示远端 unstaged 文件`,
    },
  );
}

async function clickWorkspaceFileTreeRow(path: string): Promise<void> {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    () =>
      browser.execute((currentTestId) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === currentTestId,
        );
        row?.click();
        return Boolean(row);
      }, rowTestId),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 文件树没有目标行 ${path}`,
    },
  );
}

async function waitForWorkspaceFileTreeRow(path: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (currentTestId) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (candidate) => candidate.dataset.testid === currentTestId,
          ),
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 文件树没有显示新增远端文件 ${path}`,
    },
  );
}

function isCaseFixturePath(value: string, workspaceRoot: string): boolean {
  return (
    posix.dirname(value) === posix.join(workspaceRoot, ".zcode-e2e") &&
    /^ssh-p0-dev-\d+$/u.test(posix.basename(value))
  );
}
