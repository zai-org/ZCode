import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";

// 工作流主链路的英文界面与深色主题（docs/dynamic-workflow/launch.md「The confirmation window」、
// docs/dynamic-workflow/presentation.md「The chat area」「The run pane」、
// docs/dynamic-workflow/transcript-and-notifications.md「The completion card」、DESIGN.md「Theme Modes」）。
//
// 脚本名字、阶段、子代理和回放回答全是 ASCII：这些界面上再出现 CJK，就是漏翻译，不是模型或脚本的文字。
// 确认窗和运行态 run 卡是瞬时界面，所以主题在每个界面就地切换取色（DWI-01 走到哪里取到哪里），
// DWI-02 判定这些取色结果。一次 run 走完全部界面。
const RUN_NAME = "E2E Research Digest";
const AGENTS = ["Digester", "Researcher A", "Researcher B"];
const HELD_AGENT_FIXTURE = "dwi-agent-c";
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const COMPLETION_CARD = '[data-workflow-completion-card="true"]';
const RUN_LINE = '[data-workflow-run-line="true"]';
const NOTIFICATION_ROW = '[data-testid^="chat-workflow-notification-row-"]';
const RUN_PHASES = '[data-testid="workflow-run-phases"]';
// 确认窗没有自己的 testid：取包住「Permission required」选项列表的 popover。aria-label 本身也是英文断言。
const PERMISSION_WINDOW = '.bg-popover:has([role="listbox"][aria-label="Permission required"])';

type ThemeName = "zai-light" | "zai-dark";
// DESIGN.md「Text colors」的三档：Primary 是主要阅读文字，其余两档是设计上有意减弱的辅助文字。
const TEXT_TOKENS = [
  "--color-foreground",
  "--color-foreground-subtle",
  "--color-foreground-subtlest",
] as const;
type TextToken = (typeof TEXT_TOKENS)[number];
type Rgb = [number, number, number];
interface Paint {
  background: Rgb;
  foreground: Rgb;
  /** `--color-popover` 解析成的颜色，确认窗的背景应当正好是它。 */
  popoverToken: Rgb;
  /** 三档文字 token 合成到当前背景上的颜色，界面文字应当正好是其中声明的一档。 */
  textTokens: Record<TextToken, Rgb>;
  rootClass: string;
}
type Surface = "window" | "run card" | "completion card" | "notification row" | "run pane";

const paints = new Map<Surface, { token: TextToken } & Record<ThemeName, Paint>>();
let runId = "";

function relativeLuminance(color: Rgb) {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb) {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

/**
 * 读 anchor 文字所在的最深元素的文字色，以及它实际落在什么背景上。
 * 计算值可能是 oklab / lab / color()，统一交给 canvas 转成 sRGB；卡片背景带透明度（`bg-card/70`），
 * 要沿祖先链往上合成到不透明为止。Electron 根节点为 vibrancy 保持透明，链走完就落到 `--color-background`。
 */
async function readPaint(selector: string, anchor: string): Promise<Paint | null> {
  return browser.execute(
    (scopeSelector: string, anchorText: string, tokenNames: readonly string[]) => {
      type Rgba = [number, number, number, number];
      const context = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true,
      })!;
      const toRgba = (color: string): Rgba => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "#010203";
        context.fillStyle = color;
        if (context.fillStyle === "#010203" && color !== "#010203") {
          throw new Error(`canvas 解析不了颜色：${color}`);
        }
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data as unknown as Rgba;
        return [r, g, b, a / 255];
      };
      const over = (top: Rgba, under: Rgba): Rgba => {
        const alpha = top[3] + under[3] * (1 - top[3]);
        if (alpha === 0) return [0, 0, 0, 0];
        const mix = (index: 0 | 1 | 2) =>
          (top[index] * top[3] + under[index] * under[3] * (1 - top[3])) / alpha;
        return [mix(0), mix(1), mix(2), alpha];
      };

      const scope = document.querySelector<HTMLElement>(scopeSelector);
      if (!scope || !(scope.textContent ?? "").includes(anchorText)) return null;
      let element: HTMLElement = scope;
      for (;;) {
        const child = Array.from(element.children).find((candidate) =>
          (candidate.textContent ?? "").includes(anchorText),
        );
        if (!(child instanceof HTMLElement)) break;
        element = child;
      }

      const rootStyle = getComputedStyle(document.documentElement);
      let background = toRgba(rootStyle.getPropertyValue("--color-background").trim());
      const chain: HTMLElement[] = [];
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        chain.push(node);
      }
      for (const node of chain.reverse()) {
        background = over(toRgba(getComputedStyle(node).backgroundColor), background);
      }
      const foreground = over(toRgba(getComputedStyle(element).color), background);
      const rgb = (color: Rgba) =>
        [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])] as [
          number,
          number,
          number,
        ];
      const popover = toRgba(rootStyle.getPropertyValue("--color-popover").trim());
      const textTokens = Object.fromEntries(
        tokenNames.map((name) => [
          name,
          rgb(over(toRgba(rootStyle.getPropertyValue(name).trim()), background)),
        ]),
      );
      return {
        background: rgb(background),
        foreground: rgb(foreground),
        popoverToken: rgb(popover),
        textTokens: textTokens as Record<TextToken, Rgb>,
        rootClass: document.documentElement.className,
      };
    },
    selector,
    anchor,
    TEXT_TOKENS,
  );
}

