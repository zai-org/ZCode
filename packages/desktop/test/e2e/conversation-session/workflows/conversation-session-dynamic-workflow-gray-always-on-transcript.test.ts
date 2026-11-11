import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  loginWithApiKey,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";

// 脚本 transcript（docs/dynamic-workflow/transcript-and-notifications.md「The script transcript」
// 「The epilogue fold」、docs/dynamic-workflow/authoring.md「Running commands: `world.run`」
// 「Progress: `log` and `report`」）：
// 第一阶段「检查」跑四条确定性的 `node -e` 命令——成功带 stdout、非零退出带 stderr、260 行长输出
// （正文按 200 行截）、`output: { tail: 16 }` 只留尾巴——前后各一条 `log`；第二阶段一个子代理复核。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用；命令由真实 run 引擎执行并写 journal，面板读的是真实的两条 journal 查询。
// 复核员的回答用受控流挂起：run 停在第二阶段时断言面板的运行态，再释放，不靠延时抢时序。
const RUN_NAME = "E2E 检查命令";
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const HELD_AGENT_FIXTURE = "dwt-agent";
const OK_STDOUT = "E2E_DWT_OK_1\nE2E_DWT_OK_2\nE2E_DWT_OK_3\nE2E_DWT_OK_4\n";
// 卡片按 argv 展示命令行：带空格或引号的实参用 JSON 字符串加引号（formatCommandLine）。
const COMMANDS = [
  `node -e "console.log('E2E_DWT_OK_1');console.log('E2E_DWT_OK_2');console.log('E2E_DWT_OK_3');console.log('E2E_DWT_OK_4')"`,
  `node -e "console.error('Error: E2E_DWT_BAD config missing');process.exit(3)"`,
  `node -e "for(let i=1;i<=260;i++)console.log('E2E_DWT_LONG_'+i)"`,
  `node -e "process.stdout.write('E2E_DWT_HEAD_'.repeat(20)+'E2E_DWT_TAIL_END')"`,
];

interface ScriptCard {
  key: string | null;
  status: string | null;
  open: boolean;
  firstLine: string;
  command: string;
  statusWord: string;
  statusFailed: boolean;
  statusTitle: string | null;
  result: string;
  peek: { text: string; error: boolean }[];
}

let sessionId = "";
let runId = "";
let cardsBeforeReload: ScriptCard[] = [];

function paneSelector() {
  return `[data-testid="workflow-workspace-pane"][data-workflow-run-id="${runId}"]`;
}

/** 读出面板里每张卡的可见素材（用 textContent：到场动画期间 getText 可能是空串）。 */
function readScriptCards(): Promise<ScriptCard[]> {
  return browser.execute((selector: string) => {
    const pane = document.querySelector<HTMLElement>(selector);
    if (!pane) return [];
    const text = (element: Element | null | undefined) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    return Array.from(
      pane.querySelectorAll<HTMLElement>('[data-testid="workflow-workspace-card"]'),
    ).map((card) => {
      const status = card.querySelector<HTMLElement>('[data-testid="workflow-workspace-status"]');
      const peek = card.querySelector<HTMLElement>('[data-testid="workflow-workspace-peek"]');
      return {
        key: card.dataset.cardKey ?? null,
        status: card.dataset.status ?? null,
        open: card.dataset.open === "true",
        // 中间一列的第一行：动词 + 命令行。
        firstLine: text(card.children[1]?.firstElementChild),
        command: card.querySelector("code")?.textContent ?? "",
        statusWord: text(status),
        statusFailed: status?.dataset.failed === "true",
        statusTitle: status?.getAttribute("title") ?? null,
        result: text(card.querySelector('[data-testid="workflow-workspace-result"]')),
        peek: Array.from(peek?.children ?? []).map((line) => ({
          text: line.textContent ?? "",
          error: line.classList.contains("text-destructive"),
        })),
      };
    });
  }, paneSelector());
}

