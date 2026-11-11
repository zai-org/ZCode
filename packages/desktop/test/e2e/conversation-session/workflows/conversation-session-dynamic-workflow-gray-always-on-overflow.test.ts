import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";

// 时间线的溢出与并行结构（docs/dynamic-workflow/presentation.md「Drawing the timeline」：「Rails and
// arcs」「Stream rails」「Past six participants」「Overflow: the ledge」；「The timeline model」「The run
// pane」「The spine」）：
// 六个阶段，宽过会话列。「铺开」九个子代理并行，其中六个是带类型的 ask、只回文字不提交，催交一轮后
// 由 run 引擎判失败（脚本 catch 住，run 继续）；「产出」「消化」是用 channel 相连的两段 future，
// 流水线让两站成为一条流轨；「起草」「复核」循环两轮，复核 → 起草是一条回弧；最后「收尾」。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用；编译、确认窗、run 引擎、子代理会话、流水线与完成通知走产品链路。
// 两处运行态用受控流挂起：产出员的第二问与消化员的第一问同时挂着（两站都在跑，流在流动）；
// 复核员第二轮挂着（循环第二轮，镜头居中运行站）。断言做完再释放，不靠延时抢时序。
const RUN_NAME = "E2E 检查流水线";
const STATION_NAMES = ["铺开", "产出", "消化", "起草", "复核", "收尾"];
const CHECKERS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"].map((n) => `检查员${n}`);
const FAILED_CHECKERS = CHECKERS.slice(3);

let runId = "";

interface TimelineSnapshot {
  digest: { x: number; y: number; width: number; height: number; expanded: string | null };
  runStatus: string | null;
  stations: Array<{ text: string; title: string; status: string; folded: boolean }>;
  rails: Array<{
    from: string;
    to: string;
    kind: string | null;
    ink: string | null;
    chevrons: string | null;
    flowing: number;
  }>;
  arcs: Array<{ from: string; to: string; ink: string | null; stream: boolean }>;
  roster: {
    flag: string | null;
    pills: Array<{ name: string; status: string }>;
    more: { count: string | null; text: string; failed: string | null; faces: number } | null;
  } | null;
  ledges: Record<
    "left" | "right",
    { lamps: Array<{ index: number; label: string }>; more: string | null } | null
  >;
  scroller: { scrollLeft: number; clientWidth: number; scrollWidth: number } | null;
  scrollbar: { trackWidth: number; thumbWidth: number } | null;
}

/** 一次读出这张 run 卡时间线上要断言的全部状态（失败时整份打进报错，便于对照截图）。 */
async function readTimeline(id: string): Promise<TimelineSnapshot | null> {
  return browser.execute((runIdArg: string) => {
    const digest = document.querySelector<HTMLElement>(
      `[data-workflow-run-digest="true"][data-workflow-run-id="${runIdArg}"]`,
    );
    if (digest === null) return null;
    const all = (selector: string, root: ParentNode = digest) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector));
    const rect = digest.getBoundingClientRect();
    const firstPills = digest.querySelector<HTMLElement>('[data-testid="workflow-timeline-pills"]');
    const moreRow = firstPills?.querySelector<HTMLElement>(
      '[data-testid="workflow-roster-more-row"]',
    );
    const ledge = (side: "left" | "right") => {
      const root = digest.querySelector<HTMLElement>(
        `[data-testid="workflow-timeline-ledge-${side}"]`,
      );
      if (root === null) return null;
      return {
        lamps: all('[data-testid="workflow-timeline-ledge-lamp"]', root).map((lamp) => ({
          index: Number(lamp.getAttribute("data-station-index")),
          label: lamp.getAttribute("aria-label") ?? "",
        })),
        more:
          root.querySelector('[data-testid="workflow-timeline-ledge-more"]')?.textContent ?? null,
      };
    };
    const scroller = digest.querySelector<HTMLElement>(
      '[data-testid="workflow-timeline-scroller"]',
    );
    const track = digest.querySelector<HTMLElement>('[data-testid="workflow-timeline-scrollbar"]');
    const thumb = track?.querySelector<HTMLElement>(
      '[data-testid="workflow-timeline-scrollbar-thumb"]',
    );
    return {
      digest: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        expanded: digest.getAttribute("data-expanded"),
      },
      runStatus: digest.getAttribute("data-workflow-run-status"),
      stations: all('[data-testid="workflow-timeline-station"]').map((station) => ({
        text: station.textContent ?? "",
        title:
          station
            .querySelector('[data-testid="workflow-timeline-station-head"]')
            ?.getAttribute("title") ?? "",
        status: station.getAttribute("data-station-status") ?? "",
        folded: station.getAttribute("data-station-folded") === "true",
      })),
      rails: all('[data-testid="workflow-timeline-rail"]').map((rail) => {
        const chevrons = rail.querySelector('[data-testid="workflow-stream-chevrons"]');
        return {
          from: rail.getAttribute("data-rail-from") ?? "",
          to: rail.getAttribute("data-rail-to") ?? "",
          kind: rail.getAttribute("data-rail-kind"),
          ink: rail.getAttribute("data-rail-ink"),
          chevrons: chevrons?.getAttribute("data-stream-ink") ?? null,
          flowing: chevrons?.querySelectorAll(".wf-stream-flow").length ?? 0,
        };
      }),
      arcs: all('[data-testid="workflow-timeline-arc"]').map((arc) => ({
        from: arc.getAttribute("data-arc-from") ?? "",
        to: arc.getAttribute("data-arc-to") ?? "",
        ink: arc.getAttribute("data-arc-ink"),
        stream: arc.getAttribute("data-arc-stream") === "true",
      })),
      roster:
        firstPills === null || firstPills === undefined
          ? null
          : {
              flag: firstPills.getAttribute("data-station-roster"),
              pills: all('[data-testid="workflow-agent-pill"]', firstPills).map((pill) => ({
                name: (pill.textContent ?? "").trim(),
                status: pill.getAttribute("data-agent-status") ?? "",
              })),
              more:
                moreRow === null || moreRow === undefined
                  ? null
                  : {
                      count: moreRow.getAttribute("data-more-count"),
                      text: moreRow.textContent ?? "",
                      failed:
                        moreRow.querySelector('[data-testid="workflow-more-failed"]')
                          ?.textContent ?? null,
                      faces:
                        moreRow.querySelector('[data-testid="workflow-more-deck"]')
                          ?.childElementCount ?? 0,
                    },
            },
      ledges: { left: ledge("left"), right: ledge("right") },
      scroller:
        scroller === null
          ? null
          : {
              scrollLeft: scroller.scrollLeft,
              clientWidth: scroller.clientWidth,
              scrollWidth: scroller.scrollWidth,
            },
      scrollbar:
        track === null || thumb === null || thumb === undefined
          ? null
          : {
              trackWidth: track.getBoundingClientRect().width,
              thumbWidth: thumb.getBoundingClientRect().width,
            },
    };
  }, id);
}

