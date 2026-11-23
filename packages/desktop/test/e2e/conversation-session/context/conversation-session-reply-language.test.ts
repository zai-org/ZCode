// RL01–RL09 Agent 回复语言（docs/conversation-session-case-catalog.md「Agent 回复语言」）。
// 回复语言是「行为与工具」里的自由文本设置（默认留空），由 Main 持有并推送给每个窗口的 Host；
// 只经 language 输入附件到达模型，值变化才公告；system 前缀不变。
// 所有断言读取上游请求体；比较前去掉 cache_control（断点随请求尾部移动，不属于历史内容）。
// non-MCS 与 MCS 两种投影各跑一遍：公告分别在 user 侧 <system-reminder> 与 role: system 消息里。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  setReplyLanguageInSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  resolveSeededReplayBaseUrl,
  seedCustomAnthropicMessagesProvider,
} from "#e2e/helpers/custom-openai-provider-store";
import {
  restartIntoWorkspacePreservingProfile,
  seedTurboAgentStartupModel,
} from "#e2e/helpers/model-provider-restart-runtime";
import { openSubagentHostWindow } from "#e2e/helpers/subagent-host-window";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamProviderModelById,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const COMPACT_REQUEST = "CRITICAL: Respond with TEXT ONLY";
const TITLE_REQUEST = "Generate a concise title";
const DEFAULT_TITLE_RULE = "Use the user's primary language.";
const CLEARED = "The language preference was cleared. Match the user's language.";
const PROVIDER_NAME = "Reply Language Fixture";

// marker 互不为前缀：fixture 与请求查询按子串匹配。
const TURNS = {
  default: { marker: "E2E_RL_DEFAULT", reply: "RL_A_DEFAULT" },
  set: { marker: "E2E_RL_SET", reply: "RL_A_SET" },
  same: { marker: "E2E_RL_SAME", reply: "RL_A_SAME" },
  changed: { marker: "E2E_RL_CHANGED", reply: "RL_A_CHANGED" },
  compacted: { marker: "E2E_RL_COMPACTED", reply: "RL_A_COMPACTED" },
  resumed: { marker: "E2E_RL_RESUMED", reply: "RL_A_RESUMED" },
  newTask: { marker: "E2E_RL_NEWTASK", reply: "RL_A_NEWTASK" },
  cleared: { marker: "E2E_RL_CLEARED", reply: "RL_A_CLEARED" },
  afterClear: { marker: "E2E_RL_AFTERCLEAR", reply: "RL_A_AFTERCLEAR" },
  otherWindow: { marker: "E2E_RL_OTHERWINDOW", reply: "RL_A_OTHERWINDOW" },
} as const;

const SCENARIOS = [
  { name: "non-mcs", model: UPSTREAM_MODEL, mcs: false, reminderRole: "user" },
  // 是否走 MCS 由模型配置的 supportsMidConversationSystem 决定。
  { name: "mcs", model: "claude-opus-4-8", mcs: true, reminderRole: "system" },
] as const;

type Scenario = (typeof SCENARIOS)[number];
type TurnName = keyof typeof TURNS;
type ProviderRequest = { messages: { role?: string }[]; model?: string; system?: unknown };
type Announced = { language: string; role?: string };

const recorded: Record<string, unknown> = {};

