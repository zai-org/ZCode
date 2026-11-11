// zcode-site 的错误：错误码到退出码和面向 Agent 的 message / hint 的映射（技术方案 5.8）。
// 和 zcode-site.mjs 一起随插件分发，零依赖。

// 与 api/openapi.yaml 的 x-cli-exit-code 一致。
const EXIT_BY_CODE = {
  3001: 1,
  3002: 3,
  3101: 2,
  3601: 1,
  3602: 1,
  3603: 4,
  3604: 4,
  3605: 3,
  3607: 3,
  3608: 3,
  3609: 1,
  3610: 3,
  3611: 1,
  3612: 3,
  3613: 4,
  3614: 1,
  2001: 4,
  2005: 4,
  2007: 4,
};

// 错误体不带提示文案（技术方案 5.8），面向 Agent 的 message / hint 在这里按 code 生成。
const MESSAGES = {
  3001: ["Invalid request", "Check the command arguments."],
  3002: [
    "Too many deployments in the last hour",
    "Wait and retry later; the limit is 10 deployments per hour.",
  ],
  // MaaS JWT 过期时 zcode-server 不按 free 放行，以免付费用户被降级（契约 0.13.0）。
  3101: [
    "The ZCode coding plan sign-in has expired",
    "Ask the user to sign in to ZCode again, then retry.",
  ],
  3601: ["Site not found", "Run `zcode-site list` to see your sites, then pass --site <id>."],
  3602: [
    "Deployment not found",
    "Run `zcode-site status` to see the latest deployment of this site.",
  ],
  3603: [
    "The deployment cannot do this in its current state",
    "Start a new deployment with `zcode-site deploy`.",
  ],
  3604: [
    "The package upload is incomplete",
    "Run `zcode-site deploy` again to re-upload the package.",
  ],
  3605: [
    "Account quota exceeded",
    "New deployments are paused until the next period. Tell the user that upgrading their ZCode plan raises the limits; the Sites panel in ZCode desktop shows the usage.",
  ],
  3607: [
    "The package is larger than 200MB",
    "Exclude build caches, source maps and dev dependencies from the stage, then deploy again.",
  ],
  3608: [
    "The current plan cannot hide the ZCode badge",
    "Free plans always show the badge; tell the user to upgrade to a paid ZCode plan, then run `zcode-site badge hide` again.",
  ],
  3609: ["This ZCode version is too old for Sites", "Ask the user to update ZCode."],
  3610: [
    "Another deployment is in progress",
    "Wait for it to finish (`zcode-site status --site <siteId>`), then retry.",
  ],
  // 名称和域名前缀在服务端过内容安全机审（契约 0.15.0）；只有名称不通过才报错，前缀不通过时服务端换成 site。
  3611: [
    "The site name did not pass content review",
    "Pick a different display name (--name for a new site, `zcode-site rename` for an existing one) and retry; nothing was created or renamed.",
  ],
  // 部署上线后过内容审核（契约 0.16.0）：人审驳回当前线上版本时站点被下线（offlineReason=review_rejected），用户不能自己改回上线。
  3612: [
    "The live version of this site was rejected by content review",
    "The site was taken offline and can't be brought back online with this version. Change the content and deploy again; a successful deploy puts the site back online.",
  ],
  // 访问统计即时查询 RUM 日志（契约 0.19.0）：查询失败、超时或排队已满。
  3613: ["Visit analytics are unavailable right now", "Retry in a minute."],
  // 改域名前缀时前缀过内容安全机审，不通过时不改（契约 0.19.0，与新建站点时换成 site 不同）。
  3614: [
    "The domain prefix did not pass content review",
    "Pick a different prefix and retry; the domain was not changed.",
  ],
  2001: ["Sites service error", "Retry later."],
  2005: ["Sites storage error", "Retry later."],
  2007: ["Sites upstream error", "Retry later."],
};

export class CliError extends Error {
  constructor(code, message, hint, exitCode, data) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function apiError(status, body) {
  if (status === 401) {
    return new CliError(
      "UNAUTHENTICATED",
      "Not signed in to ZCode",
      "Ask the user to sign in to ZCode, then retry.",
      2,
    );
  }
  const code = body?.code;
  const [message, hint] = MESSAGES[code] ?? [`Sites API error (HTTP ${status})`, "Retry later."];
  return new CliError(code ?? `HTTP_${status}`, message, hint, EXIT_BY_CODE[code] ?? 4, body?.data);
}

export function localError(code, message, hint) {
  return new CliError(code, message, hint, 1);
}
