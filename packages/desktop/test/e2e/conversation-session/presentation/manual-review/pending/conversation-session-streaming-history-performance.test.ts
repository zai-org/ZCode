import { readFile, writeFile } from "node:fs/promises";
import { Key } from "webdriverio";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { DEFAULT_WORKSPACE, setCurrentElectronRendererContentSize } from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { selectUpstreamModel, selectUpstreamThoughtLevel } from "#e2e/helpers/upstream-provider";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-streaming-history-performance";
const TURNS = Number(process.env.ZCODE_E2E_STREAM_HISTORY_TURNS ?? 1000);
const percentile = (values: number[], ratio: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * ratio))
  ] ?? 0;

async function createLongHistory(history: string) {
  const id = -948001;
  const writer = new BufferWriter();
  serialize(writer, [100, id, ServiceChannels.ZCodeAgent, "createSession"]);
  serialize(writer, [
    {
      workspacePath: DEFAULT_WORKSPACE,
      persistence: "immediate",
      titleGenerationEnabled: false,
      importedHistory: {
        source: "claudeCode",
        title: "E2E_STREAM_HISTORY",
        messages: Array.from({ length: TURNS }, (_, i) => [
          { role: "user", content: `历史提问 ${i}` },
          {
            role: "assistant",
            content:
              i === 0
                ? `${history}\n\n**E2E_FIND_MARKUP**\n\n[E2E_FIND_LINK](https://example.com/e2e-find-hidden-target)`
                : history,
          },
        ]).flat(),
      },
    },
  ]);
  const prefixes = [201, 202, 203].map((kind) => {
    const prefix = new BufferWriter();
    serialize(prefix, [kind, id]);
    return Array.from(prefix.buffer.buffer);
  });
  // 长历史不能作为数百万个 WebDriver 数字参数枚举；编码只跨测试驱动，Host 仍接收原 RPC。
  const response = await browser.execute(
    (payload, headers) => {
      const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
      return window.__remoteProjectHandoffRpc!.call(Array.from(bytes), headers);
    },
    Buffer.from(writer.buffer.buffer).toString("base64"),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(response)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(JSON.stringify(body));
  return body as { session: { sessionId: string } };
}
type StreamProbe = {
  frames: number[];
  longTasks: { at: number; duration: number }[];
  changes: { at: number; reasoning: string; text: string }[];
  stop(): void;
};
declare global {
  interface Window {
    __streamHistoryProbe?: StreamProbe;
    __streamHistoryScan?: Record<
      string,
      {
        count: number;
        props: Record<string, number>;
        reasons: Record<string, number>;
        signature: string;
      }
    >;
  }
}

async function profileCommand(command: "start" | "stop") {
  return browser.electron.execute(async (electron, action) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!target) throw new Error("Renderer unavailable");
    const debug = target.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    if (action === "start") {
      await debug.sendCommand("Profiler.enable");
      await debug.sendCommand("Profiler.start");
      return "";
    }
    const result = await debug.sendCommand("Profiler.stop");
    debug.detach();
    return JSON.stringify(result.profile);
  }, command);
}

async function enableScan() {
  const require = createRequire(import.meta.url);
  const scan = await readFile(require.resolve("react-scan/dist/auto.global.js"), "utf8");
  // 仅诊断运行注入，早于 React；记录实例身份与 props 原因，不拿开启 Scan 的耗时做性能验收。
  const probe = `;window.__streamHistoryScan={};window.reactScan({dangerouslyForceRunInProduction:true,animationSpeed:'off',showToolbar:false,onRender(fiber,renders){
    const type=fiber.type?.type||fiber.type;const name=type?.displayName||type?.name||type?.render?.name;if(!name)return;
    const props=fiber.memoizedProps||{};const old=fiber.alternate?.memoizedProps||{};
    const key=name+':'+(props.row?.rowId??props.unit?.turnId??props.sessionId??'');
    const item=window.__streamHistoryScan[key]??={count:0,props:{},reasons:{},signature:String(type).slice(0,200)};item.count++;
    for(const key of Object.keys(props))if(!Object.is(props[key],old[key]))item.props[key]=(item.props[key]||0)+1;
    for(const render of renders)for(const change of render.changes){const key=change.reason+':'+change.name;item.reasons[key]=(item.reasons[key]||0)+1;}
  }});`;
  await browser.electron.execute(async (electron, source) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!target) throw new Error("Renderer unavailable");
    const debug = target.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
    target.webContents.reload();
  }, scan + probe);
  await browser.waitUntil(() => browser.execute(() => Boolean(window.__streamHistoryScan)), {
    timeout: 30000,
  });
}

