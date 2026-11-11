import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const paths = getE2EAppDataPaths();
const LONG_MARKER = "E2E_TRJ07_VIRTUAL_FOLDED_TARGET";
const SEARCH_MARKER = "E2E_TRJ06_SHARED_MATCH";
const DELTA_MARKER = "E2E_TRJ02_DELTA_USER";
const RECENT_TAIL_MARKER = "E2E_TRJ09_RECENT_TAIL";
type ActualTrajectoryRecord = {
  type?: string;
  sessionId?: string;
  response?: { text?: string; reasoningText?: string };
};

describe("模型调用轨迹查看器 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TRJ01-TRJ09: 写入、投影、交互、虚拟搜索、窄布局与有界尾读", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await setRendererLocale("zh-CN");
    await sendV4Prompt("E2E_TRJ_TASK_SEED reply with E2E_TRJ_TASK_READY");
    await waitForV4TimelineContaining("E2E_TRJ_TASK_READY", 45_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null && snapshot.sessionId !== "draft",
      "trajectory case 没有建立真实 task/session",
      45_000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId as string;

    const actualTrajectoryFile = await waitForActualTrajectory(taskId);
    expect(
      actualTrajectoryFile.records.some((record) => record.response?.text === "E2E_TRJ_TASK_READY"),
    ).toBe(true);
    expect(
      actualTrajectoryFile.records.some(
        (record) => record.response?.reasoningText === "E2E_TRJ_ACTUAL_REASONING",
      ),
    ).toBe(true);

    await seedTrajectory(taskId, actualTrajectoryFile.filePath);
    await seedUnreadableTrajectoryCandidate(actualTrajectoryFile.filePath);
    await openTrajectoryThroughTaskMenu(taskId);
    await waitForTrajectory();

    const initial = await trajectorySnapshot();
    expect(initial.callCount).toBeLessThan(90);
    expect(initial.callCount).toBeGreaterThan(0);
    expect(initial.expandedCount).toBeGreaterThanOrEqual(6);
    expect(initial.copyCount).toBeGreaterThan(0);
    expect(initial.sourceKinds).toContain("main");
    expect(initial.querySources).toContain("main_turn");
    expect(initial.finishReasons).toEqual(
      expect.arrayContaining(["length", "content-filter", "tool-calls"]),
    );
    expect(initial.expandedRoles).toEqual(
      expect.arrayContaining([
        "system",
        "user",
        "reasoning",
        "assistant",
        "tool-call",
        "tool-result",
      ]),
    );
    expect(initial.text).toContain("主会话");
    expect(initial.text).toContain("系统提示词");
    expect(initial.text).toContain("用户消息");
    expect(initial.text).toContain("思考过程");
    expect(initial.text).toContain("助手消息");
    expect(initial.text).toContain("工具调用");
    expect(initial.text).toContain("工具结果");
    expect(initial.text).toContain("mcp__computer-use__open_application_with_full_name");
    expect(initial.text).toContain("e2e_trj_0");
    expect(initial.text).toContain(DELTA_MARKER);
    expect(initial.text).not.toContain("E2E_TRJ02_OLD_ASSISTANT_INPUT");
    expect(initial.text).toContain("E2E_TRJ02_ERROR_VALUE");
    expect(initial.errorIconCount).toBeGreaterThan(0);
    expect(initial.callErrorCount).toBeGreaterThan(0);
    expect(initial.text).toContain("达到长度限制");
    expect(initial.text).toContain("内容过滤");
    expect(initial.text).toContain("custom-e2e-finish");
    expect(initial.text).toContain("1.25s");

    // TRJ02：错误投影和工具元数据必须从真实 host 文件读取链路进入 UI。
    // 首屏同时包含 full→delta 与错误 payload，能直接区分“仅写 fixture”与 UI 投影成功。

    // TRJ03：默认展开；点击整行收起再恢复，复制按钮只在展开态存在，原始换行保留。
    const beforeCollapse = await trajectoryRoleRowSnapshot("system");
    expect(beforeCollapse.state).toBe("open");
    expect(beforeCollapse.copyVisible).toBe(true);
    await installClipboardCapture();
    await clickFirst(
      '[data-trajectory-expandable-role="system"] [data-trajectory-message-copy=""]',
    );
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (
            (window as unknown as { __e2eTrajectoryClipboard?: string }).__e2eTrajectoryClipboard ??
            ""
          ).includes("SYSTEM LINE 2"),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "展开态复制没有写入完整 system 正文",
      },
    );
    await clickFirst(
      '[data-trajectory-expandable-role="system"] [data-trajectory-message-trigger=""]',
    );
    const collapsed = await trajectoryRoleRowSnapshot("system");
    expect(collapsed.state).toBe("closed");
    expect(collapsed.copyVisible).toBe(false);
    await clickFirst(
      '[data-trajectory-expandable-role="system"] [data-trajectory-message-trigger=""]',
    );
    const reexpanded = await trajectoryRoleRowSnapshot("system");
    expect(reexpanded.state).toBe("open");
    expect(reexpanded.copyVisible).toBe(true);
    expect(reexpanded.hasOverflowToggle).toBe(true);
    expect(reexpanded.text).toMatch(/SYSTEM LINE 1[\s\S]*SYSTEM LINE 2/);
    const overflowLabel = await firstText('[data-trajectory-overflow-toggle=""]');
    // 修复原因：矮窗口（Windows CI 800px）下 system 行位于视口上方，DOM click 会点到
    // 用户看不见的按钮；展开后虚拟列表补偿滚动，把该行移出挂载窗口，行内展开状态随卸载丢失。
    // 用户只能点击可见的按钮，所以先把按钮滚入视口再操作。
    await clickVisible('[data-trajectory-overflow-toggle=""]');
    await browser.waitUntil(
      async () => (await firstText('[data-trajectory-overflow-toggle=""]')) !== overflowLabel,
      { timeout: 10_000, timeoutMsg: "超长正文没有切换为完整展开态" },
    );
    await clickVisible('[data-trajectory-overflow-toggle=""]');

    // TRJ04：全局命令直接派生收起状态；自定义菜单分别只打开 reasoning/tool-result。
    await clickFirst('[data-trajectory-toggle-all=""]');
    await browser.waitUntil(async () => (await trajectorySnapshot()).expandedCount === 0, {
      timeout: 10_000,
      timeoutMsg: "全部收起没有覆盖六类内容",
    });
    await waitForToggleAllAction(["Expand all", "全部展开"]);
    await clickNative('[data-trajectory-custom-expansion=""]');
    await clickNative('[data-trajectory-expansion-kind="reasoning"]');
    await clickNative('[data-trajectory-expansion-kind="tool-result"]');
    await browser.keys("Escape");
    await browser.waitUntil(
      async () => {
        const roles = (await trajectorySnapshot()).expandedRoles;
        return (
          roles.includes("reasoning") &&
          roles.includes("tool-result") &&
          roles.every((role) => role === "reasoning" || role === "tool-result")
        );
      },
      { timeout: 10_000, timeoutMsg: "自定义展开没有只展开 reasoning 与 tool-result" },
    );

    // TRJ05：长列表只挂载窗口附近行；用户 override 跨真实虚拟卸载/重挂载保持。
    const virtual = await trajectorySnapshot();
    expect(virtual.callCount).toBeLessThan(80);
    expect(virtual.virtualRowCount).toBeLessThan(80);
    await verifyVirtualizedExpansionPersistence(42);

    // TRJ06：多匹配导航更新活动索引，清空后搜索栏关闭。
    await searchAndNavigate(SEARCH_MARKER);
    const firstSearch = await searchSnapshot();
    expect(firstSearch.counter).toMatch(/1\s*\/\s*2/);
    await waitForSearchHighlights(1, 1);
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await searchSnapshot()).counter?.match(/2\s*\/\s*2/) != null,
      {
        timeout: 10_000,
        timeoutMsg: "下一个搜索结果没有更新活动索引",
      },
    );
    await browser.keys(["Shift", "Enter"]);
    await browser.waitUntil(
      async () => (await searchSnapshot()).counter?.match(/1\s*\/\s*2/) != null,
      {
        timeout: 10_000,
        timeoutMsg: "上一个搜索结果没有更新活动索引",
      },
    );
    await waitForSearchHighlights(1, 1);
    await setSearchValue("E2E_TRJ06_NO_MATCH");
    await browser.waitUntil(
      async () => (await searchSnapshot()).counter?.match(/0\s*\/\s*0/) != null,
      {
        timeout: 10_000,
        timeoutMsg: "无结果搜索没有归零计数器",
      },
    );
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await searchHighlightSnapshot()).registered, {
      timeout: 10_000,
      timeoutMsg: "关闭搜索后 CSS highlight registry 没有清空",
    });

    // TRJ07：虚拟窗口外、折叠正文中的唯一命中会自动挂载并展开。
    await searchAndNavigate(LONG_MARKER);
    await browser.waitUntil(
      async () => {
        const snapshot = await trajectorySnapshot();
        return snapshot.expandedText.includes(LONG_MARKER);
      },
      { timeout: 15_000, timeoutMsg: "虚拟窗口外的折叠命中没有自动展开并定位" },
    );

    // TRJ08：窄视口中共享操作列不横跳，完整 tool name 仍存在于 DOM。
    await setCurrentElectronRendererContentSize(760, 720);
    const narrow = await trajectorySnapshot();
    expect(narrow.text).toContain("mcp__computer-use__open_application_with_full_name");
    expect(narrow.pageHorizontalOverflow).toBe(false);
    expect(narrow.chevronRightEdgeDelta).toBeLessThanOrEqual(2);

    // TRJ09：稀疏扩展到 33 MiB 后只读取尾部完整记录，并显式呈现 truncated。
    await seedOversizedTrajectoryTail(actualTrajectoryFile.filePath, taskId);
    await clickFirst('[aria-label="Refresh"], [aria-label="刷新"]');
    await browser.waitUntil(
      async () => {
        const snapshot = await trajectorySnapshot();
        return snapshot.text.includes(RECENT_TAIL_MARKER) && snapshot.truncatedNoticeCount === 1;
      },
      { timeout: 20_000, timeoutMsg: "有界尾部读取没有保留 recent record 或 truncated 提示" },
    );
  });
});

