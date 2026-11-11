import { useMemo, useState } from "react";
import { Clock, Ellipsis, FolderMinus, FolderX, Pencil, Pin } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import { REMOTE_KIND_PRESENTATION } from "@/remote-connection/RemoteConnectionTags.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCountMessage,
  type ProjectManagementRow,
} from "@/project-sidebar/project-management-view.js";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import type { RemoteProjectHost, VirtualProject } from "@/project-sidebar/contract.js";

/** 表格列只在宽屏出现；窄屏把设备、会话和最近活动折成一行元信息。 */
export const PROJECT_MANAGEMENT_GRID = "md:grid-cols-[1rem_minmax(0,1fr)_8rem_4.75rem_7rem_1.5rem]";
const TAG =
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-ui-xs";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["month", 30 * 86_400_000],
  ["year", 365 * 86_400_000],
];
/** 「2 分钟前 / 昨天 / 6 个月前」：按最大可用单位取整，跟随当前语言。 */
export function useRelativeTime() {
  const { locale } = useZCodeIntl();
  return useMemo(() => {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return (timestamp: number, now = Date.now()) => {
      const diff = Math.max(0, now - timestamp);
      let unit = UNITS[0]!;
      for (const candidate of UNITS) if (diff >= candidate[1]) unit = candidate;
      return format.format(-Math.floor(diff / unit[1]), unit[0]);
    };
  }, [locale]);
}

export function DeviceTag({ host, label }: { host?: RemoteProjectHost; label?: string }) {
  const { intl } = useZCodeIntl();
  if (!host)
    return (
      <span className="truncate text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "project.thisComputer" })}
      </span>
    );
  const presentation = host.kind === "server" ? undefined : REMOTE_KIND_PRESENTATION[host.kind];
  const name = label ?? host.id;
  return (
    <span
      data-remote-connection-kind={host.kind}
      title={name}
      className={cn(
        TAG,
        "min-w-0 max-w-full border",
        presentation?.className ?? "border-transparent bg-surface-hover text-foreground-subtle",
      )}
    >
      {presentation ? <presentation.Icon aria-hidden="true" className="size-3" /> : null}
      <span className="truncate">
        {host.kind === "server"
          ? name
          : `${intl.formatMessage({ id: `remote.kind.${host.kind}` })} · ${name}`}
      </span>
    </span>
  );
}

function ReasonTag({ row }: { row: ProjectManagementRow }) {
  const { intl } = useZCodeIntl();
  if (!row.reason) return null;
  const text = intl.formatMessage(
    { id: `projectManagement.reason.${row.reason}` },
    { months: row.idleMonths ?? 3 },
  );
  return (
    <span
      data-testid="project-management-reason"
      data-reason={row.reason}
      className={cn(
        TAG,
        row.reason === "missing"
          ? "bg-warning-surface text-warning-surface-foreground"
          : "bg-surface-hover text-foreground-subtle",
      )}
    >
      {row.reason === "missing" ? <FolderX aria-hidden="true" className="size-3" /> : null}
      {row.reason === "idle" ? <Clock aria-hidden="true" className="size-3" /> : null}
      {text}
    </span>
  );
}

