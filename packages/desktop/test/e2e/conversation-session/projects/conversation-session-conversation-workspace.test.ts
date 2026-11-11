import { access } from "node:fs/promises";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_CONVERSATION_SECTION,
  TID_PROJECT_SECTION,
  TID_V4_COMPOSER_INPUT,
  TID_VIRTUAL_PROJECT_ADD,
  TID_VIRTUAL_PROJECT_NEW_TASK,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_CONVERSATION_WORKSPACE,
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";

describe("非项目对话工作区 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("全新用户直接进入对话，并持久化任务/项目二级分区顺序", async function () {
    this.timeout(90000);

    await waitForWorkspaceApp(DEFAULT_CONVERSATION_WORKSPACE, 30000);
    await expectPathExists(DEFAULT_CONVERSATION_WORKSPACE, true);
    await expectPathExists(DEFAULT_WORKSPACE, false);

    const snapshot = await browser.execute(
      (testIds) => ({
        elements: Object.fromEntries(
          Object.entries(testIds).map(([key, testId]) => {
            const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
            return [
              key,
              element
                ? {
                    exists: true,
                    text: element.textContent?.trim() ?? "",
                    expanded:
                      element
                        .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
                        ?.getAttribute("aria-expanded") ?? null,
                  }
                : { exists: false, text: "", expanded: null },
            ];
          }),
        ),
        projectBeforeTask: (() => {
          const project = document.querySelector(`[data-testid="${testIds.projectSection}"]`);
          const conversation = document.querySelector(
            `[data-testid="${testIds.conversationSection}"]`,
          );
          return Boolean(
            project &&
            conversation &&
            project.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        })(),
        projectActionOutsideTrigger: (() => {
          const project = document.querySelector(`[data-testid="${testIds.projectSection}"]`);
          const trigger = project?.querySelector('[data-slot="collapsible-trigger"]');
          const action = project?.querySelector(`[data-testid="${testIds.projectAdd}"]`);
          return Boolean(trigger && action && !trigger.contains(action));
        })(),
        titlesAreDragTriggers: Object.values(testIds)
          .filter((testId) =>
            [testIds.projectSection, testIds.conversationSection].includes(testId),
          )
          .every((testId) => {
            const section = document.querySelector(`[data-testid="${testId}"]`);
            const trigger = section?.querySelector('[data-slot="collapsible-trigger"]');
            const dragHandle = section?.querySelector("[data-purpose-section-drag-trigger]");
            return Boolean(trigger && dragHandle && trigger === dragHandle);
          }),
      }),
      {
        composerInput: TID_V4_COMPOSER_INPUT,
        composerWorkspaceTrigger: TID_COMPOSER_WORKSPACE_TRIGGER,
        conversationSection: TID_CONVERSATION_SECTION,
        conversationNewTask: TID_VIRTUAL_PROJECT_NEW_TASK,
        projectSection: TID_PROJECT_SECTION,
        projectAdd: TID_VIRTUAL_PROJECT_ADD,
        projectDetach: TID_COMPOSER_PROJECT_DETACH,
      },
    );

    expect(snapshot.elements.composerInput?.exists).toBe(true);
    expect(snapshot.elements.composerWorkspaceTrigger?.exists).toBe(true);
    expect(snapshot.elements.conversationSection?.exists).toBe(true);
    expect(snapshot.elements.conversationSection?.expanded).toBe("true");
    expect(snapshot.elements.conversationNewTask?.exists).toBe(true);
    expect(snapshot.elements.projectSection?.exists).toBe(true);
    expect(snapshot.elements.projectSection?.expanded).toBe("true");
    expect(snapshot.elements.projectAdd?.exists).toBe(true);
    expect(snapshot.elements.projectDetach?.exists).toBe(false);
    expect(snapshot.projectBeforeTask).toBe(true);
    expect(snapshot.projectActionOutsideTrigger).toBe(true);
    expect(snapshot.titlesAreDragTriggers).toBe(true);

    await dragPurposeSectionOnto(TID_CONVERSATION_SECTION, TID_PROJECT_SECTION);
    await expectPurposeSectionOrder(TID_CONVERSATION_SECTION, TID_PROJECT_SECTION);

    const persistedOrder = await browser.execute(() => {
      const rawValue = window.localStorage.getItem("zcode-sidebar-purpose-section-preferences");
      if (!rawValue) {
        return null;
      }
      const parsed = JSON.parse(rawValue) as { sectionOrder?: unknown };
      return parsed.sectionOrder ?? null;
    });
    expect(persistedOrder).toEqual(["conversations", "projects"]);

    const projectToggle = await $(
      `[data-testid="${TID_PROJECT_SECTION}"] [data-slot="collapsible-trigger"]`,
    );
    const conversationToggle = await $(
      `[data-testid="${TID_CONVERSATION_SECTION}"] [data-slot="collapsible-trigger"]`,
    );
    await projectToggle.click();
    await expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    await expect(conversationToggle).toHaveAttribute("aria-expanded", "true");

    await browser.execute(() => window.location.reload());
    await waitForWorkspaceApp(DEFAULT_CONVERSATION_WORKSPACE, 30000);
    await expectPurposeSectionOrder(TID_CONVERSATION_SECTION, TID_PROJECT_SECTION);

    const restoredProjectToggle = await $(
      `[data-testid="${TID_PROJECT_SECTION}"] [data-slot="collapsible-trigger"]`,
    );
    const restoredConversationToggle = await $(
      `[data-testid="${TID_CONVERSATION_SECTION}"] [data-slot="collapsible-trigger"]`,
    );
    await expect(restoredProjectToggle).toHaveAttribute("aria-expanded", "false");
    await expect(restoredConversationToggle).toHaveAttribute("aria-expanded", "true");
    await restoredConversationToggle.click();
    await expect(restoredConversationToggle).toHaveAttribute("aria-expanded", "false");
    await expect(restoredProjectToggle).toHaveAttribute("aria-expanded", "false");

    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await browser.waitUntil(
      () =>
        browser.execute(
          (testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
          TID_COMPOSER_WORK_OUTSIDE_PROJECT,
        ),
      {
        timeout: 10000,
        timeoutMsg: "workspace 菜单没有显示“不在项目中工作”入口",
      },
    );
  });
});