async function setThemeAndWait(theme: ThemeName) {
  await browser.execute((value: string) => {
    const actions = (
      window as typeof window & { __testActions?: { setTheme?: (next: string) => void } }
    ).__testActions;
    if (!actions?.setTheme) throw new Error("缺少主题测试入口");
    actions.setTheme(value);
  }, theme);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected: string) => document.documentElement.classList.contains(`theme-${expected}`),
        theme,
      ),
    { timeout: 15000, timeoutMsg: `主题没有切到 ${theme}` },
  );
}

/** 切到某个主题，等颜色过渡停下（相邻两次读数相同）再取色。 */
async function readSettledPaint(selector: string, anchor: string, theme: ThemeName) {
  await setThemeAndWait(theme);
  let previous = "";
  let settled: Paint | null = null;
  await browser.waitUntil(
    async () => {
      const paint = await readPaint(selector, anchor);
      const current = JSON.stringify(paint);
      const stable = paint !== null && current === previous;
      previous = current;
      settled = paint;
      return stable;
    },
    { timeout: 15000, timeoutMsg: `${selector} 在 ${theme} 下的颜色没有稳定（锚点 ${anchor}）` },
  );
  return settled as unknown as Paint;
}

/** 在当前界面上就地读两个主题的颜色，读完回到浅色，后面的文案断言不受影响。 */
async function captureThemes(surface: Surface, selector: string, anchor: string, token: TextToken) {
  const light = await readSettledPaint(selector, anchor, "zai-light");
  const dark = await readSettledPaint(selector, anchor, "zai-dark");
  await setThemeAndWait("zai-light");
  paints.set(surface, { token, "zai-light": light, "zai-dark": dark });
}

/** 收集某个界面可见文字与可读属性里所有含 CJK 的片段；空数组才算没有漏翻译。 */
async function readCjk(selector: string) {
  return browser.execute((scopeSelector: string) => {
    const cjk = /[⺀-鿿豈-﫿＀-￯]/;
    const scope = document.querySelector<HTMLElement>(scopeSelector);
    if (!scope) return [`界面不存在：${scopeSelector}`];
    const found: string[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent ?? "";
      if (cjk.test(text)) found.push(text.trim());
    }
    for (const element of [scope, ...Array.from(scope.querySelectorAll<HTMLElement>("*"))]) {
      for (const attribute of ["aria-label", "title", "placeholder"]) {
        const value = element.getAttribute(attribute) ?? "";
        if (cjk.test(value)) found.push(`[${attribute}] ${value}`);
      }
    }
    return found;
  }, selector);
}

