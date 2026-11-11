import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { findE2EBashOutputPath, resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  getLatestUpstreamToolResultByToolCallId,
  countUpstreamRequests,
} from "#e2e/helpers/conversation-session-network";
import { withoutTotalTokensReminderText } from "#e2e/helpers/total-tokens-evidence";
import {
  listToolCallBlocks,
  waitForFoldedToolCallBlockByToolCallId,
  waitForToolCallBlockByToolCallId,
} from "#e2e/helpers/conversation-session-tool";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  getV4ConfigProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

const ROOT = resolveE2ERuntimePath("bash-direct-output", "中文 空格");
const LIMIT = 5 * 1024 ** 3;
const RELEASES = [
  "A.release",
  "B.release",
  "B.finish",
  "query.grow",
  "query.release",
  "foreground.release",
  "foreground.finish",
  "background.release",
  "background.finish",
  "read-failure.release",
  "realtime.1.release",
  "realtime.2.release",
  "realtime.3.release",
  "realtime.4.release",
  "realtime.5.release",
];
const outputs = new Set<string>();

async function release(name: string) {
  await writeFile(join(ROOT, name), "release");
}
async function waitFile(name: string) {
  await browser.waitUntil(async () => (await stat(join(ROOT, name)).catch(() => null)) !== null, {
    timeout: 90000,
    timeoutMsg: `producer 没有到达 ${name}`,
  });
}
async function idle() {
  await waitForV4ConversationState((s) => s.state === "idle", "BDO 会话没有回到 idle", 30000);
}
async function prompt(marker: string, newTask = true) {
  if (newTask) {
    // 合并适配：全局新任务落到独立聊天目录，Bash fixture 必须从 ZCodeProject 发起。
    await startDraftFromProject(DEFAULT_WORKSPACE);

    // 项目新草稿恢复 build；显式选择 yolo，避免把模式切换动画中的旧文案当成已选中。
    await switchV4Mode("yolo");
    await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
      timeout: 15000,
      timeoutMsg: "项目草稿未应用 yolo 模式",
    });
  }
  await sendV4Prompt(`${marker}: Execute the exact Bash output regression fixture.`);
}
async function done(marker: string) {
  await waitForV4AssistantMessageContaining(`${marker}_DONE`, 90000);
  await idle();
}
async function result(id: string) {
  const value = await getLatestUpstreamToolResultByToolCallId(id);
  expect(value).not.toBeNull();
  // 修复原因：工具批次后的 token 预算提醒以 `\n\n` 段并进 tool_result 文本，按原样比较
  // Bash 结果会多出提醒段；这里只断言 Bash 结果本身，按完整形态去掉提醒段。
  return { ...value!, content: withoutTotalTokensReminderText(value!.content) };
}
async function outputPath(id: string) {
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  expect(sessionId).not.toBe("draft");
  const path = await findE2EBashOutputPath(sessionId!, id);
  if (!path) throw new Error(`Bash 未保留预期输出文件: ${sessionId}/${id}`);
  outputs.add(path);
  return path;
}
async function snippet(path: string, tail = false) {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 128));
    await handle.read(buffer, 0, buffer.length, tail ? size - buffer.length : 0);
    return buffer.toString();
  } finally {
    await handle.close();
  }
}
async function setExpanded(id: string, expanded: boolean) {
  await waitForToolCallBlockByToolCallId(id);
  const trigger = await $(`[data-testid="tool-summary-trigger-${id}"]`);
  if ((await trigger.getAttribute("aria-expanded")) !== String(expanded)) await trigger.click();
}

async function assertOutputHidden(id: string) {
  await browser.waitUntil(
    async () =>
      browser.execute((toolId) => {
        const block = document.querySelector(`[data-testid="chat-tool-call-block-${toolId}"]`);
        return (
          Boolean(block) &&
          !block!.querySelector(
            '[data-testid^="bash-output-preview-"], [data-testid="bash-result-output"], [data-testid="bash-output-notice"], [data-testid="bash-output-file"]',
          )
        );
      }, id),
    { timeout: 5000, timeoutMsg: `收起后的 Bash 仍渲染输出：${id}` },
  );
}

