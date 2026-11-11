import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData, seedSettings } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "#e2e/helpers/conversation-session-tool-cross-product";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_TOOL_DETAIL_TOGGLE_READ";
const TOOL_TURN_TIMEOUT_MS = 150000;
const TOOL_DETAIL_TOGGLE_EPSILON_PX = 2;
const TOOL_DETAIL_RUNTIME_ROOT = resolveE2ERuntimePath(
  "conversation-session-tool-detail-toggle-stability",
);
const TOOL_DETAIL_READ_FILES = [
  join(TOOL_DETAIL_RUNTIME_ROOT, "read-fixture-a.txt"),
  join(TOOL_DETAIL_RUNTIME_ROOT, "read-fixture-b.txt"),
] as const;

interface ToolDetailToggleSample {
  contentDisplay: string;
  contentExists: boolean;
  contentHeight: number;
  contentHidden: boolean;
  expanded: boolean;
  shellHeight: number;
  time: number;
}

interface ToolDetailToggleProbe {
  error?: string;
  samples: ToolDetailToggleSample[];
  targetOpen: boolean;
}

describe("P08 摘要组折叠与 Read 行稳定性", () => {
  before(async function () {
    this.timeout(TOOL_TURN_TIMEOUT_MS);
    await seedSettings({ messageStreamShowTodos: true });
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    await stopIfBusy();
    await cleanupReadFixture();
  });

  after(async () => {
    await cleanupReadFixture();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("连续 Read 摘要组展开收起高度连续归零且 Read 不创建详情", async function () {
    this.timeout(TOOL_TURN_TIMEOUT_MS);

    await prepareReadFixture();
    await ensureToolCrossProductFullAccessMode();

    const prompt = [
      `${CASE_MARKER}_${Date.now()}:`,
      `Read ${TOOL_DETAIL_READ_FILES[0]} and ${TOOL_DETAIL_READ_FILES[1]}.`,
      `Then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" ");
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(CASE_MARKER);
    await waitForUpstreamRequestContaining(CASE_MARKER);
    await waitForToolTurnIdle();
    // 修复原因：正式 v4 replay 可能在下一条 DOM 断言前已完成整轮，工具块此时
    // 已进入折叠历史；先展开完成态历史，再访问真实 Read，避免只在慢响应下通过。
    await expandAssistantHistoriesWithContent();

    const groupTrigger = await $("[data-summary-group-trigger]");
    await groupTrigger.waitForDisplayed();
    await expect(groupTrigger).toHaveAttribute("aria-expanded", "false");
    assertExploreToolDetailToggleProbe(
      await probeLatestExploreToolDetailToggle(true, "[data-summary-group-trigger]"),
    );
    assertExploreToolDetailToggleProbe(
      await probeLatestExploreToolDetailToggle(false, "[data-summary-group-trigger]"),
    );
    const block = await waitForToolCallBlockByToolName("Read", 30000);
    expect(block.exists).toBe(true);
    expect(block.toolName).toBe("Read");
    // Read 当前仅显示文件摘要（canToggle=false）；不应沿用旧 Explore 的详情折叠断言。
    const readTrigger = await $('[data-tool-name="Read"] [data-testid^="tool-summary-trigger-"]');
    await expect(readTrigger).not.toHaveAttribute("aria-expanded");
    expect((await $$('[data-tool-name="Read"]')).length).toBe(2);
  });
});

async function prepareReadFixture(): Promise<void> {
  await cleanupReadFixture();
  await mkdir(TOOL_DETAIL_RUNTIME_ROOT, { recursive: true });
  await Promise.all(
    TOOL_DETAIL_READ_FILES.map((filePath, index) =>
      writeFile(
        filePath,
        [
          `P08_READ_FILE_${index + 1}_CONTENT`,
          "This file is read by the P08 Explore toggle stability e2e.",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ),
  );
}

async function cleanupReadFixture(): Promise<void> {
  await rm(TOOL_DETAIL_RUNTIME_ROOT, { recursive: true, force: true });
}

async function waitForToolTurnIdle(): Promise<void> {
  let latestState = "not-started";
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      const snapshot = await getV4PaneSnapshot();
      latestState = JSON.stringify({
        canStop: snapshot.canStop,
        sessionId: snapshot.sessionId,
      });
      return !snapshot.canStop;
    },
    {
      timeout: TOOL_TURN_TIMEOUT_MS,
      timeoutMsg: `P08 Read 工具轮没有结束，latest=${latestState}`,
    },
  );
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
}

function probeLatestExploreToolDetailToggle(
  targetOpen: boolean,
  selector = `[data-tool-name="Read"] [data-testid^="${TID_TOOL_SUMMARY_TRIGGER}-"]`,
): Promise<ToolDetailToggleProbe> {
  return browser.executeAsync(
    (triggerSelector, shouldOpen, done) => {
      const trigger = Array.from(document.querySelectorAll<HTMLElement>(triggerSelector)).at(-1);
      const shell = trigger?.closest<HTMLElement>('[data-slot="collapsible"]');
      if (!trigger || !shell) {
        done({
          error: "explore-toggle-elements-missing",
          samples: [],
          targetOpen: shouldOpen,
        });
        return;
      }

      const readSample = (): ToolDetailToggleSample => {
        const content = Array.from(shell.children).find(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.dataset.slot === "collapsible-content",
        );
        const contentStyle = content ? window.getComputedStyle(content) : null;
        return {
          contentDisplay: contentStyle?.display ?? "none",
          contentExists: content !== undefined,
          contentHeight: content?.getBoundingClientRect().height ?? 0,
          contentHidden: content?.hasAttribute("hidden") ?? true,
          expanded: trigger.getAttribute("aria-expanded") === "true",
          shellHeight: shell.getBoundingClientRect().height,
          time: performance.now(),
        };
      };

      const samples = [readSample()];
      if (samples[0]?.expanded === shouldOpen) {
        done({
          error: "explore-toggle-already-at-target",
          samples,
          targetOpen: shouldOpen,
        });
        return;
      }

      trigger.click();
      const startedAt = performance.now();
      const sampleAnimation = () => {
        const current = readSample();
        samples.push(current);
        const elapsed = performance.now() - startedAt;
        const settled = shouldOpen
          ? current.expanded &&
            current.contentExists &&
            !current.contentHidden &&
            current.contentDisplay !== "none" &&
            current.contentHeight > 0
          : !current.expanded &&
            (!current.contentExists || current.contentHidden || current.contentDisplay === "none");
        if (elapsed >= 450 && settled) {
          done({ samples, targetOpen: shouldOpen });
          return;
        }
        if (elapsed >= 1200) {
          done({
            error: "explore-toggle-animation-not-settled",
            samples,
            targetOpen: shouldOpen,
          });
          return;
        }
        requestAnimationFrame(sampleAnimation);
      };
      requestAnimationFrame(sampleAnimation);
    },
    selector,
    targetOpen,
  ) as Promise<ToolDetailToggleProbe>;
}

function assertExploreToolDetailToggleProbe(probe: ToolDetailToggleProbe): void {
  if (probe.error || probe.samples.length < 10) {
    throw new Error(`P08 Explore 折叠采样不完整: ${JSON.stringify(probe)}`);
  }

  const samples = probe.samples;
  const finalSample = samples.at(-1)!;
  if (finalSample.expanded !== probe.targetOpen) {
    throw new Error(`P08 Explore 折叠终态不正确: ${JSON.stringify(probe)}`);
  }

  const reversals = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous) return [];
    const reversed = probe.targetOpen
      ? sample.contentHeight + TOOL_DETAIL_TOGGLE_EPSILON_PX < previous.contentHeight
      : sample.contentHeight - TOOL_DETAIL_TOGGLE_EPSILON_PX > previous.contentHeight;
    return reversed
      ? [
          {
            index,
            previous: previous.contentHeight,
            value: sample.contentHeight,
          },
        ]
      : [];
  });
  if (reversals.length > 0) {
    throw new Error(`P08 Explore 折叠高度方向反转: ${JSON.stringify({ reversals, probe })}`);
  }

  if (!probe.targetOpen) {
    const firstHiddenIndex = samples.findIndex(
      (sample, index) =>
        index > 0 &&
        (!sample.contentExists || sample.contentHidden || sample.contentDisplay === "none"),
    );
    const lastVisible = firstHiddenIndex <= 0 ? undefined : samples[firstHiddenIndex - 1];
    const firstHidden = firstHiddenIndex < 0 ? undefined : samples[firstHiddenIndex];
    const finalHeightJump =
      lastVisible === undefined || firstHidden === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(firstHidden.shellHeight - lastVisible.shellHeight);
    if (
      lastVisible === undefined ||
      lastVisible.contentHeight > TOOL_DETAIL_TOGGLE_EPSILON_PX ||
      finalHeightJump > TOOL_DETAIL_TOGGLE_EPSILON_PX
    ) {
      throw new Error(
        `P08 Explore 收起仍有尾部间距跳变: ${JSON.stringify({ finalHeightJump, lastVisible, probe })}`,
      );
    }
  }
}

async function stopIfBusy(): Promise<void> {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) {
    return;
  }
  await clickV4Stop();
  await waitForV4Pane(
    (nextSnapshot) => !nextSnapshot.canStop,
    "P08 afterEach stop 后没有退出 streaming",
    30000,
  );
}
