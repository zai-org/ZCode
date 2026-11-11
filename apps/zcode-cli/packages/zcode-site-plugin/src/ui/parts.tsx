import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Globe,
  LoaderCircle,
  X,
} from "lucide-react";
import type { AnalyticsRange, SiteCommand } from "../contract.ts";
import type { Route } from "./host.ts";
import {
  formatRelative,
  formatTime,
  type Locale,
  type MessageKey,
  type Translate,
} from "./i18n.ts";
import {
  coverKey,
  type AnalyticsState,
  type PV24hMap,
  type Deployment,
  type LogEntry,
  type MenuItem,
  type Page,
  type Phase,
  type Site,
  type Plans,
  type Usage,
} from "./model.ts";

export interface ViewState {
  route: Route;
  statusPage?: "login" | "relogin" | "plan" | "appVersion";
  bar?: { key: MessageKey; logid?: string };
  toast?: string;
  query: string;
  commands: SiteCommand[];
  sites?: Page<Site>;
  usage?: Usage;
  /** 套餐表；读失败时为 "failed"，只在用量页就地提示，不影响上方用量。 */
  plans?: Plans | "failed";
  site?: Site;
  deployments?: Page<Deployment>;
  deployment?: Deployment;
  logs: LogEntry[];
  logsDone: boolean;
  rename?: { saving: boolean; error?: MessageKey };
  badge: { saving: boolean; error?: MessageKey };
  /** 封面图片的 data URL，按部署 id 缓存：同一个部署的封面不变，换页面也不重新读。 */
  covers: Record<string, string>;
  /** 列表卡片和概览上的近 24 小时 PV，按站点 id；换页面不清，刷新时重读。 */
  pv24h: PV24hMap;
  /** 当前站点各区间的统计；换站点时清空。 */
  analytics: Partial<Record<AnalyticsRange, AnalyticsState>>;
  analyticsRange: AnalyticsRange;
  remove?: { saving: boolean; error?: MessageKey };
}

export interface ViewActions {
  navigate(route: Route): void;
  refresh(): void;
  setQuery(query: string): void;
  copy(text: string, toast: MessageKey): void;
  openLink(url: string): void;
  loadMoreSites(): void;
  loadMoreDeployments(): void;
  startRename(): void;
  saveRename(name: string): void;
  cancelRename(): void;
  setBadgeVisible(visible: boolean): void;
  setAnalyticsRange(range: AnalyticsRange): void;
  startDelete(): void;
  cancelDelete(): void;
  confirmDelete(): void;
}

export interface ViewContext {
  t: Translate;
  locale: Locale;
  timeZone?: string;
  actions: ViewActions;
}

export const Ctx = createContext<ViewContext>(null as never);
export const useView = () => useContext(Ctx);

export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" />
    </div>
  );
}

// ---------- 通用部件 ----------

/**
 * 「新建部署 / 重新部署」分体按钮：主按钮复制第一条命令，箭头展开全部命令。
 * 面板拿不到宿主输入框，只复制，用户自己粘贴发送（docs/site/sites-panel.md「运维菜单」）。
 */
export function PromptMenu({
  items,
  label,
  icon,
  primary = false,
  newDeployment = false,
}: {
  items: MenuItem[];
  label: string;
  icon: ReactNode;
  primary?: boolean;
  newDeployment?: boolean;
}) {
  const { t, actions } = useView();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !ref.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const first = items[0];
  const name = (item: MenuItem): string =>
    newDeployment && item.command === "site-deploy"
      ? t("sites.menu.site-deploy.new")
      : t(`sites.menu.${item.command}` as MessageKey);
  const copy = (item: MenuItem) => {
    setOpen(false);
    actions.copy(item.text, "sites.menu.copied");
  };
  return (
    <div ref={ref} className="menu-anchor">
      <div className={`split ${primary ? "primary" : "outline"}`}>
        <button
          type="button"
          className="split-main"
          disabled={!first}
          onClick={() => first && copy(first)}
        >
          {icon}
          {label}
        </button>
        <span className="split-divider" aria-hidden="true" />
        <button
          type="button"
          className="split-toggle"
          aria-label={t("sites.menu.title")}
          aria-expanded={open}
          disabled={items.length === 0}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown />
        </button>
      </div>
      {open && (
        <div className="popover" role="menu">
          <p className="popover-hint">{t("sites.menu.hint")}</p>
          {items.map((item) => (
            <button
              key={item.command}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => copy(item)}
            >
              <span className="menu-item-text">
                <span className="strong">{name(item)}</span>
                <code>{item.text}</code>
              </span>
              <Copy className="menu-item-icon" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Alert({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="alert" role="alert">
      <CircleAlert className="alert-icon" />
      <div className="alert-body">
        <p className="alert-title">{title}</p>
        {lines.filter(Boolean).map((line) => (
          <p key={line} className="subtle">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** 站点线上版本的首页截图；还没有封面时显示占位，封面在加载时留空。 */
export function Cover({
  site,
  covers,
}: {
  site: Site;
  covers: Record<string, string>;
}) {
  const key = coverKey(site);
  const src = key ? covers[key] : undefined;
  return (
    <span className="cover">
      {src ? (
        <img src={src} alt="" />
      ) : (
        !key && <Globe className="cover-icon" />
      )}
    </span>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="stack-2">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <dt className="subtle sm">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Cell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="cell">
      <dt className="subtle sm">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

/** 用 · 分隔的元信息；换行后的行首不留孤立的点（见 .meta 样式）。 */
export function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="meta-wrap">
      <span className="meta">{wrapMeta(children)}</span>
    </span>
  );
}

function wrapMeta(children: ReactNode): ReactNode {
  const items = (Array.isArray(children) ? children : [children]).filter(
    (child) => child !== null && child !== undefined && child !== false,
  );
  return items.map((child, index) => (
    <span key={index} className="meta-item">
      {child}
    </span>
  ));
}

export function StatusLabel({
  phase,
  bare = false,
}: {
  phase: Phase;
  bare?: boolean;
}) {
  const { t } = useView();
  return (
    <span className={`status ${phase.tone}`}>
      {!bare &&
        (phase.tone === "busy" ? (
          <LoaderCircle className="status-spin spin" />
        ) : (
          <span className="status-dot" />
        ))}
      {t(`sites.status.${phase.label}`)}
    </span>
  );
}

export function PhaseIcon({ phase }: { phase: Phase }) {
  return (
    <span className={`phase-icon ${phase.tone}`}>
      {phase.tone === "busy" ? (
        <LoaderCircle className="spin" />
      ) : phase.tone === "danger" ? (
        <X />
      ) : (
        <Check />
      )}
    </span>
  );
}

export function Switch({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function RelativeTime({ iso }: { iso: string }) {
  const { locale, timeZone } = useView();
  return (
    <time dateTime={iso} title={formatTime(iso, locale, timeZone)}>
      {formatRelative(iso, locale, Date.now(), timeZone)}
    </time>
  );
}
