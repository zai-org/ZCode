import { describe, expect, it } from "vitest";
import type { SiteCommand } from "../contract.ts";
import { parseRoute } from "./host.ts";
import {
  ACTIVE_POLL_MS,
  chartPoints,
  coverKey,
  formatCount,
  formatDuration,
  formatShare,
  pv24hBatches,
  errorView,
  filterSites,
  formatBytes,
  formatMeter,
  IDLE_POLL_MS,
  listMenu,
  meterPercent,
  planName,
  pollInterval,
  siteMenu,
  sitePhase,
  stageViews,
  type Deployment,
  type LogEntry,
  type Site,
} from "./model.ts";

const deployment = (patch: Partial<Deployment> = {}): Deployment => ({
  id: "2",
  siteId: "1",
  status: "success",
  artifactSize: 1024,
  isCurrent: true,
  failure: null,
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  finishedAt: null,
  ...patch,
});
const site = (patch: Partial<Site> = {}): Site => ({
  id: "1",
  name: "Birthday",
  domainLabel: "birthday-w9r9",
  url: "https://birthday-w9r9.zai-ai.site",
  status: "online",
  badgeHidden: false,
  badgeVisible: true,
  hasCover: false,
  currentDeployment: deployment(),
  latestDeployment: deployment(),
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  ...patch,
});
const log = (stage: LogEntry["stage"], ts: string): LogEntry => ({
  offset: 0,
  ts,
  stage,
  level: "info",
  message: "",
});
const commands: SiteCommand[] = [
  "site-badge",
  "site-deploy",
  "site-logs",
  "site-offline",
  "site-online",
  "site-status",
  "site-usage",
].map((name) => ({ name, description: name }));

describe("polling", () => {
  it("polls fast only while a deployment is in progress", () => {
    expect(pollInterval([deployment(), null])).toBe(IDLE_POLL_MS);
    expect(pollInterval([deployment({ status: "publishing" })])).toBe(
      ACTIVE_POLL_MS,
    );
    expect(pollInterval([])).toBe(IDLE_POLL_MS);
  });
});

describe("stageViews", () => {
  it("marks stages up to the current status and takes times from logs", () => {
    const views = stageViews(deployment({ status: "publishing" }), [
      log("preparing", "t1"),
      log("uploading", "t2"),
      log("uploading", "t3"),
    ]);
    expect(views.map((view) => view.state)).toEqual([
      "done",
      "done",
      "active",
      "pending",
    ]);
    expect(views[1]).toMatchObject({ startedAt: "t2", endedAt: "t3" });
    expect(views[2].startedAt).toBeUndefined();
  });

  it("marks the failed stage", () => {
    const failed = deployment({
      status: "failed",
      failure: { stage: "verifying", code: "WARMUP_FAILED", message: "" },
    });
    expect(stageViews(failed, []).map((view) => view.state)).toEqual([
      "done",
      "done",
      "done",
      "failed",
    ]);
    expect(
      stageViews(deployment(), []).every((view) => view.state === "done"),
    ).toBe(true);
  });
});

describe("sitePhase", () => {
  it("prefers an in-progress deployment, then offline, then a failed latest deployment", () => {
    expect(
      sitePhase(
        site({ latestDeployment: deployment({ status: "uploading" }) }),
      ),
    ).toEqual({
      label: "uploading",
      tone: "busy",
    });
    expect(sitePhase(site({ status: "offline" })).label).toBe("offline");
    expect(
      sitePhase(site({ latestDeployment: deployment({ status: "failed" }) })),
    ).toEqual({
      label: "failed",
      tone: "danger",
    });
    expect(sitePhase(site())).toEqual({ label: "online", tone: "success" });
    expect(
      sitePhase(site({ status: "pending", latestDeployment: null })).tone,
    ).toBe("muted");
  });
});

describe("coverKey", () => {
  it("keys covers by the live deployment and skips sites without one", () => {
    expect(coverKey(site({ hasCover: true }))).toBe(deployment().id);
    expect(coverKey(site())).toBeUndefined();
    expect(
      coverKey(site({ hasCover: true, currentDeployment: null })),
    ).toBeUndefined();
  });
});

describe("errorView", () => {
  it.each([
    [
      { reason: "official_auth_unavailable" as const },
      { kind: "page", key: "login" },
    ],
    [{ reason: "unauthenticated" as const }, { kind: "page", key: "login" }],
    [
      { reason: "official_auth_plan_required" as const },
      { kind: "page", key: "plan" },
    ],
    [{ code: 3101 }, { kind: "page", key: "relogin" }],
    [{ code: 3609 }, { kind: "page", key: "appVersion" }],
    [{ code: 3601 }, { kind: "missing" }],
    [{ code: 3602 }, { kind: "missing" }],
    [
      { code: 2001, logid: "x" },
      { kind: "bar", logid: "x" },
    ],
    [{ reason: "network" as const }, { kind: "bar" }],
  ])("maps %o", (error, view) => {
    expect(errorView(error)).toEqual(view);
  });
});

