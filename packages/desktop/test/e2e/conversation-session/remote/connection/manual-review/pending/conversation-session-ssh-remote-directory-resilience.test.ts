import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  sendSSHFollowTurn,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_DIRECTORY_RESILIENCE";
const failure = process.env.R3_DIRECTORY_FAILURE_CASE ?? "missing";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-directory-resilience",
);

describe(`${MARKER}: 单个目录失效不影响设备与其他项目`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = { failure };
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "directory-resilience.json"),
      JSON.stringify(facts, null, 2),
    );
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`SSH-GUIDE-DIR ${failure}: 失败项目保留、其他两个恢复、目录修复后原历史可续聊`, async function () {
    this.timeout(15 * 60_000);
    if (!["missing", "file", "denied"].includes(failure)) throw new Error("未知目录故障类型");
    const prepared = await prepareSSHLifecycle(MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const { config } = prepared;
    const [rootA, pathB] = config.workspacePaths;
    // 目录可用性由 Host stat 派生。撤销独占父目录的遍历权限才能真实触发 EACCES，
    // 仅 chmod 目标目录本身仍可 stat；也不能撤销公共 home 权限而连带破坏 B/C。
    const pathA = failure === "denied" ? `${rootA}/primary` : rootA;
    if (failure === "denied")
      expect((await runSSHCommand(config, `mkdir -p '${pathA}'`)).code).toBe(0);
    const pathC = `${pathB}-guide-c`;
    const saved = `${pathA}-guide-saved`;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config,
      provider,
      label: "A",
      workspacePath: pathA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config,
      provider,
      label: "B",
      workspacePath: pathB,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    expect(
      (
        await runSSHCommand(
          config,
          `mkdir -p '${pathC}'; printf GUIDE_REMOTE_DATA > '${pathA}/guide-sentinel.txt'`,
        )
      ).code,
    ).toBe(0);
    const tabC = await connectSSHWorkspace({ config, caseMarker: MARKER, workspacePath: pathC });
    // 恢复合同保留原激活项目；不能让只验证目录隔离的 case 额外要求连接 B 时抢走 C 的焦点。
    await selectV4TaskById(taskB.taskId);
    await disconnectRemoteSource(sourceId, MARKER, {
      workspaceIdentities: [taskA.identity, taskB.identity, tabC.workspaceIdentity!],
    });

    try {
      const mutation =
        failure === "denied"
          ? `chmod 000 '${rootA}'`
          : `mv '${pathA}' '${saved}'${failure === "file" ? `; printf GUIDE_FILE > '${pathA}'` : ""}`;
      expect((await runSSHCommand(config, mutation)).code).toBe(0);
      facts.directoryAccessAfterMutation = (
        await runSSHCommand(
          config,
          `id -u; test -r '${pathA}' && test -x '${pathA}' && printf ACCESSIBLE || printf INACCESSIBLE; printf '\\n'; ls '${pathA}' >/dev/null 2>&1 && printf READ_OK || printf READ_DENIED; printf '\\n'; p=$(sed -nE 's/.*"pid": *([0-9]+).*/\\1/p' "$HOME/.zcode/server/run/status.json" | head -1); test -z "$p" || awk '/^Uid:/ {print "core " $0}' /proc/$p/status`,
        )
      ).stdout;
      if (failure === "denied") {
        // 权限故障必须由非特权账号实际观测，避免 chmod 成功却仍能访问造成假回归。
        expect(facts.directoryAccessAfterMutation).toMatch(
          /^[1-9]\d*\nINACCESSIBLE\nREAD_DENIED\n/,
        );
        expect(facts.directoryAccessAfterMutation).toMatch(/core Uid:\s+[1-9]\d*\s+[1-9]\d*/);
      }
      await reconnectRemoteProject(taskB.identity, MARKER);
      const restoredB = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: taskB.identity,
        expectedPath: pathB,
      });
      const restoredC = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: tabC.workspaceIdentity!,
        expectedPath: pathC,
        requireActive: false,
      });
      expect(restoredB.remoteSessionId).not.toBe(taskB.remoteSessionId);
      expect(restoredC.remoteSessionId).toBeTruthy();
      expect(restoredC.remoteSessionId).not.toBe(tabC.remoteSessionId);
      facts.failedProjectSnapshot = await readRemoteTabSnapshot(taskA.identity);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        resolve(artifactDir, "directory-resilience.json"),
        JSON.stringify(facts, null, 2),
      );
      expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBeNull();
      expect(facts.failedProjectSnapshot).toMatchObject({
        workspacePath: pathA,
        workspaceIdentity: taskA.identity,
      });
      const failedProject = $(`[data-project-workspace-identity="${taskA.identity}"]`);
      await failedProject.waitForDisplayed();
      taskB.remoteSessionId = restoredB.remoteSessionId!;
      await sendSSHFollowTurn(taskB, MARKER, taskA.firstPrompt);

      // Source 已在线，失效目录不再提供 Host 连接动作；按主目录规格验证禁用与历史读取。
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () =>
          ["missing", "unavailable"].includes(
            (await failedProject.getAttribute("data-primary-root-status")) ?? "",
          ),
        { timeout: 30_000, timeoutMsg: `${MARKER}: 失效主目录没有更新项目状态` },
      );
      const create = failedProject.$('[data-testid="virtual-project-create-task"]');
      expect(await create.isEnabled()).toBe(false);
      expect(await failedProject.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(
        false,
      );
      await create.parentElement().moveTo();
      await browser.waitUntil(
        async () =>
          /主文件夹.*删除或移动|无法访问|main folder.*deleted|cannot be accessed/iu.test(
            await browser.execute(() => document.body.innerText),
          ),
        { timeout: 10_000, timeoutMsg: `${MARKER}: 失败项目没有给出目录不可用原因` },
      );
      await browser.saveScreenshot(resolve(artifactDir, `${failure}-reason.png`));
      const toggle = failedProject.$('[data-testid="virtual-project-toggle"]');
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const historyRow = failedProject.$(
        `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, taskA.taskId))}]`,
      );
      await historyRow.waitForDisplayed();
      // 失效目录的历史必须能通过可见任务行读取；真实指针排除隐藏行的 DOM click 干扰。
      await historyRow.click();
      try {
        await waitForV4Pane(
          (pane) => pane.sessionId === taskA.taskId,
          `${MARKER}: 失效目录原任务未打开`,
        );
      } finally {
        facts.historyNavigation = {
          expectedTaskId: taskA.taskId,
          tab: await readRemoteTabSnapshot(taskA.identity),
          panes: await browser.execute(() =>
            [...document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]')]
              .filter((pane) => pane.getClientRects().length > 0)
              .map((pane) => ({ id: pane.dataset.testid, sessionId: pane.dataset.sessionId })),
          ),
        };
      }
      await waitForV4AssistantMessageContaining(taskA.firstReply);
      facts.failedProjectRetained = await readRemoteTabSnapshot(taskA.identity);
      facts.siblings = [restoredB, restoredC];
      const untouched = await runSSHCommand(
        config,
        failure === "denied"
          ? `sudo test -d '${pathA}' && sudo cat '${pathA}/guide-sentinel.txt'`
          : `test ${failure === "file" ? "-f" : "! -e"} '${pathA}' && cat '${saved}/guide-sentinel.txt'`,
      );
      expect(untouched.stdout).toBe("GUIDE_REMOTE_DATA");
    } finally {
      const restore =
        failure === "denied"
          ? `chmod 755 '${rootA}'`
          : `${failure === "file" ? `rm -f '${pathA}'; ` : ""}test ! -d '${saved}' || mv '${saved}' '${pathA}'`;
      expect((await runSSHCommand(config, restore)).code).toBe(0);
    }

    // 目录修复由所属 Host 在窗口 focus 时复查；不依赖已退役的目录连接错误页。
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(
      async () =>
        (await $(`[data-project-workspace-identity="${taskA.identity}"]`).getAttribute(
          "data-primary-root-status",
        )) === "available",
      { timeout: 30_000, timeoutMsg: `${MARKER}: 修复目录后项目没有恢复可用` },
    );
    await selectV4TaskById(taskA.taskId);
    const restoredA = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: pathA,
      requireActive: false,
    });
    taskA.remoteSessionId = restoredA.remoteSessionId!;
    await sendSSHFollowTurn(taskA, MARKER, taskB.firstPrompt);
    expect((await runSSHCommand(config, `cat '${pathA}/guide-sentinel.txt'`)).stdout).toBe(
      "GUIDE_REMOTE_DATA",
    );
    facts.originalHistoryContinued = {
      taskId: taskA.taskId,
      identity: restoredA.workspaceIdentity,
    };
  });
});
