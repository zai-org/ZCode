import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ZCodeTaskSnapshotToolFieldRef } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ToolSnapshotFieldNotice({
  refs,
  onLoadFullToolCallFields,
}: {
  refs: readonly ZCodeTaskSnapshotToolFieldRef[];
  onLoadFullToolCallFields?: () => Promise<boolean | void> | boolean | void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  if (refs.length === 0 || !onLoadFullToolCallFields) {
    return null;
  }

  const previewBytes = refs.reduce((total, ref) => total + ref.previewBytes, 0);
  const fullBytes = refs.reduce((total, ref) => total + ref.fullBytes, 0);
  const description = intl.formatMessage(
    { id: "chat.toolCall.snapshot.notice" },
    {
      fields: String(refs.length),
      previewBytes: formatBytes(previewBytes, locale),
      fullBytes: formatBytes(fullBytes, locale),
    },
  );
  const buttonLabel = intl.formatMessage({
    id: loading
      ? "chat.toolCall.snapshot.loading"
      : failed
        ? "chat.toolCall.snapshot.retry"
        : "chat.toolCall.snapshot.loadFull",
  });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-ui-base text-foreground-subtle sm:flex-row sm:items-center sm:justify-between">
      <span>{description}</span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 self-start px-2 text-ui-base sm:self-auto"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setFailed(false);
          void Promise.resolve(onLoadFullToolCallFields())
            .then(
              (result) => {
                setFailed(result === false);
              },
              () => {
                setFailed(true);
              },
            )
            .finally(() => {
              setLoading(false);
            });
        }}
      >
        {loading ? <LoaderCircle className="mr-1 size-3 animate-spin" /> : null}
        {buttonLabel}
      </Button>
    </div>
  );
}

function formatBytes(bytes: number, locale: string): string {
  if (bytes >= 1024 * 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
  }
  if (bytes >= 1024) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
  }
  return `${new Intl.NumberFormat(locale).format(bytes)} B`;
}
