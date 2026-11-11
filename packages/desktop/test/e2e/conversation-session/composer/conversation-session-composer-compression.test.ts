import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import {
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_CHAT_MODEL_SELECT_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL } from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  loginWithApiKey,
  switchV4Model,
  switchV4Mode,
} from "#e2e/helpers/v4-conversation";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";

const CASE_NAME = "conversation-session-composer-compression";
const evidence = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);

async function snapshot() {
  return browser.execute((testId) => {
    const model = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    const root =
      model.closest<HTMLElement>("[data-composer-toolbar]") ??
      model.closest<HTMLElement>(".group\\/toolbar")!;
    if (!root) throw new Error("找不到真实 composer toolbar");
    const visible = (el: Element | null) =>
      Boolean(
        el &&
        el.getBoundingClientRect().width > 0 &&
        el.getBoundingClientRect().height > 0 &&
        getComputedStyle(el).visibility !== "hidden",
      );
    const controls = ["0", "1", "2", "3"].map((priority) =>
      root.querySelector<HTMLElement>(`[data-composer-collapse-priority="${priority}"]`),
    );
    // Think 已合并到模型按钮；绿条在该按钮内，不再有独立 Think 控件。
    const thought = model;
    const prefix = model.querySelector(".composer-provider-prefix");
    const bar = thought?.querySelector(".bg-success") ?? null;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const modelIcon = root.dataset.composerModelIcon === "true";
    const providerHidden = root.dataset.composerProviderCompact === "true";
    const compact = controls.map((el) => el?.dataset.composerCompact ?? "full");
    const stage = modelIcon
      ? 5
      : compact[3] === "true"
        ? 4
        : compact[2] === "true"
          ? 3
          : compact[1] === "true"
            ? 2
            : compact[0] === "true"
              ? 1
              : 0;
    return {
      stage,
      compact,
      providerHidden,
      modelIcon,
      prefix: prefix?.textContent ?? null,
      prefixVisible: visible(prefix),
      barVisible: visible(bar),
      bar: bar ? rect(bar) : null,
      track: bar?.parentElement ? rect(bar.parentElement) : null,
      label: model.querySelector("span[title]") ? rect(model.querySelector("span[title]")!) : null,
      modelText: model.querySelector("span[title] > span > span:last-child")
        ? rect(model.querySelector("span[title] > span > span:last-child")!)
        : null,
      providerText: prefix ? rect(prefix) : null,
      title: model.querySelector("[title]")?.getAttribute("title") ?? null,
      controls: controls.map((el) => (el ? rect(el) : null)),
      model: rect(model),
      root: rect(root),
      leading: rect(root.querySelector("[data-composer-leading-content]")!),
      trailing: rect(root.querySelector("[data-composer-trailing-actions]")!),
      text: model.innerText,
    };
  }, TID_CHAT_MODEL_SELECT_TRIGGER);
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function assertLayout(s: Snapshot) {
  const expected: string[] = [s.stage >= 1, s.stage >= 2, s.stage >= 3].map((compact) =>
    compact ? "true" : "full",
  );
  expected.push(s.stage >= 4 ? "true" : "full");
  assert.deepEqual(s.compact, expected, JSON.stringify(s));
  assert.equal(s.prefixVisible, false, JSON.stringify(s));
  assert.equal(s.barVisible, s.stage >= 4, JSON.stringify(s));
  for (const [i, control] of s.controls.entries()) {
    assert.ok(control, "桌面各入口必须真实存在");
    if (i < 3 && s.compact[i] === "true") {
      assert.ok(
        Math.abs(control.width - 28) < 1 && Math.abs(control.height - 28) < 1,
        JSON.stringify(s),
      );
    }
  }
  if (s.modelIcon)
    assert.equal(s.text.includes(UPSTREAM_SECONDARY_MODEL), false, "最后一档显示模型图标");
  else assert.ok(s.text.includes(UPSTREAM_SECONDARY_MODEL), "模型文字必须保留到最后一档");
  if (!s.modelIcon) {
    assert.ok(s.label && s.modelText, "展开态必须保留完整模型文字");
    assert.ok(
      s.modelText.x >= s.label.x - 1 && s.modelText.right <= s.label.right + 1,
      "模型文字不能横向截断",
    );
    assert.ok(
      s.modelText.y >= s.label.y - 2 && s.modelText.bottom <= s.label.bottom + 2,
      "模型文字不能落到第二行被裁掉",
    );
    if (s.prefixVisible)
      assert.ok(
        s.providerText && Math.abs(s.providerText.y - s.modelText.y) < 1,
        "provider 与 model 必须同一行",
      );
  }
  if (s.barVisible) {
    assert.ok(s.bar && s.track && s.bar.width > 0 && s.bar.height > 0);
    assert.ok(Math.abs(s.bar.height - s.track.height) < 1, "max 档绿条应占满轨道");
  }
  assert.ok(s.leading.right <= s.trailing.x + 1, "两组按钮不能相互覆盖");
  assert.ok(s.trailing.right <= s.root.right + 1, "发送区不能溢出");
  assert.ok(Math.abs(s.model.y - s.controls[3]!.y) < 2, "模型与 think 必须保持单行");
}

async function settledSnapshot() {
  // 等待 ResizeObserver 布局回写后的两次绘制，不直接设置压缩状态。
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  return snapshot();
}

describe("Composer 五档压缩", () => {
  before(async () => {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (login, settings) =>
            Boolean(
              document.querySelector(
                `[data-testid="${login}"], [data-testid="${settings}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_LOGIN_USE_API_KEY_BUTTON,
          TID_TASK_SETTINGS_BUTTON,
        ),
      { timeout: 30000 },
    );
    if (await $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`).isExisting())
      await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();
  });
  after(async () => {
    await clearAppData();
  });

  it("CMP01: 真实窗口逐档缩窄与放宽，合并模型入口按五档顺序压缩且绿条保留", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const paths = getE2EAppDataPaths();
        const settingsFile = join(paths.appDataDir, "setting.json");
        const settings = JSON.parse(await readFile(settingsFile, "utf8"));
        await writeFile(
          settingsFile,
          JSON.stringify({
            ...settings,
            computerUseComposerEntryHidden: false,
            locale: "zh-CN",
            localePreference: "zh-CN",
          }),
        );
        const configFile = join(paths.homeDir, ".zcode", "cli", "config.json");
        const config = JSON.parse(
          await readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "{}";
            throw error;
          }),
        );
        await mkdir(dirname(configFile), { recursive: true });
        await writeFile(
          configFile,
          JSON.stringify({
            ...config,
            plugins: {
              ...config.plugins,
              enabled: true,
              enabledPlugins: {
                ...config.plugins?.enabledPlugins,
                [ZCODE_CUA_OFFICIAL_PLUGIN_ID]: true,
              },
            },
          }),
        );
        const repo = new NodePersonalProviderConfigRepository({
          filePath: paths.configFile,
          pollingIntervalMs: false,
        });
        try {
          await repo.update((current) => ({
            ...current,
            providers: current.providers.setRule({
              ...current.providers.getRule(UPSTREAM_PROVIDER_ID)!,
              providerName: "E2E",
            }),
          }));
        } finally {
          repo.dispose();
        }
      },
    });
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    // 修复原因：CUA 入口要等 renderer 插件 store 初始化（plugin-management.listPlugins，
    // 冷启动实测 7s+，与官方插件 seed 同一条 agent 串行链）后才知道插件已启用。
    // 默认 5s 隐式等待在冷启动下不够，这里按真实耗时显式等待优先级 0 的控件。
    await $('[data-composer-collapse-priority="0"]').waitForDisplayed({
      timeout: 60000,
      timeoutMsg: "CUA 入口没有出现（插件 store 未就绪或插件未启用？）",
    });
    await switchV4Mode("plan");
    await $('[data-composer-collapse-priority="2"]').waitForDisplayed({ timeout: 30000 });
    await mkdir(evidence, { recursive: true });
    const original = await setCurrentElectronRendererContentSize(1600, 760);
    const minimum = await browser.electron.execute((electron, id) => {
      const win = electron.BrowserWindow.fromId(id)!;
      const min = win.getMinimumSize();
      win.setMinimumSize(320, 400);
      return min;
    }, original.windowId);
    const samples: { width: number; state: Snapshot }[] = [];
    const stages = new Map<number, number>();
    try {
      let previous = 0;
      for (let width = 1600; width >= 320; width -= 8) {
        await setCurrentElectronRendererContentSize(width, 760);
        const state = await settledSnapshot();
        samples.push({ width, state });
        assertLayout(state);
        assert.ok(state.stage >= previous, "缩窄时不能反向展开");
        previous = state.stage;
        if (!stages.has(state.stage)) {
          stages.set(state.stage, width);
          await browser.saveScreenshot(join(evidence, `stage-${state.stage}.png`));
        }
        if (state.stage === 5) break;
      }
      assert.deepEqual(
        [...stages.keys()],
        [0, 1, 2, 3, 4, 5],
        "必须观察到所有独立档位，不能只经过首尾状态",
      );
      for (const [stage, width] of [...stages.entries()].reverse()) {
        await setCurrentElectronRendererContentSize(width, 760);
        const state = await settledSnapshot();
        assertLayout(state);
        assert.equal(state.stage, stage, "相同宽度放宽必须恢复相同档位");
      }
    } finally {
      await writeFile(join(evidence, "compression.json"), JSON.stringify(samples, null, 2));
      await browser.electron.execute(
        (electron, id, min) => electron.BrowserWindow.fromId(id)?.setMinimumSize(min[0]!, min[1]!),
        original.windowId,
        minimum,
      );
      await restoreElectronRendererContentSize(original);
    }
  });
});
