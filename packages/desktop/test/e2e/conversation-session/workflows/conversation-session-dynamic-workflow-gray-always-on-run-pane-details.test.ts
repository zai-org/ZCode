import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import type { ChainablePromiseElement } from "webdriverio";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  ensureUpstreamModelForE2E,
  getUpstreamProviderModelValues,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "#e2e/helpers/upstream-provider";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";

// run 侧板的细节与「配置」弹层（docs/dynamic-workflow/presentation.md「The run pane」「The run state
// the pane draws」「The settings popover」、docs/dynamic-workflow/launch.md「Changing a run's settings
// from the GUI」「Models the script names」、docs/dynamic-workflow/authoring.md「Choosing a model per
// subagent」）：
// 完成的 run 侧板写出结果、用量与每个子代理的模型；出错的 run 写出错误正文；在跑的 run 上用弹层
// 先就地调并发、再换子代理模型——后者是一次保留脚本的修订，侧板跟到新 run，新旧两端各自写出
// 「调整自」与「已被替代」。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用（主代理与子代理）；真实 Skill、编译、确认窗、模型解析、run 引擎、
// 子代理会话、GUI 配置命令、设置轮与通知仍走产品链路。长跑子代理的回答用受控流挂起，让 run 在配置
// 期间保持 running；旧 run 被替代时那条请求随之中止，不靠延时抢时序。
const RUN_DIGEST = '[data-workflow-run-digest="true"]';
const digestOf = (runId: string) => $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
const POPOVER = '[data-testid="workflow-run-settings-popover"]';
const SECONDARY_MODEL = UPSTREAM_SECONDARY_MODEL;
const SESSION_MODEL_WORD = "会话模型";
const LIVE_RUN_NAME = "E2E 长跑";

// 请求里最后一条 user 消息的文字（设置轮与通知并在同一条消息里送达）。
function lastUserMessageText(requestJson: unknown): string {
  const messages = (requestJson as { messages?: { role: string; content: unknown }[] } | undefined)
    ?.messages;
  const last = messages?.findLast((message) => message.role === "user");
  if (typeof last?.content === "string") return last.content;
  return ((last?.content as { text?: string }[] | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

function launchedRunId(content: string | undefined): string {
  const launched = /started in the background with ID: (\S+?)\./u.exec(content ?? "");
  expect(launched).not.toBeNull();
  return launched![1]!;
}

async function waitForToolSuccess(toolCallId: string): Promise<string> {
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === false,
    { timeout: 60000, timeoutMsg: `${toolCallId} 未执行成功` },
  );
  return launchedRunId((await getLatestUpstreamToolResultByToolCallId(toolCallId))?.content);
}

async function waitForTurnEnd(marker: string) {
  await waitForV4AssistantMessageContaining(marker, 120000);
  await waitForV4Pane((pane) => !pane.canStop, `${marker} 那一轮未结束`, 60000);
}

// 侧板根元素带 run id 与状态；Stop 钮总是画出，用它把侧板与聊天里的卡区分开。侧板可能同时挂着
// 几个 run 标签，只认当前可见的那一个。
async function visiblePaneRunId(): Promise<string | null> {
  return browser.execute(() => {
    for (const cancel of document.querySelectorAll<HTMLElement>(
      '[data-testid="workflow-run-cancel"]',
    )) {
      if (cancel.getClientRects().length === 0) continue;
      const pane = cancel.closest<HTMLElement>("[data-workflow-run-id]");
      if (pane) return pane.dataset.workflowRunId ?? null;
    }
    return null;
  });
}

const paneOf = (runId: string) =>
  $(`div[data-workflow-run-id="${runId}"]:has([data-testid="workflow-run-cancel"])`);

async function openPaneFromDigest(runId: string) {
  const digest = digestOf(runId);
  await digest.waitForExist({ timeout: 60000 });
  await digest.scrollIntoView({ block: "center" });
  await digest.$('[data-testid="workflow-card-open-details"]').click();
  await browser.waitUntil(async () => (await visiblePaneRunId()) === runId, {
    timeout: 30000,
    timeoutMsg: `run ${runId} 的侧板没有打开`,
  });
  return paneOf(runId);
}

// 折叠展开动画期间 getText 可能读到空串：一律读 textContent。
async function textOf(element: ChainablePromiseElement): Promise<string> {
  return String(await element.getProperty("textContent"));
}

async function openPhase(section: WebdriverIO.Element) {
  if ((await section.getAttribute("data-phase-open")) !== "true") {
    await section.$('[data-testid="workflow-run-phase-toggle"]').click();
  }
  await section.$('[data-testid="workflow-run-phase-body"]').waitForDisplayed({ timeout: 10000 });
}

// 设置轮在转写里留下一行「已调整设置 · …」（WorkflowSettingsChangeRow，没有 run id 属性）：按文字找。
// 已结束一轮的行收在「已处理」折叠里（默认收起）：没找到就展开所有收起的折叠，直到它出现。
async function waitForSettingsChangeRow(...needles: string[]) {
  await browser.waitUntil(
    async () =>
      browser.execute((wanted: string[]) => {
        const found = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="workflow-settings-change-row"]'),
        ).some((row) => wanted.every((needle) => (row.textContent ?? "").includes(needle)));
        if (found) return true;
        for (const trigger of document.querySelectorAll<HTMLElement>(
          '[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"]',
        )) {
          trigger.click();
        }
        return false;
      }, needles),
    { timeout: 30000, timeoutMsg: `转写里没有设置行：${needles.join(" · ")}` },
  );
}

