import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { resolveLocalizedText } from "@zcode/shared";
import type { PluginInstallRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PluginInstallCard({
  request,
  onRespond,
}: {
  request: PluginInstallRequestPayload;
  onRespond: (choice: "install" | "skip") => Promise<boolean>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const name =
    resolveLocalizedText(locale, request.displayName, request.displayNameI18n) ?? request.name;
  const description = resolveLocalizedText(locale, request.description, request.descriptionI18n);
  const act = async (choice: "install" | "skip") => {
    if (submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      if (!(await onRespond(choice))) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section
      data-testid="plugin-install-card"
      aria-label={intl.formatMessage({ id: "plugin.discovery.confirmTitle" })}
      className="mx-auto flex max-h-96 w-full max-w-xl flex-col gap-3 overflow-y-auto rounded-xl border border-card-border bg-card p-4 text-ui-base text-foreground"
    >
      <div className="flex min-w-0 items-start gap-3">
        <PluginIcon src={request.icon} className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{name}</div>
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "plugin.discovery.official" })}
          </div>
          {description ? (
            <p className="mt-1 break-words text-ui-sm text-foreground-subtle">{description}</p>
          ) : null}
        </div>
      </div>
      <p className="break-words">{request.reason}</p>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({
          id:
            request.scope === "workspace"
              ? request.action === "install"
                ? "plugin.discovery.workspaceInstall"
                : "plugin.discovery.workspaceEnable"
              : "plugin.discovery.userInstall",
        })}
      </p>
      {failed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "plugin.discovery.responseFailed" })}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          data-testid="plugin-install-skip"
          variant="ghost"
          className="rounded-lg text-foreground-subtle"
          disabled={submitting}
          onClick={() => void act("skip")}
        >
          {intl.formatMessage({ id: "plugin.discovery.skip" })}
        </Button>
        <Button
          data-testid="plugin-install-confirm"
          className="max-w-full rounded-lg"
          disabled={submitting}
          onClick={() => void act("install")}
        >
          {submitting ? <LoaderCircle className="animate-spin" /> : null}
          <span className="truncate">
            {intl.formatMessage({
              id:
                request.scope === "workspace"
                  ? request.action === "install"
                    ? "plugin.discovery.installAndEnable"
                    : "plugin.discovery.enableInWorkspace"
                  : request.action === "enable"
                    ? "plugin.discovery.enable"
                    : "plugin.discovery.install",
            })}
          </span>
        </Button>
      </div>
    </section>
  );
}
