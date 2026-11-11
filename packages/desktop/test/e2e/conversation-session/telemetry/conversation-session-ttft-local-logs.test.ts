import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

async function readLogs(directory: string): Promise<string> {
  const files = await readdir(directory).catch(() => [] as string[]);
  return (
    await Promise.all(
      files
        .filter((file) => /\.(log|jsonl)$/.test(file))
        .map((file) => readFile(join(directory, file), "utf8")),
    )
  ).join("\n");
}

describe("TTFT03 生产本地日志", () => {
  it("云端关闭时 Enter 发送仍记录真实接收、投影、DOM 和绘制估计", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    // 冷启动首轮可能重建订阅；先等待真实轮次结束，正向样本只验证连续在线内容。
    await sendV4Prompt("E2E_TTFT_LOCAL_WARMUP: Reply exactly ready.");
    await waitForV4AssistantMessageContaining("ttft-local-warmup-ready");
    await waitForV4ConversationState((state) => state.state === "idle", "准备轮未结束");
    const appLogDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR!);
    const cliLogDir = process.env.ZCODE_LOG_DIR!;
    expect(appLogDir).toBeTruthy();
    expect(cliLogDir).toBeTruthy();
    await browser.electron.execute((electron) => {
      const win = electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      electron.app.focus({ steal: true });
      win?.show();
      win?.focus();
      win?.webContents.focus();
    });
    const before = (await readLogs(appLogDir)).length;
    await setV4ComposerText("E2E_TTFT_LOCAL_LOGS: Reply exactly ttft-local-reply-private.");
    await browser.keys("Enter");
    await waitForV4AssistantMessageContaining("ttft-local-reply-private");
    await waitForV4ConversationState((state) => state.state === "idle", "本地 TTFT 轮未结束");
    let entries: Array<Record<string, unknown>> = [];
    await browser.waitUntil(
      async () => {
        entries = (await readLogs(appLogDir))
          .slice(before)
          .split("\n")
          .flatMap((line) => {
            const offset = line.indexOf("[ttft] ");
            if (offset < 0) return [];
            try {
              return [JSON.parse(line.slice(offset + "[ttft] ".length))];
            } catch {
              return [];
            }
          });
        const start = entries.find((entry) => entry.event === "ttft.start");
        const current = start
          ? entries.filter((entry) => entry.observationId === start.observationId)
          : [];
        const excluded = current.find((entry) => entry.event === "ttft.excluded");
        if (excluded) throw new Error(`TTFT 样本已排除：${String(excluded.outcome)}`);
        return current.some((entry) => entry.event === "ttft.text.paint_estimate");
      },
      { timeout: 15000, timeoutMsg: "本地文件缺少首正文绘制观测" },
    );
    const start = entries.find((entry) => entry.event === "ttft.start")!;
    const observation = entries.filter((entry) => entry.observationId === start.observationId);
    for (const event of [
      "ttft.first_output",
      "ttft.first_text",
      "ttft.text.projected",
      "ttft.text.committed",
      "ttft.text.paint_estimate",
    ]) {
      expect(observation.filter((entry) => entry.event === event)).toHaveLength(1);
    }
    expect(start.localOnly).toBe(true);
    const received = observation.find((entry) => entry.event === "ttft.first_text")!;
    const painted = observation.find((entry) => entry.event === "ttft.text.paint_estimate")!;
    expect(Number(painted.durationMs)).toBeGreaterThanOrEqual(Number(received.durationMs));
    expect(painted.visible).toBe(true);
    expect(
      observation.some((entry) => entry.phase === "host.runtime" && entry.status === "completed"),
    ).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("ttft-local-reply-private");
    const requestId = received.requestId as string;
    expect(requestId).toBeTruthy();
    await browser.waitUntil(
      async () => {
        const lines = (await readLogs(cliLogDir))
          .split("\n")
          .filter((line) => line.includes(requestId));
        return ["fetch_started", "response_headers", "first_content"].every((event) =>
          lines.some((line) => line.includes(`ttft.model.${event}`)),
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "CLI 文件缺少同一输入的首有效内容日志",
      },
    );
  });
});
