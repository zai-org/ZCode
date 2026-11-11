import type { UsageEntitlementSubscriptionDetail } from "@zcode/shared";
import { LoaderCircle, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function CodingPlanStatusMeta({
  renewTime,
  expireTime,
  extraAction,
  statusLabel,
  manageLabel,
  unlinkLabel,
  unlinkLoading,
  onManage,
  onUnlink,
}: {
  extraAction?: ReactNode;
  statusLabel?: ReactNode;
  renewTime?: string | null;
  expireTime?: string | null;
  manageLabel?: string | null;
  unlinkLabel?: string | null;
  unlinkLoading?: boolean;
  onManage?: () => void;
  onUnlink?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const subscriptionTime = resolveCodingPlanSubscriptionTime({
    renewTime,
    expireTime,
  });
  const subscriptionTimeLabel = subscriptionTime
    ? intl.formatMessage(
        {
          id:
            subscriptionTime.kind === "renew"
              ? "settings.modelProvider.codingPlan.renewsAt"
              : "settings.modelProvider.codingPlan.expiresAt",
        },
        {
          date: formatCodingPlanSubscriptionDate(subscriptionTime.value, locale),
        },
      )
    : null;
  const hasMetaContent = Boolean(
    statusLabel ||
    subscriptionTimeLabel ||
    extraAction ||
    (manageLabel && onManage) ||
    (unlinkLabel && onUnlink),
  );
  const fallbackStatusLabel =
    statusLabel ??
    (hasMetaContent
      ? null
      : intl.formatMessage({
          id: "settings.modelProvider.codingPlan.status.purchased",
        }));

  return (
    <span className="flex flex-wrap items-center gap-1.5 text-ui-base text-foreground-subtle">
      {fallbackStatusLabel ? <span>{fallbackStatusLabel}</span> : null}
      {subscriptionTimeLabel ? <span>{subscriptionTimeLabel}</span> : null}
      <CodingPlanMetaSeparator visible={Boolean(subscriptionTimeLabel && extraAction)} />
      {extraAction}
      <CodingPlanMetaSeparator
        visible={Boolean((subscriptionTimeLabel || extraAction) && manageLabel)}
      />
      {manageLabel && onManage ? (
        <CodingPlanMetaAction label={manageLabel} onClick={onManage} />
      ) : null}
      <CodingPlanMetaSeparator
        visible={Boolean(
          (subscriptionTimeLabel || extraAction || manageLabel || fallbackStatusLabel) &&
          unlinkLabel,
        )}
      />
      {unlinkLabel && onUnlink ? (
        <CodingPlanMetaAction label={unlinkLabel} loading={unlinkLoading} onClick={onUnlink} />
      ) : null}
    </span>
  );
}

export function StartPlanStatusMeta({
  expireTime,
  entitlements,
  hasQuota = false,
  refreshing = false,
  onRefresh,
}: {
  expireTime?: string | null;
  entitlements?: UsageEntitlementSubscriptionDetail["entitlements"];
  hasQuota?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    setCurrentTime(Date.now());
  }, [entitlements]);
  useEffect(() => {
    const pendingTime = resolvePendingStartPlanEffectiveTime(entitlements, currentTime);
    if (!pendingTime) return;
    const effectiveAt = Date.parse(pendingTime);
    const remainingMs = effectiveAt - Date.now();
    if (!Number.isFinite(effectiveAt) || remainingMs < 0) return;
    // setTimeout 存在约 24.8 天上限；长排期分段唤醒，到点后再切换刷新按钮。
    const timeout = window.setTimeout(
      () => setCurrentTime(Date.now()),
      Math.min(remainingMs + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [currentTime, entitlements]);
  const statusState = resolveStartPlanStatusMetaState({
    entitlements,
    hasQuota,
    now: currentTime,
  });
  const pendingEffectiveTime =
    statusState === "pending"
      ? resolvePendingStartPlanEffectiveTime(entitlements, currentTime)
      : null;
  const pendingEffectiveTimeLabel = pendingEffectiveTime
    ? intl.formatMessage(
        { id: "settings.modelProvider.startPlan.pendingUntil" },
        { date: formatStartPlanEffectiveDate(pendingEffectiveTime, locale) },
      )
    : null;
  const normalizedExpireTime = expireTime?.trim();
  const expireTimeLabel = normalizedExpireTime
    ? intl.formatMessage(
        { id: "settings.modelProvider.startPlan.expiresAt" },
        {
          date: formatStartPlanExpireDate(normalizedExpireTime, locale),
        },
      )
    : null;
  // 产品语义：待生效时展示排期；到点但额度桶尚未同步时提供就地刷新；
  // 对应额度桶出现后只保留过期日期。免费套餐无管理页，升级入口在卡片右侧。
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-ui-base text-foreground-subtle">
      {pendingEffectiveTimeLabel ? (
        <span className="whitespace-nowrap text-success">{pendingEffectiveTimeLabel}</span>
      ) : null}
      <CodingPlanMetaSeparator visible={Boolean(pendingEffectiveTimeLabel && expireTimeLabel)} />
      {statusState === "refreshable" && onRefresh ? (
        <>
          {/* Bug 原因：排期权益到点后服务端才创建额度桶，本地仍可能展示旧模型。
              就地刷新只在尚未拿到额度桶时出现；立即生效和已同步成功的套餐不显示。 */}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="rounded-full border-success/30 bg-success/14 px-2.5 font-medium text-success hover:border-success/50 hover:bg-success/20 hover:text-success dark:border-success/40 dark:bg-success/18 dark:hover:bg-success/24"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon className="size-3" aria-hidden="true" />
            )}
            {intl.formatMessage({
              id: "settings.modelProvider.startPlan.refreshEntitlement",
            })}
          </Button>
          <CodingPlanMetaSeparator visible={Boolean(expireTimeLabel)} />
        </>
      ) : null}
      {expireTimeLabel ? (
        <>
          {/* Bugfix: Start Plan 不展示 renew 时间，状态卡片只保留过期日期，避免把免费额度刷新时间误读成套餐续费。 */}
          <span className="whitespace-nowrap">{expireTimeLabel}</span>
        </>
      ) : null}
    </span>
  );
}

export function resolveStartPlanStatusMetaState({
  entitlements,
  hasQuota,
  now = Date.now(),
}: {
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"];
  hasQuota: boolean;
  now?: number;
}): "pending" | "refreshable" | "settled" {
  const effectiveTimes = (entitlements ?? []).flatMap((entitlement) => {
    const effectiveTime = entitlement.effectiveTime?.trim();
    if (!effectiveTime) return [];
    const milliseconds = Date.parse(effectiveTime);
    return Number.isFinite(milliseconds) ? [milliseconds] : [];
  });
  if (effectiveTimes.some((milliseconds) => milliseconds > now)) {
    return "pending";
  }
  if (
    !hasQuota &&
    // effective_at=0 会投影为 Unix Epoch，是立即生效哨兵值，不属于排期权益。
    effectiveTimes.some((milliseconds) => milliseconds > 0 && milliseconds <= now)
  ) {
    return "refreshable";
  }
  return "settled";
}

export function resolvePendingStartPlanEffectiveTime(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  now = Date.now(),
): string | null {
  const futureTimes = (entitlements ?? []).flatMap((entitlement) => {
    const effectiveTime = entitlement.effectiveTime?.trim();
    if (!effectiveTime) return [];
    const milliseconds = Date.parse(effectiveTime);
    return Number.isFinite(milliseconds) && milliseconds > now
      ? [{ effectiveTime, milliseconds }]
      : [];
  });
  futureTimes.sort((left, right) => left.milliseconds - right.milliseconds);
  return futureTimes[0]?.effectiveTime ?? null;
}

export function formatStartPlanEffectiveDate(
  value: string,
  locale: string,
  now = Date.now(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const currentDate = new Date(now);
  const dayDifference =
    resolveLocalCalendarDayIndex(date) - resolveLocalCalendarDayIndex(currentDate);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (dayDifference === 0 || dayDifference === 1) {
    const relativeDay = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      dayDifference,
      "day",
    );
    const displayDay = relativeDay.replace(/^./u, (character) =>
      character.toLocaleUpperCase(locale),
    );
    return `${displayDay} ${time}`;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function resolveLocalCalendarDayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function CodingPlanMetaSeparator({ visible }: { visible: boolean }) {
  return visible ? <span aria-hidden="true">·</span> : null;
}

function CodingPlanMetaAction({
  label,
  loading,
  onClick,
}: {
  label: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-ui-base font-medium text-brand underline-offset-2 hover:text-brand/80 hover:underline disabled:pointer-events-none disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function resolveCodingPlanSubscriptionTime({
  renewTime,
  expireTime,
}: {
  renewTime?: string | null;
  expireTime?: string | null;
}): { kind: "renew" | "expire"; value: string } | null {
  const normalizedRenewTime = renewTime?.trim();
  if (normalizedRenewTime) {
    return { kind: "renew", value: normalizedRenewTime };
  }

  const normalizedExpireTime = expireTime?.trim();
  if (normalizedExpireTime) {
    return { kind: "expire", value: normalizedExpireTime };
  }

  return null;
}

function formatCodingPlanSubscriptionDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const isCurrentYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(isCurrentYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    // 订阅接口返回的是日期语义，按本地时区格式化 ISO 零点会让美国时区显示成前一天。
    // 同一年隐藏年份时也要按 UTC 判断，否则临界时区会把“今年”误判成去年/明年。
    timeZone: "UTC",
  }).format(date);
}

export function formatStartPlanExpireDate(value: string, locale: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const isCurrentYear = date.getFullYear() === new Date(now).getFullYear();
  // Start Plan 过去只展示到期日，同一天内无法判断额度具体何时失效。
  // 过期时间按客户端本地时区补齐小时分钟，并继续仅在跨年时展示年份。
  return new Intl.DateTimeFormat(locale, {
    ...(isCurrentYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
