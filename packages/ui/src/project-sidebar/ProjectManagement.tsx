import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Clock, FolderMinus, FolderX, MessageCircleOff, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import {
  buildProjectManagementRows,
  formatCountMessage,
  selectProjectManagementRows,
  selectRemovedProjects,
  summarizeUnusedProjects,
  type ProjectManagementFilter,
  type ProjectManagementRow,
  type ProjectManagementSort,
} from "@/project-sidebar/project-management-view.js";
import {
  useProjectManagement,
  type ProjectRemovalOptions,
} from "@/project-sidebar/useProjectManagement.js";
import {
  PROJECT_MANAGEMENT_GRID,
  ProjectManagementListRow,
} from "@/project-sidebar/ProjectManagementRow.js";
import { ProjectRemovalDialog } from "@/project-sidebar/ProjectRemovalDialog.js";
import { RemovedProjects } from "@/project-sidebar/RemovedProjects.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { projectKey } from "@/project-sidebar/view.js";

const PAGE = 50;
const SORTS = ["lastActive", "name", "sessions"] as const;

export function ProjectManagement() {
  return (
    <ProjectDirectoryProvider>
      <ProjectManagementContent />
    </ProjectDirectoryProvider>
  );
}

function ProjectManagementContent() {
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  const count = (id: string, n: number, values?: Record<string, string | number>) =>
    formatCountMessage(intl, `projectManagement.${id}`, n, values);
  const state = useProjectManagement();
  const sortId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectManagementFilter>("all");
  const [sort, setSort] = useState<ProjectManagementSort>("lastActive");
  const [limit, setLimit] = useState(PAGE);
  // 选择只是 UI 草稿：生效集合 = 草稿 ∩ 当前可见且可移除的行，树刷新后自然收敛，不另做同步。
  const [draft, setDraft] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<readonly ProjectManagementRow[] | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const hostLabel = useCallback(
    (host: RemoteProjectHost) => {
      const sourceServerId = parseRemoteWorkspaceIdentity(
        buildRemoteHostWorkspaceIdentity(host.id, "/"),
      )?.sourceServerId;
      return (sourceServerId && state.deviceNames.get(sourceServerId)) || remoteHostLabel(host);
    },
    [state.deviceNames],
  );
  // 「最近活动」与疑似原因按目录版本取一次当前时间，渲染之间保持稳定。
  const now = useMemo(() => Date.now(), [state.tree]);
  const rows = useMemo(
    () =>
      buildProjectManagementRows({
        tree: state.tree,
        availability: state.availability,
        directory: state.directory,
        canRemoveEntries: Boolean(state.remoteService),
        now,
        hostLabel,
      }),
    [state.tree, state.availability, state.directory, state.remoteService, now, hostLabel],
  );
  const unused = useMemo(() => summarizeUnusedProjects(rows), [rows]);
  const visible = useMemo(
    () => selectProjectManagementRows(rows, { query, filter, sort }),
    [rows, query, filter, sort],
  );
  const removed = useMemo(() => selectRemovedProjects(state.tree), [state.tree]);
  const selectable = useMemo(() => visible.filter((row) => row.removal), [visible]);
  const selected = useMemo(
    () => selectable.filter((row) => draft.has(row.key)),
    [selectable, draft],
  );
  const disabled = state.busy || state.loading;
  const canEdit = (row: ProjectManagementRow) => {
    const availability = state.availability.get(row.key);
    return Boolean(
      state.service &&
      !row.project.legacySingleRoot &&
      (availability?.online ?? true) &&
      !availability?.unresolved,
    );
  };
  // 同一目录可属于多个项目；只用 Host + ID 取当前事实，离线或移除后不保留旧编辑草稿。
  const editingRow = rows.find((row) => row.key === editingKey && canEdit(row));
  useEffect(() => {
    if (editingKey && !editingRow) setEditingKey(null);
  }, [editingKey, editingRow]);

  const resetView = () => {
    setDraft(new Set());
    setLimit(PAGE);
  };
  const review = () => {
    setQuery("");
    setFilter("unused");
    setLimit(PAGE);
    // 预选全部候选，用户只需取消要保留的项目。
    setDraft(new Set(rows.filter((row) => row.reason && row.removal).map((row) => row.key)));
  };
  const toggle = (row: ProjectManagementRow, checked: boolean) =>
    setDraft((current) => {
      const next = new Set(current);
      if (checked) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
  const confirm = (batch: readonly ProjectManagementRow[], options?: ProjectRemovalOptions) => {
    setPending(null);
    setDraft(new Set());
    void state.remove(batch, options);
  };

  const failureText = state.failure
    ? count(`failure.${state.failure.kind}`, state.failure.count, {
        name: state.failure.name,
        reason: state.failure.reason,
      })
    : null;
  const allChecked = selectable.length > 0 && selected.length === selectable.length;
  return (
    <section data-testid="project-management" className="min-w-0 space-y-6">
      {state.failure ? (
        <div
          role="alert"
          data-testid="project-management-failure"
          className="flex min-w-0 items-center gap-3 rounded-xl bg-warning-surface py-2.5 pl-4 pr-3 text-warning-surface-foreground"
        >
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 text-ui-base">{failureText}</span>
          <Button
            data-testid="project-management-retry"
            variant="outline"
            className="shrink-0 border-current text-inherit hover:bg-transparent"
            disabled={state.busy}
            onClick={() => void state.failure?.retry()}
          >
            {msg("retry")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-inherit"
            aria-label={msg("dismiss")}
            onClick={state.dismissFailure}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
      {filter === "all" && unused.total > 0 && !state.loading ? (
        <div
          data-testid="project-management-suggestion"
          className="flex min-w-0 flex-wrap items-center gap-4 rounded-xl border border-card-border bg-card p-4"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-ui-base font-medium">
              {count("suggestion.title", unused.total)}
            </span>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-ui-sm text-foreground-subtle">
              {(
                [
                  ["missing", FolderX],
                  ["empty", MessageCircleOff],
                  ["idle", Clock],
                ] as const
              ).map(([reason, Icon]) =>
                unused[reason] ? (
                  <span key={reason} className="flex items-center gap-1.5">
                    <Icon aria-hidden="true" className="size-3.5" />
                    {count(`suggestion.${reason}`, unused[reason])}
                  </span>
                ) : null,
              )}
            </div>
          </div>
          <Button
            data-testid="project-management-review"
            variant="outline"
            size="lg"
            disabled={disabled}
            onClick={review}
          >
            {msg("review", { count: unused.total })}
          </Button>
        </div>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
        <SettingsSearchInput
          data-testid="project-management-search"
          placeholder={msg("search")}
          aria-label={msg("search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetView();
          }}
          onClear={() => {
            setQuery("");
            resetView();
          }}
          clearLabel={msg("clearSearch")}
          containerClassName="min-w-0 sm:col-span-2 lg:col-span-1"
          className="text-mobile-input-safe sm:text-ui-base"
        />
        <Select
          value={filter}
          disabled={state.busy}
          onValueChange={(value) => {
            setFilter(value as ProjectManagementFilter);
            resetView();
          }}
        >
          <SelectTrigger
            data-testid="project-management-filter"
            size="lg"
            className="h-9 w-full min-w-0"
            aria-label={msg("filterLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="project-management-filter-all">
              {msg("filter.all")}
            </SelectItem>
            <SelectItem value="unused" data-testid="project-management-filter-unused">
              {msg("filter.unused", { count: unused.total })}
            </SelectItem>
          </SelectContent>
        </Select>
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={sortId} className="shrink-0 text-ui-base text-foreground-subtle">
            {msg("sortLabel")}
          </label>
          <Select value={sort} onValueChange={(value) => setSort(value as ProjectManagementSort)}>
            <SelectTrigger
              id={sortId}
              data-testid="project-management-sort"
              size="lg"
              className="h-9 min-w-0 flex-1 lg:w-36 lg:flex-none"
              aria-label={msg("sortLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  data-testid={`project-management-sort-${value}`}
                >
                  {msg(`sort.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {state.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-ui-base text-destructive"
        >
          <span>{msg("loadFailed")}</span>
          <Button variant="outline" onClick={() => void state.refresh()}>
            {msg("retry")}
          </Button>
        </div>
      ) : null}
      {state.loading ? (
        <p role="status" className="py-8 text-ui-base text-foreground-subtle">
          {msg("loading")}
        </p>
      ) : !visible.length ? (
        <p
          data-testid="project-management-empty"
          className="py-12 text-center text-ui-base text-foreground-subtle"
        >
          {msg(!rows.length ? "empty" : filter === "unused" && !query ? "noUnused" : "noResults")}
        </p>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <div
            className={cn(
              "grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-2 text-ui-sm text-foreground-subtle",
              PROJECT_MANAGEMENT_GRID,
            )}
          >
            <Checkbox
              data-testid="project-management-select-all"
              aria-label={msg("selectAll")}
              disabled={disabled || !selectable.length}
              checked={allChecked ? true : selected.length ? "indeterminate" : false}
              onCheckedChange={() =>
                setDraft(allChecked ? new Set() : new Set(selectable.map((row) => row.key)))
              }
            />
            <span className="min-w-0 truncate md:pl-6.5">
              <span className="md:hidden">{msg("selectAll")}</span>
              <span className="hidden md:inline">{msg("column.project")}</span>
            </span>
            <span className="hidden md:block">{msg("column.device")}</span>
            <span className="hidden text-right md:block">{msg("column.sessions")}</span>
            <span className="hidden text-right md:block">{msg("column.lastActive")}</span>
            <span className="hidden md:block" />
          </div>
          {visible.slice(0, limit).map((row) => (
            <ProjectManagementListRow
              key={row.key}
              row={row}
              now={now}
              checked={draft.has(row.key) && row.removal !== null}
              disabled={disabled}
              onEdit={canEdit(row) ? () => setEditingKey(row.key) : undefined}
              onCheckedChange={(checked) => toggle(row, checked)}
              onRemove={() => setPending([row])}
            />
          ))}
          {visible.length > limit ? (
            <div className="flex justify-center border-t border-border p-2">
              <Button
                data-testid="project-management-show-more"
                variant="ghost"
                onClick={() => setLimit((n) => n + PAGE)}
              >
                {msg("showMore", { count: Math.min(PAGE, visible.length - limit) })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <RemovedProjects
        projects={removed}
        disabled={disabled}
        onRestore={(project) => void state.restore(project)}
      />
      {selected.length ? (
        // 窄屏仍有设置侧栏，固定高度的单行操作栏会溢出；允许换行，保留所有操作。
        <div
          data-testid="project-management-selection-bar"
          className="sticky bottom-4 z-10 flex min-h-12 min-w-0 flex-wrap items-center gap-3 rounded-xl border border-popover-border bg-popover py-2 pl-4 pr-2 shadow-md"
        >
          <span className="shrink-0 text-ui-base font-medium">
            {msg("selected", { count: selected.length })}
          </span>
          <span className="hidden min-w-0 truncate text-ui-sm text-foreground-subtle sm:inline">
            {msg("ofShown", { count: visible.length })}
          </span>
          <Button variant="ghost" className="shrink-0" onClick={() => setDraft(new Set())}>
            {msg("clearSelection")}
          </Button>
          <span className="flex-1" />
          <Button
            data-testid="project-management-remove"
            size="lg"
            variant="ghost"
            disabled={disabled}
            className="shrink-0 bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface"
            onClick={() => setPending(selected)}
          >
            <FolderMinus className="size-4" />
            {count("removeSelected", selected.length)}
          </Button>
        </div>
      ) : null}
      <ProjectRemovalDialog
        rows={pending}
        measureData={state.measureData}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
      {editingRow && state.service ? (
        <ProjectEditor
          key={editingRow.key}
          project={editingRow.project}
          host={editingRow.host}
          projects={state.tree.projects.filter(
            (project) => !state.availability.get(projectKey(project))?.entryId,
          )}
          service={state.service}
          onClose={() => setEditingKey(null)}
          onSaved={state.refresh}
          onDeleted={state.refresh}
        />
      ) : null}
    </section>
  );
}
