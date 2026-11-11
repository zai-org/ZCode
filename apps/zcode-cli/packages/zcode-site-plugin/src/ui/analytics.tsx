import { useState, type PointerEvent } from "react";
import { RotateCw } from "lucide-react";
import { ANALYTICS_RANGES, type AnalyticsRange } from "../contract.ts";
import { formatRelative, type Locale, type MessageKey } from "./i18n.ts";
import {
  chartPoints,
  formatCount,
  formatDuration,
  formatShare,
  isDeviceType,
  type AnalyticsPoint,
  type AnalyticsShare,
  type SiteAnalytics,
} from "./model.ts";
import { Loading, useView, type ViewState } from "./parts.tsx";

/**
 * 站点的「数据统计」标签（技术方案 8.1）：区间切换、四个核心指标、PV / UV 趋势和四种分布。
 * 数据在用户查看时由服务端即时查询，缓存 10 分钟；没算完时显示加载并自动重试。
 */
export function AnalyticsTab({ state }: { state: ViewState }) {
  const { t, actions } = useView();
  const range = state.analyticsRange;
  const current = state.analytics[range];
  return (
    <div className="stack-4">
      <div className="row between wrap-row gap-2">
        <RangeSwitch value={range} onChange={actions.setAnalyticsRange} />
        {current?.status === "ready" && <Updated iso={current.generatedAt} />}
      </div>
      {!current || current.status === "loading" ? (
        <div className="stack-1 center-text">
          <Loading />
          <p className="subtle sm">{t("sites.analytics.computing")}</p>
        </div>
      ) : current.status === "failed" ? (
        <div className="dashed column">
          <span>{t("sites.analytics.failed")}</span>
          <button
            type="button"
            className="btn outline sm"
            onClick={() => actions.setAnalyticsRange(range)}
          >
            <RotateCw />
            {t("sites.retry")}
          </button>
        </div>
      ) : (
        <Report data={current} />
      )}
      <p className="subtlest sm">{t("sites.analytics.note")}</p>
    </div>
  );
}

export function RangeSwitch({
  value,
  onChange,
}: {
  value: AnalyticsRange;
  onChange: (range: AnalyticsRange) => void;
}) {
  const { t } = useView();
  return (
    <div className="seg" role="group">
      {ANALYTICS_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={range === value}
          onClick={() => range !== value && onChange(range)}
        >
          {t(`sites.analytics.range.${range}`)}
        </button>
      ))}
    </div>
  );
}

function Updated({ iso }: { iso: string }) {
  const { t, locale, timeZone } = useView();
  return (
    <span className="subtlest sm">
      {t("sites.analytics.updated", {
        time: formatRelative(iso, locale, Date.now(), timeZone),
      })}
    </span>
  );
}

function Report({ data }: { data: SiteAnalytics }) {
  const { t, locale } = useView();
  const summary = data.summary;
  if (!summary) return <p className="dashed">{t("sites.analytics.empty")}</p>;
  return (
    <div className="stack-4">
      {data.partial && (
        <p className="subtle sm warning-text">{t("sites.analytics.partial")}</p>
      )}
      <dl className="stats">
        <Stat label={t("sites.analytics.pv")} value={formatCount(summary.pv)} />
        <Stat label={t("sites.analytics.uv")} value={formatCount(summary.uv)} />
        <Stat
          label={t("sites.analytics.duration")}
          value={formatDuration(summary.avgDurationSeconds, locale)}
        />
        <Stat
          label={t("sites.analytics.bounce")}
          value={formatShare(summary.bounceRate)}
        />
      </dl>
      {data.series && (
        <Trend key={data.range} series={data.series} range={data.range} />
      )}
      <div className="shares">
        <ShareList
          title="sites.analytics.pages"
          items={data.pages}
          label={(key) => key || "/"}
        />
        <ShareList
          title="sites.analytics.referrers"
          items={data.referrers}
          label={(key) => key || t("sites.analytics.direct")}
        />
        <ShareList
          title="sites.analytics.devices"
          items={data.devices}
          label={(key) =>
            isDeviceType(key)
              ? t(`sites.analytics.device.${key}`)
              : key || t("sites.analytics.unknown")
          }
        />
        <ShareList
          title="sites.analytics.regions"
          items={data.regions}
          label={(key) => key || t("sites.analytics.unknown")}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt className="subtle sm">{label}</dt>
      <dd className="stat-value">{value}</dd>
    </div>
  );
}

const W = 600;
const H = 160;

/**
 * PV 实线带面积、UV 实线。悬停（触屏按住拖动）时取离指针最近的桶，画竖线和两个点，
 * 浮层显示该桶的时间和 PV / UV。不用 SVG <title>：宿主 iframe 里原生提示不可靠。
 */
