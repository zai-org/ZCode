import { ttftReceiverUrl } from "#e2e/helpers/ttft-otlp-fixture";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  prepareV4ConversationE2E,
  sendV4Prompt as sendPrompt,
  waitForV4AssistantMessageContaining as waitForAssistantMessageContaining,
  startNewV4Draft,
  waitForV4ConversationState,
  setV4ComposerText,
  clickV4Send,
} from "#e2e/helpers/v4-conversation";

interface Attribute {
  key: string;
  value: { stringValue?: string; doubleValue?: number };
}
interface Span {
  name: string;
  traceId: string;
  attributes: Attribute[];
  startTimeUnixNano: string;
  endTimeUnixNano: string;
}
interface Metric {
  name: string;
  histogram?: {
    dataPoints: Array<{ count: string; explicitBounds: number[]; attributes: Attribute[] }>;
  };
}
interface RecordData {
  data: {
    resourceSpans?: Array<{ scopeSpans: Array<{ spans: Span[] }> }>;
    resourceMetrics?: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }>;
  };
}
async function readExport(): Promise<RecordData[]> {
  const response = await fetch(ttftReceiverUrl("/records"));
  if (!response.ok) throw new Error(`OTLP receiver: ${response.status}`);
  return response.json() as Promise<RecordData[]>;
}