async function consequenceText(): Promise<string> {
  return (await textOf($('[data-testid="workflow-run-settings-consequence"]'))).trim();
}

// 弹层的模型菜单与 composer 是同一个 ModelConfigSelect：宽屏下按 provider 分组（二级菜单），
// 也可能直接平铺模型项。两种形态都接得住，找不到时把菜单里出现过的项带进错误信息。
async function pickSettingsModel(modelId: string) {
  const itemIds = getUpstreamProviderModelValues(modelId).map((value) =>
    testId(TID_CHAT_MODEL_SELECT_ITEM, value),
  );
  const groupId = testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${UPSTREAM_PROVIDER_ID}`);
  await $('[data-testid="workflow-run-settings-model-trigger"]').click();
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (items: string[], group: string) => {
            const find = (id: string) =>
              document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(id)}"]`);
            if (items.some((id) => find(id) !== null)) return true;
            const groupElement = find(group);
            if (groupElement) {
              groupElement.focus();
              for (const name of ["pointerenter", "mouseenter", "mousemove"]) {
                groupElement.dispatchEvent(
                  new MouseEvent(name, { bubbles: true, cancelable: true, view: window }),
                );
              }
              groupElement.click();
            }
            return false;
          },
          itemIds,
          groupId,
        ),
      { timeout: 30000 },
    );
  } catch (error) {
    const seen = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
        .map((element) => element.dataset.testid ?? "")
        .filter((id) => id.startsWith("chat-model-select-")),
    );
    throw new Error(`配置弹层的模型菜单里没有 ${modelId}；菜单项：${JSON.stringify(seen)}`, {
      cause: error,
    });
  }
  await browser.execute((items: string[]) => {
    for (const id of items) {
      const element = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(id)}"]`);
      if (element) {
        element.click();
        return;
      }
    }
  }, itemIds);
}

