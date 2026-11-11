// zcode-site CLI 测试：用内存里的 Sites API 替身（按 api/openapi.yaml 的状态机）代替 zcode-server 和后面的控制面。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createServer } from "node:http";

import { createEndpointFetch, main, normalizePrefix } from "../scripts/zcode-site.mjs";
import { packStage } from "../scripts/stage.mjs";

// CLI 只认 agent 注入的官方命令端点（技术方案 5.8）；身份头和版本头由端点补，CLI 不带。
const ENV = {
  ZCODE_OFFICIAL_ENDPOINT: "/tmp/zcode-official-test.sock",
  ZCODE_OFFICIAL_ENDPOINT_TOKEN: "session-token",
};

class FakeSites {
  constructor() {
    this.sites = [];
    this.deployments = [];
    this.nextId = 1000;
    // 发布结果：上传完成之后第几次轮询进入终态、终态是什么
    this.publishPolls = 1;
    this.publishOutcome = { status: "success" };
    this.uploads = 0;
    // 第一次上传：truncate 时服务端只收到一部分（3604）；dropResponse 时服务端收完了但响应丢了（网络错误）
    this.firstUpload = undefined;
    this.unauthenticated = false;
    this.planExpired = false;
    this.endpointNetworkError = false;
    this.badgeRemovable = false;
    // 服务端机审：rejectNames 里的名称返回 3611，rejectPrefixes 里的（规范化后的）前缀换成 site。
    this.rejectNames = new Set();
    this.rejectPrefixes = new Set();
    // 统计：前几次读返回 computing（服务端后台计算中）。
    this.analyticsComputing = 0;
    this.analyticsCalls = [];
  }

  site({ prefix = "app", ...overrides } = {}) {
    const id = String(this.nextId++);
    const s = {
      id,
      name: overrides.name ?? "app",
      domainLabel: `${prefix}-${id}`,
      url: `https://${prefix}-${id}.zcode-cn.site`,
      status: "pending",
      region: "cn",
      badgeHidden: false,
      badgeVisible: true,
      multiInstance: false,
      currentDeployment: null,
      latestDeployment: null,
      ...overrides,
    };
    this.sites.push(s);
    return s;
  }

  deployment(siteId, overrides = {}) {
    const d = {
      id: String(this.nextId++),
      siteId,
      status: "preparing",
      artifactSize: 0,
      failure: null,
      logs: [],
      polls: 0,
      ...overrides,
    };
    this.deployments.push(d);
    return d;
  }

  view(d) {
    const { logs, polls, ...rest } = d;
    return rest;
  }

  fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (this.unauthenticated) return new Response(null, { status: 401 });
    if (this.planExpired)
      return Response.json(
        { code: 3101, msg: "coding plan is required", logid: "l" },
        { status: 403 },
      );
    if (this.endpointNetworkError) {
      return Response.json(
        { code: 2007, msg: "x", data: null, logid: "" },
        { status: 502, headers: { "X-ZCode-Official-Endpoint-Error": "network" } },
      );
    }
    assert.equal(init.headers.Authorization, "Bearer session-token");
    assert.equal(init.headers["X-ZCode-App-Version"], undefined);
    assert.equal(init.headers["X-Bigmodel-Authorization"], undefined);
    const { pathname } = new URL(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const ok = (data) => Response.json({ code: 0, msg: "success", data, logid: "l" });
    const err = (status, code, data) =>
      Response.json({ code, msg: "x", data, logid: "l" }, { status });
    const parts = pathname.split("/").slice(4); // /api/v1/sites/...

    if (pathname === "/api/v1/sites/usage") return ok({ plan: "free", canDeploy: true });
    if (parts.length === 0 && method === "GET")
      return ok({ items: [...this.sites].reverse(), nextCursor: null });
    if (parts.length === 0 && method === "POST") {
      this.createBodies = [...(this.createBodies ?? []), body];
      if (this.rejectNames.has(body.name)) return err(400, 3611);
      const prefix = normalizePrefix(body.domainPrefix ?? body.name);
      return ok(
        this.site({ name: body.name, prefix: this.rejectPrefixes.has(prefix) ? "site" : prefix }),
      );
    }
    const site = this.sites.find((s) => s.id === parts[0]);
    if (!site) return err(404, 3601);
    if (parts.length === 1 && method === "GET") return ok(site);
    if (parts.length === 1 && method === "DELETE") {
      const busy = this.deployments.some(
        (d) =>
          d.siteId === site.id &&
          ["preparing", "uploading", "publishing", "verifying"].includes(d.status),
      );
      if (busy) return err(409, 3610);
      this.sites = this.sites.filter((s) => s !== site);
      return ok(undefined);
    }
    if (parts.length === 2 && parts[1] === "analytics" && method === "GET") {
      const range = new URL(url).searchParams.get("range");
      this.analyticsCalls.push(range);
      if (this.analyticsComputing-- > 0) return ok({ status: "computing", range });
      return ok({ status: "ready", range, generatedAt: "t", partial: false, summary: null });
    }
    if (parts.length === 1 && method === "PATCH" && "domainPrefix" in body) {
      // 服务端规则（契约 updateSite）：改前缀不兜底，不足 4 位 3001，机审不过 3614，后缀重新生成。
      const prefix = normalizePrefix(body.domainPrefix);
      if (prefix === "site" && body.domainPrefix.toLowerCase() !== "site") return err(400, 3001);
      if (this.rejectPrefixes.has(prefix)) return err(400, 3614);
      const label = `${prefix}-${this.nextId++}`;
      Object.assign(site, { domainLabel: label, url: `https://${label}.zcode-cn.site` });
      return ok(site);
    }
    if (parts.length === 1 && method === "PATCH") {
      if (body.badgeHidden && !this.badgeRemovable) return err(403, 3608);
      if ("multiInstance" in body && typeof body.multiInstance !== "boolean") return err(400, 3001);
      if (this.rejectNames.has(body.name)) return err(400, 3611);
      // 服务端规则：当前线上版本被人审驳回时不能改回上线。
      if (body.status === "online" && site.offlineReason === "review_rejected")
        return err(403, 3612);
      if ("badgeHidden" in body) site.badgeVisible = !body.badgeHidden;
      Object.assign(site, body);
      // 服务端规则：没有线上版本的站点上线后还是 pending。
      if (site.status === "online" && !site.currentDeployment) site.status = "pending";
      return ok(site);
    }
    if (parts.length === 2 && method === "POST") {
      const busy = this.deployments.find((d) =>
        ["preparing", "uploading", "publishing", "verifying"].includes(d.status),
      );
      if (busy)
        return err(409, 3610, {
          inProgress: { siteId: busy.siteId, deploymentId: busy.id, status: busy.status },
        });
      const d = this.deployment(site.id, {
        artifactSize: body.artifactSize,
        logs: [{ stage: "preparing", level: "info", message: "created" }],
      });
      site.latestDeployment = this.view(d);
      return ok(this.view(d));
    }
    const d = this.deployments.find((x) => x.id === parts[2] && x.siteId === site.id);
    if (!d) return err(404, 3602);
    const action = parts[3];
    if (!action && method === "GET") {
      if (d.status === "publishing" && ++d.polls >= this.publishPolls) {
        Object.assign(d, this.publishOutcome);
        d.logs.push({
          stage: "verifying",
          level: d.status === "success" ? "info" : "error",
          message: d.status,
        });
        if (d.status === "success") {
          site.currentDeployment = this.view(d);
          site.status = "online";
          delete site.offlineReason;
        }
      }
      return ok(this.view(d));
    }
    if (action === "package" && method === "PUT") {
      this.uploads++;
      assert.equal(init.headers["Content-Type"], "application/gzip");
      if (!["preparing", "uploading"].includes(d.status)) return err(409, 3603);
      d.status = "uploading";
      const first = this.uploads === 1 ? this.firstUpload : undefined;
      if (first === "truncate" || body.length !== d.artifactSize) return err(409, 3604);
      d.status = "publishing";
      d.logs.push({ stage: "publishing", level: "info", message: "publishing" });
      if (first === "dropResponse") throw new TypeError("fetch failed");
      return ok(this.view(d));
    }
    if (action === "logs") {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const entries = d.logs.slice(offset).map((e, i) => ({ ...e, offset: offset + i, ts: "t" }));
      return ok({
        entries,
        nextOffset: d.logs.length,
        done: !["preparing", "uploading", "publishing", "verifying"].includes(d.status),
      });
    }
    return err(404, 3601);
  };
}

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-site-cli-"));
  await mkdir(join(dir, "stage"));
  await writeFile(join(dir, "stage", "start.sh"), "exec node static-server.mjs .\n");
  await writeFile(join(dir, "stage", "index.html"), "<h1>hi</h1>");
  return dir;
}