async function startProbe() {
  await browser.execute(() => {
    const root = document.querySelector('[data-testid="v4-timeline"]');
    if (!root) throw new Error("Timeline unavailable");
    const probe: StreamProbe = { frames: [], longTasks: [], changes: [], stop() {} };
    let frame = 0;
    const tick = (time: number) => {
      probe.frames.push(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const longTasks = new PerformanceObserver((list) =>
      probe.longTasks.push(
        ...list.getEntries().map((entry) => ({ at: entry.startTime, duration: entry.duration })),
      ),
    );
    longTasks.observe({ type: "longtask" });
    const changes = new MutationObserver(() => {
      const reasoning =
        root.querySelector('[data-reasoning-streaming-text="true"]')?.textContent ?? "";
      const text = root.textContent ?? "";
      const last = probe.changes.at(-1);
      if (last?.reasoning !== reasoning || last?.text !== text)
        probe.changes.push({ at: performance.now(), reasoning, text: text.slice(-6000) });
    });
    changes.observe(root, { subtree: true, childList: true, characterData: true });
    probe.stop = () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      longTasks.disconnect();
    };
    window.__streamHistoryProbe = probe;
    if (window.__streamHistoryScan) window.__streamHistoryScan = {};
  });
}

describe("PERF04 long history streaming", () => {
  let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
  before(async function () {
    this.timeout(240000);
    replay = await startConversationModelProviderReplayServer(CASE);
    if (process.env.ZCODE_E2E_STREAM_SCAN === "1") await enableScan();
    await prepareV4ConversationE2E();
    await setCurrentElectronRendererContentSize(1280, 900);
    await installHandoffRpcProbe();
  });
  after(async () => {
    await restoreHandoffProbes();
    await replay?.stop();
  });

  it("持续展示 thinking 和正文，完成态逐字一致并保留导航", async function () {
    this.timeout(300000);
    // 经现有导入服务写入隔离会话，再由真实 CLI/Host 水合；不直接写 renderer store。
    const history =
      "历史正文包含足够多的内容用于稳定复现。 History paragraph for streaming. ".repeat(65);
    const result = await createLongHistory(history);
    await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
      { taskId: result.session.sessionId, workspacePath: DEFAULT_WORKSPACE },
    ]);
    await selectV4TaskById(result.session.sessionId);
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    await browser.waitUntil(
      async () => (await getV4TimelineScrollState()).renderUnitCount >= TURNS,
      { timeout: 90000, timeoutMsg: "长历史未完整加载" },
    );
    const before = await getV4TimelineScrollState();
    await startProbe();
    const scanEnabled = process.env.ZCODE_E2E_STREAM_SCAN === "1";
    if (!scanEnabled) await profileCommand("start");
    let completed = false;
    try {
      await sendV4Prompt("E2E_STREAM_HISTORY 请持续输出思考与正文。");
      await waitForV4TimelineContaining("E2E_STREAM_FINAL_END", 90000);
      await waitForV4Pane((pane) => !pane.canStop, "流式会话未完成", 45000);
      completed = true;
    } finally {
      const profile = !scanEnabled ? await profileCommand("stop") : null;
      const data = await browser.execute(() => {
        const probe = window.__streamHistoryProbe!;
        probe.stop();
        return {
          frames: probe.frames,
          longTasks: probe.longTasks,
          changes: probe.changes,
          scan: window.__streamHistoryScan ?? null,
        };
      });
      const gaps = data.frames.slice(1).map((time, index) => time - data.frames[index]!);
      const streamingStart = data.changes.find((change) => change.reasoning)?.at ?? Infinity;
      const streamingFrames = data.frames.filter((time) => time >= streamingStart);
      const streamingGaps = streamingFrames
        .slice(1)
        .map((time, index) => time - streamingFrames[index]!);
      const streamingLongTasks = data.longTasks.filter((entry) => entry.at >= streamingStart);
      const metrics = {
        before,
        turns: TURNS,
        scanEnabled,
        frameP95Ms: percentile(gaps, 0.95),
        longTaskCount: data.longTasks.length,
        maxLongTaskMs: Math.max(0, ...data.longTasks.map((entry) => entry.duration)),
        streamingFrameP95Ms: percentile(streamingGaps, 0.95),
        streamingLongTaskCount: streamingLongTasks.length,
        reasoningUpdates: new Set(data.changes.map((change) => change.reasoning).filter(Boolean))
          .size,
        ...data,
      };
      const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (directory) {
        await writeFile(
          join(directory, "stream-history-metrics.json"),
          JSON.stringify(metrics, null, 2),
        );
        if (profile) await writeFile(join(directory, "stream-history.cpuprofile"), profile);
      }
      if (completed) {
        expect(metrics.reasoningUpdates).toBeGreaterThan(20);
        if (scanEnabled) expect(Object.keys(data.scan ?? {}).length).toBeGreaterThan(0);
        const expected = Array.from({ length: 100 }, (_, i) => `正文 ${i + 1}：持续输出。`).join(
          "\n",
        );
        expect(data.changes.at(-1)?.text).toContain(expected);
        expect((await getV4TimelineScrollState()).renderUnitCount).toBeGreaterThanOrEqual(
          TURNS + 1,
        );
        // 本机对比预算单独配置；Scan 观察轮只验证行为，耗时证据不混入关闭 Scan 的验收。
        const budget = Number(process.env.ZCODE_E2E_STREAM_FRAME_BUDGET_MS ?? 80);
        if (!scanEnabled) expect(metrics.frameP95Ms).toBeLessThan(budget);
      }
    }
    // 宽屏目录负责补齐千轮历史；补齐后再缩窄，验证宽度改变后的重新测高与搜索定位。
    const searchWidth = Number(process.env.ZCODE_E2E_SEARCH_VIEWPORT_WIDTH ?? 1280);
    if (searchWidth !== 1280) await setCurrentElectronRendererContentSize(searchWidth, 900);
    // RRI08：跨虚拟窗口搜索仍须正确挂载并居中，减少屏外挂载不能只降低耗时而丢定位。
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "f"]);
    const input = await browser.$(
      'input[placeholder="Search messages..."], input[placeholder="搜索消息..."]',
    );
    await input.waitForDisplayed({ timeout: 10000 });
    let query = `历史提问 ${Math.max(0, Math.floor(TURNS / 10) - 1)}`;
    let expectedActive = 1;
    let expectedMatches = Array.from({ length: TURNS }, (_, index) => `历史提问 ${index}`).filter(
      (text) => text.includes(query),
    ).length;
    await browser.execute(() => {
      const audit = { tasks: [] as number[], observer: null as PerformanceObserver | null };
      audit.observer = new PerformanceObserver((list) => {
        audit.tasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      audit.observer.observe({ type: "longtask" });
      Object.assign(window, { __findPerformanceAudit: audit });
    });
    await input.setValue(query);
    const centered = () =>
      browser.execute(
        (expectedQuery, expectedCount, expectedIndex) => {
          const ranges = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(
            "zcode-v4-conversation-find-active",
          );
          const range = ranges?.values().next().value;
          const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
          if (!range || !timeline) return false;
          const hit = range.getBoundingClientRect(),
            viewport = timeline.getBoundingClientRect();
          return (
            range.toString() === expectedQuery &&
            document.querySelector<HTMLInputElement>(
              'input[placeholder="Search messages..."], input[placeholder="搜索消息..."]',
            )?.nextElementSibling?.textContent === `${expectedIndex}/${expectedCount}` &&
            hit.height > 0 &&
            Math.abs((hit.top + hit.bottom - viewport.top - viewport.bottom) / 2) <
              viewport.height * 0.3
          );
        },
        query,
        expectedMatches,
        expectedActive,
      );
    await browser.waitUntil(centered, { timeout: 15000, timeoutMsg: "长历史搜索未居中" });
    const searchTasks = await browser.execute(async () => {
      // 下一帧只用于收齐 PerformanceObserver 通知，不参与产品搜索调度。
      await new Promise(requestAnimationFrame);
      const audit = (
        window as unknown as {
          __findPerformanceAudit: { tasks: number[]; observer: PerformanceObserver };
        }
      ).__findPerformanceAudit;
      audit.tasks.push(...audit.observer.takeRecords().map((entry) => entry.duration));
      audit.observer.disconnect();
      return audit.tasks;
    });
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "search-long-tasks.json"),
        JSON.stringify({ query, turns: TURNS, longTasks: searchTasks }),
      );
    // 独立性能回放显式启用预算；Scan 诊断不得作为耗时验收。
    const searchBudget = Number(process.env.ZCODE_E2E_SEARCH_LONG_TASK_BUDGET_MS);
    if (
      Number.isFinite(searchBudget) &&
      searchBudget > 0 &&
      process.env.ZCODE_E2E_STREAM_SCAN !== "1"
    )
      expect(Math.max(0, ...searchTasks)).toBeLessThan(searchBudget);

    if (expectedMatches > 1) {
      expectedActive = 2;
      await browser.keys("Enter");
      await browser.waitUntil(centered, { timeout: 15000, timeoutMsg: "下一项未居中" });
      expectedActive = 1;
      await browser
        .action("key")
        .down(Key.Shift)
        .down(Key.Enter)
        .up(Key.Enter)
        .up(Key.Shift)
        .perform();
      await browser.waitUntil(centered, { timeout: 15000, timeoutMsg: "上一项未居中" });
    }
    query = `历史提问 ${Math.max(0, TURNS - 2)}`;
    expectedMatches = 1;
    await input.setValue(query);
    await browser.waitUntil(centered, { timeout: 15000, timeoutMsg: "单命中搜索未居中" });
    // 单命中回环也必须重新导航，不能被结果身份去重挡掉。
    for (const backwards of [false, true]) {
      await browser.execute(() => {
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
        timeline.scrollTop = 0;
        timeline.dispatchEvent(new Event("scroll"));
      });
      await browser.waitUntil(async () => !(await centered()), {
        timeout: 10000,
        timeoutMsg: "搜索命中尚未离开视口",
      });
      const stayedAway = await browser.execute(async () => {
        // 等待测量与挂载提交，证明已完成的搜索不会因窗口变化再次夺回滚动。
        for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
        return timeline.scrollTop < 1;
      });
      expect(stayedAway).toBe(true);
      await input.click();
      if (backwards)
        await browser
          .action("key")
          .down(Key.Shift)
          .down(Key.Enter)
          .up(Key.Enter)
          .up(Key.Shift)
          .perform();
      else await browser.keys("Enter");
      try {
        await browser.waitUntil(centered, { timeout: 15000, timeoutMsg: "重复搜索未恢复居中" });
      } catch (error) {
        const snapshot = await browser.execute(() => {
          const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
          const ranges = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(
            "zcode-v4-conversation-find-active",
          );
          const range = ranges?.values().next().value;
          return {
            scrollTop: timeline?.scrollTop,
            viewport: timeline?.getBoundingClientRect().toJSON(),
            hit: range?.getBoundingClientRect().toJSON(),
            text: range?.toString(),
            input: document.querySelector<HTMLInputElement>(
              'input[placeholder*="messages"], input[placeholder*="搜索消息"]',
            )?.value,
          };
        });
        throw new Error(`${backwards ? "Shift+Enter" : "Enter"}: ${JSON.stringify(snapshot)}`, {
          cause: error,
        });
      }
    }
    // CR-01：源 Markdown 有命中、真实正文无 Range，也必须归还用户滚动权。
    for (const missingQuery of ["**", "e2e-find-hidden-target"]) {
      await input.setValue(missingQuery);
      await browser.waitUntil(
        () =>
          browser.execute(
            (expected) => {
              const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
              const counter = document.querySelector<HTMLInputElement>(
                'input[placeholder="Search messages..."], input[placeholder="搜索消息..."]',
              )?.nextElementSibling?.textContent;
              const ranges = (
                CSS as unknown as { highlights: Map<string, Set<Range>> }
              ).highlights.get("zcode-v4-conversation-find-active");
              return (
                timeline?.textContent?.includes("E2E_FIND_MARKUP") &&
                counter === `1/${expected}` &&
                ranges?.size === 0
              );
            },
            missingQuery === "**" ? 2 : 1,
          ),
        { timeout: 15000, timeoutMsg: "源码命中目标未挂载" },
      );
      const positions = await browser.execute(async () => {
        for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
        const before = timeline.scrollTop;
        timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
        const requested = timeline.scrollTop;
        for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
        return {
          before,
          requested,
          after: timeline.scrollTop,
          viewportHeight: timeline.clientHeight,
        };
      });
      if (process.env.ZCODE_E2E_ARTIFACT_DIR)
        await writeFile(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR,
            `missing-range-${missingQuery === "**" ? "markup" : "link"}.json`,
          ),
          JSON.stringify(positions, null, 2),
        );
      expect(positions.requested).toBeGreaterThan(positions.before + positions.viewportHeight);
      expect(Math.abs(positions.after - positions.requested)).toBeLessThan(
        positions.viewportHeight,
      );
    }
    await browser.keys("Escape");
  });
});
