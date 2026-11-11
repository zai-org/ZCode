import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Copy, LoaderCircle, Maximize2, SlidersHorizontal, X } from "lucide-react";
import type { GenUiReference } from "@zcode/shared/gen-ui";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPortal,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useGenUi } from "@/hooks/useGenUi.js";
import { EMPTY_GEN_UI_SNAPSHOT, type GenUiCardTarget, type GenUiPage } from "../contract.js";
import { TweakPanel } from "./TweakPanel.js";
const subscribeEmpty = () => () => {};
function PageAnchor({ page, height }: { page: GenUiPage; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? page.bind(ref.current) : undefined), [page]);
  return (
    <div
      ref={ref}
      style={{ height, width: "calc(100% + 10px)", margin: -5 }}
      data-testid="gen-ui-anchor"
    />
  );
}
function PreviewAnchor({
  page,
  suspended,
  hasPanel,
}: {
  page: GenUiPage;
  suspended: boolean;
  hasPanel: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (suspended || !ref.current) return;
    page.preview(ref.current);
    return () => page.preview(null);
  }, [page, suspended]);
  // 预览位于 top layer，外层 Dialog 无法裁切；锚点向承载层传递实际底部圆角。
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1"
      style={{
        borderBottomLeftRadius: hasPanel ? 0 : "inherit",
        borderBottomRightRadius: hasPanel ? 0 : "inherit",
      }}
      data-testid="gen-ui-preview-anchor"
    />
  );
}
export function GenUiCard({
  target,
  reference,
}: {
  target: GenUiCardTarget;
  reference: GenUiReference;
}) {
  const { intl } = useZCodeIntl();
  const label = (id: string) => intl.formatMessage({ id: `genUi.${id}` });
  const [expanded, setExpanded] = useState(false),
    [tweaks, setTweaks] = useState(false),
    [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [copying, setCopying] = useState(false),
    [error, setError] = useState("");
  const expandButton = useRef<HTMLButtonElement>(null);
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const confirm = useCallback(
    (prompt: string) =>
      new Promise<string | null>((done) => {
        resolve.current?.(null);
        resolve.current = done;
        setDraft(prompt);
      }),
    [],
  );
  const finish = (value: string | null) => {
    resolve.current?.(value);
    resolve.current = null;
    setDraft(null);
  };
  useEffect(
    () => () => {
      resolve.current?.(null);
    },
    [],
  );
  const { page, supported, online, error: acquisitionError } = useGenUi(target, confirm, retry);
  const snapshot = useSyncExternalStore(
    page?.subscribe ?? subscribeEmpty,
    page?.getSnapshot ?? (() => EMPTY_GEN_UI_SNAPSHOT),
    () => EMPTY_GEN_UI_SNAPSHOT,
  );
  useEffect(() => {
    if (snapshot.escapeSequence) setExpanded(false);
  }, [snapshot.escapeSequence]);
  const title = reference.title || label("title");
  const loading = supported && online && snapshot.phase !== "error" && !acquisitionError;
  const status = !supported
    ? label("desktopOnly")
    : !online
      ? label("offline")
      : snapshot.phase === "error" || acquisitionError
        ? label("failed")
        : label("loading");
  const controls = (preview = false) => (
    <div
      role="toolbar"
      aria-label={title}
      className={
        preview
          ? "flex shrink-0 items-center justify-end gap-1 p-2"
          : "absolute right-0 bottom-0 z-20 flex gap-1 rounded-lg bg-popover p-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[visible=true]:opacity-100 [@media(hover:none)]:opacity-100"
      }
      data-visible={snapshot.hovered || tweaks}
      data-testid="gen-ui-actions"
    >
      {preview && (
        <DialogTitle
          className={reference.title ? "min-w-0 flex-1 truncate" : "sr-only"}
          title={title}
        >
          {title}
        </DialogTitle>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        title={label("copyImage")}
        aria-label={label("copyImage")}
        disabled={copying || snapshot.phase !== "ready"}
        onClick={async () => {
          if (!page) return;
          setCopying(true);
          setError("");
          try {
            // 复制成功不保留视觉状态；原 copied 未复位，会让图标永久停在对勾。
            await page.copyImage();
          } catch (reason) {
            setError(String(reason));
          } finally {
            setCopying(false);
          }
        }}
      >
        <Copy />
      </Button>
      {snapshot.groups.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={label("tweak")}
          aria-label={label("tweak")}
          aria-pressed={tweaks}
          onClick={() => setTweaks(!tweaks)}
        >
          <SlidersHorizontal />
        </Button>
      )}
      <Button
        ref={preview ? undefined : expandButton}
        variant="ghost"
        size="icon-sm"
        title={label(preview ? "collapse" : "expand")}
        aria-label={label(preview ? "collapse" : "expand")}
        onClick={() => setExpanded(!preview)}
      >
        {preview ? <X /> : <Maximize2 />}
      </Button>
    </div>
  );
  const panel =
    tweaks && snapshot.groups.length > 0 && page ? (
      <TweakPanel snapshot={snapshot} page={page} />
    ) : null;
  // 会话父容器已经负责宽度；卡片再次限宽会让 inline UI 无法填满正文。
  return (
    <section className="my-3 w-full" data-testid="gen-ui-card" data-gen-ui-phase={snapshot.phase}>
      <div className="group relative flow-root">
        {(snapshot.phase !== "ready" || !page) && (
          <div className="space-y-2 py-3 text-ui-base text-foreground-subtle" role="status">
            <p className="flex items-center gap-2">
              {loading && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
              {status}
            </p>
            {(snapshot.error || acquisitionError) && (
              <p className="break-words text-ui-xs">{snapshot.error || acquisitionError}</p>
            )}
            {supported && (snapshot.phase === "error" || !online || acquisitionError) && (
              <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {label("retry")}
              </Button>
            )}
          </div>
        )}
        {page && <PageAnchor page={page} height={snapshot.height} />}
        {snapshot.phase === "ready" && controls()}
      </div>
      {!expanded && panel}
      {error && (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog open={expanded} onOpenChange={setExpanded} modal={false}>
        {expanded && (
          <DialogPortal>
            <div
              className="fixed inset-0 z-40 bg-black/60"
              data-testid="gen-ui-backdrop"
              onPointerDown={() => setExpanded(false)}
            />
          </DialogPortal>
        )}
        <DialogContent
          showOverlay={false}
          showCloseButton={false}
          aria-describedby={undefined}
          className="z-40 flex h-[85vh] w-[min(1100px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 data-open:animate-none data-closed:animate-none"
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandButton.current?.focus();
          }}
        >
          {controls(true)}
          {page && (
            <PreviewAnchor page={page} suspended={draft !== null} hasPanel={panel !== null} />
          )}
          {panel}
        </DialogContent>
      </Dialog>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) finish(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label("confirm")}</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft ?? ""}
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => finish(null)}>
              {label("cancel")}
            </Button>
            <Button disabled={!draft?.trim()} onClick={() => finish(draft)}>
              {label("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
