import type {
  ComposerMentionGroup,
  ExtensionLauncherViewItem,
  ExtensionProblem,
  ExtensionSlotEntry,
  ExtensionSlotsSources,
  ExtensionViewSidePaneTab,
  FileViewerRoute,
  NavPrimaryItem,
} from "@/extension-slots/contract.js";
import {
  findStaticView,
  isExtensionTargetKind,
  mergeSlotValues,
  workspaceScopeKey,
  type ExtensionRunStatus,
  type ExtensionSlotId,
  type ExtensionStaticTable,
  type LocalizedText,
  type ResolvedScope,
  type SlotScopeKey,
  type StaticView,
  type WorkspaceRef,
} from "@zcode/shared/extension-host";

// 纯函数：静态表 ⊕ 运行状态 ⊕ 动态值 → 插槽要渲染的条目（docs/plugins/extension-host.md §16.1）。
// 三份数据各有唯一 owner（静态表：Window Host；运行状态与动态值：扩展进程；扩展进程状态：Main），
// 这里只合并最近一份，不持有状态。

export interface SlotRenderScope {
  workspace: WorkspaceRef | null;
  sessionId: string | null;
}

/** 渲染时合并的作用域键，从低到高：App → 工作区 → 会话。 */
export function slotScopeKeys(scope: SlotRenderScope): SlotScopeKey[] {
  const keys: SlotScopeKey[] = ["app"];
  if (scope.workspace) keys.push(workspaceScopeKey(scope.workspace));
  if (scope.sessionId) keys.push(`session:${scope.sessionId}`);
  return keys;
}

function runStatusOf(
  sources: ExtensionSlotsSources,
  pluginId: string,
): ExtensionRunStatus | undefined {
  return sources.snapshot?.extensions.find((entry) => entry.pluginId === pluginId);
}

/**
 * 某个插槽当前要显示的条目，按 order、id 排序。静态条目在扩展进程停止时照常返回：
 * target 在扩展进程里（view、command）的条目带 hostStopped，由插槽组件显示「扩展已停止」与重新加载。
 * 激活失败、等待激活确认或选择不激活的扩展的条目不返回（启动页另有一行）；动态值 visible=false 的条目不返回。
 */
export function selectSlotEntries(
  sources: ExtensionSlotsSources,
  slot: ExtensionSlotId,
  scope: SlotRenderScope,
): ExtensionSlotEntry[] {
  const table = sources.table;
  if (!table) return [];
  const keys = slotScopeKeys(scope);
  const hostStopped = sources.status?.state === "stopped";
  const entries: ExtensionSlotEntry[] = [];
  for (const plugin of table.plugins) {
    for (const item of plugin.slotItems) {
      if (item.slot !== slot) continue;
      const extensionTarget = isExtensionTargetKind(item.target.kind);
      if (extensionTarget && runStatusOf(sources, plugin.pluginId)?.state === "failed") continue;
      // 商店安装后等待激活确认或用户选择不激活（§17.7）：扩展进程里没有它，view / command 条目打不开。
      if (extensionTarget && plugin.activation) continue;
      const value = mergeSlotValues(sources.snapshot?.values[item.id], keys);
      if (value.visible === false) continue;
      entries.push({
        item,
        pluginName: plugin.name,
        value,
        hostStopped: extensionTarget && hostStopped,
      });
    }
  }
  return entries.sort((a, b) => a.item.order - b.item.order || a.item.id.localeCompare(b.item.id));
}

/** composer.status 只在设置了 text 时显示（扩展进程停止时动态值随之清空，条目也就不显示）。 */
export function selectComposerStatusEntries(
  sources: ExtensionSlotsSources,
  scope: SlotRenderScope,
): ExtensionSlotEntry[] {
  return selectSlotEntries(sources, "composer.status", scope).filter(({ value }) =>
    Boolean(value.text),
  );
}

/**
 * 输入框里调命令的作用域：当前会话（草稿为预热会话）；没有会话时为工作区；都没有时为 App。
 * composer.status 的点击与 composer.mention 的查询共用。
 */
export function composerCommandScope(
  workspace: WorkspaceRef | null,
  sessionId: string | null,
): ResolvedScope {
  if (workspace && sessionId) return { kind: "session", workspace, sessionId };
  if (workspace) return { kind: "workspace", workspace };
  return { kind: "app" };
}

