import {
  MAX_PV24H_SITES,
  type AnalyticsRange,
  type SiteCommand,
  type SitesError,
} from "../contract.ts";

// 与 api/openapi.yaml 的 Site / Deployment / Usage / Plans / DeploymentLogs 一致；面板只读用到的字段。
export type SiteStatus = "pending" | "online" | "offline";
export type DeploymentStatus =
  | "preparing"
  | "uploading"
  | "publishing"
  | "verifying"
  | "success"
  | "failed";
export type DeploymentStage =
  | "preparing"
  | "uploading"
  | "publishing"
  | "verifying";
export const STAGES: readonly DeploymentStage[] = [
  "preparing",
  "uploading",
  "publishing",
  "verifying",
];

export interface Deployment {
  id: string;
  siteId: string;
  status: DeploymentStatus;
  artifactSize: number;
  isCurrent: boolean;
  failure: { stage: DeploymentStage; code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface Site {
  id: string;
  name: string;
  domainLabel: string;
  url: string;
  status: SiteStatus;
  offlineReason?: "review_rejected";
  badgeHidden: boolean;
  badgeVisible: boolean;
  /** 线上版本有封面（首页截图），为 true 时读 `zcode-site://sites/{id}/cover`。 */
  hasCover: boolean;
  currentDeployment: Deployment | null;
  latestDeployment: Deployment | null;
  createdAt: string;
  updatedAt: string;
}

/** getSiteCover 的 data；没有封面时资源返回 null。 */
export interface SiteCover {
  deploymentId: string;
  contentType: string;
  /** 图片的 base64。 */
  data: string;
}

/** 站点线上版本的封面缓存键：封面跟着部署走，重新部署后换新图。 */
export function coverKey(site: Site): string | undefined {
  return site.hasCover && site.currentDeployment
    ? site.currentDeployment.id
    : undefined;
}

export interface Meter {
  used: number;
  limit: number;
}

export type Metric = "traffic" | "requests" | "storage" | "sites";
export const METRICS: readonly Metric[] = [
  "traffic",
  "requests",
  "storage",
  "sites",
];

export interface Usage {
  plan: string;
  badgeRemovable: boolean;
  canDeploy: boolean;
  period: { start: string; end: string };
  traffic: Meter;
  requests: Meter;
  storage: Meter;
  sites: Meter;
  quotaState: "active" | "exceeded";
  exceededReasons: Metric[];
  updatedAt: string;
}

/** listPlans 的一项：一个档位的额度，字段与 Usage 里同名 Meter 的 limit 对应。 */
export interface Plan extends Record<Metric, number> {
  tier: string;
  badgeRemovable: boolean;
}

/** listPlans 的 data。档位和数值都由服务端下发，按返回顺序展示；current 为 null 时不标记当前档位。 */
export interface Plans {
  current: string | null;
  plans: Plan[];
}

/** 档位名只用来展示：服务端给的是小写 key，首字母大写即可（free → Free），不按名字做判断。 */
export function planName(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export interface LogEntry {
  offset: number;
  ts: string;
  stage: DeploymentStage;
  level: "info" | "warn" | "error";
  message: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DeploymentLogs {
  entries: LogEntry[];
  nextOffset: number;
  done: boolean;
}

export const ACTIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 30_000;
export const LOG_POLL_MS = 2_000;

export function isInProgress(
  deployment: Deployment | null | undefined,
): boolean {
  return (
    !!deployment &&
    deployment.status !== "success" &&
    deployment.status !== "failed"
  );
}

/** 有进行中的部署时 3 秒读一次，否则 30 秒（docs/site/sites-panel.md「轮询」）。 */
export function pollInterval(
  deployments: readonly (Deployment | null | undefined)[],
): number {
  return deployments.some(isInProgress) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

/** 状态点的样子：进行中转圈，成功和在线是绿点，失败是红色，其余灰点。 */
export type PhaseTone = "busy" | "success" | "danger" | "muted";
export interface Phase {
  label: SiteStatus | DeploymentStatus;
  tone: PhaseTone;
}

export function deploymentPhase(deployment: Deployment): Phase {
  if (isInProgress(deployment))
    return { label: deployment.status, tone: "busy" };
  return deployment.status === "success"
    ? { label: "success", tone: "success" }
    : { label: "failed", tone: "danger" };
}

/**
 * 站点在列表和概览上显示什么：进行中的部署优先，其次是下线；最近一次部署失败时即使旧版本仍在线
 * 也显示失败，详情页再提示「上一发布版本保持可用」。
 */
export function sitePhase(site: Site): Phase {
  const latest = site.latestDeployment;
  if (latest && isInProgress(latest)) return deploymentPhase(latest);
  if (site.status === "offline") return { label: "offline", tone: "muted" };
  if (latest?.status === "failed") return { label: "failed", tone: "danger" };
  return site.status === "online"
    ? { label: "online", tone: "success" }
    : { label: "pending", tone: "muted" };
}

/** 访问地址去掉协议，卡片和域名字段只显示 host。 */
export function siteHost(site: Site): string {
  try {
    return new URL(site.url).host;
  } catch {
    return site.url;
  }
}

export type StageState = "done" | "active" | "failed" | "pending";
export interface StageView {
  stage: DeploymentStage;
  state: StageState;
  /** 该阶段日志的首末时间；没有日志时缺省。 */
  startedAt?: string;
  endedAt?: string;
}

/** 四个阶段的进度：状态以部署为准，起止时间取该阶段日志的首末 `ts`。 */
export function stageViews(
  deployment: Deployment,
  entries: readonly LogEntry[],
): StageView[] {
  const reached =
    deployment.status === "success"
      ? STAGES.length
      : deployment.status === "failed"
        ? STAGES.indexOf(deployment.failure?.stage ?? lastStage(entries))
        : STAGES.indexOf(deployment.status);
  return STAGES.map((stage, index) => {
    const logs = entries.filter((entry) => entry.stage === stage);
    const state: StageState =
      index < reached
        ? "done"
        : index > reached
          ? "pending"
          : deployment.status === "failed"
            ? "failed"
            : "active";
    return {
      stage,
      state,
      ...(logs.length
        ? { startedAt: logs[0].ts, endedAt: logs.at(-1)!.ts }
        : {}),
    };
  });
}

function lastStage(entries: readonly LogEntry[]): DeploymentStage {
  return entries.at(-1)?.stage ?? "preparing";
}

/**
 * 错误怎么呈现（docs/site/sites-panel.md「错误与状态」）：
 * - `page`：整页状态页，用户先要在面板外处理（登录、续费、升级 ZCode）；
 * - `missing`：站点或部署不存在，回列表；
 * - `bar`：顶部错误条，保留已有数据、下一轮重试。
 * 改名和角标的错误由调用处按 code 就地处理，不经这里。
 */
export type ErrorView =
  | { kind: "page"; key: "login" | "relogin" | "plan" | "appVersion" }
  | { kind: "missing" }
  | { kind: "bar"; logid?: string };

export function errorView(error: SitesError): ErrorView {
  switch (error.reason) {
    case "official_auth_unavailable":
    case "unauthenticated":
      return { kind: "page", key: "login" };
    case "official_auth_plan_required":
      return { kind: "page", key: "plan" };
  }
  switch (error.code) {
    case 3101:
      return { kind: "page", key: "relogin" };
    case 3609:
      return { kind: "page", key: "appVersion" };
    case 3601:
    case 3602:
      return { kind: "missing" };
  }
  return { kind: "bar", ...(error.logid ? { logid: error.logid } : {}) };
}

/** 菜单项：点击复制 `text` 到剪贴板，用户自己粘贴发送。 */
export interface MenuItem {
  command: string;
  text: string;
}

const LIST_MENU = [
  "site-deploy",
  "site-status",
  "site-logs",
  "site-offline",
  "site-online",
  "site-usage",
];

/** 列表右上角「新建部署」：命令都不带站点。 */
export function listMenu(commands: readonly SiteCommand[]): MenuItem[] {
  return pick(commands, LIST_MENU).map((command) => ({
    command,
    text: `/${command}`,
  }));
}

/** 站点概览的运维菜单：带站点 ID；日志带最近一次部署 ID；下线和再上线按当前状态二选一。 */
export function siteMenu(
  commands: readonly SiteCommand[],
  site: Site,
): MenuItem[] {
  const toggle =
    site.status === "online"
      ? "site-offline"
      : site.status === "offline" && site.offlineReason !== "review_rejected"
        ? "site-online"
        : undefined;
  const args: Record<string, string | undefined> = {
    "site-deploy": site.id,
    "site-status": site.id,
    "site-logs": site.latestDeployment?.id,
    "site-offline": site.id,
    "site-online": site.id,
    "site-analytics": site.id,
    "site-usage": undefined,
  };
  const wanted = [
    "site-deploy",
    "site-status",
    "site-logs",
    ...(toggle ? [toggle] : []),
    "site-analytics",
    "site-usage",
  ];
  return pick(commands, wanted)
    .filter((command) => command !== "site-logs" || site.latestDeployment)
    .map((command) => ({
      command,
      text: args[command] ? `/${command} ${args[command]}` : `/${command}`,
    }));
}

function pick(
  commands: readonly SiteCommand[],
  names: readonly string[],
): string[] {
  const available = new Set(commands.map((command) => command.name));
  return names.filter((name) => available.has(name));
}

/** 按名称和域名过滤，忽略大小写。 */
export function filterSites(sites: readonly Site[], query: string): Site[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sites];
  return sites.filter(
    (site) =>
      site.name.toLowerCase().includes(needle) ||
      site.url.toLowerCase().includes(needle),
  );
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 整数不带 .0（5 GB 而不是 5.0 GB），三位以上加千分位（1,000 GB）。
  const rounded =
    unit === 0 || value >= 100
      ? Math.round(value)
      : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 字节类用 KB/MB/GB，请求数用紧凑写法（128K、10M），站点数是原数。 */
export function formatMeter(metric: Metric, value: number): string {
  if (metric === "traffic" || metric === "storage") return formatBytes(value);
  return metric === "requests"
    ? compact.format(value)
    : value.toLocaleString("en-US");
}

/** 进度条宽度，0–100；额度为 0 时按已满处理。 */
export function meterPercent(meter: Meter): number {
  if (meter.limit <= 0) return meter.used > 0 ? 100 : 0;
  return Math.min(100, Math.round((meter.used / meter.limit) * 100));
}

// ---------- 访问统计（契约 getSiteAnalytics / getSitesPV24h，技术方案 8.1） ----------

export interface AnalyticsSummary {
  pv: number;
  uv: number;
  /** 停留时长在访客离开页面时才上报，还没有时为 null。 */
  avgDurationSeconds: number | null;
  bounceRate: number | null;
}

export interface AnalyticsPoint {
  start: string;
  pv: number;
  uv: number;
}

export interface AnalyticsShare {
  key: string;
  pv: number;
  share: number;
}

/** status=ready 的结果；区间内没有 PV 时 summary、series 和各分布都是 null。 */
export interface SiteAnalytics {
  status: "ready";
  range: AnalyticsRange;
  generatedAt: string;
  partial: boolean;
  summary: AnalyticsSummary | null;
  series: AnalyticsPoint[] | null;
  pages: AnalyticsShare[] | null;
  referrers: AnalyticsShare[] | null;
  devices: AnalyticsShare[] | null;
  regions: AnalyticsShare[] | null;
}

/** 5 秒内没查完：服务端在后台继续，客户端过几秒用同样的参数再读。 */
export interface AnalyticsPending {
  status: "computing";
  range: AnalyticsRange;
}

export interface SitesPV24h {
  items: { siteId: string; pv24h: number | null }[];
}

/** 统计在服务端后台计算时每 3 秒再读一次，最多约 1 分钟（契约 getSiteAnalytics）。 */
export const ANALYTICS_RETRY_MS = 3_000;
export const ANALYTICS_MAX_RETRIES = 20;

/**
 * 统计页某个区间的状态：
 * - `loading`：第一次读或后台计算中；
 * - `failed`：3613（查询失败、超时或排队已满）或重试一分钟仍未算完，就地提示稍后重试；
 * - 其余是结果。
 */
export type AnalyticsState =
  | { status: "loading" }
  | { status: "failed" }
  | SiteAnalytics;

/** 列表卡片上的近 24 小时 PV：null 表示这次没查出来，显示「—」。 */
export type PV24hMap = Record<string, number | null>;

/** 读 pv24h 时一次带的站点：还没读过的，最多 20 个。 */
export function pv24hBatches(siteIds: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < siteIds.length; i += MAX_PV24H_SITES)
    batches.push(siteIds.slice(i, i + MAX_PV24H_SITES));
  return batches;
}

const integer = new Intl.NumberFormat("en-US");

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : integer.format(value);
}

/** 占比和跳出率：0–1 的小数显示成百分比，小于 10% 保留一位小数。 */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const percent = value * 100;
  return `${percent < 10 && percent > 0 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** 平均停留时长：不到 1 分钟显示秒，否则「x 分 y 秒」；超过 1 小时显示「x 时 y 分」。 */
export function formatDuration(
  seconds: number | null | undefined,
  locale: "en" | "zh-CN",
): string {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.round(seconds);
  const zh = locale === "zh-CN";
  if (total < 60) return zh ? `${total} 秒` : `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return zh ? `${m} 分 ${s} 秒` : `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return zh ? `${h} 时 ${m} 分` : `${h}h ${m}m`;
}

/** RUM 上报的设备类型原值；不认识的原样显示。 */
export const DEVICE_TYPES = ["pc", "mobile", "tablet"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export function isDeviceType(key: string): key is DeviceType {
  return (DEVICE_TYPES as readonly string[]).includes(key);
}

/** 趋势图坐标：按最大值归一到 [0, 1]，最大值为 0 时都在底线上。 */
export function chartPoints(
  values: readonly number[],
): { x: number; y: number }[] {
  const max = Math.max(0, ...values);
  const last = Math.max(1, values.length - 1);
  return values.map((value, index) => ({
    x: values.length === 1 ? 0.5 : index / last,
    y: max === 0 ? 0 : value / max,
  }));
}
