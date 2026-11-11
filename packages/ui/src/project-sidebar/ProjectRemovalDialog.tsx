import { useEffect, useRef, useState } from "react";
import { Brain, History, MessageSquare, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCountMessage,
  summarizeProjectRemoval,
  type ProjectManagementRow,
} from "@/project-sidebar/project-management-view.js";
import { DeviceTag } from "@/project-sidebar/ProjectManagementRow.js";
import {
  isProjectDataCandidate,
  type ProjectDataTotals,
  type ProjectRemovalOptions,
} from "@/project-sidebar/useProjectManagement.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";

/** undefined = 本批无本机候选；"measuring" = 正在计算；null = 测量失败或无数据，隐藏选项。 */
type DataState = ProjectDataTotals | "measuring" | null | undefined;

/**
 * 确认时的行集合由调用方冻结；对话框只展示按设备拆分的后果。
 * 本机候选可勾选「同时删除 ZCode 数据」：每次打开默认不勾选，勾选后改写标题、说明与按钮，并要求输入确认词。
 */
export function ProjectRemovalDialog({
  rows,
  measureData,
  onCancel,
  onConfirm,
}: {
  rows: readonly ProjectManagementRow[] | null;
  measureData?(rows: readonly ProjectManagementRow[]): Promise<ProjectDataTotals | null>;
  onCancel(): void;
  onConfirm(rows: readonly ProjectManagementRow[], options?: ProjectRemovalOptions): void;
}) {
  const { intl, locale } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  const count = (id: string, n: number, values?: Record<string, string | number>) =>
    formatCountMessage(intl, `projectManagement.${id}`, n, values);
  // 关闭动画期间保留上一批内容，避免对话框先变空再淡出。
  const last = useRef(rows);
  if (rows) last.current = rows;
  const shown = rows ?? last.current;
  const [data, setData] = useState<DataState>(undefined);
  const [deleteData, setDeleteData] = useState(false);
  const [word, setWord] = useState("");

  // 每次打开新批次都重新测量，并把选项复位为不勾选；迟到的旧批次结果丢弃。
  useEffect(() => {
    if (!rows) return;
    setDeleteData(false);
    setWord("");
    if (!measureData || !rows.some(isProjectDataCandidate)) {
      setData(undefined);
      return;
    }
    let current = true;
    setData("measuring");
    void measureData(rows).then((totals) => {
      if (!current) return;
      setData(totals && (totals.sessions > 0 || totals.totalBytes > 0) ? totals : null);
    });
    return () => {
      current = false;
    };
  }, [rows, measureData]);

  const summary = shown ? summarizeProjectRemoval(shown) : null;
  const hasLocal = summary?.devices.some((device) => device.hostId === "local");
  const hasRemote = summary?.devices.some((device) => device.hostId !== "local");
  const localCount = shown?.filter(isProjectDataCandidate).length ?? 0;
  const totals = data && data !== "measuring" ? data : null;
  const confirmWord = msg("confirm.data.word");
  const deleting = deleteData && Boolean(totals);
  const remoteDevices = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    (summary?.devices ?? [])
      .filter((device) => device.hostId !== "local")
      .map((device) => device.label ?? device.hostId),
  );
  const toggleData = (checked: boolean) => {
    setDeleteData(checked);
    // 取消勾选即清空确认词，再次勾选必须重新输入。
    setWord("");
  };
  const [typePrefix, typeSuffix] = msg("confirm.data.type", { word: "\u0000" }).split("\u0000");

  return (
    <AlertDialog open={Boolean(rows)} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="project-management-confirm">
        {shown && summary ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {deleting
                  ? count("confirm.data.title", shown.length)
                  : count("confirm.title", shown.length)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleting && totals
                  ? count("confirm.data.description", localCount, {
                      sessions: count("sessionsCount", totals.sessions),
                    })
                  : // 只移除 1 个项目时用单数句（俄语等语言的代词/动词随数变化，过去固定复数）。
                    count("confirm.description", shown.length, { sessions: summary.sessions })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="divide-y divide-border rounded-xl border border-border bg-surface px-3">
              {summary.devices.map((device) => (
                <div
                  key={device.hostId}
                  data-testid="project-management-confirm-device"
                  data-host-id={device.hostId}
                  className="flex min-w-0 flex-col gap-0.5 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 text-ui-base">
                      {count("projectsCount", device.count)}
                    </span>
                    <DeviceTag host={device.host} label={device.label} />
                  </div>
                  {device.hostId !== "local" ? (
                    <span className="text-ui-sm text-foreground-subtle">
                      {formatCountMessage(
                        intl,
                        "projectManagement.confirm.remoteNote",
                        device.count,
                        {
                          device: device.label ?? device.hostId,
                        },
                      )}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            {data ? (
              <label
                data-testid="project-management-confirm-data"
                data-checked={deleting ? "true" : "false"}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl px-3 py-3",
                  deleting
                    ? "bg-destructive-surface text-destructive-surface-foreground"
                    : "border border-border",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={deleting}
                  disabled={!totals}
                  onCheckedChange={(checked) => toggleData(checked === true)}
                />
                <span
                  className={cn("flex min-w-0 flex-1 flex-col", deleting ? "gap-2" : "gap-0.5")}
                >
                  <span className={cn("flex items-center gap-2", deleting && "font-medium")}>
                    <span className="min-w-0 flex-1 text-ui-base">
                      {count("confirm.data.option", localCount)}
                    </span>
                    <span
                      className={cn("shrink-0 tabular-nums", !deleting && "text-foreground-subtle")}
                    >
                      {totals ? formatBytes(totals.totalBytes) : msg("confirm.data.calculating")}
                    </span>
                  </span>
                  {deleting && totals ? (
                    <>
                      <span className="flex flex-col gap-1.5">
                        <DataLine
                          icon={MessageSquare}
                          label={count("confirm.data.sessions", totals.sessions)}
                          bytes={totals.sessionBytes}
                        />
                        {totals.checkpointBytes > 0 ? (
                          <DataLine
                            icon={History}
                            label={msg("confirm.data.checkpoints")}
                            bytes={totals.checkpointBytes}
                          />
                        ) : null}
                        {totals.memoryBytes > 0 ? (
                          <DataLine
                            icon={Brain}
                            label={msg("confirm.data.memory")}
                            bytes={totals.memoryBytes}
                          />
                        ) : null}
                      </span>
                      <span className="text-ui-sm">
                        {hasRemote
                          ? msg("confirm.data.notDeletedRemote", { devices: remoteDevices })
                          : msg("confirm.data.notDeleted")}
                      </span>
                    </>
                  ) : (
                    <span className="text-ui-sm text-foreground-subtle">
                      {count("confirm.data.note", localCount)}
                    </span>
                  )}
                </span>
              </label>
            ) : null}
            {deleting ? (
              <>
                <span className="text-ui-sm text-foreground-subtle">
                  {count("confirm.data.noRestore", localCount)}
                </span>
                <label className="flex flex-col gap-1.5">
                  <span className="text-ui-sm text-foreground-subtle">
                    {typePrefix}
                    <b className="font-mono font-medium text-foreground">{confirmWord}</b>
                    {typeSuffix}
                  </span>
                  <Input
                    data-testid="project-management-confirm-data-word"
                    size="lg"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    value={word}
                    onChange={(event) => setWord(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <div className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
                {hasLocal ? <span>{msg("confirm.restoreLocal")}</span> : null}
                {hasRemote ? <span>{msg("confirm.restoreRemote")}</span> : null}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel size="lg">{msg("confirm.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                data-testid="project-management-confirm-remove"
                variant="destructive"
                size="lg"
                disabled={!rows || (deleting && word.trim() !== confirmWord)}
                onClick={() =>
                  rows &&
                  onConfirm(
                    rows,
                    deleting && totals ? { deleteData: { totalBytes: totals.totalBytes } } : {},
                  )
                }
              >
                {deleting && totals ? (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    {msg("confirm.data.confirm", { size: formatBytes(totals.totalBytes) })}
                  </>
                ) : (
                  count("removeSelected", shown.length)
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DataLine({
  icon: Icon,
  label,
  bytes,
}: {
  icon: typeof MessageSquare;
  label: string;
  bytes: number;
}) {
  return (
    <span className="flex items-center gap-2 text-ui-sm">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{label}</span>
      <span className="tabular-nums">{formatBytes(bytes)}</span>
    </span>
  );
}