async function seedTrajectory(taskId: string, filePath: string) {
  const safeTaskId = taskId
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const records = Array.from({ length: 80 }, (_, index) => createRecord(taskId, index));
  expect(filePath.endsWith(`model-io-${safeTaskId || "no-session"}.jsonl`)).toBe(true);
  await appendFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

async function seedUnreadableTrajectoryCandidate(actualFilePath: string) {
  // 修复原因：Windows 路径分隔符是反斜杠，旧的 includes("/debug/") 永远为 false，
  // 会对已存在的 model-io 文件本身 mkdir 并报 EEXIST；按父目录名判断模式才跨平台。
  const otherMode = basename(dirname(actualFilePath)) === "debug" ? "rollout" : "debug";
  await mkdir(join(paths.storageRoot, "cli", otherMode, basename(actualFilePath)), {
    recursive: true,
  });
}

async function waitForActualTrajectory(taskId: string): Promise<{
  filePath: string;
  records: ActualTrajectoryRecord[];
}> {
  const safeTaskId = taskId
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const fileName = `model-io-${safeTaskId || "no-session"}.jsonl`;
  const candidates = ["debug", "rollout"].map((mode) =>
    join(paths.storageRoot, "cli", mode, fileName),
  );
  let result: { filePath: string; records: ActualTrajectoryRecord[] } | null = null;

  await browser.waitUntil(
    async () => {
      for (const filePath of candidates) {
        const records = await readTrajectoryRecords(filePath, taskId);
        if (
          records.some(
            (record) =>
              record.response?.text === "E2E_TRJ_TASK_READY" &&
              record.response?.reasoningText === "E2E_TRJ_ACTUAL_REASONING",
          )
        ) {
          result = { filePath, records };
          return true;
        }
      }
      return false;
    },
    { timeout: 20_000, timeoutMsg: "CLI 没有写出包含 reasoningText 的真实 model-io" },
  );

  return result as NonNullable<typeof result>;
}

async function readTrajectoryRecords(filePath: string, taskId: string) {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ActualTrajectoryRecord];
      } catch {
        return [];
      }
    })
    .filter((record) => record.type === "model_io" && record.sessionId === taskId);
}