async function run(fake, cwd, ...argv) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    env: ENV,
    cwd,
    fetchImpl: fake.fetch,
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
    sleep: async () => {},
    now: () => 0,
  });
  const lines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    code,
    lines,
    result: lines.at(-1),
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}

test("first deploy creates and binds a site, then later deploys reuse it", async () => {
  const fake = new FakeSites();
  const cwd = await project();
  const r = await run(fake, cwd, "deploy", "stage", "--name", "My App");

  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.equal(fake.sites.length, 1);
  assert.equal(fake.sites[0].name, "My App");
  assert.deepEqual(r.result, {
    siteId: fake.sites[0].id,
    deploymentId: fake.deployments[0].id,
    status: "success",
    url: fake.sites[0].url,
    failure: null,
  });
  assert.ok(r.lines.some((l) => l.event === "site_created"));
  assert.deepEqual(r.lines[0], {
    event: "packed",
    packageBytes: fake.deployments[0].artifactSize,
    unpackedBytes: 41,
    files: 2,
    linuxBinaries: 0,
  });
  assert.ok(r.lines.some((l) => l.event === "log" && l.message === "publishing"));
  const binding = JSON.parse(await readFile(join(cwd, ".zcode-site.json"), "utf8"));
  assert.deepEqual(binding, { siteId: fake.sites[0].id, domainLabel: fake.sites[0].domainLabel });

  const again = await run(fake, cwd, "deploy", "stage", "--quiet");
  assert.equal(again.code, 0);
  assert.equal(again.lines.length, 1, "--quiet prints only the result");
  assert.equal(fake.sites.length, 1);
  assert.equal(fake.deployments.length, 2);

  // skill 让首次部署统一带 --new；已绑定的项目误带时只提醒，仍部署到已绑定的站点。
  const withNew = await run(fake, cwd, "deploy", "stage", "--new");
  assert.equal(withNew.code, 0);
  assert.equal(fake.sites.length, 1);
  assert.ok(withNew.lines.some((l) => l.event === "warning" && /--new is ignored/.test(l.message)));
});

test("an unbound project does not guess among existing sites", async () => {
  const fake = new FakeSites();
  fake.site({ name: "a" });
  fake.site({ name: "b" });
  const r = await run(fake, await project(), "deploy", "stage");

  assert.equal(r.code, 1);
  assert.equal(r.error.code, "SITE_NOT_SELECTED");
  assert.deepEqual(
    r.error.data.candidates.map((c) => c.name),
    ["b", "a"],
  );
  assert.equal(fake.deployments.length, 0);

  const created = await run(fake, await project(), "deploy", "stage", "--new");
  assert.equal(created.code, 0);
  assert.equal(fake.sites.length, 3);
});

test("a 3610 for the same site that has not started publishing is resumed", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const cwd = await project();
  // 续传按包大小认同一次部署；同一个 stage 每次打出的包字节一致（tar 头用文件 mtime，gzip 头不写时间）。
  const { body } = await packStage(join(cwd, "stage"));
  const stuck = fake.deployment(site.id, { status: "uploading", artifactSize: body.length });
  const r = await run(fake, cwd, "deploy", "stage", "--site", site.id);

  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.equal(r.result.deploymentId, stuck.id);
  assert.ok(r.lines.some((l) => l.event === "deployment_started" && l.resumed === true));
});

test("a deployment in progress elsewhere is reported with exit code 3", async () => {
  const fake = new FakeSites();
  const other = fake.site();
  const mine = fake.site();
  fake.deployment(other.id, { status: "publishing" });
  const r = await run(fake, await project(), "deploy", "stage", "--site", mine.id);

  assert.equal(r.code, 3);
  assert.equal(r.error.code, 3610);
  assert.match(r.error.hint, new RegExp(other.id));
});