/** 轮询时间线直到满足条件；超时把最后一份快照写进日志。 */
async function waitForTimeline(
  predicate: (snapshot: TimelineSnapshot) => boolean,
  message: string,
  timeout = 120000,
): Promise<TimelineSnapshot> {
  let last: TimelineSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await readTimeline(runId);
        return last !== null && predicate(last);
      },
      { timeout, interval: 250, timeoutMsg: message },
    );
  } catch (error) {
    // wdio 的超时错误在定时器里就被报告，换掉 message 也带不进报告：快照写进日志，原错误照抛。
    console.log(`${message}\n最后一次时间线快照：${JSON.stringify(last)}`);
    throw error;
  }
  return last!;
}

function railOf(snapshot: TimelineSnapshot, from: number, to: number) {
  return snapshot.rails.find((rail) => rail.from === String(from) && rail.to === String(to));
}

function arcOf(snapshot: TimelineSnapshot, from: number, to: number) {
  return snapshot.arcs.find((arc) => arc.from === String(from) && arc.to === String(to));
}

/** 檐上的每枚灯：标签是「站名 · 状态」，且对应的站在内容里是折叠的。 */
function expectLedgeConsistent(snapshot: TimelineSnapshot, side: "left" | "right") {
  const ledge = snapshot.ledges[side]!;
  for (const lamp of ledge.lamps) {
    expect(lamp.label).toBe(
      `${STATION_NAMES[lamp.index]} · ${statusWord(snapshot.stations[lamp.index]!.status)}`,
    );
    expect(snapshot.stations[lamp.index]!.folded).toBe(true);
  }
  // 最多三枚灯，其余收进 `+n`（presentation.md「Overflow: the ledge」）。檐这一侧折叠的站：从这一侧的
  // 边缘数起、直到第一个开着的站。
  const ordered = side === "left" ? snapshot.stations : [...snapshot.stations].reverse();
  const open = ordered.findIndex((station) => !station.folded);
  const foldedOnSide = open === -1 ? ordered.length : open;
  expect(ledge.lamps.length).toBe(Math.min(3, foldedOnSide));
  if (foldedOnSide > 3) expect(ledge.more).toBe(`+${foldedOnSide - 3}`);
  else expect(ledge.more).toBeNull();
}

function statusWord(status: string): string {
  return (
    { done: "已完成", failed: "已失败", running: "运行中", pending: "待开始" }[status] ?? status
  );
}

