import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { useSubagents } from "@/hooks/useSubagents.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
/* oxlint-disable eslint(max-lines) -- 侧栏 Tab trigger 集中维护拖拽、上下文菜单与各类图标；本次只增加 Browser 驻留态测试属性，不为行数拆散既有交互。 */
import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FolderOpenIcon,
  PuzzleIcon,
  BotMessageSquareIcon,
  BugIcon,
  FileIcon,
  FileCode2Icon,
  FileDiffIcon,
  MapIcon,
  MessageSquareTextIcon,
  ListTreeIcon,
  PlugIcon,
  NotepadTextIcon,
  PackageIcon,
  PaletteIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WaypointsIcon,
  Workflow as WorkflowIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { Button } from "@/components/ui/button.js";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";
import { resolveExtensionIcon, resolveLocalizedText } from "@/extension-slots/index.js";

// tab 默认按 156px 等宽排列；空间不足时以相同 grow/shrink 参数平均收缩到 60px，
// 之后由外层滚动容器承接溢出，避免标题长度改变每个 tab 的宽度。
// 标题没有独立上限时，长网页标题会持续撑宽 tab；主 tab 与拖拽浮层都只钳制标题本体，避免挤占图标、徽标和关闭按钮。
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
}) {
  const wasDraggingRef = useRef(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const normalizedTransform = transform
    ? {
        ...transform,
        // 横向 tabs 是固定高度控件，拖拽时只允许水平位移。
        // dnd-kit 会携带 scale 信息；这里钳回 1，避免 tab 被临时压缩或拉伸。
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  if (isDragging) {
    wasDraggingRef.current = true;
  }

  const tabTrigger = (
    <TabsTrigger value={tab.id} asChild>
      <div
        ref={setNodeRef}
        data-side-pane-tab-id={tab.id}
        data-browser-tab-residency={"residency" in tab ? tab.residency : undefined}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          // side pane tab 里有独立关闭按钮，外层不能再渲染成 button。
          // 否则会形成 button 嵌套 button，生产包里浏览器会修正 DOM，导致 tab/close/drag 事件错位。
          // 这里用 TabsTrigger asChild 承载 Radix 状态，真实 DOM 改成 div，关闭按钮继续保持原生 button。
          event.preventDefault();
        }}
        onClick={(event) => {
          // 浏览器可能同时派发 middle-click 的 click/auxclick；先在 click 阶段拦截，
          // 避免关闭前把 inactive tab 激活。
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            event.preventDefault();
            return;
          }

          onActivateTab(tab.id);
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;

          // Side Pane tab 之前只有左键激活和显式关闭按钮，middle-click 会触发
          // 浏览器默认自动滚动，且部分浏览器还会先触发 tab 激活。统一在 auxclick 阶段
          // 取消默认行为并关闭目标 tab，保持原 active tab 不变。
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
        className={cn(
          "group relative inline-flex items-center gap-1 [corner-shape:superellipse(1.5)]",
          "flex-[1_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle !rounded-lg",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          // TabsTrigger asChild 经过 ContextMenuTrigger 再包一层后，Radix 的 active 标记不会稳定落到真实 tab div。
          // 这里用受控的 isActive 同步补齐 data-active / data-state，保证 Tailwind 的 active variant 能命中。
          "data-active:!bg-selected data-active:text-foreground data-active:shadow-[0_1px_2px_-1px_rgb(0_0_0/0.08)]",
          "cursor-default",
          isDragging && "cursor-grabbing shadow-md",
        )}
      >
        <SidePaneTabItemContent
          tab={tab}
          title={title}
          diffBadgeLabel={diffBadgeLabel}
          closeVisible={isActive}
          revealCloseOnHover
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeTabLabel}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCloseTab(tab.id);
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    </TabsTrigger>
  );

  return (
    <ContextMenu>
      <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
        <ContextMenuTrigger asChild>{tabTrigger}</ContextMenuTrigger>
      </SidePaneTabTitleTooltip>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onSelect={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SidePaneTabDragOverlay({
  tab,
  title,
  diffBadgeLabel,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex !h-7 w-39 min-w-15 max-w-39 items-center justify-start gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-selected px-1.5 pr-1 text-ui-base font-medium text-foreground shadow-md",
        "cursor-grabbing [corner-shape:superellipse(1.5)]",
      )}
    >
      <SidePaneTabItemContent tab={tab} title={title} diffBadgeLabel={diffBadgeLabel} />
    </div>
  );
}

function SidePaneTabItemContent({
  tab,
  title,
  diffBadgeLabel,
  closeVisible = false,
  revealCloseOnHover = false,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
  closeVisible?: boolean;
  revealCloseOnHover?: boolean;
}) {
  return (
    <span
      data-side-pane-tab-content=""
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]",
        closeVisible ? "[--tab-fade-offset:1.25rem]" : "[--tab-fade-offset:0px]",
        revealCloseOnHover &&
          "group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SidePaneTabIcon tab={tab} />
      </span>
      <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
        {title}
      </span>
      {isDiffPreviewTab(tab) ? (
        <span className="ml-0.5 shrink-0 rounded-full border border-border bg-surface px-1 py-0 text-ui-xs leading-3 text-foreground-subtle">
          {diffBadgeLabel}
        </span>
      ) : null}
    </span>
  );
}