async function dragPurposeSectionOnto(sourceTestId: string, targetTestId: string): Promise<void> {
  const positions = await browser.execute(
    (sourceId, targetId) => {
      const source = document.querySelector<HTMLElement>(`[data-testid="${sourceId}"]`);
      const target = document.querySelector<HTMLElement>(`[data-testid="${targetId}"]`);
      const dragHandle = source?.querySelector<HTMLElement>("[data-purpose-section-drag-trigger]");
      if (!dragHandle || !target) {
        return null;
      }

      const sourceRect = dragHandle.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        startX: Math.round(sourceRect.left + sourceRect.width / 2),
        startY: Math.round(sourceRect.top + sourceRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.top + targetRect.height / 2),
      };
    },
    sourceTestId,
    targetTestId,
  );
  if (!positions) {
    throw new Error("purpose section 拖拽元素不存在");
  }

  await browser.performActions([
    {
      id: "purpose-section-drag-pointer",
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
          y: positions.startY - 10,
        },
        { type: "pointerMove", duration: 260, x: positions.endX, y: positions.endY },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();

  // dnd-kit 会屏蔽拖拽后的紧随 click；先消耗该屏蔽，避免后续折叠按钮点击被吞。
  await browser.execute(() => {
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function expectPurposeSectionOrder(firstTestId: string, secondTestId: string): Promise<void> {
  let previousGeometry: string | null = null;
  let stablePolls = 0;
  await browser.waitUntil(
    async () => {
      const geometry = await browser.execute(
        (firstId, secondId) => {
          const first = document.querySelector(`[data-testid="${firstId}"]`);
          const second = document.querySelector(`[data-testid="${secondId}"]`);
          const firstRect = first?.getBoundingClientRect();
          const secondRect = second?.getBoundingClientRect();
          if (!first || !second || !firstRect || !secondRect) {
            return null;
          }
          return {
            ordered: Boolean(
              first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            firstTop: Math.round(firstRect.top),
            secondTop: Math.round(secondRect.top),
          };
        },
        firstTestId,
        secondTestId,
      );
      if (!geometry?.ordered || geometry.firstTop >= geometry.secondTop) {
        previousGeometry = null;
        stablePolls = 0;
        return false;
      }

      const nextGeometry = `${geometry.firstTop}:${geometry.secondTop}`;
      stablePolls = nextGeometry === previousGeometry ? stablePolls + 1 : 0;
      previousGeometry = nextGeometry;
      // 数据恢复和 dnd-kit 位移动画都会改变相邻分区坐标；连续稳定后再点击，避免命中正在交叉的另一行。
      return stablePolls >= 3;
    },
    { timeout: 10000, interval: 50, timeoutMsg: "purpose section 顺序没有按拖拽结果更新" },
  );
}

async function expectPathExists(path: string, expected: boolean): Promise<void> {
  let exists = true;
  try {
    await access(path);
  } catch {
    exists = false;
  }
  expect(exists).toBe(expected);
}
