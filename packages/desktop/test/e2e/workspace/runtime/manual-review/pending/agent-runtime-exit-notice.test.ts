// 后台 runtime（app-server）意外退出后，会话底部给出原因横幅（docs/ui/agent-runtime-exit-notice.md）。
// 复现方式与用户现场一致：直接 SIGKILL app-server 子进程。只在 Linux 上按 /proc 定位本次 E2E 的进程。
// 运行：ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- \
//   --spec './test/e2e/workspace/runtime/manual-review/pending/agent-runtime-exit-notice.test.ts'
// ARE-02 借用 v4 后台工作用例的回放夹具产出一个后台 Bash，并用 prlimit 让 Host 暂时无法创建子进程；需要另设
//   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,\
//     packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-background-work.json
// 未设置时 ARE-02 跳过。
import { execFileSync } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { TID_V4_BACKGROUND_WORK_ITEM, TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared/test-ids";
import { prepareConversationE2E, sendPrompt } from "#e2e/helpers/conversation-session";
import {
  approveV4Permission,
  getV4BackgroundWorks,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";

/**
 * 本次 E2E 工作区的 app-server 进程：命令行含 app-server（或已改名为 zcode-cli），cwd 在本次隔离
 * HOME 的工作区下。
 * 不按环境变量 HOME 判断：Host 给 agent 的 HOME 不一定是 E2E HOME。plugin-workspace 泳道排除。
 */
async function findE2EAppServerPids(homeDir: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      // CLI 启动后把进程标题改成 zcode-cli，会覆盖 cmdline；两种形态都要认。
      if (!cmdline.includes("app-server") && !cmdline[0]?.startsWith("zcode-cli")) continue;
      const cwd = await readlink(`/proc/${entry}/cwd`);
      if (cwd.startsWith(`${homeDir}/`) && !cwd.includes("/.zcode/")) pids.push(Number(entry));
    } catch {
      // 进程在扫描期间退出或不可读：跳过。
    }
  }
  return pids;
}

async function describeAppServers(): Promise<string> {
  const rows: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      if (!cmdline.some((arg) => arg.includes("app-server"))) continue;
      const home = (await readFile(`/proc/${entry}/environ`, "utf8"))
        .split("\0")
        .find((line) => line.startsWith("HOME="));
      rows.push(`${entry} ${cmdline.slice(0, 4).join(" ")} ${home ?? ""}`);
    } catch {
      // 跳过
    }
  }
  return rows.join("; ") || "无";
}

/**
 * 让 Host 进程暂时无法创建子进程（RLIMIT_NPROC 软限制压到 1，fork 返回 EAGAIN），模拟系统资源耗尽时
 * 重新拉起 runtime 失败：spawn 不成功就没有 available，窗格的三次自动重连用完后进入订阅错误态。
 * 只改这一个进程的软限制；返回恢复函数。
 */
function blockHostSpawns(hostPid: number): () => void {
  const pid = String(hostPid);
  const [soft] = execFileSync("prlimit", [
    "--pid",
    pid,
    "--nproc",
    "--output",
    "SOFT",
    "--noheadings",
  ])
    .toString()
    .trim()
    .split(/\s+/);
  execFileSync("prlimit", ["--pid", pid, "--nproc=1:"]);
  return () => execFileSync("prlimit", ["--pid", pid, `--nproc=${soft}:`]);
}

async function readParentPid(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(ppid) || ppid <= 1) throw new Error(`读不到 app-server ${pid} 的父进程`);
  return ppid;
}

function readBackgroundWorkElapsed(workId: string): Promise<string | null> {
  return browser.execute(
    (selector) =>
      document.querySelector<HTMLElement>(`${selector} .tabular-nums`)?.textContent ?? null,
    `[data-testid="${TID_V4_BACKGROUND_WORK_ITEM}-${workId}"]`,
  );
}

