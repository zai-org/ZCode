import { describe, expect, it } from "vitest";
import { resourcePath } from "./routes.ts";

const SITE = "1978123456789012480";
const DEP = "1978123456789012481";

describe("resourcePath", () => {
  it.each([
    ["zcode-site://usage", "/api/v1/sites/usage"],
    ["zcode-site://plans", "/api/v1/sites/plans"],
    ["zcode-site://sites", "/api/v1/sites"],
    ["zcode-site://sites?cursor=", "/api/v1/sites"],
    [
      "zcode-site://sites?cursor=a%2Fb&limit=20",
      "/api/v1/sites?cursor=a%2Fb&limit=20",
    ],
    [`zcode-site://sites/${SITE}`, `/api/v1/sites/${SITE}`],
    [
      `zcode-site://sites/${SITE}/deployments?cursor=x`,
      `/api/v1/sites/${SITE}/deployments?cursor=x`,
    ],
    [
      `zcode-site://sites/${SITE}/deployments/${DEP}`,
      `/api/v1/sites/${SITE}/deployments/${DEP}`,
    ],
    [`zcode-site://sites/${SITE}/cover`, `/api/v1/sites/${SITE}/cover`],
    [`zcode-site://sites/${SITE}/analytics`, `/api/v1/sites/${SITE}/analytics`],
    [
      `zcode-site://sites/${SITE}/analytics?range=30d`,
      `/api/v1/sites/${SITE}/analytics?range=30d`,
    ],
    [
      `zcode-site://sites/analytics/pv24h?siteIds=${SITE},${DEP}`,
      `/api/v1/sites/analytics/pv24h?siteIds=${SITE}%2C${DEP}`,
    ],
    [
      `zcode-site://sites/${SITE}/deployments/${DEP}/logs?offset=12`,
      `/api/v1/sites/${SITE}/deployments/${DEP}/logs?offset=12`,
    ],
  ])("maps %s", (uri, path) => {
    expect(resourcePath(uri)).toBe(path);
  });

  it.each([
    "zcode-site://other",
    "https://sites/1",
    "zcode-site://usage?cursor=1",
    "zcode-site://plans?limit=1",
    "zcode-site://plans/free",
    "zcode-site://sites/abc",
    "zcode-site://sites/0123",
    "zcode-site://sites/1/deployments/2/logs/extra",
    "zcode-site://sites/1/cover/2",
    "zcode-site://sites/1/cover?offset=1",
    "zcode-site://sites/1/settings",
    "zcode-site://sites/1/deployments/2/logs?offset=-1",
    "zcode-site://sites?limit=1e3",
    "zcode-site://sites?cursor=a&cursor=b",
    "zcode-site://sites/1/deployments/2?offset=1",
    "zcode-site://user@sites",
    "zcode-site://sites/..%2Fusage",
    "zcode-site://sites/1/analytics?range=1y",
    "zcode-site://sites/1/analytics?offset=1",
    "zcode-site://sites/1/analytics/pages",
    "zcode-site://sites/analytics",
    "zcode-site://sites/analytics/pv24h?siteIds=1,abc",
    `zcode-site://sites/analytics/pv24h?siteIds=${Array(21).fill("1").join(",")}`,
    "zcode-site://sites/analytics/pv24h?range=24h",
    "not a uri",
  ])("rejects %s", (uri) => {
    expect(resourcePath(uri)).toBeUndefined();
  });
});