describe("Bash 直接文件输出补充 E2E", () => {
  before(async function () {
    this.timeout(120000);
    await mkdir(ROOT, { recursive: true });
    await copyFile(
      new URL(
        "../../fixtures/fs/conversation-session/bash-direct-output/writer.cjs",
        import.meta.url,
      ),
      join(ROOT, "writer.cjs"),
    );
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
      timeout: 15000,
      timeoutMsg: "项目草稿未应用 yolo 模式",
    });
  });
  beforeEach(async () => {
    for (const name of await readdir(ROOT)) if (name.endsWith(".pid")) await rm(join(ROOT, name));
    for (const name of [
      ...RELEASES,
      "query.ready",
      "query.grown",
      "foreground.ready",
      "background.ready",
      "read-failure.ready",
      "realtime.1.ready",
      "realtime.2.ready",
      "realtime.3.ready",
      "realtime.4.ready",
      "realtime.5.ready",
    ]) {
      await rm(join(ROOT, name), { force: true });
    }
  });
  afterEach(async () => {
    // 失败同样释放本 case 的子进程，避免下一条测试或 coverage teardown 被遗留任务影响。
    await Promise.all(RELEASES.map(release));
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
    const pids = await Promise.all(
      (await readdir(ROOT))
        .filter((name) => name.endsWith(".pid"))
        .map(async (name) => Number(await readFile(join(ROOT, name), "utf8"))),
    );
    await browser.waitUntil(
      async () =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
      { timeout: 10000, timeoutMsg: "本条 Bash producer 没有清理完成" },
    );
    for (const path of outputs) await rm(path, { force: true, recursive: true });
    outputs.clear();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BDO01: 中文空格路径、两流无换行与非零空输出保持正确结果", async function () {
    this.timeout(120000);
    await prompt("E2E_BDO_SMALL");
    await done("E2E_BDO_SMALL");
    expect((await result("toolu_bdo_small")).content).toBe("BDO_中文_STDOUT|中文_STDERR");
    expect((await result("toolu_bdo_empty_error")).content).toContain("Exit code 7");
    // 小输出应清理实际临时文件；检查当前 session/tool 的所有候选，而不是旧 HOME 路径。
    expect(
      await findE2EBashOutputPath((await getV4PaneSnapshot()).sessionId!, "toolu_bdo_small"),
    ).toBeNull();
  });

  it("BDO02: 超过 64 MiB 的前台输出保留完整文件，详情只展示正文", async function () {
    this.timeout(120000);
    await prompt("E2E_BDO_LARGE");
    await done("E2E_BDO_LARGE");
    const path = await outputPath("toolu_bdo_large");
    expect((await stat(path)).size).toBe(
      65 * 1024 ** 2 + Buffer.byteLength("BDO_HEAD\n\nBDO_TAIL\n"),
    );
    expect(await snippet(path)).toContain("BDO_HEAD");
    expect(await snippet(path, true)).toContain("BDO_TAIL");
    expect((await result("toolu_bdo_large")).content).toContain(path);
    // 修复原因：轮次结束约 0.3 秒后工具卡才收进工作记录并重挂；先等收起完成再操作卡片。
    await waitForFoldedToolCallBlockByToolCallId("toolu_bdo_large");
    await setExpanded("toolu_bdo_large", false);
    await assertOutputHidden("toolu_bdo_large");
    await setExpanded("toolu_bdo_large", true);
    const body = await $('[data-testid="bash-result-output"]');
    await body.waitForDisplayed();
    await browser.waitUntil(async () => (await body.getText()).includes("BDO_HEAD"), {
      timeout: 10000,
      timeoutMsg: "展开后的 Bash 头部摘要没有显示",
    });
    expect(await body.getText()).toContain("BDO_HEAD");
    expect(await body.getText()).not.toContain("BDO_TAIL");
    expect(Buffer.byteLength(await body.getText())).toBe(30000);
    expect(await $('[data-testid="bash-output-notice"]').isExisting()).toBe(false);
    expect(await $('[data-testid="bash-output-file"]').isExisting()).toBe(false);
    await setExpanded("toolu_bdo_large", false);
    await assertOutputHidden("toolu_bdo_large");
  });

  it("BDO03: 并发前台 Bash 共享进度期间一个退出不影响另一个", async function () {
    this.timeout(120000);
    const previews = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="bash-output-preview-full"]')).map(
          (el) => el.textContent ?? "",
        ),
      );
    const waitPreview = (text: string) =>
      browser.waitUntil(async () => (await previews()).some((s) => s.includes(text)), {
        timeout: 30000,
        timeoutMsg: `Bash 没有更新进度：${text}`,
      });
    // 同一批 mutating Bash 会串行执行；两个独立会话才能形成真实并发。
    await prompt("E2E_BDO_PROGRESS_A");
    await setExpanded("toolu_bdo_progress_a", true);
    await waitPreview("A-STAGE1");
    const fullPreview = await $('[data-testid="bash-output-preview-full"]');
    await fullPreview.waitForDisplayed();
    // 展开动画期间元素已有尺寸但可见文本仍可能为空；等待实际预览再检查行数和字节数。
    await browser.waitUntil(async () => (await fullPreview.getText()).includes("A-STAGE1"), {
      timeout: 10000,
      timeoutMsg: "展开后的 Bash 进度预览没有显示",
    });
    const fullText = await fullPreview.getText();
    expect(fullText).toContain("A-STAGE1");
    expect(fullText.split("\n").length).toBeGreaterThan(5);
    expect(fullText.split("\n").length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(fullText)).toBeLessThanOrEqual(4096);
    await setExpanded("toolu_bdo_progress_a", false);
    await assertOutputHidden("toolu_bdo_progress_a");
    const sessionA = (await getV4PaneSnapshot()).sessionId!;
    await outputPath("toolu_bdo_progress_a");
    await prompt("E2E_BDO_PROGRESS_B");
    await setExpanded("toolu_bdo_progress_b", true);
    await waitPreview("B-STAGE1");
    const sessionB = (await getV4PaneSnapshot()).sessionId!;
    await outputPath("toolu_bdo_progress_b");
    for (const text of await previews()) expect(text.length).toBeLessThanOrEqual(4096);
    await selectV4TaskById(sessionA);
    // 切回会话后明确展开，再检查进度；不隐含验证卡片展开状态的恢复。
    await setExpanded("toolu_bdo_progress_a", true);
    await waitPreview("A-STAGE1");
    await release("A.release");
    await done("E2E_BDO_PROGRESS_A");
    await selectV4TaskById(sessionB);
    await setExpanded("toolu_bdo_progress_b", true);
    await release("B.release");
    await browser.waitUntil(async () => (await previews()).some((s) => s.includes("B-STAGE2")), {
      timeout: 10000,
      timeoutMsg: "第一个 Bash 完成后另一个 Bash 的进度停止更新",
    });
    await release("B.finish");
    await done("E2E_BDO_PROGRESS_B");
    expect(await previews()).toEqual([]);
  });

  it("BDO07: 展开时实时刷新，收起不渲染输出，再展开显示最新内容", async function () {
    this.timeout(60000);
    const id = "toolu_bdo_realtime";
    const marker = "E2E_BDO_REALTIME";
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifactDir) throw new Error("E2E artifact directory is required for refresh timings");
    const observations: {
      stage: number;
      fileVisibleMs: number;
      previewVisibleMs: number;
      height: number;
      lineHeight: number;
      bottomGap: number;
    }[] = [];
    await prompt(marker);
    await waitFile("realtime.1.ready");
    const path = await outputPath(id);
    const pid = Number(await readFile(join(ROOT, "realtime.pid"), "utf8"));
    await setExpanded(id, true);
    let expectedOutput = "";
    let frozenOutput = "";
    const scrollMetrics = () =>
      browser.execute(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="bash-output-scroll"]')!;
        return {
          height: el.clientHeight,
          lineHeight: Number.parseFloat(getComputedStyle(el.querySelector("pre")!).lineHeight),
          bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight,
        };
      });

    for (const stage of [1, 2, 3, 4, 5]) {
      if (stage > 1) await waitFile(`realtime.${stage}.ready`);
      const writtenAt = Number(await readFile(join(ROOT, `realtime.${stage}.ready`), "utf8"));
      const fragment = `实时-${stage}-stdout|实时-${stage}-stderr`;
      expectedOutput += (stage > 1 ? `line-${stage} abcdefghijklmnop\n`.repeat(80) : "") + fragment;
      // ready 由 producer 在两流写入后创建；release 前直接读原文件，不能用最终结果冒充实时输出。
      expect(await readFile(path, "utf8")).toBe(expectedOutput);
      const fileVisibleMs = Date.now() - writtenAt;
      if (stage === 3) {
        // 收起期间跨过一次 1 秒进度轮询；新输出仍不能重新渲染正文。
        await browser.pause(1200);
        await assertOutputHidden(id);
        await setExpanded(id, true);
      }
      const preview = await $('[data-testid="bash-output-preview-full"]');
      if (stage === 4) {
        // 用户上滚后即使 CLI 已发布新一段，正在阅读的有界窗口也不能被替换。
        await browser.pause(1500);
        expect(await preview.getText()).toBe(frozenOutput);
        await browser.execute(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="bash-output-scroll"]')!;
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
      }
      await browser.waitUntil(
        async () => (await preview.isExisting()) && (await preview.getText()).includes(fragment),
        {
          timeout: stage === 1 ? 8000 : 5000,
          timeoutMsg: `第 ${stage} 段 Bash 输出未在退出前刷新`,
        },
      );
      const previewVisibleMs = Date.now() - writtenAt;
      expect(previewVisibleMs).toBeLessThanOrEqual(stage === 1 ? 8000 : 5000);
      expect(process.kill(pid, 0)).toBe(true);
      expect((await listToolCallBlocks()).find((block) => block.toolCallId === id)?.status).toBe(
        "in_progress",
      );
      expect(await getLatestUpstreamToolResultByToolCallId(id)).toBeNull();
      const metrics = await scrollMetrics();
      observations.push({ stage, fileVisibleMs, previewVisibleMs, ...metrics });
      console.log("BASH_REALTIME_VIEWPORT", JSON.stringify(observations.at(-1)));
      await writeFile(
        join(artifactDir, "bash-realtime-refresh.json"),
        JSON.stringify(observations, null, 2),
      );
      expect(metrics.lineHeight).toBeGreaterThan(0);
      expect(metrics.height).toBe(metrics.lineHeight * (stage === 1 ? 1 : 5));
      expect(metrics.bottomGap).toBeLessThanOrEqual(1);
      const scrollViewport = await $('[data-testid="bash-output-scroll"]');
      await browser.waitUntil(
        async () =>
          (await scrollViewport.getAttribute("data-scroll-mask")) ===
          (stage === 1 ? "none" : "top"),
        { timeout: 5000, timeoutMsg: "Bash 吸底后渐隐方向不正确" },
      );
      expect(
        await scrollViewport.getCSSProperty("mask-image").then((value) => value.value === "none"),
      ).toBe(stage === 1);
      expect(await $('[data-testid="bash-output-resume"]').isExisting()).toBe(false);
      if (stage === 2) {
        await setExpanded(id, false);
        await assertOutputHidden(id);
      }
      if (stage === 3 || stage === 5) {
        frozenOutput = await preview.getText();
        await browser.execute(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="bash-output-scroll"]')!;
          el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await browser.waitUntil(
          async () => (await scrollViewport.getAttribute("data-scroll-mask")) === "both",
          {
            timeout: 5000,
            timeoutMsg: "Bash 中间位置没有上下渐隐",
          },
        );
        await browser.execute(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="bash-output-scroll"]')!;
          el.scrollTop = 0;
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await browser.waitUntil(
          async () =>
            (await $('[data-testid="bash-output-scroll"]').getAttribute("data-following")) ===
            "false",
          { timeout: 5000, timeoutMsg: "用户上滚后没有暂停跟随" },
        );
        expect(await $('[data-testid="bash-output-resume"]').isExisting()).toBe(false);
        expect(await scrollViewport.getAttribute("data-scroll-mask")).toBe("bottom");
      }
      await release(`realtime.${stage}.release`);
    }

    await done(marker);
    // 修复原因：最后一轮结束后保持同一组件实例，约 0.3 秒后工具卡才收进工作记录并重挂；
    // 先等卡片落进展开的工作记录，否则收起/展开点在正在卸载的旧节点上。
    await waitForFoldedToolCallBlockByToolCallId(id);
    await setExpanded(id, false);
    await assertOutputHidden(id);
    await setExpanded(id, true);
    // 详情有展开动画；等待真实可见文本，不能把动画首帧的空 getText 当成丢输出。
    const finalOutput = await $('[data-testid="bash-result-output"]');
    await browser.waitUntil(async () => (await finalOutput.getText()) === expectedOutput, {
      timeout: 10000,
      timeoutMsg: "重新展开后没有显示最终 Bash 输出",
    });
    const finalMetrics = await scrollMetrics();
    expect(finalMetrics.height).toBe(finalMetrics.lineHeight * 5);
    expect(await $('[data-testid="bash-output-resume"]').isExisting()).toBe(false);
    expect((await result(id)).content).toBe(expectedOutput);
    expect((await waitForToolCallBlockByToolCallId(id)).status).toBe("completed");
    expect(await $('[data-testid="bash-output-preview-short"]').isExisting()).toBe(false);
    expect(await $('[data-testid="bash-output-preview-full"]').isExisting()).toBe(false);
    await setExpanded(id, false);
    await assertOutputHidden(id);
    expect(
      await countUpstreamRequests({ includes: [marker], excludes: ["Generate a concise title"] }),
    ).toBe(2);
  });

  it("BDO04: TaskOutput 运行时重复头读、完成后尾读", async function () {
    this.timeout(120000);
    await prompt("E2E_BDO_QUERY");
    await done("E2E_BDO_QUERY");
    await waitFile("query.ready");
    const path = await outputPath("toolu_bdo_query");
    await prompt("E2E_BDO_QUERY_FIRST", false);
    await done("E2E_BDO_QUERY_FIRST");
    const first = (await result("toolu_bdo_query_first")).content;
    expect(first).toContain("BDO_QUERY_HEAD");
    expect(first).not.toContain("BDO_QUERY_FIRST_TAIL");
    await release("query.grow");
    await waitFile("query.grown");
    await prompt("E2E_BDO_QUERY_SECOND", false);
    await done("E2E_BDO_QUERY_SECOND");
    const second = (await result("toolu_bdo_query_second")).content;
    const firstOutput = first.match(/<output>([\s\S]*?)<\/output>/)?.[1];
    expect(firstOutput).toBeDefined();
    expect(second.match(/<output>([\s\S]*?)<\/output>/)?.[1]).toBe(firstOutput);
    expect(second).not.toContain("BDO_QUERY_SECOND_TAIL");
    await release("query.release");
    await waitForV4AssistantMessageContaining("E2E_BDO_QUERY_NOTIFIED", 30000);
    await prompt("E2E_BDO_QUERY_FINAL", false);
    await done("E2E_BDO_QUERY_FINAL");
    const final = (await result("toolu_bdo_query_final")).content;
    expect(final).toContain("BDO_QUERY_FINAL_TAIL");
    expect(final).not.toContain("BDO_QUERY_HEAD");
    expect((await stat(path)).size).toBeGreaterThan(600000);
  });

  for (const mode of ["foreground", "background"] as const) {
    it(`BDO05: ${mode} 真实 5 GiB 边界与 5 秒 watchdog`, async function () {
      this.timeout(150000);
      const disk = await statfs(ROOT, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(12 * 1024 ** 3))
        throw new Error("5 GiB 实写需要至少 12 GiB 可用空间，未执行不能算通过");
      const marker = `E2E_BDO_LIMIT_${mode.toUpperCase()}`;
      await prompt(marker);
      await waitFile(`${mode}.ready`);
      const path = await outputPath(`toolu_bdo_limit_${mode}`);
      expect((await stat(path)).size).toBe(LIMIT);
      // 跨过完整检查周期后，等于阈值的命令必须仍存活。
      await browser.pause(5500);
      const pid = Number(await readFile(join(ROOT, `${mode}.pid`), "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      await release(`${mode}.release`);
      await waitFile(`${mode}.exceeded`);
      await waitForV4AssistantMessageContaining(`${marker}_KILLED`, 20000);
      await idle();
      if (mode === "foreground") {
        const output = await result("toolu_bdo_limit_foreground");
        expect(output.isError).toBe(true);
        // 取消结果超过模型预算时沿用 artifact 包装，诊断在完整结果中而非 2 KiB 预览里。
        const persisted = output.content.match(/Full output saved to: ([^\n]+)/)?.[1];
        const full = persisted ? await readFile(persisted, "utf8") : output.content;
        expect(full).toContain("Command killed: output file exceeded 5GB");
        expect(await stat(path).catch(() => null)).toBeNull();
      } else {
        expect((await stat(path)).size).toBe(LIMIT + 1);
        expect(
          await countUpstreamRequests({
            includes: [marker, "<task-notification>", "<status>killed</status>"],
          }),
        ).toBe(1);
      }
      await browser.waitUntil(
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 10000, timeoutMsg: "超限 producer 没有退出" },
      );
    });
  }

  it("BDO06: 真实输出读取/打开失败有诊断，后续 Bash 仍能执行", async function () {
    this.timeout(120000);
    await prompt("E2E_BDO_READ_FAILURE");
    await waitFile("read-failure.ready");
    const path = await outputPath("toolu_bdo_read_failure");
    await rm(path);
    await release("read-failure.release");
    await done("E2E_BDO_READ_FAILURE");
    expect((await result("toolu_bdo_read_failure")).content).toContain("bash output unavailable");
    // 故障注入必须沿用本 session 已发布的实际输出目录，不能在退役 HOME 根创建障碍。
    const blocked = join(dirname(path), "toolu_bdo_open_failure-stdout.log");
    outputs.add(blocked);
    await mkdir(blocked, { recursive: true });
    await prompt("E2E_BDO_OPEN_FAILURE", false);
    await done("E2E_BDO_OPEN_FAILURE");
    // 启动失败没有进程退出码；验证实际错误诊断，不套用命令非零退出的 is_error 契约。
    expect((await result("toolu_bdo_open_failure")).content).toContain("EISDIR");
    expect((await stat(blocked)).isDirectory()).toBe(true);
    await prompt("E2E_BDO_RECOVERY", false);
    await done("E2E_BDO_RECOVERY");
    expect((await result("toolu_bdo_recovery")).content).toBe("BDO_中文_STDOUT|中文_STDERR");
  });
});
