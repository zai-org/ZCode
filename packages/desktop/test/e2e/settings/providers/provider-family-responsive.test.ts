import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  readSettings,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import { PROVIDER_RESPONSIVE_TEAM_NAME } from "#e2e/fixtures/provider-family-responsive";

const TEAM_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
const TEAM_SELECTION = {
  kind: "team-coding-plan",
  productId: "product-team-a",
  organizationId: "org-team-a",
  projectId: "proj-team-a",
};

async function captureEvidence(label: string) {
  const directory =
    process.env.ZCODE_E2E_ARTIFACT_DIR ||
    join(process.cwd(), ".e2e-artifacts", "provider-responsive");
  await mkdir(directory, { recursive: true });
  await browser.saveScreenshot(join(directory, `provider-responsive-${label}.png`));
}

async function visible(testID: string) {
  await browser.waitUntil(
    async () => {
      for (const element of await $$(sel(testID))) {
        if (await element.isDisplayed()) return true;
      }
      return false;
    },
    { timeout: 30000, timeoutMsg: `未显示 ${testID}` },
  );
  // 响应式导航有隐藏副本，必须操作真实可见元素。
  for (const element of await $$(sel(testID))) {
    if (await element.isDisplayed()) return element;
  }
  throw new Error(`可见元素已消失：${testID}`);
}

async function openProviderSettings() {
  await (await visible(TID_TASK_SETTINGS_BUTTON)).click();
  await (await visible(TID_SETTINGS_PAGE)).waitForDisplayed();
  await (await visible(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"))).click();
  // 当前家庭由隔离配置恢复；重新进入时不能再次点击导航，避免测试主动覆盖待验证的套餐选择。
  // 等待应用的真实刷新状态结束，避免初次加载替换选项节点而产生 stale element。
  await browser.waitUntil(
    async () =>
      (await $(`${sel(TID_SETTINGS_PAGE)} button[aria-busy]`).getAttribute("aria-busy")) ===
      "false",
    { timeout: 30000, timeoutMsg: "模型供应商初始刷新未结束" },
  );
}

async function setScenario(enabled: boolean) {
  const baseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL;
  assert.ok(baseUrl, "缺少套餐业务 mock 地址");
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "both", providerResponsive: enabled }),
  });
  assert.equal(response.status, 200);
}

