import { LoaderCircle, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useEffect, useState } from "react";
import { CloudInteractiveBundleHero } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import { CloudVideo } from "@/components/cloud-content-dialog/CloudDialogMediaHero.js";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

interface MarketingBannerProps {
  src?: string;
  video?: Extract<CloudDialogHero, { type: "video" }>;
  bundle?: Extract<CloudDialogHero, { type: "interactive_bundle" }>;
  locale?: string;
  hasAction: boolean;
  hasClose: boolean;
  actionLabel: string;
  closeLabel: string;
  pendingLabel: string;
  pending: boolean;
  onClick: () => void;
  onClose: () => void;
}

export function MarketingBannerView(props: MarketingBannerProps) {
  return (
    <MarketingBannerContent
      key={props.bundle?.resolvedUrl ?? props.video?.src ?? props.src}
      {...props}
    />
  );
}

function MarketingBannerContent(props: MarketingBannerProps) {
  const [bundleReady, setBundleReady] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ready = !props.bundle || bundleReady;
  useEffect(() => {
    const clearHover = () => setHovered(false);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearHover();
    };
    window.addEventListener("blur", clearHover);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", clearHover);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <div
      className="relative w-full"
      data-testid="marketing-banner"
      aria-busy={props.pending}
      onPointerEnter={(event) => setHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      style={ready ? undefined : { height: 0, overflow: "hidden", visibility: "hidden" }}
    >
      {/* 由同一按钮裁切图片与 iframe，避免资源越过圆角；关闭/loading 保留为兄弟覆盖层。 */}
      <button
        type="button"
        disabled={!ready || props.pending || !props.hasAction}
        aria-label={props.hasAction ? props.actionLabel : undefined}
        onClick={props.onClick}
        className="block h-24 w-full overflow-hidden rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 disabled:cursor-default"
      >
        {props.bundle ? (
          <span
            className="pointer-events-none block size-full overflow-hidden"
            aria-hidden="true"
            inert
          >
            <CloudInteractiveBundleHero
              hero={props.bundle}
              locale={props.locale ?? "en-US"}
              title={props.actionLabel}
              presentation
              hovered={ready && !props.pending && hovered}
              onReadyChange={setBundleReady}
            />
          </span>
        ) : props.video ? (
          <span
            className="pointer-events-none block size-full overflow-hidden"
            aria-hidden="true"
            inert
          >
            <CloudVideo hero={props.video} title={props.actionLabel} presentation />
          </span>
        ) : (
          <img
            src={props.src}
            alt={props.hasAction ? props.actionLabel : ""}
            className="block size-full object-cover"
            draggable={false}
          />
        )}
      </button>
      {props.pending ? (
        // 原 bg-card 让关闭/loading 带上常驻底色；两种状态都保持透明。
        <span
          role="status"
          className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full text-foreground"
        >
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only">{props.pendingLabel}</span>
        </span>
      ) : props.hasClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.closeLabel}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
          className="absolute right-2.5 top-2.5 rounded-full text-foreground-subtle hover:bg-hover hover:text-foreground focus-visible:ring-foreground/50"
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