function createRecord(taskId: string, index: number) {
  const callId = `call_e2e_trj_${index}`;
  const userContent =
    index === 55
      ? `folded prefix\n${LONG_MARKER}\nfolded suffix`
      : index === 1 || index === 42
        ? `user ${SEARCH_MARKER} ${index}`
        : `user message ${index}`;
  const request =
    index === 3
      ? {
          messagesKind: "full",
          messageOffset: 0,
          messageCount: 1,
          messages: [{ role: "user", content: "E2E_TRJ02_DELTA_BASELINE" }],
          toolNames: ["mcp__computer-use__open_application_with_full_name"],
        }
      : index === 4
        ? {
            messagesKind: "delta",
            messageOffset: 1,
            messageCount: 3,
            messages: [
              { role: "assistant", content: "E2E_TRJ02_OLD_ASSISTANT_INPUT" },
              { role: "user", content: DELTA_MARKER },
            ],
            toolNames: ["mcp__computer-use__open_application_with_full_name"],
          }
        : {
            messages:
              index === 0
                ? [
                    {
                      role: "system",
                      content: `SYSTEM LINE 1\n${"overflow content line\n".repeat(80)}SYSTEM LINE 2`,
                    },
                    { role: "user", content: userContent },
                    {
                      role: "tool",
                      content: `tool output ${index}`,
                      toolCallId: callId,
                      toolName: "mcp__computer-use__open_application_with_full_name",
                    },
                  ]
                : index === 2
                  ? [
                      { role: "user", content: userContent },
                      {
                        role: "tool",
                        content: "E2E_TRJ02_ERROR_VALUE\nstack line",
                        toolCallId: callId,
                        toolName: "mcp__computer-use__open_application_with_full_name",
                        isError: true,
                      },
                    ]
                  : [
                      {
                        role: "user",
                        content: index === 1 ? [{ type: "text", text: userContent }] : userContent,
                      },
                    ],
            toolNames: ["mcp__computer-use__open_application_with_full_name"],
          };

  return {
    type: "model_io",
    sessionId: taskId,
    requestId: `e2e-trj-request-${String(index).padStart(3, "0")}`,
    querySource: index === 42 || index === 55 ? "prompt_enhance" : "main_turn",
    attempt: index === 2 ? 2 : 1,
    startedAt: new Date(Date.UTC(2026, 7, 24, 2, 0, index)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 7, 24, 2, 0, index, 250)).toISOString(),
    durationMs: index === 0 ? 1250 : 250 + index,
    model: { modelId: "e2e-trajectory-model", providerId: "e2e-provider" },
    request,
    response: {
      reasoningText: `reasoning ${index}\nsecond reasoning line`,
      text: `assistant message ${index}`,
      finishReason:
        index === 0
          ? "length"
          : index === 1
            ? "content-filter"
            : index === 2
              ? "custom-e2e-finish"
              : "tool-calls",
      usage: { inputTokens: 1000 + index, outputTokens: 20 + index },
      toolCalls: [
        {
          toolCallId: callId,
          toolName: "mcp__computer-use__open_application_with_full_name",
          input: { app: "Maps", index },
        },
      ],
    },
    error:
      index === 2
        ? { name: "ProviderError", message: "E2E_TRJ02_RECORD_ERROR", stack: "stack:2:1" }
        : undefined,
  };
}