describe("RL Agent 回复语言", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(artifactPath("RL-failure.png"));
    }
  });
  after(async () => {
    await writeFile(artifactPath("RL-requests.json"), JSON.stringify(recorded, null, 2));
    await clearAppData();
  });

  for (const scenario of SCENARIOS) {
    it(`RL01–RL09（${scenario.name}）：设置变化才公告，compact 后重述，冷恢复不重复，清除一次，多窗口生效，标题跟随公告语言`, async function () {
      this.timeout(600_000);
      await setupProvider(scenario.model, scenario.mcs);
      await prepareV4ConversationE2E({ skipProvider: true, resetDraftBeforeProvider: true });
      // 第二个变体复用上一个变体留下的项目草稿，它的模型偏好指向已被替换的模型，显示 "Choose model"。
      // 在最终草稿上按变体选模型，不依赖草稿初始化的副作用。
      await selectUpstreamProviderModelById(scenario.model, {
        includePlainModelFallback: false,
        providerId: UPSTREAM_PROVIDER_ID,
        providerName: PROVIDER_NAME,
      });
      await waitForUpstreamModelSelected(scenario.model, {
        includePlainModelFallback: false,
        providerId: UPSTREAM_PROVIDER_ID,
      });
      // 上一个变体最后把设置改成了 Deutsch；每个变体都从未设置开始（第一个变体本来就是空值，这一步不写盘）。
      await setReplyLanguageInSettings("");
      const send = (name: TurnName, text: string) => sendTurn(scenario, name, text);
      const expectAnnounced = (request: ProviderRequest, languages: string[], cleared = 0) => {
        const found = announcements(request);
        expect(found.map((item) => item.language)).toEqual(languages);
        expect(countCleared(request)).toBe(cleared);
        // 公告所在的角色证明本变体走的是预期的投影。
        expect(found.every((item) => item.role === scenario.reminderRole)).toBe(true);
      };

      // RL01：默认留空，不公告；标题按默认规则。
      const r1 = await send("default", "FIRST: hello.");
      const sessionId = await idleSessionId("RL01 首轮没有完成");
      expect(r1.model).toBe(scenario.model);
      expectAnnounced(r1, []);
      expect(JSON.stringify(r1.system ?? null)).not.toContain("# Language");
      const defaultTitle = await titleRequestOf(scenario, "default");
      expect(defaultTitle).toContain(DEFAULT_TITLE_RULE);
      expect(defaultTitle).not.toContain("Write the title in");

      // RL02：输入原文并保存；下一轮恰好一条公告，正文直接用原文。
      await setReplyLanguageInSettings("简体中文");
      await selectV4TaskById(sessionId, 30_000);
      const r2 = await send("set", "SECOND: after setting the language.");
      expectAnnounced(r2, ["简体中文"]);
      expect(JSON.stringify(r2.system ?? null)).not.toContain("# Language");
      expectStrictPrefix(r1, r2, "RL01 → RL02");

      // RL03：值没变，不再公告。
      const r3 = await send("same", "THIRD: same language.");
      expectAnnounced(r3, ["简体中文"]);
      expectStrictPrefix(r2, r3, "RL02 → RL03");

      // RL04：改值；只追加一条，旧公告不改写。
      await setReplyLanguageInSettings("日本語");
      await selectV4TaskById(sessionId, 30_000);
      const r4 = await send("changed", "FOURTH: after changing the language.");
      expectAnnounced(r4, ["简体中文", "日本語"]);
      expectStrictPrefix(r3, r4, "RL03 → RL04");

      // RL05：手动 compact 后，首个请求恰好一条重述的公告。
      const announcedBeforeCompact = languagePartIds(sessionId);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
        timeout: 15_000,
        timeoutMsg: "composer 输入框没有出现",
      });
      await clickV4Send();
      await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
      await idleSessionId("compact 后没有回到空闲态");
      // 发下一轮之前库里就多出一条语言公告：它来自 compaction 重述，不是下一轮收集补发的。
      expect(
        languagePartIds(sessionId).filter((id) => !announcedBeforeCompact.includes(id)),
      ).toHaveLength(1);
      const r5 = await send("compacted", "FIFTH: after compact.");
      expectAnnounced(r5, ["日本語"]);
      expect(stripCacheControl(r5.system)).toEqual(stripCacheControl(r1.system));

      // RL06：重启 App，CLI 冷恢复。Host 从 InitLocal 拿到设置，同值不再公告；
      // 没拿到时 Host 会回答 null，这里就会多出一条清除公告。
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
      await selectV4TaskById(sessionId, 30_000);
      const r6 = await send("resumed", "SIXTH: after restart.");
      expectAnnounced(r6, ["日本語"]);
      expectStrictPrefix(r5, r6, "RL05 → RL06（冷恢复）");

      // RL07：新任务首轮公告当前设置；标题按公告的语言写。
      // 在同一项目里新建：侧栏全局新建会切到草稿工作区，下一个变体的准备步骤要求当前是 DEFAULT_WORKSPACE。
      await startDraftFromProject(DEFAULT_WORKSPACE);
      const r7 = await send("newTask", "SEVENTH: new task.");
      const newSessionId = await idleSessionId("RL07 新任务首轮没有完成");
      expectAnnounced(r7, ["日本語"]);
      const languageTitle = await titleRequestOf(scenario, "newTask");
      expect(languageTitle).toContain("Write the title in 日本語.");
      expect(languageTitle).not.toContain(DEFAULT_TITLE_RULE);

      // RL08：清空设置；只发一次清除公告。
      await setReplyLanguageInSettings("");
      await selectV4TaskById(newSessionId, 30_000);
      const r8 = await send("cleared", "EIGHTH: after clearing the language.");
      expectAnnounced(r8, ["日本語"], 1);
      expectStrictPrefix(r7, r8, "RL07 → RL08");
      const r9 = await send("afterClear", "NINTH: still cleared.");
      expectAnnounced(r9, ["日本語"], 1);
      expectStrictPrefix(r8, r9, "RL08 → RL08 第二轮");

      // RL09：在第二个窗口改设置；第一个窗口的 Host 也拿到新值（Main 推送给每个 Host）。
      // 第二个窗口会恢复到草稿工作区而不是 DEFAULT_WORKSPACE；本例只用它的设置页，不等工作区路径。
      const firstHandle = await browser.getWindowHandle();
      // 只借用它的开窗流程（产品 activate 路径），不注入故障。
      const second = await openSubagentHostWindow();
      try {
        await setReplyLanguageInSettings("Deutsch");
      } finally {
        await browser.electron.execute(
          (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
          second.windowId,
        );
        await browser.switchToWindow(firstHandle);
      }
      await selectV4TaskById(newSessionId, 30_000);
      const r10 = await send("otherWindow", "TENTH: changed in another window.");
      expectAnnounced(r10, ["日本語", "Deutsch"], 1);
      expectStrictPrefix(r9, r10, "RL08 → RL09");
    });
  }
});

