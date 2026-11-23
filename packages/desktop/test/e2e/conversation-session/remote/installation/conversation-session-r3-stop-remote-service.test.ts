import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  connectRemoteSourceFromSettings,
  openRemoteDevicesSettings,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_STOP_REMOTE_SERVICE";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-stop-remote-service",
);
// 连接管理器的在线重试档位为 2/4/8 秒；多等一段余量，覆盖完整一个自动重试周期。
const AUTOMATIC_RETRY_CYCLE_MS = 2_000 + 4_000 + 8_000 + 6_000;

interface RemoteDaemonSnapshot {
  /** 远端仍存活的 Supervisor / Core 进程数（按命令行匹配，排除探测 shell 自身）。 */
  alive: number;
  supervisorPid: number | null;
  corePid: number | null;
  state: string | null;
}

async function readRemoteDaemon(config: SSHConnectionConfig): Promise<RemoteDaemonSnapshot> {
  const result = await runSSHCommand(
    config,
    [
      // pgrep -f 会匹配承载模式串的 shell 自身；用 glob 括号切断字面匹配。
      'n=0; for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *runtime/server-cor[e].js*|*"serve --superviso"[r]*) n=$((n+1));; esac; done; echo "alive=$n"',
      'echo "lock=$(cat "$HOME/.zcode/server/run/server.lock" 2>/dev/null | tr -d "\\n")"',
      'echo "status=$(cat "$HOME/.zcode/server/run/status.json" 2>/dev/null | tr -d "\\n")"',
    ].join("; "),
  );
  const line = (key: string) =>
    result.stdout
      .split("\n")
      .find((value) => value.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() ?? "";
  const parse = (value: string): Record<string, unknown> | null => {
    try {
      return value ? (JSON.parse(value) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const lock = parse(line("lock"));
  const status = parse(line("status"));
  return {
    alive: Number.parseInt(line("alive"), 10),
    supervisorPid: typeof lock?.pid === "number" ? lock.pid : null,
    corePid: typeof status?.pid === "number" ? status.pid : null,
    state: typeof status?.state === "string" ? status.state : null,
  };
}

/**
 * 远端除本次探测外仍存活的当前用户 SSH 会话数：每条 SSH 连接对应一个用户态 sshd（或 sshd-session）进程，
 * 探测自身是 `$PPID`。runSSHCommand 每次新建并关闭连接，不计入后续读数。
 */
async function countOtherSSHSessions(config: SSHConnectionConfig): Promise<number> {
  const result = await runSSHCommand(
    config,
    'me=$(id -u); n=0; for d in /proc/[0-9]*; do [ "${d#/proc/}" = "$PPID" ] && continue; [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] || continue; case "$(cat "$d/comm" 2>/dev/null)" in sshd|sshd-session) n=$((n+1));; esac; done; echo "sessions=$n"',
  );
  const match = /sessions=(\d+)/u.exec(result.stdout);
  if (!match) throw new Error(`${CASE_MARKER}: 读取远端 SSH 会话数失败：${result.stdout}`);
  return Number.parseInt(match[1]!, 10);
}

/**
 * 直接在远端执行与 Host 相同的 `running-tasks --json`，作为确认弹窗任务清单段的对照证据。
 * Supervisor 只从 Core 心跳（10 秒一次）得知清单，Core 就绪后首个心跳之前输出 `null`。
 */
async function readRemoteRunningTasksOutput(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(
    config,
    '"$HOME/.zcode/server/bin/zcode" running-tasks --json --server-root "$HOME/.zcode/server"',
  );
  return `exit=${result.code} ${result.stdout.trim()}`;
}

async function openStopMenuItem(sourceId: string) {
  await $(`[data-source-server-card="${sourceId}"] button[aria-label="更多"]`).click();
  const item = $('[role="menu"] [data-source-server-lifecycle-action="stop"]');
  await item.waitForDisplayed({ timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 缺少停止远端服务` });
  return item;
}

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await browser.execute((color) => {
    (
      window as Window & { __testActions?: { setTheme(theme: string): void } }
    ).__testActions?.setTheme(color);
  }, theme);
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}

/** 深浅主题截图，供人工复核 destructive 菜单项与确认弹窗的可辨识度；结束后恢复浅色。 */
async function captureThemeScreenshots(name: string): Promise<void> {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (!root) return;
  const dir = resolve(root, "r3-stop-remote-service");
  await mkdir(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await browser.saveScreenshot(resolve(dir, `${name}-${theme}.png`));
  }
  await setTheme("light");
}

function stopDialog() {
  return $('[role="dialog"][data-confirm-intent="source-server-stop"]');
}

async function setWindowSize(size: readonly [number, number]): Promise<void> {
  await browser.electron.execute((electron, [width, height]) => {
    electron.BrowserWindow.getAllWindows()
      .find((window) => !window.isDestroyed())
      ?.setSize(width, height);
  }, size);
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}

interface ConfirmOverflowProbe {
  overflowY: string;
  /** 说明区内容高于可视高度，即出现纵向滚动。 */
  scrollable: boolean;
  /** 长路径不能把说明区横向撑开。 */
  horizontalOverflow: boolean;
  /** 说明区滚动时确认按钮仍在视口内。 */
  footerInViewport: boolean;
}

/**
 * RDLC #05：确认弹窗在深浅主题 × 宽 / 窄窗口（最小窗口 480×640）下截图，供人工复核任务清单可读。
 * 真实清单通常很短，窄窗口下再向说明区追加一段合成的长清单（仅用于布局探测，截图后移除），
 * 断言说明区纵向滚动、长路径不横向溢出、按钮仍在视口内，并截图复核可滚动。
 */
async function probeConfirmDialogLayouts(): Promise<ConfirmOverflowProbe> {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  const dir = root ? resolve(root, "r3-stop-remote-service") : undefined;
  if (dir) await mkdir(dir, { recursive: true });
  const capture = async (name: string) => {
    for (const theme of ["light", "dark"] as const) {
      await setTheme(theme);
      if (dir) await browser.saveScreenshot(resolve(dir, `${name}-${theme}.png`));
    }
  };
  const original = await browser.electron.execute((electron) => {
    const size = electron.BrowserWindow.getAllWindows()
      .find((window) => !window.isDestroyed())
      ?.getSize();
    return size ? ([size[0]!, size[1]!] as const) : null;
  });
  if (!original) throw new Error(`${CASE_MARKER}: 读取窗口尺寸失败`);
  try {
    await capture("confirm-wide");
    await setWindowSize([480, 640]);
    await capture("confirm-narrow");
    const probe = await browser.execute((confirmTestId) => {
      const dialog = document.querySelector(
        '[role="dialog"][data-confirm-intent="source-server-stop"]',
      );
      const description = dialog?.querySelector<HTMLElement>('[data-slot="dialog-description"]');
      const confirm = dialog?.querySelector<HTMLElement>(`[data-testid="${confirmTestId}"]`);
      if (!description || !confirm) return null;
      const synthetic = document.createElement("span");
      synthetic.setAttribute("data-e2e-synthetic-task-list", "");
      synthetic.textContent = `\n${Array.from(
        { length: 40 },
        (_, index) =>
          `synthetic-session-${index} — /home/dev/projects/a-very-long-workspace-directory-name-without-spaces-${index}`,
      ).join("\n")}`;
      description.append(synthetic);
      return {
        overflowY: getComputedStyle(description).overflowY,
        scrollable: description.scrollHeight > description.clientHeight,
        horizontalOverflow: description.scrollWidth > description.clientWidth,
        footerInViewport: confirm.getBoundingClientRect().bottom <= window.innerHeight,
      };
    }, TID_CONFIRM_DIALOG_CONFIRM);
    if (!probe) throw new Error(`${CASE_MARKER}: 确认弹窗缺少说明区或确认按钮`);
    await capture("confirm-narrow-long-list");
    await browser.execute(() => {
      document.querySelector("[data-e2e-synthetic-task-list]")?.remove();
    });
    return probe;
  } finally {
    await setWindowSize(original);
    await setTheme("light");
  }
}

describe(`${CASE_MARKER}: 设备卡停止远端服务`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-BLD-10 从设备卡「更多」停止远端服务：进程退出、保持未连接且不被自动拉起，再连接可恢复", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const [workspacePath] = config.workspacePaths;
    const facts: Record<string, unknown> = {};
    // 本机 runner 每次新建专用容器；基线只排除开发者自己开着的会话。
    const sshSessionsBaseline = await countOtherSSHSessions(config);
    facts.sshSessionsBaseline = sshSessionsBaseline;

    const project = await connectSSHWorkspace({ config, caseMarker: CASE_MARKER, workspacePath });
    const sourceId = parseRemoteWorkspaceIdentity(project.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 首连缺少设备身份`);
    const running = await readRemoteDaemon(config);
    expect(running.state).toBe("ready");
    expect(running.alive).toBeGreaterThanOrEqual(2);
    facts.running = running;
    // 在线时本机持有会话，证明下方“停止后回到基线”的读数不是空断言。
    const sshSessionsOnline = await countOtherSSHSessions(config);
    expect(sshSessionsOnline).toBeGreaterThan(sshSessionsBaseline);
    facts.sshSessionsOnline = sshSessionsOnline;

    await openRemoteDevicesSettings();
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);

    // 1. 危险确认默认聚焦取消，回车不执行：远端服务保持运行，设备仍在线。
    const item = await openStopMenuItem(sourceId);
    expect(await item.getAttribute("data-disabled")).toBeNull();
    expect(await item.getAttribute("data-variant")).toBe("destructive");
    facts.remoteRunningTasksBeforeFirstConfirm = await readRemoteRunningTasksOutput(config);
    await item.click();
    await stopDialog().waitForDisplayed({ timeout: 15_000 });
    // RDLC #05：先读取运行中任务再确认。说明含中断说明、任务清单段（刚启动的远端可能尚未上报清单，
    // 此时显示设备未提供）、其他电脑的影响，以及仅停止且启动自动重连开启（默认）时的下次启动提示。
    const confirmText = await stopDialog().getText();
    expect(confirmText).toMatch(/中断此设备上所有运行中的任务|interrupts all running tasks/u);
    expect(confirmText).toMatch(
      /此设备当前没有运行中的任务|设备未提供任务清单|No tasks are running|didn't provide a task list/u,
    );
    expect(confirmText).toMatch(/其他电脑上的 ZCode|ZCode on another computer/u);
    expect(confirmText).toMatch(/下次打开 ZCode 时会重新启动远端服务|next time you open ZCode/u);
    facts.confirmText = confirmText;
    const focused = await browser.execute(() => document.activeElement?.textContent ?? "");
    expect(["取消", "Cancel"].some((label) => focused.includes(label))).toBe(true);
    await browser.keys("Enter");
    await stopDialog().waitForDisplayed({ reverse: true, timeout: 15_000 });
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);
    expect((await readRemoteDaemon(config)).supervisorPid).toBe(running.supervisorPid);

    // 2. 确认停止：Supervisor 与 Core 退出，锁释放，设备显示未连接。
    // 先等远端上报清单（首个 Core 心跳后输出 []），再打开确认：此时任务清单段必须是“没有运行中的任务”，
    // 证明设备卡读到了真实清单，而不是把读取失败当作结果。
    let remoteRunningTasks = "";
    await browser.waitUntil(
      async () => {
        remoteRunningTasks = await readRemoteRunningTasksOutput(config);
        return remoteRunningTasks === "exit=0 []";
      },
      {
        timeout: 60_000,
        interval: 2_000,
        timeoutMsg: `${CASE_MARKER}: 远端未上报运行中任务清单；latest=${remoteRunningTasks}`,
      },
    );
    const confirmItem = await openStopMenuItem(sourceId);
    await captureThemeScreenshots("menu");
    await confirmItem.click();
    await stopDialog().waitForDisplayed({ timeout: 15_000 });
    const reportedConfirmText = await stopDialog().getText();
    expect(reportedConfirmText).toMatch(/此设备当前没有运行中的任务|No tasks are running/u);
    expect(reportedConfirmText).not.toMatch(/设备未提供任务清单|didn't provide a task list/u);
    facts.reportedConfirmText = reportedConfirmText;
    const overflowProbe = await probeConfirmDialogLayouts();
    expect(overflowProbe).toEqual({
      overflowY: "auto",
      scrollable: true,
      horizontalOverflow: false,
      footerInViewport: true,
    });
    facts.confirmOverflowProbe = overflowProbe;
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 15_000 });
    // Host 先断开再执行远端停止：设备卡变为未连接早于停止完成，完成以成功提示为准。
    await waitForDeviceStatus(sourceId, "offline", CASE_MARKER, 90_000);
    let toasts: string[] = [];
    await browser.waitUntil(
      async () => {
        toasts = await getToastMessages();
        return toasts.some(
          (message) => message.includes("已停止") || message.includes("Stopped the remote service"),
        );
      },
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 没有停止成功提示；latest=${JSON.stringify(toasts)}`,
      },
    );
    const stopped = await readRemoteDaemon(config);
    expect(stopped.alive).toBe(0);
    expect(stopped.supervisorPid).toBeNull();
    expect(stopped.state).toBe("stopped");
    facts.stopped = stopped;
    // 停止后本机不再连着设备：断开与停止命令用过的 SSH 会话都已释放，只剩基线。
    // sshd 退出有少许延迟，先等读数回到基线；超时后由 expect 报出最后一次读数。
    let sshSessionsAfterStop = -1;
    await browser
      .waitUntil(
        async () => {
          sshSessionsAfterStop = await countOtherSSHSessions(config);
          return sshSessionsAfterStop === sshSessionsBaseline;
        },
        { timeout: 15_000, interval: 1_000 },
      )
      .catch(() => undefined);
    expect(sshSessionsAfterStop).toBe(sshSessionsBaseline);
    facts.sshSessionsAfterStop = sshSessionsAfterStop;

    // 3. 等过一个自动重试周期：本机不会把远端服务重新拉起，设备仍是未连接。
    await browser.pause(AUTOMATIC_RETRY_CYCLE_MS);
    const afterRetryCycle = await readRemoteDaemon(config);
    expect(afterRetryCycle.alive).toBe(0);
    expect(afterRetryCycle.supervisorPid).toBeNull();
    await waitForDeviceStatus(sourceId, "offline", CASE_MARKER, 5_000);
    facts.afterRetryCycle = afterRetryCycle;

    // 4. 再点“连接”照常启动远端服务：新 Supervisor/Core 就绪，设备回到已连接。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER, 120_000);
    // 设置页连接留在设备管理（RDUX-27）；等向导真正收起，避免迟到导航影响后续断言。
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("closed");
    const restarted = await readRemoteDaemon(config);
    expect(restarted.state).toBe("ready");
    expect(restarted.alive).toBeGreaterThanOrEqual(2);
    expect(restarted.supervisorPid).not.toBe(running.supervisorPid);
    expect(restarted.corePid).not.toBe(running.corePid);
    facts.restarted = restarted;
    expect(await readHostProcesses()).toEqual(hosts);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "stop-remote-service.json"),
      JSON.stringify(facts, null, 2),
    );
  });
});