describe("TTFT01 真实 Composer 到最终 OTLP", () => {
  afterEach(async () => {
    const focus = await browser.execute(
      () => (window as unknown as { __ttftFocusEvents?: unknown[] }).__ttftFocusEvents ?? [],
    );
    console.info("TTFT focus evidence", JSON.stringify(focus));
  });
  // wdio-electron-service 会移除第一个形参；在函数体内解构才能真正执行窗口操作。
  beforeEach(async () => {
    await browser.electron.execute((electron) => {
      const { BrowserWindow } = electron;
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.show();
      win?.focus();
    });
  });
  it("正文先到：一次发送只生成一个总样本和六个主阶段", async function () {
    this.timeout(180000);
    await fetch(ttftReceiverUrl("/reset"), { method: "POST" });
    await prepareV4ConversationE2E();
    await browser.electron.execute((electron) => {
      const { BrowserWindow } = electron;
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.focus();
    });
    await mkdir(resolveE2ERuntimePath("ttft"), { recursive: true });
    await writeFile(
      resolveE2ERuntimePath("ttft", "input.txt"),
      "E2E_TTFT_TOOL_FILE_CONTENT",
      "utf8",
    );
    await browser.execute(() => {
      const host = window as unknown as { __ttftFocusEvents: unknown[] };
      host.__ttftFocusEvents = [];
      window.addEventListener("blur", (event) =>
        host.__ttftFocusEvents.push({
          type: event.type,
          target: event.target === window ? "window" : "other",
          at: Date.now(),
          focused: document.hasFocus(),
          visibility: document.visibilityState,
        }),
      );
      document.addEventListener("visibilitychange", () =>
        host.__ttftFocusEvents.push({
          type: "visibility",
          at: Date.now(),
          visibility: document.visibilityState,
        }),
      );
    });
    await sendPrompt("E2E_TTFT_STAGE_TEXT: Reply exactly ttft-stage-text-ok.");
    await waitForAssistantMessageContaining("ttft-stage-text-ok");
    await browser.waitUntil(
      async () => {
        const records = await readExport();
        return records.some((record) =>
          record.data.resourceMetrics?.some((resource) =>
            resource.scopeMetrics.some((scope) =>
              scope.metrics.some((metric) => metric.name === "zcode.local_ttft.duration"),
            ),
          ),
        );
      },
      { timeout: 30000, timeoutMsg: "真实发送未导出专用 TTFT Histogram" },
    );
    const records = await readExport();
    const spans = records
      .flatMap((record) => record.data.resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans);
    const roots = spans.filter((span) => span.name === "local_ttft");
    expect(roots).toHaveLength(1);
    expect(roots[0]?.attributes).toContainEqual({
      key: "first_output_kind",
      value: { stringValue: "text" },
    });
    const stages = spans.filter(
      (span) =>
        span.traceId === roots[0]?.traceId &&
        [
          "renderer_prepare",
          "command_admission",
          "execution_wait",
          "request_prepare",
          "model_request",
          "output_return",
        ].some((stage) => span.name === `local_ttft.${stage}`),
    );
    expect(stages.map((span) => span.name).sort()).toEqual(
      [
        "renderer_prepare",
        "command_admission",
        "execution_wait",
        "request_prepare",
        "model_request",
        "output_return",
      ]
        .map((stage) => `local_ttft.${stage}`)
        .sort(),
    );
    for (const stage of stages)
      expect(BigInt(stage.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(stage.startTimeUnixNano));
    const totalMs =
      Number(BigInt(roots[0]!.endTimeUnixNano) - BigInt(roots[0]!.startTimeUnixNano)) / 1e6;
    const explainedMs = stages.reduce(
      (sum, span) =>
        sum + Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6,
      0,
    );
    expect(Math.abs(totalMs - explainedMs)).toBeLessThan(0.01);
    const metrics = records
      .flatMap((record) => record.data.resourceMetrics ?? [])
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    const total = metrics
      .filter((metric) => metric.name === "zcode.local_ttft.duration")
      .flatMap((metric) => metric.histogram?.dataPoints ?? []);
    expect(total.reduce((count, point) => count + Number(point.count), 0)).toBe(1);
    expect(total[0]?.explicitBounds).toEqual([
      1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000,
    ]);
    expect(
      total.flatMap((point) => point.attributes.map((attribute) => attribute.key)),
    ).not.toEqual(
      expect.arrayContaining(["command_id", "session_id", "trace_id", "workspace_path"]),
    );
  });
  it("思考先到：空 start 不收口，已知模型/命令延迟正确归因，首输出早于 ACK 和正文", async function () {
    this.timeout(120000);
    await waitForV4ConversationState((state) => state.state === "idle", "正文轮尚未完成");
    await browser.execute(() => {
      (window as unknown as { __zcodeTransportDelayE2E: unknown }).__zcodeTransportDelayE2E = {
        commandMs: 250,
        ackMs: 7000,
      };
    });
    await setV4ComposerText("E2E_TTFT_STAGE_REASONING: Reply exactly ttft-stage-reasoning-ok.");
    await clickV4Send();
    let first: Span | undefined;
    await browser.waitUntil(
      async () => {
        const records = await readExport();
        first = records
          .flatMap((record) => record.data.resourceSpans ?? [])
          .flatMap((resource) => resource.scopeSpans)
          .flatMap((scope) => scope.spans)
          .find(
            (span) =>
              span.name === "local_ttft" &&
              span.attributes.some(
                (attribute) =>
                  attribute.key === "first_output_kind" &&
                  attribute.value.stringValue === "reasoning",
              ),
          );
        return Boolean(first);
      },
      { timeout: 6000, timeoutMsg: "首思考没有在 ACK/terminal 前导出" },
    );
    const ackReleased = await browser.execute(() => {
      const plan = (
        window as unknown as {
          __zcodeTransportDelayE2E?: { consumed?: boolean; ackReleased?: boolean };
        }
      ).__zcodeTransportDelayE2E;
      if (!plan?.consumed) throw new Error("真实 command 未进入延迟 seam");
      return plan.ackReleased === true;
    });
    expect(ackReleased).toBe(false);
    const spans = (await readExport())
      .flatMap((record) => record.data.resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans)
      .filter((span) => span.traceId === first!.traceId);
    expect(spans.some((span) => span.name === "local_ttft.first_text")).toBe(false);
    const durationMs = (name: string) => {
      const span = spans.find((item) => item.name === name)!;
      return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6;
    };
    expect(durationMs("local_ttft.command_admission")).toBeGreaterThanOrEqual(240);
    expect(durationMs("local_ttft.model_request")).toBeGreaterThanOrEqual(200);
    expect(durationMs("local_ttft.model_request")).toBeLessThan(1500);
    await waitForAssistantMessageContaining("ttft-stage-reasoning-ok");
    await browser.waitUntil(
      async () =>
        (await readExport()).some((record) =>
          record.data.resourceSpans?.some((resource) =>
            resource.scopeSpans.some((scope) =>
              scope.spans.some(
                (span) => span.traceId === first!.traceId && span.name === "local_ttft.first_text",
              ),
            ),
          ),
        ),
      { timeout: 10000, timeoutMsg: "首正文没有独立导出" },
    );
    await waitForV4ConversationState((state) => state.state === "idle", "思考轮没有结束");
  });
  it("工具先到：真实工具执行后输出正文，总 TTFT 仍只有一条", async function () {
    this.timeout(120000);
    await startNewV4Draft();
    await sendPrompt(
      "E2E_TTFT_STAGE_TOOL: Read the readonly fixture, then reply exactly ttft-stage-tool-ok.",
    );
    await waitForAssistantMessageContaining("ttft-stage-tool-ok");
    await browser.waitUntil(
      async () =>
        (await readExport()).some((record) =>
          record.data.resourceSpans?.some((resource) =>
            resource.scopeSpans.some((scope) =>
              scope.spans.some(
                (span) =>
                  span.name === "local_ttft" &&
                  span.attributes.some(
                    (attribute) =>
                      attribute.key === "first_output_kind" &&
                      attribute.value.stringValue === "tool",
                  ),
              ),
            ),
          ),
        ),
      { timeout: 10000, timeoutMsg: "工具首输出没有导出" },
    );
    const roots = (await readExport())
      .flatMap((record) => record.data.resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans)
      .filter((span) => span.name === "local_ttft");
    expect(roots).toHaveLength(3);
  });
});
