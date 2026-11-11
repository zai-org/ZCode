import { CheckIcon, FolderIcon, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ClaudeMigrationRange,
  useClaudeSessionMigration,
} from "@/hooks/useClaudeSessionMigration.js";
import { UNLIMITED_SCAN_LIMIT_INPUT } from "@/hooks/useClaudeSessionMigration.js";
import { SettingsSyncSelectionStep } from "@/settings-sync/SettingsSyncSelectionStep.js";
import type { useSettingsSync } from "@/hooks/useSettingsSync.js";
import { Badge } from "@/components/ui/badge.js";
import {
  ExternalAgentImportSelectionPanel,
  type ExternalAgentImportCategoryState,
  type ImportResourceCategory,
} from "@/settings/ExternalAgentImportDialog.js";

export interface OnboardingWorkspaceCandidate {
  workspacePath: string;
  label: string;
  sessionCount: number;
}

export interface FinishExecutionState {
  started: boolean;
  running: boolean;
  finished: boolean;
  sessionCompletedCount: number;
  sessionTotalCount: number;
  sessionImportedCount: number;
  sessionSkippedCount: number;
  sessionFailedCount: number;
  agentsFileCompletedCount: number;
  agentsFileTotalCount: number;
  agentsFileImportedCount: number;
  agentsFileSkippedCount: number;
  agentsFileFailedCount: number;
  currentTaskLabel: string | null;
  error: string | null;
}

export function createInitialFinishExecutionState(): FinishExecutionState {
  return {
    started: false,
    running: false,
    finished: false,
    sessionCompletedCount: 0,
    sessionTotalCount: 0,
    sessionImportedCount: 0,
    sessionSkippedCount: 0,
    sessionFailedCount: 0,
    agentsFileCompletedCount: 0,
    agentsFileTotalCount: 0,
    agentsFileImportedCount: 0,
    agentsFileSkippedCount: 0,
    agentsFileFailedCount: 0,
    currentTaskLabel: null,
    error: null,
  };
}

