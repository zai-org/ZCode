// DMM-10：手机远控的新建草稿独立迁移，规格见 docs/chat/draft-model-migration.md。
// 手机经 attachment 读取 ClientConfig（本次放行的频道，同时覆盖 CCF-12），迁移标记与气泡
// 记录存在手机浏览器自己的 localStorage，作用域为 mobile:<device>，与桌面互不影响。
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  TID_CHAT_MODEL_GUIDE,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_COMPOSER,
} from "@zcode/shared/test-ids";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  pinE2ELocale,
  seedSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { e2eMobileBrowserLaunchOptions } from "#e2e/helpers/e2e-mobile-browser-executable";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const CASE_MARKER = "DMM-10";
// 与用户从官方模板创建时的默认 ID 相同；归属由 templateId 决定。
const OFFICIAL_PROVIDER_ID = "bigmodel-standard-api";
// 型号用中性名：测试会随开源导出，不能出现任何真实的待发布或迁移计划。
const SOURCE_MODEL = "e2e-dmm-model-a";
const TARGET_MODEL = "e2e-dmm-model-b";
// 较长的中文文案：390 宽的手机上必须换行，用来验证气泡不超出输入框、离屏幕边留出间距。
const NOTICE_ZH_CN =
  "E2E 手机文案：新建任务的默认模型已按服务端规则切换为 e2e-dmm-model-b，可在模型菜单中改回原来的模型。";
const NOTICE_KEY = "zcode-draft-model-migration-notice:v1";
const PROJECT_SELECTOR = '[data-testid="project-section"]';

type MobileWindow = Window & {
  __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(path: string): { draftProjectId?: string | null };
    };
  };
  __dmm10RestoreClipboard?: () => void;
};