describe("动态工作流 · run 侧板细节与配置弹层", () => {
  let okRunId = "";
  let failRunId = "";
  let liveRunId = "";
  let amendedRunId = "";

  before(async () => {
    await prepareV4ConversationE2E();
    // 弹层要换到第二个模型：给 E2E provider 加上录制时的第二个模型，再把 composer 选回会话模型。
    await ensureUpstreamModelForE2E(SECONDARY_MODEL);
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWR-04 完成的 run：侧板写出结果面板、用量行与 run 的子代理模型，点名模型的子代理行带自己的模型；完成的 run 不能配置", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWD_OK_START 用工作流核对材料并成文，子代理用 deepseek-v4-pro。");
    await approveV4Permission();
    okRunId = await waitForToolSuccess("toolu_dwd_create_ok");
    // 工具回话说出解析后的规范串：run 的 subagent_model 与脚本点名的模型（launch.md「Models the script names」）。
    const created = await getLatestUpstreamToolResultByToolCallId("toolu_dwd_create_ok");
    expect(created?.content).toContain(SECONDARY_MODEL);
    expect(created?.content).toContain("Models named in the script");

    await browser.waitUntil(
      async () =>
        (await digestOf(okRunId).isExisting()) &&
        (await digestOf(okRunId).getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "核对成文 run 没有跑到 completed" },
    );
    await waitForTurnEnd("E2E_DWD_OK_DONE");

    // 每个子代理真的跑在它的模型上：点名模型的核对员走自己的模型，撰写员跟随 run 的 subagent_model。
    const [checkRequest] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_DWD_TASK_CHECK"],
    });
    const [writeRequest] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_DWD_TASK_WRITE"],
    });
    expect((checkRequest?.requestJson as { model?: string } | undefined)?.model).toBe(
      "deepseek-v4-flash",
    );
    expect((writeRequest?.requestJson as { model?: string } | undefined)?.model).toBe(
      SECONDARY_MODEL,
    );

    const pane = await openPaneFromDigest(okRunId);
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("completed");

    // 结果面板：completed 写「结果」与「结果已作为后台结果送进会话」的提示。
    const result = pane.$('[data-testid="workflow-run-result"]');
    await result.waitForExist({ timeout: 30000 });
    expect(await textOf(result)).toContain("结果");
    expect(await textOf(result)).toContain("本实例已完成");
    await expect(pane.$('[data-testid="workflow-run-error"]')).not.toBeExisting();

    // 摘要行：模型是第一个词「子代理 {model}」，之后是子代理数、步数与 tokens。
    const usage = pane.$('[data-testid="workflow-run-usage"]');
    await browser.waitUntil(async () => /2\/2/u.test(await textOf(usage)), {
      timeout: 30000,
      timeoutMsg: "侧板摘要行没有写出 2/2 步",
    });
    const usageText = await textOf(usage);
    expect(usageText).toMatch(new RegExp(`^\\s*子代理 [^·]*${SECONDARY_MODEL}`, "u"));
    expect(usageText).toContain("tokens");
    // 模型段：屏幕上只有名字，规范串在 tooltip 里；完成的 run 不能配置，所以它只是字、不是按钮，
    // 状态头也没有 Configure。
    const modelSegment = pane.$('[data-testid="workflow-run-subagent-model"]');
    expect(await modelSegment.getTagName()).toBe("span");
    expect(await modelSegment.getAttribute("title")).toContain(`/${SECONDARY_MODEL}`);
    await expect(pane.$('[data-testid="workflow-run-configure"]')).not.toBeExisting();

    // 脊线：人设点名了模型的核对员，行尾跟着它的模型名；撰写员跑在 run 的模型上，行里不再说一遍。
    const sections = await pane.$$('[data-testid="workflow-run-phase"]');
    expect(sections).toHaveLength(2);
    for (const section of sections) await openPhase(section);
    const modelsByAgent: Record<string, string | null> = {};
    for (const pill of await pane.$$('[data-testid="workflow-agent-pill"]')) {
      const text = String(await pill.getProperty("textContent"));
      const name = ["核对员", "撰写员"].find((candidate) => text.includes(candidate));
      if (name === undefined) continue;
      const model = pill.$('[data-testid="workflow-run-agent-model"]');
      modelsByAgent[name] = (await model.isExisting())
        ? String(await model.getProperty("textContent"))
        : null;
    }
    expect(modelsByAgent["核对员"]).toContain("deepseek-v4-flash");
    expect(modelsByAgent["撰写员"]).toBeNull();
  });

  it("DWR-05 出错的 run：侧板写「实例出错」与脚本抛出的错误正文；出错的 run 可以配置，弹层的后果句是「重试」", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWD_FAIL_START 用工作流取证。");
    await approveV4Permission();
    failRunId = await waitForToolSuccess("toolu_dwd_create_fail");
    await browser.waitUntil(
      async () =>
        (await digestOf(failRunId).isExisting()) &&
        (await digestOf(failRunId).getAttribute("data-workflow-run-status")) === "errored",
      { timeout: 120000, timeoutMsg: "取证 run 没有到达 errored" },
    );
    await waitForTurnEnd("E2E_DWD_FAIL_DONE");

    const pane = await openPaneFromDigest(failRunId);
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("errored");
    // 错误面板：标题「实例出错」，正文是脚本抛出的那句话；没有「结果」面板。
    const errorPanel = pane.$('[data-testid="workflow-run-error"]');
    await errorPanel.waitForExist({ timeout: 30000 });
    expect(await textOf(errorPanel)).toContain("实例出错");
    expect(await textOf(pane.$('[data-testid="workflow-run-error-message"]'))).toContain(
      "E2E_DWD_FAIL_REASON 证据不足，无法继续",
    );
    await expect(pane.$('[data-testid="workflow-run-result"]')).not.toBeExisting();

    // 出错的 run 可以配置（launch.md「Which runs can be configured」）：弹层打开时两项都停在 run 的
    // 设置上，没有改动就没有后果句；拨一下步进器，后果句是出错状态那一句「重试」。不应用，Esc 关掉。
    await pane.$('[data-testid="workflow-run-configure"]').click();
    await $(POPOVER).waitForDisplayed({ timeout: 10000 });
    expect(await consequenceText()).toBe("");
    expect(await $('[data-testid="workflow-run-settings-apply"]').isEnabled()).toBe(false);
    await $('[data-testid="workflow-run-settings-bound-decrease"]').click();
    expect(await consequenceText()).toBe("将以新设置另起一次运行重试，已完成的步骤会保留。");
    await browser.keys("Escape");
    await $(POPOVER).waitForExist({ reverse: true, timeout: 10000 });
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("errored");
  });

  it("DWR-06 在跑的 run：弹层只调并发就地生效；换子代理模型是修订，侧板跟到新 run，新旧两端写出「调整自」与「已被替代」", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWD_LIVE_START 用工作流准备材料后长跑。");
    await approveV4Permission();
    liveRunId = await waitForToolSuccess("toolu_dwd_create_live");
    // 准备员做完，长跑员的回答被挂起：run 保持 running。
    await browser.waitUntil(
      async () =>
        (await digestOf(liveRunId)
          .$('[data-testid="workflow-agent-pill"][data-agent-status="done"]')
          .isExisting()) &&
        (await digestOf(liveRunId)
          .$('[data-testid="workflow-agent-pill"][data-agent-status="running"]')
          .isExisting()),
      { timeout: 60000, timeoutMsg: "准备员没有做完，或长跑员没有进入运行态" },
    );
    await waitForTurnEnd("E2E_DWD_LIVE_STARTED");

    const pane = await openPaneFromDigest(liveRunId);
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("running");
    // run 没有自己选模型：摘要行不写模型段。
    await expect(pane.$('[data-testid="workflow-run-subagent-model"]')).not.toBeExisting();

    // 1) 弹层从 run 的当前设置起步：模型是会话模型（带「会话模型」徽标），步进器停在默认并发 D 上。
    await pane.$('[data-testid="workflow-run-configure"]').click();
    const popover = $(POPOVER);
    await popover.waitForDisplayed({ timeout: 10000 });
    expect(await textOf(popover)).toContain("配置工作流");
    expect(await textOf($('[data-testid="workflow-run-settings-model-badge"]'))).toBe(
      SESSION_MODEL_WORD,
    );
    const boundInput = $('[data-testid="workflow-run-settings-bound-value"]');
    const defaultBound = Number(await boundInput.getValue());
    expect(defaultBound).toBeGreaterThan(0);
    expect(await textOf($('[data-testid="workflow-run-settings-bound"]'))).toContain("= 默认");
    expect(await consequenceText()).toBe("");
    expect(await $('[data-testid="workflow-run-settings-apply"]').isEnabled()).toBe(false);

    // 2) 只把上限调高一格：run 在跑，就地生效，不另起 run。
    await $('[data-testid="workflow-run-settings-bound-increase"]').click();
    await expect(boundInput).toHaveValue(String(defaultBound + 1));
    expect(await textOf($('[data-testid="workflow-run-settings-bound"]'))).toContain(
      `默认 ${defaultBound}`,
    );
    expect(await consequenceText()).toBe("立即应用到当前运行，不会新起一次运行。");
    await $('[data-testid="workflow-run-settings-apply"]').click();
    await popover.waitForExist({ reverse: true, timeout: 30000 });
    // 就地调并发：侧板仍是同一个 run，芯片读出新的界；设置轮的行点名同一个 run。
    const chip = pane.$('[data-testid="workflow-run-concurrency"]');
    await browser.waitUntil(
      async () =>
        (await chip.isExisting()) &&
        new RegExp(`^最大并发数 ${defaultBound + 1}\\b`, "u").test((await textOf(chip)).trim()),
      { timeout: 30000, timeoutMsg: `侧板没有出现「最大并发数 ${defaultBound + 1}」芯片` },
    );
    expect(await visiblePaneRunId()).toBe(liveRunId);
    // 就地生效的设置轮只有一行、没有卡（presentation.md「The run card」）。
    await waitForSettingsChangeRow("已调整设置", `最多 ${defaultBound + 1} 个同时运行`);
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("running");

    // 3) 再打开：步进器从 run 自己的界起步；换子代理模型 = 停掉当前 run、以新设置另起一次。
    await paneOf(liveRunId).$('[data-testid="workflow-run-configure"]').click();
    await popover.waitForDisplayed({ timeout: 10000 });
    await expect(boundInput).toHaveValue(String(defaultBound + 1));
    await pickSettingsModel(SECONDARY_MODEL);
    await browser.waitUntil(
      async () =>
        (await consequenceText()) === "将停止当前运行，以新设置另起一次运行，已完成的步骤会保留。",
      { timeout: 10000, timeoutMsg: "换模型后后果句不是「将停止当前运行……」" },
    );
    expect(await $('[data-testid="workflow-run-settings-model-badge"]').isExisting()).toBe(false);
    await $('[data-testid="workflow-run-settings-apply"]').click();
    await popover.waitForExist({ reverse: true, timeout: 30000 });

    // 4) 侧板跟着工作流走：同一个标签换成新 run（presentation.md「The settings popover」）。
    await browser.waitUntil(
      async () => {
        const visible = await visiblePaneRunId();
        return visible !== null && visible !== liveRunId;
      },
      { timeout: 30000, timeoutMsg: "接受修订后侧板没有换成新 run" },
    );
    amendedRunId = (await visiblePaneRunId())!;
    const amendedPane = paneOf(amendedRunId);
    // 修订的设置轮：一行说换了模型，下面挂新 run 的卡；旧卡变「工作流已被替代」。
    await waitForSettingsChangeRow("已调整设置", SECONDARY_MODEL);
    await digestOf(amendedRunId).waitForExist({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await digestOf(liveRunId).getAttribute("aria-label")) === "工作流已被替代",
      { timeout: 30000, timeoutMsg: "旧 run 卡没有变成「工作流已被替代」" },
    );
    expect(await textOf(amendedPane.$('[data-testid="workflow-run-amends"]'))).toContain(
      `调整自 run${liveRunId}`,
    );
    const provenance = amendedPane.$('[data-testid="workflow-run-provenance"]');
    await provenance.waitForExist({ timeout: 30000 });
    expect(await textOf(provenance)).toContain("由你调整设置");
    expect(await textOf(provenance)).toContain("子代理模型");
    await browser.waitUntil(
      async () =>
        new RegExp(`子代理 [^·]*${SECONDARY_MODEL}`, "u").test(
          await textOf(amendedPane.$('[data-testid="workflow-run-usage"]')),
        ),
      { timeout: 30000, timeoutMsg: "新 run 的摘要行没有写出新的子代理模型" },
    );

    // 新 run 重跑长跑员（新模型上的一次真实请求）并完成；准备员那一步作为缓存导入，不再发请求。
    await browser.waitUntil(
      async () => (await amendedPane.getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "修订出来的新 run 没有跑到 completed" },
    );
    const longRequest = (
      await getUpstreamRequestEvidence({ lastUserMessageIncludes: ["E2E_DWD_TASK_LONG"] })
    ).find((record) => record.fixtureId === "dwd-agent-long");
    expect((longRequest?.requestJson as { model?: string } | undefined)?.model).toBe(
      SECONDARY_MODEL,
    );
    expect(await countUpstreamRequests({ lastUserMessageIncludes: ["E2E_DWD_TASK_PREP"] })).toBe(1);

    // 5) 旧 run 的侧板：停在「已被替代」，lineage 行指向后继、可点；被替代的 run 不能再配置。
    await openPaneFromDigest(liveRunId);
    const oldPane = paneOf(liveRunId);
    expect(await oldPane.getAttribute("data-workflow-run-status")).toBe("stopped");
    const supersededBy = oldPane.$('[data-testid="workflow-run-superseded-by"]');
    await supersededBy.waitForExist({ timeout: 30000 });
    expect(await textOf(supersededBy)).toContain(`已被替代，后继 run${amendedRunId}`);
    await expect(oldPane.$('[data-testid="workflow-run-configure"]')).not.toBeExisting();
    await expect(oldPane.$('[data-testid="workflow-run-amends"]')).not.toBeExisting();
    await supersededBy.click();
    await browser.waitUntil(async () => (await visiblePaneRunId()) === amendedRunId, {
      timeout: 30000,
      timeoutMsg: "点「已被替代」没有打开后继 run 的侧板",
    });

    // 新 run 的完成通知唤醒主代理；被替代的旧 run 不单独通知。
    await waitForTurnEnd("E2E_DWD_LIVE_DONE");
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: ["<task-notification>", `<task-id>${liveRunId}</task-id>`],
      }),
    ).toBe(0);

    // 设置轮沿用 run 的名字（launch.md「The settings turn」）：模型读到的两句设置文字都写
    // 「run {A} ("{name}")」，新 run 的通知也以这个名字为题，而不是一串 run id。
    const [notified] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["<task-notification>", "<tool-use-id>settings-"],
    });
    expect(notified?.fixtureId).toBe("dwd-live-notified");
    const notifiedText = lastUserMessageText(notified?.requestJson);
    expect(notifiedText).toContain(
      `Changed the settings of workflow run ${liveRunId} ("${LIVE_RUN_NAME}") from the GUI: at most ${defaultBound + 1} of its subagents run at once.`,
    );
    expect(notifiedText).toContain(
      `Changed the settings of workflow run ${liveRunId} ("${LIVE_RUN_NAME}") from the GUI: its subagents now run on`,
    );
    expect(notifiedText).toContain(`<description>${LIVE_RUN_NAME}</description>`);
  });
});