async function openTrajectoryThroughTaskMenu(taskId: string) {
  await browser.waitUntil(
    () =>
      browser.execute((currentTaskId) => {
        const item = [...document.querySelectorAll<HTMLElement>("[data-testid]")].find((element) =>
          element.getAttribute("data-testid")?.endsWith(currentTaskId),
        );
        if (!item) return false;
        const rect = item.getBoundingClientRect();
        item.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
        return true;
      }, taskId),
    { timeout: 15_000, timeoutMsg: `侧栏中没有找到真实 task item: ${taskId}` },
  );

  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const labels = new Set(["View model trajectory", "查看调用轨迹"]);
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (element) => labels.has((element.textContent ?? "").trim()),
        );
        item?.click();
        return Boolean(item);
      }),
    { timeout: 15_000, timeoutMsg: "task context menu 没有调用轨迹入口" },
  );
}

async function verifyVirtualizedExpansionPersistence(index: number) {
  let targetKey: string | null = null;
  let targetScrollTop = 0;
  await browser.waitUntil(
    async () => {
      const result = await browser.execute((targetIndex) => {
        const root = document.querySelector<HTMLElement>('[data-trajectory-timeline=""]');
        const scroller = root?.parentElement;
        if (!root || !scroller) return null;
        const resolvedIndex = Number(targetIndex);
        scroller.scrollTop = (scroller.scrollHeight * resolvedIndex) / 80;
        const row = root.querySelector<HTMLElement>(`[data-index="${resolvedIndex}"]`);
        const message = row?.querySelector<HTMLElement>('[data-trajectory-expandable-role="user"]');
        const trigger = message?.querySelector<HTMLElement>('[data-trajectory-message-trigger=""]');
        if (!message || !trigger) return null;
        trigger.click();
        return {
          key: message.dataset.trajectorySearchTargetKey ?? null,
          scrollTop: scroller.scrollTop,
        };
      }, index);
      if (!result?.key) return false;
      targetKey = result.key;
      targetScrollTop = result.scrollTop;
      return true;
    },
    { timeout: 15_000, timeoutMsg: `虚拟列表没有挂载第 ${index} 条调用` },
  );

  await browser.waitUntil(
    () =>
      browser.execute((key) => {
        const target = [
          ...document.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]"),
        ].find((element) => element.dataset.trajectorySearchTargetKey === key);
        return target?.dataset.state === "open";
      }, targetKey),
    { timeout: 10_000, timeoutMsg: "目标 user row 没有记录展开 override" },
  );

  await browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-trajectory-timeline=""]');
    if (root?.parentElement) root.parentElement.scrollTop = 0;
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (key) =>
          ![...document.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]")].some(
            (element) => element.dataset.trajectorySearchTargetKey === key,
          ),
        targetKey,
      ),
    { timeout: 10_000, timeoutMsg: "目标 user row 没有离开虚拟挂载窗口" },
  );

  await browser.execute((scrollTop) => {
    const root = document.querySelector<HTMLElement>('[data-trajectory-timeline=""]');
    if (root?.parentElement) root.parentElement.scrollTop = scrollTop;
  }, targetScrollTop);
  await browser.waitUntil(
    () =>
      browser.execute((key) => {
        const target = [
          ...document.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]"),
        ].find((element) => element.dataset.trajectorySearchTargetKey === key);
        return target?.dataset.state === "open";
      }, targetKey),
    { timeout: 15_000, timeoutMsg: "虚拟重挂载后 user row 展开 override 丢失" },
  );
}

