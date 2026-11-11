import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function ToolDetailSection({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copied = value !== undefined && copiedValue === value;
  const copyLabel = intl.formatMessage({
    id: copied ? "chat.message.copy.copied" : "chat.message.copy",
  });
  return (
    <section
      data-fallback-section
      className="min-w-0 space-y-2 [&+section]:border-t [&+section]:border-border [&+section]:pt-3"
    >
      <header className="flex min-h-6 items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
        <h4>{label}</h4>
        {value !== undefined ? (
          <Button
            variant="ghost"
            size="icon-md"
            aria-label={`${copyLabel} ${label}`}
            title={copyLabel}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopiedValue(value);
                setCopyFailed(false);
              } catch {
                setCopiedValue(null);
                setCopyFailed(true);
              }
            }}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        ) : null}
      </header>
      {copyFailed ? (
        <p role="status" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "chat.toolCall.fallback.copyFailed" })}
        </p>
      ) : null}
      <div
        data-fallback-scroll
        className="max-h-60 min-w-0 overflow-auto text-ui-base text-foreground-subtle"
      >
        {children}
      </div>
    </section>
  );
}
