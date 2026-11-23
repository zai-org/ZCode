import { isDeepStrictEqual } from "node:util";
import { compareMcpServerNames } from "./mcp-diagnostics.js";
import { LOCAL_TOOL_SEARCH_DESCRIPTION, renderToolSearchAnnouncement } from "./description.js";
import {
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  type ToolSearchMode,
  type ResolvedToolSearchMode,
  type Model,
  type ToolSearchMcpState,
  type ModelToolContract,
  type ToolSearchCandidate,
  type ToolSearchExecutionContext,
  type ToolSearchDelivery,
  type ToolSearchRetractionCause,
} from "@zcode/contracts";
import type { ToolRegistry } from "../registry.js";
import type { ToolMetadata } from "../types.js";
import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  collectToolSearchHistory,
  collectToolSearchDelivery,
  toolReferenceKey,
  projectToolReferences,
} from "./history.js";

export function resolveToolSearchMode(
  model: Model,
  mode: ToolSearchMode = "off",
): ResolvedToolSearchMode {
  const capability = model.requestCapabilities?.toolSearch;
  if (mode === "off") return "off";
  if (mode === "native") {
    if (!capability?.protocolSupported)
      throw new Error("--toolsearch-mode native requires an Anthropic Messages provider.");
    return "native";
  }
  if (mode === "auto" && capability?.protocolSupported && capability.defaultEnabled)
    return "native";
  if (model.properties.supportsToolCall) return "local";
  if (mode === "local")
    throw new Error("--toolsearch-mode local requires a provider that supports tool calls.");
  return "off";
}

export function isDeferredTool(tool: ModelToolContract, metadata?: ToolMetadata): boolean {
  return (
    tool.name !== TOOL_SEARCH_NAME &&
    tool.name !== DEFERRED_TOOL_CALL_NAME &&
    !tool.providerNative &&
    metadata?.alwaysLoad !== true &&
    (metadata?.shouldDefer === true || metadata?.mcpPresentation !== undefined)
  );
}

/** 内存中的状态事实：sources / deniedTools 只用于计算撤销原因，不写入公告 metadata。 */
type McpStatusFacts = ToolSearchMcpState & {
  sources?: Readonly<Record<string, string>>;
  deniedTools?: readonly string[];
};

interface ToolExposureInput {
  mcp?: McpStatusFacts;
  model: Model;
  mode?: ToolSearchMode;
  tools: readonly ModelToolContract[];
  registry?: Pick<ToolRegistry, "get">;
  entries: readonly RuntimeMessageEntry[];
}

function resolveToolSearchCatalog(
  input: ToolExposureInput,
  preCompactDiscoveredTools: ReadonlySet<string>,
  hasRetainedDefinitions = false,
) {
  const requestedMode = resolveToolSearchMode(input.model, input.mode);
  let hasConfiguredDeferred = false;
  const catalog: ToolSearchCandidate[] = input.tools
    .filter((tool) => requestedMode === "local" || tool.name !== DEFERRED_TOOL_CALL_NAME)
    .map((tool) => {
      const entry = input.registry?.get(tool.name);
      const metadata = entry?.metadata;
      const configuredDeferred = isDeferredTool(tool, metadata);
      hasConfiguredDeferred ||= configuredDeferred;
      return {
        name: tool.name,
        aliases: entry?.aliases,
        description: tool.description,
        searchHint: metadata?.searchHint,
        mcp: metadata?.mcpPresentation,
        deferred:
          configuredDeferred &&
          !(requestedMode === "local" && preCompactDiscoveredTools.has(tool.name)),
      };
    });
  const deferred = new Set(catalog.filter((tool) => tool.deferred).map((tool) => tool.name));
  const controlsAvailable =
    catalog.some((tool) => tool.name === TOOL_SEARCH_NAME) &&
    (requestedMode !== "local" || catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME));
  // 全部提升后仍需要控制入口处理后续目录变化，不能用剩余 deferred 数量关闭 Local。
  const enabled =
    requestedMode !== "off" &&
    (hasConfiguredDeferred ||
      Boolean(input.mcp?.pending.length) ||
      (requestedMode === "native" && hasRetainedDefinitions)) &&
    controlsAvailable;
  const mode: ResolvedToolSearchMode = enabled ? requestedMode : "off";
  return {
    catalog,
    controlsAvailable,
    deferred,
    enabled,
    requestedMode,
    mode,
    reason: enabled
      ? mode
      : requestedMode === "off"
        ? "provider_disabled"
        : !controlsAvailable
          ? "tool_unavailable"
          : "no_deferred_tools",
  };
}

