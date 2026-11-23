// 运行：pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/conversation-session/plugins/conversation-session-plugin-skill-live-catalog.test.ts
// 合同：docs/skills-live-catalog.md。打开的会话跟随 skill 目录变化：新 skill 只追加一行，
// 插件停用后它的 skill 不再能加载，已发送的列表不改写、不发删除通知。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { PLUGIN_MCP_PLUGIN_ID } from "#e2e/helpers/plugin-mcp-skill";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const FIRST_MARKER = "E2E_SKILL_LIVE_FIRST";
const SECOND_MARKER = "E2E_SKILL_LIVE_SECOND";
const THIRD_MARKER = "E2E_SKILL_LIVE_THIRD";
const FIRST_REPLY = "skill-live-first-ok";
const SECOND_REPLY = "skill-live-second-ok";
const THIRD_REPLY = "skill-live-third-ok";
const LOAD_LIVE_TOOL_ID = "toolu_e2e_skill_live_load";
const LOAD_PLUGIN_TOOL_ID = "toolu_e2e_skill_live_plugin";
const LIVE_SKILL_NAME = "e2e-live-skill";
const LIVE_SKILL_LINE = `- ${LIVE_SKILL_NAME}: E2E live catalog skill marker`;
// 正文标记只出现在 SKILL.md 与 tool_result 里，不参与 provider 匹配。
const LIVE_SKILL_BODY = "skill-live-body-marker";
const PLUGIN_SKILL_NAME = "e2e-plugin-mcp-ping:plugin-mcp-ping";
const PLUGIN_SKILL_LINE = `- ${PLUGIN_SKILL_NAME}: E2E workspace Plugin skill marker`;

describe("Skill live catalog in an open session E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("appends a new workspace skill and stops loading a disabled plugin skill", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(`${FIRST_MARKER}: Do not call tools; reply with exactly ${FIRST_REPLY}.`);
    await waitForUpstreamRequestContaining(FIRST_MARKER, 60000);
    await waitForV4AssistantMessageContaining(FIRST_REPLY);
    const first = await lastMainRequest(FIRST_MARKER);
    expect(countOf(first, PLUGIN_SKILL_LINE)).toBe(1);
    expect(countOf(first, LIVE_SKILL_LINE)).toBe(0);

    // 同一个会话里：先停用工作区插件，再新建工作区 skill。每次重读都是全量，
    // 读到新 skill 的那次一定也读到了停用配置。
    await disableWorkspacePlugin();
    await writeWorkspaceSkill();

    await sendV4Prompt(
      `${SECOND_MARKER}: Call Skill with ${LIVE_SKILL_NAME}, then reply with exactly ${SECOND_REPLY}.`,
    );
    await waitForV4AssistantMessageContaining(SECOND_REPLY);
    // Skill tool 未命中时立即全量重读一次：刚写入的 skill 不受去抖窗口影响。
    const loaded = await getLatestUpstreamToolResultByToolCallId(LOAD_LIVE_TOOL_ID);
    expect(loaded?.content).toContain(LIVE_SKILL_BODY);
    const second = await lastMainRequest(SECOND_MARKER);
    // 新 skill 追加一行；已发送的列表不改写，停用的插件 skill 不发删除通知。
    expect(countOf(second, LIVE_SKILL_LINE)).toBe(1);
    expect(countOf(second, PLUGIN_SKILL_LINE)).toBe(1);

    await sendV4Prompt(
      `${THIRD_MARKER}: Call Skill with ${PLUGIN_SKILL_NAME}, then reply with exactly ${THIRD_REPLY}.`,
    );
    await waitForV4AssistantMessageContaining(THIRD_REPLY);
    const refused = await getLatestUpstreamToolResultByToolCallId(LOAD_PLUGIN_TOOL_ID);
    // 找不到的 skill 由 Skill handler 返回失败、executor 包装（00-tool-change-chain.md「工具错误的包装与文字」）。
    expect(refused?.content).toContain(`<tool_use_error>Unknown skill: ${PLUGIN_SKILL_NAME}`);
    const third = await lastMainRequest(THIRD_MARKER);
    // 之后的请求不重复公告。
    expect(countOf(third, LIVE_SKILL_LINE)).toBe(1);
  });
});

async function disableWorkspacePlugin(): Promise<void> {
  const { workspace } = getE2EAppDataPaths();
  const configPath = join(workspace, ".zcode", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    plugins?: { enabledPlugins?: Record<string, boolean> };
  };
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...config.plugins,
          enabledPlugins: { ...config.plugins?.enabledPlugins, [PLUGIN_MCP_PLUGIN_ID]: false },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeWorkspaceSkill(): Promise<void> {
  const { workspace } = getE2EAppDataPaths();
  const directory = join(workspace, ".zcode", "skills", LIVE_SKILL_NAME);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${LIVE_SKILL_NAME}\ndescription: E2E live catalog skill marker\n---\n\n${LIVE_SKILL_BODY}\n`,
    "utf8",
  );
}

/** 本轮最后一次主请求（不含标题 sidecar）；它带着到目前为止的完整历史。 */
async function lastMainRequest(marker: string): Promise<unknown> {
  const records = await getUpstreamRequestEvidence({ includes: [marker] });
  const record = records.at(-1);
  expect(record).toBeDefined();
  return record?.requestJson;
}

function countOf(requestJson: unknown, text: string): number {
  return JSON.stringify(requestJson).split(text).length - 1;
}