/** 多 root 项目在主目录后跟「+N」；提示列出其余目录。点按也能打开，触屏没有悬停。 */
function MoreRootsTag({ roots }: { roots: VirtualProject["roots"] }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  if (!roots.length) return null;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="project-management-more-roots"
          aria-label={formatCountMessage(intl, "projectManagement.moreRoots", roots.length)}
          // 高度不超过路径行高，多 root 行与单 root 行等高。
          className={cn(TAG, "h-4 bg-tag tabular-nums text-foreground-subtle")}
          // Radix 在 click 时关闭提示；阻止默认后由点按打开。
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          +{roots.length}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6}>
        <span className="flex min-w-0 flex-col gap-0.5 font-mono">
          {roots.map((root) => (
            <span key={root.rootPath} className="break-all">
              {root.rootPath}
            </span>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ProjectManagementListRow({
  row,
  checked,
  disabled,
  now,
  onCheckedChange,
  onEdit,
  onRemove,
}: {
  row: ProjectManagementRow;
  checked: boolean;
  disabled: boolean;
  now: number;
  onCheckedChange(checked: boolean): void;
  onEdit?(): void;
  onRemove(): void;
}) {
  const { intl } = useZCodeIntl();
  const relative = useRelativeTime();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  const { project } = row;
  const removable = row.removal !== null;
  const known = row.sessions !== null;
  const sessions = known ? String(row.sessions) : "—";
  const lastActive = !known
    ? "—"
    : row.lastActiveAt === null
      ? msg("never")
      : relative(row.lastActiveAt, now);
  const primary = project.roots.find((root) => root.isPrimary) ?? project.roots[0];
  const others = project.roots.filter((root) => root !== primary);
  const iconClass = "mt-0.5 hidden size-4 shrink-0 text-foreground-subtle md:mt-0 md:block";
  return (
    <div
      data-testid="project-management-row"
      data-project-key={row.key}
      data-project-id={project.id}
      data-host-id={project.hostId}
      className={cn(
        "group/row grid grid-cols-[1rem_minmax(0,1fr)_1.5rem] items-start gap-x-3 border-t border-border px-4 py-2.5 first:border-t-0 md:items-center md:py-2",
        PROJECT_MANAGEMENT_GRID,
      )}
    >
      <Checkbox
        data-testid="project-management-row-checkbox"
        className="mt-0.5 md:mt-0"
        checked={checked}
        disabled={disabled || !removable}
        title={removable ? undefined : msg("unremovable")}
        aria-label={msg("selectProject", { name: project.name })}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="flex min-w-0 items-start gap-2.5 md:items-center">
        {row.reason === "missing" ? (
          <FolderX aria-hidden="true" className={iconClass} />
        ) : (
          <ProjectFolderIcon
            aria-hidden="true"
            rootCount={project.roots.length}
            className={iconClass}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
            <span className="min-w-0 truncate text-ui-base font-medium" title={project.name}>
              {project.name}
            </span>
            {project.pinned ? (
              <Pin
                aria-label={msg("pinned")}
                className="size-3 shrink-0 text-foreground-subtlest"
              />
            ) : null}
            <ReasonTag row={row} />
          </div>
          {primary ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle"
                title={primary.rootPath}
              >
                {primary.rootPath}
              </span>
              <MoreRootsTag roots={others} />
            </div>
          ) : null}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-sm text-foreground-subtle md:hidden">
            {row.host ? (
              <DeviceTag host={row.host} label={row.deviceLabel} />
            ) : (
              <span>{intl.formatMessage({ id: "project.thisComputer" })}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {known
                ? formatCountMessage(intl, "projectManagement.sessionsCount", row.sessions!)
                : msg("offline")}
            </span>
            {known ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{lastActive}</span>
              </>
            ) : null}
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 md:flex">
        <DeviceTag host={row.host} label={row.deviceLabel} />
      </div>
      <span
        className="hidden text-right text-ui-sm tabular-nums text-foreground-subtle md:block"
        title={known ? undefined : msg("offline")}
      >
        {sessions}
      </span>
      <span
        className="hidden truncate text-right text-ui-sm text-foreground-subtle md:block"
        title={known ? undefined : msg("offline")}
      >
        {lastActive}
      </span>
      <div>
        {onEdit || removable ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="project-management-row-menu"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={msg("rowActions", { name: project.name })}
                className="md:opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit ? (
                <DropdownMenuItem data-testid="project-management-row-edit" onSelect={onEdit}>
                  <Pencil className="size-4" />
                  {intl.formatMessage({ id: "project.edit" })}
                </DropdownMenuItem>
              ) : null}
              {onEdit && removable ? <DropdownMenuSeparator /> : null}
              {removable ? (
                <DropdownMenuItem
                  data-testid="project-management-row-remove"
                  variant="destructive"
                  onSelect={onRemove}
                >
                  <FolderMinus className="size-4" />
                  {msg("removeOne")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