describe("menus", () => {
  it("lists commands without a site for a new deployment", () => {
    expect(listMenu(commands).map((item) => item.text)).toEqual([
      "/site-deploy",
      "/site-status",
      "/site-logs",
      "/site-offline",
      "/site-online",
      "/site-usage",
    ]);
  });

  it("adds the site and picks offline or online by status", () => {
    expect(siteMenu(commands, site()).map((item) => item.text)).toEqual([
      "/site-deploy 1",
      "/site-status 1",
      "/site-logs 2",
      "/site-offline 1",
      "/site-usage",
    ]);
    expect(
      siteMenu(commands, site({ status: "offline" })).map(
        (item) => item.command,
      ),
    ).toContain("site-online");
    const rejected = siteMenu(
      commands,
      site({ status: "offline", offlineReason: "review_rejected" }),
    );
    expect(rejected.map((item) => item.command)).not.toContain("site-online");
    const fresh = siteMenu(
      commands,
      site({
        status: "pending",
        latestDeployment: null,
        currentDeployment: null,
      }),
    );
    expect(fresh.map((item) => item.command)).toEqual([
      "site-deploy",
      "site-status",
      "site-usage",
    ]);
  });

  it("only offers commands the plugin ships", () => {
    expect(listMenu([{ name: "site-deploy", description: "" }])).toEqual([
      { command: "site-deploy", text: "/site-deploy" },
    ]);
  });
});

describe("helpers", () => {
  it("filters by name and domain", () => {
    const sites = [
      site(),
      site({ id: "3", name: "Shop", url: "https://shop-abcd.zai.site" }),
    ];
    expect(filterSites(sites, "ABCD").map((item) => item.id)).toEqual(["3"]);
    expect(filterSites(sites, " birth ").map((item) => item.id)).toEqual(["1"]);
    expect(filterSites(sites, "")).toHaveLength(2);
  });

  it("shows plan tiers as given, only capitalized", () => {
    expect(planName("free")).toBe("Free");
    expect(planName("team_plus")).toBe("Team_plus");
    expect(planName("")).toBe("");
  });

  it("formats sizes and meter widths", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatBytes(1000 * 1024 ** 3)).toBe("1,000 GB");
    expect(formatMeter("requests", 1_000_000)).toBe("1M");
    expect(formatMeter("requests", 128_000)).toBe("128K");
    expect(formatMeter("requests", 0)).toBe("0");
    expect(formatMeter("sites", 30)).toBe("30");
    expect(meterPercent({ used: 5, limit: 10 })).toBe(50);
    expect(meterPercent({ used: 50, limit: 10 })).toBe(100);
    expect(meterPercent({ used: 0, limit: 0 })).toBe(0);
  });

  it("restores only well-formed routes", () => {
    expect(parseRoute({ page: "site", siteId: "12" })).toEqual({
      page: "site",
      siteId: "12",
    });
    expect(
      parseRoute({ page: "deployment", siteId: "12", deploymentId: "x" }),
    ).toEqual({
      page: "list",
    });
    expect(parseRoute(undefined)).toEqual({ page: "list" });
    expect(parseRoute({ page: "usage" })).toEqual({ page: "usage" });
    expect(
      parseRoute({ page: "site", siteId: "12", tab: "deployments" }),
    ).toEqual({
      page: "site",
      siteId: "12",
      tab: "deployments",
    });
    expect(
      parseRoute({ page: "site", siteId: "12", tab: "analytics" }),
    ).toEqual({
      page: "site",
      siteId: "12",
      tab: "analytics",
    });
    expect(parseRoute({ page: "site", siteId: "12", tab: "x" })).toEqual({
      page: "site",
      siteId: "12",
    });
  });
});

describe("analytics helpers", () => {
  it("formats counts, shares and durations", () => {
    expect(formatCount(12833)).toBe("12,833");
    expect(formatCount(null)).toBe("—");
    expect(formatShare(0.5234)).toBe("52%");
    expect(formatShare(0.0123)).toBe("1.2%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(null)).toBe("—");
    expect(formatDuration(30.3, "zh-CN")).toBe("30 秒");
    expect(formatDuration(102, "zh-CN")).toBe("1 分 42 秒");
    expect(formatDuration(3720, "en")).toBe("1h 2m");
    expect(formatDuration(null, "en")).toBe("—");
  });

  it("splits pv24h reads into batches of 20", () => {
    const ids = Array.from({ length: 45 }, (_, i) => String(i + 1));
    expect(pv24hBatches(ids).map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(pv24hBatches([])).toEqual([]);
  });

  it("scales chart points to the max", () => {
    expect(chartPoints([0, 5, 10])).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
    expect(chartPoints([0, 0])).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });
});
