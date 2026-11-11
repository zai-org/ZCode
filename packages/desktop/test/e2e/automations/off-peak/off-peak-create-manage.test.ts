import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_MENU,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  restoreElectronRendererContentSize,
  setInputValueByTestIdDom,
  setCurrentElectronRendererContentSize,
  type ElectronRendererContentSizeSnapshot,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  UPSTREAM_SECONDARY_MODEL,
} from "#e2e/helpers/upstream-provider";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "#e2e/helpers/model-provider-restart";

let rendererSizeSnapshot: ElectronRendererContentSizeSnapshot | undefined;

/**
 * 闲时任务「表单创建 → 列表回显 → Pause → Continue → 删除」端到端。
 *
 * 由进程内 mock 网关驱动（wdio.conf startOffPeakE2EMock 设 ZCODE_OFFPEAK_MOCK=1）：
 * host 起网关、灰度强制开启、票据在本 spec 窗口内保持 queued。全程只碰 UI + 本地 sqlite
 * + 进程内网关的取号/状态接口，不派发模型请求，因此确定性。
 * 完整 run（派发→running→completed）、敏感批准、重启续跑见 coverage matrix 的 OPF/OPA/OPR。
 */
describe("闲时任务表单创建与管理 E2E", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      console.info("[SR87 idle diagnosis]", await browser.execute(() => document.body.innerText));
    }
  });
  after(async () => {
    if (rendererSizeSnapshot) {
      await restoreElectronRendererContentSize(rendererSizeSnapshot);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("表单创建闲时任务后列表回显，可 Pause / Continue 并删除", async function () {
    this.timeout(150000);

    // 登录 + workspace 就绪即可进入 Automations 主视图；mock 网关免真实 provider。
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCurrentAccount();
    // 修复原因：Electron 41 不支持 WebDriver window/rect；通过 BrowserWindow 固定宽屏，
    // 才能稳定验证 Tooltip 首选右侧时不会因窄窗碰撞策略翻转。
    // 只固定宽度以命中右侧 Tooltip 布局；高度受 macOS work area 限制，不能硬编码 960px。
    rendererSizeSnapshot = await setCurrentElectronRendererContentSize(1440);

    // 1) 打开 Automations 主视图（侧栏入口）。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现 Automations 入口",
    });

    // 2) 创建入口按页签展示；先进入闲时任务，不能在 scheduled 页签找闲时创建按钮。
    // 空列表没有 tab，直接显示两类创建入口；已有任务时才按页签分流。
    if (await browser.$(`[data-testid="${TID_OFFPEAK_TAB}"]`).isExisting())
      await selectIdleTimeTab();
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
      timeoutMsg: "闲时任务创建按钮没有出现（灰度未命中？）",
    });

    // 3) 模型可预选，档位必须显式选择，不能依赖历史自动补默认的行为。
    await selectOffPeakReasoning();
    const title = `E2E_OFFPEAK_${Date.now()}`;
    await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, title, {
      timeoutMsg: "闲时任务标题输入没有出现",
    });
    await setInputValueByTestIdDom(
      TID_OFFPEAK_FORM_INSTRUCTIONS,
      "整理今天改动的文件并生成一份摘要",
      { timeoutMsg: "闲时任务 instructions 输入没有出现" },
    );
    await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
      timeoutMsg: "闲时任务创建提交按钮不可点击",
    });

    // 4) 创建成功回列表后默认仍停留在定时任务 tab；闲时任务不会在该 tab 混排，
    // 必须切换到「闲时任务」再验证回显。
    await selectIdleTimeTab();
    await browser.waitUntil(
      async () => (await offPeakCardTitles()).some((t) => t.includes(title)),
      {
        timeout: 20000,
        timeoutMsg: `闲时任务列表没有回显新建卡片：${title}`,
      },
    );

    // 5) Pause：新建任务必须先暂停，避免检查详情期间被 scheduler 派发。
    await openOffPeakCardMenu({
      timeoutMsg: "卡片操作菜单没有出现",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_PAUSE, "right");

    // 修复原因：窄窗口里 right 提示会被 Radix 翻到菜单内部的 left，必须验证其改为上方后
    // 与菜单完全不相交；该尺寸覆盖用户缩小桌面窗口后的单列卡片布局。
    await browser.keys("Escape");
    await setCurrentElectronRendererContentSize(900, 720);
    await openOffPeakCardMenu({
      timeoutMsg: "窄窗口下卡片操作菜单没有出现",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_PAUSE, "top");
    await clickTestIdByDom(TID_OFFPEAK_ACTION_PAUSE, {
      timeoutMsg: "卡片菜单没有 Pause 项",
    });
    await setCurrentElectronRendererContentSize(1440);
    await openOffPeakCardMenu({
      timeoutMsg: "Pause 后重新打开卡片菜单失败",
    });
    await waitForTestIdByDom(TID_OFFPEAK_ACTION_CONTINUE, {
      timeoutMsg: "Pause 后菜单没有出现 Continue，状态未切 paused",
    });

    // 6) 卡片主点击进入任务详情，History 可达且空态不保留创建 CTA。
    await browser.execute((cardTid) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid === cardTid,
      );
      card?.click();
    }, TID_OFFPEAK_CARD);
    await waitForTestIdByDom(TID_OFFPEAK_EDIT_VIEW, {
      timeoutMsg: "点击闲时任务卡片没有进入任务详情",
    });
    const editView = await browser.$(`[data-testid="${TID_OFFPEAK_EDIT_VIEW}"]`);
    const editViewButtons = await editView.$$("button");
    let historyButton: WebdriverIO.Element | undefined;
    for (const button of editViewButtons) {
      if (/History|历史/.test(await button.getText())) {
        historyButton = button;
        break;
      }
    }
    if (!historyButton) {
      throw new Error("任务详情里没有 History 入口");
    }
    // 修复原因：Radix tab 在 pointer/mouse down 阶段切换值，HTMLElement.click() 只派发
    // click 事件，旧 E2E 虽找到 History 按钮却没有真正切换 tab。
    await historyButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (viewTid, submitTid) => {
            const view = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (item) => item.dataset.testid === viewTid,
            );
            return !Array.from(view?.querySelectorAll<HTMLElement>("[data-testid]") ?? []).some(
              (item) => item.dataset.testid === submitTid,
            );
          },
          TID_OFFPEAK_EDIT_VIEW,
          TID_OFFPEAK_EDIT_SUBMIT,
        ),
      {
        timeout: 5000,
        timeoutMsg: "History 详情态仍显示创建或保存 CTA",
      },
    );
    // 详情页返回已迁到 Settings header breadcrumb。旧 case 点击编辑区的“第一个按钮”，
    // 会随 Settings/History 控件排序变成非返回动作，导致仍停留在详情页。
    await clickAutomationsBreadcrumbBack();
    await browser.waitUntil(
      async () => (await offPeakCardTitles()).some((t) => t.includes(title)),
      {
        timeout: 10000,
        timeoutMsg: "从闲时任务详情返回后列表没有恢复",
      },
    );

    // 7) Continue：点 Continue → 菜单重新出现 Pause（状态回 queued）。
    await openOffPeakCardMenu({
      timeoutMsg: "返回列表后重新打开卡片菜单失败",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_CONTINUE, "right");
    await clickTestIdByDom(TID_OFFPEAK_ACTION_CONTINUE, {
      timeoutMsg: "卡片菜单没有 Continue 项",
    });
    await openOffPeakCardMenu({
      timeoutMsg: "Continue 后重新打开卡片菜单失败",
    });
    await waitForTestIdByDom(TID_OFFPEAK_ACTION_PAUSE, {
      timeoutMsg: "Continue 后菜单没有回到 Pause，状态未回 queued",
    });

    // 8) 删除：菜单点删除 → 二次确认 → 卡片消失。
    await clickTestIdByDom(TID_OFFPEAK_ACTION_DELETE, {
      timeoutMsg: "卡片菜单没有删除项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await browser.waitUntil(
      async () => !(await offPeakCardTitles()).some((t) => t.includes(title)),
      { timeout: 15000, timeoutMsg: `删除后卡片仍然存在：${title}` },
    );
  });

  it("F-OFFPEAK-004：等待运行期间切换普通聊天计划不会重绑已保存闲时任务", async function () {
    this.timeout(150000);
    // 后续设置与文件夹具绑定默认项目，不能使用分配新虚拟目录的全局新建。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有 Automations 入口" });
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, { timeoutMsg: "闲时任务创建按钮没有出现" });
    await selectOffPeakReasoning();
    const title = `E2E_OFFPEAK_SWITCH_${Date.now()}`;
    await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, title);
    await setInputValueByTestIdDom(
      TID_OFFPEAK_FORM_INSTRUCTIONS,
      "等待期间切换普通聊天的模型连接，闲时任务仍使用创建时快照。",
    );
    await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, { timeoutMsg: "闲时任务提交按钮不可用" });

    const before = await waitForOffPeakModelSelection(title);
    expect(before.providerId).toContain("offpeak");
    // 后续设置与文件夹具绑定默认项目，不能使用分配新虚拟目录的全局新建。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    const after = await waitForOffPeakModelSelection(title);
    expect(after).toEqual(before);
    expect(await readOffPeakStatus(title)).toBe("queued");
  });
});