/** 等四张卡都画出、收起的卡 peek 都取回（peek 在卡滚进视口时才取正文；展开的卡没有 peek）。 */
async function waitForSettledCards(timeoutMsg: string): Promise<ScriptCard[]> {
  let cards: ScriptCard[] = [];
  await browser.waitUntil(
    async () => {
      cards = await readScriptCards();
      return (
        cards.length === 4 &&
        cards.every((card) => card.status === "completed" && (card.open || card.peek.length > 0))
      );
    },
    { timeout: 60000, timeoutMsg: `${timeoutMsg}；最后一次读到 ${JSON.stringify(cards)}` },
  );
  return cards;
}

/** 点卡的结果行切换展开：卡的正中可能落在 peek 上，而 peek 里的点击不折叠（文档「Cards」）。 */
async function toggleCard(index: number) {
  const card = (await $(paneSelector()).$$('[data-testid="workflow-workspace-card"]'))[index]!;
  await card.$('[data-testid="workflow-workspace-result"]').click();
  return card;
}

/** 展开的卡：等正文取回（页脚出现），读出正文、stderr 段、页脚与截断说明。 */
async function readCardBody(index: number) {
  let body: {
    text: string;
    stdout: string;
    stderr: string | null;
    footer: string;
    note: string | null;
  } | null = null;
  await browser.waitUntil(
    async () => {
      body = await browser.execute(
        (selector: string, position: number) => {
          const card = document.querySelectorAll(
            `${selector} [data-testid="workflow-workspace-card"]`,
          )[position];
          const root = card?.querySelector('[data-testid="workflow-workspace-card-body"]');
          const footer = root?.querySelector('[data-testid="workflow-workspace-card-footer"]');
          if (!root || !footer) return null;
          // 正文的 stdout 是命令行之后、stderr 段之外的第一个 <pre>。
          const stdout = Array.from(root.querySelectorAll("pre")).find(
            (pre) =>
              !pre.closest('[data-testid="workflow-workspace-stderr"]') &&
              pre.previousElementSibling?.textContent !== "$",
          );
          const stderr = root.querySelector('[data-testid="workflow-workspace-stderr"] pre');
          return {
            text: root.textContent ?? "",
            stdout: stdout?.textContent ?? "",
            stderr: stderr?.textContent ?? null,
            footer: (footer.textContent ?? "").replace(/\s+/g, " ").trim(),
            note: footer.querySelector("p")?.textContent ?? null,
          };
        },
        paneSelector(),
        index,
      );
      return body !== null;
    },
    { timeout: 30000, timeoutMsg: `第 ${index + 1} 张卡的正文没有取回` },
  );
  return body!;
}

/** 从 run 卡的「检查」站点开脚本 transcript（药丸的无障碍名是「打开 {phase} 处的脚本步骤」）。 */
async function openScriptTranscript() {
  const pill = await $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`).$(
    'button[data-testid="workflow-agent-pill"][aria-label="打开 检查 处的脚本步骤"]',
  );
  await pill.waitForClickable({ timeout: 60000 });
  await pill.click();
  await $(paneSelector()).waitForDisplayed({ timeout: 30000 });
}

/** renderer 重载：Host 与 CLI 不动，只换一份新的 renderer（取正文的缓存随之清空）。 */
async function reloadRenderer() {
  await browser.refresh();
  const login = $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`);
  const task = $(`[data-testid="${testId(TID_TASK_ITEM, sessionId)}"]`);
  await browser.waitUntil(async () => (await login.isDisplayed()) || (await task.isExisting()), {
    timeout: 60000,
    timeoutMsg: "renderer 重载后既没有登录页也没有任务项",
  });
  if (await login.isDisplayed()) await loginWithApiKey();
  // 语言固定只在内存里；新 renderer 要重新固定。
  await pinE2ELocale("zh-CN");
  if ((await getV4PaneSnapshot()).sessionId !== sessionId) {
    await selectV4TaskById(sessionId, 60000);
  }
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `没有重新打开会话 ${sessionId}`,
    60000,
  );
}

