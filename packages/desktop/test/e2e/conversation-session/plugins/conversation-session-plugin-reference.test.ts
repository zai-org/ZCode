// PLG01（wire 半区）+ PLG12/PLG15（商店试用）+ S01（plugins 分组半区）formal E2E：
// 1) @ 面板出现 plugins 分组候选，选中后 composer 插入 canonical `plugin://` markdown；
// 2) Plugin 商店详情页顶部 Try now 只预填 canonical 引用；示例提示词继续预填引用 + prompt；
//    两条入口都不自动发送；
// 3) 发送含 canonical Plugin 引用的消息后，provider 请求包含 identifiers-only 的
//    `plugin_reference` reminder（确定性 replay fixture 以 bodyIncludes "<plugin_reference>"
//    才放行主响应，并驱动一次 Read 测试工具调用），最终回复 marker 出现在时间线；
//    reminder 不出现在用户可见时间线，请求中不含路径/env 等禁injected 字段。
// 引用目标使用默认启用的官方纯内容插件 skill-creator（stable id 确定，无需安装步骤）。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickV4SlashOption,
  getV4ComposerText,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  clickPluginControl,
  openPluginCard,
  openPluginSettings,
} from "#e2e/helpers/plugin-management-lifecycle";

const PLUGIN_STABLE_ID = "skill-creator@zcode-plugins-official";
const STORE_TRY_PLUGIN_STABLE_ID = "zcode-guide@zcode-plugins-official";
const STORE_TRY_PLUGIN_ICON =
  "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png";
const PROMPT_MARKER = "E2E_PLUGIN_REFERENCE";
const REPLY_MARKER = "PLUGIN_REFERENCE_REPLY_OK";
const NOTE_RELATIVE_PATH = "plugin-reference-e2e/note.md";
const NOTE_BODY = "PLUGIN_REFERENCE_NOTE_BODY";
const SCREENSHOT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-reference");

// 截图只作为人工复盘 artifact，不作为通过判定（conversation-session-ui-testid-contract）。
async function captureEvidence(label: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await browser.saveScreenshot(join(SCREENSHOT_DIR, `${label}.png`));
}

async function readPluginMentionPresentation(pluginId: string): Promise<{
  found: boolean;
  iconSrc: string | null;
  label: string;
}> {
  return browser.execute(
    (inputTestId, mentionId) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const mention = Array.from(
        input?.querySelectorAll<HTMLElement>("[data-mention-category='plugins']") ?? [],
      ).find((element) => element.getAttribute("data-mention-id") === mentionId);
      // mention 的图标已改为 CSS 装饰，避免图标加载回调破坏 Lexical 选区。
      const image = mention?.style.getPropertyValue("--mention-image").trim();
      return {
        found: Boolean(mention),
        iconSrc: image?.startsWith("url(") ? (JSON.parse(image.slice(4, -1)) as string) : null,
        label: mention?.textContent ?? "",
      };
    },
    TID_V4_COMPOSER_INPUT,
    `plugin:${pluginId}`,
  );
}

// 走产品自身的 editor.focus()（和 Try now 的 requestFocus 同一条路径），
// 让原生 selection 按真实逻辑回灌，再发真实按键。
async function focusV4Composer(): Promise<void> {
  await browser.execute((inputTestId) => {
    const input = document.querySelector<
      HTMLElement & { __zcodeLexicalInputE2E?: { focus: () => void } }
    >(`[data-testid="${inputTestId}"]`);
    input?.__zcodeLexicalInputE2E?.focus();
  }, TID_V4_COMPOSER_INPUT);
}

