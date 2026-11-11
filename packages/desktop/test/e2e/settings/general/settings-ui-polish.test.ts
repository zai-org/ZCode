import { mkdir } from "node:fs/promises";
import { ModelConfig, ModelOptionSpecsConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { join } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_LOGIN_TRIGGER,
  TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON,
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  readModelProvider,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { connectSSHWorkspace, readSSHRuntimeConfig } from "#e2e/helpers/ssh-remote-p0";

const EMPTY_MODELS_PROVIDER_ID = "e2e-empty-models-provider";
const REORDER_MODELS_PROVIDER_ID = "e2e-reorder-models-provider";
const REORDER_MODEL_IDS = ["e2e-reorder-first", "e2e-reorder-second"] as const;
const REASONING_EDITOR_PROVIDER_ID = "e2e-reasoning-editor-provider";
const REASONING_EDITOR_MODEL_ID = "gateway/team/glm-5.3-20260907";
const DELETE_PROVIDER_ID = "e2e-delete-provider";

describe("设置页 UI polish E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    // 上一个用例可能停在设置页，先真实关闭遮挡层再操作侧栏项目。
    const back = $(sel(TID_SETTINGS_BACK_BUTTON));
    if (await back.isDisplayed()) await back.click();
    await prepareV4ConversationE2E({ skipProvider: true });
    // prepare 已保证默认项目草稿；窄屏检查会收起侧栏，不能再无条件 hover 新建。
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  });

  it("UP-00: Windows 设置页使用问号帮助入口且移除 caption 下箭头", async function () {
    if (process.platform !== "win32") return;
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    const panel = await $('[data-settings-panel-frame="true"]');
    expect(((await panel.getAttribute("class")) ?? "").split(/\s+/)).toContain("rounded-md");
    expect(await panel.getCSSProperty("border-top-left-radius")).toMatchObject({ value: "6px" });
    expect(
      await $('[data-testid="settings-page"] svg.lucide-circle-question-mark').isDisplayed(),
    ).toBe(true);
    expect(
      await $(
        '[data-testid="settings-page"] button[aria-label="titleBar.windowMenu"]',
      ).isExisting(),
    ).toBe(false);
    expect(
      await $(
        '[data-testid="settings-page"] [data-testid="desktop-window-controls"]',
      ).isDisplayed(),
    ).toBe(true);
    expect(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('[data-settings-panel-frame="true"]');
        return panel ? getComputedStyle(panel).borderTopRightRadius : null;
      }),
    ).toBe("6px");
    expect(
      await browser.execute(() => {
        const logo = document.querySelector<HTMLElement>(
          '[data-testid="settings-page"] [data-testid="settings-logo"]',
        );
        if (!logo) return null;
        const rect = logo.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      }),
    ).toEqual({ left: 17, top: 19 });
    const settingsLogo = await $('[data-testid="settings-logo"]');
    expect(await settingsLogo.$("[data-desktop-logo-badge]").getSize("width")).toBe(20);
    expect(await settingsLogo.$("svg").getSize("width")).toBe(13);
    expect(await settingsLogo.$("animate").isExisting()).toBe(false);
    for (const theme of ["light", "dark"]) {
      await setPresentation({ locale: "zh-CN", theme });
      expect(await settingsLogo.$("svg").getSize("width")).toBe(13);
      const screenshotDir = join(process.cwd(), ".e2e-artifacts", "desktop-logo");
      await mkdir(screenshotDir, { recursive: true });
      await browser.saveScreenshot(join(screenshotDir, `settings-${theme}.png`));
    }
    expect(
      await browser.execute(() => {
        const help = document
          .querySelector('[data-testid="settings-page"] svg.lucide-circle-question-mark')
          ?.closest<HTMLElement>("button");
        const close = document.querySelector<HTMLElement>(
          '[data-testid="settings-page"] [data-testid="window-control-close"]',
        );
        if (!help || !close) return null;
        const helpRect = help.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        return {
          helpTop: helpRect.top,
          closeTop: closeRect.top,
          closeRightInset: window.innerWidth - closeRect.right,
        };
      }),
    ).toEqual({ helpTop: 17, closeTop: 17, closeRightInset: 15 });
    expect(
      await browser.execute(() => {
        const content = document.querySelector('[data-settings-content-frame="true"]')!;
        const panel = document.querySelector('[data-settings-panel-frame="true"]')!;
        const style = getComputedStyle(content);
        return {
          right: style.paddingRight,
          bottom: style.paddingBottom,
          top: panel.getBoundingClientRect().top - content.getBoundingClientRect().top,
        };
      }),
    ).toEqual({ right: "6px", bottom: "6px", top: 6 });
  });

  it("UP-01: 头像菜单按 language、theme、zoom 顺序展示偏好入口", async function () {
    this.timeout(60000);

    await clickVisibleTestId(TID_LOGIN_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "侧边栏头像菜单入口没有出现",
    });

    await browser.waitUntil(async () => (await readVisibleProfileMenuItems()).length >= 3, {
      timeout: 15000,
      timeoutMsg: "头像菜单的偏好入口没有完整展开",
    });
    const menuSnapshot = await readVisibleProfileMenuItems();
    if (process.platform === "darwin") {
      // macOS 根框架使用 background-alt；比较语义 utility 的运行时主题色，避免绑定具体色值格式。
      const backgrounds = await browser.execute(() => {
        const frame = document.querySelector<HTMLElement>(
          "div.h-dvh.flex.flex-col.overflow-hidden.border-border.text-foreground",
        );
        if (!frame) throw new Error("DesktopWindowFrame 不存在");
        const reference = document.createElement("div");
        reference.className = "bg-background-alt";
        document.body.append(reference);
        const result = [
          getComputedStyle(frame).backgroundColor,
          getComputedStyle(reference).backgroundColor,
        ];
        reference.remove();
        return result;
      });
      expect(backgrounds[0]).toBe(backgrounds[1]);
    }
    if (process.platform === "linux") {
      const shellChrome = await browser.execute(() => {
        const frame = document.querySelector<HTMLElement>('[data-desktop-window-frame="true"]');
        if (!frame) throw new Error("DesktopWindowFrame 不存在");
        const style = getComputedStyle(frame);
        return { radius: style.borderTopLeftRadius, clipPath: style.clipPath };
      });
      expect(shellChrome).toEqual({ radius: "16px", clipPath: "inset(0px round 16px)" });
    }

    // 圆角规范：独立菜单外壳 lg，选项 md；读取计算样式以覆盖实际 CSS 和业务覆盖。
    const radii = await browser.execute(() => {
      const menu = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"]'),
      ).find((element) => element.getBoundingClientRect().width > 0);
      if (!menu) throw new Error("头像菜单浮层没有出现");
      return {
        shell: getComputedStyle(menu).borderTopLeftRadius,
        items: Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
          (item) => getComputedStyle(item).borderTopLeftRadius,
        ),
      };
    });
    expect(radii.shell).toBe("8px");
    expect(radii.items.length).toBeGreaterThanOrEqual(3);
    expect(radii.items.every((radius) => radius === "6px")).toBe(true);

    const languageIndex = menuSnapshot.findIndex((text) => /界面语言|Language/.test(text));
    const themeIndex = menuSnapshot.findIndex((text) => /界面主题|App theme/.test(text));
    const zoomIndex = menuSnapshot.findIndex((text) => /界面缩放|Interface zoom/.test(text));

    if (languageIndex < 0 || themeIndex < 0 || zoomIndex < 0) {
      throw new Error(`头像菜单偏好入口不完整：${JSON.stringify(menuSnapshot)}`);
    }
    expect(themeIndex).toBeGreaterThan(languageIndex);
    expect(zoomIndex).toBeGreaterThan(themeIndex);
    // 本例遗留的模态菜单会屏蔽下一例真实滚轮；DOM click 不受遮挡，曾掩盖该污染。
    await browser.keys("Escape");
    await browser.waitUntil(
      async () =>
        (await readVisibleProfileMenuItems()).length === 0 &&
        (await browser.execute(() => getComputedStyle(document.body).pointerEvents)) !== "none",
      { timeout: 10000, timeoutMsg: "头像菜单未关闭或指针屏障尚未释放" },
    );
  });

  it("UP-02: 设置页桌面 Sidebar 宽度为 268px 且与内容直接相接", async () => {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });

    expect(
      await browser.execute(() => {
        const page = document.querySelector<HTMLElement>('[data-testid="settings-page"]');
        const sidebar = page?.querySelector<HTMLElement>(":scope > aside");
        const content = page?.querySelector<HTMLElement>('[data-settings-content-frame="true"]');
        if (!page || !sidebar || !content) return null;
        const pageRect = page.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        return {
          sidebarWidth: sidebarRect.width,
          contentOffset: contentRect.left - pageRect.left,
          gap: contentRect.left - sidebarRect.right,
        };
      }),
    ).toEqual({ sidebarWidth: 268, contentOffset: 268, gap: 0 });
  });

  async function readVisibleProfileMenuItems() {
    return browser.execute(() => {
      const visibleItems = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visibleItems.map((element) => element.innerText.trim());
    });
  }

  it("MP-UI-01: 点击新增供应商后原子创建并直接进入普通详情卡", async function () {
    this.timeout(60000);

    await openModelProviderSettings();
    expect(
      await browser.execute((addProviderTestId) => {
        const addButton = document.querySelector<HTMLButtonElement>(
          `[data-testid="${addProviderTestId}"]`,
        );
        const actions = addButton?.parentElement;
        const refreshButton = Array.from(
          actions?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => button !== addButton);
        return {
          addVariant: addButton?.dataset.variant,
          addSize: addButton?.dataset.size,
          gap: actions ? getComputedStyle(actions).gap : null,
          refreshBeforeAdd: Boolean(
            refreshButton &&
            addButton &&
            refreshButton.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          refreshVariant: refreshButton?.dataset.variant,
          refreshSize: refreshButton?.dataset.size,
        };
      }, TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON),
    ).toEqual({
      addVariant: "default",
      addSize: "default",
      gap: "8px",
      refreshBeforeAdd: true,
      refreshVariant: "outline",
      refreshSize: "icon-md",
    });
    const selectedProviderTestId = await browser.execute(() => {
      const selected = document.querySelector<HTMLElement>(
        '[data-testid^="model-provider-nav-item-"][aria-selected="true"]',
      );
      return selected?.dataset.testid ?? null;
    });
    if (!selectedProviderTestId) throw new Error("进入设置页后没有选中的 Provider");
    await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON, {
      timeout: 30000,
      timeoutMsg: "添加模型供应商入口没有出现",
    });
    await $(sel(TID_MODEL_PROVIDER_TEMPLATE_PICKER)).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "添加供应商后没有进入 Template 选择页",
    });
    const templateLayout = await browser.execute((templateItemPrefix) => {
      const picker = document.querySelector<HTMLElement>(
        '[data-testid="model-provider-template-picker"]',
      );
      const cards = Array.from(
        picker?.querySelectorAll<HTMLElement>(`[data-testid^="${templateItemPrefix}"]`) ?? [],
      );
      return {
        cardHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
        columns: picker
          ? getComputedStyle(picker.querySelector<HTMLElement>(".grid")!)
              .gridTemplateColumns.split(" ")
              .filter(Boolean).length
          : 0,
        hasChevron: cards.every((card) => Boolean(card.querySelector(".lucide-chevron-right"))),
      };
    }, `${TID_MODEL_PROVIDER_TEMPLATE_ITEM}-`);
    expect(templateLayout.cardHeights.every((height) => height >= 64)).toBe(true);
    expect(templateLayout.columns).toBe(2);
    expect(templateLayout.hasChevron).toBe(true);
    expect(
      await browser.execute(() =>
        Array.from(
          document.querySelectorAll(
            '[data-provider-template-group="zhipu"] [data-testid^="model-provider-template-item-"]',
          ),
        ).map((node) => node.getAttribute("data-testid")),
      ),
    ).toEqual([
      "model-provider-template-item-bigmodel-api",
      "model-provider-template-item-zai-api",
      "model-provider-template-item-bigmodel-standard-api",
      "model-provider-template-item-zai-standard-api",
    ]);
    await clickTestIdByDom(TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON);
    await browser.waitUntil(
      async () =>
        !(await $(sel(TID_MODEL_PROVIDER_TEMPLATE_PICKER)).isDisplayed()) &&
        (await $(sel(selectedProviderTestId)).getAttribute("aria-selected")) === "true",
      {
        timeout: 15000,
        timeoutMsg: "从 Template 选择页返回后没有恢复原 Provider 详情",
      },
    );
    await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "deepseek"), {
      timeout: 15000,
      timeoutMsg: "Upstream Built-in Template 入口没有出现",
    });
    await $(sel("model-provider-actions-button")).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "Built-in Template 创建后没有进入供应商详情",
    });
    await browser.waitUntil(
      async () =>
        (await $(sel(TID_MODEL_PROVIDER_BASE_URL_INPUT)).getValue()) ===
        "https://api.deepseek.com/anthropic",
      {
        timeout: 30000,
        timeoutMsg: "Template Endpoint 没有进入新 Provider 的 Effective Config",
      },
    );
    expect(await $(sel(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER)).getText()).toMatch(
      /Anthropic Messages/iu,
    );
    // Todo113 第二轮官方默认目录已去掉旧 Flash 别名，旧规则兼容另由配置测试覆盖。
    expect(await readModelOrder()).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(
      await browser.execute((addModelTestId) => {
        const addModelButton = document.querySelector<HTMLButtonElement>(
          `[data-testid="${addModelTestId}"]`,
        );
        return {
          parentMarginBottom: addModelButton?.parentElement
            ? getComputedStyle(addModelButton.parentElement).marginBottom
            : null,
          size: addModelButton?.dataset.size,
          variant: addModelButton?.dataset.variant,
        };
      }, TID_MODEL_PROVIDER_ADD_MODEL_BUTTON),
    ).toEqual({ parentMarginBottom: "4px", size: "default", variant: "secondary" });
    expect(
      await browser.execute(() => {
        const detail = document.querySelector('[data-model-provider-detail-scroll="true"]');
        return Array.from(detail?.querySelectorAll<HTMLImageElement>("img") ?? []).some((image) => {
          const rect = image.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      }),
    ).toBe(true);

    await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON);
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom"), {
      timeout: 15000,
      timeoutMsg: "自定义供应商 Template 入口没有出现",
    });

    await $(sel("model-provider-actions-button")).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "原子创建后没有进入普通供应商详情卡",
    });
    await $(sel(TID_MODEL_PROVIDER_BASE_URL_INPUT)).waitForDisplayed();
    await $(sel(TID_MODEL_PROVIDER_API_KEY_INPUT)).waitForDisplayed();
    await $(sel(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON)).waitForDisplayed();

    expect(
      await browser.execute(
        () => document.querySelector('[data-testid="add-provider-footer"]') === null,
      ),
    ).toBe(true);
    // 先验证创建链路，独立滚动故障不能遮蔽模板/自定义 Provider 的实际结果。
    await assertModelProviderPageScroll();
  });

  it("MP-UI-05: 模型配置页不显示远程配置同步入口", async function () {
    this.timeout(60000);

    await openModelProviderSettings();

    const remoteSyncActionVisible = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("button"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .some((element) => /同步到远端|Sync to remote/u.test(element.innerText.trim())),
    );

    expect(remoteSyncActionVisible).toBe(false);
  });

  it("MP-UI-02: 模型供应商删光模型后仍显示空状态和添加模型入口", async function () {
    this.timeout(120000);

    await restartIntoWorkspace({
      // Bug 根因：运行中的 Host 会在退出阶段回写 provider 文件；先 seed 再重启时，
      // 正式 E2E 的退出写回可能覆盖 fixture。必须在进程退出屏障后写入持久态。
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          apiKey: "e2e-bigmodel-empty-models-token",
          id: EMPTY_MODELS_PROVIDER_ID,
          models: ["glm-empty-models-e2e"],
          name: "Empty Models E2E",
        });
      },
    });
    await openModelProviderSettings();
    await clickTestIdByDom(
      testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${EMPTY_MODELS_PROVIDER_ID}`),
      {
        timeout: 30000,
        timeoutMsg: "空模型测试供应商入口没有出现",
      },
    );
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"), {
      timeout: 15000,
      timeoutMsg: "最后一个模型的删除按钮没有出现",
    });

    const emptyState = await waitForEmptyModelState();
    expect(emptyState).toEqual(
      expect.objectContaining({
        hasDashedBorder: true,
        hasInfoIcon: true,
        isLeftAligned: true,
        isStandardHeight: true,
      }),
    );
    expect(emptyState.text).toMatch(
      /当前没有配置模型，添加模型后可在聊天中使用。|No models are configured\. Add a model to use it in chat\./,
    );
    await $(sel(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON)).waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "空模型状态没有保留添加模型入口",
    });
  });

  it("MP-UI-03: 模型拖拽保存期间保持乐观顺序且列表边框不重叠", async function () {
    this.timeout(120000);

    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          apiKey: "e2e-reorder-models-token",
          id: REORDER_MODELS_PROVIDER_ID,
          models: REORDER_MODEL_IDS,
          name: "Reorder Models E2E",
        });
      },
    });
    await openModelProviderSettings();
    await clickTestIdByDom(
      testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${REORDER_MODELS_PROVIDER_ID}`),
      {
        timeout: 30000,
        timeoutMsg: "调序测试供应商入口没有出现",
      },
    );
    await waitForModelOrder(REORDER_MODEL_IDS);
    await beginModelOrderTrace();
    await beginModelDragStyleTrace(REORDER_MODEL_IDS[0]);

    await dragModel(REORDER_MODEL_IDS[0], REORDER_MODEL_IDS[1]);
    const expectedOrder = [REORDER_MODEL_IDS[1], REORDER_MODEL_IDS[0]] as const;
    await waitForModelOrder(expectedOrder);
    await browser.pause(800);

    const trace = await finishModelOrderTrace();
    const firstExpectedIndex = trace.findIndex(
      (order) => order.join("/") === expectedOrder.join("/"),
    );
    expect(firstExpectedIndex).toBeGreaterThanOrEqual(0);
    expect(
      trace
        .slice(firstExpectedIndex)
        .some((order) => order.join("/") === REORDER_MODEL_IDS.join("/")),
    ).toBe(false);
    expect(await finishModelDragStyleTrace()).toContainEqual({
      hasTransparentBottomBorder: true,
      hasVisibleBottomDivider: false,
    });

    const borderSnapshot = await readModelListBorderSnapshot();
    expect(borderSnapshot).toEqual({
      containerHasDivide: false,
      firstHasBottomBorder: true,
      lastHasBottomBorder: false,
      modelContentPaddingInline: "12px",
    });
  });

  it("MP-UI-04: 删除供应商后导航与 Personal Config 同时移除", async function () {
    this.timeout(120000);

    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          id: DELETE_PROVIDER_ID,
          models: ["e2e-delete-provider-model"],
          name: "Delete Provider E2E",
        });
      },
    });
    await openModelProviderSettings();
    const navTestId = testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${DELETE_PROVIDER_ID}`);
    await clickTestIdByDom(navTestId, {
      timeout: 30000,
      timeoutMsg: "删除测试供应商入口没有出现",
    });

    // Todo115 删除操作已移入菜单，不再查找标题栏的独立垃圾桶。
    await clickTestIdByWebDriver("model-provider-actions-button");
    const deleteItem = $('[role="menuitem"]:has(svg.lucide-trash-2)');
    await deleteItem.waitForDisplayed({ timeout: 15000 });
    await deleteItem.click();

    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              /确认删除|Delete provider/.test(button.innerText.trim())
            );
          }),
        ),
      {
        timeout: 15000,
        timeoutMsg: "删除供应商确认按钮没有出现",
      },
    );
    await browser.execute(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            /确认删除|Delete provider/.test(candidate.innerText.trim())
          );
        },
      );
      button?.click();
    });

    await browser.waitUntil(
      async () =>
        browser.execute(
          (targetTestId) => !document.querySelector(`[data-testid="${targetTestId}"]`),
          navTestId,
        ),
      {
        timeout: 30000,
        timeoutMsg: "删除后供应商仍残留在设置页导航",
      },
    );
    expect(await readModelProvider(DELETE_PROVIDER_ID)).toBeNull();
  });

  it("MP-UI-06: 推理档位与 Mapping 使用紧凑编辑器并保存 Personal 覆盖", async function () {
    this.timeout(120000);

    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          id: REASONING_EDITOR_PROVIDER_ID,
          models: [REASONING_EDITOR_MODEL_ID],
          name: "Reasoning Editor E2E",
        });
        // 本例验证推荐配置的继承编辑；通用 replay 的 disabled 精确覆盖会遮住推荐档位。
        const repository = new NodePersonalProviderConfigRepository({
          filePath: getE2EAppDataPaths().configFile,
          pollingIntervalMs: false,
        });
        try {
          await repository.update((current) => {
            const model = current.models.getExactRule(
              REASONING_EDITOR_PROVIDER_ID,
              REASONING_EDITOR_MODEL_ID,
            )!.config;
            return {
              ...current,
              models: current.models.setExact(
                REASONING_EDITOR_PROVIDER_ID,
                REASONING_EDITOR_MODEL_ID,
                new ModelConfig({
                  ...model,
                  optionSpecs: new ModelOptionSpecsConfig({
                    ...model.optionSpecs,
                    reasoningLevel: undefined,
                  }),
                }),
              ),
            };
          });
        } finally {
          repository.dispose();
        }
      },
    });
    await openModelProviderSettings();
    await clickTestIdByDom(
      testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${REASONING_EDITOR_PROVIDER_ID}`),
      {
        timeout: 30000,
        timeoutMsg: "推理档位测试供应商入口没有出现",
      },
    );
    await openModelMetadataDialog(REASONING_EDITOR_MODEL_ID);

    // Todo141 将输入能力和推理配置移到默认收起的高级区；先验证折叠，再由真实点击展开。
    const advanced = $('[data-model-advanced-trigger="true"]');
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(await $('[data-model-max-output="true"] input').isDisplayed()).toBe(true);
    expect(await $('[data-model-reasoning-level-editor="true"]').isDisplayed()).toBe(false);
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");

    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-model-settings-group]")).map(
          (element) => element.dataset.modelSettingsGroup,
        ),
      ),
    ).toEqual(["basic", "tokens", "tokens", "modalities", "capabilities", "reasoning"]);
    expect(
      await browser.execute(
        () => document.querySelectorAll("[data-model-settings-group] > h3").length,
      ),
    ).toBe(0);
    expect(
      await browser.execute(() => {
        // Todo125 分组标题包含独立帮助按钮，不能再冒充单字段 label。
        const inputLabel = document.querySelector<HTMLElement>(
          '[data-model-help="inputModalities"]',
        )?.parentElement;
        const capabilitiesLabel = document.querySelector<HTMLElement>(
          '[data-model-capabilities-label="true"]',
        );
        return {
          capabilitiesLabel: capabilitiesLabel?.textContent?.trim(),
          labelSpacingMatches:
            Boolean(inputLabel && capabilitiesLabel) &&
            getComputedStyle(inputLabel!).marginBottom ===
              getComputedStyle(capabilitiesLabel!).marginBottom,
        };
      }),
    ).toMatchObject({
      capabilitiesLabel: expect.stringMatching(/^(Model capabilities|模型能力)$/),
      labelSpacingMatches: true,
    });
    expect(
      await browser.execute(() => ({
        hasIdentityRow: Boolean(document.querySelector('[data-model-identity-row="true"]')),
        hasEnabledRow: Boolean(document.querySelector('[data-model-enabled-row="true"]')),
        hasLegacyIdentityEnabledLayout: Boolean(
          document.querySelector('[data-model-identity-enabled-layout="true"]'),
        ),
      })),
    ).toEqual({
      hasIdentityRow: true,
      hasEnabledRow: false,
      hasLegacyIdentityEnabledLayout: false,
    });
    expect(
      await browser.execute(() => {
        const options = Array.from(
          document.querySelectorAll<HTMLElement>('[data-model-capability-option="true"]'),
        );
        return {
          count: options.length,
          iconCount: document.querySelectorAll('[data-model-capability-icon="true"]').length,
          structuredOutputUsesLayers: Boolean(options[0]?.querySelector("svg.lucide-layers")),
          checkboxCount: options.reduce(
            (count, option) =>
              count + option.querySelectorAll('[data-model-option-checkbox="true"]').length,
            0,
          ),
          roles: options.map((option) => option.getAttribute("role")),
          states: options.map((option) => option.getAttribute("aria-checked")),
          personalOverrides: options.map((option) => option.dataset.personalOverride),
        };
      }),
    ).toEqual({
      count: 3,
      iconCount: 0,
      structuredOutputUsesLayers: false,
      checkboxCount: 3,
      roles: ["checkbox", "checkbox", "checkbox"],
      states: ["false", "false", "false"],
      personalOverrides: ["true", "true", "true"],
    });
    expect(
      await browser.execute(() => {
        const footer = document.querySelector<HTMLElement>('[data-model-settings-footer="true"]');
        const buttons = Array.from(footer?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const saveButton = buttons.find((button) => /^(Save|保存)$/u.test(button.innerText.trim()));
        const cancelButton = buttons.find((button) =>
          /^(Cancel|取消)$/u.test(button.innerText.trim()),
        );
        return {
          cancelSize: cancelButton?.dataset.size,
          cancelVariant: cancelButton?.dataset.variant,
          saveBeforeCancel: Boolean(
            saveButton &&
            cancelButton &&
            saveButton.compareDocumentPosition(cancelButton) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          saveSize: saveButton?.dataset.size,
          saveVariant: saveButton?.dataset.variant,
        };
      }),
    ).toEqual({
      cancelSize: "lg",
      cancelVariant: "ghost",
      saveBeforeCancel: false,
      saveSize: "lg",
      saveVariant: "default",
    });
    expect(
      await browser.execute(() => ({
        advancedGroupExists: Boolean(document.querySelector('[data-model-advanced="true"]')),
        advancedTriggerExists: Boolean(
          document.querySelector('[data-model-advanced-trigger="true"]'),
        ),
        reasoningHasLevelsAndMapping: Boolean(
          document.querySelector(
            '[data-model-settings-group="reasoning"] [data-model-reasoning-level-editor="true"]',
          ) &&
          document.querySelector(
            '[data-model-settings-group="reasoning"] [data-model-reasoning-level-map-editor="true"]',
          ),
        ),
      })),
    ).toEqual({
      advancedGroupExists: true,
      advancedTriggerExists: true,
      reasoningHasLevelsAndMapping: true,
    });
    expect(await $('[data-model-reasoning-level-editor="true"]').isDisplayed()).toBe(true);
    expect(await $('[data-model-input-modality="text"]').getAttribute("aria-pressed")).toBe("true");
    expect(await $('[data-model-input-modality="image"]').getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-model-modality-lock="true"]').length,
      ),
    ).toBe(1);
    await setRendererViewport(390, 844);
    try {
      for (const presentation of [
        { locale: "zh-CN", theme: "dark" },
        { locale: "en-US", theme: "light" },
      ]) {
        await setPresentation(presentation);
        await verifyModelEditorFocusFeedback();
        const geometry = await browser.execute(() => {
          const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
          const heading = dialog.querySelector<HTMLElement>('[data-slot="dialog-header"]')!;
          const scroller = dialog.querySelector<HTMLElement>("[data-model-settings-scroll]")!;
          const bounds = dialog.getBoundingClientRect();
          return {
            titleVisible: heading.getBoundingClientRect().top >= bounds.top,
            scrollTop: dialog.scrollTop,
            clientHeight: dialog.clientHeight,
            scrollHeight: dialog.scrollHeight,
            gridRows: getComputedStyle(dialog).gridTemplateRows,
            scrollerClient: scroller.clientHeight,
            scrollerScroll: scroller.scrollHeight,
          };
        });
        expect(geometry).toMatchObject({ titleVisible: true, scrollTop: 0 });
        const screenshotDir = join(process.cwd(), ".e2e-artifacts", "todo90-92");
        await mkdir(screenshotDir, { recursive: true });
        await browser.saveScreenshot(
          join(screenshotDir, `model-editor-${presentation.theme}-390.png`),
        );
        expect(
          await browser.execute(() => {
            const footer = document.querySelector<HTMLElement>(
              '[data-model-settings-footer="true"]',
            );
            const groups = Array.from(
              document.querySelectorAll<HTMLElement>("[data-model-settings-group]"),
            );
            const fit = (element: HTMLElement) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
            };
            return Boolean(footer && fit(footer) && groups.length === 6 && groups.every(fit));
          }),
        ).toBe(true);
      }
      expect(
        await browser.execute(() => {
          const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
          const scroller = document.querySelector<HTMLElement>(
            '[data-model-settings-scroll="true"]',
          );
          const firstGroup = document.querySelector<HTMLElement>("[data-model-settings-group]");
          if (!dialog || !scroller || !firstGroup) return null;
          const dialogRect = dialog.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          const groupRect = firstGroup.getBoundingClientRect();
          return {
            scrollbarOuterInset: Math.round(dialogRect.right - scrollerRect.right),
            scrollbarGutter: Math.round(scrollerRect.right - groupRect.right),
          };
        }),
      ).toEqual({
        scrollbarOuterInset: 5,
        scrollbarGutter: 16,
      });
      expect(
        await browser.execute(() => {
          const groups = Array.from(
            document.querySelectorAll<HTMLElement>("[data-model-settings-group]"),
          );
          const booleanOptions = Array.from(
            document.querySelectorAll<HTMLElement>('[data-model-boolean-option="true"]'),
          );
          const modalityOptions = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-model-input-modality], [data-model-output-modality]",
            ),
          );
          const identityRow = document.querySelector<HTMLElement>(
            '[data-model-identity-row="true"]',
          );
          const enabledRow = document.querySelector<HTMLElement>('[data-model-enabled-row="true"]');
          const fitsViewport = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          };
          return (
            window.innerWidth === 390 &&
            groups.every(fitsViewport) &&
            booleanOptions.every(fitsViewport) &&
            modalityOptions.every(fitsViewport) &&
            Boolean(identityRow && !enabledRow) &&
            fitsViewport(identityRow!) &&
            !enabledRow
          );
        }),
      ).toBe(true);
    } finally {
      await clearRendererViewport();
      await setPresentation({ locale: "zh-CN", theme: "dark" });
    }

    await browser.waitUntil(
      async () => (await readReasoningLevelValues()).join("/") === "low/high/max",
      {
        timeout: 15000,
        timeoutMsg: "模型配置没有展示有序推理档位标签",
      },
    );
    const reasoningLevelTypographyBeforeEdit = await browser.execute(() => {
      const editor = document.querySelector<HTMLElement>(
        '[data-model-reasoning-level-editor="true"]',
      );
      const chip = editor?.querySelector<HTMLButtonElement>("div > button:first-of-type");
      const addButton = editor?.querySelector<HTMLButtonElement>(
        '[data-model-reasoning-level-add="true"]',
      );
      if (!chip || !addButton) return null;
      const chipStyle = getComputedStyle(chip);
      const chipHeight = chip.parentElement?.getBoundingClientRect().height ?? 0;
      return {
        addButtonHeight: Math.round(addButton.getBoundingClientRect().height),
        addButtonWidth: Math.round(addButton.getBoundingClientRect().width),
        addButtonVariant: addButton.dataset.variant,
        chipFontFamily: chipStyle.fontFamily,
        chipFontSize: chipStyle.fontSize,
        chipHeight: Math.round(chipHeight),
      };
    });
    expect(reasoningLevelTypographyBeforeEdit).not.toBeNull();
    const firstReasoningLevel = $(
      '[data-model-reasoning-level-editor="true"] > div > button:first-of-type',
    );
    await firstReasoningLevel.click();
    const reasoningLevelInput = $('input[data-model-reasoning-level-input="true"]');
    await reasoningLevelInput.waitForDisplayed({
      timeout: 10000,
      timeoutMsg: "点击推理档位后没有进入编辑态",
    });
    const reasoningLevelTypographyAfterEdit = await browser.execute(() => {
      const editor = document.querySelector<HTMLElement>(
        '[data-model-reasoning-level-editor="true"]',
      );
      const input = editor?.querySelector<HTMLInputElement>(
        'input[data-model-reasoning-level-input="true"]',
      );
      if (!input) return null;
      const inputStyle = getComputedStyle(input);
      return {
        inputFontFamily: inputStyle.fontFamily,
        inputFontSize: inputStyle.fontSize,
        inputHeight: Math.round(input.getBoundingClientRect().height),
      };
    });
    expect(reasoningLevelTypographyAfterEdit).not.toBeNull();
    expect(reasoningLevelTypographyBeforeEdit?.addButtonVariant).toBe("outline");
    expect(reasoningLevelTypographyBeforeEdit?.addButtonHeight).toBe(
      reasoningLevelTypographyBeforeEdit?.chipHeight,
    );
    expect(reasoningLevelTypographyBeforeEdit?.addButtonWidth).toBe(
      reasoningLevelTypographyBeforeEdit?.chipHeight,
    );
    expect(reasoningLevelTypographyAfterEdit?.inputHeight).toBe(
      reasoningLevelTypographyBeforeEdit?.chipHeight,
    );
    expect(reasoningLevelTypographyAfterEdit?.inputFontSize).toBe(
      reasoningLevelTypographyBeforeEdit?.chipFontSize,
    );
    expect(reasoningLevelTypographyAfterEdit?.inputFontFamily).toBe(
      reasoningLevelTypographyBeforeEdit?.chipFontFamily,
    );
    await browser.execute(() => {
      document
        .querySelector<HTMLInputElement>('input[data-model-reasoning-level-input="true"]')
        ?.blur();
    });
    await browser.waitUntil(async () => !(await reasoningLevelInput.isExisting()), {
      timeout: 10000,
      timeoutMsg: "推理档位输入框失焦后没有退出编辑态",
    });
    expect(
      await browser.execute(
        () =>
          document.querySelector('[data-model-reasoning-level-editor="true"] textarea') === null,
      ),
    ).toBe(true);
    const reasoningMapEditor = $('[data-model-reasoning-level-map-editor="true"] textarea');
    await reasoningMapEditor.waitForDisplayed({
      timeout: 15000,
      timeoutMsg: "推理参数 Mapping JSON 编辑框没有出现",
    });
    // 继承配置只作为 placeholder 展示；空 value 表示尚未写入 Personal Overlay。
    expect(await reasoningMapEditor.getValue()).toBe("");
    expect((await reasoningMapEditor.getAttribute("placeholder"))?.trim()).not.toBe("");
    const personalReasoningMapInput = '{"reasoning_effort": reasoningLevel}';
    // Todo98 保留用户 Map 原文，不再压成单行或删除表达式中的空格。
    await reasoningMapEditor.setValue(personalReasoningMapInput);

    await browser.execute(() => {
      const first = document.querySelector<HTMLButtonElement>(
        '[data-model-reasoning-level-editor="true"] > div > button:first-of-type',
      );
      first?.dispatchEvent(
        new KeyboardEvent("keydown", { altKey: true, bubbles: true, key: "ArrowRight" }),
      );
    });
    await browser.waitUntil(
      async () => (await readReasoningLevelValues()).join("/") === "high/low/max",
      {
        timeout: 10000,
        timeoutMsg: "键盘调整推理档位顺序没有立即反映到草稿",
      },
    );
    expect(
      await browser.execute(() => {
        const chips = [
          ...document.querySelectorAll<HTMLElement>('[data-model-reasoning-chip="true"]'),
        ];
        const map = document.querySelector<HTMLElement>(
          '[data-model-reasoning-level-map-editor="true"] textarea',
        );
        const group = document.querySelector<HTMLElement>(
          '[data-model-settings-group="reasoning"]',
        );
        const capability = document.querySelector<HTMLElement>(
          '[data-model-settings-group="capabilities"] [role="checkbox"]',
        );
        return {
          chips: chips.map((chip) => chip.dataset.personalOverride),
          map: map?.dataset.personalOverride,
          outerHighlighted: group?.className.includes("border-primary") ?? false,
          capabilityCheckboxes: capability?.querySelectorAll("[data-model-option-checkbox]").length,
        };
      }),
    ).toEqual({
      chips: ["true", "true", "true"],
      map: "true",
      outerHighlighted: false,
      capabilityCheckboxes: 1,
    });
    await clickVisibleButton(/保存|Save/);
    // 修复原因：Dialog 有关闭动画。若立即用 DOM click 重开，会穿透尚未卸载的遮罩层，
    // wait 条件又会误把旧 Dialog 当成新 Dialog，随后只能持续读到空档位。
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.querySelector('[data-model-reasoning-level-editor="true"]') === null,
        ),
      { timeout: 15000, timeoutMsg: "模型配置保存后弹窗没有关闭" },
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-provider-detail-feedback-state="success"]')),
        ),
      { timeout: 15000, timeoutMsg: "模型配置保存后没有展示成功反馈" },
    );
    await assertLongProviderFeedbackVisible();
    expect(
      await browser.execute(() => {
        const feedback = document.querySelector<HTMLElement>(
          '[data-provider-detail-feedback-state="success"]',
        );
        const viewport = document.querySelector<HTMLElement>(
          '[data-testid="provider-detail-feedback-viewport"]',
        );
        const icon = feedback?.querySelector<HTMLElement>("svg");
        if (!feedback || !viewport || !icon) return null;
        return {
          matchesLoadingWidth:
            Math.abs(
              feedback.getBoundingClientRect().width - viewport.getBoundingClientRect().width,
            ) <= 1,
          usesXlRadius: feedback.classList.contains("rounded-xl"),
          iconUsesSuccess: icon.classList.contains("text-success"),
          neutralSurface:
            feedback.classList.contains("border-border") &&
            feedback.classList.contains("bg-popover/95") &&
            feedback.classList.contains("text-foreground"),
        };
      }),
    ).toEqual({
      matchesLoadingWidth: true,
      usesXlRadius: true,
      iconUsesSuccess: true,
      neutralSurface: true,
    });
    await openModelMetadataDialog(REASONING_EDITOR_MODEL_ID, true);
    await browser.waitUntil(
      async () => (await readReasoningLevelValues()).join("/") === "high/low/max",
      {
        timeout: 30000,
        timeoutMsg: "推理档位顺序保存后没有保持",
      },
    );
    expect(await $('[data-model-reasoning-level-map-editor="true"] textarea').getValue()).toBe(
      personalReasoningMapInput,
    );
    const followSwitch = '[data-model-recommended-config="true"] [role="switch"]';
    expect(await $(followSwitch).getAttribute("aria-checked")).toBe("true");
    await $(followSwitch).click();
    expect(await $(followSwitch).getAttribute("aria-checked")).toBe("false");
    await closeAndReopenModelEditor("cancel");
    expect(await $(followSwitch).getAttribute("aria-checked")).toBe("true");
    expect(await $('[data-model-reasoning-level-map-editor="true"] textarea').getValue()).toBe(
      personalReasoningMapInput,
    );

    await $(followSwitch).click();
    await closeAndReopenModelEditor("save");
    expect(await $(followSwitch).getAttribute("aria-checked")).toBe("false");
    expect(await $('[data-model-reasoning-level-map-editor="true"] textarea').getValue()).toBe(
      personalReasoningMapInput,
    );

    await $(followSwitch).click();
    expect(await $('[data-model-reasoning-level-map-editor="true"] textarea').getValue()).toBe("");
    const editedAfterReset = '{"output_config":{"effort":reasoningLevel}}';
    await $('[data-model-reasoning-level-map-editor="true"] textarea').setValue(editedAfterReset);
    await closeAndReopenModelEditor("save");
    expect(await $(followSwitch).getAttribute("aria-checked")).toBe("true");
    expect(await $('[data-model-reasoning-level-map-editor="true"] textarea').getValue()).toBe(
      editedAfterReset,
    );
    // 能力由真实表单保存，随后验证两个消费入口；不直接改 DOM 或注入徽标。
    // 切回推荐配置会恢复当前 Built-in 能力；按真实状态开启视觉，不能无条件反转成关闭。
    const imageInput = $('[data-model-input-modality="image"]');
    if ((await imageInput.getAttribute("aria-pressed")) !== "true") await imageInput.click();
    await expect(imageInput).toHaveAttribute("aria-pressed", "true");
    await clickVisibleButton(/保存|Save/);
    await $('[data-model-settings-scroll="true"]').waitForExist({ reverse: true });
    for (const presentation of [
      { locale: "zh-CN", theme: "dark" },
      { locale: "en-US", theme: "light" },
    ]) {
      await setPresentation(presentation);
      const badge = $(
        `[data-model-provider-model-id="${REASONING_EDITOR_MODEL_ID}"] [data-model-input-capability="vision"]`,
      );
      await badge.waitForDisplayed();
      expect(await badge.getText()).toMatch(/视觉|Vision/);
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER);
    // 合并模型菜单先打开 Provider 分组，再进入具体模型列表。
    await $('[data-testid="composer-provider-trigger"]').click();
    await $(
      sel(testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${REASONING_EDITOR_PROVIDER_ID}`)),
    ).click();
    const modelItem = $(
      sel(
        testId(
          TID_CHAT_MODEL_SELECT_ITEM,
          encodeCustomModelValue(REASONING_EDITOR_PROVIDER_ID, REASONING_EDITOR_MODEL_ID),
        ),
      ),
    );
    try {
      await modelItem.waitForDisplayed();
    } catch (error) {
      const menu = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="menu"], [role="listbox"], [data-testid^="chat-model-select"]',
          ),
        ).map((element) => ({ id: element.dataset.testid, text: element.innerText })),
      );
      throw new Error(`视觉模型候选未显示：${JSON.stringify(menu)}`, { cause: error });
    }
    expect(await modelItem.$('[data-model-input-capability="vision"]').isDisplayed()).toBe(true);
  });

  it("MP-UI-05-remote: 远程 workspace 下也不显示配置同步入口", async function () {
    this.timeout(10 * 60_000);
    if (!process.env.ZCODE_E2E_SSH_HOST?.trim()) {
      this.skip();
      return;
    }

    const config = readSSHRuntimeConfig("MP-UI-05-remote");
    await connectSSHWorkspace({
      caseMarker: "MP-UI-05-remote",
      config,
      workspacePath: config.workspacePaths[0],
    });
    await openModelProviderSettings();

    const remoteSyncActionVisible = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("button"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .some((element) => /同步到远端|Sync to remote/u.test(element.innerText.trim())),
    );

    expect(remoteSyncActionVisible).toBe(false);
  });
});

async function verifyModelEditorFocusFeedback(): Promise<void> {
  const selector = '[data-model-settings-group="capabilities"] [role="checkbox"]';
  const button = $(selector);
  await button.scrollIntoView();
  const outside = $('[data-model-settings-footer="true"] button');
  await outside.moveTo();
  await browser.execute((target) => document.querySelector<HTMLElement>(target)?.blur(), selector);
  const readStyle = () =>
    browser.executeAsync(
      (target, done: (style: { background: string; border: string }) => void) => {
        const element = document.querySelector<HTMLElement>(target)!;
        // Bug 原因：Hover 中途的 alpha=0.047 被当成最终颜色，随后与焦点最终的
        // alpha=0.05 比较必然超时。只等待此控件的动画完成，不修改产品样式或固定 sleep。
        void Promise.allSettled(
          element.getAnimations().map((animation) => animation.finished),
        ).then(() => {
          const css = getComputedStyle(element);
          done({ background: css.backgroundColor, border: css.borderColor });
        });
      },
      selector,
    );
  const normal = await readStyle();
  await button.moveTo();
  await browser.waitUntil(async () => (await readStyle()).background !== normal.background);
  const hovered = await readStyle();
  await outside.moveTo();
  await browser.keys("Tab");
  await browser.execute((target) => document.querySelector<HTMLElement>(target)?.focus(), selector);
  await browser.waitUntil(async () => (await readStyle()).background === hovered.background);
  expect((await readStyle()).border).toBe(normal.border);
  // 鼠标已经移走，键盘焦点仍有同一底色；不能用取消 ring 让 Tab 焦点消失。
  expect(
    await browser.execute(
      (target) => document.querySelector(target) === document.activeElement,
      selector,
    ),
  ).toBe(true);
  await outside.moveTo();
  await browser.execute((target) => document.querySelector<HTMLElement>(target)?.blur(), selector);
  await browser.waitUntil(async () => (await readStyle()).background === normal.background);
}

async function setPresentation(input: { locale: string; theme: string }): Promise<void> {
  const error = await browser.executeAsync((next, done: (error?: string) => void) => {
    const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
      .__testActions;
    if (typeof actions?.setLocale !== "function" || typeof actions?.setTheme !== "function")
      return done("missing presentation test actions");
    (actions.setLocale as (value: string) => void)(next.locale);
    (actions.setTheme as (value: string) => void)(next.theme);
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }, input);
  if (error) throw new Error(error);
}

async function readModelOrder(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-model-provider-model-id]")).map(
      (element) => element.dataset.modelProviderModelId ?? "",
    ),
  );
}

async function openModelMetadataDialog(modelId: string, expandAdvanced = false) {
  const clicked = await browser.execute((targetModelId) => {
    const row = document.querySelector<HTMLElement>(
      `[data-model-provider-model-id="${CSS.escape(targetModelId)}"]`,
    );
    const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => candidate.querySelector("svg.lucide-pencil") !== null,
    );
    button?.click();
    return Boolean(button);
  }, modelId);
  if (!clicked) throw new Error(`模型编辑按钮不存在：${modelId}`);
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => document.querySelector('[data-model-reasoning-level-editor="true"]') !== null,
      ),
    { timeout: 15000, timeoutMsg: "模型配置弹窗没有出现" },
  );
  if (expandAdvanced) await $('[data-model-advanced-trigger="true"]').click();
}

async function readReasoningLevelValues(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-model-reasoning-level-editor="true"] > div > button:first-of-type',
      ),
    ).map((button) => button.innerText.trim()),
  );
}

async function closeAndReopenModelEditor(action: "save" | "cancel") {
  await clickVisibleButton(action === "save" ? /^(保存|Save)$/u : /^(取消|Cancel)$/u);
  await browser.waitUntil(
    async () => !(await $('[data-model-reasoning-level-editor="true"]').isExisting()),
    { timeout: 15000, timeoutMsg: "模型编辑弹窗没有关闭" },
  );
  await openModelMetadataDialog(REASONING_EDITOR_MODEL_ID, true);
}

async function clickVisibleButton(label: RegExp) {
  const clicked = await browser.execute(
    (source, flags) => {
      const matcher = new RegExp(source, flags);
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && matcher.test(candidate.innerText.trim());
        },
      );
      button?.click();
      return Boolean(button);
    },
    label.source,
    label.flags,
  );
  if (!clicked) throw new Error(`没有找到按钮：${label}`);
}

async function waitForModelOrder(expected: readonly string[]) {
  await browser.waitUntil(async () => (await readModelOrder()).join("/") === expected.join("/"), {
    timeout: 30000,
    timeoutMsg: `模型顺序没有收敛到 ${expected.join("/")}`,
  });
}

async function beginModelOrderTrace() {
  await browser.execute(() => {
    const windowWithTrace = window as Window & {
      __e2eModelOrderTrace?: string[][];
      __e2eModelOrderObserver?: MutationObserver;
    };
    const readOrder = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-model-provider-model-id]")).map(
        (element) => element.dataset.modelProviderModelId ?? "",
      );
    const record = () => {
      const trace = (windowWithTrace.__e2eModelOrderTrace ??= []);
      const order = readOrder();
      if (trace.at(-1)?.join("/") !== order.join("/")) trace.push(order);
    };
    windowWithTrace.__e2eModelOrderTrace = [];
    windowWithTrace.__e2eModelOrderObserver?.disconnect();
    windowWithTrace.__e2eModelOrderObserver = new MutationObserver(record);
    windowWithTrace.__e2eModelOrderObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    record();
  });
}

async function finishModelOrderTrace(): Promise<string[][]> {
  return browser.execute(() => {
    const windowWithTrace = window as Window & {
      __e2eModelOrderTrace?: string[][];
      __e2eModelOrderObserver?: MutationObserver;
    };
    windowWithTrace.__e2eModelOrderObserver?.disconnect();
    return windowWithTrace.__e2eModelOrderTrace ?? [];
  });
}

async function beginModelDragStyleTrace(modelId: string) {
  await browser.execute((targetModelId) => {
    const windowWithTrace = window as Window & {
      __e2eModelDragStyleTrace?: Array<{
        hasTransparentBottomBorder: boolean;
        hasVisibleBottomDivider: boolean;
      }>;
      __e2eModelDragStyleObserver?: MutationObserver;
    };
    const row = document.querySelector<HTMLElement>(
      `[data-model-provider-model-id="${CSS.escape(targetModelId)}"]`,
    );
    windowWithTrace.__e2eModelDragStyleTrace = [];
    windowWithTrace.__e2eModelDragStyleObserver?.disconnect();
    if (!row) return;
    windowWithTrace.__e2eModelDragStyleObserver = new MutationObserver(() => {
      if (!row.classList.contains("z-10")) return;
      windowWithTrace.__e2eModelDragStyleTrace?.push({
        hasTransparentBottomBorder: row.classList.contains("border-transparent"),
        hasVisibleBottomDivider: row.classList.contains("border-input-border"),
      });
    });
    windowWithTrace.__e2eModelDragStyleObserver.observe(row, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }, modelId);
}

async function finishModelDragStyleTrace() {
  return browser.execute(() => {
    const windowWithTrace = window as Window & {
      __e2eModelDragStyleTrace?: Array<{
        hasTransparentBottomBorder: boolean;
        hasVisibleBottomDivider: boolean;
      }>;
      __e2eModelDragStyleObserver?: MutationObserver;
    };
    windowWithTrace.__e2eModelDragStyleObserver?.disconnect();
    return windowWithTrace.__e2eModelDragStyleTrace ?? [];
  });
}

async function dragModel(sourceModelId: string, targetModelId: string) {
  const positions = await browser.execute(
    (sourceId, targetId) => {
      const source = document.querySelector<HTMLElement>(
        `[data-model-provider-model-id="${CSS.escape(sourceId)}"]`,
      );
      const target = document.querySelector<HTMLElement>(
        `[data-model-provider-model-id="${CSS.escape(targetId)}"]`,
      );
      if (!source || !target) return null;
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        startX: Math.round(sourceRect.left + sourceRect.width / 2),
        startY: Math.round(sourceRect.top + sourceRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.bottom - 4),
      };
    },
    sourceModelId,
    targetModelId,
  );
  if (!positions) throw new Error("模型拖拽元素不存在");

  await browser.performActions([
    {
      id: "model-reorder-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: positions.startX, y: positions.startY },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        {
          type: "pointerMove",
          duration: 120,
          x: positions.startX,
          y: positions.startY + 10,
        },
        {
          type: "pointerMove",
          duration: 260,
          x: positions.endX,
          y: positions.endY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function readModelListBorderSnapshot() {
  return browser.execute(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-model-provider-model-id]"),
    );
    const container = rows[0]?.parentElement;
    return {
      containerHasDivide: container?.className.includes("divide-y") ?? false,
      firstHasBottomBorder: rows[0]?.classList.contains("border-b") ?? false,
      lastHasBottomBorder: rows.at(-1)?.classList.contains("border-b") ?? false,
      modelContentPaddingInline: rows[0]?.firstElementChild
        ? getComputedStyle(rows[0].firstElementChild).paddingInlineStart
        : null,
    };
  });
}

async function clickVisibleTestId(
  currentTestId: string,
  options: {
    timeout?: number;
    timeoutMsg?: string;
  } = {},
) {
  const timeout = options.timeout ?? 10000;
  await browser.waitUntil(
    async () => {
      return browser.execute((targetTestId) => {
        const target = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => {
            const rect = candidate.getBoundingClientRect();
            return candidate.dataset.testid === targetTestId && rect.width > 0 && rect.height > 0;
          },
        );
        if (!target) return false;
        target.focus();
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
        }
        return true;
      }, currentTestId);
    },
    { timeout, timeoutMsg: options.timeoutMsg },
  );
}

async function openModelProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现模型供应商分区入口",
  });
}

async function waitForEmptyModelState() {
  await browser.waitUntil(async () => (await readEmptyModelStateSnapshot()) !== null, {
    timeout: 30000,
    timeoutMsg: "模型供应商空模型提示没有出现",
  });
  const snapshot = await readEmptyModelStateSnapshot();
  if (!snapshot) {
    throw new Error("Coding Plan 空模型提示等待成功后又消失");
  }
  return snapshot;
}

async function readEmptyModelStateSnapshot() {
  return browser.execute(() => {
    // 修复原因：祖先容器的 innerText 也包含空状态文案，必须锁定虚线提示自身，
    // 否则几何/样式断言会误读整个设置页容器。
    const candidate = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
      (element) =>
        element.classList.contains("border-dashed") &&
        /当前没有配置模型|No models are configured/.test(element.innerText.trim()),
    );
    if (!candidate) {
      return null;
    }
    return {
      hasDashedBorder: candidate.classList.contains("border-dashed"),
      hasInfoIcon: candidate.querySelector("svg.lucide-info") !== null,
      isLeftAligned:
        candidate.classList.contains("justify-start") && candidate.classList.contains("text-left"),
      isStandardHeight: candidate.classList.contains("h-12"),
      text: candidate.innerText.trim(),
    } satisfies EmptyModelStateSnapshot;
  });
}

interface EmptyModelStateSnapshot {
  hasDashedBorder: boolean;
  hasInfoIcon: boolean;
  isLeftAligned: boolean;
  isStandardHeight: boolean;
  text: string;
}

async function setRendererViewport(width: number, height: number) {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有收敛到 ${width}px` },
  );
}

