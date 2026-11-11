import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2Icon, CircleAlertIcon, LoaderCircle, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

export type ProviderDetailFeedbackState = "pending" | "success" | "failure";

export interface ProviderDetailFeedbackInput {
  key: string;
  message: string;
  state: ProviderDetailFeedbackState;
  /** 连接测试成功使用语义绿；保存/删除沿用中性反馈，不按文案或 key 推断操作。 */
  successEmphasis?: boolean;
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
  dismissible?: boolean;
  dismissLabel?: string;
}

interface ProviderDetailFeedbackContextValue {
  showFeedback: (input: ProviderDetailFeedbackInput) => void;
  dismissFeedback: (key: string) => void;
}

const ProviderDetailFeedbackContext = createContext<ProviderDetailFeedbackContextValue>({
  showFeedback: () => undefined,
  dismissFeedback: () => undefined,
});

export function useProviderDetailFeedback(): ProviderDetailFeedbackContextValue {
  return useContext(ProviderDetailFeedbackContext);
}

function resolveDefaultDuration(state: ProviderDetailFeedbackState): number {
  if (state === "pending") return 0;
  return state === "failure" ? 8_000 : 3_500;
}

export function ProviderDetailFeedbackBoundary({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ProviderDetailFeedbackInput[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissFeedback = useCallback((key: string) => {
    const timer = timersRef.current.get(key);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(key);
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  const showFeedback = useCallback(
    (input: ProviderDetailFeedbackInput) => {
      const previousTimer = timersRef.current.get(input.key);
      if (previousTimer) clearTimeout(previousTimer);
      timersRef.current.delete(input.key);
      setItems((current) => {
        const existingIndex = current.findIndex((item) => item.key === input.key);
        if (existingIndex < 0) return [...current, input];
        const next = [...current];
        next[existingIndex] = input;
        return next;
      });

      const durationMs = input.durationMs ?? resolveDefaultDuration(input.state);
      if (durationMs > 0) {
        timersRef.current.set(
          input.key,
          setTimeout(() => dismissFeedback(input.key), durationMs),
        );
      }
    },
    [dismissFeedback],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const contextValue = useMemo(
    () => ({ showFeedback, dismissFeedback }),
    [dismissFeedback, showFeedback],
  );

  return (
    <ProviderDetailFeedbackContext.Provider value={contextValue}>
      {children}
      {/* 整页滚动后，内容底部可能在屏外；覆盖层不占高度，sticky 以 main 视口定位反馈。 */}
      <div className="pointer-events-none absolute inset-3 flex flex-col justify-end sm:inset-4">
        <div
          className="sticky bottom-3 z-20 flex flex-col gap-2 sm:bottom-4"
          data-testid="provider-detail-feedback-viewport"
          aria-live="polite"
        >
          {items.map((item) => (
            <div
              key={item.key}
              role={item.state === "failure" ? "alert" : "status"}
              data-provider-detail-feedback-state={item.state}
              className={cn(
                "pointer-events-auto flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm",
                item.state === "success" &&
                  (item.successEmphasis
                    ? "border-success/30 bg-success/10 text-success shadow-md"
                    : "border-border bg-popover/95 text-foreground shadow-md"),
                item.state === "failure" &&
                  "border-destructive/30 bg-destructive/10 text-destructive shadow-lg",
                item.state === "pending" && "border-border bg-popover/95 text-foreground shadow-md",
              )}
            >
              {item.state === "pending" ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : item.state === "success" ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 text-ui-sm font-medium">{item.message}</span>
              {item.actionLabel && item.onAction ? (
                <Button type="button" variant="ghost" size="sm" onClick={item.onAction}>
                  {item.actionLabel}
                </Button>
              ) : null}
              {item.dismissible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={item.dismissLabel ?? item.message}
                  onClick={() => dismissFeedback(item.key)}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </ProviderDetailFeedbackContext.Provider>
  );
}