async function setupProvider(modelId: string, supportsMidConversationSystem: boolean) {
  await waitForDefaultWorkspaceReady();
  await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  // 通用 fixture 的 240 token 窗口会触发自动 compact；本例只在手动 /compact 时压缩。
  await seedCustomAnthropicMessagesProvider({
    baseURL: await resolveSeededReplayBaseUrl(),
    modelId,
    providerId: UPSTREAM_PROVIDER_ID,
    providerName: PROVIDER_NAME,
    supportsMidConversationSystem,
  });
  await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, modelId);
  await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
}

/** 两个变体共用一套 fixture（按 marker 子串匹配），请求查询用带变体名的 marker 区分。 */
function markerOf(scenario: Scenario, name: TurnName): string {
  return `${TURNS[name].marker}_${scenario.name}`;
}

/** 任务首轮结束后的标题请求（序列化后的请求体）。 */
async function titleRequestOf(scenario: Scenario, firstTurn: TurnName): Promise<string> {
  const query = { includeTitle: true, includes: [TITLE_REQUEST, markerOf(scenario, firstTurn)] };
  await waitForUpstreamRequest(query, `${firstTurn} 之后没有标题请求`, 60_000);
  const title = JSON.stringify((await getUpstreamRequestEvidence(query)).at(-1)?.requestJson);
  recorded[`${scenario.name}.title.${firstTurn}`] = title;
  return title;
}

async function sendTurn(
  scenario: Scenario,
  name: TurnName,
  text: string,
): Promise<ProviderRequest> {
  const marker = markerOf(scenario, name);
  const { reply } = TURNS[name];
  await sendV4Prompt(`${marker} ${text} Reply with exactly "${reply}".`);
  await waitForV4AssistantMessageContaining(reply, 60_000);
  await idleSessionId(`${marker} 没有完成`);
  const query = { lastUserMessageIncludes: [marker], excludes: [COMPACT_REQUEST] };
  await waitForUpstreamRequest(query, `${marker} 没有上游请求`, 30_000);
  const request = (await getUpstreamRequestEvidence(query)).at(-1)?.requestJson;
  if (!isProviderRequest(request)) throw new Error(`${marker} 的上游请求不是 Messages 请求`);
  recorded[`${scenario.name}.${name}`] = request;
  return request;
}

async function idleSessionId(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    90_000,
  );
  return snapshot.sessionId!;
}

function isProviderRequest(value: unknown): value is ProviderRequest {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as ProviderRequest).messages),
  );
}

/** 遍历每条消息里的全部字符串。 */
function visitStrings(request: ProviderRequest, onString: (value: string, role?: string) => void) {
  for (const message of request.messages) {
    const visit = (value: unknown) => {
      if (typeof value === "string") onString(value, message.role);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(message);
  }
}

/**
 * 按出现顺序列出每条语言公告的语言与所在消息的角色。
 * 语言是自由文本，可能含句点；按正文模板用反向引用取值，不在第一个句点处截断。
 */
function announcements(request: ProviderRequest): Announced[] {
  const found: Announced[] = [];
  const pattern = /# Language\nAlways respond in (.+?)\. Use \1 for all explanations/g;
  visitStrings(request, (value, role) => {
    for (const match of value.matchAll(pattern)) found.push({ language: match[1]!, role });
  });
  return found;
}

function countCleared(request: ProviderRequest): number {
  let count = 0;
  visitStrings(request, (value) => {
    count += value.split(CLEARED).length - 1;
  });
  return count;
}

function expectStrictPrefix(previous: ProviderRequest, next: ProviderRequest, label: string) {
  expect(stripCacheControl(next.system)).toEqual(stripCacheControl(previous.system));
  const before = stripCacheControl(previous.messages);
  const after = stripCacheControl(next.messages);
  if (after.length <= before.length) {
    throw new Error(`${label} 没有在尾部追加：previous=${before.length}, next=${after.length}`);
  }
  // 上一个请求的最后一条 user 消息可能在下一个请求里与之后的 user 内容合并；只比较它之前的消息与块前缀。
  const head = before.slice(0, -1);
  expect(after.slice(0, head.length)).toEqual(head);
  const lastBefore = blocksOf(before.at(-1));
  expect(blocksOf(after[head.length]).slice(0, lastBefore.length)).toEqual(lastBefore);
}

function blocksOf(message: unknown): unknown[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : ((content as unknown[]) ?? []);
}

function stripCacheControl<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner)),
  ) as T;
}

/** 会话里语言公告的 part id（持久化的提醒 part 带 metadata.source）。 */
function languagePartIds(sessionId: string): string[] {
  // Node SQLite 只提供同步 API；只读隔离 E2E DB，不改写运行中的 session。
  const db = new DatabaseSync(
    join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "db", "db.sqlite"),
    { readOnly: true },
  );
  try {
    return db
      .prepare("select id, data from part where session_id = ?")
      .all(sessionId)
      .filter((part) => JSON.parse(String(part.data)).metadata?.source === "language")
      .map((part) => String(part.id));
  } finally {
    db.close();
  }
}

function artifactPath(name: string): string {
  return join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"), name);
}