/** composer.mention 的一个条目：静态声明 ⊕ 组名 ⊕ 扩展进程是否停止。 */
export type ComposerMentionEntry = Pick<
  ComposerMentionGroup,
  "itemId" | "pluginId" | "pluginName" | "title"
> & {
  target: { kind: "command" | "tool"; id: string };
  hostStopped: boolean;
};

/**
 * composer.mention 的条目（§16.6），按 order、id 排序。组名：条目标题 → 命令标题（command）→ 插件名。
 * 动态值 visible=false 的条目、激活失败的扩展的 command 条目不返回（selectSlotEntries）。
 */
export function selectComposerMentionEntries(
  sources: ExtensionSlotsSources,
  scope: SlotRenderScope,
): ComposerMentionEntry[] {
  return selectSlotEntries(sources, "composer.mention", scope).flatMap(
    ({ item, pluginName, hostStopped }) => {
      const kind = item.target.kind;
      if (kind !== "command" && kind !== "tool") return [];
      const extension = sources.table?.plugins.find(
        (plugin) => plugin.pluginId === item.pluginId,
      )?.extension;
      const command =
        kind === "command" && extension?.state === "ok"
          ? extension.commands.find((candidate) => candidate.id === item.target.id)
          : undefined;
      return [
        {
          itemId: item.id,
          pluginId: item.pluginId,
          pluginName,
          title: item.title ?? command?.title ?? pluginName,
          target: { kind, id: item.target.id },
          hostStopped,
        },
      ];
    },
  );
}

/** 启动页的视图条目：标题与图标缺省时取视图声明。 */
export function selectLauncherViewItems(
  sources: ExtensionSlotsSources,
  scope: SlotRenderScope,
): ExtensionLauncherViewItem[] {
  return selectSlotEntries(sources, "sidePane.launcher", scope).flatMap(
    ({ item, pluginName, value, hostStopped }) => {
      const view = findStaticView(sources.table, item.target.id);
      if (!view) return [];
      const icon = item.icon ?? view.icon;
      return [
        {
          itemId: item.id,
          viewId: view.id,
          title: item.title ?? view.title,
          ...(icon ? { icon } : {}),
          pluginName,
          ...(value.tooltip ? { tooltip: value.tooltip } : {}),
          hostStopped,
        },
      ];
    },
  );
}

/**
 * 启动页问题行：每个插件最多一行。优先级：清单的 extension 非法 / 不兼容 → 激活失败 →
 * 有不可用的插槽条目（显示第一条的字段路径）。扩展进程停止时照常显示（数据来自静态表）。
 */
export function selectExtensionProblems(sources: ExtensionSlotsSources): ExtensionProblem[] {
  const problems: ExtensionProblem[] = [];
  for (const plugin of sources.table?.plugins ?? []) {
    const base = {
      pluginId: plugin.pluginId,
      name: plugin.name,
      ...(plugin.version ? { version: plugin.version } : {}),
    };
    const extension = plugin.extension;
    if (extension?.state === "invalid") {
      problems.push({ ...base, state: "invalid", reason: extension.reason, path: extension.path });
      continue;
    }
    if (extension?.state === "incompatible") {
      problems.push({ ...base, state: "incompatible", reason: extension.reason });
      continue;
    }
    const run = runStatusOf(sources, plugin.pluginId);
    if (run?.state === "failed") {
      problems.push({ ...base, state: "failed", reason: run.reason ?? "" });
      continue;
    }
    const first = plugin.problems[0];
    if (first) problems.push({ ...base, state: "invalid", reason: first.reason, path: first.path });
  }
  return problems.sort((a, b) => a.name.localeCompare(b.name));
}

/** 静态表里全部合法、兼容扩展的视图。 */
export function selectStaticViews(table: ExtensionStaticTable | null): StaticView[] {
  return (table?.plugins ?? []).flatMap((plugin) =>
    plugin.extension?.state === "ok" ? plugin.extension.views : [],
  );
}

/** 插件 id 按码点比较：排序结果与运行环境的语言无关（§16.5「字典序」）。 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * nav.primary 的条目（§16.4）。导航是 App 级：动态值只按 App 作用域合并。
 * 标题缺省时取视图标题（view target），再缺省取插件名；view target 找不到视图声明时不显示。
 */
