import { GitGraph, GitMergeIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState, type UIEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitGraphCommitDetail } from "./GitGraphCommitDetail.js";
import { formatCommitTime, getRefIcon, getShortHash } from "./GitGraphDisplay.js";
import { type GitGraphCommit, type GitGraphLayoutPath, layoutGitGraph } from "./layout.js";

export interface GitGraphPaneProps {
  commits: readonly GitGraphCommit[];
  hasMore?: boolean;
  loadingMore?: boolean;
  refreshing?: boolean;
  selectedCommitHash: string | null;
  onSelectCommit: (hash: string) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
}

const laneStrokeClasses = [
  "stroke-git-descendant",
  "stroke-git-renamed",
  "stroke-git-added",
  "stroke-git-modified",
];

const laneFillClasses = [
  "fill-git-descendant",
  "fill-git-renamed",
  "fill-git-added",
  "fill-git-modified",
];

const NODE_RADIUS = 4;
const SELECTED_NODE_RADIUS = 4.25;
const SELECTED_RING_RADIUS = 5.5;
const LOAD_MORE_SCROLL_THRESHOLD_PX = 96;
// 单泳道图形宽度比 Graph 表头短，保留最小列宽避免表头被挤压。
const GRAPH_COLUMN_MIN_WIDTH_PX = 56;

function getLaneStrokeClass(laneIndex: number): string {
  return laneStrokeClasses[laneIndex % laneStrokeClasses.length]!;
}

function getLaneFillClass(laneIndex: number): string {
  return laneFillClasses[laneIndex % laneFillClasses.length]!;
}

function getTableColumnStyle() {
  return {
    gridTemplateColumns: "minmax(260px,1fr) 128px 112px 84px",
  };
}

function isPathRelated(path: GitGraphLayoutPath, hash: string | null): boolean {
  return Boolean(hash && path.relatedHashes.includes(hash));
}