describe("供应商真实应用响应式回归", () => {
  it("CTP-12: 长团队名宽窄布局、独立 Start 导航和团队选择持久化", async function () {
    this.timeout(180000);
    await setScenario(true);
    // 仅准备阶段重启以读取业务 fixture；后续持久化断言不回填或改写配置。
    await restartIntoWorkspacePreservingProfile();
    // 本例验证宽度断点；1000px 高度会被 Pro 屏幕工作区裁到 876px，阻断全部业务断言。
    const viewportHeight = 800;
    const originalSize = await setCurrentElectronRendererContentSize(1800, viewportHeight);
    try {
      await openProviderSettings();
      await (await visible(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER)).click();
      await (await visible(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, TEAM_KEY))).click();
      await browser.waitUntil(
        async () => {
          const selection = (await readSettings()).providerFamilyConnectionSelections?.bigmodel;
          return (
            selection?.kind === "team-coding-plan" &&
            selection.productId === TEAM_SELECTION.productId &&
            selection.organizationId === TEAM_SELECTION.organizationId &&
            selection.projectId === TEAM_SELECTION.projectId
          );
        },
        { timeout: 10000, timeoutMsg: "团队选择没有持久化" },
      );

      // Electron 窗口最小宽度为 480；手机尺寸组合另由组件浏览器测试覆盖。
      for (const width of [1800, 480]) {
        await setCurrentElectronRendererContentSize(width, viewportHeight);
        const trigger = await visible(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER);
        await expect(trigger).toHaveText(PROVIDER_RESPONSIVE_TEAM_NAME);
        await browser.execute(async () => {
          await document.fonts.ready;
        });
        const geometry = await browser.execute((triggerId) => {
          const trigger = [
            ...document.querySelectorAll<HTMLElement>(`[data-testid="${triggerId}"]`),
          ].find((node) => node.getBoundingClientRect().width > 0)!;
          const rect = trigger.getBoundingClientRect();
          const controls = trigger.parentElement!;
          const header = controls.parentElement!.parentElement!;
          const title = header.querySelector("h3")!.getBoundingClientRect();
          const value = trigger.querySelector('[data-slot="select-value"]')!
            .firstElementChild as HTMLElement;
          const arrow = trigger.querySelector("svg")!.getBoundingClientRect();
          return {
            viewport: innerWidth,
            pageWidth: document.documentElement.scrollWidth,
            left: rect.left,
            right: rect.right,
            panelRight: header.getBoundingClientRect().right,
            arrowLeft: arrow.left,
            arrowRight: arrow.right,
            textWidth: value.clientWidth,
            fullTextWidth: value.scrollWidth,
            overflow: getComputedStyle(value).textOverflow,
            sameRow: rect.top < title.bottom && rect.bottom > title.top,
          };
        }, TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER);
        console.log("E2E_PROVIDER_RESPONSIVE_GEOMETRY", width, JSON.stringify(geometry));
        await captureEvidence(String(width));
        assert.ok(geometry.right <= geometry.panelRight + 1, "选择框超出面板");
        assert.ok(geometry.pageWidth <= geometry.viewport, "页面横向溢出");
        assert.ok(
          geometry.arrowLeft >= geometry.left && geometry.arrowRight <= geometry.right,
          "箭头被裁切",
        );
        assert.equal(geometry.overflow, "ellipsis");
        if (width === 1800) {
          assert.ok(geometry.fullTextWidth <= geometry.textWidth + 1, "宽屏应优先显示全称");
          assert.ok(geometry.sameRow, "宽屏操作区不应整组换行");
        } else {
          assert.ok(
            geometry.fullTextWidth > geometry.textWidth + 1,
            "窄屏用例必须实际触发名称省略",
          );
        }
        assert.equal(await $(sel("model-provider-start-plan-switch-prefix")).isExisting(), false);
      }

      await setCurrentElectronRendererContentSize(1200, viewportHeight);
      // Start 已独立为导航项；旧快捷按钮已删除，浏览 Start 不应改写付费团队选择。
      await (
        await visible(
          testId(
            TID_MODEL_PROVIDER_NAV_ITEM,
            `coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
          ),
        )
      ).click();
      // 设置页第一个 h3 是侧栏分组标题，按详情标题定位，避免读到“智谱”。
      await expect($(sel(TID_SETTINGS_PAGE)).$("h3=Start Plan")).toBeDisplayed();
      expect(await $(sel(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER)).isExisting()).toBe(false);
      assert.deepEqual(
        (await readSettings()).providerFamilyConnectionSelections?.bigmodel,
        TEAM_SELECTION,
      );
      await captureEvidence("independent-start");
      await (await visible(TID_SETTINGS_BACK_BUTTON)).click();
      await openProviderSettings();
      await (
        await visible(
          testId(
            TID_MODEL_PROVIDER_NAV_ITEM,
            `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
          ),
        )
      ).click();
      await expect(await visible(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER)).toHaveText(
        PROVIDER_RESPONSIVE_TEAM_NAME,
      );
      assert.deepEqual(
        (await readSettings()).providerFamilyConnectionSelections?.bigmodel,
        TEAM_SELECTION,
      );
      const response = await fetch(
        `${process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL}/__e2e/coding-plan/requests`,
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { requests: Array<{ path: string }> };
      for (const path of [
        "/api/biz/customer/getCustomerInfo",
        "/api/biz/subscription/enterprise/v2/pricing",
        "/api/v1/zcode-plan/billing/balance",
      ]) {
        assert.ok(
          payload.requests.some((request) => request.path === path),
          `应用未请求 ${path}`,
        );
      }
      await captureEvidence("persisted-team");
    } finally {
      await restoreElectronRendererContentSize(originalSize);
      await setScenario(false);
    }
  });
});