async function waitForTrajectory() {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector('[data-trajectory-timeline=""]'))),
    { timeout: 20_000, timeoutMsg: "调用轨迹 timeline 没有渲染" },
  );
}

async function clickFirst(selector: string) {
  await browser.waitUntil(
    () =>
      browser.execute((value) => {
        const element = document.querySelector<HTMLElement>(value);
        element?.click();
        return Boolean(element);
      }, selector),
    { timeout: 10_000, timeoutMsg: `没有找到可点击元素: ${selector}` },
  );
}

async function clickVisible(selector: string) {
  await browser.waitUntil(
    () =>
      browser.execute((value) => {
        const element = document.querySelector<HTMLElement>(value);
        element?.scrollIntoView({ block: "center" });
        return Boolean(element);
      }, selector),
    { timeout: 10_000, timeoutMsg: `没有找到可滚入视口的元素: ${selector}` },
  );
  await clickFirst(selector);
}

async function firstText(selector: string) {
  return browser.execute(
    (value) => document.querySelector<HTMLElement>(value)?.textContent ?? "",
    selector,
  );
}

async function installClipboardCapture() {
  await browser.execute(() => {
    const target = window as unknown as { __e2eTrajectoryClipboard?: string };
    target.__e2eTrajectoryClipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          target.__e2eTrajectoryClipboard = text;
        },
      },
    });
  });
}

