import { type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Globe,
  HardDrive,
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
import { formatTime, type MessageKey } from "./i18n.ts";
import {
  filterSites,
  formatCount,
  formatMeter,
  listMenu,
  meterPercent,
  planName,
  siteHost,
  sitePhase,
  type Metric,
  type Site,
  type Usage,
} from "./model.ts";
import {
  useView,
  Loading,
  PromptMenu,
  Alert,
  Meta,
  StatusLabel,
  RelativeTime,
  Ctx,
  Cover,
} from "./parts.tsx";
import type { ViewContext, ViewState } from "./parts.tsx";
import { SitePage } from "./site.tsx";

export type { ViewActions, ViewContext, ViewState } from "./parts.tsx";

export function App({ state, view }: { state: ViewState; view: ViewContext }) {
  return (
    <Ctx.Provider value={view}>
      {state.statusPage ? (
        state.statusPage === "login" ? (
          <LoginPage />
        ) : (
          <StatusPage messageKey={`sites.error.${state.statusPage}`} />
        )
      ) : (
        <div className="shell">
          <div className="scroll">
            <main className="page">
              {state.bar && <ErrorBar bar={state.bar} />}
              <CurrentPage state={state} />
            </main>
          </div>
          {state.route.page === "list" && state.usage && (
            <UsageBar usage={state.usage} />
          )}
        </div>
      )}
      {state.toast && (
        <div className="toast" role="status">
          {state.toast}
        </div>
      )}
    </Ctx.Provider>
  );
}

function CurrentPage({ state }: { state: ViewState }) {
  const { route } = state;
  if (route.page === "list") return <ListPage state={state} />;
  if (route.page === "usage")
    return <UsagePage usage={state.usage} plans={state.plans} />;
  return <SitePage state={state} />;
}

function LoginPage() {
  const { t } = useView();
  return (
    <main className="state-page">
      <Globe className="state-icon" />
      <div className="state-text">
        <p className="empty-title">{t("sites.login.title")}</p>
        <p>{t("sites.login.intro")}</p>
        <p className="state-note">{t("sites.login.note")}</p>
      </div>
      <RetryButton />
    </main>
  );
}

function StatusPage({ messageKey }: { messageKey: MessageKey }) {
  const { t } = useView();
  return (
    <main className="state-page">
      <CircleAlert className="state-icon" />
      <p>{t(messageKey)}</p>
      <RetryButton />
    </main>
  );
}

function RetryButton() {
  const { t, actions } = useView();
  return (
    <button type="button" className="btn outline" onClick={actions.refresh}>
      <RotateCw />
      {t("sites.retry")}
    </button>
  );
}

function ErrorBar({ bar }: { bar: NonNullable<ViewState["bar"]> }) {
  const { t, actions } = useView();
  return (
    <div className="alert" role="alert">
      <CircleAlert className="alert-icon" />
      <div className="alert-body">
        <p className="alert-title">{t(bar.key)}</p>
        {bar.logid && (
          <p className="subtle">
            {t("sites.error.logid", { logid: bar.logid })}
          </p>
        )}
      </div>
      <button type="button" className="btn ghost sm" onClick={actions.refresh}>
        {t("sites.retry")}
      </button>
    </div>
  );
}

// ---------- 列表 ----------

function ListPage({ state }: { state: ViewState }) {
  const { t, actions } = useView();
  const sites = state.sites;
  const shown = sites ? filterSites(sites.items, state.query) : [];
  return (
    <div className="stack-4">
      <header className="row between">
        <div className="title-row">
          <h1>{t("sites.title")}</h1>
          {sites && sites.items.length > 0 && (
            <span className="count">
              {sites.items.length}
              {sites.nextCursor ? "+" : ""}
            </span>
          )}
        </div>
        <PromptMenu
          items={listMenu(state.commands)}
          label={t("sites.list.newDeployment")}
          icon={<Plus />}
          primary
          newDeployment
        />
      </header>
      {!sites ? (
        <Loading />
      ) : sites.items.length === 0 ? (
        <div className="empty">
          <Globe className="empty-icon" />
          <p className="empty-title">{t("sites.list.emptyTitle")}</p>
          <p className="subtle">{t("sites.list.emptyHint")}</p>
        </div>
      ) : (
        <>
          <label className="search">
            <Search />
            <input
              type="search"
              value={state.query}
              placeholder={t("sites.list.search")}
              aria-label={t("sites.list.search")}
              onChange={(event) => actions.setQuery(event.target.value)}
            />
          </label>
          {shown.length === 0 ? (
            <p className="dashed">{t("sites.list.noMatch")}</p>
          ) : (
            <ul className="cards">
              {shown.map((site) => (
                <SiteCard
                  key={site.id}
                  site={site}
                  covers={state.covers}
                  pv24h={state.pv24h[site.id]}
                />
              ))}
            </ul>
          )}
          {sites.nextCursor && (
            <button
              type="button"
              className="btn ghost center"
              onClick={actions.loadMoreSites}
            >
              {t("sites.loadMore")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SiteCard({
  site,
  covers,
  pv24h,
}: {
  site: Site;
  covers: Record<string, string>;
  /** undefined 是还在读，null 是没查出来，都显示「—」。 */
  pv24h: number | null | undefined;
}) {
  const { t, actions } = useView();
  const time = site.latestDeployment?.updatedAt ?? site.updatedAt;
  return (
    <li className="card site-card">
      <button
        type="button"
        className="site-main"
        onClick={() => actions.navigate({ page: "site", siteId: site.id })}
      >
        <Cover site={site} covers={covers} />
        <span className="site-text">
          <span className="site-name">{site.name}</span>
          <span className="site-host">
            {site.currentDeployment
              ? siteHost(site)
              : t("sites.list.notPublished")}
          </span>
          <Meta>
            <StatusLabel phase={sitePhase(site)} />
            <RelativeTime iso={time} />
            {/* 窄面板没有右侧的 PV 列，PV 放进元信息行。 */}
            <span className="pv-meta" title={t("sites.list.pv24h")}>
              {t("sites.list.pvMeta", { value: formatCount(pv24h) })}
            </span>
          </Meta>
        </span>
      </button>
      <span className="site-pv" title={t("sites.list.pv24h")}>
        <span className="site-pv-value">{formatCount(pv24h)}</span>
        <span className="site-pv-label">{t("sites.list.pv24h")}</span>
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("sites.visit")}
        title={t("sites.visit")}
        disabled={site.status !== "online"}
        onClick={() => actions.openLink(site.url)}
      >
        <ArrowUpRight />
      </button>
    </li>
  );
}

function UsageBar({ usage }: { usage: Usage }) {
  const { t, actions } = useView();
  const item = (metric: Metric, label: MessageKey) =>
    t("sites.usage.bar", {
      label: t(label),
      used: formatMeter(metric, usage[metric].used),
      limit: formatMeter(metric, usage[metric].limit),
    });
  return (
    <footer
      className={`usage-bar${usage.quotaState === "exceeded" ? " danger" : ""}`}
    >
      <div className="usage-bar-inner">
        <span className="usage-bar-text">
          {item("traffic", "sites.usage.traffic")}
          <span className="wide-only">
            {" "}
            · {item("requests", "sites.usage.requests")}
          </span>
          <span className="wide-only">
            {" "}
            · {item("sites", "sites.usage.sites")}
          </span>
        </span>
        <button
          type="button"
          className="btn ghost"
          onClick={() => actions.navigate({ page: "usage" })}
        >
          {t("sites.usage.title")}
          <ChevronRight />
        </button>
      </div>
    </footer>
  );
}

// ---------- 用量 ----------

const METRIC_VIEWS: { metric: Metric; label: MessageKey; icon: ReactNode }[] = [
  {
    metric: "traffic",
    label: "sites.usage.traffic",
    icon: <ArrowDownToLine />,
  },
  { metric: "storage", label: "sites.usage.storage", icon: <HardDrive /> },
  { metric: "requests", label: "sites.usage.requests", icon: <Activity /> },
  { metric: "sites", label: "sites.usage.sites", icon: <Globe /> },
];

function UsagePage({
  usage,
  plans,
}: {
  usage: Usage | undefined;
  plans: ViewState["plans"];
}) {
  const { t, locale, timeZone, actions } = useView();
  return (
    <div className="stack-5">
      <button
        type="button"
        className="btn ghost back"
        onClick={() => actions.navigate({ page: "list" })}
      >
        <ChevronLeft />
        {t("sites.title")}
      </button>
      {!usage ? (
        <Loading />
      ) : (
        <div className="stack-4">
          <div className="stack-1">
            <h1>{t("sites.usage.title")}</h1>
            <p className="subtle sm">
              {t("sites.usage.shared", { plan: planName(usage.plan) })}
            </p>
          </div>
          {usage.quotaState === "exceeded" && (
            <Alert
              title={t("sites.usage.exceeded", {
                reasons: usage.exceededReasons
                  .map((metric) => t(`sites.usage.${metric}`))
                  .join(locale === "zh-CN" ? "、" : ", "),
              })}
              lines={[]}
            />
          )}
          <dl className="meters">
            {METRIC_VIEWS.map(({ metric, label, icon }) => {
              const meter = usage[metric];
              const percent = meterPercent(meter);
              const over = usage.exceededReasons.includes(metric);
              return (
                <div key={metric} className="card meter">
                  <div className="row gap-2">
                    <span className="meter-icon">{icon}</span>
                    <dt className="strong">{t(label)}</dt>
                  </div>
                  <dd className="meter-value">
                    <span className="big">
                      {formatMeter(metric, meter.used)}
                    </span>
                    <span className="subtle sm">
                      {" "}
                      / {formatMeter(metric, meter.limit)}
                    </span>
                  </dd>
                  <div className="row gap-3">
                    <div
                      className={`meter-track${over ? " danger" : ""}`}
                      role="progressbar"
                      aria-label={t(label)}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="meter-fill"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="meter-percent">{percent}%</span>
                  </div>
                </div>
              );
            })}
          </dl>
          <div className="stack-1">
            <p className="subtle sm">{t("sites.usage.reset")}</p>
            <p className="subtlest sm">
              {t("sites.usage.period", {
                start: formatTime(usage.period.start, locale, timeZone),
                end: formatTime(usage.period.end, locale, timeZone),
              })}
            </p>
          </div>
          <PlanCards plans={plans} />
        </div>
      )}
    </div>
  );
}

/**
 * 每个档位一张卡片，指标顺序与上方用量卡一致；不放升级入口，当前档位加标记。
 * 档位和数值都来自 listPlans，按返回顺序展示，面板不写死；实际判定以用量接口的 limit 为准。
 */
function PlanCards({ plans }: { plans: ViewState["plans"] }) {
  const { t, actions } = useView();
  return (
    <section className="stack-3" aria-labelledby="sites-plans">
      <h2 id="sites-plans">{t("sites.usage.plans.title")}</h2>
      {plans === undefined ? (
        <Loading />
      ) : plans === "failed" ? (
        <div className="row gap-2" role="status">
          <p className="subtle sm">{t("sites.usage.plans.failed")}</p>
          <button
            type="button"
            className="btn ghost sm"
            onClick={actions.refresh}
          >
            {t("sites.retry")}
          </button>
        </div>
      ) : (
        <div className="plans">
          {plans.plans.map((tier) => {
            const current = tier.tier === plans.current;
            return (
              <article
                key={tier.tier}
                className={`card plan${current ? " current" : ""}`}
              >
                <div className="row gap-2">
                  <h3 className="plan-name">{planName(tier.tier)}</h3>
                  {current && (
                    <span className="tag">
                      {t("sites.usage.plans.current")}
                    </span>
                  )}
                </div>
                <dl className="plan-limits">
                  {METRIC_VIEWS.map(({ metric, label }) => (
                    <div key={metric}>
                      <dt className="subtle sm">{t(label)}</dt>
                      <dd className="plan-value">
                        {formatMeter(metric, tier[metric])}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt className="subtle sm">
                      {t("sites.usage.plans.badge")}
                    </dt>
                    <dd className="plan-value">
                      {t(
                        tier.badgeRemovable
                          ? "sites.usage.plans.badgeRemovable"
                          : "sites.usage.plans.badgeKept",
                      )}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}
      <p className="subtle sm">{t("sites.usage.plans.note")}</p>
    </section>
  );
}
