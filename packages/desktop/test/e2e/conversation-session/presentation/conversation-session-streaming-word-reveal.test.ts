import { clearAppData } from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-streaming-word-reveal";
/** fixture 里各段的片段，用来确认完成态文本完整。 */
const TEXT_FRAGMENTS = [
  "节奏要能看清楚",
  "列表项四",
  "不能落在后面",
  "The burst sentence still spreads out.",
] as const;
/** fixture 里各段的标记，用来把单元归到段落：慢速段、列表段、快速段、停顿后的突发段。 */
const SEGMENT_MARKERS = ["慢速段", "列表项", "快速段", "突发段"] as const;
const SLOW = 0;
const FAST = 2;
const BURST = 3;
/** 第二轮 fixture 的正文片段。 */
const SECOND_ROUND_FRAGMENT = "Second round fades in too.";

interface RevealMount {
  text: string;
  tag: string;
  state: string;
  /** 排期写在 --zcode-reveal-delay 上的延迟。 */
  delay: number;
  /** 挂载时 opacity 过渡的实际时长；没有过渡时为 -1。 */
  duration: number;
  at: number;
  fading: boolean;
  paragraph: Element | null;
}

interface MarkerMount {
  state: string;
  fading: boolean;
  duration: number;
  /** 挂载时 li 的文本片段，用来定位是哪一项的圆点。 */
  item: string;
}

interface StoredRevealProbe {
  mounts: RevealMount[];
  markerMounts: MarkerMount[];
  settle: { changed: number; inDelay: number; inDelayKept: number; durationKept: number };
  observer: MutationObserver;
  markers: string[];
}

interface SegmentTiming {
  count: number;
  medianDuration: number;
  medianDelay: number;
  maxDelay: number;
}

interface RevealProbeResult {
  /** 新挂载、标为 new 的单元数（词 span 与行内 code）。 */
  newUnits: number;
  /** 其中挂载后确实带着 opacity CSSTransition 的数量——CSS 没生效时这里是 0。 */
  newUnitsWithTransition: number;
  /** 每段的排期统计，下标对应 SEGMENT_MARKERS。 */
  segments: SegmentTiming[];
  /** 含汉字却不止一个字的单元；中文按字切分时应为空。 */
  multiCharHanUnits: string[];
  /** 行内 code 作为一个单元淡入。 */
  inlineCode: { newMounted: number; withTransition: number };
  /** 列表圆点 / 序号：li::marker 上的 color 过渡。 */
  markers: { newMounted: number; withTransition: number };
  /** 停顿后整句突发到达的那一段的排期。 */
  burst: { count: number; monotonic: boolean; spreadMs: number };
  /** 单元在延迟期间从 new 变成 settled 时，淡入是否仍在、时长是否不变。 */
  settleDuringDelay: {
    changed: number;
    inDelay: number;
    inDelayKept: number;
    durationKept: number;
  };
  sample: { text: string; delay: number; duration: number } | null;
  /** 以 settled 新挂载的单元：没有经过淡入就直接出现。 */
  settledMounts: { text: string; paragraph: string }[];
  /** 每个圆点挂载时的状态与所在项。 */
  markerItems: { state: string; item: string; fading: boolean }[];
}

/**
 * SWR01 逐字 / 逐词浮现。
 *
 * 这个用例盯的是最容易悄悄失效、静态检查都发现不了的环节：
 * 1. rehype 插件有没有真的进管线并产出单元，会不会被 rehype-sanitize 剥掉；
 * 2. 「单元生成了但没有任何 CSS 规则消费」——Streamdown 内置动画当初就是这样失效的，
 *    所以断言挂载后存在 opacity 的 CSSTransition，而不是元素存在；
 * 3. 进度按 block 记录：后面的段落必须从第一个单元开始淡入，不能被前一段的进度吞掉；
 * 4. 中文按字切分；行内 code 作为一个单元淡入；列表圆点（li::marker）跟着第一个字淡入；
 * 5. 只有滞后按到达速度缩放：快速段滞后明显低于 250ms 上限；淡入时长快慢段都是 300ms；
 * 6. 停顿后整句突发到达时，排期把整句铺开，延迟单调递增，而不是同时起跳；
 * 7. 单元在延迟期间就变成 settled、内联的 delay 被移除时，已排好的淡入不被取消、时长不变。
 *
 * 流式窗口很窄，轮询会漏，因此探针在发送之前就挂上 MutationObserver，
 * 只统计新挂载的节点与 new → settled 的属性变化。
 */