async function clickNative(selector: string) {
  const element = $(selector);
  await element.waitForDisplayed({ timeout: 10_000 });
  await element.click();
}

async function waitForToggleAllAction(labels: string[]) {
  await browser.waitUntil(
    () =>
      browser.execute((expectedLabels) => {
        const button = document.querySelector<HTMLElement>('[data-trajectory-toggle-all=""]');
        return expectedLabels.includes(button?.getAttribute("aria-label") ?? "");
      }, labels),
    { timeout: 10_000, timeoutMsg: `批量按钮没有切换为 ${labels.join("/")}` },
  );
}

async function searchAndNavigate(query: string) {
  const hasSearchBar = await browser.execute(() =>
    Boolean(document.querySelector('[data-trajectory-search-bar=""]')),
  );
  if (!hasSearchBar) await clickFirst('[data-trajectory-search-trigger=""]');
  await setSearchValue(query);
  await browser.waitUntil(async () => (await trajectorySnapshot()).text.includes(query), {
    timeout: 15_000,
    timeoutMsg: `搜索命中没有被虚拟列表挂载并 reveal: ${query}`,
  });
}

async function setSearchValue(query: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Boolean(document.querySelector('[data-trajectory-search-bar=""] input')),
      ),
    { timeout: 10_000, timeoutMsg: "调用轨迹搜索框没有出现" },
  );
  const input = $('[data-trajectory-search-bar=""] input');
  await input.setValue(query);
}

async function waitForSearchHighlights(expectedNormal: number, expectedActive: number) {
  await browser.waitUntil(
    async () => {
      const snapshot = await searchHighlightSnapshot();
      return snapshot.normal === expectedNormal && snapshot.active === expectedActive;
    },
    {
      timeout: 10_000,
      timeoutMsg: `搜索高亮没有达到 normal=${expectedNormal} active=${expectedActive}`,
    },
  );
}

async function searchHighlightSnapshot() {
  return browser.execute(() => {
    const registry = (
      CSS as unknown as {
        highlights?: {
          get: (name: string) => { size?: number } | undefined;
          has: (name: string) => boolean;
        };
      }
    ).highlights;
    const normalName = "zcode-model-trajectory-find";
    const activeName = "zcode-model-trajectory-find-active";
    return {
      registered: Boolean(registry?.has(normalName) || registry?.has(activeName)),
      normal: registry?.get(normalName)?.size ?? 0,
      active: registry?.get(activeName)?.size ?? 0,
    };
  });
}