function Trend({
  series,
  range,
}: {
  series: AnalyticsPoint[];
  range: AnalyticsRange;
}) {
  const { t, locale, timeZone } = useView();
  const [active, setActive] = useState<number>();
  const pv = chartPoints(series.map((point) => point.pv));
  // UV 和 PV 用同一个纵轴，不单独归一：UV 线始终在 PV 线下方。
  const max = Math.max(0, ...series.map((point) => point.pv));
  const uv = series.map((point, index) => ({
    x: pv[index].x,
    y: max === 0 ? 0 : point.uv / max,
  }));
  const path = (points: { x: number; y: number }[]) =>
    points
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${(p.x * W).toFixed(1)},${(H - p.y * H).toFixed(1)}`,
      )
      .join(" ");
  const line = path(pv);
  const area = `${line} L${W},${H} L0,${H} Z`;
  const point = active === undefined ? undefined : series[active];
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - box.left) / box.width),
    );
    let nearest = 0;
    for (let i = 1; i < pv.length; i++)
      if (Math.abs(pv[i].x - ratio) < Math.abs(pv[nearest].x - ratio))
        nearest = i;
    setActive(nearest);
  };
  return (
    <section className="card trend">
      <header className="row between gap-2">
        <div className="stack-1">
          <h3>{t("sites.analytics.trend")}</h3>
          <p className="subtlest xs">
            {t("sites.analytics.peak", { value: formatCount(max) })}
          </p>
        </div>
        <div className="legend">
          <span className="legend-pv">PV</span>
          <span className="legend-uv">UV</span>
        </div>
      </header>
      <div
        className="chart-wrap"
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(undefined)}
      >
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("sites.analytics.trend")}
        >
          {[0.25, 0.5, 0.75].map((y) => (
            <line
              key={y}
              className="chart-grid"
              x1="0"
              x2={W}
              y1={H * y}
              y2={H * y}
            />
          ))}
          <defs>
            <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart-area-top" />
              <stop offset="100%" className="chart-area-bottom" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#chart-area)" />
          {active !== undefined && (
            <line
              className="chart-guide"
              x1={pv[active].x * W}
              x2={pv[active].x * W}
              y1="0"
              y2={H}
            />
          )}
          <path className="chart-pv" d={line} />
          <path className="chart-uv" d={path(uv)} />
        </svg>
        {active !== undefined && point && (
          <>
            {/* 点用 HTML 画：SVG 按 preserveAspectRatio="none" 拉伸，圆会变形。 */}
            <span
              className="chart-dot uv"
              style={{
                left: `${uv[active].x * 100}%`,
                top: `${(1 - uv[active].y) * 100}%`,
              }}
            />
            <span
              className="chart-dot pv"
              style={{
                left: `${pv[active].x * 100}%`,
                top: `${(1 - pv[active].y) * 100}%`,
              }}
            />
            <div
              className="chart-tip"
              style={
                pv[active].x > 0.5
                  ? { right: `calc(${(1 - pv[active].x) * 100}% + 10px)` }
                  : { left: `calc(${pv[active].x * 100}% + 10px)` }
              }
            >
              <span className="subtle">
                {bucketLabel(point.start, range, locale, timeZone)}
              </span>
              <span className="chart-tip-row pv">
                <span>PV</span>
                <span>{formatCount(point.pv)}</span>
              </span>
              <span className="chart-tip-row uv">
                <span>UV</span>
                <span>{formatCount(point.uv)}</span>
              </span>
            </div>
          </>
        )}
      </div>
      <div className="row between subtlest xs">
        <span>{bucketLabel(series[0].start, range, locale, timeZone)}</span>
        <span>
          {bucketLabel(series.at(-1)!.start, range, locale, timeZone)}
        </span>
      </div>
    </section>
  );
}

/** 24 小时按小时分桶显示「月/日 时:00」，7 / 30 天按天显示「月/日」。 */
function bucketLabel(
  iso: string,
  range: AnalyticsRange,
  locale: Locale,
  timeZone: string | undefined,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    ...(range === "24h"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
    ...(timeZone ? { timeZone } : {}),
  });
}

function ShareList({
  title,
  items,
  label,
}: {
  title: MessageKey;
  items: AnalyticsShare[] | null;
  label: (key: string) => string;
}) {
  const { t } = useView();
  if (!items?.length) return null;
  return (
    <section className="card share-card">
      <header className="row between">
        <h3>{t(title)}</h3>
        <span className="subtlest xs">PV</span>
      </header>
      <ul className="share-list">
        {items.map((item) => (
          <li key={item.key} className="share-row">
            <div className="row between gap-2">
              <span className="truncate" title={label(item.key)}>
                {label(item.key)}
              </span>
              <span className="share-num">
                {formatCount(item.pv)}
                <span className="subtlest">{formatShare(item.share)}</span>
              </span>
            </div>
            <div className="share-track">
              <div
                className="share-fill"
                style={{
                  width: `${Math.min(100, Math.round(item.share * 100))}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
