import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_TASK_ITEM,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay, waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PARENT = "E2E_SAT31_PARENT";
const PARENT_LAUNCHED = "E2E_SAT31_PARENT_LAUNCHED";
const NOTIFICATION_DONE = "E2E_SAT31_NOTIFICATION_DONE";
const SYNC_DONE = "E2E_SAT31_SYNC_DONE";
const BG_DONE = "E2E_SAT31_BG_DONE";
const SYNC_CALL = "toolu_e2e_sat31_sync";
const BG_CALL = "toolu_e2e_sat31_bg";
const BG_CHILD_FIXTURE = "conversation-session-subagent-legacy-part-cold-load-background-child";
// Agent 工具结算时新写进 part.metadata 的结构化字段；升级前写下的 part 没有它们。
const STRUCTURED_FACT_KEYS = ["agentId", "childSessionId", "outputFile", "background"] as const;
const paths = getE2EAppDataPaths();

interface ChildEntry {
  childSessionId: string;
  toolCallId: string | null;
}

// 回归 2026-11-11（!3624 评审 CR-01）：冷加载只读结构化字段时，升级前写下的 Agent part（只有回执文本）
// 都没有子会话入口。当前版本先跑出真实的 Agent part，重启时在进程退出后删掉结构化字段，得到与升级前
// 一样的数据：回执文本不变，part.metadata 里没有这些字段。
describe("SAT31 升级前的 Agent part 冷加载", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT31: 没有结构化字段的旧 Agent part 冷加载后仍带各自的子会话入口", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    await sendV4PromptAndWaitAccepted(
      `${PARENT}: call Agent once in the foreground, then once in the background, then finish.`,
      PARENT,
      "SAT31 首轮用户消息没有进入 timeline",
      90000,
    );
    await waitForV4AssistantMessageContaining(PARENT_LAUNCHED, 90000);
    await waitForV4Pane((state) => !state.canStop, "SAT31 首轮没有收口", 30000);
    // 后台 child 停在半途，父 turn 先收口；释放后完成通知单独唤醒父会话。
    await waitForControlledReplay(BG_CHILD_FIXTURE);
    await releaseControlledReplay(BG_CHILD_FIXTURE);
    await waitForV4AssistantMessageContaining(NOTIFICATION_DONE, 120000);
    await waitForV4Pane((state) => !state.canStop, "SAT31 完成通知轮没有收口", 30000);
    await waitForUpstreamRequest(
      { includes: [PARENT, BG_DONE, "<task-notification>", "<status>completed</status>"] },
      "后台 Agent 的完成通知没有回到父模型",
      30000,
    );

    const parentId = (await getV4PaneSnapshot()).sessionId;
    if (!parentId) throw new Error("missing parent session");
    const children = readAgentChildren(parentId);
    expect(Object.keys(children).sort()).toEqual([BG_CALL, SYNC_CALL]);
    const expected = [
      { childSessionId: children[SYNC_CALL]!, toolCallId: SYNC_CALL },
      { childSessionId: children[BG_CALL]!, toolCallId: BG_CALL },
    ];
    expect(await waitForChildEntries(expected, "实时 Agent 卡片没有子会话入口")).toEqual(expected);

    // 真正重启 CLI；进程树退出后、新进程启动前没有别的写入方，在这里把 part 改成升级前的样子。
    let stripped: string[] = [];
    await restartIntoWorkspacePreservingProfile(paths.workspace, {
      afterElectronProcessExit: () => {
        stripped = stripStructuredAgentFacts(parentId);
      },
    });
    expect(stripped.sort()).toEqual([BG_CALL, SYNC_CALL]);
    const parent = $(`[data-testid="${testId(TID_TASK_ITEM, parentId)}"]`);
    await parent.waitForDisplayed({ timeout: 30000 });
    await parent.click();
    await waitForV4AssistantMessageContaining(NOTIFICATION_DONE, 30000);

    // 修复点：没有结构化字段的旧 part 按原来的逻辑读回执文本里的 agentId 行，两张卡片都带各自的入口。
    expect(await waitForChildEntries(expected, "旧 Agent part 冷加载后没有子会话入口")).toEqual(
      expected,
    );
    // 入口能打开对应 child 的历史。
    expect(await openChildAndReadAssistantText(children[SYNC_CALL]!)).toContain(SYNC_DONE);
    expect(await openChildAndReadAssistantText(children[BG_CALL]!)).toContain(BG_DONE);
  });
});