export function GitGraphPane({
  commits,
  hasMore = false,
  loadingMore = false,
  refreshing = false,
  selectedCommitHash,
  onSelectCommit,
  onLoadMore,
  onRefresh,
}: GitGraphPaneProps) {
  const { intl, locale } = useZCodeIntl();
  const [hoveredCommitHash, setHoveredCommitHash] = useState<string | null>(null);
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const layout = useMemo(() => layoutGitGraph(commits), [commits]);
  const highlightedHash = hoveredCommitHash;
  const tableColumnStyle = getTableColumnStyle();
  const graphColumnWidth = Math.max(layout.width + 12, GRAPH_COLUMN_MIN_WIDTH_PX);
  const expandedCommit = commits.find((commit) => commit.hash === expandedCommitHash) ?? null;
  const handleGraphScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!hasMore || loadingMore || !onLoadMore) {
        return;
      }

      const target = event.currentTarget;
      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceToBottom <= LOAD_MORE_SCROLL_THRESHOLD_PX) {
        onLoadMore();
      }
    },
    [hasMore, loadingMore, onLoadMore],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border bg-surface/40 px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitGraph className="size-3.5 text-foreground" />
              <h2 className="truncate text-ui-base font-medium">
                {intl.formatMessage({ id: "gitGraph.title" })}
              </h2>
            </div>
          </div>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={refreshing}
              aria-label={intl.formatMessage({ id: "gitGraph.refresh" })}
              title={intl.formatMessage({ id: "gitGraph.refresh" })}
              className="mr-8 text-foreground-subtle hover:text-foreground"
              onClick={onRefresh}
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
          ) : null}
        </div>
      </div>

      {commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GitGraph className="mx-auto size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "gitGraph.empty.title" })}
            </p>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.empty.description" })}
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" onScroll={handleGraphScroll}>
          <div
            className="grid min-h-full min-w-[760px]"
            style={{
              gridTemplateRows: "auto 1fr",
              gridTemplateColumns: `minmax(${GRAPH_COLUMN_MIN_WIDTH_PX}px, ${layout.width + 12}px) minmax(0, 1fr)`,
            }}
          >
            <div className="border-b border-r border-border bg-surface/60 px-3 py-2 text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.column.graph" })}
            </div>
            <div
              className="grid border-b border-border bg-surface/60 text-ui-base font-medium text-foreground-subtle"
              style={tableColumnStyle}
            >
              <div className="border-r border-border px-3 py-2">
                {intl.formatMessage({ id: "gitGraph.column.description" })}
              </div>
              <div className="border-r border-border px-3 py-2">
                {intl.formatMessage({ id: "gitGraph.column.date" })}
              </div>
              <div className="border-r border-border px-3 py-2">
                {intl.formatMessage({ id: "gitGraph.column.author" })}
              </div>
              <div className="px-3 py-2">
                {intl.formatMessage({ id: "gitGraph.column.commit" })}
              </div>
            </div>

            <div
              className="relative border-r border-border bg-background-alt/35"
              // 固定内容高度会让图轨背景提前结束；列填满视口，SVG 保留实际提交高度。
              style={{ minHeight: layout.height + layout.rowHeight }}
            >
              <svg
                className="absolute inset-0 overflow-visible"
                width={graphColumnWidth}
                height={layout.height + layout.rowHeight}
                viewBox={`0 0 ${graphColumnWidth} ${layout.height + layout.rowHeight}`}
                role="img"
                aria-label={intl.formatMessage({ id: "gitGraph.graphAriaLabel" })}
              >
                {layout.paths.map((path) => (
                  <path
                    key={path.id}
                    d={path.path}
                    className={cn(
                      "fill-none stroke-[2] opacity-55 transition-opacity",
                      getLaneStrokeClass(path.laneIndex),
                      highlightedHash && !isPathRelated(path, highlightedHash) && "opacity-30",
                      isPathRelated(path, highlightedHash) && "opacity-100",
                    )}
                  />
                ))}
                {layout.rows.map((row) => {
                  const isSelected = row.commit.hash === selectedCommitHash;
                  const isHovered = row.commit.hash === hoveredCommitHash;
                  return (
                    <g key={row.commit.hash}>
                      <circle
                        cx={row.x}
                        cy={row.y}
                        r={isSelected ? SELECTED_NODE_RADIUS : NODE_RADIUS}
                        className={cn(
                          "stroke-background stroke-[2] transition-all",
                          getLaneFillClass(row.laneIndex),
                          highlightedHash && !isSelected && !isHovered && "opacity-80",
                        )}
                      />
                      {isSelected ? (
                        <circle
                          cx={row.x}
                          cy={row.y}
                          r={SELECTED_RING_RADIUS}
                          className={cn(
                            "fill-none stroke-[1] opacity-85",
                            getLaneStrokeClass(row.laneIndex),
                          )}
                        />
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="min-w-0">
              {layout.rows.map((row) => {
                const isSelected = row.commit.hash === selectedCommitHash;
                const isHovered = row.commit.hash === hoveredCommitHash;
                const commitTime = formatCommitTime(row.commit.authoredAtMs, locale);

                return (
                  <button
                    key={row.commit.hash}
                    type="button"
                    className={cn(
                      "grid w-full min-w-0 items-center border-y border-transparent text-left transition-colors",
                      "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                      isSelected && "border-b-border bg-selected",
                      isSelected && row.rowIndex > 0 && "border-t-border",
                      isHovered && !isSelected && "bg-surface-hover",
                    )}
                    style={{ ...tableColumnStyle, height: layout.rowHeight }}
                    onClick={() => {
                      onSelectCommit(row.commit.hash);
                      setExpandedCommitHash((currentHash) =>
                        currentHash === row.commit.hash ? null : row.commit.hash,
                      );
                    }}
                    onMouseEnter={() => setHoveredCommitHash(row.commit.hash)}
                    onMouseLeave={() => setHoveredCommitHash(null)}
                  >
                    <span className="min-w-0 px-3">
                      <span className="flex min-w-0 items-center gap-2">
                        {row.commit.refs.length > 0 ? (
                          <span className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">
                            {row.commit.refs.slice(0, 4).map((ref) => (
                              <span
                                key={`${row.commit.hash}:${ref.name}`}
                                className={cn(
                                  "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-ui-base text-foreground-subtle",
                                  ref.kind === "head" &&
                                    "border-git-descendant bg-selected text-foreground",
                                  ref.kind === "tag" && "border-git-added",
                                )}
                              >
                                {getRefIcon(ref, "size-2.5")}
                                <span className="max-w-32 truncate">{ref.name}</span>
                              </span>
                            ))}
                          </span>
                        ) : null}
                        <span className="truncate text-ui-base text-foreground">
                          {row.commit.subject || getShortHash(row.commit.hash)}
                        </span>
                        {row.commit.parents.length > 1 ? (
                          <GitMergeIcon className="size-3 shrink-0 text-git-renamed" />
                        ) : null}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "truncate border-l border-transparent px-3 text-ui-base text-foreground-subtle",
                        isSelected && "border-border",
                      )}
                    >
                      {commitTime}
                    </span>
                    <span
                      className={cn(
                        "truncate border-l border-transparent px-3 text-ui-base font-medium text-foreground-subtle",
                        isSelected && "border-border",
                      )}
                    >
                      {row.commit.authorName}
                    </span>
                    <span
                      className={cn(
                        "truncate border-l border-transparent px-3 font-mono text-ui-base text-foreground-subtle",
                        isSelected && "border-border",
                      )}
                    >
                      {getShortHash(row.commit.hash)}
                    </span>
                  </button>
                );
              })}
              {hasMore && onLoadMore ? (
                <div className="flex h-10 items-center border-b border-border px-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loadingMore}
                    className="h-7 w-full text-ui-base sm:hidden"
                    onClick={onLoadMore}
                  >
                    {loadingMore
                      ? intl.formatMessage({ id: "gitGraph.loadMore.loading" })
                      : intl.formatMessage({ id: "gitGraph.loadMore" })}
                  </Button>
                  <button
                    type="button"
                    disabled={loadingMore}
                    className="hidden w-full rounded-md px-2 py-1 text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-60 sm:block"
                    onClick={onLoadMore}
                  >
                    {loadingMore
                      ? intl.formatMessage({ id: "gitGraph.loadMore.loading" })
                      : intl.formatMessage({ id: "gitGraph.loadMore" })}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {expandedCommit ? <GitGraphCommitDetail commit={expandedCommit} /> : null}
    </section>
  );
}
