import { Check, Download, LoaderCircle, TriangleAlert } from "lucide-react";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
  ZCodeImportedSessionSkippedItem,
} from "@zcode/shared";
import type { ClaudeSessionMigrationSupportState } from "@/hooks/useClaudeSessionMigration.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

function getKnownReasonLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reason: string,
): string {
  if (reason === "session_not_found_or_workspace_mismatch") {
    return intl.formatMessage({
      id: "settings.migration.reason.session_not_found_or_workspace_mismatch",
    });
  }

  return reason;
}

function ImportIssuesList({
  title,
  items,
}: {
  title: string;
  items: ZCodeImportedSessionSkippedItem[];
}) {
  const { intl } = useZCodeIntl();

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={`${item.provider}-${item.sessionId}-${item.reason}`}
            className="rounded-lg border border-border bg-background px-3 py-2"
          >
            <div className="font-mono text-ui-base text-foreground">{item.sessionId}</div>
            {item.workspacePath ? (
              <div className="mt-1 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.migration.workspacePathLabel" })}
              </div>
            ) : null}
            {item.workspacePath ? (
              <div className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {item.workspacePath}
              </div>
            ) : null}
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {getKnownReasonLabel(intl, item.reason)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MigrationCandidatesCard({
  supportState,
  candidates,
  selectedSessionIds,
  selectedCount,
  importError,
  lastImportResult,
  isImporting,
  dateTimeFormatter,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  onImportSelected,
}: {
  supportState: ClaudeSessionMigrationSupportState;
  candidates: ZCodeImportableSessionCandidate[];
  selectedSessionIds: string[];
  selectedCount: number;
  importError: string | null;
  lastImportResult: ZCodeImportSessionsResult | null;
  isImporting: boolean;
  dateTimeFormatter: Intl.DateTimeFormat;
  onToggleSelection: (sessionId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onImportSelected: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardHeader className="border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>
                {intl.formatMessage({ id: "settings.migration.candidatesTitle" })}
              </CardTitle>
              <Badge variant="outline">
                {intl.formatMessage(
                  { id: "settings.migration.candidatesCount" },
                  { count: String(candidates.length) },
                )}
              </Badge>
              <Badge variant="outline">
                {intl.formatMessage(
                  { id: "settings.migration.selectedCount" },
                  { count: String(selectedCount) },
                )}
              </Badge>
            </div>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.candidatesDescription" })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!supportState.supported || candidates.length === 0 || isImporting}
              onClick={onSelectAll}
            >
              {intl.formatMessage({ id: "settings.migration.selectAll" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={selectedCount === 0 || isImporting}
              onClick={onClearSelection}
            >
              {intl.formatMessage({ id: "settings.migration.clearSelection" })}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!supportState.supported || selectedCount === 0 || isImporting}
              onClick={onImportSelected}
            >
              {isImporting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {intl.formatMessage({ id: "settings.migration.importSelected" })}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-4">
        {importError ? (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>
              {intl.formatMessage({ id: "settings.migration.importFailedTitle" })}
            </AlertTitle>
            <AlertDescription>
              {intl.formatMessage(
                { id: "settings.migration.importFailedDescription" },
                { error: importError },
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {lastImportResult ? (
          <Alert>
            <Check className="size-4" />
            <AlertTitle>{intl.formatMessage({ id: "settings.migration.resultTitle" })}</AlertTitle>
            <AlertDescription>
              {intl.formatMessage(
                { id: "settings.migration.resultSummary" },
                {
                  imported: String(lastImportResult.imported.length),
                  skipped: String(lastImportResult.skipped.length),
                  failed: String(lastImportResult.failed.length),
                },
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-background px-4 py-8 text-center">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.migration.emptyTitle" })}
            </div>
            <div className="mt-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.migration.emptyDescription" })}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {candidates.map((candidate) => {
              const isSelected = selectedSessionIds.includes(candidate.sessionId);

              return (
                <button
                  key={candidate.sessionId}
                  type="button"
                  disabled={isImporting}
                  className={cn(
                    "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                    isSelected
                      ? "border-primary bg-accent"
                      : "border-border bg-background hover:bg-surface",
                  )}
                  onClick={() => onToggleSelection(candidate.sessionId)}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-input text-transparent",
                      )}
                    >
                      <Check className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1 text-ui-base font-medium text-foreground">
                          <span className="line-clamp-1 break-all">
                            {candidate.previewTitle || candidate.sessionId}
                          </span>
                        </div>
                        <Badge variant="outline" className="font-mono">
                          {candidate.sessionId.slice(0, 8)}
                        </Badge>
                      </div>
                      <div className="grid gap-2 text-ui-base text-foreground-subtle grid-cols-[minmax(0,1fr)_auto] items-center">
                        <div className="min-w-0 space-y-1">
                          <div className="font-mono text-ui-xs text-foreground-subtle">
                            {candidate.sessionId}
                          </div>
                          <div className="text-ui-xs text-foreground-subtle">
                            {intl.formatMessage({ id: "settings.migration.workspacePathLabel" })}
                          </div>
                          <div className="break-all font-mono text-ui-xs text-foreground-subtlest">
                            {candidate.workspacePath}
                          </div>
                          <div className="line-clamp-1 break-all font-mono text-ui-xs text-foreground-subtlest">
                            {candidate.sourcePath}
                          </div>
                        </div>
                        <div className="text-right text-ui-xs text-foreground-subtle">
                          {intl.formatMessage(
                            { id: "settings.migration.updatedAt" },
                            { time: dateTimeFormatter.format(candidate.updatedAt) },
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {lastImportResult ? (
          <div className="grid grid-cols-2 gap-4">
            <ImportIssuesList
              title={intl.formatMessage({ id: "settings.migration.skippedTitle" })}
              items={lastImportResult.skipped}
            />
            <ImportIssuesList
              title={intl.formatMessage({ id: "settings.migration.failedTitle" })}
              items={lastImportResult.failed}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
