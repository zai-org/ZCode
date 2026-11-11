/* eslint-disable max-lines -- Treemapping 需要在同一视图里组合活动树、矩形布局和详情区；等交互稳定后再拆分子组件。 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { FolderIcon, LoaderCircle } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  FileDisplayInline,
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTreemappingActivityModel,
  type TreemappingActivityEvent,
  type TreemappingActivityModel,
  type TreemappingFileActivity,
  type TreemappingFileKind,
} from "@/lib/treemappingActivity.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { TreemappingSidePaneSource } from "@/lib/workspaceSidePane.js";
import { useTreemappingConversationMessage } from "@/v4/useTreemappingConversationMessage.js";

interface TreemappingFileNode extends TreemappingFileActivity {
  type: "file";
}

interface TreemappingDirectoryNode {
  type: "directory";
  path: string;
  views: number;
  lastTouchedAt: number;
  children: TreemappingNode[];
  events: TreemappingActivityEvent[];
}

type TreemappingNode = TreemappingDirectoryNode | TreemappingFileNode;

interface TreemappingSummary {
  added: number;
  removed: number;
  views: number;
  files: number;
  written: number;
  modified: number;
  deleted: number;
  pending: number;
}

const VIEWED_ONLY_WEIGHT = 6;
const MIN_CHANGE_WEIGHT = 14;
const ROOT_PATH = ".";
const DIRECTORY_BASIS_SCALE = 64;
const DIRECTORY_HEIGHT_SCALE = 34;
const FILE_BASIS_SCALE = 52;
const FILE_HEIGHT_SCALE = 24;

function createDirectory(path: string): TreemappingDirectoryNode {
  return {
    type: "directory",
    path,
    views: 0,
    lastTouchedAt: 0,
    events: [],
    children: [],
  };
}

function getNodePathParts(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function findChildDirectory(
  directory: TreemappingDirectoryNode,
  path: string,
): TreemappingDirectoryNode | null {
  const child = directory.children.find(
    (node): node is TreemappingDirectoryNode => node.type === "directory" && node.path === path,
  );
  return child ?? null;
}

function ensureDirectory(
  root: TreemappingDirectoryNode,
  directoryPath: string,
): TreemappingDirectoryNode {
  if (!directoryPath || directoryPath === ROOT_PATH) {
    return root;
  }

  let current = root;
  const parts = getNodePathParts(directoryPath);
  let accumulatedPath = "";
  for (const part of parts) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
    const existing = findChildDirectory(current, accumulatedPath);
    if (existing) {
      current = existing;
      continue;
    }

    const next = createDirectory(accumulatedPath);
    current.children.push(next);
    current = next;
  }
  return current;
}

function getParentPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex > 0 ? path.slice(0, slashIndex) : ROOT_PATH;
}

function buildTree(
  model: TreemappingActivityModel,
  workspaceLabel: string,
): TreemappingDirectoryNode {
  const root = createDirectory(workspaceLabel || ROOT_PATH);
  const directoryByPath = new Map<string, TreemappingDirectoryNode>([[ROOT_PATH, root]]);

  for (const directoryActivity of model.directories) {
    const directory = ensureDirectory(root, directoryActivity.path);
    directoryByPath.set(directoryActivity.path, directory);
    directory.views += directoryActivity.views;
    directory.lastTouchedAt = Math.max(directory.lastTouchedAt, directoryActivity.lastTouchedAt);
    directory.events.push(...directoryActivity.events);
  }

  for (const file of model.files) {
    const parentDirectory = ensureDirectory(root, getParentPath(file.path));
    parentDirectory.children.push({
      ...file,
      type: "file",
    });
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreemappingDirectoryNode) {
  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    const leftDiff = summarizeNode(left).added + summarizeNode(left).removed;
    const rightDiff = summarizeNode(right).added + summarizeNode(right).removed;
    if (leftDiff !== rightDiff) {
      return rightDiff - leftDiff;
    }
    return left.path.localeCompare(right.path);
  });

  for (const child of node.children) {
    if (child.type === "directory") {
      sortTree(child);
    }
  }
}

function summarizeNode(node: TreemappingNode): TreemappingSummary {
  if (node.type === "file") {
    return {
      added: node.added,
      removed: node.removed,
      views: node.views,
      files: 1,
      written: node.kind === "written" ? 1 : 0,
      modified: node.kind === "modified" ? 1 : 0,
      deleted: node.kind === "deleted" ? 1 : 0,
      pending: node.pendingToolCallIds.length,
    };
  }

  return node.children.reduce<TreemappingSummary>(
    (summary, child) => {
      const childSummary = summarizeNode(child);
      return {
        added: summary.added + childSummary.added,
        removed: summary.removed + childSummary.removed,
        views: summary.views + childSummary.views,
        files: summary.files + childSummary.files,
        written: summary.written + childSummary.written,
        modified: summary.modified + childSummary.modified,
        deleted: summary.deleted + childSummary.deleted,
        pending: summary.pending + childSummary.pending,
      };
    },
    {
      added: 0,
      removed: 0,
      views: node.views,
      files: 0,
      written: 0,
      modified: 0,
      deleted: 0,
      pending: 0,
    },
  );
}

function getDiffCount(summary: Pick<TreemappingSummary, "added" | "removed">): number {
  return summary.added + summary.removed;
}

function getFileWeight(node: TreemappingFileNode): number {
  const diffCount = node.added + node.removed;
  if (diffCount > 0) {
    return Math.max(diffCount, MIN_CHANGE_WEIGHT);
  }
  return node.kind === "viewed" ? VIEWED_ONLY_WEIGHT : MIN_CHANGE_WEIGHT;
}

function getDirectoryWeight(node: TreemappingDirectoryNode): number {
  const summary = summarizeNode(node);
  const diffCount = getDiffCount(summary);
  if (diffCount > 0) {
    return Math.max(diffCount, MIN_CHANGE_WEIGHT);
  }

  return summary.views > 0 ? VIEWED_ONLY_WEIGHT : MIN_CHANGE_WEIGHT;
}

function getAreaSideWeight(weight: number): number {
  return Math.sqrt(Math.max(weight, 1));
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findNode(node: TreemappingNode, path: string): TreemappingNode | null {
  if (node.path === path) {
    return node;
  }

  if (node.type === "file") {
    return null;
  }

  for (const child of node.children) {
    const match = findNode(child, path);
    if (match) {
      return match;
    }
  }

  return null;
}

function findFirstFile(node: TreemappingNode): TreemappingFileNode | null {
  if (node.type === "file") {
    return node;
  }

  for (const child of node.children) {
    const file = findFirstFile(child);
    if (file) {
      return file;
    }
  }

  return null;
}

function getFileTone(kind: TreemappingFileKind): string {
  if (kind === "written") {
    return "border-success/50 bg-success/15 text-foreground";
  }
  if (kind === "modified") {
    return "border-warning/50 bg-warning/20 text-foreground";
  }
  if (kind === "deleted") {
    return "border-destructive/60 bg-destructive/15 text-foreground";
  }

  return "border-file-node-foreground/45 bg-file-node text-foreground";
}

function getChangeLabel(kind: TreemappingFileKind, formatMessage: (id: string) => string) {
  return formatMessage(`treemapping.change.${kind}`);
}

function getEventActionLabel(
  action: TreemappingActivityEvent["action"],
  formatMessage: (id: string) => string,
) {
  if (action === "write") {
    return getChangeLabel("written", formatMessage);
  }
  if (action === "modify") {
    return getChangeLabel("modified", formatMessage);
  }
  if (action === "delete") {
    return getChangeLabel("deleted", formatMessage);
  }
  return getChangeLabel("viewed", formatMessage);
}

export function TreemappingPane({
  activeTaskId,
  workspacePath,
  workspaceIdentity,
  source,
}: {
  activeTaskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  source: TreemappingSidePaneSource;
}) {
  const { intl } = useZCodeIntl();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // store 收尾：消息源从旧 zcodeSessionStore 迁 v4 conversation 投影 rows。
  // 旧 source.kind === "message"（按 legacy messageId 锚定某条消息）的入口随旧
  // ChatView 一起删除，这里统一取最后一个 assistant 轮的活动。
  const message: TaskChatMessage | null = useTreemappingConversationMessage({
    sessionId: activeTaskId,
    workspacePath,
    workspaceIdentity,
  });
  const model = useMemo(
    () => buildTreemappingActivityModel(message, workspacePath),
    [message, workspacePath],
  );
  const tree = useMemo(
    () => buildTree(model, getPathLeaf(workspacePath) || workspacePath),
    [model, workspacePath],
  );
  const selectedNode =
    (selectedPath ? findNode(tree, selectedPath) : null) ?? findFirstFile(tree) ?? tree;
  const handleSelectPath = useCallback(
    (path: string) => {
      logger.debug("[TreemappingPane] select node", {
        activeTaskId,
        path,
        previousPath: selectedNode.path,
        sourceKind: source.kind,
      });
      setSelectedPath(path);
    },
    [activeTaskId, selectedNode.path, source.kind],
  );
  const summary = summarizeNode(tree);
  const selectedSummary = summarizeNode(selectedNode);
  const isLive = source.kind === "current" || Boolean(message?.streaming);
  const formatMessage = (id: string) => intl.formatMessage({ id });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-ui-base font-medium">
              {intl.formatMessage({ id: "treemapping.title" })}
            </h2>
            <p className="truncate text-ui-base text-foreground-subtle">
              {source.kind === "current"
                ? intl.formatMessage({ id: "treemapping.scope.current" })
                : intl.formatMessage(
                    { id: "treemapping.scope.turn" },
                    {
                      turn: String(source.turnIndex !== undefined ? source.turnIndex + 1 : ""),
                    },
                  )}
            </p>
          </div>
          <span className="rounded-full border border-border px-2 py-0.5 text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: isLive ? "treemapping.badge.live" : "treemapping.badge.snapshot",
            })}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-ui-base">
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.files" })}
            value={summary.files}
          />
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.diff" })}
            value={<DiffCount added={summary.added} removed={summary.removed} />}
          />
          <SummaryCell
            label={intl.formatMessage({ id: "treemapping.summary.views" })}
            value={summary.views}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {summary.files === 0 ? (
          <EmptyState runningWithoutPathCount={model.runningWithoutPathCount} />
        ) : (
          <DirectoryBox
            node={tree}
            depth={0}
            selectedPath={selectedNode.path}
            onSelect={handleSelectPath}
            formatMessage={formatMessage}
          />
        )}
      </div>

      <div className="border-t border-border bg-card px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 flex-1 overflow-hidden">
            {selectedNode.type === "file" ? (
              <FileDisplayInline
                path={selectedNode.path}
                options={{
                  showFilePath: true,
                  className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                  fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                  filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                }}
              />
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="truncate font-mono text-ui-base font-medium text-foreground">
                  {selectedNode.path}
                </span>
              </span>
            )}
          </div>
          <DiffCount
            added={selectedSummary.added}
            removed={selectedSummary.removed}
            className="shrink-0 text-ui-base"
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
          <span>
            <span className="text-foreground-subtlest">
              {intl.formatMessage({ id: "treemapping.summary.views" })}:
            </span>{" "}
            <span className="font-mono text-foreground-subtle">{selectedSummary.views}</span>
          </span>
          {selectedNode.type === "file" ? (
            <span className="text-foreground-subtle">
              {getChangeLabel(selectedNode.kind, formatMessage)}
            </span>
          ) : (
            <span>
              <span className="text-foreground-subtlest">
                {intl.formatMessage({ id: "treemapping.summary.files" })}:
              </span>{" "}
              <span className="font-mono text-foreground-subtle">{selectedSummary.files}</span>
            </span>
          )}
        </div>
        {selectedNode.type === "file" && selectedNode.events.length > 0 ? (
          <div className="mt-2 max-h-24 overflow-auto rounded-lg border border-border bg-background/50">
            {selectedNode.events.slice(-4).map((event, index) => (
              <div
                key={`${event.toolCallId}-${event.action}-${index}`}
                className={cn(
                  "flex min-h-8 min-w-0 items-center justify-between gap-3 px-2 py-1.5 text-ui-base",
                  index > 0 && "border-t border-border/60",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {getEventActionLabel(event.action, formatMessage)}
                  </span>
                </span>
                <DiffCount added={event.added} removed={event.removed} className="shrink-0" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <div className="truncate text-ui-base text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

function DiffCount({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}>
      <span className={added > 0 ? "text-diff-added" : "text-foreground-subtlest"}>+{added}</span>
      <span className={removed > 0 ? "text-diff-removed" : "text-foreground-subtlest"}>
        -{removed}
      </span>
    </span>
  );
}

function EmptyState({ runningWithoutPathCount }: { runningWithoutPathCount: number }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 text-center">
      {runningWithoutPathCount > 0 ? (
        <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
      ) : null}
      <div className="text-ui-base font-medium">
        {intl.formatMessage({ id: "treemapping.empty.title" })}
      </div>
      <div className="max-w-64 text-ui-base leading-5 text-foreground-subtle">
        {runningWithoutPathCount > 0
          ? intl.formatMessage(
              { id: "treemapping.empty.running" },
              { count: String(runningWithoutPathCount) },
            )
          : intl.formatMessage({ id: "treemapping.empty.description" })}
      </div>
    </div>
  );
}

function DirectoryBox({
  node,
  depth,
  selectedPath,
  onSelect,
  formatMessage,
}: {
  node: TreemappingDirectoryNode;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
  formatMessage: (id: string) => string;
}) {
  const summary = summarizeNode(node);
  const weight = getDirectoryWeight(node);
  const style: CSSProperties = {
    // 目录本身没有状态色，但面积要反映子树聚合 diff。
    // 之前宽度按 weight 线性增长，视觉比例几乎只看宽度；这里用 sqrt(weight) 同时影响宽高，
    // 让矩形面积更接近活动权重，而不是把大改动目录挤成长条。
    flexGrow: weight,
    flexBasis:
      depth === 0
        ? undefined
        : `${clampSize(getAreaSideWeight(weight) * DIRECTORY_BASIS_SCALE, 160, 360)}px`,
    minHeight:
      depth === 0
        ? undefined
        : `${clampSize(getAreaSideWeight(weight) * DIRECTORY_HEIGHT_SCALE, 96, 220)}px`,
  };

  return (
    <section
      style={style}
      className={cn(
        // CSS 的 :hover 会同时命中所有祖先目录，子文件 hover 时父目录也会变色。
        // 目录容器只表达层级和选中态，悬停反馈留给当前文件块，避免父级被子级 hover 牵连。
        "flex min-w-0 flex-col rounded-lg border-2 border-border p-2 transition-colors duration-150",
        depth > 0 && "flex-1",
        selectedPath === node.path && "!border-primary",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.path);
      }}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2 text-ui-base">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="truncate font-mono">
            {depth === 0 ? node.path : getPathLeaf(node.path)}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-baseline gap-1.5 text-foreground-subtle">
          <DiffCount added={summary.added} removed={summary.removed} />
          {node.views > 0 ? <span className="font-mono">· {node.views}v</span> : null}
        </span>
      </div>
      <div className="flex min-h-20 flex-1 flex-wrap content-stretch items-stretch gap-2">
        {node.children.map((child) =>
          child.type === "directory" ? (
            <DirectoryBox
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              formatMessage={formatMessage}
            />
          ) : (
            <FileBox
              key={child.path}
              node={child}
              selected={selectedPath === child.path}
              onSelect={onSelect}
              formatMessage={formatMessage}
            />
          ),
        )}
      </div>
    </section>
  );
}

function FileBox({
  node,
  selected,
  onSelect,
  formatMessage,
}: {
  node: TreemappingFileNode;
  selected: boolean;
  onSelect: (path: string) => void;
  formatMessage: (id: string) => string;
}) {
  const diffCount = node.added + node.removed;
  const weight = getFileWeight(node);
  const recentlyTouched = Date.now() - node.lastTouchedAt < 2000;
  const descriptor = resolveFileDisplayDescriptor(node.path);
  const style: CSSProperties = {
    flexGrow: weight,
    flexBasis: `${clampSize(getAreaSideWeight(weight) * FILE_BASIS_SCALE, 88, 260)}px`,
    // 文件叶子用 sqrt(weight) 同时影响宽高，避免 diff 大小只体现在横向占比上。
    // 实际高度仍由父级 stretch 分配，这里只提供面积权重的下限信号。
    minHeight: `${clampSize(getAreaSideWeight(weight) * FILE_HEIGHT_SCALE, 58, 156)}px`,
  };

  return (
    <button
      type="button"
      title={`${node.path} · +${node.added}/-${node.removed} · ${node.views} views`}
      aria-pressed={selected}
      data-selected={selected ? "true" : undefined}
      style={style}
      className={cn(
        "relative min-w-20 flex-1 self-stretch rounded-md border-2 p-2 text-left text-ui-base transition-colors duration-150 hover:border-primary/60 focus-visible:border-primary focus-visible:outline-none",
        "animate-in fade-in zoom-in-95",
        getFileTone(node.kind),
        // 最近触达高亮之前使用 ring（box-shadow），点击后的 focus reset 会把它清掉；
        // 改为边框色后，近期触达、hover、选中都走同一种视觉语言。
        recentlyTouched && !selected && "border-primary/60",
        // 点击后文件块本身会获得 focus，而全局 focus reset 会用 !important 清掉
        // outline/box-shadow；Tailwind ring 也是 box-shadow，所以选中态不能继续依赖 ring。
        selected && "!border-primary",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.path);
      }}
    >
      {node.pendingToolCallIds.length > 0 ? (
        <span className="absolute right-2 top-2 size-2 animate-pulse rounded-full bg-current opacity-80" />
      ) : null}
      <span className="flex h-full min-h-0 flex-col justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-0.5 pr-3 leading-5">
          <span className="flex min-w-0 items-center gap-1.5">
            <FileDisplayIcon
              src={descriptor.fileIconSrc}
              size={14}
              className="size-3.5 shrink-0 opacity-90"
            />
            <span
              className={cn(
                "truncate font-mono font-medium",
                node.kind === "deleted" && "line-through",
              )}
            >
              {descriptor.fileName}
            </span>
          </span>
          {descriptor.filePath ? (
            <span className="truncate font-mono text-ui-base text-foreground-subtle opacity-90">
              {descriptor.filePath}
            </span>
          ) : null}
        </span>
        <span className="space-y-0.5 leading-5">
          <span className="block truncate">{getChangeLabel(node.kind, formatMessage)}</span>
          <span className="block truncate opacity-85">
            {diffCount > 0 ? (
              <DiffCount added={node.added} removed={node.removed} />
            ) : (
              <span className="font-mono">{node.views} views</span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