describe("后台 runtime 意外退出提示", () => {
  before(function () {
    if (process.platform !== "linux") this.skip();
  });

  it("ARE-01 SIGKILL app-server 后会话底部出现通用原因横幅，可关闭", async function () {
    this.timeout(180_000);
    const homeDir = process.env.ZCODE_E2E_HOME_DIR;
    if (!homeDir) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
    // 发一条消息让工作区确定拉起 runtime（provider 指向不可达的占位地址，本轮请求失败无妨）。
    await prepareConversationE2E();
    await sendPrompt("E2E_ARE01 start the runtime");

    let pids: number[] = [];
    try {
      await browser.waitUntil(
        async () => {
          pids = await findE2EAppServerPids(homeDir);
          return pids.length > 0;
        },
        { timeout: 60_000 },
      );
    } catch {
      throw new Error(
        `工作区没有拉起 app-server（HOME=${homeDir}）：${await describeAppServers()}`,
      );
    }
    expect(await $('[data-testid="agent-runtime-exit-banner"]').isExisting()).toBe(false);

    for (const pid of pids) process.kill(pid, "SIGKILL");

    const banner = $('[data-testid="agent-runtime-exit-banner"]');
    await banner.waitForDisplayed({ timeout: 30_000, timeoutMsg: "app-server 被杀后没有出现横幅" });
    if (process.env.ZCODE_E2E_ARE_SCREENSHOT) {
      await browser.saveScreenshot(process.env.ZCODE_E2E_ARE_SCREENSHOT);
    }
    // Linux 的 SIGKILL 不是可判定的内存不足签名，走通用文案。
    expect(await banner.getAttribute("data-exit-cause")).toBe("unknown");
    expect(await banner.getText()).toMatch(
      /后台运行时异常退出|background runtime exited unexpectedly/,
    );

    // 面板会自动重连并拉起新进程；横幅在用户关闭前保留。
    await browser.waitUntil(async () => (await findE2EAppServerPids(homeDir)).length > 0, {
      timeout: 60_000,
      timeoutMsg: "自动重连没有拉起新的 app-server",
    });
    for (const button of await banner.$$("button")) {
      if (/关闭|Dismiss/.test(await button.getText())) {
        await button.click();
        break;
      }
    }
    await banner.waitForDisplayed({ reverse: true, timeout: 10_000 });
  });

  it("ARE-02 重连失败时原因横幅随错误面板保留；胶囊里后台 Bash 的计时冻结、取消入口隐藏", async function () {
    if (!process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.includes("v4-background-work")) this.skip();
    this.timeout(240_000);
    const homeDir = process.env.ZCODE_E2E_HOME_DIR;
    if (!homeDir) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await sendV4Prompt("E2E_V4_BGWORK 起一个后台任务");
    try {
      await waitForV4PermissionDialog(15_000);
      await approveV4Permission();
    } catch {
      // 默认放行 Bash 时没有权限弹窗。
    }
    // 胶囊的明细行只在展开后渲染：先从 Composer 入口直达展开的运行中明细。
    await openV4ComposerRunningBackgroundWorks(60_000);
    let workId = "";
    await browser.waitUntil(
      async () => {
        workId =
          (await getV4BackgroundWorks()).find((work) => work.status === "running")?.workId ?? "";
        return workId !== "";
      },
      { timeout: 30_000, timeoutMsg: "胶囊里没有出现运行中的后台 Bash" },
    );
    const cancel = $(`[data-testid="v4-background-work-cancel-${workId}"]`);
    await cancel.waitForExist({ timeout: 10_000, timeoutMsg: "在线时应有取消入口" });

    const pids = await findE2EAppServerPids(homeDir);
    if (pids.length === 0)
      throw new Error(`没有找到本次工作区的 app-server：${await describeAppServers()}`);
    const hostPid = await readParentPid(pids[0]!);
    const restoreSpawns = blockHostSpawns(hostPid);
    try {
      for (const pid of pids) process.kill(pid, "SIGKILL");
      await $(`[data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`).waitForDisplayed({
        timeout: 60_000,
        timeoutMsg: "runtime 拉不起来时窗格没有进入订阅错误态",
      });
      // 三项各自独立，收齐后一起断言，任何一项回退都能单独看出来。
      const problems: string[] = [];
      // 错误面板替换了时间线；原因横幅要跟着留在窗格里。
      const bannerShown = await $('[data-testid="agent-runtime-exit-banner"]')
        .waitForDisplayed({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        );
      if (!bannerShown) problems.push("重连失败后原因横幅消失了");
      if (process.env.ZCODE_E2E_ARE_SCREENSHOT) {
        await browser.saveScreenshot(
          process.env.ZCODE_E2E_ARE_SCREENSHOT.replace(/(\.png)?$/, "-errored.png"),
        );
      }
      // 胶囊仍显示断开前的后台 Bash，但计时停住、取消入口隐藏（目标执行已不存在）。
      const before = await readBackgroundWorkElapsed(workId);
      if (before === null) throw new Error("错误态下胶囊里找不到该后台 Bash 的计时");
      await browser.pause(2_500);
      const after = await readBackgroundWorkElapsed(workId);
      if (after !== before) problems.push(`离线时计时仍在走：${before} → ${after}`);
      if (await cancel.isExisting()) problems.push("离线时仍显示取消按钮");
      expect(problems).toEqual([]);
    } finally {
      restoreSpawns();
    }

    // 停止干预后用错误面板的「重新连接」恢复，横幅在用户关闭前保留。
    await $(`[data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`).click();
    await $(`[data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`).waitForExist({
      reverse: true,
      timeout: 60_000,
      timeoutMsg: "手动重新连接后仍停在错误面板",
    });
    await $('[data-testid="agent-runtime-exit-banner"]').waitForDisplayed({ timeout: 10_000 });
  });
});