async function clearRendererViewport() {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown> = {}) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  expect(sent).toBe(true);
}

async function assertModelProviderPageScroll() {
  try {
    for (const width of [1280, 600]) {
      await setRendererViewport(width, 800);
      for (const side of ["navigation", "detail"]) {
        const geometry = await browser.execute((side) => {
          const panel = document.querySelector<HTMLElement>(
            '[data-model-provider-split-panel="true"]',
          )!;
          const nav = panel.querySelector<HTMLElement>(
            '[data-model-provider-navigation-scroll="true"]',
          )!;
          const detail = panel.querySelector<HTMLElement>(
            '[data-model-provider-detail-scroll="true"]',
          )!;
          const main = panel.closest("main")!;
          const probe = document.createElement("div");
          probe.dataset.modelLayoutProbe = "true";
          probe.style.height = "1200px";
          probe.setAttribute("aria-hidden", "true");
          (side === "navigation" ? nav : detail).append(probe);
          main.scrollTop = panel.offsetTop;
          nav.scrollTop = 100;
          detail.scrollTop = 100;
          const rect = panel.getBoundingClientRect();
          const target = (side === "navigation" ? nav : detail).getBoundingClientRect();
          return {
            height: rect.height,
            navHeight: nav.getBoundingClientRect().height,
            detailHeight: detail.getBoundingClientRect().height,
            navScroll: nav.scrollTop,
            detailScroll: detail.scrollTop,
            minHeight: getComputedStyle(panel).minHeight,
            mainScroll: main.scrollTop,
            x: Math.round(target.left + Math.min(target.width / 2, 30)),
            y: Math.round(Math.max(rect.top, main.getBoundingClientRect().top) + 100),
          };
        }, side);
        expect(geometry.minHeight).toBe("576px");
        expect(geometry.height).toBeGreaterThan(1200);
        expect(Math.abs(geometry.navHeight - geometry.detailHeight)).toBeLessThan(1);
        expect(geometry.navScroll).toBe(0);
        expect(geometry.detailScroll).toBe(0);
        await browser.performActions([
          {
            type: "wheel",
            id: "model-page-wheel",
            actions: [
              {
                type: "scroll",
                duration: 200,
                x: geometry.x,
                y: geometry.y,
                deltaX: 0,
                deltaY: 160,
              },
            ],
          },
        ]);
        try {
          await browser.waitUntil(
            async () =>
              browser.execute((before) => {
                const panel = document.querySelector('[data-model-provider-split-panel="true"]')!;
                return panel.closest("main")!.scrollTop > before + 20;
              }, geometry.mainScroll),
            { timeout: 3000, timeoutMsg: "Outer settings page did not scroll" },
          );
        } catch (error) {
          const actual = await browser.execute(({ x, y }) => {
            const panel = document.querySelector('[data-model-provider-split-panel="true"]')!;
            const main = panel.closest("main")!;
            const hit = document.elementFromPoint(x, y);
            return {
              scrollTop: main.scrollTop,
              scrollHeight: main.scrollHeight,
              clientHeight: main.clientHeight,
              probePresent: Boolean(panel.querySelector("[data-model-layout-probe]")),
              hit: hit?.tagName,
              hitClass: hit?.className,
              hitInsideMain: Boolean(hit && main.contains(hit)),
            };
          }, geometry);
          throw new Error(
            `Outer settings page did not scroll: ${JSON.stringify({ width, side, geometry, actual })}`,
            { cause: error },
          );
        }
        await browser.execute(() => {
          document.querySelector("[data-model-layout-probe]")?.remove();
          document
            .querySelector('[data-model-provider-split-panel="true"]')!
            .closest("main")!.scrollTop = 0;
        });
      }
    }
  } finally {
    await browser.releaseActions();
    await browser.execute(() =>
      document.querySelectorAll("[data-model-layout-probe]").forEach((e) => e.remove()),
    );
    await clearRendererViewport();
  }
}