describe("动态工作流 · 脚本 transcript", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWT-01 从「检查」站的脚本药丸打开 tab：表头写 run 名与运行中，一章四张命令卡按执行顺序，log 不成卡；成功卡 peek 末三行、展开有 $ 命令行与 Copy；失败卡退出码 3 标红、stderr 单独成段", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWT_START 用工作流跑几条检查命令，再让子代理复核。");
    await waitForV4PermissionDialog();
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwt_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dwt_create");
    const launched = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "");
    expect(launched).not.toBeNull();
    runId = launched![1]!;
    await waitForV4AssistantMessageContaining("E2E_DWT_STARTED", 60000);
    sessionId = (await getV4PaneSnapshot()).sessionId ?? "";
    expect(sessionId).not.toBe("draft");

    // run 停在第二阶段：复核员的回答被挂起，四条命令已经跑完。
    const digest = await $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
    await digest.waitForDisplayed({ timeout: 120000 });
    await browser.waitUntil(
      async () =>
        (await digest.$$('[data-testid="workflow-agent-pill"][data-agent-status="running"]')
          .length) === 1,
      { timeout: 120000, timeoutMsg: "复核员没有进入运行态" },
    );

    await openScriptTranscript();
    const pane = $(paneSelector());
    await expect(pane.$('[data-testid="workflow-workspace-title"]')).toHaveText(RUN_NAME);
    await expect(pane.$('[data-testid="workflow-workspace-run-status"]')).toHaveText("运行中");

    const cards = await waitForSettledCards("面板没有画出四张已结束的命令卡");
    // 一张卡对应一次 world.run，按准入顺序；`log` 没有站点、不进 journal，不成卡。
    expect(cards.map((card) => card.command)).toEqual(COMMANDS);
    for (const card of cards) {
      expect(card.firstLine.startsWith("已执行")).toBe(true);
      expect(card.firstLine).not.toContain("E2E_DWT_LOG");
    }
    // 章：同一阶段的连续卡成一章，章头是阶段名与「4 步」；表头第二行数阶段、步数与时长。
    const chapters = await pane.$$('[data-testid="workflow-workspace-chapter"]');
    expect(chapters).toHaveLength(1);
    const chapterText = await chapters[0]!.getText();
    expect(chapterText).toContain("检查");
    expect(chapterText).toContain("4 步");
    const summary = await pane.$('[data-testid="workflow-workspace-summary"]').getText();
    expect(summary).toContain("1 个阶段");
    expect(summary).toContain("4 步");

    // 成功卡：退出码 0 绿色；收起时 peek 是 stdout 的最后三行非空行。
    const [ok, bad] = cards;
    expect(ok!.statusWord).toBe("退出码 0");
    expect(ok!.statusFailed).toBe(false);
    expect(ok!.peek.map((line) => line.text)).toEqual([
      "E2E_DWT_OK_2",
      "E2E_DWT_OK_3",
      "E2E_DWT_OK_4",
    ]);
    // 失败卡：非零退出是值，状态词「退出码 3」标红，悬停给命令行；stdout 为空时 peek 取 stderr，
    // 像错误的行标红。结果行的字节数是 stdout 的 0 B。
    expect(bad!.statusWord).toBe("退出码 3");
    expect(bad!.statusFailed).toBe(true);
    expect(bad!.statusTitle).toBe(COMMANDS[1]);
    expect(bad!.result).toContain("0 B");
    expect(bad!.peek).toEqual([{ text: "Error: E2E_DWT_BAD config missing", error: true }]);

    // 展开成功卡：`$ 命令行`、stdout、页脚「退出码 0」与 Copy；没有 stderr 段与截断说明。
    await toggleCard(0);
    const okBody = await readCardBody(0);
    expect(okBody.text).toContain(`$${COMMANDS[0]}`);
    expect(okBody.stdout).toBe(OK_STDOUT);
    expect(okBody.stderr).toBeNull();
    expect(okBody.footer).toContain("退出码 0");
    expect(okBody.note).toBeNull();
    // 展开后 peek 让位给正文。
    expect((await readScriptCards())[0]!.peek).toEqual([]);
    // Copy 复制 stdout；正文里的点击不折叠卡。
    await browser.electron.execute((electron) => electron.clipboard.clear());
    const copy = (await pane.$$('[data-testid="workflow-workspace-card"]'))[0]!.$(
      '[data-testid="workflow-workspace-copy"]',
    );
    await copy.click();
    // 「已复制」只停 1.5 s：先等它，再核对剪贴板。
    await expect(copy).toHaveText(expect.stringContaining("已复制"));
    // 失败原因：Windows 系统剪贴板把纯文本的 LF 存成 CRLF，读回来是 `\r\n`；应用写入的
    // 仍是 stdout 原文。按 LF 归一后再比，断言的仍是“复制的是 stdout 原文”。
    let clipboardText = "";
    await browser
      .waitUntil(
        async () => {
          clipboardText = await browser.electron.execute((electron) =>
            electron.clipboard.readText(),
          );
          return clipboardText.replaceAll("\r\n", "\n") === OK_STDOUT;
        },
        { timeout: 10000, timeoutMsg: "Copy 没有把 stdout 写进剪贴板" },
      )
      .catch((error: unknown) => {
        throw new Error(`Copy 没有把 stdout 写进剪贴板: ${JSON.stringify(clipboardText)}`, {
          cause: error,
        });
      });
    expect((await readScriptCards())[0]!.open).toBe(true);

    // 展开失败卡：没有 stdout 时不写「没有输出」，stderr 在单独的一段里；页脚「退出码 3」。
    await toggleCard(1);
    const badBody = await readCardBody(1);
    expect(badBody.text).toContain(`$${COMMANDS[1]}`);
    expect(badBody.stderr).toBe("Error: E2E_DWT_BAD config missing\n");
    expect(badBody.text).not.toContain("没有输出");
    expect(badBody.footer).toContain("退出码 3");
  });

  it("DWT-02 长输出：peek 是最后三行，展开只画前 200 行并写截断说明；tail 模式的卡写的是保留下来的 16 B，正文只有尾巴", async function () {
    this.timeout(120000);
    if (!runId) throw new Error("DWT-01 没有留下 run");
    const cards = await readScriptCards();
    const [, , long, tail] = cards;

    // 260 行 stdout：peek 取最后三行非空行；结果行写 stdout 的字节数（4312 B）。
    expect(long!.statusWord).toBe("退出码 0");
    expect(long!.peek.map((line) => line.text)).toEqual([
      "E2E_DWT_LONG_258",
      "E2E_DWT_LONG_259",
      "E2E_DWT_LONG_260",
    ]);
    expect(long!.result).toContain("4.2 KB");
    await toggleCard(2);
    const longBody = await readCardBody(2);
    const shown = longBody.stdout.split("\n");
    expect(shown).toHaveLength(200);
    expect(shown[0]).toBe("E2E_DWT_LONG_1");
    expect(shown[199]).toBe("E2E_DWT_LONG_200");
    expect(longBody.stdout).not.toContain("E2E_DWT_LONG_201");
    expect(longBody.note).toMatch(
      /^只显示前 200 行（共 [\d.]+ (B|KB)）；完整结果仍在 journal 里。$/,
    );

    // `output: { tail: 16 }`：进程打印 276 字节，journal 只存最后 16 字节，卡上写的是 16 B。
    expect(tail!.statusWord).toBe("退出码 0");
    expect(tail!.result).toContain("16 B");
    expect(tail!.peek.map((line) => line.text)).toEqual(["E2E_DWT_TAIL_END"]);
    await toggleCard(3);
    const tailBody = await readCardBody(3);
    expect(tailBody.stdout).toBe("E2E_DWT_TAIL_END");
    expect(tailBody.note).toBeNull();
    expect(tailBody.footer).toContain("16 B");
  });

  it("DWT-03 run 结束后表头转为已完成；子代理 transcript 里 ask 正文之外的引擎尾注折进默认收起的披露；renderer 重载后重开 tab，从 journal 画出同样的卡与正文", async function () {
    this.timeout(300000);
    if (!runId || !sessionId) throw new Error("DWT-01 没有留下会话与 run");
    await releaseControlledReplay(HELD_AGENT_FIXTURE);
    const digest = $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
    await browser.waitUntil(
      async () => (await digest.getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "run 没有到达完成态" },
    );
    // 面板订阅父会话投影：run 的状态词跟着变。
    await expect($(paneSelector()).$('[data-testid="workflow-workspace-run-status"]')).toHaveText(
      "已完成",
    );
    await waitForV4AssistantMessageContaining("E2E_DWT_DONE", 120000);
    // 把前两例展开的卡收起，peek 回来：重载后的展开态记忆是空的，比的是同一副收起的样子。
    for (const [index, card] of (await readScriptCards()).entries()) {
      if (card.open) await toggleCard(index);
    }
    cardsBeforeReload = await waitForSettledCards("完成后面板的四张卡没有停在已结束");
    expect(cardsBeforeReload.every((card) => !card.open && card.peek.length > 0)).toBe(true);

    // 子代理 transcript：气泡正文是脚本写的指令（带上 world.run 的退出码），质量尾注折进
    // 「工作流引擎附加说明」，默认收起；展开后去掉开头的 `---`，等宽显示。
    let opened = false;
    for (const pill of await digest.$$(
      '[data-testid="workflow-agent-pill"][data-agent-open="true"]',
    )) {
      if ((await pill.getText()).includes("复核员")) {
        await pill.click();
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);
    const readBubble = () =>
      browser.execute(() => {
        const bubble = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-session-id^="sess_dwf-"] [data-v4-user-input-bubble="true"]',
          ),
        ).find((element) => (element.textContent ?? "").includes("E2E_DWT_TASK"));
        if (!bubble) return null;
        const fold = bubble.querySelector<HTMLElement>('[data-v4-user-input-epilogue="true"]');
        const toggle = fold?.querySelector<HTMLButtonElement>("button");
        const body = fold?.querySelector<HTMLElement>('[data-v4-user-input-epilogue-body="true"]');
        return {
          text: bubble.textContent ?? "",
          label: toggle?.textContent ?? null,
          expanded: toggle?.getAttribute("aria-expanded") ?? null,
          body: body?.textContent ?? null,
        };
      });
    let bubble: Awaited<ReturnType<typeof readBubble>> = null;
    await browser.waitUntil(
      async () => {
        bubble = await readBubble();
        return bubble !== null && bubble.label !== null;
      },
      {
        timeout: 60000,
        timeoutMsg: `子代理 transcript 没有画出带尾注披露的 ask 气泡；最后一次读到 ${JSON.stringify(bubble)}`,
      },
    );
    expect(bubble!.text).toContain("E2E_DWT_TASK 依据两条检查的退出码 0 与 3 给出一句结论。");
    expect(bubble!.label).toBe("工作流引擎附加说明");
    expect(bubble!.expanded).toBe("false");
    expect(bubble!.body).toBeNull();
    expect(bubble!.text).not.toContain("Standard for this result");
    await browser.execute(() => {
      const bubble = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-session-id^="sess_dwf-"] [data-v4-user-input-bubble="true"]',
        ),
      ).find((element) => (element.textContent ?? "").includes("E2E_DWT_TASK"));
      bubble
        ?.querySelector<HTMLButtonElement>('[data-v4-user-input-epilogue="true"] button')
        ?.click();
    });
    await browser.waitUntil(async () => (await readBubble())?.body != null, {
      timeout: 10000,
      timeoutMsg: "点开披露后没有出现尾注正文",
    });
    const epilogue = (await readBubble())!.body!;
    expect(epilogue.startsWith("Standard for this result:")).toBe(true);
    expect(epilogue).toContain("call `escalate`");

    // 冷读：renderer 重载清空正文缓存与展开态记忆；重开 tab，清单与正文都从 journal 重读。
    await reloadRenderer();
    await openScriptTranscript();
    const cardsAfterReload = await waitForSettledCards("重载后面板没有画出四张已结束的命令卡");
    expect(cardsAfterReload).toEqual(cardsBeforeReload);
    await toggleCard(1);
    const badBody = await readCardBody(1);
    expect(badBody.stderr).toBe("Error: E2E_DWT_BAD config missing\n");
    expect(badBody.footer).toContain("退出码 3");
  });
});
