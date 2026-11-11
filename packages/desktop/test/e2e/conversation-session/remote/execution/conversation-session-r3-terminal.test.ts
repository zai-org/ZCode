import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { TID_TERMINAL, TID_TERMINAL_TOGGLE } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { selectV4TaskById } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_TERMINAL";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-terminal");
const run = promisify(execFile);

async function severDesktopSshSessions(container: string): Promise<string> {
  const script = [
    "target_uid=$(id -u dev); killed=''",
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = 1 ] && continue',
    "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue; case \"$c\" in *sshd*) ;; *) continue;; esac",
    'uid=$(awk \'/^Uid:/ {print $2}\' "$d/status"); [ "$uid" = "$target_uid" ] || continue',
    'parent=$(awk \'{print $4}\' "$d/stat"); kill -9 "$p" 2>/dev/null && killed="$killed $p"',
    '[ "$parent" != 1 ] && kill -9 "$parent" 2>/dev/null && killed="$killed $parent"; done',
    "echo $killed",
  ].join("; ");
  return (await run("docker", ["exec", container, "sh", "-c", script])).stdout.trim();
}

/** 远端 PTY shell 数：cwd 等于给定 workspace 的交互 shell（不含测试自身的 exec 会话）。 */
async function countRemoteShells(
  config: SSHConnectionConfig,
  workspacePath: string,
): Promise<number> {
  const result = await runSSHCommand(
    config,
    `n=0; for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *bas[h]*|*zs[h]*|*"/bin/s"[h]*) [ "$(readlink $d/cwd 2>/dev/null)" = "${workspacePath}" ] && n=$((n+1));; esac; done; echo $n`,
  );
  return Number.parseInt(result.stdout.trim() || "0", 10);
}

/** 项目行点击只展开任务列表；切换 active workspace 走该 workspace 的 task 行（与其它 R3 用例一致）。 */
async function selectWorkspaceTab(taskId: string): Promise<void> {
  await selectV4TaskById(taskId, 30_000);
}