async function assertLongProviderFeedbackVisible() {
  try {
    for (const [width, height] of [
      [1280, 600],
      [600, 500],
    ]) {
      await setRendererViewport(width!, height!);
      for (const side of ["navigation", "detail"]) {
        const results = await browser.execute((side) => {
          const panel = document.querySelector<HTMLElement>(
            '[data-model-provider-split-panel="true"]',
          )!;
          const main = panel.closest("main")!;
          const detail = panel.querySelector<HTMLElement>(
            '[data-model-provider-detail-scroll="true"]',
          )!;
          const target = panel.querySelector<HTMLElement>(
            `[data-model-provider-${side}-scroll="true"]`,
          )!;
          const probe = document.createElement("div");
          probe.dataset.feedbackLayoutProbe = "true";
          probe.style.height = "1200px";
          target.prepend(probe);
          const feedback = panel.querySelector<HTMLElement>(
            '[data-provider-detail-feedback-state="success"]',
          )!;
          const fullHeight = main.scrollHeight;
          const results = [0, (main.scrollHeight - main.clientHeight) / 2, main.scrollHeight].map(
            (offset) => {
              main.scrollTop = offset;
              const rect = feedback.getBoundingClientRect();
              const viewport = main.getBoundingClientRect();
              const column = detail.getBoundingClientRect();
              return {
                visible:
                  rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom,
                insideColumn: rect.left >= column.left && rect.right <= column.right,
                stableHeight: main.scrollHeight === fullHeight,
              };
            },
          );
          probe.remove();
          main.scrollTop = 0;
          return results;
        }, side);
        for (const result of results)
          expect(result).toEqual({ visible: true, insideColumn: true, stableHeight: true });
      }
    }
  } finally {
    await browser.execute(() =>
      document.querySelectorAll("[data-feedback-layout-probe]").forEach((probe) => probe.remove()),
    );
    await clearRendererViewport();
  }
}
