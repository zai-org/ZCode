/**
 * 面板文案。只按错误码和原因生成，不展示服务端 msg；`zh-CN` 以外的语言回落 `en`。
 * 键按页面分组，与 docs/site/sites-panel.md「文案与 i18n」一致。
 */
const en = {
  "sites.title": "Sites",
  "sites.retry": "Retry",
  "sites.loading": "Loading…",
  "sites.loadMore": "Load more",
  "sites.cancel": "Cancel",
  "sites.save": "Save",
  "sites.copyLink": "Copy URL",
  "sites.copied": "Link copied.",
  "sites.visit": "Visit site",

  "sites.list.search": "Search sites…",
  "sites.list.emptyTitle": "Bring your work online",
  "sites.list.emptyHint":
    "Tell the agent what you want to deploy. Sites publishes it, and you can follow progress and links here.",
  "sites.list.noMatch": "No matching sites",
  "sites.list.notPublished": "Not published yet",
  "sites.list.newDeployment": "New deployment",

  "sites.site.rename": "Rename site",
  "sites.site.renameHint": "Changing the name does not affect the site URL.",
  "sites.site.name": "Site name",
  "sites.site.nameInvalid": "Use 1–100 characters.",
  "sites.site.nameRejected":
    "This name did not pass content review. Try another.",
  "sites.site.redeploy": "Redeploy",
  "sites.site.overview": "Overview",
  "sites.site.deployments": "Deployments",
  "sites.site.production": "Production deployment",
  "sites.site.noProduction": "No published version yet.",
  "sites.site.domain": "Domain",
  "sites.site.publishedAt": "Published at",
  "sites.site.latest": "Latest deployment",
  "sites.site.settings": "Settings",
  "sites.site.badge": "Show ZCode badge",
  "sites.site.badgeHint":
    "Display Made with ZCode at the bottom right of the website.",
  "sites.site.badgeLocked": "Upgrade your ZCode plan to hide the badge.",
  "sites.site.badgeRejected": "Your current plan can't hide the badge.",
  "sites.site.failed": "Deployment failed",
  "sites.site.failedAt": "Failed at {stage}: {message}",
  "sites.site.stillOnline": "The previous version is still online.",
  "sites.site.reviewRejected":
    "The content did not pass review. Change it and deploy again.",

  "sites.deployment.back": "Back to deployments",
  "sites.deployment.details": "Deployment details",
  "sites.deployment.current": "Current production",
  "sites.deployment.status": "Status",
  "sites.deployment.size": "Package",
  "sites.deployment.finishedAt": "Finished",
  "sites.deployment.empty": "No deployments yet.",
  "sites.deployment.logs": "Deployment logs",
  "sites.deployment.copyLogs": "Copy logs",
  "sites.deployment.logsCopied": "Logs copied.",
  "sites.deployment.noLogs": "No logs yet.",
  "sites.deployment.logsLive": "Waiting for logs…",
  "sites.deployment.logsEnd": "End of logs",
  "sites.deployment.follow": "Jump to latest",
  "sites.stage.preparing": "Prepare",
  "sites.stage.uploading": "Upload artifacts",
  "sites.stage.publishing": "Publish site",
  "sites.stage.verifying": "Verify",

  "sites.usage.title": "Usage & limits",
  "sites.usage.shared": "Shared across all sites · Plan {plan}",
  "sites.usage.traffic": "Monthly transfer",
  "sites.usage.requests": "Monthly requests",
  "sites.usage.storage": "Storage",
  "sites.usage.sites": "Online sites",
  "sites.usage.reset":
    "Transfer and requests reset monthly · Storage reflects current usage",
  "sites.usage.period": "Period {start} – {end} · Data may be delayed",
  "sites.usage.exceeded":
    "Over the limit for: {reasons}. New deployments are paused until the next period; upgrade your ZCode plan to raise the limits.",
  "sites.usage.bar": "{label} {used} / {limit}",
  "sites.usage.plans.title": "Plan limits & benefits",
  "sites.usage.plans.note":
    "All sites share the account limits. Transfer and requests reset monthly, storage counts what is in use, and only online sites count toward the site limit.",
  "sites.usage.plans.badge": "ZCode badge",
  "sites.usage.plans.badgeKept": "Shown",
  "sites.usage.plans.badgeRemovable": "Removable",
  "sites.usage.plans.current": "Current",
  "sites.usage.plans.failed": "Couldn't load plan limits.",

  "sites.menu.hint":
    "Pick one to copy it, then paste it into the chat input and send.",
  "sites.menu.title": "Sites commands",
  "sites.menu.copied": "Copied. Paste it into the chat input and send.",
  "sites.menu.site-deploy": "Redeploy",
  "sites.menu.site-deploy.new": "Deploy",
  "sites.menu.site-status": "Deployment status",
  "sites.menu.site-logs": "Deployment logs",
  "sites.menu.site-offline": "Take site offline",
  "sites.menu.site-online": "Bring site online",
  "sites.menu.site-usage": "Traffic and usage",
  "sites.menu.site-analytics": "Visit analytics",

  "sites.status.pending": "Not online yet",
  "sites.status.online": "Online",
  "sites.status.offline": "Offline",
  "sites.status.preparing": "Preparing",
  "sites.status.uploading": "Uploading",
  "sites.status.publishing": "Publishing",
  "sites.status.verifying": "Verifying",
  "sites.status.success": "Deployed",
  "sites.status.failed": "Deployment failed",

  "sites.login.title": "Sign in to use ZCode Sites",
  "sites.login.intro":
    "ZCode Sites puts the pages and apps your agent builds online with a public link. Track sites, deployments, and usage here.",
  "sites.login.note": "Deploying is available to signed-in users only. Sign in to ZCode first.",
  "sites.error.relogin": "Your sign-in has expired. Sign in to ZCode again.",
  "sites.error.plan":
    "Your Coding Plan has expired or doesn't match. Renew it, or disconnect it in Settings, to use this panel. The agent can still deploy sites.",
  "sites.error.appVersion":
    "This version of ZCode is too old for Sites. Update ZCode.",
  "sites.error.network": "Can't reach the Sites service right now.",
  "sites.error.logid": "Request ID: {logid}",
  "sites.error.action": "The change didn't go through. Try again.",
  "sites.error.copy": "Couldn't copy. Select the text and copy it manually.",
  "sites.list.pv24h": "PV, 24h",
  "sites.list.pvMeta": "{value} PV in 24h",

  "sites.site.analytics": "Analytics",
  "sites.site.visits": "Visits",
  "sites.site.visitsMore": "View more",
  "sites.site.pv24h": "PV, last 24 hours",
  "sites.site.pv7d": "PV, last 7 days",
  "sites.site.uv7d": "Visitors, last 7 days",
  "sites.site.dangerZone": "Danger zone",

  "sites.analytics.range.24h": "24 hours",
  "sites.analytics.range.7d": "7 days",
  "sites.analytics.range.30d": "30 days",
  "sites.analytics.pv": "Page views",
  "sites.analytics.uv": "Visitors",
  "sites.analytics.duration": "Avg. visit duration",
  "sites.analytics.bounce": "Bounce rate",
  "sites.analytics.trend": "Traffic trend",
  "sites.analytics.peak": "Peak {value} PV",
  "sites.analytics.pages": "Top pages",
  "sites.analytics.referrers": "Referrers",
  "sites.analytics.devices": "Devices",
  "sites.analytics.regions": "Regions",
  "sites.analytics.direct": "Direct / unknown",
  "sites.analytics.unknown": "Unknown",
  "sites.analytics.device.pc": "Desktop",
  "sites.analytics.device.mobile": "Mobile",
  "sites.analytics.device.tablet": "Tablet",
  "sites.analytics.empty": "No visits in this period yet.",
  "sites.analytics.computing": "Crunching the numbers…",
  "sites.analytics.failed": "Couldn't load analytics. Try again later.",
  "sites.analytics.updated": "Updated {time}",
  "sites.analytics.partial": "Too much data this time; the numbers may be low.",
  "sites.analytics.note":
    "Counts browser visits that ran the page. Bots and screenshots are excluded; data arrives within a few minutes.",

  "sites.delete.title": "Delete site",
  "sites.delete.action": "Delete",
  "sites.delete.settingHint":
    "Delete the site and its deployment history. This can't be undone.",
  "sites.delete.warning":
    "{host} returns 404 right away and the site can't be restored. Transfer and requests already used this month are not refunded.",
  "sites.delete.confirmLabel": "Type the site name {name} to confirm",
  "sites.delete.inProgress":
    "A deployment is in progress. Delete after it finishes.",
  "sites.delete.done": "Site deleted.",
};

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "sites.title": "部署",
  "sites.retry": "重试",
  "sites.loading": "加载中…",
  "sites.loadMore": "加载更多",
  "sites.cancel": "取消",
  "sites.save": "保存",
  "sites.copyLink": "复制链接",
  "sites.copied": "链接已复制。",
  "sites.visit": "访问站点",

  "sites.list.search": "搜索站点…",
  "sites.list.emptyTitle": "让你的作品上线",
  "sites.list.emptyHint":
    "告诉 Agent 你想部署什么，发布后可在这里查看进度与访问链接。",
  "sites.list.noMatch": "没有找到匹配的站点",
  "sites.list.notPublished": "尚未发布",
  "sites.list.newDeployment": "新建部署",

  "sites.site.rename": "修改站点名称",
  "sites.site.renameHint": "修改名称不会影响访问域名。",
  "sites.site.name": "站点名称",
  "sites.site.nameInvalid": "名称长度需为 1–100 个字符。",
  "sites.site.nameRejected": "名称未通过内容审核，请换一个。",
  "sites.site.redeploy": "重新部署",
  "sites.site.overview": "概览",
  "sites.site.deployments": "部署记录",
  "sites.site.production": "当前线上部署",
  "sites.site.noProduction": "尚无线上版本。",
  "sites.site.domain": "域名",
  "sites.site.publishedAt": "发布时间",
  "sites.site.latest": "最近一次部署",
  "sites.site.settings": "设置",
  "sites.site.badge": "显示 ZCode 标识",
  "sites.site.badgeHint": "在网站右下角展示 Made with ZCode。",
  "sites.site.badgeLocked": "升级 ZCode 套餐后可以移除标识。",
  "sites.site.badgeRejected": "当前套餐不能移除标识。",
  "sites.site.failed": "部署失败",
  "sites.site.failedAt": "在「{stage}」阶段失败：{message}",
  "sites.site.stillOnline": "上一发布版本保持可用。",
  "sites.site.reviewRejected": "内容未通过审核，修改后重新部署。",

  "sites.deployment.back": "返回部署记录",
  "sites.deployment.details": "部署详情",
  "sites.deployment.current": "当前线上版本",
  "sites.deployment.status": "状态",
  "sites.deployment.size": "产物包",
  "sites.deployment.finishedAt": "完成时间",
  "sites.deployment.empty": "还没有部署记录。",
  "sites.deployment.logs": "部署日志",
  "sites.deployment.copyLogs": "复制全部日志",
  "sites.deployment.logsCopied": "日志已复制。",
  "sites.deployment.noLogs": "暂无日志。",
  "sites.deployment.logsLive": "等待新日志…",
  "sites.deployment.logsEnd": "日志已结束",
  "sites.deployment.follow": "回到最新",
  "sites.stage.preparing": "检查与准备",
  "sites.stage.uploading": "上传产物",
  "sites.stage.publishing": "发布站点",
  "sites.stage.verifying": "验证上线",

  "sites.usage.title": "用量与限制",
  "sites.usage.shared": "所有站点共享 · 套餐 {plan}",
  "sites.usage.traffic": "本月流量",
  "sites.usage.requests": "本月请求",
  "sites.usage.storage": "存储空间",
  "sites.usage.sites": "已上线站点",
  "sites.usage.reset": "流量与请求额度每月重置 · 存储按当前占用计算",
  "sites.usage.period": "统计周期 {start} – {end} · 数据可能有延迟",
  "sites.usage.exceeded":
    "{reasons}已超出额度，下个周期前不能新部署；升级 ZCode 套餐可提高额度。",
  "sites.usage.bar": "{label} {used} / {limit}",
  "sites.usage.plans.title": "套餐额度与权益",
  "sites.usage.plans.note":
    "所有站点共享账户额度，流量和请求按月重置，存储按实际占用计算；站点数只统计已上线的站点。",
  "sites.usage.plans.badge": "ZCode 品牌标识",
  "sites.usage.plans.badgeKept": "保留标识",
  "sites.usage.plans.badgeRemovable": "可移除",
  "sites.usage.plans.current": "当前",
  "sites.usage.plans.failed": "套餐额度加载失败。",

  "sites.menu.hint": "选择后复制到剪贴板，粘贴到输入框发送。",
  "sites.menu.title": "部署命令",
  "sites.menu.copied": "已复制，粘贴到输入框发送。",
  "sites.menu.site-deploy": "重新部署",
  "sites.menu.site-deploy.new": "部署",
  "sites.menu.site-status": "查看部署状态",
  "sites.menu.site-logs": "查看部署日志",
  "sites.menu.site-offline": "下线站点",
  "sites.menu.site-online": "重新上线",
  "sites.menu.site-usage": "查看访问与用量",
  "sites.menu.site-analytics": "查看访问统计",

  "sites.status.pending": "尚未上线",
  "sites.status.online": "在线",
  "sites.status.offline": "已下线",
  "sites.status.preparing": "准备中",
  "sites.status.uploading": "上传中",
  "sites.status.publishing": "发布中",
  "sites.status.verifying": "验证中",
  "sites.status.success": "已部署",
  "sites.status.failed": "部署失败",

  "sites.login.title": "登录后即可使用 ZCode Site",
  "sites.login.intro":
    "ZCode Site 可以把 Agent 做好的网页和应用部署上线，生成可公开访问的链接；在这里可以查看站点、部署进度和用量。",
  "sites.login.note": "部署能力仅限登录用户使用，请先登录 ZCode。",
  "sites.error.relogin": "登录已过期，请重新登录 ZCode。",
  "sites.error.plan":
    "Coding Plan 已失效或类型不符，续费或在设置里断开后可用；部署仍可让 Agent 完成。",
  "sites.error.appVersion": "当前 ZCode 版本过旧，请升级 ZCode。",
  "sites.error.network": "暂时无法连接部署服务。",
  "sites.error.logid": "请求 ID：{logid}",
  "sites.error.action": "操作没有成功，请重试。",
  "sites.error.copy": "复制失败，请手动选择文本复制。",
  "sites.list.pv24h": "近 24 小时 PV",
  "sites.list.pvMeta": "24 小时 PV {value}",

  "sites.site.analytics": "数据统计",
  "sites.site.visits": "访问数据",
  "sites.site.visitsMore": "查看更多",
  "sites.site.pv24h": "近 24 小时 PV",
  "sites.site.pv7d": "近 7 天 PV",
  "sites.site.uv7d": "近 7 天访客",
  "sites.site.dangerZone": "危险操作",

  "sites.analytics.range.24h": "近 24 小时",
  "sites.analytics.range.7d": "近 7 天",
  "sites.analytics.range.30d": "近 30 天",
  "sites.analytics.pv": "浏览量 PV",
  "sites.analytics.uv": "独立访客 UV",
  "sites.analytics.duration": "平均访问时长",
  "sites.analytics.bounce": "跳出率",
  "sites.analytics.trend": "访问趋势",
  "sites.analytics.peak": "峰值 {value} PV",
  "sites.analytics.pages": "热门页面",
  "sites.analytics.referrers": "访问来源",
  "sites.analytics.devices": "设备分布",
  "sites.analytics.regions": "地区分布",
  "sites.analytics.direct": "直接访问 / 未知",
  "sites.analytics.unknown": "未知",
  "sites.analytics.device.pc": "桌面",
  "sites.analytics.device.mobile": "移动端",
  "sites.analytics.device.tablet": "平板",
  "sites.analytics.empty": "这段时间还没有访问数据。",
  "sites.analytics.computing": "正在统计…",
  "sites.analytics.failed": "统计暂时加载失败，请稍后重试。",
  "sites.analytics.updated": "数据更新于 {time}",
  "sites.analytics.partial": "本次数据量较大，只统计了一部分，数字可能偏小。",
  "sites.analytics.note":
    "统计浏览器中实际打开的访问，不含爬虫和平台截图；数据约有几分钟延迟。",

  "sites.delete.title": "删除站点",
  "sites.delete.action": "删除",
  "sites.delete.settingHint": "删除站点及其部署记录，删除后不可恢复。",
  "sites.delete.warning":
    "{host} 会立即无法访问，站点不可恢复；本月已用的流量和请求不退回。",
  "sites.delete.confirmLabel": "输入站点名称 {name} 确认删除",
  "sites.delete.inProgress": "站点有进行中的部署，请等部署结束后再删除。",
  "sites.delete.done": "站点已删除。",
};

export type Locale = "en" | "zh-CN";

export function resolveLocale(locale: string | undefined): Locale {
  return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

export function translator(locale: Locale): Translate {
  const table = locale === "zh-CN" ? zh : en;
  return (key, vars) =>
    table[key].replace(/\{(\w+)\}/g, (match, name: string) =>
      vars && name in vars ? String(vars[name]) : match,
    );
}

/** 部署阶段和日志只看时分秒：同一次部署通常几分钟内完成，日期在部署卡片上已有。 */
export function formatClock(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** 时间按用户本地时区显示；hostContext 给了时区时以它为准。 */
export function formatTime(
  iso: string,
  locale: Locale,
  timeZone?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 列表和卡片上的相对时间（「3 分钟前」）；超过一周显示月日，完整时间放在 title 里。 */
export function formatRelative(
  iso: string,
  locale: Locale,
  now: number,
  timeZone?: string,
): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const elapsed = Math.max(0, now - time);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsed < MINUTE) return rtf.format(0, "second");
  if (elapsed < HOUR)
    return rtf.format(-Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return rtf.format(-Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 7 * DAY) return rtf.format(-Math.floor(elapsed / DAY), "day");
  return new Date(time).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}
