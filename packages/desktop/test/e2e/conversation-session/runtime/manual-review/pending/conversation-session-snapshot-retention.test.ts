// 生产 renderer 的独立 CDP E2E；使用 node:test，不能放入 WDIO/Docker preset。
// 前置：隔离 HOME 中播种 8 个 sess_probe_retention_0..7 已完成会话，启动未开启 E2E bridge 的 App。
// ZCODE_RETENTION_CDP_URL=http://127.0.0.1:9326 ZCODE_RETENTION_ARTIFACT_DIR=<dir>
// pnpm --filter @zcode/desktop test:e2e:retention
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { countRetainedHistory } from "#e2e/helpers/session-pane-retention-heap";

const prefix = "sess_probe_retention_";
// SPR03 的 fixture 使用 8 个独立工作区，覆盖每个 transport 各遗留一个预热 owner 的路径。
const crossWorkspace = process.env.ZCODE_RETENTION_CROSS_WORKSPACE === "1";
// SPR04/05 复用同工作区 fixture，直接检查已脱离 store 的历史 snapshot。
const sameWorkspace = process.env.ZCODE_RETENTION_SAME_WORKSPACE === "1";
const returnToDraft = crossWorkspace || sameWorkspace;

function rendererPage(browser: Browser) {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("/renderer/index.html"));
  assert(page, "缺少真实生产 renderer");
  return page;
}