/** 手机夹具的 relay 同时是控制面；规则经它的 client/configs 下发，不能另改 endpoint 打断配对认证。 */
async function setRelayClientConfigs(configs: Record<string, unknown>) {
  const relayUrl = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL?.trim();
  if (!relayUrl) throw new Error("手机 relay 夹具未启动，无法下发 client/configs");
  const response = await fetch(new URL("/__e2e/client-configs", relayUrl), {
    body: JSON.stringify({ configs }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`下发 client/configs 失败：status=${response.status}`);
}

describe("草稿模型迁移：手机远控", () => {
  after(async () => {
    await setRelayClientConfigs({}).catch(() => {});
    await clearAppData();
  });

  it("DMM-10：手机作用域独立迁移并弹一次气泡，经 attachment 读取规则", async () => {
    // Host 按刷新间隔缓存 client/configs；规则须在应用首次读取前就位。
    await setRelayClientConfigs({
      draftModelMigration: {
        revision: 1,
        targetModelId: TARGET_MODEL,
        sourceModelIds: [SOURCE_MODEL],
        notice: { "zh-CN": NOTICE_ZH_CN },
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    // 保留 profile 的重启也会保留 renderer 的语言偏好，须先同步为中文，避免它写回系统语言。
    await pinE2ELocale("zh-CN");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        // 手机应用优先读桌面语言；浏览器 locale=zh-CN 不能覆盖英文桌面设置。
        // 冷启动前落盘，避免运行中切换语言的异步持久化与手机读取设置竞争。
        await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
        await seedReplayProvider({
          id: OFFICIAL_PROVIDER_ID,
          templateId: OFFICIAL_PROVIDER_ID,
          name: "BigModel API",
          baseURL: "http://127.0.0.1:9/v1",
          models: [TARGET_MODEL, SOURCE_MODEL],
        });
      },
    });

    // 配对材料只经内存与 loopback 传递，不写 WebDriver 日志。
    let receivePair!: (url: string) => void;
    const pairing = new Promise<string>((resolve) => {
      receivePair = resolve;
    });
    const receiver = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method !== "OPTIONS") {
        let value = "";
        for await (const chunk of request) value += String(chunk);
        receivePair(value);
      }
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing pairing receiver");
    let mobile: Browser | undefined;
    let page: Page | undefined;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    try {
      await browser.execute((port) => {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        (window as MobileWindow).__dmm10RestoreClipboard = () => {
          navigator.clipboard.writeText = original;
        };
        navigator.clipboard.writeText = async (text) => {
          await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: text });
        };
      }, address.port);
      await $(
        'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
      ).click();
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="web-remote-control-dialog-scroll"] button',
              ),
            ).find(
              (node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 60_000, timeoutMsg: "DMM-10 配对链接不可用" },
      );
      const pairUrl = await pairing;
      if (new URL(pairUrl).hostname !== "127.0.0.1") throw new Error("Local Web fixture required");
      mobile = await chromium.launch({
        ...e2eMobileBrowserLaunchOptions(),
        headless: true,
        args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
      });
      const context = await mobile.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      page = await context.newPage();
      await openMobilePairingPage(page, pairUrl, {
        artifactDir,
        caseMarker: CASE_MARKER,
        phase: "pair",
        readySelector: PROJECT_SELECTOR,
      });

      // 进入项目新建草稿，从手机 store 读取作用域，构造“官方模板 + 源模型”的手机端 Recent。
      const openProjectDraft = async () => {
        await page!
          .locator(PROJECT_SELECTOR)
          .getByTestId("virtual-project-create-task")
          .first()
          .tap();
        await page!.locator('[data-mobile-page="chat"]').waitFor();
      };
      await openProjectDraft();
      // 等应用完成语言水合再种源模型，不能让“无匹配文案”掩盖气泡断言。
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
      const recentKey = await page.evaluate(() => {
        const target = window as MobileWindow;
        const path = target.__zcodeTabStoreE2E!.getState().activeWorkspacePath!;
        const projectId = target
          .__zcodeSessionStoreE2E!.getState()
          .getWorkspaceState(path).draftProjectId;
        // 手机命名空间来自配对参数；从已有键里取，避免测试侧复算设备身份。
        const existing = Object.keys(localStorage).find((key) =>
          key.startsWith("zcode-composer-workspace-scope:v1:"),
        );
        const scope = existing
          ? (JSON.parse(localStorage.getItem(existing)!) as {
              clientNamespace: string;
              hostId: string;
            })
          : null;
        if (!scope?.clientNamespace.startsWith("mobile:")) {
          throw new Error(`手机草稿作用域未就绪: ${existing ?? "none"}`);
        }
        return `zcode-composer-recent:v2:${JSON.stringify([scope.clientNamespace, scope.hostId, projectId ?? null])}`;
      });
      await page.evaluate(
        ({ key, providerId, modelId }) =>
          localStorage.setItem(
            key,
            JSON.stringify({
              modelSelection: { providerId, modelId, options: { reasoningLevel: "disabled" } },
              mode: "build",
              order: 1,
            }),
          ),
        { key: recentKey, providerId: OFFICIAL_PROVIDER_ID, modelId: SOURCE_MODEL },
      );
      // 返回首页再新建，让本次打开从上面写入的 Recent 初始化。
      await page.getByRole("button", { name: /返回任务首页|Back to task home/ }).tap();
      await openProjectDraft();

      const expectedValue = encodeCustomModelValue(OFFICIAL_PROVIDER_ID, TARGET_MODEL);
      const trigger = page.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).first();
      await page.waitForFunction(
        ({ selector, value }) =>
          document.querySelector<HTMLElement>(selector)?.dataset.modelCurrentValue === value,
        { selector: `[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`, value: expectedValue },
        { timeout: 30_000 },
      );
      expect(await trigger.getAttribute("data-model-current-value")).toBe(expectedValue);
      // Radix Tooltip 另渲染一份 VisuallyHidden 副本（role=tooltip，1px 裁剪）供 aria-describedby 使用，
      // Playwright 仍视其为可见；按浮层结构只取真正显示的那份气泡。
      const guide = page.locator(
        `[data-slot="tooltip-content"] [data-testid="${TID_CHAT_MODEL_GUIDE}"]:not([role="tooltip"] *)`,
      );
      await guide.waitFor({ timeout: 15_000 });
      expect((await guide.innerText()).trim()).toBe(NOTICE_ZH_CN);
      await page.screenshot({ path: join(artifactDir, "dmm-10-mobile-guide.png") });
      // 布局：不超出输入框、离屏幕边至少 8px，长文案换行。
      const layout = await page.evaluate(
        ({ guideTestId, triggerTestId, composerTestId }) => {
          const guideElement = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${guideTestId}"]`),
          ).find((element) => !element.closest('[role="tooltip"]'));
          const bubble = guideElement?.closest<HTMLElement>('[data-slot="tooltip-content"]');
          const trigger = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${triggerTestId}"]`),
          ).find((element) => element.getClientRects().length > 0);
          const composer = trigger?.closest<HTMLElement>(`[data-testid="${composerTestId}"]`);
          const text = guideElement?.firstElementChild as HTMLElement | null | undefined;
          if (!bubble || !trigger || !composer || !text) return null;
          return {
            bubble: bubble.getBoundingClientRect().toJSON() as DOMRect,
            trigger: trigger.getBoundingClientRect().toJSON() as DOMRect,
            composer: composer.getBoundingClientRect().toJSON() as DOMRect,
            textHeight: text.getBoundingClientRect().height,
            // line-height 为 normal 时按字号 1.2 倍估算单行高度。
            lineHeight:
              Number.parseFloat(getComputedStyle(text).lineHeight) ||
              Number.parseFloat(getComputedStyle(text).fontSize) * 1.2,
            viewport: window.innerWidth,
          };
        },
        {
          guideTestId: TID_CHAT_MODEL_GUIDE,
          triggerTestId: TID_CHAT_MODEL_SELECT_TRIGGER,
          composerTestId: TID_V4_COMPOSER,
        },
      );
      if (!layout) throw new Error("没有找到气泡、模型按钮或输入框");
      console.log(`[DMM-10] 气泡布局 ${JSON.stringify(layout)}`);
      // 手机上按钮左侧放不下整行气泡，碰撞处理会向右平移；要求是不超出输入框、不贴屏幕边。
      expect(layout.bubble.right).toBeLessThanOrEqual(layout.composer.right + 0.5);
      expect(layout.bubble.left).toBeGreaterThanOrEqual(layout.composer.left - 0.5);
      expect(layout.bubble.left).toBeGreaterThanOrEqual(8 - 0.5);
      expect(layout.bubble.right).toBeLessThanOrEqual(layout.viewport - 8 + 0.5);
      if (layout.textHeight < layout.lineHeight * 2 - 1)
        throw new Error(`手机长文案没有换行: ${JSON.stringify(layout)}`);
      expect(
        JSON.parse((await page.evaluate((key) => localStorage.getItem(key), NOTICE_KEY))!),
      ).toEqual({ revision: 1 });
      const migratedRecent = JSON.parse(
        (await page.evaluate((key) => localStorage.getItem(key), recentKey))!,
      ) as { modelSelection: { modelId: string }; mode: string };
      expect(migratedRecent.modelSelection.modelId).toBe(TARGET_MODEL);
      expect(migratedRecent.mode).toBe("build");

      // 手机迁移不写桌面：桌面浏览器存储里没有手机作用域的迁移标记与气泡记录。
      const desktopNotice = await browser.execute(
        (key) => window.localStorage.getItem(key),
        NOTICE_KEY,
      );
      expect(desktopNotice).toBeNull();
    } finally {
      await browser
        .execute(() => (window as MobileWindow).__dmm10RestoreClipboard?.())
        .catch(() => {});
      await page?.close().catch(() => {});
      await mobile?.close().catch(() => {});
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});
