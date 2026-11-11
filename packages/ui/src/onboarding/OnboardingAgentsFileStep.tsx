import {
  AlertTriangleIcon,
  CheckIcon,
  FileTextIcon,
  LoaderCircle,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OnboardingAgentsFileMigrationState } from "@/onboarding/useOnboardingAgentsFileMigration.js";

export function OnboardingAgentsFileStep(props: { migration: OnboardingAgentsFileMigrationState }) {
  const { intl } = useZCodeIntl();
  const status = props.migration.status;
  const supported = status?.supported === true;
  const selected = props.migration.selected && supported;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={props.migration.loading}
          onClick={() => void props.migration.refresh()}
        >
          {props.migration.loading ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {intl.formatMessage({ id: "settingsSync.action.rescan" })}
        </Button>
      </div>

      {props.migration.error ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {intl.formatMessage(
            { id: "onboarding.agentsFile.error" },
            { error: props.migration.error },
          )}
        </div>
      ) : null}

      <button
        type="button"
        disabled={!supported}
        onClick={() => props.migration.setSelected(!selected)}
        className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-background p-4 text-left transition-colors enabled:hover:bg-surface-hover/50 disabled:cursor-not-allowed disabled:opacity-70"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-5 shrink-0 items-center justify-center">
            <div
              className={`flex size-4 items-center justify-center rounded-sm border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}
            >
              <CheckIcon className="size-3.5" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <FileTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "onboarding.agentsFile.copyTitle" })}
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base">
          <div className="grid min-w-0 gap-1 sm:grid-cols-[5rem_1fr] sm:items-center">
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: "onboarding.agentsFile.sourceLabel" })}
            </span>
            <span className="min-w-0 truncate font-mono text-foreground">
              {status?.sourcePath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}
            </span>
          </div>
          <div className="grid min-w-0 gap-1 sm:grid-cols-[5rem_1fr] sm:items-center">
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: "onboarding.agentsFile.targetLabel" })}
            </span>
            <span className="min-w-0 truncate font-mono text-foreground">
              {status?.targetPath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}
            </span>
          </div>
        </div>

        {!supported && !props.migration.loading ? (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base leading-6 text-foreground">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{intl.formatMessage({ id: "onboarding.agentsFile.missingSource" })}</span>
          </div>
        ) : null}
      </button>
    </div>
  );
}
