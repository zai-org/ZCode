// IFD01–IFD04 指令文件增量公告候选（docs/conversation-session-case-catalog.md「指令文件增量公告」）。
// 已发出的指令公告不改写：运行中改文件不重读；冷恢复与 compaction 重读后只在末尾追加增量。
// 所有断言读取上游请求体；比较前去掉 cache_control（断点随请求尾部移动，不属于历史内容）。
import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
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
import {
  ensureUpstreamProviderForE2E,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const execFileAsync = promisify(execFile);
const AGENTS_PATH = join(DEFAULT_WORKSPACE, "AGENTS.md");
const RULE_V1 = "IFD_RULE_V1 original rule";
const RULE_V2 = "IFD_RULE_V2 changed between turns";
const RULE_V3 = "IFD_RULE_V3 changed before compact";
const COMPACT_REQUEST = "CRITICAL: Respond with TEXT ONLY";
const FULL_HEAD = "Codebase and user instructions are shown below.";
const DELTA_HEAD = "Instruction files were re-read";
const PROJECT_TYPE = "(project instructions, checked into the codebase):";

const TURNS = {
  u1: { marker: "E2E_IFD_U1", reply: "IFD_A1" },
  u2: { marker: "E2E_IFD_U2_EDITED", reply: "IFD_A2" },
  u3: { marker: "E2E_IFD_U3_COLD", reply: "IFD_A3" },
  u4: { marker: "E2E_IFD_U4_AGAIN", reply: "IFD_A4" },
  u5: { marker: "E2E_IFD_U5_REMOVED", reply: "IFD_A5" },
  c1: { marker: "E2E_IFD_C1", reply: "IFD_C_A1" },
  c2: { marker: "E2E_IFD_C2_COMPACTED", reply: "IFD_C_A2" },
} as const;

type TurnName = keyof typeof TURNS;
type ProviderRequest = { messages: ProviderMessage[]; system?: unknown; tools?: unknown };
type ProviderMessage = { role: string; content: unknown };
type TextBlock = { message: number; block: number; role: string; text: string };

const recorded: Record<string, unknown> = {};
const GIT_ROOT = join(DEFAULT_WORKSPACE, ".git");
// 本用例自己 git init 的根；工作区原来就是仓库时不 init，清理时也不删。
let createdGitRoot = false;

describe("IFD 指令文件增量公告", () => {
  // 每个用例自己准备 git 根、AGENTS.md 与 provider，单独运行 IFD04 也成立；清理与准备对称。
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(
        artifactPath(`IFD-failure-${this.currentTest.title.slice(0, 5)}.png`),
      );
    }
    await rm(AGENTS_PATH, { force: true });
    if (createdGitRoot) await rm(GIT_ROOT, { force: true, recursive: true });
    createdGitRoot = false;
  });
  after(async () => {
    await writeFile(artifactPath("IFD-requests.json"), JSON.stringify(recorded, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("IFD01–IFD03：运行中改文件不重读，冷恢复追加变更与删除增量", async function () {
    this.timeout(480_000);
    await prepareCase(RULE_V1);

    const r1 = await sendTurn("u1", "FIRST: hello.");
    const sessionId = await idleSessionId("U1 没有完成");
    const full1 = expectOneFullAnnouncement(r1, RULE_V1);
    const path = announcedPath(full1);

    // IFD01：运行中改文件，下一次请求不重读、不追加增量。
    await writeAgents(RULE_V2);
    const r2 = await sendTurn("u2", "SECOND: hello again.");
    expectStrictPrefix(r1, r2, "U1 → U2");
    expect(JSON.stringify(r2)).not.toContain(RULE_V2);
    expect(deltaAnnouncements(r2)).toEqual([]);
    expect(fullAnnouncements(r2)).toEqual([full1]);

    // IFD02：冷恢复后重读，首轮公告不改写，新 user 消息里先是增量后是 prompt。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId, 30_000);
    await waitForV4TimelineContaining(TURNS.u2.reply);
    const r3 = await sendTurn("u3", "THIRD: after resume.");
    expectStrictPrefix(r2, r3, "U2 → cold U3");
    expect(stripCacheControl(r3.system)).toEqual(stripCacheControl(r2.system));
    expect(stripCacheControl(r3.tools)).toEqual(stripCacheControl(r2.tools));
    expect(fullAnnouncements(r3)).toEqual([full1]);
    expectDeltaBeforePrompt(
      r3,
      "u3",
      `<system-reminder>\n${DELTA_HEAD} when this session started; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:\n\nContents of ${path} ${PROJECT_TYPE}\n\n${RULE_V2}\n</system-reminder>`,
    );

    const r4 = await sendTurn("u4", "FOURTH: once more.");
    expectStrictPrefix(r3, r4, "cold U3 → U4");
    expect(deltaAnnouncements(r4)).toHaveLength(1);

    // IFD03：退出期间删除文件，冷恢复后追加删除增量。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => rm(AGENTS_PATH, { force: true }),
    });
    await selectV4TaskById(sessionId, 30_000);
    await waitForV4TimelineContaining(TURNS.u4.reply);
    const r5 = await sendTurn("u5", "FIFTH: after delete.");
    expectStrictPrefix(r4, r5, "U4 → cold U5");
    expect(fullAnnouncements(r5)).toEqual([full1]);
    expectDeltaBeforePrompt(
      r5,
      "u5",
      `<system-reminder>\n${DELTA_HEAD} when this session started.\n\nInstructions no longer present: ${path}\n</system-reminder>`,
    );
  });

  it("IFD04：手动 compact 后按重读的内容公告", async function () {
    this.timeout(360_000);
    await prepareCase(RULE_V1);

    const c1 = await sendTurn("c1", "FIRST: hello.");
    expectOneFullAnnouncement(c1, RULE_V1);

    await writeAgents(RULE_V3);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await idleSessionId("compact 后没有回到空闲态");
    recorded.compact = (
      await getUpstreamRequestEvidence({ includes: [TURNS.c1.marker, COMPACT_REQUEST] })
    ).at(-1)?.requestJson;

    const c2 = await sendTurn("c2", "SECOND: after compact.");
    const text = JSON.stringify(c2);
    expect(text).toContain(RULE_V3);
    if (text.includes(RULE_V1)) {
      // 保留段带有完整的旧公告：summary 之前不放，请求末尾追加 compaction 增量，旧公告不改写。
      const deltas = deltaAnnouncements(c2);
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toContain(`${DELTA_HEAD} after the conversation was compacted;`);
      expect(deltas[0]).toContain(RULE_V3);
    } else {
      // 保留段没有完整块（为空也一样）：按初始格式公告完整块。
      expectOneFullAnnouncement(c2, RULE_V3);
      expect(deltaAnnouncements(c2)).toEqual([]);
    }
  });
});