test("an upload the server rejects as incomplete is uploaded again", async () => {
  const fake = new FakeSites();
  fake.firstUpload = "truncate";
  const r = await run(fake, await project(), "deploy", "stage");

  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.equal(fake.uploads, 2);
  assert.equal(r.lines.filter((l) => l.event === "uploading").length, 2);
});

test("a lost upload response continues with the deployment the server already accepted", async () => {
  const fake = new FakeSites();
  fake.firstUpload = "dropResponse";
  const r = await run(fake, await project(), "deploy", "stage");

  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.equal(fake.uploads, 2); // 第二次收到 3603，CLI 查到部署已在发布，直接轮询
  assert.equal(r.result.status, "success");
});

test("a failed deployment exits 4 with the failure", async () => {
  const fake = new FakeSites();
  fake.publishPolls = 2;
  fake.publishOutcome = {
    status: "failed",
    failure: { stage: "verifying", code: "WARMUP_FAILED", message: "no 200 within 90s" },
  };
  const r = await run(fake, await project(), "deploy", "stage");

  assert.equal(r.code, 4);
  assert.equal(r.error.code, "WARMUP_FAILED");
  assert.match(r.error.hint, /start\.sh/);
  assert.equal(r.error.data.status, "failed");
});

test("a stage that fails the package contract creates nothing", async () => {
  const fake = new FakeSites();
  const cwd = await project();
  await writeFile(join(cwd, "stage", "start.sh"), "exec node server.js\r\n");
  await writeFile(join(cwd, "stage", ".env"), "SECRET=1");
  const r = await run(fake, cwd, "deploy", "stage", "--new");

  assert.equal(r.code, 1);
  assert.equal(r.error.code, "PACKAGE_CHECK_FAILED");
  assert.equal(r.error.data.problems.length, 2);
  assert.equal(fake.sites.length, 0);
  assert.equal(fake.deployments.length, 0);
});

test("local and auth errors", async () => {
  const fake = new FakeSites();
  const cwd = await project();
  assert.equal((await run(fake, cwd, "deploy", "missing")).error.code, "STAGE_NOT_FOUND");
  assert.equal((await run(fake, cwd, "deploy", "stage", "--site", "1", "--new")).code, 1);
  assert.equal((await run(fake, cwd, "nope")).error.code, "UNKNOWN_COMMAND");
  fake.unauthenticated = true;
  const r = await run(fake, cwd, "usage");
  assert.equal(r.code, 2);
  assert.equal(r.error.code, "UNAUTHENTICATED");

  fake.unauthenticated = false;
  fake.planExpired = true;
  const expired = await run(fake, cwd, "usage");
  assert.equal(expired.code, 2);
  assert.equal(expired.error.code, 3101);
  assert.match(expired.error.hint, /sign in to ZCode again/);

  const noEnv = await main(["usage"], {
    env: {},
    cwd,
    stdout: { write() {} },
    stderr: { write() {} },
  });
  assert.equal(noEnv, 2);

  fake.planExpired = false;
  fake.endpointNetworkError = true;
  const offline = await run(fake, cwd, "usage");
  assert.equal(offline.code, 4);
  assert.equal(offline.error.code, "NETWORK_ERROR");
});

test("createEndpointFetch talks HTTP over the endpoint socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-site-ep-"));
  const socketPath = join(dir, "endpoint.sock");
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      if (req.url === "/empty") return res.writeHead(204).end();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ code: 0, data: { ok: true } }));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const fetchImpl = createEndpointFetch(socketPath);
    const res = await fetchImpl(
      "http://zcode-official-endpoint/api/v1/sites/1/deployments/2/package?x=1",
      {
        method: "PUT",
        headers: { Authorization: "Bearer t", "Content-Type": "application/gzip" },
        body: Buffer.from("tarball"),
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code: 0, data: { ok: true } });
    assert.equal(seen[0].url, "/api/v1/sites/1/deployments/2/package?x=1");
    assert.equal(seen[0].headers["content-length"], "7");
    assert.equal(seen[0].headers["transfer-encoding"], undefined);
    assert.equal(seen[0].body.toString(), "tarball");
    assert.equal((await fetchImpl("http://zcode-official-endpoint/empty")).status, 204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("status, rename, offline and online use the bound site", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const cwd = await project();
  await writeFile(
    join(cwd, ".zcode-site.json"),
    JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }),
  );

  assert.equal((await run(fake, cwd, "status")).result.id, site.id);
  assert.equal((await run(fake, cwd, "rename", "New", "Name")).result.name, "New Name");
  assert.equal((await run(fake, cwd, "offline")).result.status, "offline");
  assert.equal((await run(fake, cwd, "online")).result.status, "pending");
  fake.sites[0].currentDeployment = { id: "1", status: "success" };
  assert.equal((await run(fake, cwd, "online")).result.status, "online");
  assert.equal((await run(fake, cwd, "list")).result.sites.length, 1);
  assert.equal((await run(fake, cwd, "status", "--site", "999")).code, 1);
});