/** 当前产品把定时与闲时任务分 tab 展示，按本地化标签选中闲时 tab。 */
async function selectIdleTimeTab(): Promise<void> {
  const tabList = await browser.$(`[data-testid="${TID_OFFPEAK_TAB}"]`);
  const buttons = await tabList.$$("button");
  for (const button of buttons) {
    if (/Idle-time task|闲时任务/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("闲时任务列表没有闲时 tab");
}

async function seedCurrentAccount(): Promise<void> {
  // 网关 mock 只替代取号，不替代 Registry 的账号模型。使用隔离的账号控制面。
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
      await seedBigModelOAuthCredential();
    },
  });
}

async function selectOffPeakReasoning(): Promise<void> {
  await clickTestIdByWebDriver(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER);
  await clickTestIdByWebDriver(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, "high"));
}

/** Settings header 中的 Automations breadcrumb 是编辑详情返回列表的真实入口。 */
async function clickAutomationsBreadcrumbBack(): Promise<void> {
  const buttons = await browser.$$("nav[aria-label] button");
  for (const button of buttons) {
    if (/Automations|自动化/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("闲时任务详情没有返回 Automations 列表的 breadcrumb 入口");
}

/** 当前列表里所有闲时任务卡片文本（含标题）。 */
async function offPeakCardTitles(): Promise<string[]> {
  return browser.execute((cardTid) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((item) => item.dataset.testid === cardTid)
      .map((item) => item.textContent?.trim() ?? "");
  }, TID_OFFPEAK_CARD);
}

/** 桌面端卡片菜单仅在 hover 后显示；Radix trigger 还需要真实 pointerdown。 */
async function openOffPeakCardMenu({ timeoutMsg }: { timeoutMsg: string }): Promise<void> {
  const card = await browser.$(`[data-testid="${TID_OFFPEAK_CARD}"]`);
  const menu = await browser.$(`[data-testid="${TID_OFFPEAK_CARD_MENU}"]`);
  // 缩窗后列表容器会产生滚动。先将卡片滚回视区并在卡片上真实悬停；按钮的显示
  // 由 group-hover 的 CSS transition 驱动。Electron 41 缩窗后 ChromeDriver 的
  // waitForClickable 会把已可见、可用且位于 viewport 内的按钮误判为不可点击，
  // 因此按已核验的 DOM 交互前置条件直接发出真实 WebDriver click。
  await card.scrollIntoView();
  await card.moveTo();
  await browser.waitUntil(
    () =>
      browser
        .execute((menuTestId) => {
          const menu = document.querySelector<HTMLElement>(`[data-testid="${menuTestId}"]`);
          if (!(menu instanceof HTMLButtonElement)) return { present: false };
          const rect = menu.getBoundingClientRect();
          return {
            disabled: menu.disabled,
            opacity: getComputedStyle(menu).opacity,
            present: true,
            visible:
              rect.bottom > 0 &&
              rect.left > 0 &&
              rect.right < window.innerWidth &&
              rect.top < window.innerHeight,
          };
        }, TID_OFFPEAK_CARD_MENU)
        .then(
          (state) => state.present && !state.disabled && state.opacity === "1" && state.visible,
        ),
    { timeout: 5_000, timeoutMsg },
  );
  try {
    await menu.click();
  } catch (error) {
    const opened = await browser.execute((menuTestId) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${menuTestId}"]`);
      return trigger?.getAttribute("aria-expanded") === "true";
    }, TID_OFFPEAK_CARD_MENU);
    // Electron 41 + ChromeDriver 在 resize 后会出现“html 拦截 click”的误报，但同一条
    // 原生 pointer 链已经让 Radix trigger 进入 aria-expanded=true。只在菜单真实打开时
    // 继续，未打开仍保留原始异常，避免把真正的点击失败吞掉。
    if (!opened) throw error;
  }
}

