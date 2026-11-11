import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  LoaderCircle,
  Pencil,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AnalyticsTab } from "./analytics.tsx";
import { formatClock, formatTime } from "./i18n.ts";
import {
  deploymentPhase,
  formatBytes,
  formatCount,
  siteHost,
  siteMenu,
  sitePhase,
  stageViews,
  type Deployment,
  type LogEntry,
  type Page,
  type Site,
  type StageState,
} from "./model.ts";
import {
  useView,
  Loading,
  PromptMenu,
  Alert,
  Section,
  Field,
  Cell,
  Meta,
  StatusLabel,
  PhaseIcon,
  Switch,
  RelativeTime,
} from "./parts.tsx";
import type { ViewState } from "./parts.tsx";

export function SitePage({ state }: { state: ViewState }) {
  const { t, actions } = useView();
  const { route, site } = state;
  if (route.page !== "site" && route.page !== "deployment") return null;
  if (!site || site.id !== route.siteId) return <Loading />;
  const tab =
    route.page === "deployment" || route.tab === "deployments"
      ? "deployments"
      : route.tab === "analytics"
        ? "analytics"
        : "overview";
  const latest = site.latestDeployment;
  const published =
    site.currentDeployment?.finishedAt ?? site.currentDeployment?.createdAt;
  return (
    <div className="stack-5">
      <nav className="crumbs" aria-label={t("sites.title")}>
        <button
          type="button"
          className="btn ghost sm back"
          onClick={() => actions.navigate({ page: "list" })}
        >
          <ChevronLeft />
          {t("sites.title")}
        </button>
        <span className="subtlest" aria-hidden="true">
          /
        </span>
        <span className="truncate">{site.name}</span>
      </nav>
      <header className="site-head">
        <div className="site-head-text">
          <div className="title-row">
            <h1 className="wrap">{site.name}</h1>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("sites.site.rename")}
              title={t("sites.site.rename")}
              onClick={actions.startRename}
            >
              <Pencil />
            </button>
          </div>
          <Meta>
            <StatusLabel phase={sitePhase(site)} />
            {published && <RelativeTime iso={published} />}
          </Meta>
        </div>
        <div className="head-actions">
          <PromptMenu
            items={siteMenu(state.commands, site)}
            label={t("sites.site.redeploy")}
            icon={<RotateCw />}
          />
          <button
            type="button"
            className="btn primary lg"
            disabled={site.status !== "online"}
            onClick={() => actions.openLink(site.url)}
          >
            {t("sites.visit")}
            <ArrowUpRight />
          </button>
        </div>
      </header>
      {site.offlineReason === "review_rejected" ? (
        <Alert
          title={t("sites.status.offline")}
          lines={[t("sites.site.reviewRejected")]}
        />
      ) : (
        latest?.status === "failed" && (
          <Alert
            title={t("sites.site.failed")}
            lines={[
              latest.failure
                ? t("sites.site.failedAt", {
                    stage: t(`sites.stage.${latest.failure.stage}`),
                    message: latest.failure.message,
                  })
                : "",
              site.currentDeployment ? t("sites.site.stillOnline") : "",
            ]}
          />
        )
      )}
      <div className="tabs" role="tablist">
        <TabButton
          active={tab === "overview"}
          onClick={() => actions.navigate({ page: "site", siteId: site.id })}
        >
          {t("sites.site.overview")}
        </TabButton>
        <TabButton
          active={tab === "deployments"}
          onClick={() =>
            actions.navigate({
              page: "site",
              siteId: site.id,
              tab: "deployments",
            })
          }
        >
          {t("sites.site.deployments")}
          {state.deployments && state.deployments.items.length > 0 && (
            <span className="tab-count">
              {state.deployments.items.length}
              {state.deployments.nextCursor ? "+" : ""}
            </span>
          )}
        </TabButton>
        <TabButton
          active={tab === "analytics"}
          onClick={() =>
            actions.navigate({
              page: "site",
              siteId: site.id,
              tab: "analytics",
            })
          }
        >
          {t("sites.site.analytics")}
        </TabButton>
      </div>
      {route.page === "deployment" ? (
        <DeploymentDetail state={state} site={site} />
      ) : tab === "deployments" ? (
        <DeploymentList site={site} deployments={state.deployments} />
      ) : tab === "analytics" ? (
        <AnalyticsTab state={state} />
      ) : (
        <Overview state={state} site={site} />
      )}
      {state.rename && <RenameDialog site={site} rename={state.rename} />}
      {state.remove && <DeleteDialog site={site} remove={state.remove} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab${active ? " active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Overview({ state, site }: { state: ViewState; site: Site }) {
  const { t, locale, timeZone, actions } = useView();
  const current = site.currentDeployment;
  const latest = site.latestDeployment;
  const removable = state.usage?.badgeRemovable ?? false;
  return (
    <div className="stack-5">
      <Section title={t("sites.site.production")}>
        {current ? (
          <dl className="card fields">
            <Field label={t("sites.site.domain")}>
              <span className="row gap-1">
                <span className="truncate grow">{siteHost(site)}</span>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("sites.copyLink")}
                  title={t("sites.copyLink")}
                  onClick={() => actions.copy(site.url, "sites.copied")}
                >
                  <Copy />
                </button>
              </span>
            </Field>
            <Field label={t("sites.site.publishedAt")}>
              {formatTime(
                current.finishedAt ?? current.createdAt,
                locale,
                timeZone,
              )}
            </Field>
          </dl>
        ) : (
          <p className="dashed">
            <Globe className="dashed-icon" />
            {t("sites.site.noProduction")}
          </p>
        )}
      </Section>
      <Visits state={state} site={site} />
      {latest && (
        <Section title={t("sites.site.latest")}>
          <DeploymentRow siteId={site.id} deployment={latest} />
        </Section>
      )}
      <Section title={t("sites.site.settings")}>
        <div className="card">
          <div className="setting">
            <div className="setting-text">
              <label htmlFor="badge" className="setting-title">
                {t("sites.site.badge")}
              </label>
              <p className="subtle sm">{t("sites.site.badgeHint")}</p>
            </div>
            <Switch
              id="badge"
              checked={!site.badgeHidden}
              disabled={state.badge.saving || (!removable && !site.badgeHidden)}
              onChange={actions.setBadgeVisible}
            />
          </div>
          {state.badge.error && (
            <p className="card-foot danger">{t(state.badge.error)}</p>
          )}
          {!removable && state.usage && (
            <p className="card-foot">
              <Sparkles className="foot-icon" />
              <span className="tag">{state.usage.plan}</span>
              <span>{t("sites.site.badgeLocked")}</span>
            </p>
          )}
        </div>
      </Section>
      <Section title={t("sites.site.dangerZone")}>
        <div className="card">
          <div className="setting">
            <div className="setting-text">
              <p className="setting-title">{t("sites.delete.title")}</p>
              <p className="subtle sm">{t("sites.delete.settingHint")}</p>
            </div>
            <button
              type="button"
              className="btn danger sm"
              onClick={actions.startDelete}
            >
              <Trash2 />
              {t("sites.delete.action")}
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** 概览上的「访问数据」：近 24 小时 PV 与近 7 天 PV / 访客，点「查看更多」进统计页。 */
function Visits({ state, site }: { state: ViewState; site: Site }) {
  const { t, actions } = useView();
  const week = state.analytics["7d"];
  const ready = week?.status === "ready" ? week : undefined;
  const weekValue = (value: number | undefined) =>
    ready
      ? formatCount(ready.summary ? (value ?? 0) : 0)
      : week?.status === "failed"
        ? "—"
        : "…";
  return (
    <section className="stack-2">
      <div className="row between">
        <h2>{t("sites.site.visits")}</h2>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            actions.navigate({
              page: "site",
              siteId: site.id,
              tab: "analytics",
            })
          }
        >
          {t("sites.site.visitsMore")}
          <ChevronRight />
        </button>
      </div>
      <dl className="grid-cells">
        <Cell label={t("sites.site.pv24h")}>
          <span className="cell-value">
            {site.id in state.pv24h ? formatCount(state.pv24h[site.id]) : "…"}
          </span>
        </Cell>
        <Cell label={t("sites.site.pv7d")}>
          <span className="cell-value">{weekValue(ready?.summary?.pv)}</span>
        </Cell>
        <Cell label={t("sites.site.uv7d")}>
          <span className="cell-value">{weekValue(ready?.summary?.uv)}</span>
        </Cell>
      </dl>
    </section>
  );
}

function DeploymentList({
  site,
  deployments,
}: {
  site: Site;
  deployments: Page<Deployment> | undefined;
}) {
  const { t, actions } = useView();
  if (!deployments) return <Loading />;
  if (deployments.items.length === 0)
    return <p className="dashed">{t("sites.deployment.empty")}</p>;
  return (
    <div className="stack-2">
      <ul className="cards">
        {deployments.items.map((deployment) => (
          <li key={deployment.id}>
            <DeploymentRow siteId={site.id} deployment={deployment} />
          </li>
        ))}
      </ul>
      {deployments.nextCursor && (
        <button
          type="button"
          className="btn ghost center"
          onClick={actions.loadMoreDeployments}
        >
          {t("sites.loadMore")}
        </button>
      )}
    </div>
  );
}

/** 部署以发起时间为标题；部署 ID 对用户没有意义，面板不显示（菜单里的日志命令仍带它）。 */
function DeploymentRow({
  siteId,
  deployment,
}: {
  siteId: string;
  deployment: Deployment;
}) {
  const { t, locale, timeZone, actions } = useView();
  const phase = deploymentPhase(deployment);
  return (
    <button
      type="button"
      className="card row-card"
      onClick={() =>
        actions.navigate({
          page: "deployment",
          siteId,
          deploymentId: deployment.id,
        })
      }
    >
      <PhaseIcon phase={phase} />
      <span className="row-card-text">
        <span className="row gap-2 wrap-row">
          <span className="strong truncate">
            {formatTime(deployment.createdAt, locale, timeZone)}
          </span>
          {deployment.isCurrent && (
            <span className="tag">{t("sites.deployment.current")}</span>
          )}
        </span>
        <Meta>
          <StatusLabel phase={phase} bare />
          <span>{formatBytes(deployment.artifactSize)}</span>
        </Meta>
      </span>
      <ChevronRight className="chevron" />
    </button>
  );
}

function DeploymentDetail({ state, site }: { state: ViewState; site: Site }) {
  const { t, locale, timeZone, actions } = useView();
  const deployment = state.deployment;
  if (!deployment) return <Loading />;
  const phase = deploymentPhase(deployment);
  const done =
    deployment.status === "success" || deployment.status === "failed";
  return (
    <div className="stack-4">
      <button
        type="button"
        className="btn ghost sm back"
        onClick={() =>
          actions.navigate({
            page: "site",
            siteId: site.id,
            tab: "deployments",
          })
        }
      >
        <ChevronLeft />
        {t("sites.deployment.back")}
      </button>
      <header className="stack-1">
        <p className="subtle sm">{t("sites.deployment.details")}</p>
        <div className="row gap-2 wrap-row">
          <h2 className="deployment-title">
            {formatTime(deployment.createdAt, locale, timeZone)}
          </h2>
          {deployment.isCurrent && (
            <span className="tag">{t("sites.deployment.current")}</span>
          )}
        </div>
      </header>
      <dl className="grid-cells">
        <Cell label={t("sites.deployment.status")}>
          <StatusLabel phase={phase} />
        </Cell>
        <Cell label={t("sites.deployment.size")}>
          {formatBytes(deployment.artifactSize)}
        </Cell>
        <Cell label={t("sites.deployment.finishedAt")}>
          {deployment.finishedAt
            ? formatTime(deployment.finishedAt, locale, timeZone)
            : "—"}
        </Cell>
      </dl>
      {deployment.failure && (
        <Alert
          title={t("sites.status.failed")}
          lines={[
            t("sites.site.failedAt", {
              stage: t(`sites.stage.${deployment.failure.stage}`),
              message: deployment.failure.message,
            }),
          ]}
        />
      )}
      <section className="card logs-card">
        <header className="logs-head">
          <div className="row between">
            <h3>{t("sites.deployment.logs")}</h3>
            <button
              type="button"
              className="icon-btn sm"
              disabled={state.logs.length === 0}
              aria-label={t("sites.deployment.copyLogs")}
              title={t("sites.deployment.copyLogs")}
              onClick={() =>
                actions.copy(
                  state.logs
                    .map(
                      (entry) =>
                        `${entry.ts} [${entry.stage}] ${entry.level} ${entry.message}`,
                    )
                    .join("\n"),
                  "sites.deployment.logsCopied",
                )
              }
            >
              <Copy />
            </button>
          </div>
          <Steps deployment={deployment} logs={state.logs} />
        </header>
        <LogViewer entries={state.logs} />
        <footer className="logs-foot">
          {!(done && state.logsDone) && (
            <span className="pulse" aria-hidden="true" />
          )}
          <span>
            {t(
              done && state.logsDone
                ? "sites.deployment.logsEnd"
                : "sites.deployment.logsLive",
            )}
          </span>
        </footer>
      </section>
    </div>
  );
}

function Steps({
  deployment,
  logs,
}: {
  deployment: Deployment;
  logs: LogEntry[];
}) {
  const { t } = useView();
  return (
    <ol className="steps">
      {stageViews(deployment, logs).map((view) => (
        <li key={view.stage} className={`step ${view.state}`}>
          <span className="step-bar" />
          <span className="step-label">
            <StepIcon state={view.state} />
            <span className="truncate">{t(`sites.stage.${view.stage}`)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state }: { state: StageState }) {
  if (state === "done") return <Check className="step-icon" />;
  if (state === "failed") return <X className="step-icon" />;
  if (state === "active") return <LoaderCircle className="step-icon spin" />;
  return <span className="step-dot" />;
}

/** 日志贴底跟随新内容；用户往上翻就停下，点「回到最新」或滚回底部后恢复。 */
function LogViewer({ entries }: { entries: LogEntry[] }) {
  const { t, locale, timeZone } = useView();
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow) element.scrollTop = element.scrollHeight;
  }, [entries.length, follow]);
  return (
    <div className="logs-wrap">
      <div
        ref={ref}
        className="logs"
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollow(
            element.scrollHeight - element.scrollTop - element.clientHeight <
              24,
          );
        }}
      >
        {entries.length === 0 ? (
          <p className="logs-empty">{t("sites.deployment.noLogs")}</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.offset} className={`log ${entry.level}`}>
              <span className="log-time">
                {formatClock(entry.ts, locale, timeZone)}
              </span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))
        )}
      </div>
      {!follow && (
        <button
          type="button"
          className="btn outline sm jump"
          onClick={() => setFollow(true)}
        >
          {t("sites.deployment.follow")}
        </button>
      )}
    </div>
  );
}