function isDiffPreviewTab(tab: WorkspaceSidePaneTab): boolean {
  return (
    tab.type === "code-viewer" &&
    (tab.source.type === "patch" || tab.source.type === "multi-file-diff")
  );
}

export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  if (tab.type === "file-manager") return <FolderOpenIcon className="size-3.5" />;
  // plan-detail tab 由 switch-mode（ExitPlanMode）工具调用卡片打开，来源卡片
  // 用 NotepadTextIcon；tab 必须与来源一致，避免点击后图标跳变。不用 ListChecksIcon：
  // 那会与状态面板 Todo section 撞图标，语义上也偏向 todo 而非计划方案文档。
  if (tab.type === "plan-detail") {
    return <NotepadTextIcon className="size-3.5" />;
  }
  if (tab.type === "plugin-ui") {
    return <PlugIcon className="size-3.5" />;
  }
  if (tab.type === "extension-view") {
    // 只渲染白名单里的图标，其余为通用插件图标（DESIGN.md「Extension slots」）。
    const Icon = resolveExtensionIcon(tab.icon);
    return <Icon className="size-3.5" />;
  }
  if (tab.type === "extension-logs") return <ScrollTextIcon className="size-3.5" />;
  // 同一条约定：来源卡片（CreateWorkflow）用 lucide Workflow，tab 必须与它一致。
  if (tab.type === "workflow-run") {
    return <WorkflowIcon className="size-3.5" />;
  }
  // run 目录与单个 run 的详情必须能一眼分开（一页名单 vs 一次运行），所以借 subagent 目录
  // 的同一枚「目录」图标——两个目录页在 tab 条上因此同形，正是它们的共同点。
  if (tab.type === "workflow-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }
  // actor transcript 是「一个 actor 的对话记录」：既不是整次运行（Workflow），也不是子智能体
  // 会话（Bot）。三者在 tab 条上必须能一眼分开——它们的可见性与回收语义都不同。
  if (tab.type === "workflow-actor-session") {
    return <BotMessageSquareIcon className="size-3.5" />;
  }
  // 脚本 transcript 与脚本药丸同一枚字形（终端）：来源与 tab 一致，点开不跳变。
  if (tab.type === "workflow-workspace") {
    return <TerminalIcon className="size-3.5" />;
  }
  // 产物 tab 的图标**按 kind 变**是错的：tab 条上的图标要在打开前就稳定（tab 从内存恢复时
  // 元数据还没读回来）。所以用一枚固定的「交付物」图标，kind 的区分留给 tab 内部的头部与卡片。
  if (tab.type === "workflow-artifact") {
    return <PackageIcon className="size-3.5" />;
  }
  if (tab.type === "selection-side-chat") {
    return <MessageSquareTextIcon className="size-3.5" />;
  }
  if (tab.type === "subagent-session") {
    return <SubagentTabAvatar tab={tab} />;
  }

  if (tab.type === "subagent-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }

  if (tab.type === "browser") {
    return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
  }

  if (tab.type === "browser-permissions") {
    return <ShieldCheckIcon className="size-3.5" />;
  }

  if (tab.type === "git") {
    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.type === "treemapping") {
    return <MapIcon className="size-3.5" />;
  }

  if (tab.type === "whiteboard") {
    return <PaletteIcon className="size-3.5" />;
  }

  if (tab.type === "model-trajectory") {
    return <WaypointsIcon className="size-3.5" />;
  }

  if (tab.type === "new-tab") return <FileIcon className="size-3.5" />;
  if (tab.type === "plugin-market") return <PuzzleIcon className="size-3.5" />;

  if (tab.type === "developer-tools") {
    return <BugIcon className="size-3.5" />;
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return <SquareTerminalIcon className="size-3.5" />;
  }

  // 同 getSidePaneTabTitle——browser-use tab 无 source，若不在此拦截会 fallthrough
  // 到下方 `tab.source.type` 读 undefined.type 崩溃。
  // agent 导航后由 <webview> favicon 事件回填 faviconUrl，与 human browser tab 一致地展示真实图标；
  // 缺省（about:blank/未取到）回退地球图标。
  if (tab.type === "browser-use") {
    return <BrowserUseTabIcon tab={tab} />;
  }

  if (tab.source.type === "patch") {
    const fileDisplayTarget = getPatchFileDisplayTarget(tab.source);
    if (fileDisplayTarget) {
      const descriptor = resolveFileDisplayDescriptor(fileDisplayTarget);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.type === "multi-file-diff") {
    if (tab.source.path) {
      const descriptor = resolveFileDisplayDescriptor(tab.source.path);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.path) {
    const descriptor = resolveFileDisplayDescriptor(tab.source.path);
    return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
  }

  return <FileCode2Icon className="size-3.5" />;
}

function isUsablePatchFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsablePatchFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsablePatchFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

function getPatchHeaderFileDisplayTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsablePatchFileTarget(nextFileTarget)) {
        // 部分 file diff source 没有带 path，title 也可能只是“Diff”。
        // 这里从 unified diff 的文件头里取真实文件名，再交给 fileDisplay 解析文件类型图标。
        return nextFileTarget;
      }
    }
  }

  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsablePatchFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