describe("PLG plugin 引用：@ 面板 plugins 分组与 plugin_reference reminder", () => {
  beforeEach(async () => {
    // Try now 使用全局新建语义；下一场景重新回到文件夹具所在项目。
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("@ 面板展示 plugins 分组候选，选中后插入 canonical plugin:// markdown", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@zcode-guide", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
    const pluginOptionId = await waitForV4MentionOptionPrefix(
      `plugin:${STORE_TRY_PLUGIN_STABLE_ID}`,
      30000,
    );
    expect(pluginOptionId).toBe(`plugin:${STORE_TRY_PLUGIN_STABLE_ID}`);
    const pickerIcon = await browser.execute(
      (optionTestId) =>
        document
          .querySelector<HTMLElement>(`[data-testid="${optionTestId}"]`)
          ?.querySelector<HTMLImageElement>("img")?.src ?? null,
      testId(TID_PROMPT_SUGGESTION_OPTION, pluginOptionId),
    );
    expect(pickerIcon).toBe(STORE_TRY_PLUGIN_ICON);
    await captureEvidence("01-picker-plugins-group");

    expect(await clickV4SlashOption(pluginOptionId)).toBe(true);
    await browser.waitUntil(async () => ((await getV4ComposerText()) ?? "").includes("plugin://"), {
      timeout: 15000,
      timeoutMsg: "选中 plugin mention 后 composer 没有插入 canonical plugin:// markdown",
    });
    await browser.waitUntil(async () => !(await hasV4SlashPanel()), {
      timeout: 15000,
      timeoutMsg: "选中 plugin mention 后面板没有关闭",
    });
    expect(await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID)).toEqual({
      found: true,
      iconSrc: STORE_TRY_PLUGIN_ICON,
      label: "zcode-guide",
    });
    await captureEvidence("02-composer-plugin-chip");

    // 清空草稿，避免影响后续用例。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "v4 composer 输入框没有出现或不可输入",
    });
  });

  it("Plugin 商店顶部 Try now 只预填 canonical 引用且不自动发送", async () => {
    await openPluginSettings();
    await openPluginCard(STORE_TRY_PLUGIN_STABLE_ID);
    await captureEvidence("03-plugin-store-try-now-detail");
    await clickPluginControl("plugin-store-try-now", {
      pluginId: STORE_TRY_PLUGIN_STABLE_ID,
    });

    await waitForV4Pane(
      (state) => state.sessionId === "draft" && !state.canStop,
      "Plugin 商店 Try now 没有通过标准新建任务进入空闲草稿",
      30000,
    );
    await browser.waitUntil(
      async () =>
        ((await getV4ComposerText()) ?? "").includes(`plugin://${STORE_TRY_PLUGIN_STABLE_ID}`),
      {
        timeout: 30000,
        timeoutMsg: "Plugin 商店 Try now 没有预填 canonical Plugin 引用",
      },
    );
    const tryNowText = (await getV4ComposerText()) ?? "";
    for (const prompt of [
      "How do I configure MCP servers in ZCode?",
      "Diagnose my current ZCode setup",
      "ZCode 里怎么配置 MCP 服务器？",
      "帮我诊断当前的 ZCode 配置",
    ]) {
      expect(tryNowText).not.toContain(prompt);
    }
    const tryNowMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(tryNowMention.found).toBe(true);
    expect(tryNowMention.iconSrc).toBe(STORE_TRY_PLUGIN_ICON);
    expect(["ZCode Guide", "ZCode 使用指南"]).toContain(tryNowMention.label);
    await captureEvidence("04-plugin-store-try-now-draft");

    // 回归守卫：Try now 只预填引用、没有尾随文本时，光标会落在 mention token 内部，
    // 真实按一下空格会让 Lexical 按 token 语义整节点替换，引用直接消失（v3.7.1~v3.7.6）。
    // 这里必须走真实按键，jsdom 结构断言覆盖不到原生 selection 回灌这一环。
    await focusV4Composer();
    await browser.keys(" ");
    const afterSpaceMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(afterSpaceMention.found).toBe(true);
    expect((await getV4ComposerText()) ?? "").toContain(`plugin://${STORE_TRY_PLUGIN_STABLE_ID}`);
    await captureEvidence("04b-plugin-store-try-now-after-space");

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "Plugin 商店 Try now 后的 v4 composer 不可编辑",
    });
  });

  it("Plugin 商店示例提示词预填 canonical 引用与提示词但不自动发送", async () => {
    await openPluginSettings();
    await openPluginCard(STORE_TRY_PLUGIN_STABLE_ID);
    await clickPluginControl("plugin-store-example-prompt", {
      pluginId: STORE_TRY_PLUGIN_STABLE_ID,
    });

    await waitForV4Pane(
      (state) => state.sessionId === "draft" && !state.canStop,
      "Plugin 商店试用没有通过标准新建任务进入空闲草稿",
      30000,
    );
    await browser.waitUntil(
      async () => {
        const text = (await getV4ComposerText()) ?? "";
        return (
          text.includes(`plugin://${STORE_TRY_PLUGIN_STABLE_ID}`) &&
          [
            "How do I configure MCP servers in ZCode?",
            "Diagnose my current ZCode setup",
            "ZCode 里怎么配置 MCP 服务器？",
            "帮我诊断当前的 ZCode 配置",
          ].some((prompt) => text.includes(prompt))
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "Plugin 商店试用没有预填 canonical Plugin 引用与示例提示词",
      },
    );
    const storeMention = await readPluginMentionPresentation(STORE_TRY_PLUGIN_STABLE_ID);
    expect(storeMention.found).toBe(true);
    expect(storeMention.iconSrc).toBe(STORE_TRY_PLUGIN_ICON);
    expect(["ZCode Guide", "ZCode 使用指南"]).toContain(storeMention.label);
    await captureEvidence("03-plugin-store-try-draft");

    // 试用只预填，不自动发送；保持 draft 且手动清空，避免影响 wire 用例。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15000,
      timeoutMsg: "Plugin 商店试用后的 v4 composer 不可编辑",
    });
  });

  it("发送 canonical plugin 引用后 provider 收到 identifiers-only reminder 并驱动测试工具", async function () {
    this.timeout(240000);
    // Read 测试工具的目标文件（workspace 相对路径，遵守 e2e runtime 路径契约）。
    await mkdir(join(DEFAULT_WORKSPACE, "plugin-reference-e2e"), { recursive: true });
    await writeFile(join(DEFAULT_WORKSPACE, "plugin-reference-e2e", "note.md"), NOTE_BODY, "utf8");

    await sendV4Prompt(
      `${PROMPT_MARKER} read ${NOTE_RELATIVE_PATH} with [@skill-creator](plugin://${PLUGIN_STABLE_ID})`,
    );
    await waitForV4TimelineContaining(REPLY_MARKER, 60000);
    await waitForV4Pane(
      (state) => !state.canStop && state.sessionId !== "draft" && state.sessionId !== null,
      "plugin 引用回合没有回到空闲态",
      60000,
    );
    await captureEvidence("04-timeline-plugin-reference-reply");

    // wire 断言：主请求包含且仅包含一条 identifiers-only plugin_reference reminder。
    const capture = await waitForUpstreamNetworkCapture("<plugin_reference>");
    const serialized = JSON.stringify(capture.requestJson);
    expect(serialized).toContain(PLUGIN_STABLE_ID);
    expect((serialized.match(/<plugin_reference>/g) ?? []).length).toBe(1);
    // identifiers-only：禁injected 字段（路径、插件环境变量、rootPath 字段名）不得进入 provider 输入。
    expect(serialized).not.toContain("ZCODE_PLUGIN_ROOT");
    expect(serialized).not.toContain('"rootPath"');

    // reminder 是 model-only：用户可见时间线不得渲染 plugin_reference 标签。
    const timelineHasReminder = await browser.execute(() =>
      (document.body.textContent ?? "").includes("<plugin_reference>"),
    );
    expect(timelineHasReminder).toBe(false);
  });
});
