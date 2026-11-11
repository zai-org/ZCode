import { CheckIcon, ChevronRightIcon, InfoIcon, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const CONTEXT_USAGE_REFRESH_SUCCESS_MS = 1_000;

export function CodingPlanUsageHeaderAction({
  error,
  loading,
  onUsageClick,
  openLabel,
  refreshingLabel,
  updatedLabel,
  warningLabel,
}: {
  error: string | null | undefined;
  loading: boolean;
  onUsageClick?: () => void;
  openLabel: string;
  refreshingLabel: string;
  updatedLabel: string;
  warningLabel?: string;
}) {
  const [refreshActionState, setRefreshActionState] = useState<"idle" | "success">("idle");
  const previousLoadingRef = useRef<boolean | null>(null);

  useEffect(() => {
    const wasLoading = previousLoadingRef.current;
    previousLoadingRef.current = loading;
    if (loading) {
      setRefreshActionState("idle");
      return;
    }
    if (wasLoading === true && !error) {
      setRefreshActionState("success");
      const timeout = window.setTimeout(
        () => setRefreshActionState("idle"),
        CONTEXT_USAGE_REFRESH_SUCCESS_MS,
      );
      return () => window.clearTimeout(timeout);
    }
  }, [error, loading]);

  if (loading) {
    return (
      <span
        role="status"
        aria-label={refreshingLabel}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-foreground-subtle"
      >
        <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    );
  }

  if (refreshActionState === "success") {
    return (
      <span
        role="status"
        aria-label={updatedLabel}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-success"
      >
        <CheckIcon className="size-3.5" />
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {warningLabel ? (
        <TooltipProvider>
          <ControlHintTooltip title={warningLabel}>
            <span
              role="img"
              aria-label={warningLabel}
              className="inline-flex h-6 w-5 items-center justify-center text-warning"
            >
              <InfoIcon className="size-3.5" aria-hidden="true" />
            </span>
          </ControlHintTooltip>
        </TooltipProvider>
      ) : null}
      {onUsageClick ? (
        <button
          type="button"
          aria-label={openLabel}
          className="inline-flex h-6 shrink-0 items-center gap-0.5 text-ui-sm text-foreground-subtle hover:text-foreground hover:underline"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onUsageClick();
          }}
        >
          <span>{openLabel}</span>
          <ChevronRightIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}