export function getPatchFileDisplayTarget(source: {
  path?: string;
  title: string;
  patch: string;
}): string | null {
  if (isUsablePatchFileTarget(source.path)) {
    return source.path;
  }

  const patchHeaderTarget = getPatchHeaderFileDisplayTarget(source.patch);
  if (patchHeaderTarget) {
    return patchHeaderTarget;
  }

  // 新增/删除文件的 diff 有时会把 source.path 传成 /dev/null。
  // /dev/null 不是业务文件名，直接用于图标识别会固定落到 document；这里只在路径无效时回退 title。
  return isUsablePatchFileTarget(source.title) ? source.title : null;
}

export function getSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
  /** 扩展视图的标题按语言映射，渲染时按当前界面语言取。 */
  locale = "en-US",
): string {
  if (tab.type === "plan-detail") {
    return formatMessage({ id: "planTool.panel.planTab" });
  }
  // 展示名是卡片打开时冻结的兜底；run 身份始终是 runId（tab id 里那一段）。
  if (tab.type === "workflow-run") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowRun" });
  }
  if (tab.type === "workflow-directory") {
    return formatMessage({ id: "sidePane.workflowDirectory" });
  }
  // 实例序号必须留在标题里：同一车道族的实例共用脚本里那一个名字，少了序号 tab 条上就是
  // 两个无法区分的「reviewer」。拼接而不是本地化模板——照 selection-side-chat 的先例。
  if (tab.type === "workflow-actor-session") {
    const name = tab.actorName?.trim() || formatMessage({ id: "sidePane.workflowActor" });
    return `${name} #${tab.ordinal}`;
  }
  // 标题是 run 名（一个 run 一份脚本 transcript）；类型标签「Script steps / 脚本步骤」在 tooltip 里。
  if (tab.type === "workflow-workspace") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowScript" });
  }
  // 展示名是打开时冻结的兜底；产物身份始终是 (runId, artifactId)（tab id 里那两段）。
  if (tab.type === "workflow-artifact") {
    return (
      tab.title?.trim() || tab.artifactId || formatMessage({ id: "sidePane.workflowArtifact" })
    );
  }
  if (tab.type === "selection-side-chat") {
    return `${formatMessage({ id: "sidePane.selectionChat" })} ${tab.ordinal}`;
  }
  if (tab.type === "subagent-session") {
    return tab.title?.trim() || formatMessage({ id: "sidePane.subagent" });
  }

  if (tab.type === "subagent-directory") {
    return formatMessage({ id: "sidePane.subagentDirectory" });
  }

  if (tab.type === "browser") {
    const pageTitle = tab.title?.trim();
    return pageTitle || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "browser-permissions") {
    return formatMessage({ id: "browser.permission.settings" });
  }

  if (tab.type === "git") {
    return formatMessage({ id: "sidePane.review" });
  }

  if (tab.type === "treemapping") {
    return formatMessage({ id: "treemapping.title" });
  }

  if (tab.type === "whiteboard") {
    return tab.title || formatMessage({ id: "whiteboard.title" });
  }

  if (tab.type === "model-trajectory") {
    return tab.title?.trim() || formatMessage({ id: "modelTrajectory.title" });
  }

  if (tab.type === "new-tab") return formatMessage({ id: "sidePane.newTab" });
  if (tab.type === "plugin-market") return formatMessage({ id: "workspace.openPluginsSettings" });

  if (tab.type === "developer-tools") {
    return formatMessage({ id: "developerTools.title" });
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return tab.title || formatMessage({ id: "terminal.title" });
  }

  // browser-use tab 之前未在此分派，会 fallthrough 到底部 `tab.source.title`，
  // 而 browser-use tab 无 source 字段 → 读 undefined.title 触发 React 崩溃（整棵 workspace 子树挂掉）。
  // 用页面标题（agent 导航后由 getState 回填），缺省复用 browser.title 文案。
  if (tab.type === "browser-use") {
    return tab.title?.trim() || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "plugin-ui") {
    return tab.title.trim() || formatMessage({ id: "sidePane.pluginUi" });
  }

  if (tab.type === "extension-view") {
    return (
      resolveLocalizedText(tab.title, locale) || formatMessage({ id: "extensions.view.title" })
    );
  }

  if (tab.type === "extension-logs") return formatMessage({ id: "extensions.logs.title" });

  if (tab.type === "file-manager")
    return tab.source?.title || formatMessage({ id: "fileManager.title" });
  return tab.source.title || formatMessage({ id: "codeViewer.title" });
}

function SubagentTabAvatar({
  tab,
}: {
  tab: Extract<WorkspaceSidePaneTab, { type: "subagent-session" }>;
}) {
  const { agents } = useSubagents(tab.workspacePath, ZCODE_AGENT_PROVIDER, tab.workspaceIdentity);
  const key = tab.subagentType.trim().toLowerCase();
  const color = agents.find(
    (agent) => agent.name.trim().toLowerCase() === key || agent.id.trim().toLowerCase() === key,
  )?.color;
  return (
    <WorkflowAgentFace
      avatarIndex={undefined}
      name={tab.subagentType}
      color={color ? SUBAGENT_WORKFLOW_COLOR[color] : undefined}
      status={undefined}
      idle
      // 头像默认最小尺寸为 20px；紧凑标签必须同时覆盖，否则 size 不生效。
      className="size-3.5 min-h-3.5! min-w-3.5!"
    />
  );
}