/**
 * Pause / Continue 的信息图标嵌在可选择菜单项内：提示必须避开菜单，
 * 且点击图标只能查看说明，不能冒泡执行父级动作。
 */
async function assertMenuHintDoesNotSelectAction(
  actionTestId: string,
  expectedSide: "right" | "top",
): Promise<void> {
  const action = await browser.$(`[data-testid="${actionTestId}"]`);
  const hintTrigger = await action.$(":scope > span:last-child");
  await hintTrigger.moveTo();

  await browser.waitUntil(
    async () => {
      const tooltip = await browser.$('[role="tooltip"]');
      return tooltip.isDisplayed();
    },
    {
      timeout: 5000,
      timeoutMsg: `操作提示没有出现：${actionTestId}`,
    },
  );

  const geometry = await browser.execute(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    // Portal 会保留关闭中的 tooltip 节点；只能读取当前 open 节点，否则 data-side
    // 为空会把实际 right/top 布局误报为失败。
    const tooltip = Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).find(
      (item) => item.dataset.state !== "closed",
    );
    if (!menu || !tooltip) {
      return null;
    }
    const menuRect = menu.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    return {
      menuRight: menuRect.right,
      menuTop: menuRect.top,
      tooltipBottom: tooltipRect.bottom,
      tooltipLeft: tooltipRect.left,
      tooltipWidth: tooltipRect.width,
    };
  });

  expect(geometry).not.toBeNull();
  // Radix 的 data-side 是内部实现属性，并非页面对用户的承诺；实际几何关系才是
  // tooltip 避让菜单的行为契约。
  if (expectedSide === "right") {
    expect(geometry?.tooltipLeft ?? 0).toBeGreaterThanOrEqual(
      geometry?.menuRight ?? Number.POSITIVE_INFINITY,
    );
  } else {
    expect(geometry?.tooltipBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      geometry?.menuTop ?? 0,
    );
  }
  expect(geometry?.tooltipWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);

  await hintTrigger.click();
  await browser.waitUntil(
    async () => {
      const currentAction = await browser.$(`[data-testid="${actionTestId}"]`);
      return currentAction.isDisplayed();
    },
    {
      timeout: 2000,
      timeoutMsg: `点击信息图标错误触发了父级动作：${actionTestId}`,
    },
  );
}

async function waitForOffPeakModelSelection(title: string): Promise<{
  modelId: string;
  providerId: string;
}> {
  let selection: { modelId: string; providerId: string } | null = null;
  await browser.waitUntil(
    async () => {
      selection = readOffPeakModelSelection(title);
      return selection !== null;
    },
    { timeout: 30000, interval: 500, timeoutMsg: `闲时任务没有保存模型选择：${title}` },
  );
  if (!selection) throw new Error(`闲时任务模型选择为空：${title}`);
  return selection;
}

function readOffPeakModelSelection(title: string): { modelId: string; providerId: string } | null {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT model_selection FROM off_peak_tasks WHERE title = ?")
      .get(title) as { model_selection: string | null } | undefined;
    if (!row?.model_selection) return null;
    const parsed = JSON.parse(row.model_selection) as { modelId?: string; providerId?: string };
    return parsed.modelId && parsed.providerId
      ? { modelId: parsed.modelId, providerId: parsed.providerId }
      : null;
  } finally {
    database.close();
  }
}

function readOffPeakStatus(title: string): string | null {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT status FROM off_peak_tasks WHERE title = ?").get(title) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  } finally {
    database.close();
  }
}