async function openTerminalAndWaitPrompt(): Promise<void> {
  const open = await browser.execute(
    (terminalTestId) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${terminalTestId}"] .xterm-rows`),
      ).some((row) => row.offsetParent !== null),
    TID_TERMINAL,
  );
  if (!open) {
    await clickTestIdByDom(TID_TERMINAL_TOGGLE, {
      timeoutMsg: `${CASE_MARKER}: Terminal 入口不可点击`,
    });
  }
  await waitForTestIdByDom(TID_TERMINAL, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: Terminal 没有打开`,
  });
  // 0911 修复：原写法 `() => async () => …` 返回函数对象（恒 truthy），45s 的
  // prompt 等待被短路成立即通过——PTY 未就绪即开始输入，首批按键全丢（swap 慢机
  // 下两次同点 FAIL 实锤）。改为真正的 async 条件。
  await browser.waitUntil(
    async () => {
      const text = await terminalText();
      return /[$#]\s*$/.test(text) || /TICK|R3_TERM/u.test(text);
    },
    { timeout: 45_000, timeoutMsg: `${CASE_MARKER}: 远端 shell 提示符未出现` },
  );
}

/** 经当前窗口的真实文本输入通路写入一次；不因回显失败而重复执行命令。 */
async function typeInTerminal(command: string): Promise<void> {
  const focused = await browser.execute((terminalTestId) => {
    const area = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>(
        `[data-testid="${terminalTestId}"] .xterm-helper-textarea`,
      ),
    ).findLast((item) => item.closest<HTMLElement>(".xterm")?.offsetParent !== null);
    area?.focus();
    return Boolean(area && document.activeElement === area);
  }, TID_TERMINAL);
  expect(focused).toBe(true);
  // 旧测试按块重发并退格清理，录像已出现输入被截断和覆盖；单次 paste 事件经过 xterm 自身输入处理，不修改系统剪贴板或直接调用 PTY。
  await browser.execute((text) => {
    const input = document.activeElement;
    if (
      !(input instanceof HTMLTextAreaElement) ||
      !input.classList.contains("xterm-helper-textarea")
    )
      throw new Error("Terminal input lost focus");
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, command);
  try {
    await browser.waitUntil(async () => (await terminalText()).includes(command), {
      timeout: 8000,
      interval: 200,
      timeoutMsg: `${CASE_MARKER}: 终端未完整回显输入命令`,
    });
  } catch (error) {
    await writeFile(
      resolve(artifactDir, "terminal-input-failure.json"),
      JSON.stringify(
        {
          command,
          actual: await terminalText(),
          dom: await browser.execute(
            (terminalTestId) => ({
              active: document.activeElement?.outerHTML,
              rows: Array.from(
                document.querySelectorAll(`[data-testid="${terminalTestId}"] .xterm-rows`),
              ).map((row) => row.outerHTML),
            }),
            TID_TERMINAL,
          ),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  await browser.execute(() => {
    const events: unknown[] = [];
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      queueMicrotask(() =>
        events.push({
          type: event.type,
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          prevented: event.defaultPrevented,
          target: target?.outerHTML,
          active: document.activeElement?.outerHTML,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
        }),
      );
    };
    document.addEventListener("keydown", listener, true);
    document.addEventListener("keyup", listener, true);
    (window as unknown as { __terminalKeys: { read(): unknown[] } }).__terminalKeys = {
      read() {
        document.removeEventListener("keydown", listener, true);
        document.removeEventListener("keyup", listener, true);
        return events;
      },
    };
  });
  await browser.keys("Enter");
  const keys = await browser.execute(() =>
    (window as unknown as { __terminalKeys: { read(): unknown[] } }).__terminalKeys.read(),
  );
  await writeFile(resolve(artifactDir, "terminal-key-events.json"), JSON.stringify(keys, null, 2));
}

/** 面板可能同时挂载多个 workspace 的 xterm（非 active 的隐藏）；只读取可见实例。 */
async function terminalText(): Promise<string> {
  return browser.execute((terminalTestId) => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="${terminalTestId}"] .xterm-rows`),
    );
    const visible = rows.filter(
      (row) => row.getClientRects().length > 0 && row.offsetParent !== null,
    );
    // DOM 行末补齐空白不属于命令；拼回软换行后再核对完整回显。
    return Array.from((visible.at(-1) ?? rows.at(-1))?.children ?? [])
      .map((row) => (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd())
      .join("");
  }, TID_TERMINAL);
}

async function waitTerminalIncludes(marker: string, timeout = 60_000): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = await terminalText();
      return text.includes(marker);
    },
    { timeout, interval: 300, timeoutMsg: `${CASE_MARKER}: Terminal 没有显示 ${marker}` },
  );
  return text;
}

function tickCount(text: string): number {
  return (text.match(/TICK-\d+/gu) ?? []).length;
}

/** 视口内可见的最大 TICK 序号；没有 TICK 时为 0。 */
function maxTick(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/TICK-(\d+)/gu), (match) => Number(match[1])));
}

/**
 * 面板收起态：AnimatedTerminalPanel 收起时把 Terminal 包在 aria-hidden 容器里并把 ResizablePanel 折叠到 0px，
 * DOM 保持挂载。只看真正承载 xterm 的 Terminal 区块（含 .xterm-rows），全部处于收起态才算收起。
 */