describe("动态工作流 · 时间线溢出、名册与并行结构", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWV-01 九人一站折成五枚钉住的失败药丸加「还有 4 个 ✕ 1」；产出与消化之间是流动的流轨；点「还有」打开侧板落到这一站，名单列全九人", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWV_START 用工作流检查九项、流水线消化条目、起草复核两轮后定稿。");
    await waitForV4PermissionDialog();
    await approveV4Permission();

    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwv_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dwv_create");
    const launched = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "");
    expect(launched).not.toBeNull();
    runId = launched![1]!;

    // 第一处挂起：产出员第二问与消化员第一问都挂着，两站都在跑。
    const live = await waitForTimeline(
      (snapshot) =>
        snapshot.stations.length === 6 &&
        snapshot.stations[1]?.status === "running" &&
        snapshot.stations[2]?.status === "running" &&
        railOf(snapshot, 1, 2)?.ink === "march" &&
        (snapshot.roster?.more?.failed ?? null) !== null,
      "产出 / 消化没有同时进入运行态，或「铺开」没有折成名册",
    );
    expect(live.runStatus).toBe("running");
    expect(
      await $(
        `[data-workflow-run-digest="true"][data-workflow-run-id="${runId}"] [data-testid="workflow-card-name"]`,
      ).getText(),
    ).toBe(RUN_NAME);
    expect(live.stations.map((station) => station.text)).toEqual(
      STATION_NAMES.map((name) => expect.stringContaining(name)),
    );

    // 名册（presentation.md「Past six participants」）：settled 的一站先钉失败，再按参与者顺序；
    // 六人失败，五个钉住，第六个失败者与三个完成者藏在「还有 4 个」里，红色 ✕ 1 只数藏着的失败。
    expect(live.roster!.flag).toBe("true");
    expect(live.roster!.pills).toHaveLength(5);
    for (const pill of live.roster!.pills) {
      expect(pill.status).toBe("failed");
      expect(FAILED_CHECKERS).toContain(pill.name);
    }
    expect(live.roster!.more).toEqual({
      count: "4",
      text: expect.stringContaining("还有 4 个"),
      failed: "1",
      faces: 3,
    });
    // 站的灯按折叠规则：全部结算且有失败即 failed（脚本 catch 住不改变节点的结局）。
    expect(live.stations[0]!.status).toBe("failed");

    // 流轨（presentation.md「Stream rails」）：产出 → 消化顶替普通轨道，两端都在跑时三枚 chevron
    // 用警示色依次亮起；回弧这时还没有任何一端被访问过，是 faint。
    const stream = railOf(live, 1, 2)!;
    expect(stream.kind).toBe("stream");
    expect(stream.chevrons).toBe("march");
    expect(stream.flowing).toBe(3);
    expect(railOf(live, 0, 1)?.kind).toBeNull();
    expect(arcOf(live, 4, 3)).toEqual({ from: "4", to: "3", ink: "faint", stream: false });

    // 点「还有 4 个」：开 run 侧板、落到「铺开」、门打开，名单只列没钉住的四人，按失败、完成分组。
    await $(
      `[data-workflow-run-digest="true"][data-workflow-run-id="${runId}"] [data-testid="workflow-roster-more-row"]`,
    ).click();
    const section = await $(
      '[data-testid="workflow-run-phases"] [data-testid="workflow-run-phase"][data-phase-open="true"]:has([data-testid="workflow-roster-more-row"][data-door="open"])',
    );
    await section.waitForExist({ timeout: 30000 });
    expect(await section.$('[data-testid="workflow-run-phase-toggle"]').getText()).toContain(
      "铺开",
    );
    const door = await section.$('[data-testid="workflow-roster-more-row"]');
    expect(await door.getAttribute("aria-expanded")).toBe("true");
    expect(await door.getAttribute("data-more-count")).toBe("4");
    const roll = await section.$('[data-testid="workflow-roster-roll"]');
    await roll.waitForExist({ timeout: 10000 });
    const pane = await browser.execute(() => {
      const root = document.querySelector(
        '[data-testid="workflow-run-phase"][data-phase-open="true"]:has([data-testid="workflow-roster-roll"])',
      );
      const names = (scope: string) =>
        Array.from(
          root?.querySelectorAll<HTMLElement>(`${scope} [data-testid="workflow-agent-pill"]`) ?? [],
        ).map((pill) => ({
          text: pill.textContent ?? "",
          status: pill.getAttribute("data-agent-status") ?? "",
        }));
      return {
        pins: names('[data-testid="workflow-roster-pins"]'),
        roll: names('[data-testid="workflow-roster-roll"]'),
        groups: Array.from(
          root?.querySelectorAll<HTMLElement>('[data-testid="workflow-roll-heading"]') ?? [],
        ).map((heading) => ({
          group: heading.getAttribute("data-roll-group"),
          // 人数与词分在两个 span 里（人数加粗），textContent 之间没有空格：去掉空白再比。
          text: (heading.textContent ?? "").replace(/\s+/g, ""),
        })),
      };
    });
    expect(pane.groups).toEqual([
      { group: "failed", text: "1个已失败" },
      { group: "done", text: "3个已完成" },
    ]);
    expect(pane.pins).toHaveLength(5);
    expect(pane.roll.map((pill) => pill.status)).toEqual(["failed", "done", "done", "done"]);
    // 钉住的五人加名单里的四人恰好是九位检查员，各出现一次。
    const listed = [...pane.pins, ...pane.roll].map(
      (pill) => CHECKERS.find((name) => pill.text.includes(name)) ?? pill.text,
    );
    expect([...listed].sort()).toEqual([...CHECKERS].sort());

    await releaseControlledReplay("dwv-produce-2");
    await releaseControlledReplay("dwv-digest-1");
  });

  it("DWV-02 循环第二轮：回弧变实、起草站写「⟳ 2」，镜头居中运行站、早先的站折上左檐并有滚动条；点檐上的灯滚回去，卡片原地不动", async function () {
    this.timeout(300000);
    // 第二处挂起：复核员第二轮挂着，正在运行的是「复核」（下标 4）。
    const held = await waitForTimeline(
      (snapshot) =>
        snapshot.stations[4]?.status === "running" &&
        snapshot.stations[3]?.title === "起草 · 已到访 2 次" &&
        arcOf(snapshot, 4, 3)?.ink === "strong" &&
        snapshot.ledges.left !== null &&
        snapshot.scroller !== null &&
        // 镜头滚动有动画：半路的快照里最靠内容的灯，落定后可能已折进「+n」，下面就点不到了。
        // 所以等镜头落到运行站（下标 4）的居中位置（presentation.md「Camera」）。
        Math.abs(
          snapshot.scroller.scrollLeft - (4 * 192 - (snapshot.scroller.clientWidth - 168) / 2),
        ) <= 1,
      "复核没有进入第二轮运行态，或镜头没有落到运行站、把早先的站折到左檐",
    );

    // 回弧（presentation.md「Rails and arcs」「Ink」）：源站被访问、目标站已到第二轮即 strong；
    // 循环上的站写轮次，站头 title 说「已到访 2 次」。
    expect(arcOf(held, 4, 3)).toEqual({ from: "4", to: "3", ink: "strong", stream: false });
    expect(held.stations[3]!.title).toBe("起草 · 已到访 2 次");
    // 流轨两端都已结束：有条目过去过、此刻没有在过，是 strong，不再流动。
    expect(railOf(held, 1, 2)).toEqual(
      expect.objectContaining({ kind: "stream", ink: "strong", chevrons: "strong", flowing: 0 }),
    );

    // 檐（presentation.md「Overflow: the ledge」）：灯滚出视口的站折到左檐，檐上的灯与折叠的站一一对应。
    const scroller = held.scroller!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expectLedgeConsistent(held, "left");
    expect(held.stations[4]!.folded).toBe(false);
    // 滚动条：拇指长 = 视口² / 内容，至少 24px。
    expect(held.scrollbar).not.toBeNull();
    const thumb = Math.max(24, scroller.clientWidth ** 2 / scroller.scrollWidth);
    expect(Math.abs(held.scrollbar!.thumbWidth - thumb)).toBeLessThanOrEqual(1.5);

    // 点檐上最靠内容的那枚灯：镜头把那一站带回视野。时间线自己滚，卡片的位置与大小不变、也不被折起。
    const target = held.ledges.left!.lamps.at(-1)!.index;
    // 镜头的落点：那一站居中（presentation.md「Camera」，`index × 192 − (clientWidth − 168) / 2`，夹在 0）。
    const landing = Math.max(0, target * 192 - (scroller.clientWidth - 168) / 2);
    await $(
      `[data-workflow-run-digest="true"][data-workflow-run-id="${runId}"] [data-testid="workflow-timeline-ledge-lamp"][data-station-index="${target}"]`,
    ).click();
    const moved = await waitForTimeline(
      (snapshot) =>
        snapshot.scroller !== null &&
        Math.abs(snapshot.scroller.scrollLeft - landing) <= 1 &&
        snapshot.stations[target]?.folded === false &&
        !(snapshot.ledges.left?.lamps ?? []).some((lamp) => lamp.index === target),
      `点檐上的灯后「${STATION_NAMES[target]}」没有滚回视野`,
      30000,
    );
    expect(moved.digest).toEqual(held.digest);
    if (moved.ledges.left !== null) expectLedgeConsistent(moved, "left");
    if (moved.ledges.right !== null) expectLedgeConsistent(moved, "right");

    await releaseControlledReplay("dwv-review-2");
    await waitForTimeline((snapshot) => snapshot.runStatus === "completed", "run 没有到达完成态");
    await waitForV4AssistantMessageContaining("E2E_DWV_DONE", 120000);
  });
});