export function selectNavPrimaryItems(sources: ExtensionSlotsSources): NavPrimaryItem[] {
  return selectSlotEntries(sources, "nav.primary", { workspace: null, sessionId: null }).flatMap(
    ({ item, pluginName, value, hostStopped }) => {
      const kind = item.target.kind;
      if (kind !== "view" && kind !== "surface") return [];
      const view = kind === "view" ? findStaticView(sources.table, item.target.id) : undefined;
      if (kind === "view" && !view) return [];
      const icon = item.icon ?? view?.icon;
      return [
        {
          itemId: item.id,
          pluginId: item.pluginId,
          pluginName,
          title: item.title ?? view?.title ?? pluginName,
          ...(icon ? { icon } : {}),
          ...(value.tooltip ? { tooltip: value.tooltip } : {}),
          // 未读标记（§18.1 H11）：扩展进程停止时快照清空，标记随之消失。
          ...(value.badge !== undefined ? { badge: value.badge } : {}),
          target: { kind, id: item.target.id },
          hostStopped,
        },
      ];
    },
  );
}

/** 按当前语言解析标题后排序；标题相同时按插件 id。 */
export function sortNavPrimaryItems(
  items: readonly NavPrimaryItem[],
  locale: string,
): Array<NavPrimaryItem & { label: string }> {
  return items
    .map((item) => ({
      ...item,
      label: resolveLocalizedText(item.title, locale) || item.pluginName,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, locale) || compareIds(a.pluginId, b.pluginId));
}

/**
 * file.viewer 的查找（§16.5）：文件名（小写）以条目的某个扩展名结尾就算匹配。每个插件取第一个
 * 匹配的条目（selectSlotEntries 已按 order、id 排序）；多个插件时取插件 id 字典序第一个，
 * `others` 是落选的插件 id（冲突日志用）。扩展进程已停止时 view 条目打不开，不参加选择。
 */
export function selectFileViewer(
  sources: ExtensionSlotsSources,
  fileName: string,
  workspace: WorkspaceRef | null,
): { route: FileViewerRoute; others: string[] } | null {
  const name = fileName.toLowerCase();
  const byPlugin = new Map<string, FileViewerRoute>();
  for (const { item, hostStopped } of selectSlotEntries(sources, "file.viewer", {
    workspace,
    sessionId: null,
  })) {
    if (byPlugin.has(item.pluginId) || hostStopped) continue;
    const kind = item.target.kind;
    if (kind !== "view" && kind !== "surface") continue;
    const matches = (item.fileExtensions ?? []).some(
      (extension) => name.length > extension.length && name.endsWith(extension),
    );
    if (!matches) continue;
    const view = kind === "view" ? findStaticView(sources.table, item.target.id) : undefined;
    if (kind === "view" && !view) continue;
    byPlugin.set(item.pluginId, {
      itemId: item.id,
      pluginId: item.pluginId,
      target: { kind, id: item.target.id },
      ...(view ? { view } : {}),
    });
  }
  const [winner, ...others] = [...byPlugin.keys()].sort(compareIds);
  if (!winner) return null;
  return { route: byPlugin.get(winner)!, others };
}

/**
 * file.viewer 的 view 查看器标签（§16.5）：每个文件一个，id 带工作区相对路径，同一文件再次打开时聚焦它；
 * 标题是文件名；input 交给视图实例的 view.input。path 是工作区相对的 posix 路径。
 */
export function buildFileViewerTab(
  view: StaticView,
  file: { path: string; workspace: WorkspaceRef },
): ExtensionViewSidePaneTab {
  return {
    id: `extension-view:${view.id}:file:${file.path}`,
    type: "extension-view",
    viewId: view.id,
    title: file.path.split("/").pop() || file.path,
    ...(view.icon ? { icon: view.icon } : {}),
    input: { kind: "file", path: file.path, workspace: file.workspace },
  };
}

/** 标题是字符串或按语言的映射：精确语言 → 同主语言 → en-US → 第一项。 */
export function resolveLocalizedText(text: LocalizedText | undefined, locale: string): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  const language = locale.split("-")[0];
  return (
    text[locale] ??
    Object.entries(text).find(([key]) => key.split("-")[0] === language)?.[1] ??
    text["en-US"] ??
    Object.values(text)[0] ??
    ""
  );
}