test("analytics waits while the server computes them, then gives up after a minute", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const cwd = await project();
  fake.analyticsComputing = 2;
  const ok = await run(fake, cwd, "analytics", "--site", site.id, "--range", "30d");
  assert.equal(ok.code, 0);
  assert.deepEqual(fake.analyticsCalls, ["30d", "30d", "30d"]);
  assert.deepEqual(
    { siteId: ok.result.siteId, status: ok.result.status, range: ok.result.range },
    { siteId: site.id, status: "ready", range: "30d" },
  );
  assert.equal((await run(fake, cwd, "analytics", "--site", site.id)).result.range, "7d");

  fake.analyticsComputing = 100;
  const pending = await run(fake, cwd, "analytics", "--site", site.id);
  assert.equal(pending.code, 4);
  assert.equal(pending.error.code, "ANALYTICS_PENDING");
  assert.equal((await run(fake, cwd, "analytics", "--site", site.id, "--range", "1y")).code, 1);
});

test("prefix changes the domain, updates the binding and reports the old address", async () => {
  const fake = new FakeSites();
  const site = fake.site({ prefix: "old-name" });
  const cwd = await project();
  await writeFile(
    join(cwd, ".zcode-site.json"),
    JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }),
  );
  const oldUrl = site.url;
  const changed = await run(fake, cwd, "prefix", "Tokyo Trip");
  assert.equal(changed.code, 0);
  assert.match(changed.result.url, /^https:\/\/tokyo-trip-\d+\.zcode-cn\.site$/);
  assert.equal(changed.result.previousUrl, oldUrl);
  const binding = JSON.parse(await readFile(join(cwd, ".zcode-site.json"), "utf8"));
  assert.equal(binding.domainLabel, fake.sites[0].domainLabel);

  // 规范化后不足 4 位在本地就拦下，不发请求；机审不过是 3614，退出码 1。
  const short = await run(fake, cwd, "prefix", "生日");
  assert.equal(short.code, 1);
  assert.equal(short.error.code, "INVALID_ARGS");
  fake.rejectPrefixes.add("bad-word");
  const rejected = await run(fake, cwd, "prefix", "bad word");
  assert.equal(rejected.code, 1);
  assert.equal(rejected.error.code, 3614);
  assert.equal((await run(fake, cwd, "prefix")).code, 1);
});

test("delete needs an explicit --site and unlinks the project", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const other = fake.site();
  const cwd = await project();
  await writeFile(
    join(cwd, ".zcode-site.json"),
    JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }),
  );
  const missing = await run(fake, cwd, "delete");
  assert.equal(missing.code, 1);
  assert.equal(missing.error.code, "MISSING_SITE");
  assert.equal(fake.sites.length, 2);

  const kept = await run(fake, cwd, "delete", "--site", other.id);
  assert.deepEqual(kept.result, { siteId: other.id, deleted: true, unlinked: false });
  await readFile(join(cwd, ".zcode-site.json"), "utf8");

  fake.deployment(site.id, { status: "publishing" });
  const busy = await run(fake, cwd, "delete", "--site", site.id);
  assert.equal(busy.code, 3);
  assert.equal(busy.error.code, 3610);
  fake.deployments = [];
  const removed = await run(fake, cwd, "delete", "--site", site.id);
  assert.deepEqual(removed.result, { siteId: site.id, deleted: true, unlinked: true });
  await assert.rejects(readFile(join(cwd, ".zcode-site.json"), "utf8"), { code: "ENOENT" });
  assert.equal(fake.sites.length, 0);
  assert.equal((await run(fake, cwd, "delete", "--site", site.id)).error.code, 3601);
});