test(
  sameWorkspace
    ? "SPR04/05: same-workspace history and draft roundtrips release snapshots and callbacks"
    : crossWorkspace
      ? "SPR03: cross-workspace switches and return to draft release prewarm owners and history"
      : "SPR01: 136 session switches release inactive snapshots and closed stores",
  { timeout: 1_200_000 },
  async () => {
    const endpoint = process.env.ZCODE_RETENTION_CDP_URL;
    const artifactDir = process.env.ZCODE_RETENTION_ARTIFACT_DIR;
    const sourceMapPath = process.env.ZCODE_RETENTION_RENDERER_SOURCEMAP;
    assert(!sameWorkspace || sourceMapPath, "SPR04/05 需要精确生产 renderer sourcemap 校验回调族");
    assert(endpoint && artifactDir, "需要显式指定隔离 App CDP 与证据目录");
    const output = resolve(artifactDir);
    await mkdir(output, { recursive: true });
    let browser = await chromium.connectOverCDP(endpoint);
    // 前置 bridge 断言也可能失败；连接从建立起就归 finally 清理，避免失败后进程挂起。
    try {
      let page = rendererPage(browser);
      // 测试 bridge 会额外持有 store；误连普通 E2E 构建会污染生产回收证据，必须先拒绝。
      assert.deepEqual(
        await page.evaluate((allowEmptyTrajectoryBridge) => {
          return Object.keys(window).filter((key) => {
            if (!/^__zcode.*StoreE2E$/u.test(key)) return false;
            // 现有生产构建无条件暴露该无历史入口。保留它，只接受空请求；不能删除根来伪造回收。
            if (allowEmptyTrajectoryBridge && key === "__zcodeModelTrajectoryStoreE2E") {
              const bridge = (
                window as Window & {
                  __zcodeModelTrajectoryStoreE2E?: { getState(): { pendingRequest: unknown } };
                }
              ).__zcodeModelTrajectoryStoreE2E;
              return bridge?.getState().pendingRequest !== null;
            }
            return true;
          });
        }, returnToDraft),
        [],
        "SPR01 必须使用未暴露 E2E store bridge 的生产 renderer",
      );
      let cdp = await page.context().newCDPSession(page);
      const measurements: Array<
        { name: string; switches: number; heapMiB: number } & Awaited<
          ReturnType<typeof countRetainedHistory>
        >
      > = [];
      let switches = 0;
      await cdp.send("HeapProfiler.enable");
      try {
        // 基线从 session 0 开始；随后固定按 1..7,0 循环。
        await page.getByTestId(`task-item-${prefix}7`).waitFor({ state: "visible" });
        const more = page.locator("[data-task-list-show-more]");
        for (const button of await more.all()) {
          if (await button.isVisible()) await button.click();
        }
        const select = async (index: number) => {
          await page.locator(`[data-testid="task-item-${prefix}${index}"]`).click();
          await page.waitForFunction(
            ({ prefix, index }) => {
              const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
              return (
                pane?.getAttribute("data-session-id") === `${prefix}${index}` &&
                pane.textContent?.includes(`RETENTION_REPLY_${index}`)
              );
            },
            { prefix, index },
            // 首次跨工作区可能冷启动 runtime；验收等待内容就绪，不把机器负载当作泄漏失败。
            { timeout: 60_000 },
          );
          if (sameWorkspace) {
            const editor = page
              .locator('[data-testid="v4-session-pane-workspace-main"] [contenteditable="true"]')
              .first();
            await editor.click();
            await editor.fill("/");
            const panel = page.locator('[data-testid="prompt-suggestion-panel"][data-trigger="/"]');
            await panel.waitFor({ state: "visible" });
            assert((await panel.locator('[role="option"]').count()) > 0, "slash 选项必须实际出现");
            await editor.press("Escape");
            await panel.waitFor({ state: "hidden" });
            await editor.fill("");
          }
          await pause(150);
        };
        const showDraft = async () => {
          await page.getByTestId("task-new-button").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="v4-session-pane-workspace-main"]')
                ?.getAttribute("data-session-id") === "draft",
          );
        };
        await select(0);
        const checkpoints: Array<[string, number]> = sameWorkspace
          ? [
              ["draft-008", 8],
              ["draft-032", 32],
              ["draft-064", 64],
              ["draft-128", 128],
              ["idle-control", 128],
              ["single-connection-roundtrips", 128],
            ]
          : crossWorkspace
            ? [
                ["draft-008", 8],
                ["draft-016", 16],
                ["draft-032", 32],
                ["idle-control", 32],
              ]
            : [
                ["warmup-008", 8],
                ["switch-040", 40],
                ["switch-072", 72],
                ["switch-136", 136],
                ["idle-control", 136],
              ];
        for (const [name, target] of checkpoints) {
          while (switches < target) {
            await select((switches + 1) % 8);
            switches++;
            await appendFile(
              join(output, "switches.jsonl"),
              JSON.stringify({ switches, loaded: true }) + "\n",
            );
          }
          if (name === "single-connection-roundtrips") {
            // 四次往返共用一个操作连接；中途没有采堆、GC 或重连，排除检查点促成累积。
            for (const index of [1, 2, 3, 4]) {
              await select(index);
              await showDraft();
              await appendFile(
                join(output, "roundtrips.jsonl"),
                JSON.stringify({ index, returnedToDraft: true }) + "\n",
              );
            }
          } else if (returnToDraft && name !== "idle-control") {
            await showDraft();
          }
          // 自动化的 InjectedScript/UtilityScript 会持有 DOM。采样前释放操作连接，
          // 重连后先采堆，不执行页面脚本；不清除或修改任何产品引用。
          if (returnToDraft) {
            await cdp.detach();
            await browser.close();
          }
          // 只在测试等待既有 30s keep-warm 到期；不改变产品回收策略。
          await pause(35_000);
          if (returnToDraft) {
            browser = await chromium.connectOverCDP(endpoint);
            page = rendererPage(browser);
            cdp = await page.context().newCDPSession(page);
            await cdp.send("HeapProfiler.enable");
          }
          await cdp.send("Runtime.discardConsoleEntries");
          await cdp.send("HeapProfiler.collectGarbage");
          await pause(300);
          await cdp.send("HeapProfiler.collectGarbage");
          const usage = await cdp.send("Runtime.getHeapUsage");
          const path = join(output, `${name}.heapsnapshot`);
          const stream = createWriteStream(path);
          const chunk = ({ chunk }: { chunk: string }) => {
            stream.write(chunk);
          };
          cdp.on("HeapProfiler.addHeapSnapshotChunk", chunk);
          try {
            await cdp.send("HeapProfiler.takeHeapSnapshot", {
              reportProgress: false,
              captureNumericValue: true,
            });
          } finally {
            cdp.off("HeapProfiler.addHeapSnapshotChunk", chunk);
            await new Promise<void>((resolve, reject) => {
              stream.on("error", reject);
              stream.end(resolve);
            });
          }
          const counts = await countRetainedHistory(
            path,
            returnToDraft ? "draft" : `${prefix}0`,
            sourceMapPath,
          );
          const sample = { name, switches, heapMiB: usage.usedSize / 1048576, ...counts };
          measurements.push(sample);
          await writeFile(join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
          await page.screenshot({ path: join(output, `${name}.png`) });
          console.log(JSON.stringify(sample));
        }
        if (sameWorkspace) {
          const idle = measurements.find((sample) => sample.name === "idle-control")!.callbacks!;
          const roundtrips = measurements.at(-1)!.callbacks!;
          for (const sample of measurements) {
            assert.equal(sample.callbacks!.onFocus, 1, `${sample.name}: onFocus 回调累积`);
            assert.deepEqual(
              sample.callbacks!.lexicalUpdateListeners,
              measurements[0]!.callbacks!.lexicalUpdateListeners,
              `${sample.name}: Lexical listener 累积`,
            );
          }
          // 相同草稿表面允许 React alternate 多持有一份，不能按往返次数保留旧 render 链。
          assert(roundtrips.prewarmWaiter <= idle.prewarmWaiter + 1, "预热等待回调随往返累积");
          assert(roundtrips.fileLink <= idle.fileLink + 1, "旧页面文件链接回调随往返累积");
        }
        // 先收齐全部检查点及闲置对照，红灯时也保留完整曲线和堆快照。
        for (const sample of measurements) {
          // SPR03 中间返回草稿时，当前编辑器的 slash 回调可能仍持有上一页闭包；
          // 它不属于预热注册表。保留中间证据，最终与闲置对照都必须真正释放历史。
          if (sameWorkspace || !crossWorkspace || sample.switches === 32) {
            assert.equal(sample.inactiveSnapshots, 0, `${sample.name}: 非当前会话 snapshot 未释放`);
            assert.equal(sample.closedStores, 0, `${sample.name}: 已关闭 store 未释放`);
          }
          assert.equal(
            sample.liveStores,
            returnToDraft ? 0 : 1,
            `${sample.name}: 历史 store 数量错误`,
          );
          if (returnToDraft) {
            assert.equal(
              sample.inactivePrewarmCoordinators,
              0,
              `${sample.name}: 空闲预热 owner 未释放`,
            );
          }
        }
      } finally {
        if (browser.isConnected()) {
          await cdp.send("HeapProfiler.disable");
          await cdp.detach();
        }
      }
    } finally {
      await browser.close();
    }
  },
);