export function buildToolExposure(input: ToolExposureInput) {
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  const history = collectToolSearchDelivery(input.entries);
  const { catalog, deferred, enabled, mode, reason, requestedMode } = resolveToolSearchCatalog(
    input,
    preCompactDiscoveredTools,
    history.retained.size > 0,
  );
  const native = resolveToolSearchMode(input.model, input.mode) === "native";
  const delivery: ToolSearchDelivery = { definitions: [], strippedReferences: [] };
  const stripped = new Set(history.stripped.keys());
  if (native) {
    discovered.clear();
    for (const name of preCompactDiscoveredTools) discovered.add(name);
    for (const reference of history.references) {
      const key = toolReferenceKey(reference.toolCallId, reference.toolName);
      if (stripped.has(key)) continue;
      const tool = input.tools.find((tool) => tool.name === reference.toolName);
      if (!tool && !history.retained.has(reference.toolName)) {
        stripped.add(key);
        delivery.strippedReferences.push(reference);
        continue;
      }
      discovered.add(reference.toolName);
    }
  }
  // 没有引用的 MCP 记录即常驻记录；Map 保持首次记录的顺序。
  const resident = [...history.definitions.values()].filter(
    ({ tool, mcp }) => mcp !== undefined && !history.retained.has(tool.name),
  );
  const residentByName = new Map(resident.map((record) => [record.tool.name, record.tool]));
  const tools: ModelToolContract[] = input.tools
    .filter((tool) => {
      if (tool.name === TOOL_SEARCH_NAME) return enabled;
      if (tool.name === DEFERRED_TOOL_CALL_NAME) return mode === "local";
      return (
        mode === "off" ||
        !deferred.has(tool.name) ||
        (mode === "native" && discovered.has(tool.name))
      );
    })
    .map((tool) => {
      const { deferLoading: _previous, ...contract } = tool;
      if (mode === "local" && tool.name === TOOL_SEARCH_NAME)
        return {
          ...contract,
          name: LOCAL_TOOL_SEARCH_NAME,
          description: LOCAL_TOOL_SEARCH_DESCRIPTION,
        };
      if (mode === "native" && deferred.has(tool.name))
        return { ...contract, ...history.retained.get(tool.name)?.tool, deferLoading: true };
      // 常驻 MCP 定义在首次交付时冻结。修复前 schema 变化后发送 live 定义，已发送的工具字节随之改变。
      const frozen = native ? residentByName.get(tool.name) : undefined;
      if (!frozen) return contract;
      const {
        description: _description,
        inputSchema: _inputSchema,
        strict: _strict,
        ...rest
      } = contract;
      return { ...rest, ...frozen };
    });
  if (native) {
    // 离开的常驻工具按记录顺序放回前一个仍在请求中的常驻工具之后；前面没有时放在第一个 MCP 工具之前。
    // 修复前离开即从请求中消失，模型看不到已交付的定义；仍在 registry、只是本轮被过滤的工具不放回。
    const isMcp = (name: string) =>
      history.definitions.get(name)?.mcp !== undefined ||
      input.registry?.get(name)?.metadata.mcpPresentation !== undefined;
    resident.forEach(({ tool }, index) => {
      if (tools.some((current) => current.name === tool.name) || input.registry?.get(tool.name))
        return;
      let at = -1;
      for (let previous = index - 1; previous >= 0 && at === -1; previous--)
        at = tools.findIndex((current) => current.name === resident[previous]!.tool.name);
      if (at === -1) {
        const first = tools.findIndex((current) => isMcp(current.name));
        at = (first === -1 ? tools.length : first) - 1;
      }
      tools.splice(at + 1, 0, { ...tool });
    });
  }
  if (mode === "native") {
    const insertionIndex = Math.max(tools.length - 1, 0);
    const departed: ModelToolContract[] = [];
    for (const { tool } of history.retained.values())
      if (!tools.some((current) => current.name === tool.name))
        departed.push({ ...tool, deferLoading: true });
    tools.splice(insertionIndex, 0, ...departed);
  }
  if (native) {
    const referenced = new Set(
      history.references
        .filter(
          (reference) => !stripped.has(toolReferenceKey(reference.toolCallId, reference.toolName)),
        )
        .map((reference) => reference.toolName),
    );
    for (const tool of tools) {
      const previous = history.definitions.get(tool.name);
      const mcp = input.registry?.get(tool.name)?.metadata.mcpPresentation;
      // deferred 工具只记录被引用的定义；compact 携带的名称没有引用，不算已交付。
      // 常驻 MCP 只在首次出现时记录，之后发送冻结的定义。
      if (deferred.has(tool.name) ? !referenced.has(tool.name) : !mcp || previous) continue;
      const { name, description, inputSchema, strict } = tool;
      const definition = {
        // JSON 会删除 undefined 字段；写入时保持同一形状，避免冷恢复后重复记录相同定义。
        tool: {
          name,
          ...(description === undefined ? {} : { description }),
          inputSchema,
          ...(strict === undefined ? {} : { strict }),
        },
        ...(mcp ? { mcp: { serverName: mcp.serverName, toolName: mcp.toolName } } : {}),
      };
      if (!isDeepStrictEqual(previous, definition)) delivery.definitions.push(definition);
    }
  }
  // Local 使用完整目录，且常驻控制工具以实际发送的定义覆盖原文案。
  // 已发送的公告只在请求模式为 off 时隐藏：该模式在会话内固定，隐藏结果不随目录变化而改写历史字节。
  const projection = projectToolReferences(
    input.entries,
    mode,
    mode === "local" ? [...input.tools, ...tools] : tools,
    deferred,
    requestedMode === "off",
    native ? stripped : undefined,
  );
  const context: ToolSearchExecutionContext = { enabled, mode, catalog, discovered };
  return {
    tools,
    ...projection,
    enabled,
    context,
    reason,
    delivery:
      delivery.definitions.length || delivery.strippedReferences.length ? delivery : undefined,
  };
}