export function OnboardingSessionsStep(props: {
  migration: ReturnType<typeof useClaudeSessionMigration>;
  workspaceCandidates: OnboardingWorkspaceCandidate[];
  selectedWorkspacePaths: string[];
  onToggleWorkspace: (workspacePath: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}) {
  const { intl } = useZCodeIntl();
  const selectedCount = props.selectedWorkspacePaths.length;
  const totalCount = props.workspaceCandidates.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={props.migration.range}
          onValueChange={(value) => props.migration.setRange(value as ClaudeMigrationRange)}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">
              {intl.formatMessage({ id: "settings.migration.range.7d" })}
            </SelectItem>
            <SelectItem value="30d">
              {intl.formatMessage({ id: "settings.migration.range.30d" })}
            </SelectItem>
            <SelectItem value="90d">
              {intl.formatMessage({ id: "settings.migration.range.90d" })}
            </SelectItem>
            <SelectItem value="all">
              {intl.formatMessage({ id: "settings.migration.range.all" })}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={props.migration.limitInput}
          onValueChange={(value) => {
            props.migration.setLimitInput(value);
          }}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["30", "50", "100", UNLIMITED_SCAN_LIMIT_INPUT].map((value) => (
              <SelectItem key={value} value={value}>
                {value === UNLIMITED_SCAN_LIMIT_INPUT
                  ? intl.formatMessage({ id: "onboarding.sessions.unlimited" })
                  : intl.formatMessage({ id: "onboarding.sessions.count" }, { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-9 min-w-0 px-4 text-ui-base"
          disabled={!props.migration.supportState.supported || props.migration.isScanning}
          onClick={() => {
            void props.migration.scan();
          }}
        >
          {props.migration.isScanning ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "settings.migration.scan" })}
        </Button>
      </div>

      {props.migration.scanError ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {intl.formatMessage(
            { id: "settings.migration.scanFailedDescription" },
            { error: props.migration.scanError },
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex w-full flex-col flex-1 rounded-xl border border-border bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({
                  id: "onboarding.sessions.chooseWorkspace",
                })}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={totalCount === 0}
            onClick={allSelected ? props.onClearSelection : props.onSelectAll}
          >
            {allSelected
              ? intl.formatMessage({ id: "settingsSync.selection.clearAll" })
              : intl.formatMessage({ id: "settingsSync.selection.selectAll" })}
          </Button>
        </div>
        {props.workspaceCandidates.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.sessions.empty" })}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-1 p-2 overflow-y-auto">
            {props.workspaceCandidates.map((workspace) => {
              const checked = props.selectedWorkspacePaths.includes(workspace.workspacePath);

              return (
                <button
                  key={workspace.workspacePath}
                  type="button"
                  onClick={() => props.onToggleWorkspace(workspace.workspacePath)}
                  className="flex min-w-0 w-full items-start gap-3 rounded-lg bg-background p-3 pl-3 text-left transition-colors hover:bg-surface-hover/50"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    <div
                      className={`flex size-4 items-center justify-center rounded-sm border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}
                    >
                      <CheckIcon className="size-3.5" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </div>
                      <Badge variant="outline">
                        {intl.formatMessage(
                          { id: "onboarding.sessions.count" },
                          { count: String(workspace.sessionCount) },
                        )}
                      </Badge>
                    </div>
                    {/* 长路径是连续文本，父级 flex 子项如果不允许收缩，会把整张卡片横向撑出容器，所以这里补齐 min-w-0 让 truncate 真正生效。 */}
                    <div className="w-full truncate text-ui-base text-foreground-subtlest">
                      {workspace.workspacePath}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function OnboardingAgentSettingsStep(props: {
  settingsSync: ReturnType<typeof useSettingsSync>;
}) {
  const { intl } = useZCodeIntl();

  const { discovery, loading, error } = props.settingsSync.state;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col rounded-xl bg-background border border-border overflow-y-auto">
      <div className="flex min-h-0 flex-1 flex-col gap-1 border-b border-border p-2">
        {discovery ? (
          <SettingsSyncSelectionStep
            discovery={discovery}
            selectedKeys={props.settingsSync.state.selectedKeys}
            onToggleSelection={props.settingsSync.actions.toggleSelection}
            onSetCategorySelectionAllAgents={
              props.settingsSync.actions.setCategorySelectionAllAgents
            }
          />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-base text-foreground-subtle">
            <LoaderCircle className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "common.loading" })}</span>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
            {error}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background-alt px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.agentSettings.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}

export function OnboardingExternalAgentImportStep(props: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  return (
    <ExternalAgentImportSelectionPanel
      category={props.category}
      state={props.state}
      workspacePath={props.workspacePath}
    />
  );
}

export function OnboardingMigrationStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-xl bg-background border border-border px-6 py-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <span>
              {intl.formatMessage({
                id: "settingsSync.importing.progressLabel",
              })}
            </span>
            <span>{props.overallProgress}%</span>
          </div>
          <Progress value={props.overallProgress} className="h-2 rounded-full bg-card" />
        </div>

        <div className="flex gap-3">
          <LoaderCircle className="size-5 animate-spin" />
          <div>
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage(
                { id: "onboarding.migration.progress" },
                { progress: String(props.overallProgress) },
              )}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {props.finishExecution.currentTaskLabel ??
                intl.formatMessage({ id: "onboarding.migration.ready" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OnboardingFinishStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
  settingsImportedCount: number;
  settingsSkippedCount: number;
  settingsFailedCount: number;
  /** 没有打开项目、需要项目才能导入而记为失败的设置项数。 */
  settingsWorkspaceRequiredCount: number;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 pt-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success text-success-foreground">
          <CheckIcon className="size-7" />
        </div>
        <div className="text-2xl font-medium text-foreground">
          {intl.formatMessage({ id: "onboarding.finish.done" })}
        </div>
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "onboarding.finish.ready" })}
        </div>
        {props.finishExecution.error ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
            {props.finishExecution.error}
          </div>
        ) : null}
        {props.settingsWorkspaceRequiredCount > 0 ? (
          <div
            data-testid="onboarding-finish-workspace-required"
            className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground"
          >
            {intl.formatMessage(
              { id: "onboarding.finish.workspaceRequired" },
              { count: String(props.settingsWorkspaceRequiredCount) },
            )}
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.sessions" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.sessionImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.sessionSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.sessionFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.agentsFile" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.agentsFileImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.agentsFileSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.agentsFileFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.settings" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.settingsImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.settingsSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.settingsFailedCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
