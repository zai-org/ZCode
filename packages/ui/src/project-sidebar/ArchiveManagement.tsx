import { useId, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildArchiveGroups,
  buildArchiveProjectOptions,
  type ArchiveGroup,
  type ArchiveSort,
} from "@/project-sidebar/archive-view.js";
import { useArchiveManagement } from "@/project-sidebar/useArchiveManagement.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { ArchiveGroupCard } from "@/project-sidebar/ArchiveGroupCard.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";

export function ArchiveManagement() {
  return (
    <ProjectDirectoryProvider>
      <ArchiveManagementContent />
    </ProjectDirectoryProvider>
  );
}
function ArchiveManagementContent() {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `archives.${id}` });
  const state = useArchiveManagement();
  const sortId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ArchiveSort>("updated");
  const [project, setProject] = useState("all");
  const allGroups = useMemo(() => buildArchiveGroups(state.tree), [state.tree]);
  const projectOptions = useMemo(() => buildArchiveProjectOptions(state.tree), [state.tree]);
  const groups = useMemo(
    () => buildArchiveGroups(state.tree, { query, sort, project }),
    [state.tree, query, sort, project],
  );
  const rows = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const name = (group: ArchiveGroup) => {
    const title = group.project?.name ?? msg(group.projectId ? "removedProject" : "unclassified");
    const source = state.directory.hosts.find((h) => h.id === group.hostId);
    const host = source ? remoteHostLabel(source) : undefined;
    return `${title}${group.project?.deleted ? ` · ${msg("removed")}` : ""}${host ? ` · ${host}` : ""}`;
  };
  return (
    <section data-testid="archive-management" className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-ui-xl font-medium">{msg("title")}</h2>
        <Button
          data-testid="archive-delete-all"
          variant="ghost"
          disabled={state.busy || state.loading || Boolean(state.error) || !rows.length}
          className="bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface"
          onClick={() => void state.run(rows, "delete")}
        >
          <Trash2 className="size-4" />
          {msg(query.trim() || project !== "all" ? "deleteFiltered" : "deleteAll")}
        </Button>
      </div>
      <div
        data-testid="archive-filters"
        className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,13rem)]"
      >
        <SettingsSearchInput
          data-testid="archive-search"
          placeholder={msg("search")}
          aria-label={msg("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={msg("clearSearch")}
          containerClassName="min-w-0 sm:col-span-2 lg:col-span-1"
          className="text-mobile-input-safe sm:text-ui-base"
        />
        {/* 静态标签放在触发框外，省去装饰图标；框内只保留选中值和公共下拉箭头。 */}
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={sortId} className="shrink-0 text-ui-base text-foreground-subtle">
            {msg("sortLabel")}
          </label>
          <Select value={sort} onValueChange={(v) => setSort(v as ArchiveSort)}>
            <SelectTrigger
              id={sortId}
              data-testid="archive-sort"
              size="lg"
              className="h-9 min-w-0 flex-1"
              aria-label={msg("sortLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["updated", "created"] as const).map((value) => (
                <SelectItem key={value} value={value} data-testid={`archive-sort-${value}`}>
                  {msg(`sort.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger
            data-testid="archive-project-filter"
            size="lg"
            className="h-9 w-full min-w-0"
            aria-label={msg("projectLabel")}
          >
            <SelectValue placeholder={msg("allProjects")} />
          </SelectTrigger>
          <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
            <SelectItem value="all" data-testid="archive-project-all">
              {msg("allProjects")}
            </SelectItem>
            {projectOptions.map((group) => (
              <SelectItem
                key={group.key}
                value={group.key}
                data-testid={`archive-project-option-${group.projectId ?? "unclassified"}`}
              >
                <span className="truncate">{name(group)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      {state.busy ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {msg("working")}
        </p>
      ) : null}
      {state.result ? (
        <p
          role={state.result.failed ? "alert" : "status"}
          className="text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            { id: "archives.result" },
            {
              succeeded: state.result.succeeded,
              failed: state.result.failed,
              skipped: state.result.skipped,
            },
          )}
          {state.result.details.map((detail, index) => (
            <span key={index} className="block break-words">
              {detail}
            </span>
          ))}
        </p>
      ) : null}
      {state.loading ? (
        <p role="status" className="py-8 text-ui-base text-foreground-subtle">
          {msg("loading")}
        </p>
      ) : !groups.length && !state.error ? (
        <p className="py-12 text-center text-ui-base text-foreground-subtle">
          {msg(allGroups.length ? "noResults" : "empty")}
        </p>
      ) : (
        groups.map((group) => (
          <ArchiveGroupCard
            key={group.key}
            group={group}
            name={name(group)}
            sort={sort}
            disabled={state.busy || Boolean(state.error)}
            onAction={state.run}
          />
        ))
      )}
    </section>
  );
}