// Bug 根因：请求投影中生成的公告晚于续写快照，恢复快照后会反复生成并累积到主历史。
// 公告只由正常提醒收集和 compact 重建调用，提交历史后才生成请求快照。
export function buildToolSearchAnnouncement(
  input: ToolExposureInput,
  compactDiscoveredTools?: ReadonlySet<string>,
): RuntimeAttachmentEntry | undefined {
  // Off 不需要公告或提升信息，保持关闭路径不扫描公告历史。
  if (resolveToolSearchMode(input.model, input.mode) === "off") return undefined;
  // Bug 根因：全量 metadata 与增量正文不一致，compact 保留尾部时会误以为旧名称仍在上下文。
  // 只从保留的公告事实恢复状态；恢复提示不算完整列名，原始列名被压缩后仍需补齐。
  const announced = new Set<string>();
  const listed = new Set<string>();
  const retracted = new Set<string>();
  let previousMcp: ToolSearchMcpState | undefined;
  const preCompactDiscoveredTools = new Set(compactDiscoveredTools);
  for (const entry of input.entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? [])
      preCompactDiscoveredTools.add(name);
    const delta = entry.metadata?.toolSearchAnnouncement;
    if (delta) {
      const readded = new Set(delta.readdedNames);
      for (const name of delta.addedNames) {
        announced.add(name);
        retracted.delete(name);
        if (!readded.has(name)) listed.add(name);
      }
      for (const name of delta.removedNames) announced.delete(name);
    }
    // 只有状态的公告没有名称增量，状态、撤销与恢复仍要计入，否则同一状态每步重播。
    const mcpDelta = entry.metadata?.toolSearchMcpDelta;
    for (const item of mcpDelta?.retractedTools ?? []) retracted.add(item.name);
    for (const name of mcpDelta?.restoredNames ?? []) retracted.delete(name);
    if (mcpDelta?.mcp) previousMcp = mcpDelta.mcp;
  }
  const history = collectToolSearchDelivery(input.entries);
  const { deferred, mode, enabled, controlsAvailable } = resolveToolSearchCatalog(
    input,
    preCompactDiscoveredTools,
    history.retained.size > 0,
  );
  // Bug 根因：控制工具不可用时仍生成公告、再在投影时隐藏，控制工具恢复后旧公告重新出现，
  // 改写了已发送的历史字节。现在控制工具不可用时不生成公告。
  if (!controlsAvailable) return undefined;
  const names = enabled ? [...deferred].sort() : [];
  const addedNames = names.filter((name) => !announced.has(name) || !listed.has(name));
  const readdedNames = names.filter((name) => !announced.has(name) && listed.has(name));
  // deferred 转 alwaysLoad 后工具仍然可用，删除必须对照完整的当前作用域目录。
  const available = new Set(input.tools.map((tool) => tool.name));
  const removedNames = [...announced].filter((name) => !available.has(name)).sort();
  // 只能在生成时判断哪些删除只是本轮隐藏：之后 registry 会变，请求投影按记下的名称渲染。
  const hiddenNames = removedNames.filter((name) => input.registry?.get(name) !== undefined);
  // compact 只重建工具名称上下文：不写 MCP 状态、不计算撤销与恢复。
  // Bug 根因：修复前 compact 写入空的 pending/failed，下一次普通采集把仍在的状态当作新事件重播。
  const compacting = compactDiscoveredTools !== undefined;
  const mcp: ToolSearchMcpState | undefined =
    input.mcp && !compacting
      ? {
          pending: [...input.mcp.pending].sort(),
          ...(input.mcp.needsAuth?.length ? { needsAuth: [...input.mcp.needsAuth].sort() } : {}),
          failed: [...input.mcp.failed].sort((left, right) =>
            compareMcpServerNames(left.name, right.name),
          ),
        }
      : undefined;
  const retractedTools: Array<{ name: string; cause: ToolSearchRetractionCause }> = [];
  if (!compacting)
    for (const [name, definition] of history.definitions) {
      if (available.has(name) || retracted.has(name)) continue;
      const source = definition.mcp?.serverName;
      const serverClass =
        source && input.mcp?.sources ? (input.mcp.sources[source] ?? "not_configured") : undefined;
      const cause = input.mcp?.deniedTools?.includes(name)
        ? "denied"
        : serverClass === "not_configured" || serverClass === "disabled"
          ? serverClass
          : undefined;
      if (cause) retractedTools.push({ name, cause });
    }
  retractedTools.sort((left, right) => left.name.localeCompare(right.name));
  const restoredNames = compacting
    ? []
    : [...retracted].filter((name) => available.has(name) && !deferred.has(name)).sort();
  // 来源索引不是模型事件；只比较实际可见的连接事实，内部范围变更由撤销计算负责。
  const statusChanged =
    mcp !== undefined &&
    (!isDeepStrictEqual(previousMcp?.pending ?? [], mcp.pending) ||
      !isDeepStrictEqual(previousMcp?.needsAuth ?? [], mcp.needsAuth ?? []) ||
      !isDeepStrictEqual(previousMcp?.failed ?? [], mcp.failed));
  if (
    !addedNames.length &&
    !removedNames.length &&
    !statusChanged &&
    !retractedTools.length &&
    !restoredNames.length
  )
    return undefined;
  const delta = { addedNames, removedNames, readdedNames };
  const hasNameChanges = addedNames.length > 0 || removedNames.length > 0;
  const mcpDelta = {
    ...(mcp ? { mcp } : {}),
    ...(retractedTools.length ? { retractedTools } : {}),
    ...(restoredNames.length ? { restoredNames } : {}),
  };
  return {
    kind: "attachment",
    content: renderToolSearchAnnouncement(delta, mode, hiddenNames, mcpDelta),
    metadata: {
      source: "tool_search_announcement",
      // 修复原因：只有状态的公告过去也写三个空数组，旧版本据此重渲染出空正文并报错
      // （System reminder body cannot be empty），降级后会话无法继续；现在只在名称有变化时写。
      ...(hasNameChanges ? { toolSearchAnnouncement: delta } : {}),
      ...(hiddenNames.length ? { toolSearchHiddenNames: hiddenNames } : {}),
      toolSearchMcpDelta: mcpDelta,
    },
  };
}
