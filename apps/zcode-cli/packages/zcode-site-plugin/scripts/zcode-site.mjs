#!/usr/bin/env node
// zcode-site：ZCode Sites 的命令行客户端（技术方案 4.2、4.3、5.3）。
// deploy 的输入是 Agent 准备好的 stage 目录，打包与契约检查、以及本地命令 check 在 stage.mjs；其余只和云端交互，不探测项目。
// 命令、参数、输出和错误码的完整说明只写在 HELP 里（`zcode-site help`），site-deploy skill 引用它，不再重复。
//
// 输出契约：成功时 stdout 输出 JSON，退出码 0；deploy 过程中每个阶段和每条日志各输出一行 JSON（--quiet 只输出终态）。
// 失败时 stderr 输出一行 {"error":{code,message,hint}}，退出码 1=参数或本地文件错误、2=未登录、3=超出额度或限额、4=部署失败或服务端错误。
//
// 鉴权（技术方案 5.8）：CLI 不持有任何登录凭证。请求发给 ZCode agent 侧的官方命令端点，端点按
// session token 认出会话，补上 ZCode 身份头和 X-ZCode-App-Version 后转发给 zcode-server。
// 端点地址和 token 由 ZCode 注入当前会话的 Bash，在普通终端里运行会按未登录退出：
//   ZCODE_OFFICIAL_ENDPOINT        端点地址（macOS / Linux 是 UDS 路径，Windows 是命名管道）
//   ZCODE_OFFICIAL_ENDPOINT_TOKEN  本会话的 token

import { realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { apiError, CliError, localError } from "./errors.mjs";
import { checkStage, packStage } from "./stage.mjs";

const BINDING_FILE = ".zcode-site.json";
const POLL_INTERVAL_MS = 2000;
// 服务端兜底清理会把 publishing / verifying 超 10 分钟的部署置为 failed，这里多等一点再放弃。
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const UPLOAD_ATTEMPTS = 3;
const IN_FLIGHT = new Set(["preparing", "uploading", "publishing", "verifying"]);
const RESUMABLE = new Set(["preparing", "uploading"]);
// 统计在服务端 5 秒内没算完时返回 computing，后台继续算；按契约每 3 秒再读，最多约 1 分钟。
const ANALYTICS_RANGES = ["24h", "7d", "30d"];
const ANALYTICS_RETRY_MS = 3000;
const ANALYTICS_ATTEMPTS = 20;

// ---------- 鉴权与 API ----------

const ENDPOINT_ORIGIN = "http://zcode-official-endpoint";
// 端点自己产生的错误经这个响应头说明类型；network 表示端点连不上 zcode-server。
const ENDPOINT_ERROR_HEADER = "x-zcode-official-endpoint-error";

function loadEndpoint(env) {
  const address = env.ZCODE_OFFICIAL_ENDPOINT?.trim();
  const token = env.ZCODE_OFFICIAL_ENDPOINT_TOKEN?.trim();
  if (!address || !token) {
    throw new CliError(
      "UNAUTHENTICATED",
      "ZCode credentials are not available",
      "Run zcode-site from a ZCode session (the Sites plugin must be enabled), then retry.",
      2,
    );
  }
  return { address, token };
}

// 经 UDS / 命名管道发 HTTP 请求，返回标准 Response，和 fetch 同形状（测试注入 fetchImpl 替换它）。
export function createEndpointFetch(address) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const { pathname, search } = new URL(url);
      const headers = { ...init.headers };
      if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
      const req = httpRequest(
        { socketPath: address, path: pathname + search, method: init.method ?? "GET", headers },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("aborted", () =>
            reject(new Error("the connection was closed before the response ended")),
          );
          res.on("end", () => {
            if (!res.complete)
              return reject(new Error("the connection was closed before the response ended"));
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            const status = res.statusCode ?? 502;
            const nullBody = status === 204 || status === 205 || status === 304;
            resolve(
              new Response(nullBody ? null : Buffer.concat(chunks), {
                status,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
}

function createClient(endpoint, fetchImpl) {
  // body 是 JSON 对象；Buffer 原样作为请求体发送（产物包），按长度带上 Content-Length。
  async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${endpoint.token}` };
    const raw = Buffer.isBuffer(body);
    if (body !== undefined) headers["Content-Type"] = raw ? "application/gzip" : "application/json";
    let res;
    try {
      res = await fetchImpl(ENDPOINT_ORIGIN + path, {
        method,
        headers,
        body: body === undefined || raw ? body : JSON.stringify(body),
      });
    } catch (err) {
      throw new CliError(
        "NETWORK_ERROR",
        `Cannot reach the Sites API: ${err.message}`,
        "Check the network connection to ZCode and retry.",
        4,
      );
    }
    if (res.headers.get(ENDPOINT_ERROR_HEADER) === "network") {
      throw new CliError(
        "NETWORK_ERROR",
        "ZCode cannot reach the Sites API",
        "Check the network connection and retry.",
        4,
      );
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok || parsed?.code !== 0) throw apiError(res.status, parsed);
    return parsed.data;
  }
  return {
    listSites: (cursor) =>
      call(
        "GET",
        `/api/v1/sites?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    // domainPrefix 不传时服务端按 name 规范化（openapi createSite）。
    createSite: (name, domainPrefix) =>
      call("POST", "/api/v1/sites", domainPrefix === undefined ? { name } : { name, domainPrefix }),
    getSite: (id) => call("GET", `/api/v1/sites/${id}`),
    updateSite: (id, patch) => call("PATCH", `/api/v1/sites/${id}`, patch),
    createDeployment: (siteId, artifactSize) =>
      call("POST", `/api/v1/sites/${siteId}/deployments`, { artifactSize }),
    getDeployment: (siteId, id) => call("GET", `/api/v1/sites/${siteId}/deployments/${id}`),
    uploadPackage: (siteId, id, body) =>
      call("PUT", `/api/v1/sites/${siteId}/deployments/${id}/package`, body),
    logs: (siteId, id, offset) =>
      call("GET", `/api/v1/sites/${siteId}/deployments/${id}/logs?offset=${offset}`),
    usage: () => call("GET", "/api/v1/sites/usage"),
    analytics: (siteId, range) =>
      call("GET", `/api/v1/sites/${siteId}/analytics?range=${encodeURIComponent(range)}`),
    deleteSite: (id) => call("DELETE", `/api/v1/sites/${id}`),
  };
}

// ---------- 站点绑定（技术方案 4.3） ----------

async function readBinding(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, BINDING_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const b = JSON.parse(text);
    if (typeof b.siteId === "string" && b.siteId) return b;
  } catch {
    // 落到下面统一报错
  }
  throw localError(
    "INVALID_BINDING",
    `${BINDING_FILE} is not valid`,
    `Fix or delete ${BINDING_FILE}, or pass --site <id>.`,
  );
}

async function writeBinding(cwd, site) {
  await writeFile(
    join(cwd, BINDING_FILE),
    `${JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }, null, 2)}\n`,
  );
}

async function allSites(client) {
  const items = [];
  let cursor;
  do {
    const page = await client.listSites(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function candidates(sites) {
  return sites.map((s) => ({ id: s.id, name: s.name, url: s.url, status: s.status }));
}

// resolveSite 的规则：--site > 绑定文件 > 账户下没有站点时（只限 deploy）新建；已有站点时报错并给出候选，不按名字匹配，也不自动新建。
async function resolveSite(ctx, { allowCreate }) {
  const { client, cwd, opts } = ctx;
  if (opts.site) return { site: await client.getSite(opts.site), bound: false };
  const binding = await readBinding(cwd);
  if (binding) return { site: await client.getSite(binding.siteId), bound: true };
  if (allowCreate && opts.new)
    return {
      site: await client.createSite(siteName(ctx), opts.prefix),
      bound: false,
      created: true,
    };
  const sites = await allSites(client);
  if (allowCreate && sites.length === 0)
    return {
      site: await client.createSite(siteName(ctx), opts.prefix),
      bound: false,
      created: true,
    };
  throw new CliError(
    "SITE_NOT_SELECTED",
    sites.length ? "This project is not linked to a site" : "You have no sites yet",
    allowCreate
      ? "Ask the user which site to update, then retry with --site <id>, or with --new to create a new site."
      : "Pass --site <id>, or deploy first.",
    1,
    { candidates: candidates(sites) },
  );
}

function siteName(ctx) {
  return (ctx.opts.name ?? basename(ctx.cwd)).trim() || "site";
}

// normalizePrefix 与服务端 site.NormalizePrefix 同一规则（技术方案 5.4），只用来提前告诉 Agent 实际会得到的前缀；
// 发给服务端的仍是原值，以服务端规范化的结果为准。
export function normalizePrefix(prefix) {
  let s = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 30) s = s.slice(0, 30).replace(/-+$/, "");
  return s.length < 4 ? "site" : s;
}

// --prefix 只在本次新建站点时生效；不合规时提示规范化结果，但不拦截，交给服务端兜底。
// 前缀（没有 --prefix 时是名称）没有通过服务端机审时，服务端换成 site，按返回的 domainLabel 提示（契约 0.15.0）。
function prefixNotice(opts, created, site) {
  if (!created)
    return opts.prefix === undefined
      ? undefined
      : "--prefix is ignored: the site already exists. Change its domain with `zcode-site prefix <prefix>`.";
  const expected = normalizePrefix(opts.prefix ?? site.name);
  if (expected !== "site" && !site.domainLabel.startsWith(`${expected}-`))
    return `The domain prefix ${JSON.stringify(expected)} did not pass content review, so the server used "site": the domain is ${site.url}. Change it with \`zcode-site prefix <prefix>\`.`;
  if (opts.prefix === undefined) return undefined;
  const normalized = expected;
  if (normalized === opts.prefix) return undefined;
  return normalized === "site"
    ? `--prefix ${JSON.stringify(opts.prefix)} has fewer than 4 usable [a-z0-9-] characters; the server falls back to "site".`
    : `--prefix ${JSON.stringify(opts.prefix)} is normalized to ${JSON.stringify(normalized)}.`;
}

// ---------- deploy ----------

async function deploy(ctx, stageDir) {
  const { client, out, opts } = ctx;
  if (!stageDir)
    throw localError(
      "MISSING_STAGE",
      "Missing stage directory",
      "Usage: zcode-site deploy <stage-dir> [--new | --site <id>]",
    );
  if (opts.site && opts.new)
    throw localError(
      "INVALID_ARGS",
      "--site and --new cannot be used together",
      "Pass only one of them.",
    );
  // 先打包再选站点：契约检查不过时不建站、不建部署。
  const packed = await packStage(stageDir, {
    cwd: ctx.cwd,
    allowForeignBinaries: opts["allow-foreign-binaries"],
  });
  if (packed.error)
    throw localError(packed.error, packed.message, "Pass the stage directory that holds start.sh.");
  if (packed.problems)
    throw new CliError(
      "PACKAGE_CHECK_FAILED",
      `The stage does not meet the package contract:\n${packed.problems.map((p) => `  - ${p}`).join("\n")}`,
      "Fix every listed problem in the stage (see the site-deploy skill references), then deploy again.",
      1,
      { problems: packed.problems },
    );
  out.event({ event: "packed", ...packed.result });
  for (const message of packed.warnings) out.event({ event: "warning", message });

  const { site, bound, created } = await resolveSite(ctx, { allowCreate: true });
  if (!bound) await writeBinding(ctx.cwd, site);
  if (created) out.event({ event: "site_created", siteId: site.id, url: site.url });
  // 已绑定时 --new 不生效：首次部署统一带 --new，后续部署即使误带也只会更新已绑定的站点，不会重复建站。
  if (bound && opts.new)
    out.event({
      event: "warning",
      message: `--new is ignored: this project is linked to site ${site.id} (${BINDING_FILE}).`,
    });
  const notice = prefixNotice(opts, created, site);
  if (notice) out.event({ event: "warning", message: notice });

  const deployment = await startDeployment(client, site.id, packed.body.length);
  out.event({
    event: "deployment_started",
    siteId: site.id,
    deploymentId: deployment.id,
    resumed: deployment.resumed,
  });

  await uploadPackage(ctx, site.id, deployment.id, packed.body);

  const final = await watch(ctx, site.id, deployment.id);
  const result = {
    siteId: site.id,
    deploymentId: final.id,
    status: final.status,
    url: site.url,
    failure: final.failure,
  };
  if (final.status !== "success") {
    throw new CliError(
      final.failure?.code ?? "DEPLOYMENT_FAILED",
      `Deployment failed at ${final.failure?.stage ?? "unknown"}: ${final.failure?.message ?? final.status}`,
      deployHint(final.failure?.code),
      4,
      result,
    );
  }
  return result;
}

// 同一用户同时只能有一个进行中的部署。3610 指向本站点、且还没开始发布时，多半是上一次请求成功了但响应丢了，直接续传（技术方案 5.3）。
async function startDeployment(client, siteId, size) {
  try {
    return { ...(await client.createDeployment(siteId, size)), resumed: false };
  } catch (err) {
    const p = err.data?.inProgress;
    if (err.code === 3610 && p && p.siteId === siteId && RESUMABLE.has(p.status)) {
      const d = await client.getDeployment(siteId, p.deploymentId);
      if (d.artifactSize === size) return { ...d, resumed: true };
    }
    if (err.code === 3610 && p)
      err.hint = `Deployment ${p.deploymentId} of site ${p.siteId} is ${p.status}. Wait for it to finish, then retry.`;
    throw err;
  }
}

// 包经 zcode-server 转发给控制面，由控制面写 OSS 并进入 publishing（openapi uploadPackage），CLI 不直接访问 OSS。
// 断网或 3604（传输中断、长度不符）时用同一个请求整包重传；3603 说明上一次其实已经传完、只是响应丢了，直接进入轮询。
async function uploadPackage(ctx, siteId, deploymentId, body) {
  const { client, out } = ctx;
  for (let attempt = 1; ; attempt++) {
    out.event({ event: "uploading", attempt, bytes: body.length });
    try {
      return await client.uploadPackage(siteId, deploymentId, body);
    } catch (err) {
      if (err.code === 3603) {
        const d = await client.getDeployment(siteId, deploymentId);
        if (!RESUMABLE.has(d.status)) return d;
        throw err;
      }
      const retryable = err.code === 3604 || err.code === "NETWORK_ERROR";
      if (!retryable || attempt >= UPLOAD_ATTEMPTS) throw err;
    }
  }
}

async function watch(ctx, siteId, deploymentId) {
  const { client, out, sleep, now } = ctx;
  const deadline = now() + POLL_TIMEOUT_MS;
  let offset = 0;
  let lastStatus;
  const drainLogs = async () => {
    const logs = await client.logs(siteId, deploymentId, offset);
    for (const e of logs.entries)
      out.event({ event: "log", stage: e.stage, level: e.level, message: e.message, ts: e.ts });
    offset = logs.nextOffset;
  };
  for (;;) {
    const d = await client.getDeployment(siteId, deploymentId);
    // 先读状态再读日志：状态已到终态时，这一轮读到的日志一定是全部。
    await drainLogs();
    if (d.status !== lastStatus) {
      out.event({ event: "status", status: d.status });
      lastStatus = d.status;
    }
    if (!IN_FLIGHT.has(d.status)) return d;
    if (now() > deadline) {
      throw new CliError(
        "WATCH_TIMEOUT",
        "Timed out waiting for the deployment to finish",
        `It is still ${d.status}; check later with \`zcode-site status --site ${siteId}\`.`,
        4,
        { siteId, deploymentId },
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function deployHint(code) {
  switch (code) {
    case "PACKAGE_INVALID":
      return "Fix the stage as described in the message (see the site-deploy skill's packaging reference) and deploy again.";
    case "WARMUP_FAILED":
      return "start.sh did not answer GET / on 0.0.0.0:3000 with a status below 500 in time. Read `zcode-site logs <deploymentId>`, run `zcode-site check <stage-dir>`, fix it and deploy again.";
    case "UPLOAD_TIMEOUT":
      return "The upload did not finish in time. Run `zcode-site deploy` again.";
    default:
      return "Run `zcode-site logs <deploymentId>` for details, then retry. The previous live version keeps serving.";
  }
}

// ---------- 其他命令 ----------

function summarize(site) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    status: site.status,
    ...(site.offlineReason && { offlineReason: site.offlineReason }),
    region: site.region,
    badgeHidden: site.badgeHidden,
    badgeVisible: site.badgeVisible,
    multiInstance: site.multiInstance,
    currentDeployment: site.currentDeployment && pickDeployment(site.currentDeployment),
    latestDeployment: site.latestDeployment && pickDeployment(site.latestDeployment),
  };
}

function pickDeployment(d) {
  return {
    id: d.id,
    status: d.status,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt,
    failure: d.failure,
  };
}

async function logsCommand(ctx, deploymentId) {
  if (!deploymentId)
    throw localError(
      "MISSING_DEPLOYMENT",
      "Missing deployment id",
      "Usage: zcode-site logs <deploymentId> [--site <id>] [--offset <n>]",
    );
  const { site } = await resolveSite(ctx, { allowCreate: false });
  const offset = ctx.opts.offset === undefined ? 0 : Number(ctx.opts.offset);
  if (!Number.isInteger(offset) || offset < 0)
    throw localError(
      "INVALID_ARGS",
      "--offset must be a non-negative integer",
      "Pass the nextOffset from the previous call.",
    );
  return ctx.client.logs(site.id, deploymentId, offset);
}

async function setStatus(ctx, status) {
  const { site } = await resolveSite(ctx, { allowCreate: false });
  return summarize(await ctx.client.updateSite(site.id, { status }));
}

async function setBadge(ctx, action) {
  if (action !== "hide" && action !== "show")
    throw localError(
      "INVALID_ARGS",
      "Expected hide or show",
      "Usage: zcode-site badge hide|show [--site <id>]",
    );
  const { site } = await resolveSite(ctx, { allowCreate: false });
  return summarize(await ctx.client.updateSite(site.id, { badgeHidden: action === "hide" }));
}

// 实例模式（契约 Site.multiInstance）：single 是默认，所有请求进同一个实例；multi 让请求分到多个实例。
async function setInstance(ctx, mode) {
  if (mode !== "single" && mode !== "multi")
    throw localError(
      "INVALID_ARGS",
      "Expected single or multi",
      "Usage: zcode-site instance single|multi [--site <id>]",
    );
  const { site } = await resolveSite(ctx, { allowCreate: false });
  return summarize(await ctx.client.updateSite(site.id, { multiInstance: mode === "multi" }));
}

async function rename(ctx, name) {
  if (!name?.trim())
    throw localError(
      "MISSING_NAME",
      "Missing site name",
      "Usage: zcode-site rename [--site <id>] <name>",
    );
  const { site } = await resolveSite(ctx, { allowCreate: false });
  return summarize(await ctx.client.updateSite(site.id, { name: name.trim() }));
}

async function analyticsCommand(ctx) {
  const range = ctx.opts.range ?? "7d";
  if (!ANALYTICS_RANGES.includes(range))
    throw localError(
      "INVALID_ARGS",
      "--range must be 24h, 7d or 30d",
      "Usage: zcode-site analytics [--site <id>] [--range 24h|7d|30d]",
    );
  const { site } = await resolveSite(ctx, { allowCreate: false });
  for (let attempt = 1; ; attempt++) {
    const result = await ctx.client.analytics(site.id, range);
    if (result.status !== "computing") return { siteId: site.id, url: site.url, ...result };
    if (attempt >= ANALYTICS_ATTEMPTS)
      throw new CliError(
        "ANALYTICS_PENDING",
        "The analytics are still being computed",
        "Run the same command again in a minute.",
        4,
        { siteId: site.id, range },
      );
    await ctx.sleep(ANALYTICS_RETRY_MS);
  }
}

// 改域名前缀：服务端规范化后生成新的 {前缀}-{4 位随机}，旧地址立即失效，统计从零开始（契约 updateSite）。
// 改前缀时服务端不兜底：规范化后不足 4 位直接报错，这里提前拦截，省一次请求。
async function changePrefix(ctx, prefix) {
  if (!prefix?.trim())
    throw localError(
      "MISSING_PREFIX",
      "Missing domain prefix",
      "Usage: zcode-site prefix <prefix> [--site <id>]",
    );
  const normalized = normalizePrefix(prefix);
  if (normalized === "site" && !/^site$/i.test(prefix.trim()))
    throw localError(
      "INVALID_ARGS",
      "The prefix has fewer than 4 usable characters",
      "Use 4-30 lowercase letters, digits and -.",
    );
  const { site, bound } = await resolveSite(ctx, { allowCreate: false });
  const updated = await ctx.client.updateSite(site.id, { domainPrefix: prefix.trim() });
  if (bound) await writeBinding(ctx.cwd, updated);
  return { ...summarize(updated), previousUrl: site.url };
}

// 删除不可恢复，只接受显式的 --site，不按绑定文件猜目标；删掉的是本项目绑定的站点时一并删除绑定文件。
async function deleteCommand(ctx) {
  const id = ctx.opts.site;
  if (!id)
    throw localError(
      "MISSING_SITE",
      "delete needs --site <id>",
      "Confirm with the user which site to delete, then pass --site <id>.",
    );
  await ctx.client.deleteSite(id);
  let unlinked = false;
  const binding = await readBinding(ctx.cwd).catch(() => undefined);
  if (binding?.siteId === id) {
    await rm(join(ctx.cwd, BINDING_FILE), { force: true });
    unlinked = true;
  }
  return { siteId: id, deleted: true, unlinked };
}

const HELP = `zcode-site: deploy and manage ZCode Sites. Run it from the project root.

Output
  stdout: JSON, one object per line. deploy prints progress events first; the last line is the result.
  stderr on failure: one line {"error":{"code","message","hint","data"?}}. Follow hint.

Exit codes
  0  success
  1  bad arguments, a local file or stage problem, or SITE_NOT_SELECTED
  2  not signed in to ZCode, sign-in expired, or not run inside a ZCode session
  3  quota, rate or size limit, or another deployment in progress
  4  the deployment failed, or a server error

Local command (no sign-in, nothing is uploaded)
  check <stage-dir> [--port <n>]
      Run "bash start.sh" in the stage with PORT (default 13000) and a temporary DATA_DIR, wait
      up to 90 s for GET / below 500, then stop it.
      Result: {status: "live", httpStatus, log} - the site should answer 200.
              {status: "skipped", reason} - the stage can't run on this machine (Linux binaries on
              macOS/Windows, or no bash); run the app from its normal local environment instead.
      START_FAILED: data {reason, httpStatus?, log}.

Site commands
  deploy <stage-dir> [--new | --site <id>] [--name <name>] [--prefix <prefix>]
         [--allow-foreign-binaries] [--quiet]
      Pack the stage directory (its root becomes /app) and publish it. Packing runs first and
      checks the package contract: root start.sh with LF line endings, size, file count, path
      depth, reserved /.__zcode/, broken symlinks, .env files, dependencies present, and every
      native binary linux x86-64. It skips .git, .DS_Store, __pycache__ and .zcode-site.json.
      PACKAGE_CHECK_FAILED (exit 1): data.problems lists everything to fix; nothing was created
      or uploaded. Fix all of them, then deploy again.
      --allow-foreign-binaries: accept non-linux binaries; only after confirming each listed file
                is never loaded at runtime (e.g. prebuilt binaries for other platforms next to
                the linux-x64 one).
      Target site: --site <id>, else the site in .zcode-site.json, else with --new a new site.
      A new site is linked by writing .zcode-site.json; keep it and don't put it in the stage.
      --new is ignored (with a warning) when the project is already linked.
      Without --new or --site on an unlinked project: SITE_NOT_SELECTED if the account has sites,
      data.candidates [{id, name, url, status}]; ask the user, never pick one yourself.
      --name    display name of a new site, any language (default: directory name). A name that
                fails the server's content review gets 3611 and nothing is created.
      --prefix  domain prefix of a new site: 4-30 chars, lowercase a-z 0-9 and -. The domain is
                {prefix}-{4 random chars}. The server lowercases it, turns other characters into
                -, cuts it to 30 and falls back to "site" below 4 or when the prefix fails content
                review; a warning event says so.
                Ignored for an existing site; change its domain with \`prefix\`.
      --quiet   print only the result.
      Events: {event: "packed", packageBytes, unpackedBytes, files, linuxBinaries}, then
              {event: "site_created" | "warning" | "deployment_started" | "uploading" | "log" | "status", ...}
      Result: {siteId, deploymentId, status: "success", url}
      Failure (exit 4): code is the failed stage reason, data has {siteId, deploymentId, failure}.
        PACKAGE_INVALID  server preflight rejected the package; message names the file.
        WARMUP_FAILED    GET / got no answer below 500 within 90 s; read logs, run check.
        UPLOAD_TIMEOUT   deploy again.
        PUBLISH_FAILED, PUBLISH_TIMEOUT, INTERNAL  platform side; retry later.
      The previous live version keeps serving after a failed deployment.
  status [--site <id>]
      Result: {id, name, url, status, offlineReason?, region, badgeHidden, badgeVisible, multiInstance,
      currentDeployment, latestDeployment} (deployments: {id, status, createdAt, finishedAt, failure}).
      status: pending = never deployed successfully, the URL shows nothing yet; online = the URL
              serves currentDeployment; offline = taken offline. offlineReason review_rejected means
              content review rejected the live version and took the site offline: online gets 3612,
              change the content and deploy again. A redeploy keeps the site online
              on the old version. Deployment progress is latestDeployment.status: preparing,
              uploading, publishing or verifying means still running (it ends within about 10
              minutes) - wait and check again, don't redeploy.
  logs <deploymentId> [--site <id>] [--offset <n>]
      Result: {entries: [{stage, level, message, ts}], nextOffset}; pass nextOffset to read on.
  offline [--site <id>]   take the site offline; domain and records are kept. Result: as status.
  online [--site <id>]    bring it back; a site never deployed successfully stays pending, and one whose
          live version was rejected by content review gets 3612. Result: as status.
  rename [--site <id>] <name>   change the display name only; 3611 if it fails content review.
          Result: as status.
  badge hide|show [--site <id>]   hide or show the "ZCode" badge on the site. Only paid plans can
          hide it (usage.badgeRemovable); free plans get 3608. badgeHidden is the user's choice,
          badgeVisible whether the badge actually shows. Result: as status.
  instance single|multi [--site <id>]   single (default): all requests go to one instance, so
          memory and $DATA_DIR are shared by every request; at most 200 in flight, more get 429.
          multi: requests spread over several instances, nothing in memory or $DATA_DIR is shared;
          for stateless sites with heavy traffic. Takes effect without a redeploy (another region
          within 30 s). Result: as status (multiInstance).
  prefix <prefix> [--site <id>]   change the domain to {prefix}-{4 new random chars}. The prefix is
          normalized like --prefix but never falls back: fewer than 4 usable characters is an error,
          and a prefix that fails content review gets 3614. The old address stops working at once
          (no redirect) and may go to another site; visit analytics start over. Confirm with the
          user first. Updates .zcode-site.json. Result: as status, plus previousUrl.
  delete --site <id>   permanently delete the site: its address returns 404 at once and it can't
          be restored; this month's traffic and requests are not refunded. Needs an explicit
          --site; confirm with the user first. 3610 while a deployment is in progress. Removes
          .zcode-site.json when it points to this site.
          Result: {siteId, deleted: true, unlinked}.
  analytics [--site <id>] [--range 24h|7d|30d]   visit analytics (default 7d), from browsers that
          ran the page; bots excluded, a few minutes of delay. Waits up to about a minute while
          the server computes them (ANALYTICS_PENDING after that, retry later); 3613 = retry later.
          Result: {siteId, url, status: "ready", range, generatedAt, partial, summary: {pv, uv,
          avgDurationSeconds, bounceRate}, series: [{start, pv, uv}], pages, referrers, devices,
          regions: [{key, pv, share}]}. summary and the lists are null when there were no visits;
          a referrer key "" is direct or unknown. Counting restarts when the prefix changes.
  list    Result: {sites: [{id, name, url, status}]}
  usage   Account traffic, requests and storage against the plan; canDeploy and exceededReasons.
  help    this text.

Commands without --site use the site in .zcode-site.json. Numeric error codes come from the Sites
API (e.g. 3605 quota exceeded, 3610 another deployment in progress); their hint says what to do.`;

// ---------- 入口 ----------

export async function main(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    fetchImpl,
    stdout = process.stdout,
    stderr = process.stderr,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        site: { type: "string" },
        new: { type: "boolean" },
        name: { type: "string" },
        prefix: { type: "string" },
        offset: { type: "string" },
        range: { type: "string" },
        port: { type: "string" },
        "allow-foreign-binaries": { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    return fail(stderr, localError("INVALID_ARGS", err.message, "Run `zcode-site help`."));
  }
  const [command, ...args] = parsed.positionals;
  if (!command || command === "help" || parsed.values.help) {
    stdout.write(`${HELP}\n`);
    return command || parsed.values.help ? 0 : 1;
  }
  if (command === "check") {
    try {
      const result = await check(cwd, args, parsed.values);
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (err) {
      return fail(stderr, err instanceof CliError ? err : internalError(err));
    }
  }
  const quiet = parsed.values.quiet;
  const out = { event: (e) => quiet || stdout.write(`${JSON.stringify(e)}\n`) };
  try {
    const endpoint = loadEndpoint(env);
    const client = createClient(endpoint, fetchImpl ?? createEndpointFetch(endpoint.address));
    const ctx = { client, cwd, opts: parsed.values, out, sleep, now };
    let result;
    switch (command) {
      case "deploy":
        result = await deploy(ctx, args[0]);
        break;
      case "status":
        result = summarize((await resolveSite(ctx, { allowCreate: false })).site);
        break;
      case "logs":
        result = await logsCommand(ctx, args[0]);
        break;
      case "offline":
        result = await setStatus(ctx, "offline");
        break;
      case "online":
        result = await setStatus(ctx, "online");
        break;
      case "usage":
        result = await client.usage();
        break;
      case "list":
        result = { sites: candidates(await allSites(client)) };
        break;
      case "rename":
        result = await rename(ctx, args.join(" "));
        break;
      case "badge":
        result = await setBadge(ctx, args[0]);
        break;
      case "instance":
        result = await setInstance(ctx, args[0]);
        break;
      case "analytics":
        result = await analyticsCommand(ctx);
        break;
      case "prefix":
        result = await changePrefix(ctx, args.join(" "));
        break;
      case "delete":
        result = await deleteCommand(ctx);
        break;
      default:
        throw localError(
          "UNKNOWN_COMMAND",
          `Unknown command: ${command}`,
          "Run `zcode-site help`.",
        );
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    return fail(stderr, err instanceof CliError ? err : internalError(err));
  }
}

function internalError(err) {
  return new CliError(
    "INTERNAL",
    err.message,
    "This is a bug in zcode-site; report it with the command you ran.",
    4,
  );
}

async function check(cwd, [stageDir], opts) {
  if (!stageDir)
    throw localError(
      "INVALID_ARGS",
      "Missing stage directory",
      "Usage: zcode-site check <stage-dir> [--port <n>]",
    );
  const port = opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw localError("INVALID_ARGS", "--port must be a port number", "Pass e.g. --port 13000.");
  const checked = await checkStage(stageDir, { cwd, ...(port ? { port } : {}) });
  if (checked.error)
    throw localError(
      checked.error,
      checked.message,
      "Pass the stage directory that holds start.sh.",
    );
  if (checked.failed)
    throw new CliError(
      "START_FAILED",
      checked.failed.reason,
      "Read data.log and the site-deploy skill's troubleshooting reference, fix the stage, then check again.",
      1,
      checked.failed,
    );
  return checked.result;
}

function fail(stderr, err) {
  const error = { code: err.code, message: err.message, hint: err.hint };
  if (err.data !== undefined) error.data = err.data;
  stderr.write(`${JSON.stringify({ error })}\n`);
  return err.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
