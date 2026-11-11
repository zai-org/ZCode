// E2E 扩展 fixture（docs/plugins/extension-host.md §12.1、§18.1 H3）：纯 JS，不需要构建。
// 激活时记下网络相关环境变量是否存在（只记有没有，不记值），再用全局 fetch 请求一个 https 地址：
// 主机名是 .invalid，不经代理时解析不到；经 E2E 抓包代理时由代理回一份固定响应。
// 没有自定义 CA 时代理的证书不受信任，请求以 TLS 错误失败。每次扩展进程启动（重新加载扩展）都会再请求一次。
const TARGET = "https://gitlab.e2e.example.invalid/api/v4/version";
const KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];
const FETCH_LIMIT_MS = 20_000;

function errorCode(error) {
  const cause = error?.cause;
  return (
    cause?.code ?? cause?.cause?.code ?? error?.code ?? cause?.name ?? error?.name ?? "unknown"
  );
}

async function probe(ctx) {
  try {
    // 只是测试 fixture 的兜底：请求卡住时让日志有结论。
    const response = await fetch(TARGET, { signal: AbortSignal.timeout(FETCH_LIMIT_MS) });
    const body = await response.text();
    ctx.log.info(`E2E_NETWORK_FETCH ok status=${response.status} body=${body.slice(0, 80)}`);
  } catch (error) {
    ctx.log.info(`E2E_NETWORK_FETCH error code=${errorCode(error)}`);
  }
}

export function activate(ctx) {
  const env = KEYS.map((key) => `${key}=${typeof process.env[key] === "string" ? "set" : "unset"}`);
  ctx.log.info(`E2E_NETWORK_ENV ${env.join(" ")}`);
  // 不让激活等网络（激活有 10 秒预算）。
  void probe(ctx);
}

export function deactivate() {}