async function readTextContent(selector: string) {
  return browser.execute(
    (scopeSelector: string) => document.querySelector(scopeSelector)?.textContent ?? "",
    selector,
  );
}

async function readPillStatuses(scopeSelector: string) {
  return browser.execute((selector: string) => {
    const statuses: Record<string, string> = {};
    for (const pill of Array.from(
      document.querySelectorAll<HTMLElement>(`${selector} [data-testid="workflow-agent-pill"]`),
    )) {
      // 失败原因：a6fb6916a8 给完成的子代理 pill 加了 sr-only 的「已完成」文字，整颗 pill 的
      // 文本变成「名字+状态」。名字只读 `.wf-pill-name`，状态仍读 data-agent-status。
      const name = pill.querySelector(".wf-pill-name")?.textContent ?? "";
      statuses[name.trim()] = pill.dataset.agentStatus ?? "";
    }
    return statuses;
  }, scopeSelector);
}

describe("动态工作流 · 英文界面与深色主题", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 本 spec 专门验证英文文案：固定界面语言，不跟随宿主系统语言。
    await pinE2ELocale("en-US");
    await setThemeAndWait("zai-light");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWI-01 确认窗、run 卡、侧栏运行行、通知行、完成卡和 run 侧板全程英文文案，没有 CJK 漏翻译", async function () {
    this.timeout(420000);
    // 反向对照：扫描必须真能抓到文字节点和属性里的中文，否则后面的空数组什么也证明不了。
    await browser.execute(() => {
      const control = document.createElement("div");
      control.id = "dwi-cjk-control";
      control.setAttribute("aria-label", "漏翻译属性");
      control.textContent = "漏翻译文字";
      document.body.append(control);
    });
    expect(await readCjk("#dwi-cjk-control")).toEqual(["漏翻译文字", "[aria-label] 漏翻译属性"]);
    await browser.execute(() => document.getElementById("dwi-cjk-control")?.remove());

    await sendV4Prompt("E2E_DWI_START Study two sources with a workflow and merge the findings.");

    // 确认窗。
    await waitForV4PermissionDialog();
    await browser.waitUntil(
      async () => (await readTextContent(PERMISSION_WINDOW)).includes("2 phases"),
      { timeout: 30000, timeoutMsg: "确认窗没有写出英文阶段数「2 phases」" },
    );
    const windowText = await readTextContent(PERMISSION_WINDOW);
    expect(windowText).toContain("Run this workflow?");
    expect(windowText).toContain(RUN_NAME);
    expect(windowText).toContain("Show full script");
    expect(await readCjk(PERMISSION_WINDOW)).toEqual([]);
    await captureThemes("window", PERMISSION_WINDOW, "Run this workflow?", "--color-foreground");
    await approveV4Permission();

    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwi_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dwi_create");
    runId = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "")![1]!;

    // 运行态 run 卡：汇总员的回答被受控流挂起，停在第二阶段。
    const digestSelector = `${RUN_DIGEST}[data-workflow-run-id="${runId}"]`;
    const digest = await $(digestSelector);
    await digest.waitForDisplayed({ timeout: 120000 });
    await browser.waitUntil(
      async () => {
        const pills = await readPillStatuses(digestSelector);
        return (
          pills["Researcher A"] === "done" &&
          pills["Researcher B"] === "done" &&
          pills["Digester"] === "running"
        );
      },
      { timeout: 120000, timeoutMsg: "第一阶段没有完成，或 Digester 没有进入运行态" },
    );
    expect(Object.keys(await readPillStatuses(digestSelector)).sort()).toEqual(AGENTS);
    expect(await readTextContent(`${digestSelector} [data-testid="workflow-card-kind"]`)).toContain(
      "Workflow running",
    );
    expect(await readTextContent(`${digestSelector} [data-testid="workflow-card-name"]`)).toContain(
      RUN_NAME,
    );
    const stationTexts = await browser.execute(
      (selector: string) =>
        Array.from(
          document.querySelectorAll(`${selector} [data-testid="workflow-timeline-station"]`),
        ).map((station) => station.textContent ?? ""),
      digestSelector,
    );
    expect(stationTexts).toEqual([
      expect.stringContaining("Research"),
      expect.stringContaining("Digest"),
    ]);
    expect(await readCjk(digestSelector)).toEqual([]);
    await captureThemes("run card", digestSelector, RUN_NAME, "--color-foreground-subtle");

    // 侧栏运行行写当前阶段名。
    await $(RUN_LINE).waitForDisplayed({ timeout: 60000 });
    await browser.waitUntil(async () => (await readTextContent(RUN_LINE)).includes("Digest"), {
      timeout: 60000,
      timeoutMsg: "侧栏运行行没有写出当前阶段「Digest」",
    });
    expect(await readCjk(RUN_LINE)).toEqual([]);

    await releaseControlledReplay(HELD_AGENT_FIXTURE);
    await browser.waitUntil(
      async () => (await digest.getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "run 没有到达完成态" },
    );
    expect(await readTextContent(`${digestSelector} [data-testid="workflow-card-kind"]`)).toContain(
      "Workflow completed",
    );
    expect(await readCjk(digestSelector)).toEqual([]);
    await waitForV4AssistantMessageContaining("E2E_DWI_DONE", 120000);

    // 发起行摘要。已结束一轮的工具行收在折叠里，发起行在第一轮：先展开。
    await browser.execute(() => {
      const first = document.querySelector<HTMLElement>(
        '[data-testid^="chat-assistant-history-trigger-"]',
      );
      if (first?.dataset.historyOpen === "false") first.click();
    });
    const summarySelector = `[data-testid="workflow-tool-summary"][data-workflow-run-id="${runId}"]`;
    await browser.waitUntil(
      async () => /3 subagents/.test(await readTextContent(summarySelector)),
      { timeout: 30000, timeoutMsg: "发起行摘要没有写出英文的子代理计数" },
    );
    expect(await readCjk(summarySelector)).toEqual([]);

    // 通知行：kindLabel + 名字，展开体是返回值。
    const row = await $(NOTIFICATION_ROW);
    await row.waitForDisplayed({ timeout: 60000 });
    const rowText = await readTextContent(NOTIFICATION_ROW);
    expect(rowText).toContain("Workflow completed");
    expect(rowText).toContain(RUN_NAME);
    await row.$('[role="button"]').click();
    const result = await row.$('[data-testid="workflow-notification-result"]');
    await result.waitForDisplayed({ timeout: 10000 });
    // JSON 结果画在 CodeViewer 的 shadow DOM 里，textContent 读不到：这里用 getText。
    await expect(result).toHaveText(expect.stringContaining("E2E_DWI_ANSWER_C"));
    expect(await readCjk(NOTIFICATION_ROW)).toEqual([]);
    // 失败原因：d6b55b9d5e 统一工具行摘要配色，非运行态 kindLabel 改为 Secondary
    // （text-foreground-subtle）；通知行复用 ToolLayout，与工具行同族，不再是 Tertiary。
    await captureThemes(
      "notification row",
      NOTIFICATION_ROW,
      "Workflow completed",
      "--color-foreground-subtle",
    );

    // 完成卡：kind、名字、四格数字的标签。数字计数动画结束后再读。
    const card = await $(COMPLETION_CARD);
    await card.waitForDisplayed({ timeout: 60000 });
    await browser.waitUntil(
      async () =>
        (await card
          .$('[data-testid="workflow-completion-figure-subagents"]')
          .getAttribute("data-value")) === "3" &&
        (await card
          .$('[data-testid="workflow-completion-figure-phases"]')
          .getAttribute("data-value")) === "2",
      { timeout: 10000, timeoutMsg: "完成卡的子代理 / 阶段数字不是 3 / 2" },
    );
    const cardText = await readTextContent(COMPLETION_CARD);
    expect(cardText).toContain("Workflow completed");
    expect(cardText).toContain(RUN_NAME);
    expect(
      await readTextContent(`${COMPLETION_CARD} [data-testid="workflow-completion-figures"]`),
    ).toEqual(expect.stringMatching(/time[\s\S]*tokens[\s\S]*subagents[\s\S]*phases/i));
    expect(await readCjk(COMPLETION_CARD)).toEqual([]);
    await captureThemes(
      "completion card",
      COMPLETION_CARD,
      "Workflow completed",
      "--color-foreground",
    );

    // run 侧板：两段英文阶段，结果面板写「Result」。
    await card.$('[data-testid="workflow-card-open-details"]').click();
    await $(RUN_PHASES).waitForDisplayed({ timeout: 60000 });
    const paneSelector = `div[data-workflow-run-id="${runId}"]:has(${RUN_PHASES})`;
    const toggles = await browser.execute(
      (selector: string) =>
        Array.from(
          document.querySelectorAll(`${selector} [data-testid="workflow-run-phase-toggle"]`),
        ).map((toggle) => toggle.textContent ?? ""),
      RUN_PHASES,
    );
    expect(toggles).toEqual([
      expect.stringContaining("Research"),
      expect.stringContaining("Digest"),
    ]);
    expect(await readTextContent(paneSelector)).toContain("Result");
    expect(await readCjk(paneSelector)).toEqual([]);
    await captureThemes("run pane", RUN_PHASES, "Research", "--color-foreground");
  });

  it("DWI-02 同一批界面在深色主题下画深色 token：背景和文字都与浅色不同，文字对比度够读", async function () {
    expect([...paints.keys()].sort()).toEqual([
      "completion card",
      "notification row",
      "run card",
      "run pane",
      "window",
    ]);
    const failures: string[] = [];
    for (const [surface, { token, "zai-light": light, "zai-dark": dark }] of paints) {
      const describePaint = JSON.stringify({ light, dark });
      if (!dark.rootClass.split(" ").includes("dark")) {
        failures.push(`${surface}: 深色下根节点没有 dark class ${describePaint}`);
      }
      if (light.rootClass.split(" ").includes("dark")) {
        failures.push(`${surface}: 浅色下根节点仍有 dark class ${describePaint}`);
      }
      if (relativeLuminance(dark.background) >= 0.1) {
        failures.push(`${surface}: 深色背景不够深 ${describePaint}`);
      }
      if (relativeLuminance(light.background) <= 0.6) {
        failures.push(`${surface}: 浅色背景不够浅 ${describePaint}`);
      }
      if (relativeLuminance(dark.foreground) <= relativeLuminance(dark.background)) {
        failures.push(`${surface}: 深色下文字没有比背景亮 ${describePaint}`);
      }
      for (const [theme, paint] of [
        ["light", light],
        ["dark", dark],
      ] as const) {
        // 文字画的是声明的那一档 token（合成后容差 3，canvas 转换有取整误差）。
        const expected = paint.textTokens[token];
        if (paint.foreground.some((channel, index) => Math.abs(channel - expected[index]!) > 3)) {
          failures.push(`${surface}: ${theme} 文字不是 ${token} ${describePaint}`);
        }
        // Primary 是主要阅读文字，要够读；Secondary / Tertiary 是设计上减弱的文字，不套这个下限。
        const ratio = contrastRatio(paint.foreground, paint.background);
        if (token === "--color-foreground" && ratio < 4.5) {
          failures.push(`${surface}: ${theme} 对比度 ${ratio.toFixed(2)} < 4.5 ${describePaint}`);
        }
      }
    }
    // 确认窗是不透明的 `bg-popover`：背景应当正好解析成当前主题的 token，而不是写死的颜色。
    const windowPaint = paints.get("window")!;
    for (const paint of [windowPaint["zai-light"], windowPaint["zai-dark"]]) {
      if (paint.background.some((channel, index) => channel !== paint.popoverToken[index])) {
        failures.push(`window: 背景不等于 --color-popover ${JSON.stringify(paint)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