async function prepareCase(rule: string) {
  // 指令文件向上查找到最近的 git 根为止。E2E 工作区位于仓库目录内，不独立成仓库时，
  // 删除工作区 AGENTS.md 后会读到仓库根的 AGENTS.md；独立 git 仓库让查找停在工作区。
  // 工作区原来就是仓库时查找本来就停在这里，不重新 init，也不在清理时删掉原有的 .git。
  createdGitRoot = !(await access(GIT_ROOT).then(
    () => true,
    () => false,
  ));
  if (createdGitRoot) await execFileAsync("git", ["init", "-q"], { cwd: DEFAULT_WORKSPACE });
  await writeAgents(rule);
  await setupProvider();
  await prepareV4ConversationE2E({ skipProvider: true });
}

async function setupProvider() {
  await waitForDefaultWorkspaceReady();
  await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  // 通用 fixture 的 240 token 窗口会触发自动 compact；本例要求只在手动 /compact 时压缩。
  await seedCustomAnthropicMessagesProvider({
    baseURL: await resolveSeededReplayBaseUrl(),
    modelId: UPSTREAM_MODEL,
    providerId: UPSTREAM_PROVIDER_ID,
    providerName: "Instruction File Delta Fixture",
  });
  await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
  await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
}

async function writeAgents(rule: string) {
  await writeFile(AGENTS_PATH, `${rule}\n`, "utf8");
}

async function sendTurn(name: TurnName, text: string): Promise<ProviderRequest> {
  const { marker, reply } = TURNS[name];
  await sendV4Prompt(`${marker} ${text} Reply with exactly "${reply}".`);
  await waitForV4AssistantMessageContaining(reply, 60_000);
  await idleSessionId(`${marker} 没有完成`);
  const query = { lastUserMessageIncludes: [marker], excludes: [COMPACT_REQUEST] };
  await waitForUpstreamRequest(query, `${marker} 没有上游请求`, 30_000);
  const request = (await getUpstreamRequestEvidence(query)).at(-1)?.requestJson;
  if (!isProviderRequest(request)) throw new Error(`${marker} 的上游请求不是 Messages 请求`);
  recorded[name] = request;
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

function textBlocks(request: ProviderRequest): TextBlock[] {
  return request.messages.flatMap((message, messageIndex) => {
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: unknown }>)
          : [];
    return content.flatMap((block, blockIndex) =>
      block.type === "text" && typeof block.text === "string"
        ? [{ message: messageIndex, block: blockIndex, role: message.role, text: block.text }]
        : [],
    );
  });
}

function fullAnnouncements(request: ProviderRequest): string[] {
  return textBlocks(request)
    .filter((block) => block.text.includes(FULL_HEAD))
    .map((block) => block.text);
}

function deltaAnnouncements(request: ProviderRequest): string[] {
  return textBlocks(request)
    .filter((block) => block.text.includes(DELTA_HEAD))
    .map((block) => block.text);
}

function expectOneFullAnnouncement(request: ProviderRequest, rule: string): string {
  const full = fullAnnouncements(request);
  expect(full).toHaveLength(1);
  expect(full[0]).toContain(`AGENTS.md ${PROJECT_TYPE}\n\n${rule}\n</system-reminder>`);
  return full[0] ?? "";
}

function announcedPath(full: string): string {
  const match = /Contents of (\S+AGENTS\.md) \(project instructions/.exec(full);
  if (!match?.[1]) throw new Error("完整公告里没有 AGENTS.md 路径");
  return match[1];
}

/** 增量在最后一条 user 消息里，排在本轮 prompt 之前，逐字比较（后面还有 prompt 块时以换行结尾）。 */
function expectDeltaBeforePrompt(request: ProviderRequest, name: TurnName, expected: string) {
  const blocks = textBlocks(request);
  const lastUser = blocks.filter((block) => block.role === "user").at(-1)?.message;
  const own = blocks.filter((block) => block.message === lastUser);
  const prompt = own.findIndex((block) => block.text.includes(TURNS[name].marker));
  const deltas = own.filter((block) => block.text.includes(DELTA_HEAD));
  expect(deltas).toHaveLength(1);
  expect(own.indexOf(deltas[0]!)).toBeLessThan(prompt);
  expect(deltas[0]?.text).toBe(`${expected}\n`);
}

function expectStrictPrefix(previous: ProviderRequest, next: ProviderRequest, label: string) {
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
  const content = (message as ProviderMessage | undefined)?.content;
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : ((content as unknown[]) ?? []);
}

function stripCacheControl<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner)),
  ) as T;
}

function artifactPath(name: string): string {
  return join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"), name);
}