/** 父会话里每个 Agent 调用的 child session（当前版本写在 part.metadata 上）。 */
function readAgentChildren(parentId: string): Record<string, string> {
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = db.prepare("SELECT data FROM part WHERE session_id = ?").all(parentId) as {
      data: string;
    }[];
    const children: Record<string, string> = {};
    for (const row of rows) {
      const part = JSON.parse(row.data) as {
        callID?: string;
        metadata?: Record<string, unknown>;
        tool?: string;
        type?: string;
      };
      const childSessionId = part.metadata?.childSessionId;
      if (part.type === "tool" && part.tool === "Agent" && part.callID) {
        if (typeof childSessionId !== "string") {
          throw new Error(`当前版本的 Agent part 没有结构化 childSessionId: ${part.callID}`);
        }
        children[part.callID] = childSessionId;
      }
    }
    return children;
  } finally {
    db.close();
  }
}

/**
 * 删掉父会话 Agent part 上本次新增的结构化字段，返回改过的 tool call id。
 * 先确认字段齐全、回执文本里有 agentId 行：删掉之后的 part 与升级前写下的一样。
 */
function stripStructuredAgentFacts(parentId: string): string[] {
  // node:sqlite 只有同步 API；只在 Electron 进程树退出后、新进程启动前的离线窗口里改写。
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"));
  const stripped: string[] = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    const rows = db.prepare("SELECT id, data FROM part WHERE session_id = ?").all(parentId) as {
      data: string;
      id: string;
    }[];
    const update = db.prepare("UPDATE part SET data = ? WHERE id = ?");
    for (const row of rows) {
      const part = JSON.parse(row.data) as {
        callID: string;
        metadata?: Record<string, unknown>;
        state?: { output?: unknown; status?: string };
        tool?: string;
        type?: string;
      };
      if (part.type !== "tool" || part.tool !== "Agent") continue;
      const metadata = part.metadata ?? {};
      for (const key of ["agentId", "childSessionId", "outputFile"] as const) {
        if (typeof metadata[key] !== "string") {
          throw new Error(`Agent part ${part.callID} 缺少结构化字段 ${key}`);
        }
      }
      if (part.callID === BG_CALL && metadata.background !== true) {
        throw new Error("后台 Agent part 缺少 background");
      }
      const output = part.state?.status === "completed" ? part.state.output : undefined;
      if (typeof output !== "string" || !/(?:^|\n)agentId: agent_/u.test(output)) {
        throw new Error(`Agent part ${part.callID} 的回执文本没有 agentId 行`);
      }
      for (const key of STRUCTURED_FACT_KEYS) delete metadata[key];
      part.metadata = metadata;
      update.run(JSON.stringify(part), row.id);
      stripped.push(part.callID);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return stripped;
}

/** 页面上全部子会话入口，以及它们所在的 Agent 卡片。 */
async function readChildEntries(): Promise<ChildEntry[]> {
  await expandAssistantHistoriesWithContent();
  return browser.execute(
    (prefix, cardPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
        (element) => {
          const card = element.closest<HTMLElement>(`[data-testid^="${cardPrefix}-"]`);
          return {
            childSessionId: (element.getAttribute("data-testid") ?? "").slice(prefix.length + 1),
            toolCallId: card
              ? (card.getAttribute("data-testid") ?? "").slice(cardPrefix.length + 1)
              : null,
          };
        },
      ),
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    TID_CHAT_TOOL_CALL_BLOCK,
  );
}

async function waitForChildEntries(
  expected: readonly ChildEntry[],
  timeoutMsg: string,
): Promise<ChildEntry[]> {
  let entries: ChildEntry[] = [];
  await browser
    .waitUntil(
      async () => {
        entries = await readChildEntries();
        return JSON.stringify(entries) === JSON.stringify(expected);
      },
      { timeout: 30000, timeoutMsg },
    )
    .catch(() => undefined);
  return entries;
}

/** 点开子会话入口，等右侧 child pane 加载出历史，返回其中 assistant 行的文本。 */
async function openChildAndReadAssistantText(childSessionId: string): Promise<string> {
  await browser.execute(
    (id) => {
      document.querySelector<HTMLElement>(`[data-testid=${JSON.stringify(id)}]`)?.click();
    },
    testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId),
  );
  let text = "";
  await browser
    .waitUntil(
      async () => {
        text = await browser.execute((id) => {
          const pane = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid^="v4-session-pane-"]'),
          ).find((candidate) => candidate.dataset.sessionId === id);
          const timeline = pane?.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
          // 不读 user prompt：child 的任务里已经写了 DONE marker。
          return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
            .filter((row) => row.classList.contains("group/assistant-row"))
            .map((row) => row.textContent ?? "")
            .join("\n");
        }, childSessionId);
        return text.length > 0;
      },
      { timeout: 30000, timeoutMsg: `child ${childSessionId} 的历史没有在右侧打开` },
    )
    .catch(() => undefined);
  return text;
}