function RenameDialog({
  site,
  rename,
}: {
  site: Site;
  rename: NonNullable<ViewState["rename"]>;
}) {
  const { t, actions } = useView();
  const [draft, setDraft] = useState(site.name);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) =>
      event.key === "Escape" && actions.cancelRename();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions]);
  return (
    <div
      className="overlay"
      onMouseDown={(event) =>
        event.target === event.currentTarget && actions.cancelRename()
      }
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          actions.saveRename(draft);
        }}
      >
        <div className="stack-1">
          <h2 id="rename-title">{t("sites.site.rename")}</h2>
          <p className="subtle sm">{t("sites.site.renameHint")}</p>
        </div>
        <div className="stack-2">
          <label htmlFor="rename" className="field-label">
            {t("sites.site.name")}
          </label>
          <input
            id="rename"
            className="input"
            autoFocus
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {rename.error ? (
            <p className="danger sm">{t(rename.error)}</p>
          ) : (
            <p className="row gap-1 subtle sm">
              <Globe className="inline-icon" />
              <span className="truncate">{siteHost(site)}</span>
            </p>
          )}
        </div>
        <div className="dialog-foot">
          <button
            type="button"
            className="btn ghost lg"
            onClick={actions.cancelRename}
          >
            {t("sites.cancel")}
          </button>
          <button
            type="submit"
            className="btn primary lg"
            disabled={rename.saving || !draft.trim()}
          >
            {rename.saving && <LoaderCircle className="spin" />}
            {t("sites.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** 删除不可恢复：输入站点名称后才能确认，宿主仍会按工具审批再确认一次。 */
function DeleteDialog({
  site,
  remove,
}: {
  site: Site;
  remove: NonNullable<ViewState["remove"]>;
}) {
  const { t, actions } = useView();
  const [draft, setDraft] = useState("");
  const matched = draft.trim() === site.name.trim();
  return (
    <Dialog onCancel={actions.cancelDelete} titleId="delete-title">
      <form
        className="stack-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (matched) actions.confirmDelete();
        }}
      >
        <div className="stack-1">
          <h2 id="delete-title">{t("sites.delete.title")}</h2>
          <p className="subtle sm">
            {t("sites.delete.warning", { host: siteHost(site) })}
          </p>
        </div>
        <div className="stack-2">
          <label htmlFor="delete-confirm" className="field-label">
            {t("sites.delete.confirmLabel", { name: site.name })}
          </label>
          <input
            id="delete-confirm"
            className="input"
            autoFocus
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {remove.error && <p className="danger sm">{t(remove.error)}</p>}
        </div>
        <div className="dialog-foot">
          <button
            type="button"
            className="btn ghost lg"
            onClick={actions.cancelDelete}
          >
            {t("sites.cancel")}
          </button>
          <button
            type="submit"
            className="btn danger lg"
            disabled={remove.saving || !matched}
          >
            {remove.saving && <LoaderCircle className="spin" />}
            {t("sites.delete.action")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Dialog({
  onCancel,
  titleId,
  children,
}: {
  onCancel: () => void;
  titleId: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) =>
      event.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      className="overlay"
      onMouseDown={(event) =>
        event.target === event.currentTarget && onCancel()
      }
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {children}
      </div>
    </div>
  );
}
