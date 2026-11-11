import type {
  CodingPlanBillingDiscountConfig,
  CodingPlanBillingDiscountLocaleCopy,
  Locale,
} from "@zcode/shared";
import { toZhOrEnLocale } from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import { InfoIcon, SparklesIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { logger } from "@/logger.js";

const BILLING_DISCOUNT_CACHE_TTL_MS = 60 * 60 * 1000;
export const CODING_PLAN_BILLING_DISCOUNT_DIALOG_CONTENT_CLASS =
  "max-h-[min(82vh,640px)] max-w-lg grid-rows-[auto_minmax(0,1fr)] overflow-hidden";
export const CODING_PLAN_BILLING_DISCOUNT_DIALOG_BODY_CLASS = "p-3 !space-y-3";

let billingDiscountCache: {
  value: CodingPlanBillingDiscountConfig | undefined;
  expiresAt: number;
} | null = null;
let billingDiscountRequest: Promise<
  CodingPlanBillingDiscountConfig | undefined
> | null = null;

export function useCodingPlanBillingDiscount(): {
  active: boolean;
  config: CodingPlanBillingDiscountConfig | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const services = useOptionalServices();
  return useCodingPlanBillingDiscountFromService(
    services?.codingPlanSubscriptionService,
  );
}

export function useCodingPlanBillingDiscountFromService(
  service:
    | Pick<ICodingPlanSubscriptionService, "getBillingDiscount">
    | undefined,
): {
  active: boolean;
  config: CodingPlanBillingDiscountConfig | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { locale } = useZCodeIntl();
  const [state, setState] = useState({
    active: hasLocaleCopy(billingDiscountCache?.value, locale, ["badgeBody"]),
    config: billingDiscountCache?.value,
    loading: Boolean(service) && !billingDiscountCache,
  });

  const refresh = useCallback(async () => {
    if (!service || typeof service.getBillingDiscount !== "function") {
      setState({ active: false, config: undefined, loading: false });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    try {
      const discount = await loadCodingPlanBillingDiscount(service);
      setState({
        active: hasLocaleCopy(discount, locale, ["badgeBody"]),
        config: discount,
        loading: false,
      });
    } catch (error) {
      logger.warn("[CodingPlanBillingDiscount] 读取 Coding Plan 活动配置失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setState({ active: false, config: undefined, loading: false });
    }
  }, [locale, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    active: state.active,
    config: state.config,
    loading: state.loading,
    refresh,
  };
}

export function resolveCodingPlanBillingDiscountCopy(
  config: CodingPlanBillingDiscountConfig | undefined,
  locale: Locale,
): CodingPlanBillingDiscountLocaleCopy {
  // 远程配置只约定 zh-CN/en-US 两套文案；日/俄/韩取不到时回退英文，否则折扣徽标和卡片会整体消失。
  const copy = config?.[locale] ?? config?.[toZhOrEnLocale(locale)];
  if (!copy || typeof copy !== "object") {
    return {};
  }
  return {
    badgeBody: readNonEmptyString(copy.badgeBody),
    cardTitle: readNonEmptyString(copy.cardTitle),
    cardBody: readNonEmptyString(copy.cardBody),
    infoTitle: readNonEmptyString(copy.infoTitle),
    infoBody: readNonEmptyString(copy.infoBody),
  };
}

function hasLocaleCopy(
  config: CodingPlanBillingDiscountConfig | undefined,
  locale: Locale,
  keys: Array<keyof CodingPlanBillingDiscountLocaleCopy>,
): boolean {
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  return keys.every((key) => Boolean(copy[key]));
}

type CodingPlanBillingDiscountBadgePillProps = {
  config?: CodingPlanBillingDiscountConfig;
  iconVisible?: boolean;
  size?: "default" | "compact";
  variant?: "gradient" | "surface" | "tag";
};

export function CodingPlanBillingDiscountBadgePill({
  config,
  iconVisible = true,
  size = "default",
  variant = "gradient",
}: CodingPlanBillingDiscountBadgePillProps) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  if (!copy.badgeBody) {
    return null;
  }
  return (
    <div
      className={cn(
        // Bugfix: 活动徽标文案来自服务端多语言配置，英文可能需要保留 Title Case。
        // 不能用 uppercase 强制转写，否则 "150% Quota" 会被渲染成 "150% QUOTA"。
        "inline-flex items-center py-0.5 whitespace-nowrap",
        size === "compact"
          ? "gap-0.5 px-1.5 text-ui-xs leading-none"
          : "gap-1 px-2 text-ui-xs",
        variant === "surface"
          ? "rounded-full bg-white text-[#191A1D]"
          : variant === "tag"
            ? "rounded-full bg-tag text-foreground"
            : "rounded-full text-white button-gradient dark:bg-[#484A58]",
      )}
    >
      {iconVisible ? (
        <TrendingUpIcon
          className={size === "compact" ? "size-2.5" : "size-3"}
        />
      ) : null}
      {copy.badgeBody}
    </div>
  );
}

export function CodingPlanBillingDiscountBadge(
  props: CodingPlanBillingDiscountBadgePillProps,
) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(props.config, locale);
  if (!copy.badgeBody) {
    return null;
  }
  const badge = <CodingPlanBillingDiscountBadgePill {...props} />;
  return (
    <>
      {badge}
      <CodingPlanBillingDiscountInfoDialog
        config={props.config}
        tone={props.variant === "surface" ? "onGradient" : "default"}
      />
    </>
  );
}

export function CodingPlanBillingDiscountBanner({
  config,
}: {
  config?: CodingPlanBillingDiscountConfig;
}) {
  const { locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  if (!copy.cardTitle || !copy.cardBody) {
    return null;
  }
  return (
    <div className="rounded-xl border border-transparent button-gradient px-3 py-2.5 text-white dark:bg-[#484A58]">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex h-6 shrink-0 items-center">
            <SparklesIcon className="size-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-ui-lg font-medium leading-6 text-white">
              {copy.cardTitle}
            </div>
            <div className="mt-0.5 text-ui-base leading-5 text-white/80">
              {copy.cardBody}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CodingPlanBillingDiscountBadge config={config} variant="surface" />
        </div>
      </div>
    </div>
  );
}

export function CodingPlanBillingDiscountInfoDialog({
  config,
  tone = "default",
}: {
  config?: CodingPlanBillingDiscountConfig;
  tone?: "default" | "onGradient";
}) {
  const { intl, locale } = useZCodeIntl();
  const copy = resolveCodingPlanBillingDiscountCopy(config, locale);
  // M5②.5 store 耦合剥离：MessageResponse 不再自取 store，主题/代码预览设置由调用方传入。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const openLabel = intl.formatMessage({
    id: "settings.modelProvider.codingPlan.billingDiscountInfo.open",
  });
  // 活动规则会随服务端运营配置变化，必须整体使用远端标题和 Markdown 正文，
  // 缺失时隐藏入口，避免本地旧规则与当前活动不一致。
  if (!copy.infoTitle || !copy.infoBody) {
    return null;
  }
  const markdown = `## ${copy.infoTitle}\n\n${copy.infoBody}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <InfoIcon
          role="button"
          tabIndex={0}
          aria-label={openLabel}
          className={cn(
            "size-3.5 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            tone === "onGradient"
              ? "text-white/90 hover:text-white"
              : "text-foreground-subtle hover:text-foreground",
          )}
        />
      </DialogTrigger>
      <DialogContent
        className={cn(
          CODING_PLAN_BILLING_DISCOUNT_DIALOG_CONTENT_CLASS,
          "block",
        )}
      >
        <div className={CODING_PLAN_BILLING_DISCOUNT_DIALOG_BODY_CLASS}>
          <MessageResponse
            className="min-h-0 overflow-y-auto pr-1 text-foreground"
            theme={theme}
            codePreviewSettings={codePreviewSettings}
          >
            {markdown}
          </MessageResponse>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function clearCodingPlanBillingDiscountCacheForTest() {
  billingDiscountCache = null;
  billingDiscountRequest = null;
}

export function primeCodingPlanBillingDiscountCacheForTest(
  config: CodingPlanBillingDiscountConfig | undefined,
) {
  billingDiscountCache = {
    value: config,
    expiresAt: Date.now() + BILLING_DISCOUNT_CACHE_TTL_MS,
  };
  billingDiscountRequest = null;
}

async function loadCodingPlanBillingDiscount(
  service: Pick<ICodingPlanSubscriptionService, "getBillingDiscount">,
): Promise<CodingPlanBillingDiscountConfig | undefined> {
  const now = Date.now();
  if (billingDiscountCache && billingDiscountCache.expiresAt > now) {
    return billingDiscountCache.value;
  }
  if (billingDiscountRequest) {
    return billingDiscountRequest;
  }

  const request = service.getBillingDiscount();
  billingDiscountRequest = request;
  try {
    const discount = await request;
    billingDiscountCache = {
      value: discount,
      expiresAt: now + BILLING_DISCOUNT_CACHE_TTL_MS,
    };
    return discount;
  } finally {
    if (billingDiscountRequest === request) {
      billingDiscountRequest = null;
    }
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