async function isTerminalPanelHidden(): Promise<boolean> {
  return browser.execute((terminalTestId) => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="${terminalTestId}"]`),
    ).filter((section) => section.querySelector(".xterm-rows"));
    if (sections.length === 0) return false;
    return sections.every((section) => {
      if (section.closest('[aria-hidden="true"]')) return true;
      const panel = section.closest<HTMLElement>("[data-panel]");
      return Boolean(panel) && panel!.getBoundingClientRect().height === 0;
    });
  }, TID_TERMINAL);
}

/** 面板取证：aria-hidden 祖先链、所在 ResizablePanel 的尺寸/透明度、开关按钮状态。 */
async function captureTerminalPanelDiagnostics(): Promise<Record<string, unknown>> {
  return browser.execute(
    (terminalTestId, toggleTestId) => {
      const section = document.querySelector<HTMLElement>(`[data-testid="${terminalTestId}"]`);
      const ariaChain: string[] = [];
      let node: HTMLElement | null = section;
      while (node && ariaChain.length < 12) {
        if (node.hasAttribute("aria-hidden")) {
          ariaChain.push(`${node.tagName.toLowerCase()}:${node.getAttribute("aria-hidden")}`);
        }
        node = node.parentElement;
      }
      const panel =
        section?.closest<HTMLElement>("[data-panel]") ??
        section?.closest<HTMLElement>("[data-panel-id]");
      const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="${toggleTestId}"]`);
      const sectionRect = section?.getBoundingClientRect();
      const sections = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${terminalTestId}"]`),
      ).map((item) => {
        const ancestors: string[] = [];
        let cursor = item.parentElement;
        while (cursor && ancestors.length < 4) {
          ancestors.push(
            `${cursor.tagName.toLowerCase()}${cursor.dataset.panel !== undefined ? "[data-panel]" : ""}${cursor.hasAttribute("aria-hidden") ? `[aria-hidden=${cursor.getAttribute("aria-hidden")}]` : ""}`,
          );
          cursor = cursor.parentElement;
        }
        return {
          ancestors,
          hasXtermRows: Boolean(item.querySelector(".xterm-rows")),
          height: Math.round(item.getBoundingClientRect().height),
          panelHeight: Math.round(
            item.closest("[data-panel]")?.getBoundingClientRect().height ?? -1,
          ),
        };
      });
      return {
        ariaChain,
        sections,
        activeElement: document.activeElement?.tagName.toLowerCase() ?? null,
        panel: panel
          ? {
              flexGrow: getComputedStyle(panel).flexGrow,
              height: Math.round(panel.getBoundingClientRect().height),
              opacity: getComputedStyle(panel).opacity,
            }
          : null,
        sectionCount: document.querySelectorAll(`[data-testid="${terminalTestId}"]`).length,
        sectionHeight: sectionRect ? Math.round(sectionRect.height) : null,
        toggleCount: document.querySelectorAll(`[data-testid="${toggleTestId}"]`).length,
        toggleDisabled: toggle?.disabled ?? null,
        toggleSelected: toggle?.className.includes("bg-selected") ?? null,
      };
    },
    TID_TERMINAL,
    TID_TERMINAL_TOGGLE,
  );
}

/** 点击终端面板头部按钮（按 aria-label 匹配中英文文案）。 */
async function clickTerminalButtonByLabel(labels: string[]): Promise<void> {
  const clicked = await browser.execute(
    (terminalTestId, candidates) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          `[data-testid="${terminalTestId}"] button[aria-label]`,
        ),
      );
      const target = buttons.find((button) =>
        candidates.includes(button.getAttribute("aria-label") ?? ""),
      );
      target?.click();
      return Boolean(target);
    },
    TID_TERMINAL,
    labels,
  );
  if (!clicked) throw new Error(`${CASE_MARKER}: 终端面板没有找到按钮 ${labels.join("/")}`);
}