describe("SWR01 streaming word reveal", () => {
  let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;

  before(async function () {
    this.timeout(240000);
    replay = await startConversationModelProviderReplayServer(CASE);
    await clearAppData();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await replay?.stop();
  });

  it("按到达速度调节节奏，逐字淡入、突发铺开，行内 code 与列表圆点同步淡入，完成态无残留", async function () {
    this.timeout(120000);
    await browser.execute(
      (markers: string[]) => {
        const mounts: RevealMount[] = [];
        const markerMounts: MarkerMount[] = [];
        const byElement = new WeakMap<Element, RevealMount>();
        const settle = { changed: 0, inDelay: 0, inDelayKept: 0, durationKept: 0 };
        // getAnimations 会强制一次样式计算；@starting-style 生效时这里能拿到过渡（含延迟阶段）。
        const opacityTransition = (el: Element) =>
          el
            .getAnimations()
            .find(
              (animation): animation is CSSTransition =>
                animation instanceof CSSTransition && animation.transitionProperty === "opacity",
            );
        const markerTransition = (el: Element) =>
          el
            .getAnimations({ subtree: true })
            .find(
              (animation): animation is CSSTransition =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === "color" &&
                (animation.effect as KeyframeEffect | null)?.pseudoElement === "::marker",
            );
        const durationOf = (transition: CSSTransition | undefined) => {
          const duration = transition?.effect?.getTiming().duration;
          return typeof duration === "number" ? duration : -1;
        };
        const inspectUnit = (el: HTMLElement) => {
          const state = el.getAttribute("data-zcode-reveal") ?? "";
          const delay = Number.parseFloat(el.style.getPropertyValue("--zcode-reveal-delay"));
          const transition = state === "new" ? opacityTransition(el) : undefined;
          const mount: RevealMount = {
            text: el.textContent ?? "",
            tag: el.tagName.toLowerCase(),
            state,
            delay: Number.isFinite(delay) ? delay : 0,
            duration: durationOf(transition),
            at: performance.now(),
            fading: transition !== undefined,
            paragraph: el.closest("p, li"),
          };
          mounts.push(mount);
          byElement.set(el, mount);
        };
        const inspectMarker = (el: HTMLElement) => {
          const state = el.getAttribute("data-zcode-reveal-marker") ?? "";
          const transition = state === "new" ? markerTransition(el) : undefined;
          markerMounts.push({
            state,
            fading: transition !== undefined,
            duration: durationOf(transition),
            item: (el.textContent ?? "").slice(0, 12),
          });
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "attributes") {
              const target = record.target as HTMLElement;
              if (record.oldValue !== "new") continue;
              if (target.getAttribute("data-zcode-reveal") !== "settled") continue;
              const mount = byElement.get(target);
              if (!mount) continue;
              settle.changed += 1;
              if (performance.now() - mount.at < mount.delay) {
                settle.inDelay += 1;
                const kept = opacityTransition(target);
                if (kept) {
                  settle.inDelayKept += 1;
                  if (Math.abs(durationOf(kept) - mount.duration) < 0.5) settle.durationKept += 1;
                }
              }
              continue;
            }
            for (const node of record.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.hasAttribute("data-zcode-reveal")) inspectUnit(node);
              if (node.hasAttribute("data-zcode-reveal-marker")) inspectMarker(node);
              node.querySelectorAll<HTMLElement>("[data-zcode-reveal]").forEach(inspectUnit);
              node
                .querySelectorAll<HTMLElement>("[data-zcode-reveal-marker]")
                .forEach(inspectMarker);
            }
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-zcode-reveal"],
          attributeOldValue: true,
        });
        const probe: StoredRevealProbe = { mounts, markerMounts, settle, observer, markers };
        (window as unknown as { __revealProbe: StoredRevealProbe }).__revealProbe = probe;
      },
      [...SEGMENT_MARKERS],
    );

    await sendV4Prompt("E2E_WORD_REVEAL: 输出几段节奏不同的中英混合正文用于逐字浮现验证。");
    await waitForV4AssistantMessageContaining(TEXT_FRAGMENTS[3]);
    // 完成态切到 static 后插件退出管线，单元全部消失；以此作为流式结束的信号。
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll("[data-zcode-reveal], [data-zcode-reveal-marker]").length ===
            0,
        ),
      { timeout: 30000, timeoutMsg: "完成态仍残留逐字浮现单元" },
    );

    const probe = await browser.execute((burstIndex: number): RevealProbeResult => {
      const stored = (window as unknown as { __revealProbe: StoredRevealProbe }).__revealProbe;
      stored.observer.disconnect();
      const median = (values: number[]) => {
        if (values.length === 0) return -1;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.floor(sorted.length / 2)] ?? -1;
      };
      // 完成态重建后旧段落已脱离文档，但其 textContent 仍是流式最后一帧，可用来归段。
      const segmentIndex = (mount: RevealMount) => {
        const text = mount.paragraph?.textContent ?? "";
        return stored.markers.findIndex((marker) => text.includes(marker));
      };
      const fresh = stored.mounts.filter((mount) => mount.state === "new");
      const han = /\p{Script=Han}/u;
      const code = fresh.filter((mount) => mount.tag === "code");
      const markers = stored.markerMounts.filter((mount) => mount.state === "new");
      const segments = stored.markers.map((_, index) => {
        const units = fresh.filter((mount) => segmentIndex(mount) === index);
        const delays = units.map((mount) => mount.delay);
        return {
          count: units.length,
          medianDuration: median(units.map((mount) => mount.duration)),
          medianDelay: median(delays),
          maxDelay: delays.length > 0 ? Math.max(...delays) : -1,
        };
      });
      const burstDelays = fresh
        .filter((mount) => segmentIndex(mount) === burstIndex)
        .map((mount) => mount.delay);
      const first = fresh[0];
      return {
        newUnits: fresh.length,
        newUnitsWithTransition: fresh.filter((mount) => mount.fading).length,
        segments,
        multiCharHanUnits: fresh
          .filter(
            (mount) =>
              mount.tag === "span" && han.test(mount.text) && Array.from(mount.text).length > 1,
          )
          .map((mount) => mount.text),
        inlineCode: {
          newMounted: code.length,
          withTransition: code.filter((mount) => mount.fading).length,
        },
        markers: {
          newMounted: markers.length,
          withTransition: markers.filter((mount) => mount.fading).length,
        },
        burst: {
          count: burstDelays.length,
          monotonic: burstDelays.every(
            (delay, index) => index === 0 || delay >= (burstDelays[index - 1] ?? delay),
          ),
          spreadMs: burstDelays.length > 0 ? (burstDelays.at(-1) ?? 0) - (burstDelays[0] ?? 0) : 0,
        },
        settleDuringDelay: { ...stored.settle },
        sample: first ? { text: first.text, delay: first.delay, duration: first.duration } : null,
        settledMounts: stored.mounts
          .filter((mount) => mount.state === "settled")
          .slice(0, 40)
          .map((mount) => ({
            text: mount.text,
            paragraph: (mount.paragraph?.textContent ?? "").slice(0, 16),
          })),
        markerItems: stored.markerMounts.map((mount) => ({
          state: mount.state,
          item: mount.item,
          fading: mount.fading,
        })),
      };
    }, BURST);

    console.log("[SWR01] reveal probe:", JSON.stringify(probe));

    expect(probe.newUnits).toBeGreaterThan(0);
    // 单元在而过渡不在，就是「CSS 没有规则消费」的原貌，必须断死在这里。
    expect(probe.newUnitsWithTransition).toBeGreaterThanOrEqual(Math.ceil(probe.newUnits * 0.9));
    // 每一段都要有新单元淡入：后面的段落不能被前一段的进度吞掉。
    for (const segment of probe.segments) expect(segment.count).toBeGreaterThan(0);
    expect(probe.multiCharHanUnits).toEqual([]);
    expect(probe.inlineCode.newMounted).toBeGreaterThan(0);
    expect(probe.inlineCode.withTransition).toBeGreaterThan(0);
    // fixture 有两个无序、两个有序列表项，每个圆点 / 序号都要带 color 过渡。
    expect(probe.markers.newMounted).toBeGreaterThanOrEqual(4);
    expect(probe.markers.withTransition).toBe(probe.markers.newMounted);

    // 只有滞后按到达速度缩放：快速段的滞后要明显低于 250ms 上限（固定参数时会一直顶在上限）。
    // 淡入时长固定 300ms，快慢段一样：曾经按速度缩到 120ms，每个字只有 2–3 帧渐变，看起来没有动画。
    const slow = probe.segments[SLOW];
    const fast = probe.segments[FAST];
    expect(slow?.medianDuration ?? -1).toBeGreaterThanOrEqual(290);
    expect(fast?.medianDuration ?? -1).toBeGreaterThanOrEqual(290);
    expect(fast?.medianDelay ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150);
    for (const segment of probe.segments) expect(segment.maxDelay).toBeLessThanOrEqual(255);

    // 突发整句要被铺开：延迟单调递增且拉开跨度，而不是同时起跳。
    expect(probe.burst.count).toBeGreaterThanOrEqual(10);
    expect(probe.burst.monotonic).toBe(true);
    expect(probe.burst.spreadMs).toBeGreaterThanOrEqual(40);

    // 延迟期间变成 settled 的单元，淡入必须仍在，时长也不变。
    expect(probe.settleDuringDelay.inDelay).toBeGreaterThan(0);
    expect(probe.settleDuringDelay.inDelayKept).toBe(probe.settleDuringDelay.inDelay);
    expect(probe.settleDuringDelay.durationKept).toBe(probe.settleDuringDelay.inDelayKept);

    const text = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".group\\/assistant-row"))
        .map((row) => row.innerText)
        .join("\n"),
    );
    for (const fragment of TEXT_FRAGMENTS) expect(text).toContain(fragment);
  });

  /*
   * 回归：Streamdown 的 processor 缓存按 rehype 插件函数的 name 生成 key，整个 App 共用一份。
   * 插件实例原来都叫 streamingRevealRehypePlugin，第二条流式消息命中缓存，拿到第一条消息的
   * 插件实例和它已结束的状态（incremental=false），所有字都被当成 settled 直接出现。
   * 上一个用例只覆盖 App 启动后的第一条消息，所以这里在同一会话里接着问第二轮。
   */
  it("同一会话的第二轮回复同样逐字淡入", async function () {
    this.timeout(120000);
    await browser.execute(() => {
      // settledLater：已挂载的单元在后续帧由 new 变成 settled 的次数，代表本条消息的进度在推进。
      const counts = { fresh: 0, fading: 0, settled: 0, settledLater: 0 };
      const inspect = (el: HTMLElement) => {
        const state = el.getAttribute("data-zcode-reveal");
        if (state === "settled") {
          counts.settled += 1;
          return;
        }
        if (state !== "new") return;
        counts.fresh += 1;
        const fading = el
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition && animation.transitionProperty === "opacity",
          );
        if (fading) counts.fading += 1;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes") {
            const target = record.target as HTMLElement;
            if (record.oldValue === "new" && target.getAttribute("data-zcode-reveal") === "settled")
              counts.settledLater += 1;
            continue;
          }
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.hasAttribute("data-zcode-reveal")) inspect(node);
            node.querySelectorAll<HTMLElement>("[data-zcode-reveal]").forEach(inspect);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-zcode-reveal"],
        attributeOldValue: true,
      });
      (
        window as unknown as {
          __secondRoundProbe: { counts: typeof counts; observer: MutationObserver };
        }
      ).__secondRoundProbe = { counts, observer };
    });

    await sendV4Prompt("E2E_SECOND_ROUND_REVEAL: 再输出一段正文，验证第二轮也逐字淡入。");
    await waitForV4AssistantMessageContaining(SECOND_ROUND_FRAGMENT);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll("[data-zcode-reveal]").length === 0),
      { timeout: 30000, timeoutMsg: "第二轮完成态仍残留逐字浮现单元" },
    );

    const counts = await browser.execute(() => {
      const stored = (
        window as unknown as {
          __secondRoundProbe: {
            counts: { fresh: number; fading: number; settled: number; settledLater: number };
            observer: MutationObserver;
          };
        }
      ).__secondRoundProbe;
      stored.observer.disconnect();
      return stored.counts;
    });
    console.log("[SWR01] second round probe:", JSON.stringify(counts));

    // fixture 约 40 个单元，第二轮也要逐字淡入。
    expect(counts.fresh).toBeGreaterThanOrEqual(20);
    expect(counts.fading).toBeGreaterThanOrEqual(Math.ceil(counts.fresh * 0.9));
    // 第二轮自己的进度必须推进：已挂载的单元在后续帧变成 settled。共用第一条消息的插件实例时，
    // 第二轮的进度写进第一条消息的 state、永远不会被提交，每帧都把整段当新增，这个计数是 0；
    // 第一条消息若以 incremental=false 结束，第二轮则全部以 settled 挂载、没有任何动画。
    expect(counts.settledLater).toBeGreaterThanOrEqual(Math.ceil(counts.fresh * 0.5));
  });
});
