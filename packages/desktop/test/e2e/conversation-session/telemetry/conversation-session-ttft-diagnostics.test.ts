import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { ttftReceiverUrl } from "#e2e/helpers/ttft-otlp-fixture";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  waitForV4PausedQueueSendDialog,
  clickV4QueueItemSendNow,
} from "#e2e/helpers/v4-conversation";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  getV4QueueItems,
  waitForV4QueueCount,
  clickV4Stop,
} from "#e2e/helpers/v4-conversation";

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: { stringValue?: string; doubleValue?: number; intValue?: string };
  }>;
};
async function spans(): Promise<Span[]> {
  const response = await fetch(ttftReceiverUrl("/records"));
  const records = (await response.json()) as Array<{
    data: { resourceSpans?: Array<{ scopeSpans: Array<{ spans: Span[] }> }> };
  }>;
  return records
    .flatMap((record) => record.data.resourceSpans ?? [])
    .flatMap((resource) => resource.scopeSpans)
    .flatMap((scope) => scope.spans);
}
const attr = (span: Span, key: string) =>
  span.attributes.find((item) => item.key === key)?.value.stringValue;
const ms = (span: Span) =>
  Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6;
async function waitRoot(count: number) {
  await browser.waitUntil(
    async () => (await spans()).filter((span) => span.name === "local_ttft").length >= count,
    { timeout: 30000, timeoutMsg: "最终 OTLP 根记录未到达" },
  );
}
// Electron bridge 移除第一个形参；形参解构会静默 ReferenceError，必须在函数体内解构。
async function focus() {
  const nativeFocus = await browser.electron.execute((electron) => {
    const { BrowserWindow, app } = electron;
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    app.focus({ steal: true });
    win?.restore();
    win?.show();
    win?.focus();
    win?.webContents.focus();
    return BrowserWindow.getAllWindows().map((item) => ({
      id: item.id,
      url: item.webContents.getURL(),
      focused: item.isFocused(),
      contentsFocused: item.webContents.isFocused(),
    }));
  });
  console.info("TTFT native focus", nativeFocus);
  await browser.waitUntil(async () => browser.execute(() => document.hasFocus()), {
    timeout: 5000,
    timeoutMsg: "真实 Electron 内容未获得焦点",
  });
}