test("badge hide needs a plan that can remove the badge", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const cwd = await project();
  await writeFile(
    join(cwd, ".zcode-site.json"),
    JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }),
  );

  const denied = await run(fake, cwd, "badge", "hide");
  assert.equal(denied.code, 3);
  assert.equal(denied.error.code, 3608);
  assert.match(denied.error.hint, /paid/);

  fake.badgeRemovable = true;
  const hidden = (await run(fake, cwd, "badge", "hide")).result;
  assert.equal(hidden.badgeHidden, true);
  assert.equal(hidden.badgeVisible, false);
  assert.equal((await run(fake, cwd, "badge", "show")).result.badgeVisible, true);
  assert.equal((await run(fake, cwd, "badge")).code, 1);
});

test("instance switches between single and multi instance", async () => {
  const fake = new FakeSites();
  const site = fake.site();
  const cwd = await project();
  await writeFile(
    join(cwd, ".zcode-site.json"),
    JSON.stringify({ siteId: site.id, domainLabel: site.domainLabel }),
  );

  assert.equal((await run(fake, cwd, "status")).result.multiInstance, false);
  assert.equal((await run(fake, cwd, "instance", "multi")).result.multiInstance, true);
  assert.equal(fake.sites[0].multiInstance, true);
  assert.equal((await run(fake, cwd, "instance", "single")).result.multiInstance, false);
  const bad = await run(fake, cwd, "instance", "many");
  assert.equal(bad.code, 1);
  assert.equal(bad.error.code, "INVALID_ARGS");
  assert.equal((await run(fake, cwd, "instance")).code, 1);
});

test("--prefix is sent as domainPrefix only when the site is created", async () => {
  const fake = new FakeSites();
  const cwd = await project();
  const r = await run(
    fake,
    cwd,
    "deploy",
    "stage",
    "--name",
    "生日网站",
    "--prefix",
    "happy-birthday",
  );
  assert.equal(r.code, 0, JSON.stringify(r.error));
  assert.deepEqual(fake.createBodies, [{ name: "生日网站", domainPrefix: "happy-birthday" }]);
  assert.ok(!r.lines.some((l) => l.event === "warning"));

  // 已绑定站点：--prefix 不生效，也不再创建，只提示一次。
  const again = await run(fake, cwd, "deploy", "stage", "--prefix", "other-name");
  assert.equal(again.code, 0);
  assert.equal(fake.createBodies.length, 1);
  assert.match(again.lines.find((l) => l.event === "warning").message, /ignored/);
});

test("without --prefix the server derives the prefix from the name", async () => {
  const fake = new FakeSites();
  const r = await run(fake, await project(), "deploy", "stage", "--name", "My App");
  assert.equal(r.code, 0);
  assert.deepEqual(fake.createBodies, [{ name: "My App" }]);
});

test("a non-conforming --prefix is still sent, with a warning about the normalized result", async () => {
  const fake = new FakeSites();
  const r = await run(fake, await project(), "deploy", "stage", "--prefix", "Happy Birthday!");
  assert.equal(r.code, 0);
  assert.equal(fake.createBodies[0].domainPrefix, "Happy Birthday!");
  assert.match(r.lines.find((l) => l.event === "warning").message, /"happy-birthday"/);

  const short = await run(fake, await project(), "deploy", "stage", "--new", "--prefix", "ab");
  assert.equal(short.code, 0);
  assert.match(short.lines.find((l) => l.event === "warning").message, /"site"/);
});

test("a name that fails content review gets 3611 and nothing is linked", async () => {
  const fake = new FakeSites();
  fake.rejectNames.add("bad name");
  const cwd = await project();
  const r = await run(
    fake,
    cwd,
    "deploy",
    "stage",
    "--name",
    "bad name",
    "--prefix",
    "fine-prefix",
  );
  assert.equal(r.code, 1);
  assert.equal(r.error.code, 3611);
  assert.match(r.error.hint, /--name/);
  assert.equal(fake.deployments.length, 0);
  await assert.rejects(readFile(join(cwd, ".zcode-site.json")));

  // 改名不通过时名称不变。
  assert.equal((await run(fake, cwd, "deploy", "stage", "--name", "good")).code, 0);
  const renamed = await run(fake, cwd, "rename", "bad", "name");
  assert.equal(renamed.code, 1);
  assert.equal(renamed.error.code, 3611);
  assert.equal(fake.sites[0].name, "good");
});

