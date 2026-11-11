// M5 门禁：composer 工具条（模型选择器 / 思考深度 / 模式 / slash 候选面板）。
// 证据层 L3：
// 1) slash 面板——展示 CLI builtin 与 App Composer-only catalog（compact/goal/init/plan；无 resume-goal）、模糊过滤、选中插入命令 pill；
// 2) 模型选择器——切到另一注册模型 + 思考深度后，Composer Draft 立即更新；
// 3) 模式选择——ChatModeSwitchControl 立即更新同一 Composer Draft；
// 4) context usage——首轮 ModelComplete 后 usage.contextWindow 投影（data-usage-used>0）。
// 5) task → draft——已有模型目录时仍独立重新水合 slash 目录，自定义命令继续出现。
// 6) draft → 已知 task——同一 workspace 的 slash 目录不被 task 导航清空。
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  readModelProvider,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
} from "#e2e/helpers/upstream-provider";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_MODEL_CONFIG,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
} from "@zcode/shared/test-ids";
import {
  clickV4SlashOption,
  getV4ComposerText,
  setV4ComposerText,
  getV4ConfigProjection,
  getV4ModelConfig,
  getLatestV4CommandAck,
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  startNewV4Draft,
  switchV4Mode,
  switchV4Model,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

import {
  waitForUpstreamNetworkCapture,
  assertUpstreamThoughtLevelCapture,
  assertUpstreamRequestCapture,
} from "#e2e/helpers/upstream-capture";

import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

import { seedPersonalProviderConfig } from "#e2e/helpers/model-provider-restart-config";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";

const CUSTOM_SLASH_COMMAND_NAME = "e2e-draft-catalog";
const CUSTOM_SLASH_OPTION_ID = `slash:${CUSTOM_SLASH_COMMAND_NAME}`;
const CUSTOM_SLASH_COMMAND_DIR = join(getE2EAppDataPaths().homeDir, ".zcode", "commands");
const CUSTOM_SLASH_COMMAND_PATH = join(CUSTOM_SLASH_COMMAND_DIR, `${CUSTOM_SLASH_COMMAND_NAME}.md`);
const COMPOSER_PICKER_TRIGGER_IDS = {
  mode: TID_CHAT_MODE_SELECT_TRIGGER,
  model: TID_CHAT_MODEL_SELECT_TRIGGER,
} as const;

type ComposerPicker = keyof typeof COMPOSER_PICKER_TRIGGER_IDS;

async function openComposerPicker(picker: ComposerPicker) {
  const trigger = $(`[data-testid="${COMPOSER_PICKER_TRIGGER_IDS[picker]}"]`);
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
}

async function waitForOnlyComposerPickerOpen(picker: ComposerPicker, transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((triggerIds) => {
        const expanded = Object.fromEntries(
          Object.entries(triggerIds).map(([key, testId]) => [
            key,
            document
              .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
              ?.getAttribute("aria-expanded") ?? null,
          ]),
        );
        return {
          expanded,
          listboxes: document.querySelectorAll('[role="listbox"]').length,
          menus: document.querySelectorAll('[role="menu"]').length,
        };
      }, COMPOSER_PICKER_TRIGGER_IDS);
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      const expectedListboxes = 0;
      const expectedMenus = 1;
      return (
        state.expanded[picker] === "true" &&
        Object.entries(state.expanded).every(
          ([key, value]) => key === picker || value !== "true",
        ) &&
        state.listboxes === expectedListboxes &&
        state.menus === expectedMenus
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后没有只保留目标 picker；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForNoComposerPickerOpen(transition: string) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (triggerIds) => ({
          expanded: Object.fromEntries(
            Object.entries(triggerIds).map(([key, testId]) => [
              key,
              document
                .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
                ?.getAttribute("aria-expanded") ?? null,
            ]),
          ),
          listboxes: document.querySelectorAll('[role="listbox"]').length,
          menus: document.querySelectorAll('[role="menu"]').length,
        }),
        COMPOSER_PICKER_TRIGGER_IDS,
      );
      const state = latest as {
        expanded: Record<ComposerPicker, string | null>;
        listboxes: number;
        menus: number;
      };
      return (
        Object.values(state.expanded).every((value) => value !== "true") &&
        state.listboxes === 0 &&
        state.menus === 0
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${transition} 后 composer picker 没有全部关闭；latest=${JSON.stringify(latest)}`,
    },
  );
}

async function closeComposerPicker() {
  await browser.keys("Escape");
  await waitForNoComposerPickerOpen("Escape");
}

const ACK_PROVIDER = "e2e-ack-glm";
async function seedAckProvider() {
  const upstream = await readModelProvider(UPSTREAM_PROVIDER_ID);
  if (!upstream) throw new Error("缺少回放 Provider");
  await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
    id: ACK_PROVIDER,
    label: "ACK GLM",
    apiFormat: "anthropic-messages",
    apiKey: upstream.apiKey,
    baseURL: upstream.endpoints.anthropic ?? upstream.endpoints.baseURL!,
    models: [
      {
        id: "GLM-5.3",
        reasoningLevel: {
          values: ["high", "max"],
          map: '{"thinking":{"type":"enabled"},"output_config":{"effort":reasoningLevel}}',
        },
      },
    ],
  });
  await waitForProviderConfigPolling();
}

async function expectPersistedThought(sessionId: string, thought: string) {
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    await browser.waitUntil(
      () => {
        const row = db
          .prepare(
            "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection' ORDER BY id DESC LIMIT 1",
          )
          .get(sessionId) as { data: string } | undefined;
        return Boolean(
          row && JSON.parse(row.data).modelSelection?.options?.reasoningLevel === thought,
        );
      },
      { timeout: 10000, timeoutMsg: "仅切换档位未写入 Session Selection" },
    );
  } finally {
    db.close();
  }
}

describe("v4 M5 门禁：composer 工具条与 slash 候选面板", () => {
  let completedTaskId: string | null = null;
  let customSlashHydratedInDraft = false;

  async function ensureCompletedTask() {
    if (completedTaskId) {
      return completedTaskId;
    }
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED 建立会话");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );
    completedTaskId = (await getV4PaneSnapshot()).sessionId;
    if (!completedTaskId || completedTaskId === "draft") {
      throw new Error("composer toolbar 首轮没有留下可重新打开的 completed task");
    }
    return completedTaskId;
  }

  async function ensureCustomSlashHydratedInDraft() {
    if (customSlashHydratedInDraft) {
      return;
    }
    await startNewV4Draft();
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "task → draft 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "task → draft slash 回归断言后没有清空 composer",
    });
    customSlashHydratedInDraft = true;
  }

  before(async () => {
    await skipOccupationOnboardingIfPresent();
    await mkdir(CUSTOM_SLASH_COMMAND_DIR, { recursive: true });
    await writeFile(
      CUSTOM_SLASH_COMMAND_PATH,
      [
        "---",
        "description: E2E task-to-draft slash catalog rehydration",
        "argument-hint: [scope]",
        "---",
        "",
        "Draft slash catalog fixture $ARGUMENTS.",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    // 某条交互断言失败时仍关闭其菜单，避免下一条点击被当成关闭旧弹层。
    const open = await browser.execute(() => Boolean(document.querySelector('[role="menu"]')));
    if (open) await closeComposerPicker();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CUSTOM_SLASH_COMMAND_PATH, { force: true });
    await clearAppData();
  });

  it("slash 面板：/ 触发目录候选，过滤后选中插入命令", async () => {
    await prepareV4ConversationE2E();

    // `/` 触发：CLI protocol catalog 的内建命令全部出现，UI 私有 alias 不出现。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:compact");
    await waitForV4SlashOption("slash:init");
    await waitForV4SlashOption("app-slash:plan");
    const optionIds = await getV4SlashOptionIds();
    expect(optionIds).toContain("slash:compact");
    expect(optionIds).toContain("slash:goal");
    expect(optionIds).toContain("slash:init");
    expect(optionIds).toContain("app-slash:plan");
    expect(optionIds).not.toContain("slash:plan");
    expect(optionIds).not.toContain("slash:resume-goal");

    // /plan 已是本地模式操作；旧断言等待 CLI pill，无法覆盖实际的模式切换。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/plan", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("app-slash:plan");
    expect(await clickV4SlashOption("app-slash:plan")).toBe(true);
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_V4_MODEL_CONFIG}"]`).getAttribute("data-plan-enabled")) ===
        "true",
      {
        timeout: 15000,
        timeoutMsg: "选中 /plan 后草稿没有进入计划模式",
      },
    );
    expect((await getV4ComposerText()) ?? "").toBe("");
    expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
    // Plan 菜单项是复选框；再次点击同一项关闭，而不是选择不存在的 plan-off 项。
    await switchV4Mode("plan");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "选中 /plan 后没有清空 composer",
    });

    // 模糊过滤：/goa → goal 仍在候选中
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/goa", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption("slash:goal");

    // 选中：插入 `/goal ` 命令文本（mention pill 的 markdown），面板关闭
    expect(await clickV4SlashOption("slash:goal")).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").startsWith("/goal"), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后命令没有插入 composer",
    });
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 slash 候选后面板没有关闭",
    });

    // 清空草稿，避免影响后续用例
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
  });

  it("模型选择器/思考深度/模式切换 → config 投影更新；usage 投影非零", async () => {
    await ensureCompletedTask();
    await browser.execute(() => {
      const probe = { empty: 0, disabled: 0, samples: 0, stop: () => {} };
      const observer = new MutationObserver(() => {
        const list = document.querySelector("[data-composer-model-list]");
        if (!list) return;
        probe.samples++;
        if (!list.textContent?.trim()) probe.empty++;
        if (document.querySelector<HTMLButtonElement>("[data-composer-combined-model]")?.disabled)
          probe.disabled++;
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
      probe.stop = () => observer.disconnect();
      (window as Window & { __composerCatalogProbe?: typeof probe }).__composerCatalogProbe = probe;
    });

    // 带最新投影值的分段等待（超时报文里带上 config 现值，便于定位卡在哪一段）。
    const waitForModelConfig = async (
      predicate: (cfg: {
        provider: string | null;
        model: string | null;
        thought: string | null;
      }) => boolean,
      label: string,
    ) => {
      let latest: unknown = null;
      try {
        await browser.waitUntil(
          async () => {
            const cfg = await getV4ModelConfig();
            latest = cfg;
            return predicate(cfg);
          },
          { timeout: 30000, timeoutMsg: label },
        );
      } catch (error) {
        // 失败诊断：v4 命令 ack 环形缓冲（生产 renderer 日志关闭，这是唯一 probe 面）。
        const acks = await browser
          .execute(() =>
            JSON.stringify(
              (window as Window & { __zcodeV4CommandAcksE2E?: unknown[] })
                .__zcodeV4CommandAcksE2E ?? [],
            ),
          )
          .catch(() => "acks unavailable");
        throw new Error(`${label}; latest=${JSON.stringify(latest)}; acks=${acks}`, {
          cause: error,
        });
      }
    };

    // 模型选择器：切到已注册的第二个模型 + thought=max
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    await waitForModelConfig(
      (cfg) => cfg.model === UPSTREAM_SECONDARY_MODEL,
      "模型选择器切换后 config.model 投影没有更新",
    );
    await waitForModelConfig(
      (cfg) => cfg.thought === "max",
      "思考深度切换后 config.thought 投影没有更新",
    );
    const cfg = await getV4ModelConfig();
    expect(cfg.provider).toBe(UPSTREAM_PROVIDER_ID);
    // 仅改档位且不发送：Bot 读取的是 Session，不是 Composer 的展示值。
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "high");
    await expectPersistedThought(completedTaskId!, "high");
    await browser.keys(["Control", "t"]);
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought !== "high", {
      timeout: 10000,
    });
    await expectPersistedThought(completedTaskId!, (await getV4ModelConfig()).thought!);

    // 已有会话选模后保留面板，ACK 后在原面板继续调档。
    for (const selected of [false, true]) {
      await openComposerPicker("model");
      const option = $(
        `[data-testid^="chat-model-select-item-"]${selected ? '[data-checked="true"]' : ':not([data-checked="true"])'}:not([data-model-option-locked])`,
      );
      await option.waitForClickable({ timeout: 15000 });
      const value = (await option.getAttribute("data-testid"))!.slice(
        "chat-model-select-item-".length,
      );
      await option.click();
      await waitForOnlyComposerPickerOpen("model", selected ? "重复选择当前模型" : "选择其他模型");
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).getAttribute(
            "data-model-current-value",
          )) === value,
        { timeout: 15000 },
      );
      await closeComposerPicker();
    }

    // 只点击 Provider、不发送：必须确认 Session 配置，飞书才会立即读到新选择。
    await browser.execute(() => {
      (window as Window & { __zcodeV4CommandAcksE2E?: unknown[] }).__zcodeV4CommandAcksE2E = [];
    });
    await openComposerPicker("model");
    await $('[data-testid="composer-provider-trigger"]').click();
    await $(
      `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
    ).click();
    await waitForModelConfig(
      (value) =>
        value.provider === UPSTREAM_ALTERNATE_PROVIDER_ID &&
        value.model === UPSTREAM_ALTERNATE_MODEL,
      "Provider 点击后未自动选择目标模型",
    );
    await waitForOnlyComposerPickerOpen("model", "已有会话切换 Provider 后保留弹层");
    await browser.waitUntil(
      async () => {
        const slider = $('[data-testid="composer-thought-slider"]');
        const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
        return levels.includes((await getV4ModelConfig()).thought ?? "");
      },
      { timeout: 15000, timeoutMsg: "Provider 切换后 Think 没有同步为有效档位" },
    );
    await browser.waitUntil(
      async () => (await getLatestV4CommandAck("switchModelConfig"))?.status === "accepted",
      { timeout: 15000, timeoutMsg: "Provider 切换未得到会话配置成功回执" },
    );
    await waitForOnlyComposerPickerOpen("model", "配置确认后仍保留原弹层");
    await closeComposerPicker();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");

    // Plan 已独立为开关，开启后仍保留 build 模式，不能断言旧的 mode=plan。
    const catalogProbe = await browser.execute(() => {
      const target = window as Window & {
        __composerCatalogProbe?: { empty: number; disabled: number; samples: number; stop(): void };
      };
      const probe = target.__composerCatalogProbe!;
      probe.stop();
      delete target.__composerCatalogProbe;
      return { empty: probe.empty, disabled: probe.disabled, samples: probe.samples };
    });
    expect(catalogProbe.samples).toBeGreaterThan(0);
    expect(catalogProbe.empty).toBe(0);
    // 面板保持挂载，因此能观察到 ACK 期间的禁用帧；目录仍不应清空。
    expect(catalogProbe.disabled).toBeGreaterThan(0);
    const modeTrigger = await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
    await browser.execute((id) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const probe = {
        animated: false,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        stop: () => {},
      };
      const observer = new MutationObserver(() => {
        for (const node of trigger.querySelectorAll<HTMLElement>("[style]")) {
          const style = getComputedStyle(node);
          if (style.transform !== "none" && Number(style.opacity) > 0 && Number(style.opacity) < 1)
            probe.animated = true;
        }
      });
      observer.observe(trigger, { subtree: true, attributes: true, attributeFilter: ["style"] });
      probe.stop = () => observer.disconnect();
      (window as Window & { __modeRollProbe?: typeof probe }).__modeRollProbe = probe;
    }, TID_CHAT_MODE_SELECT_TRIGGER);
    try {
      // Edit 只保留历史兼容，不再是菜单候选；用现有 Guarded 模式验证同一翻滚交互。
      await switchV4Mode("guarded");
      await browser.waitUntil(
        async () => {
          const label = await modeTrigger.$("span[title]");
          return (await label.getText()) === (await label.getAttribute("title"));
        },
        { timeout: 5000, timeoutMsg: "mode rolling label did not settle" },
      );
      expect((await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`)).elementId).toBe(
        modeTrigger.elementId,
      );
      const motion = await browser.execute(() => {
        const probe = (
          window as Window & { __modeRollProbe?: { animated: boolean; reduced: boolean } }
        ).__modeRollProbe!;
        return { animated: probe.animated, reduced: probe.reduced };
      });
      expect(motion.animated).toBe(!motion.reduced);
    } finally {
      await browser.execute(() => {
        const target = window as Window & { __modeRollProbe?: { stop: () => void } };
        target.__modeRollProbe?.stop();
        delete target.__modeRollProbe;
      });
      await switchV4Mode("build");
    }
    await switchV4Mode("plan");
    await browser.waitUntil(
      () =>
        browser.execute(
          (testId) =>
            document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.dataset
              .planEnabled === "true",
          TID_V4_MODEL_CONFIG,
        ),
      { timeout: 15000, timeoutMsg: "Plan 开关没有写回 Composer" },
    );
    expect((await getV4ModelConfig()).mode).toBe("build");
    expect(await $('[data-testid="v4-composer-plan-marker"]').isDisplayed()).toBe(true);

    // context usage：首轮 ModelComplete 后 usage.contextWindow 投影非零
    const projection = await getV4ConfigProjection();
    expect(projection.usageUsed).toBeGreaterThan(0);
  });

  it("合并模型/思考弹层与模式 picker 互斥", async () => {
    await ensureCompletedTask();
    expect(await $(`[data-testid="${TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}"]`).isExisting()).toBe(
      false,
    );
    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "打开模式 picker");
    const originalWidth = (await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).getSize())
      .width;
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "模式→合并菜单");
    expect(
      await $('[data-testid="composer-provider-trigger"] [data-provider-access-badge]').getText(),
    ).toBe("API");
    const triggerAppearance = await browser.execute(() => {
      const trigger = document.querySelector<HTMLElement>("[data-composer-combined-model]")!;
      const style = getComputedStyle(trigger);
      return { background: style.backgroundColor, radius: Number.parseFloat(style.borderRadius) };
    });
    expect(triggerAppearance.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(triggerAppearance.radius).toBeGreaterThan(0);
    expect(triggerAppearance.radius).toBeLessThan(14);
    expect(await $('[role="menu"]').getAttribute("data-align")).toBe("center");
    const expandedTrigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    expect(await expandedTrigger.getText()).toMatch(/Select model|选择模型/);
    const minimumWidth = await browser.execute(
      () => 8 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect((await expandedTrigger.getSize()).width).toBe(Math.max(originalWidth, minimumWidth));
    const labelFits = await browser.execute(() => {
      const label = document.querySelector<HTMLElement>("[data-composer-open-label]")!;
      return label.scrollWidth <= label.clientWidth;
    });
    expect(labelFits).toBe(true);
    const modelFonts = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-composer-model-list] [role="menuitemradio"]',
      )!;
      const name = row.querySelector<HTMLElement>("[title]")!;
      return {
        name: getComputedStyle(name).fontSize,
        row: getComputedStyle(row).fontSize,
      };
    });
    expect(modelFonts.name).toBe(modelFonts.row);
    expect(await $('[data-testid="composer-thought-endpoints"]').isExisting()).toBe(false);
    expect(await $('[data-slot="dropdown-menu-label"]').getText()).toMatch(/Models|模型/);
    expect(await $('[data-testid="composer-thought-slider"]').isDisplayed()).toBe(true);
    const declaredLevels = JSON.parse(
      (await $('[data-testid="composer-thought-slider"]').getAttribute("data-levels")) ?? "[]",
    ) as string[];
    expect(await $$("[data-composer-thought-stop]").length).toBe(declaredLevels.length);
    expect(await $('[data-testid="composer-thought-track"]').isDisplayed()).toBe(true);
    const trackGeometry = await browser.execute(() => {
      const track = document.querySelector<HTMLElement>('[data-testid="composer-thought-track"]')!;
      const fill = track.querySelector<HTMLElement>(".composer-thought-slider-fill")!;
      return {
        trackHeight: track.getBoundingClientRect().height,
        fillHeight: fill.getBoundingClientRect().height,
        topOffset: fill.getBoundingClientRect().top - track.getBoundingClientRect().top,
        border: getComputedStyle(track).borderTopWidth,
      };
    });
    expect(trackGeometry.border).toBe("0px");
    expect(trackGeometry.topOffset).toBe(0);
    expect(trackGeometry.fillHeight).toBe(trackGeometry.trackHeight);
    const motion = await browser.execute(() => {
      const thumb = document.querySelector(".composer-thought-slider-thumb")!;
      const fill = document.querySelector(".composer-thought-slider-fill")!;
      return {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        thumb: getComputedStyle(thumb).transitionDuration,
        fill: getComputedStyle(fill).transitionDuration,
        gradient: getComputedStyle(fill, "::before").transitionDuration,
        gradientProperty: getComputedStyle(fill, "::before").transitionProperty,
      };
    });
    expect(motion.thumb).toBe(motion.reduced ? "0s" : "0.12s");
    expect(motion.fill).toBe(motion.thumb);
    const menuLayout = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>("[data-composer-model-list]")!;
      const menu = list.closest('[role="menu"]')!;
      return {
        outerOverflow: getComputedStyle(menu).overflowY,
        listOverflow: getComputedStyle(list).overflowY,
        appRegion: getComputedStyle(menu).getPropertyValue("app-region"),
      };
    });
    expect(menuLayout.outerOverflow).toBe("hidden");
    expect(menuLayout.listOverflow).toBe("auto");
    expect(menuLayout.appRegion).toBe("no-drag");
    const modelList = $("[data-composer-model-list]");
    try {
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>("[data-composer-model-list]")!;
        list.style.maxHeight = "30px";
        list.scrollTop = 0;
      });
      await browser.waitUntil(
        async () => (await modelList.getAttribute("data-scroll-mask")) === "bottom",
      );
      for (const [position, mask] of [
        [0.5, "both"],
        [1, "top"],
      ] as const) {
        await browser.execute((ratio) => {
          const list = document.querySelector<HTMLElement>("[data-composer-model-list]")!;
          list.scrollTop = (list.scrollHeight - list.clientHeight) * ratio;
        }, position);
        await browser.waitUntil(
          async () => (await modelList.getAttribute("data-scroll-mask")) === mask,
        );
      }
    } finally {
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>("[data-composer-model-list]")!;
        list.style.removeProperty("max-height");
        list.scrollTop = 0;
      });
    }
    await browser.waitUntil(
      async () => (await modelList.getAttribute("data-scroll-mask")) === "none",
    );

    const combinedTrigger = await $("[data-composer-combined-model]");
    expect(await combinedTrigger.$('[data-composer-trigger-frame="open"]').isExisting()).toBe(true);
    expect(await combinedTrigger.$("[data-composer-open-chevron]").isExisting()).toBe(false);

    const shortcut = await $('[data-testid="composer-effort-shortcut"]');
    expect(await shortcut.getText()).toMatch(/T/i);
    const shortcutLayout = await browser.execute(() => {
      const shortcut = document.querySelector<HTMLElement>(
        '[data-testid="composer-effort-shortcut"]',
      )!;
      const value = document.querySelector<HTMLElement>('[data-testid="composer-thought-value"]')!;
      const a = shortcut.getBoundingClientRect();
      const b = value.getBoundingClientRect();
      const row = shortcut.parentElement!.getBoundingClientRect();
      return {
        afterValue: a.left > b.right,
        rightGap: row.right - a.right,
        sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 2,
      };
    });
    expect(shortcutLayout.afterValue).toBe(true);
    expect(shortcutLayout.rightGap).toBeLessThan(2);
    expect(shortcutLayout.sameRow).toBe(true);
    const shortcutStyle = await browser.execute(() => {
      const element = document.querySelector('[data-testid="composer-effort-shortcut"]')!;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        radius: style.borderRadius,
        height: style.height,
      };
    });
    expect(shortcutStyle.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(shortcutStyle.radius).toBe("6px");
    expect(shortcutStyle.height).toBe("16px");

    expect(motion.gradient).toBe(motion.reduced ? "0s" : "0.2s");
    if (!motion.reduced) expect(motion.gradientProperty).toBe("opacity");
    await closeComposerPicker();
    await openComposerPicker("model");
    await openComposerPicker("mode");
    await waitForOnlyComposerPickerOpen("mode", "合并菜单→模式");
    await browser.waitUntil(
      async () => !(await combinedTrigger.$('[data-composer-trigger-frame="open"]').isExisting()),
      { timeout: 3000 },
    );
    expect(await combinedTrigger.$('[data-composer-trigger-frame="closed"]').isExisting()).toBe(
      true,
    );
    expect((await $("[data-composer-combined-model]")).elementId).toBe(combinedTrigger.elementId);

    await closeComposerPicker();
  });

  it("draft: slider dots grow on hover and remain white on the filled track", async () => {
    // 用命名模型的独立回放声明预期，避免测试复用产品的名称匹配实现。
    const highspeed = process.env.E2E_COMPOSER_EXPECT_HIGHSPEED === "1";
    await ensureCompletedTask();
    // 未绑定草稿没有配置 ACK，连续调档仍保留弹层；已有会话的门禁由 CPG02 验证。
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    if (highspeed) {
      // 回放请求继续使用录制模型；命名模型只验证展示，不发送请求。
      const model = process.env.E2E_COMPOSER_ANIMATION_MODEL || "GLM-5.3-FlashX";
      await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
        id: "e2e-animation-model",
        label: "Animation Fixture",
        apiFormat: "anthropic-messages",
        apiKey: "e2e-fixture-key",
        baseURL: "http://127.0.0.1:1/v1",
        models: [{ id: model, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      });
      await waitForProviderConfigPolling();
      await switchV4Model("e2e-animation-model", model, "high");
    }
    await openComposerPicker("model");
    const slider = $('[data-testid="composer-thought-slider"]');
    expect(await $(".composer-thought-slider-fill").getAttribute("data-highspeed")).toBe(
      String(highspeed),
    );
    expect(await $('[data-testid="composer-thought-meter"]').getAttribute("data-highspeed")).toBe(
      String(highspeed),
    );
    const filledOpacity = await browser.execute(
      () =>
        getComputedStyle(
          document.querySelector('[data-composer-thought-stop][data-filled="true"]')!,
        ).opacity,
    );
    expect(filledOpacity).toBe("0.3");
    const sliderSize = await slider.getSize();
    await slider.moveTo({ xOffset: Math.round(16 - sliderSize.width / 2), yOffset: 0 });
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const dot = document.querySelector<HTMLElement>("[data-composer-thought-stop]")!;
          return Number.parseFloat(getComputedStyle(dot).scale) > 1.7;
        }),
      { timeout: 3000 },
    );
    const filledColor = await browser.execute(() => {
      const dot = document.querySelector<HTMLElement>(
        '[data-composer-thought-stop][data-filled="true"]',
      )!;
      return getComputedStyle(dot).backgroundColor;
    });
    expect(filledColor).toBe("rgb(255, 255, 255)");
    const drag = await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="composer-thought-slider"]',
      )!;
      const rect = input.getBoundingClientRect();
      return {
        x: Math.round(
          rect.left + 14 + ((rect.width - 28) * Number(input.value)) / Number(input.max),
        ),
        y: Math.round(rect.top + rect.height / 2),
        target: Math.round(rect.left + 14),
      };
    });
    await browser.performActions([
      {
        type: "pointer",
        id: "slider-drag",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x: drag.x, y: drag.y },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 150, x: drag.target, y: drag.y },
        ],
      },
    ]);
    const dragMotion = await browser.execute(() => ({
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      thumb: getComputedStyle(document.querySelector(".composer-thought-slider-thumb")!)
        .transitionDuration,
      fill: getComputedStyle(document.querySelector(".composer-thought-slider-fill")!)
        .transitionDuration,
    }));
    await browser.releaseActions();
    expect(dragMotion.thumb).toBe(dragMotion.reduced ? "0s" : "0.12s");
    expect(dragMotion.fill).toBe(dragMotion.thumb);
    await slider.click();
    await browser.keys("End");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector(".composer-thought-slider-fill")!, "::before")
              .opacity === "1",
        ),
      { timeout: 3000 },
    );
    const gradientColors = await browser.execute(() => {
      const fill = document.querySelector<HTMLElement>(".composer-thought-slider-fill")!;
      const marker = document.createElement("span");
      marker.style.color = "var(--composer-thought-max-accent)";
      fill.append(marker);
      const accent = getComputedStyle(marker).color;
      marker.style.color = "var(--color-purple-500)";
      const purple = getComputedStyle(marker).color;
      marker.remove();
      return { gradient: getComputedStyle(fill, "::before").backgroundImage, accent, purple };
    });
    expect(gradientColors.gradient).toContain(gradientColors.accent);
    if (highspeed) {
      // Chromium 序列化默认 OKLab 时省略 in oklab；检查真实紫色端点和无色相插值。
      expect(gradientColors.gradient).toContain(gradientColors.purple);
      expect(gradientColors.gradient).not.toContain("in oklch");
    } else expect(gradientColors.gradient).toContain("in oklch");
    const bubbles = await browser.execute(() => {
      const layer = document.querySelector<HTMLElement>(
        '[data-testid="composer-thought-bubbles"]',
      )!;
      return {
        count: layer.children.length,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        display: getComputedStyle(layer).display,
        animation: getComputedStyle(layer.firstElementChild!).animationName,
        duration: parseFloat(getComputedStyle(layer.firstElementChild!).animationDuration),
      };
    });
    expect(bubbles.count).toBe(highspeed ? 32 : 12);
    if (highspeed && !bubbles.reduced) {
      expect(bubbles.duration).toBeGreaterThanOrEqual(0.8);
      expect(bubbles.duration).toBeLessThanOrEqual(1.2);
    }
    expect(bubbles.animation).toBe(bubbles.reduced ? "none" : "composer-thought-bubble-flow");
    if (bubbles.reduced) expect(bubbles.display).toBe("none");
    await browser.keys("ArrowLeft");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            getComputedStyle(document.querySelector(".composer-thought-slider-fill")!, "::before")
              .opacity === "0",
        ),
      { timeout: 3000 },
    );
    expect(await $('[data-testid="composer-thought-bubbles"]').isExisting()).toBe(false);
    await closeComposerPicker();
    if (highspeed) await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "high");
  });

  it("模型管理入口位于 Provider 子菜单并打开模型设置", async () => {
    await ensureCompletedTask();
    await openComposerPicker("model");
    expect(await $('[data-model-footer-action="manage-models"]').isExisting()).toBe(false);
    const provider = $('[data-testid="composer-provider-trigger"]');
    expect(await provider.$('img, svg[aria-hidden="true"]').isExisting()).toBe(true);
    await provider.click();
    const providerMenu = await $('[data-slot="dropdown-menu-sub-content"]');
    await providerMenu.waitForDisplayed();
    // 入场缩放期间外框坐标尚未稳定，等待菜单自身动画结束后再验证对齐。
    await browser.waitUntil(() =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[role="menu"]')).every((menu) =>
          menu.getAnimations().every((animation) => animation.playState === "finished"),
        ),
      ),
    );
    const providerBounds = await browser.execute(() => {
      const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]')!;
      const rect = menu.getBoundingClientRect();
      return {
        inside: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
        overflow: menu.scrollWidth > menu.clientWidth,
        topSafe: rect.top >= 11,
        aligned:
          Math.abs(
            rect.top -
              document.querySelector('[data-slot="dropdown-menu-content"]')!.getBoundingClientRect()
                .top,
          ) <= 1,
        listOverflow: getComputedStyle(menu.querySelector("[data-composer-provider-list]")!)
          .overflowY,
      };
    });
    expect(providerBounds.inside).toBe(true);
    expect(providerBounds.overflow).toBe(false);
    expect(providerBounds.topSafe).toBe(true);
    expect(providerBounds.aligned).toBe(true);
    expect(providerBounds.listOverflow).toBe("auto");
    expect(
      await browser.execute(() =>
        getComputedStyle(
          document.querySelector('[data-slot="dropdown-menu-sub-content"]')!,
        ).getPropertyValue("app-region"),
      ),
    ).toBe("no-drag");

    const manage = $('[data-model-footer-action="manage-models"]');
    await manage.waitForDisplayed();
    const badgeGaps = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="menuitemradio"] [data-provider-access-badge]',
        ),
      ).map((badge) => {
        const name = badge.previousElementSibling!;
        const range = document.createRange();
        range.selectNodeContents(name);
        return badge.getBoundingClientRect().left - range.getBoundingClientRect().right;
      }),
    );
    expect(badgeGaps.length).toBeGreaterThan(0);
    for (const gap of badgeGaps) expect(gap).toBeLessThanOrEqual(9);
    await manage.click();
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await waitForNoComposerPickerOpen("模型设置返回后菜单关闭");
  });

  it("completed task 的 picker 不跨 scope 自动弹到新 draft", async () => {
    await selectV4TaskById(await ensureCompletedTask());
    await openComposerPicker("model");
    await waitForOnlyComposerPickerOpen("model", "completed task 打开模型 picker");

    await startNewV4Draft();
    await waitForNoComposerPickerOpen("completed task→draft");
  });

  it("completed task → draft 后独立重新水合自定义 slash command", async () => {
    // Bug 原因：task → draft 会保留模型目录但清空 slashCommands；旧水合门禁只检查
    // 模型目录，导致真实 user-scope 自定义命令永远不会重新进入 composer 候选。
    await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
  });

  it("draft → 已知 completed task 后保留自定义 slash command", async () => {
    // Bug 原因：Mocha grep 会跳过负责建 task 与水合 draft 的前置 it；依赖 describe 内
    // 变量会让本 case 无法独立回放。这里幂等补齐 S03 自身的前置状态，整组运行仍复用已有状态。
    const taskId = await ensureCompletedTask();
    await ensureCustomSlashHydratedInDraft();
    // Bug 原因：旧 task 导航把 workspace 级 slashCommands 清空，但 session projection
    // 只恢复会话状态，不会回填 composer 消费的 workspace catalog。
    await selectV4TaskById(taskId);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
      timeoutMsg: "draft → 已知 task 后 v4 composer 输入框没有出现或不可输入",
    });
    await waitForV4SlashOption(CUSTOM_SLASH_OPTION_ID);
    expect(await getV4SlashOptionIds()).toContain(CUSTOM_SLASH_OPTION_ID);

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "已知 task slash 回归断言后没有清空 composer",
    });
  });
  it("model tooltip describes the action and closes when the menu opens", async () => {
    await ensureCompletedTask();
    const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    await browser.performActions([
      {
        type: "pointer",
        id: "tooltip-mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1 }],
      },
    ]);
    await trigger.moveTo();
    const tooltip = $('[data-slot="tooltip-content"]');
    await tooltip.waitForDisplayed();
    expect(await tooltip.getText()).toMatch(/Select model|选择模型/);
    expect(await tooltip.getText()).not.toContain(" · ");
    expect(await tooltip.$("kbd").isExisting()).toBe(true);
    await trigger.click();
    await waitForOnlyComposerPickerOpen("model", "tooltip to model menu");
    await tooltip.waitForDisplayed({ reverse: true });
    await closeComposerPicker();
  });
  it("draft: dismisses with one outside click after using the effort slider", async () => {
    await ensureCompletedTask();
    // 未绑定草稿没有配置 ACK，连续调档仍保留弹层；已有会话的门禁由 CPG02 验证。
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    for (const gesture of ["click", "drag"]) {
      await openComposerPicker("model");
      try {
        const slider = $('[data-testid="composer-thought-slider"]');
        const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
        expect(levels.length).toBeGreaterThan(1);
        await slider.click();
        // 点击本身可能触发目录重读；等真实交互门禁恢复后再发送 Home，避免按键被吞。
        await browser.waitUntil(
          async () => (await slider.getAttribute("aria-disabled")) === "false",
          { timeout: 15000 },
        );
        await browser.keys("Home");
        await browser.waitUntil(async () => (await getV4ModelConfig()).thought === levels[0]);
        const before = await getV4ModelConfig();
        const targetIndex = gesture === "click" ? 1 : levels.length - 1;
        // 中点可能正好落在两个离散档位的分界线上；按目标档位中心点击，避免像素取整歧义。
        const rect = await browser.execute((target) => {
          const input = document.querySelector<HTMLInputElement>(
            '[data-testid="composer-thought-slider"]',
          )!;
          const bounds = input.getBoundingClientRect();
          const position = (index: number) =>
            Math.round(bounds.left + 14 + ((bounds.width - 28) * index) / Number(input.max));
          return {
            x: position(Number(input.value)),
            y: Math.round(bounds.top + bounds.height / 2),
            end: position(target),
          };
        }, targetIndex);
        await browser.performActions([
          {
            type: "pointer",
            id: "dismiss-slider",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: gesture === "click" ? rect.end : rect.x,
                y: rect.y,
              },
              { type: "pointerDown", button: 0 },
              ...(gesture === "drag"
                ? [{ type: "pointerMove" as const, duration: 150, x: rect.end, y: rect.y }]
                : []),
              { type: "pointerUp", button: 0 },
            ],
          },
        ]);
        await browser.releaseActions();
        // 先证明真实手势已经调档，避免滑杆失效时仅验证菜单关闭而产生假阳性。
        await browser.waitUntil(
          async () =>
            Number(await slider.getValue()) === targetIndex &&
            (await getV4ModelConfig()).thought === levels[targetIndex],
          { timeout: 15000, timeoutMsg: `${gesture} did not commit the target effort` },
        );
        expect(await getV4ModelConfig()).toMatchObject({
          provider: before.provider,
          model: before.model,
          thought: levels[targetIndex],
        });
        await browser.waitUntil(
          async () => {
            const value = await $('[data-testid="composer-thought-value"] [title]');
            return (await value.getText()) === (await slider.getAttribute("aria-valuetext"));
          },
          { timeout: 5000, timeoutMsg: "rolling effort label did not settle on the current level" },
        );
        await waitForOnlyComposerPickerOpen("model", "slider interaction");
        await browser.performActions([
          {
            type: "pointer",
            id: "outside-click",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, x: 4, y: 100 },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ]);
        await browser.releaseActions();
        await waitForNoComposerPickerOpen(`one outside click after ${gesture}`);
        expect(await getV4ModelConfig()).toMatchObject({
          provider: before.provider,
          model: before.model,
          thought: levels[targetIndex],
        });
      } finally {
        await browser.releaseActions();
        if (
          (await $('[data-testid="chat-model-select-trigger"]').getAttribute("aria-expanded")) ===
          "true"
        )
          await closeComposerPicker();
      }
    }
  });
  it("draft: keeps the open model picker responsive when the composer shrinks and expands", async () => {
    await ensureCompletedTask();
    // 未绑定草稿没有配置 ACK，连续调档仍保留弹层；已有会话的门禁由 CPG02 验证。
    await startNewV4Draft();
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    await openComposerPicker("model");
    const trigger = await $('[data-testid="chat-model-select-trigger"]');
    const slider = await $('[data-testid="composer-thought-slider"]');
    const menu = await $('[role="menu"]');
    const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
    expect(levels.length).toBeGreaterThan(1);
    // 鼠标留在菜单内会随浮层移动触发 Radix pointerleave 焦点规则；以键盘场景隔离 resize。
    await browser.performActions([
      {
        type: "pointer",
        id: "resize-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 4, y: 100 }],
      },
    ]);
    await browser.releaseActions();
    await browser.keys("End");
    await browser.waitUntil(() => slider.isFocused(), {
      timeout: 5000,
      timeoutMsg: "keyboard did not focus effort slider",
    });
    await browser.keys("Home");
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought === levels[0]);
    let expectedConfig = await getV4ModelConfig();
    const resizeToolbar = async (width: string) =>
      browser.execute((value) => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-testid="chat-model-select-trigger"]',
        )!;
        const root = trigger.closest<HTMLElement>(
          "[data-composer-trailing-actions]",
        )!.parentElement!;
        root.style.width = value;
      }, width);
    try {
      for (const width of ["240px", ""]) {
        await resizeToolbar(width);
        await browser.waitUntil(
          async () =>
            browser.execute((compact) => {
              const trigger = document.querySelector<HTMLElement>(
                '[data-testid="chat-model-select-trigger"]',
              )!;
              const root = trigger.closest<HTMLElement>(
                "[data-composer-trailing-actions]",
              )!.parentElement!;
              const leading = root
                .querySelector<HTMLElement>("[data-composer-leading-content]")!
                .getBoundingClientRect();
              const trailing = root
                .querySelector<HTMLElement>("[data-composer-trailing-actions]")!
                .getBoundingClientRect();
              const label = trigger.querySelector<HTMLElement>("[data-composer-open-label]")!;
              const icon = trigger.querySelector<HTMLElement>("[data-composer-open-icon]")!;
              return (
                trigger.getAttribute("aria-expanded") === "true" &&
                leading.right <= trailing.left &&
                (compact
                  ? trigger.getBoundingClientRect().width < 128 &&
                    getComputedStyle(label).display === "none" &&
                    getComputedStyle(icon).display !== "none" &&
                    getComputedStyle(
                      trigger.querySelector<HTMLElement>("[data-composer-open-thought]")!,
                    ).display !== "none" &&
                    !trigger.querySelector("[data-composer-open-chevron]")
                  : trigger.getBoundingClientRect().width >= 128 &&
                    getComputedStyle(label).display !== "none" &&
                    getComputedStyle(icon).display === "none")
              );
            }, Boolean(width)),
          { timeout: 5000, timeoutMsg: `open picker failed to fit ${width || "restored width"}` },
        );
        // 仅检查 aria-expanded 会漏掉重建菜单或丢焦点；保留 WebDriver 节点身份并验证键盘路径。
        expect((await $('[data-testid="chat-model-select-trigger"]')).elementId).toBe(
          trigger.elementId,
        );
        expect((await $('[data-testid="composer-thought-slider"]')).elementId).toBe(
          slider.elementId,
        );
        expect((await $('[role="menu"]')).elementId).toBe(menu.elementId);
        expect(await slider.isFocused()).toBe(true);
        expect(await getV4ModelConfig()).toEqual(expectedConfig);
        if (width) {
          await browser.keys("End");
          await browser.waitUntil(
            async () =>
              (await getV4ModelConfig()).thought === levels.at(-1) &&
              (await $('[data-testid="composer-thought-meter"]').getAttribute("data-progress")) ===
                "100",
            { timeout: 15000, timeoutMsg: "compact picker lost keyboard effort updates" },
          );
          expect(await $('[data-testid="composer-thought-meter"]').isDisplayed()).toBe(true);
          expectedConfig = { ...expectedConfig, thought: levels.at(-1)! };
          expect(await getV4ModelConfig()).toEqual(expectedConfig);
        }
      }
      await resizeToolbar("240px");
      await closeComposerPicker();
      await openComposerPicker("model");
      await waitForOnlyComposerPickerOpen("model", "reopen at compact width");
      expect(await $("[data-composer-open-icon]").isDisplayed()).toBe(true);
      expect(await $('[data-testid="composer-thought-meter"]').isDisplayed()).toBe(true);
      expect(await $("[data-composer-open-chevron]").isExisting()).toBe(false);
      expect(await $("[data-composer-open-label]").isDisplayed()).toBe(false);
      expect((await trigger.getSize()).width).toBeLessThan(128);
      expect(await getV4ModelConfig()).toEqual(expectedConfig);
    } finally {
      await resizeToolbar("");
      await closeComposerPicker();
    }
  });
  it("CPG02: 配置 ACK 挂起时保留面板并禁用配置，跨会话 pending 独立", async function () {
    this.timeout(120000);
    await ensureCompletedTask();
    await seedAckProvider();
    const taskA = completedTaskId!;
    const marker = "E2E_PROVIDER_PENDING_SEND_CROSS_SESSION";
    await startNewV4Draft();
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    const taskB = (
      await waitForV4Pane((p) => !p.canStop && Boolean(p.sessionId), "B 未完成", 45000)
    ).sessionId!;
    await switchV4Model(ACK_PROVIDER, "GLM-5.3", "max");
    await selectV4TaskById(taskA);
    await switchV4Model(ACK_PROVIDER, "GLM-5.3", "max");
    await setV4ComposerText(marker);
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      const probe = {
        count: 0,
        releaseOne() {
          held.shift()?.();
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          held.splice(0).forEach((send) => send());
        },
      };
      (window as Window & { __configAckProbe?: typeof probe }).__configAckProbe = probe;
      MessagePort.prototype.postMessage = function (
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        const data = args[0];
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        const wire = bytes ? new TextDecoder().decode(bytes) : "";
        // 控制真实配置 RPC 的发送，令调用方持续等待 ACK；不伪造 Session 或回执。
        if (
          wire.includes("sendConversationCommandV4") &&
          wire.includes('"type":"switchModelConfig"')
        ) {
          probe.count++;
          held.push(() => Reflect.apply(original, this, args));
          return;
        }
        Reflect.apply(original, this, args);
      };
    });
    const count = () =>
      browser.execute(
        () => (window as Window & { __configAckProbe?: { count: number } }).__configAckProbe!.count,
      );
    const release = () =>
      browser.execute(() =>
        (
          window as Window & { __configAckProbe?: { releaseOne(): void } }
        ).__configAckProbe!.releaseOne(),
      );
    const changeThought = async () => {
      await openComposerPicker("model");
      await browser.execute(() =>
        document
          .querySelector<HTMLInputElement>('[data-testid="composer-thought-slider"]')
          ?.focus(),
      );
      await browser.keys("Home");
    };
    const expectLocked = async () => {
      const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
      await browser.waitUntil(async () => !(await trigger.isEnabled()), {
        timeout: 5000,
        timeoutMsg: "ACK 在途仍允许选模",
      });
      // 跨会话导航可以关闭菜单；当前操作产生的 ACK 不得主动关闭。
      if ((await trigger.getAttribute("aria-expanded")) === "true") {
        expect(
          await $('[data-testid="composer-thought-slider"]').getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
          await $('[data-testid="composer-provider-trigger"]').getAttribute("aria-disabled"),
        ).toBe("true");
        expect(
          await $('[data-testid^="chat-model-select-item-"]').getAttribute("aria-disabled"),
        ).toBe("true");
      }
    };
    try {
      await changeThought();
      await browser.waitUntil(async () => (await count()) === 1, { timeout: 10000 });
      await expectLocked();
      await waitForOnlyComposerPickerOpen("model", "滑杆 ACK 在途保持面板");
      await browser.keys(["Control", "t"]);
      await browser.keys(["Control", "m"]);
      await expectLocked();
      expect(await count()).toBe(1);
      await closeComposerPicker();
      await selectV4TaskById(taskB);
      await changeThought();
      await browser.waitUntil(async () => (await count()) === 2, {
        timeout: 10000,
        timeoutMsg: "B 被 A 的屏障阻塞",
      });
      await expectLocked();
      await waitForOnlyComposerPickerOpen("model", "B 滑杆 ACK 在途保持面板");
      await closeComposerPicker();
      await selectV4TaskById(taskA);
      await expectLocked();
      await selectV4TaskById(taskB);
      await release();
      await expectPersistedThought(taskA, "high");
      await expectLocked();
      await release();
      await expectPersistedThought(taskB, "high");
      await browser.waitUntil(async () => (await getV4ModelConfig()).thought === "high", {
        timeout: 10000,
      });
      expect(await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).isEnabled()).toBe(true);
      await selectV4TaskById(taskA);
      await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").includes(marker), {
        timeout: 10000,
        timeoutMsg: "返回 A 后正文丢失",
      });
      const displayed = await getV4ModelConfig();
      const send = $('[data-testid="v4-composer-send"]');
      await send.waitForClickable({ timeout: 10000 });
      await send.click();
      const capture = await waitForUpstreamNetworkCapture(marker);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await writeFile(
          join(artifactDir, "cross-session-ack-request.json"),
          JSON.stringify(
            {
              sessionId: taskA,
              marker,
              displayed,
              expectedThought: "high",
              url: capture.url,
              statusCode: capture.statusCode,
              request: capture.requestJson,
            },
            null,
            2,
          ),
        );
      assertUpstreamRequestCapture(capture, { expectedText: marker, model: "GLM-5.3" });
      assertUpstreamThoughtLevelCapture(capture, "high");
      expect(displayed.thought).toBe("high");
    } finally {
      await browser.execute(() =>
        (window as Window & { __configAckProbe?: { restore(): void } }).__configAckProbe?.restore(),
      );
    }
  });
  it("CPG01: 手机远控切同名 Provider，挂起期间不发送，完成后使用目标 Provider", async function () {
    this.timeout(120000);
    await ensureCompletedTask();
    // A/B 使用同一 workspace；手机导航会重建 bridge，晚到回执必须从 Session 恢复。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
    await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
    completedTaskId = (
      await waitForV4Pane((p) => !p.canStop && Boolean(p.sessionId), "手机 A 未完成", 45000)
    ).sessionId!;
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("CPG01 缺少手机 fixture");
    await $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    ).waitForClickable({ timeout: 10000 });
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    const held: Array<() => void> = [];
    let holding = false;
    let holdConfig = false;
    let holdConfigReply = false;
    let replyBridge: string | null = null;
    let configs = 0;
    let sends = 0;
    const release = () => {
      holding = false;
      holdConfig = false;
      holdConfigReply = false;
      replyBridge = null;
      held.splice(0).forEach((send) => send());
    };
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
        const server = route.connectToServer();
        route.onMessage((message) => {
          const payload = JSON.parse(String(message)).payload;
          const wire =
            typeof payload?.dataBase64 === "string"
              ? Buffer.from(payload.dataBase64, "base64").toString("utf8")
              : "";
          if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"'))
            sends++;
          const isConfig =
            wire.includes("sendConversationCommandV4") &&
            wire.includes('"type":"switchModelConfig"');
          if (isConfig) configs++;
          if (isConfig && holdConfigReply && wire.includes(completedTaskId!))
            replyBridge = payload.bridgeSessionId;
          if (
            (holdConfig && isConfig && wire.includes(completedTaskId!)) ||
            (holding && wire.includes("model-selection") && wire.includes("getView"))
          ) {
            held.push(() => server.send(message));
          } else server.send(message);
        });
        server.onMessage((message) => {
          const payload = JSON.parse(String(message)).payload;
          if (replyBridge && payload?.bridgeSessionId === replyBridge && payload.dataBase64)
            held.push(() => route.send(message));
          else route.send(message);
        });
      });
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/provider-gate",
        caseMarker: "CPG01",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      await showMobileTaskHome(page);
      const toggles = page.getByTestId("virtual-project-toggle");
      for (let i = 0; i < (await toggles.count()); i++) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      }
      await page.getByTestId(`task-item-${completedTaskId}`).first().click();
      const input = page.getByTestId(TID_V4_COMPOSER_INPUT);
      await input.waitFor();
      await input.fill("E2E_PROVIDER_PENDING_SEND_MOBILE");
      const readDraft = () =>
        input.evaluate((element) =>
          element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
            ? element.value
            : (element.textContent ?? ""),
        );
      await browser.waitUntil(
        async () =>
          (await readDraft()).includes("E2E_PROVIDER_PENDING_SEND_MOBILE") &&
          (await page.getByTestId("v4-composer-send").isEnabled()),
        { timeout: 30000 },
      );
      holding = true;
      await page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).click();
      await page.getByTestId("composer-provider-trigger").click();
      await page
        .locator(`[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`)
        .click();
      await browser.waitUntil(() => held.length > 0, { timeout: 10000 });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      const send = page.getByTestId("v4-composer-send");
      expect(await send.isDisabled()).toBe(true);
      await input.press("Enter");
      expect(sends).toBe(0);
      expect(await readDraft()).toContain("E2E_PROVIDER_PENDING_SEND_MOBILE");
      release();
      await browser.waitUntil(() => send.isEnabled(), { timeout: 30000 });
      // 手机仅切档位也应在发送前提交 Session，而非只更新本端草稿。
      await page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).click();
      const thoughtSlider = page.getByTestId("composer-thought-slider");
      const thoughtLevels = JSON.parse(
        (await thoughtSlider.getAttribute("data-levels")) ?? "[]",
      ) as string[];
      await thoughtSlider.focus();
      await thoughtSlider.press("Home");
      await expectPersistedThought(completedTaskId!, thoughtLevels[0]!);
      await page.keyboard.press("Escape");
      // 手机配置 ACK 门禁：保留面板、禁用配置与快捷键，未确认前不发送。
      const modelTrigger = page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER);
      await modelTrigger.click();
      holdConfig = true;
      const configsBefore = configs;
      await thoughtSlider.focus();
      await thoughtSlider.press("End");
      await browser.waitUntil(() => held.length === 1, { timeout: 10000 });
      await browser.waitUntil(() => modelTrigger.isDisabled(), { timeout: 5000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await thoughtSlider.getAttribute("aria-disabled")).toBe("true");
      await page.keyboard.press("Control+t");
      await page.keyboard.press("Control+m");
      expect(configs).toBe(configsBefore + 1);
      expect(await send.isDisabled()).toBe(true);
      release();
      await expectPersistedThought(completedTaskId!, thoughtLevels.at(-1)!);
      await browser.waitUntil(() => send.isEnabled(), { timeout: 30000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await thoughtSlider.getAttribute("aria-disabled")).toBe("false");
      await page.keyboard.press("Escape");
      const repliesBefore = (await page.locator('[data-testid="v4-timeline"]').innerText()).split(
        "PROVIDER_PENDING_SEND_OK",
      ).length;
      await send.click();
      await browser.waitUntil(
        async () =>
          (await page.locator('[data-testid="v4-timeline"]').innerText()).split(
            "PROVIDER_PENDING_SEND_OK",
          ).length > repliesBefore,
        { timeout: 45000 },
      );
      expect(sends).toBe(1);
      await waitForV4Pane((pane) => !pane.canStop, "CPG01 手机请求未结束", 30000);
      const db = new DatabaseSync(
        join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "select provider_id as provider, model_id as model from model_usage where session_id = ? and query_source = 'main_turn' order by started_at desc limit 1",
            )
            .get(completedTaskId!),
        ).toMatchObject({
          provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
          model: UPSTREAM_ALTERNATE_MODEL,
        });
      } finally {
        db.close();
      }
      // 手机也保留未发送正文，离开后才放行原会话配置，再返回抓实际请求。
      await seedAckProvider();
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
      await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
      const taskB = (
        await waitForV4Pane((p) => !p.canStop && Boolean(p.sessionId), "手机验证 B 未完成", 45000)
      ).sessionId!;
      await modelTrigger.click();
      await page.getByTestId("composer-provider-trigger").click();
      await page.locator(`[data-model-provider-key="registry-provider:${ACK_PROVIDER}"]`).click();
      await browser.waitUntil(
        async () => (await thoughtSlider.getAttribute("aria-disabled")) === "false",
        { timeout: 15000 },
      );
      await thoughtSlider.focus();
      await thoughtSlider.press("End");
      await expectPersistedThought(completedTaskId!, "max");
      await page.keyboard.press("Escape");
      const marker = "E2E_PROVIDER_PENDING_SEND_CROSS_SESSION_MOBILE";
      await input.fill(marker);
      await modelTrigger.click();
      // 放行命令，仅延迟 A bridge 的下行配置回执与投影，避免向已销毁 bridge 重发命令。
      holdConfigReply = true;
      await thoughtSlider.focus();
      await thoughtSlider.press("Home");
      await expectPersistedThought(completedTaskId!, "high");
      await browser.waitUntil(() => held.length > 0, { timeout: 10000 });
      expect(await modelTrigger.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      const openTask = async (id: string) => {
        await showMobileTaskHome(page);
        const groups = page.getByTestId("virtual-project-toggle");
        for (let i = 0; i < (await groups.count()); i++) {
          if ((await groups.nth(i).getAttribute("aria-expanded")) !== "true")
            await groups.nth(i).click();
        }
        await page.getByTestId(`task-item-${id}`).first().click();
        try {
          await input.waitFor({ timeout: 15000 });
        } catch (error) {
          const dir = process.env.ZCODE_E2E_ARTIFACT_DIR;
          if (dir)
            await writeFile(
              join(dir, "cross-session-mobile-navigation.txt"),
              `${id} held=${held.length}\n${await page.locator("body").innerText()}`,
            );
          throw error;
        }
      };
      await openTask(taskB);
      release();
      await expectPersistedThought(completedTaskId!, "high");
      await openTask(completedTaskId!);
      await browser.waitUntil(async () => (await readDraft()).includes(marker), {
        timeout: 10000,
        timeoutMsg: "手机返回 A 后正文丢失",
      });
      await send.click();
      const capture = await waitForUpstreamNetworkCapture(marker);
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir)
        await writeFile(
          join(artifactDir, "cross-session-ack-mobile-request.json"),
          JSON.stringify(
            {
              sessionId: completedTaskId,
              marker,
              expectedThought: "high",
              url: capture.url,
              statusCode: capture.statusCode,
              request: capture.requestJson,
            },
            null,
            2,
          ),
        );
      assertUpstreamRequestCapture(capture, { expectedText: marker, model: "GLM-5.3" });
      assertUpstreamThoughtLevelCapture(capture, "high");
    } finally {
      release();
      await chrome.close();
    }
  });
  for (const [width, changeScope] of [
    [1280, false],
    [430, false],
    [1280, true],
  ] as const) {
    it(`CPG01: ${width}px 同名模型切 Provider 时禁止发送且保留草稿${changeScope ? "（切换会话）" : ""}`, async function () {
      this.timeout(120000);
      await ensureCompletedTask();
      let nextTaskId: string | undefined;
      if (changeScope) {
        await startNewV4Draft();
        await sendV4Prompt("E2E_V4_COMPOSER_TOOLBAR_SEED");
        await waitForV4TimelineContaining("V4_COMPOSER_TOOLBAR_SEED_OK", 45000);
        const next = await waitForV4Pane(
          (pane) => !pane.canStop && Boolean(pane.sessionId) && pane.sessionId !== "draft",
          "scope 补验未创建 B 会话",
          45000,
        );
        nextTaskId = next.sessionId!;
      }
      await selectV4TaskById(completedTaskId!);
      await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
      await browser.electron.execute((electron, size) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => window.isVisible())
          ?.setSize(size, 900);
      }, width);
      await setV4ComposerText(`E2E_PROVIDER_PENDING_SEND_${width}`);
      await browser.execute(() => {
        const original = MessagePort.prototype.postMessage;
        const held: Array<() => void> = [];
        let holding = true;
        const probe = {
          held: 0,
          sends: 0,
          allowNewRequests() {
            holding = false;
          },
          release() {
            holding = false;
            held.splice(0).forEach((send) => send());
          },
          restore() {
            probe.release();
            MessagePort.prototype.postMessage = original;
          },
        };
        (window as Window & { __providerPendingProbe?: typeof probe }).__providerPendingProbe =
          probe;
        MessagePort.prototype.postMessage = function (
          ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
        ) {
          const data = args[0];
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : null;
          const wire = bytes ? new TextDecoder().decode(bytes) : "";
          const forward = () => Reflect.apply(original, this, args);
          if (wire.includes("sendConversationCommandV4") && wire.includes('"type":"sendText"'))
            probe.sends++;
          // 挂起真实目录 RPC，不修改模型选择、ACK 或服务端状态。
          if (holding && wire.includes("model-selection") && wire.includes("getView")) {
            probe.held++;
            held.push(forward);
            return;
          }
          forward();
        };
      });
      const readProbe = () =>
        browser.execute(() => {
          const probe = (
            window as Window & { __providerPendingProbe?: { held: number; sends: number } }
          ).__providerPendingProbe!;
          return { held: probe.held, sends: probe.sends };
        });
      try {
        await openComposerPicker("model");
        await $('[data-testid="composer-provider-trigger"]').click();
        await $(
          `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
        ).click();
        await browser.waitUntil(async () => (await readProbe()).held > 0, { timeout: 10000 });
        await closeComposerPicker();
        const send = $('[data-testid="v4-composer-send"]');
        await browser.waitUntil(async () => !(await send.isEnabled()), {
          timeout: 5000,
          timeoutMsg: "Provider 刷新中仍允许发送",
        });
        await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).click();
        await browser.keys("Enter");
        expect((await readProbe()).sends).toBe(0);
        expect(await getV4ComposerText()).toContain("E2E_PROVIDER_PENDING_SEND");
        if (nextTaskId) {
          await browser.execute(() =>
            (
              window as Window & { __providerPendingProbe?: { allowNewRequests(): void } }
            ).__providerPendingProbe!.allowNewRequests(),
          );
          await selectV4TaskById(nextTaskId);
          await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_ALTERNATE_MODEL, "high");
          await setV4ComposerText(`E2E_PROVIDER_PENDING_SEND_${width}`);
          await openComposerPicker("model");
          await $('[data-testid="composer-provider-trigger"]').click();
          await $(
            `[data-model-provider-key="registry-provider:${UPSTREAM_ALTERNATE_PROVIDER_ID}"]`,
          ).click();
          await closeComposerPicker();
          await browser.waitUntil(async () => await send.isEnabled(), {
            timeout: 30000,
            timeoutMsg: "B 会话再次切 Provider 后 pending 未解除",
          });
        }
        await browser.execute(() =>
          (
            window as Window & { __providerPendingProbe?: { release(): void } }
          ).__providerPendingProbe!.release(),
        );
        await browser.waitUntil(async () => await send.isEnabled(), { timeout: 30000 });
        expect(await getV4ModelConfig()).toMatchObject({
          provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
          model: UPSTREAM_ALTERNATE_MODEL,
        });
        const repliesBefore = (await getV4PaneSnapshot()).timelineText.split(
          "PROVIDER_PENDING_SEND_OK",
        ).length;
        await send.click();
        const pane = await waitForV4Pane(
          (value) =>
            !value.canStop &&
            value.timelineText.split("PROVIDER_PENDING_SEND_OK").length > repliesBefore,
          "CPG01 新请求未结束",
          45000,
        );
        expect((await readProbe()).sends).toBe(1);
        // Node SQLite 只提供同步接口；只读一条实际请求归属，不以工具栏展示替代请求断言。
        const db = new DatabaseSync(
          join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
          { readOnly: true },
        );
        try {
          expect(
            db
              .prepare(
                "select provider_id as provider, model_id as model, status from model_usage where session_id = ? and query_source = 'main_turn' order by started_at desc limit 1",
              )
              .get(pane.sessionId!),
          ).toMatchObject({
            provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
            model: UPSTREAM_ALTERNATE_MODEL,
            status: "completed",
          });
        } finally {
          db.close();
        }
      } finally {
        await browser.electron.execute((electron) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(1280, 900);
        });
        await browser.execute(() =>
          (
            window as Window & { __providerPendingProbe?: { restore(): void } }
          ).__providerPendingProbe?.restore(),
        );
      }
    });
  }
});