async function setInteractionBehavior(behavior: "queue" | "guide") {
  if ((await readSettings()).zcodeInteractionBehavior === behavior) return;
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const trigger = Array.from(
          document.querySelectorAll<HTMLElement>('[role="combobox"]'),
        ).find((element) =>
          ["引导", "Guide", "队列", "Queue"].some((label) => element.innerText.includes(label)),
        );
        if (!trigger) return false;
        trigger.click();
        return true;
      }),
    { timeout: 15000 },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (labels) => {
          const option = Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"], [data-radix-collection-item]'),
          ).find((element) => labels.includes(element.innerText.trim()));
          if (!option) return false;
          option.click();
          return true;
        },
        behavior === "guide" ? ["引导", "Guide"] : ["队列", "Queue"],
      ),
    { timeout: 15000 },
  );
  await browser.waitUntil(
    async () => (await readSettings()).zcodeInteractionBehavior === behavior,
    { timeout: 15000 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

describe("TTFT02 真实发送诊断到最终 OTLP", () => {
  const configPath = join(dirname(DEFAULT_WORKSPACE), ".zcode", "cli", "config.json");
  let originalConfig: string | undefined;
  const runtimeEvidence: unknown[] = [];
  beforeEach(async () => {
    await browser.execute(() => {
      const state = {
        heapStart: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize,
        longTaskCount: 0,
        longTaskMs: 0,
      };
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTaskCount++;
          state.longTaskMs += entry.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      (window as unknown as { __ttftDiagnosticPerf: unknown }).__ttftDiagnosticPerf = {
        state,
        observer,
      };
    });
  });
  afterEach(async () => {
    const renderer = await browser.execute(() => {
      const probe = (
        window as unknown as {
          __ttftDiagnosticPerf: { state: unknown; observer: PerformanceObserver };
        }
      ).__ttftDiagnosticPerf;
      probe.observer.disconnect();
      return {
        sample: probe.state,
        heapEnd: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      };
    });
    const processes = await browser.electron.execute((electron) => electron.app.getAppMetrics());
    runtimeEvidence.push({ renderer, processes });
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir)
      await writeFile(
        join(artifactDir, "ttft-diagnostics-performance.json"),
        JSON.stringify(runtimeEvidence, null, 2),
      );
  });
  before(async () => {
    originalConfig = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(resolveE2ERuntimePath("ttft-diagnostics"), { recursive: true });
    const hook = resolveE2ERuntimePath("ttft-diagnostics", "hook.cjs");
    await writeFile(
      hook,
      'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.stdout.write("{}"), 300));',
    );
    await writeFile(resolveE2ERuntimePath("ttft-diagnostics", "input.txt"), "E2E_TTFT_GUIDE_FILE");
    await writeFile(
      configPath,
      JSON.stringify({
        ...(originalConfig ? JSON.parse(originalConfig) : {}),
        hooks: {
          enabled: true,
          events: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: `"${process.execPath}" "${hook}"`, timeoutMs: 3000 },
                ],
              },
            ],
          },
        },
      }),
    );
  });
  after(async () => {
    try {
      const roots = (await spans()).filter((span) => span.name === "local_ttft");
      type MetricPoint = { count?: string; attributes?: { key: string }[] };
      const metrics = async () => {
        const response = await fetch(ttftReceiverUrl("/records"));
        const records = (await response.json()) as Array<{
          data: {
            resourceMetrics?: Array<{
              scopeMetrics: Array<{
                metrics: Array<{
                  name: string;
                  histogram?: { dataPoints: MetricPoint[] };
                  sum?: { dataPoints: MetricPoint[] };
                }>;
              }>;
            }>;
          };
        }>;
        return records
          .flatMap((record) => record.data.resourceMetrics ?? [])
          .flatMap((resource) => resource.scopeMetrics)
          .flatMap((scope) => scope.metrics)
          .filter((metric) => metric.name.startsWith("zcode.local_ttft."));
      };
      const count = async () =>
        (await metrics())
          .filter((metric) => metric.name === "zcode.local_ttft.duration")
          .flatMap((metric) => metric.histogram?.dataPoints ?? [])
          .reduce((sum, point) => sum + Number(point.count ?? 0), 0);
      await browser.waitUntil(async () => (await count()) >= roots.length, {
        timeout: 15000,
        timeoutMsg: "最终 OTLP Histogram 尚未覆盖所有成功根",
      });
      expect(await count()).toBe(roots.length);
      const forbidden = new Set([
        "observation_id",
        "command_id",
        "input_id",
        "query_id",
        "session_id",
        "trace_id",
        "request_id",
        "workspace_path",
        "workspace_id",
        "user_id",
        "cli_instance_id",
      ]);
      expect(
        (await metrics())
          .flatMap((metric) => [
            ...(metric.histogram?.dataPoints ?? []),
            ...(metric.sum?.dataPoints ?? []),
          ])
          .flatMap((point) => point.attributes ?? [])
          .some((attribute) => forbidden.has(attribute.key)),
      ).toBe(false);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await writeFile(
          join(artifactDir, "ttft-diagnostics-otlp.json"),
          JSON.stringify(
            {
              spans: (await spans()).filter((span) => span.name.startsWith("local_ttft")),
              metrics: await metrics(),
            },
            null,
            2,
          ),
        );
    } finally {
      if (originalConfig !== undefined) await writeFile(configPath, originalConfig);
      else await rm(configPath, { force: true });
    }
  });

  it("队列转正保留原输入，后台返回仍导出首输出和独立阶段", async function () {
    this.timeout(180000);
    await fetch(ttftReceiverUrl("/reset"), { method: "POST" });
    await prepareV4ConversationE2E();
    await focus();
    await sendV4Prompt("E2E_TTFT_DIAG_HOLD: Reply ttft-diag-hold-ok.");
    await waitForV4ConversationState((state) => state.state === "streaming", "主任务未运行");
    await sendV4Prompt("E2E_TTFT_DIAG_QUEUE: Reply ttft-diag-queue-ok.");
    await waitForV4QueueCount(1);
    expect((await getV4QueueItems())[0]?.text).toContain("E2E_TTFT_DIAG_QUEUE");
    await browser.electron.execute((electron) => {
      const { BrowserWindow } = electron;
      BrowserWindow.getAllWindows()
        .find((win) => !win.isDestroyed())
        ?.minimize();
    });
    // minimize 是异步窗口操作；旧用例立即 focus，系统尚未派发 hidden 就已恢复前台。
    // 等真实可见性事件完成，才能验证后台返回分类，不用延时模拟后台状态。
    await browser.waitUntil(() => browser.execute(() => document.visibilityState === "hidden"), {
      timeout: 10000,
      timeoutMsg: "最小化后 renderer 未进入后台可见性状态",
    });
    await browser.waitUntil(
      async () => (await spans()).some((span) => span.name === "local_ttft.start"),
      { timeout: 5000 },
    );
    await focus();
    await waitForV4AssistantMessageContaining("ttft-diag-queue-ok");
    await waitRoot(2);
    const exported = await spans();
    const queued = exported.find(
      (span) => span.name === "local_ttft" && attr(span, "send_mode") === "queued",
    );
    expect(queued).toBeDefined();
    expect(
      exported.some(
        (span) => span.traceId === queued!.traceId && span.name === "local_ttft.prepare.context",
      ),
    ).toBe(true);
    expect(
      exported
        .filter(
          (span) => span.traceId === queued!.traceId && span.name === "local_ttft.prepare.hooks",
        )
        .some((span) => ms(span) >= 290),
    ).toBe(true);
    expect(attr(queued!, "visibility")).toBe("background_returned");
    expect(
      exported.filter(
        (span) => span.traceId === queued!.traceId && span.name === "local_ttft.execution_wait",
      ),
    ).toHaveLength(1);
    expect(
      ms(
        exported.find(
          (span) => span.traceId === queued!.traceId && span.name === "local_ttft.execution_wait",
        )!,
      ),
    ).toBeGreaterThan(500);
  });

  it("取消首输出前的等待，只记录明确取消，不产生成功耗时", async function () {
    this.timeout(120000);
    await waitForV4ConversationState((state) => state.state === "idle", "队列未完成");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await focus();
    await sendV4Prompt("E2E_TTFT_DIAG_CANCEL: Wait before answering.");
    await waitForV4ConversationState((state) => state.state === "streaming", "待取消任务未启动");
    await clickV4Stop();
    await browser.waitUntil(
      async () =>
        (await spans()).some(
          (span) => span.name === "local_ttft.excluded" && attr(span, "outcome") === "cancelled",
        ),
      { timeout: 15000 },
    );
    expect((await spans()).filter((span) => span.name === "local_ttft")).toHaveLength(2);
  });
  it("失败重试后的首输出只产生一份 TTFT，并导出两个 attempt", async function () {
    this.timeout(120000);
    await waitForV4ConversationState((state) => state.state === "idle", "取消未结束");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await focus();
    const before = (await spans()).filter((span) => span.name === "local_ttft").length;
    await sendV4Prompt("E2E_TTFT_DIAG_RETRY: Reply ttft-diag-retry-ok.");
    await waitForV4AssistantMessageContaining("ttft-diag-retry-ok");
    await waitRoot(before + 1);
    const all = await spans();
    const roots = all.filter((span) => span.name === "local_ttft");
    const root = roots.at(-1)!;
    expect(roots).toHaveLength(before + 1);
    const attempts = all.filter(
      (span) => span.traceId === root.traceId && span.name === "local_ttft.attempt",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((span) => attr(span, "detail_outcome"))).toEqual([
      "failed",
      "first_output",
    ]);
    expect(new Set(attempts.map((span) => attr(span, "request_id"))).size).toBe(2);
    expect(attr(root, "request_id")).toBe(attr(attempts[1]!, "request_id"));
    expect(
      all.some((span) => span.traceId === root.traceId && span.name === "local_ttft.retry_wait"),
    ).toBe(true);
  });
  it("明确模型失败保留已等待时间和阶段，不增加成功样本", async function () {
    this.timeout(120000);
    await waitForV4ConversationState((state) => state.state === "idle", "重试未结束");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await focus();
    const before = (await spans()).filter((span) => span.name === "local_ttft").length;
    await sendV4Prompt("E2E_TTFT_DIAG_FAIL: Fail before any output.");
    await browser.waitUntil(
      async () =>
        (await spans()).some(
          (span) => span.name === "local_ttft.excluded" && attr(span, "outcome") === "failed",
        ),
      { timeout: 20000 },
    );
    expect((await spans()).filter((span) => span.name === "local_ttft")).toHaveLength(before);
  });

  it("立即引导独立分类，不抢占主轮工具首输出", async function () {
    this.timeout(120000);
    await waitForV4ConversationState((state) => state.state === "idle", "失败轮未结束");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await focus();
    await setInteractionBehavior("guide");
    await focus();
    const before = (await spans()).filter((span) => span.name === "local_ttft").length;
    await sendV4Prompt(
      "E2E_TTFT_DIAG_GUIDE_PARENT: Read .zcode-e2e/ttft-diagnostics/input.txt then reply ttft-diag-guide-ok.",
    );
    await waitForV4ConversationState((state) => state.state === "streaming", "引导主轮未启动");
    await sendV4Prompt("E2E_TTFT_DIAG_GUIDE_INPUT: Keep the requested final answer.");
    await waitForV4AssistantMessageContaining("ttft-diag-guide-ok");
    await browser.waitUntil(
      async () =>
        (await spans()).some(
          (span) => span.name === "local_ttft.excluded" && attr(span, "outcome") === "guided",
        ),
      { timeout: 15000 },
    );
    await waitRoot(before + 1);
    expect((await spans()).filter((span) => span.name === "local_ttft")).toHaveLength(before + 1);
    await setInteractionBehavior("queue");
  });
  it("二次确认沿首次提交计时，send-now 保留被提升输入的关联", async function () {
    this.timeout(180000);
    await waitForV4ConversationState((state) => state.state === "idle", "引导轮未结束");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await focus();
    await sendV4Prompt("E2E_TTFT_DIAG_PAUSE: Wait before responding.");
    await waitForV4ConversationState((state) => state.state === "streaming", "暂停主轮未启动");
    await sendV4Prompt("E2E_TTFT_DIAG_HELD: Reply ttft-diag-held-ok.");
    await waitForV4QueueCount(1);
    const held = (await getV4QueueItems())[0]!;
    await clickV4Stop();
    await waitForV4ConversationState((state) => state.state === "idle", "暂停主轮未停止");
    const before = (await spans()).filter((span) => span.name === "local_ttft").length;
    await sendV4Prompt("E2E_TTFT_DIAG_CONFIRM: Reply ttft-diag-confirm-ok.");
    await waitForV4PausedQueueSendDialog();
    // 显式模拟用户阅读弹窗的停留，不用于业务状态同步。
    await browser.pause(350);
    await clickTestIdByDom(TID_V4_COMPOSER_KEEP_QUEUE_SEND);
    await waitForV4AssistantMessageContaining("ttft-diag-confirm-ok");
    await waitRoot(before + 1);
    const confirmed = (await spans()).filter((span) => span.name === "local_ttft").at(-1)!;
    expect(
      (await spans()).filter(
        (span) => span.traceId === confirmed.traceId && span.name === "local_ttft.start",
      ),
    ).toHaveLength(1);
    expect(
      (await spans())
        .filter(
          (span) =>
            span.traceId === confirmed.traceId && span.name === "local_ttft.user_confirmation",
        )
        .some((span) => ms(span) >= 350),
    ).toBe(true);
    await clickV4QueueItemSendNow(held.queueItemId);
    await waitForV4AssistantMessageContaining("ttft-diag-held-ok");
    await waitRoot(before + 2);
    const promoted = (await spans()).filter((span) => span.name === "local_ttft").at(-1)!;
    expect(held.queueItemId).toContain(attr(promoted, "command_id"));
  });
});