/** 关闭当前激活的终端 tab：tab 触发器内容标记为 data-terminal-tab-content，其父级带 data-active。 */
async function closeActiveTerminalTab(): Promise<void> {
  const clicked = await browser.execute((terminalTestId) => {
    const contents = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid="${terminalTestId}"] [data-terminal-tab-content]`,
      ),
    );
    const activeTrigger = contents
      .map((content) => content.parentElement)
      .find((trigger) => trigger?.hasAttribute("data-active"));
    const close = activeTrigger?.querySelector<HTMLButtonElement>("button");
    close?.click();
    return Boolean(close);
  }, TID_TERMINAL);
  if (!clicked) throw new Error(`${CASE_MARKER}: 没有找到激活终端 tab 的关闭按钮`);
}

describe(`${CASE_MARKER}: 远端终端长命令、跨 workspace 归属、断线恢复与关闭回收`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};
  let releaseLongCommand: (() => Promise<unknown>) | undefined;

  after(async () => {
    await releaseLongCommand?.().catch(() => undefined);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "terminal.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-03 A 终端长命令持续输出；切到 B 的终端 cwd 归属正确；断线恢复后 A 输出仍在；关闭终端回收远端 PTY", async function () {
    this.timeout(30 * 60_000);
    const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const releaseFile = `.r3-terminal-${Date.now().toString(36)}.stop`;
    releaseLongCommand = () => runSSHCommand(prepared.config, `: > '${workspaceA}/${releaseFile}'`);
    const shellsBeforeA = await countRemoteShells(prepared.config, workspaceA);
    const shellsBeforeB = await countRemoteShells(prepared.config, workspaceB);

    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });
    const hosts = await readHostProcesses();

    // A：命令持续到用例回收 PTY，不让固定 90 秒窗口在慢机上先于关键断言结束。
    await selectWorkspaceTab(taskA.taskId);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    await openTerminalAndWaitPrompt();
    await typeInTerminal(
      `pwd; i=0; while [ ! -f ${releaseFile} ]; do i=$((i+1)); echo TICK-$i; sleep 1; done; rm -f ${releaseFile}`,
    );
    const aText = await waitTerminalIncludes("TICK-3");
    expect(aText).toContain(workspaceA);
    await browser.waitUntil(
      async () => (await countRemoteShells(prepared.config, workspaceA)) > shellsBeforeA,
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 远端没有出现 A 的 PTY shell`,
      },
    );
    facts.shellsA = {
      before: shellsBeforeA,
      during: await countRemoteShells(prepared.config, workspaceA),
    };

    // B：切 tab 后终端属于 B（cwd 为 B），不串 A 的输出。
    await selectWorkspaceTab(taskB.taskId);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
    });
    await openTerminalAndWaitPrompt();
    // 面板 open 状态是全局的，但会话按 workspaceKey 隔离：切到 B 后应看到 B 自己的 shell，而不是 A 的 TICK 输出。
    await browser.waitUntil(async () => !(await terminalText()).includes("TICK-"), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 切到 B 后终端仍显示 A 的输出`,
    });
    // 用引号拆开标记：只有 shell 真正执行后的输出能命中，输入回显不能冒充执行完成。
    await typeInTerminal('pwd; echo R3_TERM_B_"MARK"');
    const bText = await waitTerminalIncludes("R3_TERM_B_MARK", 20_000);
    expect(bText).toContain("R3_TERM_B_MARK");
    expect(bText).toContain(workspaceB);
    expect(bText).not.toContain("TICK-");
    const shellsDuringB = await countRemoteShells(prepared.config, workspaceB);
    expect(shellsDuringB).toBeGreaterThan(shellsBeforeB);
    facts.shellsB = { before: shellsBeforeB, during: shellsDuringB };

    // 切回 A：输出继续累积（PTY 在远端持续运行）。
    await selectWorkspaceTab(taskA.taskId);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    await openTerminalAndWaitPrompt();
    const beforeSever = maxTick(await waitTerminalIncludes("TICK-", 30_000));
    let afterSwitch = beforeSever;
    // xterm 视口满后可见行数不再增长，最大序号仍能证明命令继续运行。
    await browser.waitUntil(
      async () => {
        afterSwitch = maxTick(await terminalText());
        return afterSwitch > beforeSever;
      },
      { timeout: 20_000, timeoutMsg: `${CASE_MARKER}: 切回 A 后输出没有继续增长` },
    );
    expect(afterSwitch).toBeGreaterThan(beforeSever);
    facts.ticksAcrossTabSwitch = { beforeSever, afterSwitch };

    // 断线恢复：切断 Desktop 的 SSH 会话，自动换代后 A 终端仍可见且继续/保留输出，不串 B。
    facts.severed = await severDesktopSshSessions(container);
    await browser.waitUntil(
      async () => {
        const snapshot = await readRemoteTabSnapshot(taskA.identity).catch(() => null);
        return Boolean(
          snapshot?.remoteSessionId && snapshot.remoteSessionId !== taskA.remoteSessionId,
        );
      },
      { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 断连后没有自动换代` },
    );
    await selectWorkspaceTab(taskA.taskId);
    await openTerminalAndWaitPrompt();
    const recoveredText = await waitTerminalIncludes("TICK-", 60_000);
    expect(recoveredText).not.toContain("R3_TERM_B_MARK");
    facts.terminalAfterRecovery = {
      ticks: tickCount(recoveredText),
      containsDone: recoveredText.includes("R3_TERM_A_DONE"),
      remoteShellsA: await countRemoteShells(prepared.config, workspaceA),
    };
    expect(await readHostProcesses()).toEqual(hosts);

    // 收起面板：产品契约（Terminal.tsx / AnimatedTerminalPanel.tsx）是"关闭面板只收起 UI 并保活 session，
    // 收起时只隐藏不卸载"，远端 PTY 不在此回收。0914 修正：旧断言要求 .xterm-rows 从 DOM 消失，
    // 与自 2026-05 起的多终端保活契约相悖，稳定误报；改为断言面板进入 aria-hidden 隐藏态、PTY 保留、
    // 再次展开后 A 的输出仍在。
    const shellsBeforeCollapse = await countRemoteShells(prepared.config, workspaceA);
    const maxTickBeforeCollapse = maxTick(await terminalText());
    await clickTestIdByDom(TID_TERMINAL_TOGGLE, {
      timeoutMsg: `${CASE_MARKER}: Terminal 关闭入口不可点击`,
    });
    await browser.waitUntil(() => isTerminalPanelHidden(), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 终端面板没有收起`,
    });
    facts.panelCollapsed = await captureTerminalPanelDiagnostics();
    facts.shellsWhileCollapsed = await countRemoteShells(prepared.config, workspaceA);
    expect(facts.shellsWhileCollapsed).toBe(shellsBeforeCollapse);
    await clickTestIdByDom(TID_TERMINAL_TOGGLE, {
      timeoutMsg: `${CASE_MARKER}: Terminal 展开入口不可点击`,
    });
    await browser.waitUntil(async () => !(await isTerminalPanelHidden()), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 终端面板没有重新展开`,
    });
    // 视口行数会随面板高度变化（收起再展开后 xterm 重新 fit），不能用可见 TICK 行数判断保活；
    // 可见的最大 TICK 序号是输出尾部，单调不减，用它证明同一个 shell 仍在持续输出。
    const reopenedText = await waitTerminalIncludes("TICK-", 30_000);
    facts.maxTickAroundCollapse = {
      before: maxTickBeforeCollapse,
      afterReopen: maxTick(reopenedText),
    };
    expect(maxTick(reopenedText)).toBeGreaterThanOrEqual(maxTickBeforeCollapse);

    // 按 terminal 合同回收：关闭一个终端 tab 才释放其 PTY。新建第二个 tab（新 PTY）再关闭它，
    // 远端对应 shell 被回收；A 的首个终端与 B 都不受影响。
    const shellsBeforeNewTab = await countRemoteShells(prepared.config, workspaceA);
    await clickTerminalButtonByLabel(["新建终端", "New terminal"]);
    await browser.waitUntil(
      async () => (await countRemoteShells(prepared.config, workspaceA)) > shellsBeforeNewTab,
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 新建终端 tab 后远端没有出现新的 PTY shell` },
    );
    await openTerminalAndWaitPrompt();
    facts.shellsWithSecondTab = await countRemoteShells(prepared.config, workspaceA);
    await closeActiveTerminalTab();
    let shellsAfterTabClose = facts.shellsWithSecondTab as number;
    await browser.waitUntil(
      async () => {
        shellsAfterTabClose = await countRemoteShells(prepared.config, workspaceA);
        return shellsAfterTabClose <= shellsBeforeNewTab;
      },
      {
        timeout: 60_000,
        interval: 2000,
        timeoutMsg: `${CASE_MARKER}: 关闭终端 tab 后远端 PTY 未回收`,
      },
    );
    facts.shellsAfterTabClose = {
      beforeNewTab: shellsBeforeNewTab,
      afterClose: shellsAfterTabClose,
    };
    expect(await waitTerminalIncludes("TICK-", 30_000)).toContain("TICK-");
    facts.shellsB_afterAClose = await countRemoteShells(prepared.config, workspaceB);
    expect(facts.shellsB_afterAClose).toBe(shellsDuringB);
  });
});