test("a site whose live version was rejected by content review gets 3612 until redeployed", async () => {
  const fake = new FakeSites();
  const cwd = await project();
  assert.equal((await run(fake, cwd, "deploy", "stage")).code, 0);
  const site = fake.sites[0];
  assert.equal((await run(fake, cwd, "status")).result.offlineReason, undefined);

  // 人审驳回：服务端把站点下线并带上 offlineReason。
  Object.assign(site, { status: "offline", offlineReason: "review_rejected" });
  const status = (await run(fake, cwd, "status")).result;
  assert.equal(status.status, "offline");
  assert.equal(status.offlineReason, "review_rejected");
  const denied = await run(fake, cwd, "online");
  assert.equal(denied.code, 3);
  assert.equal(denied.error.code, 3612);
  assert.match(denied.error.hint, /deploy again/);
  assert.equal(site.status, "offline");

  // 重新部署成功后站点恢复上线。
  assert.equal((await run(fake, cwd, "deploy", "stage")).code, 0);
  const redeployed = (await run(fake, cwd, "status")).result;
  assert.equal(redeployed.status, "online");
  assert.equal(redeployed.offlineReason, undefined);
});

test("a prefix replaced by site after content review gets a warning", async () => {
  const fake = new FakeSites();
  fake.rejectPrefixes.add("bad-prefix").add("bad-name");
  const r = await run(fake, await project(), "deploy", "stage", "--prefix", "Bad Prefix");
  assert.equal(r.code, 0);
  const warnings = r.lines.filter((l) => l.event === "warning").map((l) => l.message);
  assert.ok(
    warnings.some(
      (m) => /"bad-prefix" did not pass content review/.test(m) && m.includes(r.result.url),
    ),
    warnings,
  );
  assert.match(r.result.url, /^https:\/\/site-/);

  // 没有 --prefix 时前缀来自名称，同样提示。
  const byName = await run(fake, await project(), "deploy", "stage", "--new", "--name", "Bad Name");
  assert.ok(byName.lines.some((l) => l.event === "warning" && /"bad-name"/.test(l.message)));

  // 规范化后本来就是 site 的不算机审替换，只有规范化提示。
  const short = await run(fake, await project(), "deploy", "stage", "--new", "--prefix", "ab");
  assert.equal(short.code, 0);
  assert.ok(!short.lines.some((l) => /content review/.test(l.message ?? "")));
});

test("normalizePrefix matches the server rule", () => {
  const cases = [
    ["happy-birthday", "happy-birthday"],
    ["Happy Birthday!", "happy-birthday"],
    ["-a..b--cd-", "a-b-cd"],
    ["生日快乐", "site"],
    ["ab", "site"],
    ["abcd", "abcd"],
    ["", "site"],
    ["a".repeat(40), "a".repeat(30)],
    ["a".repeat(29) + "-b", "a".repeat(29)],
  ];
  for (const [input, want] of cases) assert.equal(normalizePrefix(input), want, input);
});

test("help documents every command and option, and needs no endpoint", async () => {
  let stdout = "";
  const code = await main(["help"], {
    env: {},
    cwd: tmpdir(),
    stdout: { write: (s) => (stdout += s) },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  const commands = [
    "check",
    "deploy",
    "status",
    "logs",
    "offline",
    "online",
    "rename",
    "badge",
    "instance",
    "list",
    "usage",
    "analytics",
    "prefix",
    "delete",
    "help",
  ];
  const options = [
    "--new",
    "--site",
    "--name",
    "--prefix",
    "--offset",
    "--range",
    "--quiet",
    "--port",
    "--allow-foreign-binaries",
  ];
  for (const word of commands) assert.match(stdout, new RegExp(`^  ${word}\\b`, "m"), word);
  for (const word of options) assert.ok(stdout.includes(word), word);
  for (const exit of ["0", "1", "2", "3", "4"])
    assert.match(stdout, new RegExp(`^  ${exit}  `, "m"));
});
