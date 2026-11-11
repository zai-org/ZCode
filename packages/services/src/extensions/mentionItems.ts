import {
  EXTENSION_SLOTS,
  MENTION_ITEMS_ERROR_CODES,
  type ExtensionStaticTable,
  type IExtensionHostChannel,
  type MentionCommandArgs,
  type MentionItemsResult,
  type ProvideMentionItemsInput,
  type StaticSlotItem,
} from "@zcode/shared/extension-host";
import { zcodeProtocolErrorCodes } from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
} from "#src/zcode-agent/zcodeAgent.js";

// composer.mention 的候选项路由（docs/plugins/extension-host.md §16.6）：
// - command 条目 → 扩展进程的命令（参数 { query }），返回值按插槽的 commandResult 校验；
// - tool 条目 → CLI plugins/mentionItems（会话的 MCP App 授权链，首次调用可能在会话里弹审批）。
// 不设计取消，seq 原样带回，Renderer 只采用最新一次。错误折成结果里的稳定码，不抛给 Renderer。
// 日志不记 query 与候选内容：query 是用户输入，候选内容来自插件。

export interface MentionItemsRouterDeps {
  /** 静态表的最近一份（owner 是本服务）。 */
  staticTable(): ExtensionStaticTable;
  /** 当前代际的扩展进程连接；没有时为 null。 */
  connection(): { gen: number; host: IExtensionHostChannel } | null;
  agent: Pick<IZCodeAgentService, "getPluginMentionItems">;
  logger: Pick<ServiceLogger, "debug" | "warn">;
}

const MENTION_SLOT = "composer.mention";
const commandResultSchema = EXTENSION_SLOTS[MENTION_SLOT].commandResult;
/** invalid-result 的日志最多列出这么多条 schema 路径（只给路径，不给值）。 */
const MAX_REPORTED_ISSUE_PATHS = 5;

function findMentionItem(table: ExtensionStaticTable, entry: string): StaticSlotItem | undefined {
  for (const plugin of table.plugins) {
    const item = plugin.slotItems.find((candidate) => candidate.id === entry);
    if (item) return item.slot === MENTION_SLOT ? item : undefined;
  }
  return undefined;
}

/** CLI 错误的稳定码：`data.code`（plugin_mention_*）优先；会话或 CLI 不在时折成 session-unavailable。 */
function toolErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) {
      const code = (data as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
    }
    const code = (error as { code?: unknown }).code;
    if (
      code === zcodeProtocolErrorCodes.sessionUnavailable ||
      code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
    ) {
      return MENTION_ITEMS_ERROR_CODES.sessionUnavailable;
    }
  }
  return MENTION_ITEMS_ERROR_CODES.internal;
}

export function createMentionItemsRouter(
  deps: MentionItemsRouterDeps,
): (input: ProvideMentionItemsInput) => Promise<MentionItemsResult> {
  const fail = (seq: number, code: string): MentionItemsResult => ({ seq, status: "error", code });

  const runCommand = async (
    input: ProvideMentionItemsInput,
    item: StaticSlotItem,
  ): Promise<MentionItemsResult> => {
    const target = deps.connection();
    if (!target) return fail(input.seq, MENTION_ITEMS_ERROR_CODES.hostUnavailable);
    let value: unknown;
    try {
      value = await target.host.executeCommand({
        commandId: item.target.id,
        scope: input.scope,
        args: { query: input.query } satisfies MentionCommandArgs,
      });
    } catch {
      // 原因已由扩展进程按插件记进扩展日志（command ... failed）。
      return fail(input.seq, MENTION_ITEMS_ERROR_CODES.commandFailed);
    }
    const parsed = commandResultSchema.safeParse(value);
    if (!parsed.success) {
      deps.logger.warn(
        undefined,
        `mention command result invalid entry=${item.id} paths=${parsed.error.issues
          .slice(0, MAX_REPORTED_ISSUE_PATHS)
          .map((issue) => issue.path.join(".") || "<root>")
          .join(",")}`,
      );
      return fail(input.seq, MENTION_ITEMS_ERROR_CODES.invalidResult);
    }
    return { seq: input.seq, status: "ok", items: parsed.data };
  };

  const callTool = async (
    input: ProvideMentionItemsInput,
    item: StaticSlotItem,
  ): Promise<MentionItemsResult> => {
    // 工具在会话的 MCP 连接上调用：草稿用预热会话，没有会话时不查。
    if (input.scope.kind !== "session") {
      return fail(input.seq, MENTION_ITEMS_ERROR_CODES.noSession);
    }
    const query = deps.agent.getPluginMentionItems;
    if (!query) return { seq: input.seq, status: "unsupported" };
    try {
      const result = await query({
        workspacePath: input.scope.workspace.workspacePath,
        ...(input.scope.workspace.workspaceIdentity
          ? { workspaceIdentity: input.scope.workspace.workspaceIdentity }
          : {}),
        sessionId: input.scope.sessionId,
        pluginId: item.pluginId,
        tool: item.target.id,
        query: input.query,
      });
      return result.supported
        ? { seq: input.seq, status: "ok", items: result.items }
        : { seq: input.seq, status: "unsupported" };
    } catch (error) {
      return fail(input.seq, toolErrorCode(error));
    }
  };

  return async (input) => {
    const startedAt = Date.now();
    const item = findMentionItem(deps.staticTable(), input.entry);
    const result = !item
      ? fail(input.seq, MENTION_ITEMS_ERROR_CODES.notDeclared)
      : item.target.kind === "command"
        ? await runCommand(input, item)
        : item.target.kind === "tool"
          ? await callTool(input, item)
          : fail(input.seq, MENTION_ITEMS_ERROR_CODES.notDeclared);
    const summary = `entry=${input.entry} target=${item?.target.kind ?? "none"} seq=${input.seq} ${
      result.status === "ok"
        ? `items=${result.items.length}`
        : result.status === "error"
          ? `code=${result.code}`
          : "unsupported"
    } ms=${Date.now() - startedAt}`;
    // 按键级频率只记 debug；错误另记 warn（只有条目与错误码），生产环境能看到插件坏了。
    if (result.status === "error") deps.logger.warn(undefined, `mention items error ${summary}`);
    else deps.logger.debug(undefined, `mention items ${summary}`);
    return result;
  };
}