async function seedOversizedTrajectoryTail(filePath: string, taskId: string) {
  const handle = await open(filePath, "r+");
  try {
    await handle.truncate(33 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const recentRecord = {
    type: "model_io",
    sessionId: taskId,
    requestId: "e2e-trj-recent-tail",
    querySource: "main_turn",
    startedAt: "2026-08-27T12:00:00.000Z",
    completedAt: "2026-08-27T12:00:00.250Z",
    durationMs: 250,
    model: { modelId: "e2e-trajectory-model", providerId: "e2e-provider" },
    request: {
      messages: [{ role: "user", content: RECENT_TAIL_MARKER }],
      toolNames: [],
    },
    response: {
      text: `${RECENT_TAIL_MARKER}_RESPONSE`,
      finishReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  };
  await appendFile(filePath, `\n${JSON.stringify(recentRecord)}\n`, "utf8");
}

async function trajectorySnapshot() {
  return browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-trajectory-timeline=""]');
    const expanded = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-trajectory-message-expanded=""][data-state="open"]',
      ),
    );
    return {
      callCount: document.querySelectorAll('[data-trajectory-call=""]').length,
      virtualRowCount: document.querySelectorAll('[data-trajectory-virtual-row=""]').length,
      expandedCount: expanded.length,
      expandedRoles: Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-trajectory-message-collapsible=""][data-state="open"]',
        ),
      ).map((item) => item.dataset.trajectoryExpandableRole ?? ""),
      copyCount: document.querySelectorAll('[data-trajectory-message-copy=""]').length,
      overflowToggleCount: document.querySelectorAll('[data-trajectory-overflow-toggle=""]').length,
      errorIconCount: document.querySelectorAll('[data-trajectory-payload-error-icon=""]').length,
      callErrorCount: document.querySelectorAll('[data-trajectory-call-error=""]').length,
      sourceKinds: [...document.querySelectorAll<HTMLElement>("[data-trajectory-source-kind]")].map(
        (element) => element.dataset.trajectorySourceKind ?? "",
      ),
      querySources: [
        ...document.querySelectorAll<HTMLElement>("[data-trajectory-query-source]"),
      ].map((element) => element.dataset.trajectoryQuerySource ?? ""),
      finishReasons: [
        ...document.querySelectorAll<HTMLElement>("[data-trajectory-finish-reason]"),
      ].map((element) => element.dataset.trajectoryFinishReason ?? ""),
      truncatedNoticeCount: [...document.querySelectorAll<HTMLElement>("p")].filter((element) =>
        /Too many records|记录过多/.test(element.textContent ?? ""),
      ).length,
      text: root?.textContent ?? "",
      expandedText: expanded.map((item) => item.textContent ?? "").join("\n"),
      pageHorizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      chevronRightEdgeDelta: (() => {
        const rightEdges = Array.from(
          document.querySelectorAll<HTMLElement>('[data-trajectory-message-chevron-trigger=""]'),
          (item) => item.getBoundingClientRect().right,
        );
        return rightEdges.length > 1 ? Math.max(...rightEdges) - Math.min(...rightEdges) : 0;
      })(),
    };
  });
}

async function setRendererLocale(locale: "zh-CN") {
  const changed = await browser.execute((nextLocale) => {
    const actions = (
      window as typeof window & {
        __testActions?: Record<string, unknown>;
      }
    ).__testActions;
    const setLocale = actions?.setLocale;
    if (typeof setLocale !== "function") return false;
    (setLocale as (value: string) => void)(nextLocale);
    return true;
  }, locale);
  if (!changed) {
    throw new Error(`TRJ01 缺少 renderer locale test action: ${locale}`);
  }
  await browser.waitUntil(
    async () =>
      browser.execute((expectedLocale) => {
        const actions = (
          window as typeof window & {
            __testActions?: Record<string, unknown>;
          }
        ).__testActions;
        const getLocale = actions?.getLocale;
        return typeof getLocale === "function" && getLocale() === expectedLocale;
      }, locale),
    { timeout: 15_000, timeoutMsg: `TRJ01 renderer locale 没有切换到 ${locale}` },
  );
}

async function trajectoryRoleRowSnapshot(role: string) {
  return browser.execute((targetRole) => {
    const row = document.querySelector<HTMLElement>(
      `[data-trajectory-expandable-role="${targetRole}"]`,
    );
    const copy = row?.querySelector<HTMLElement>('[data-trajectory-message-copy=""]');
    return {
      state: row?.dataset.state ?? null,
      copyVisible: Boolean(copy && window.getComputedStyle(copy).display !== "none"),
      hasOverflowToggle: Boolean(row?.querySelector('[data-trajectory-overflow-toggle=""]')),
      text: row?.textContent ?? "",
    };
  }, role);
}

async function searchSnapshot() {
  return browser.execute(() => {
    const bar = document.querySelector<HTMLElement>('[data-trajectory-search-bar=""]');
    const counter = Array.from(bar?.querySelectorAll<HTMLElement>("span") ?? []).find((item) =>
      /\d+\s*\/\s*\d+/.test(item.textContent ?? ""),
    );
    return { counter: counter?.textContent ?? null };
  });
}
