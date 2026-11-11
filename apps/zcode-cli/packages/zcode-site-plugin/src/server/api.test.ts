import { OFFICIAL_MCP_AUTH_META_KEY as SHARED_KEY } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSitesApi,
  OFFICIAL_MCP_AUTH_META_KEY,
  readOfficialAuth,
} from "./api.ts";

const ORIGIN = "https://zcode.example.com";
const headers = { Authorization: "Bearer jwt" };
const authed = { [OFFICIAL_MCP_AUTH_META_KEY]: { ok: true, headers } };

function api(response: () => Response | Promise<Response>) {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => response(),
  );
  return {
    fetch,
    call: createSitesApi({
      origin: ORIGIN,
      appVersion: "3.16.2",
      fetch: fetch as never,
      timeoutMs: 1000,
    }),
  };
}

const envelope = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("official auth meta", () => {
  it("uses the same protocol key as the host", () => {
    expect(OFFICIAL_MCP_AUTH_META_KEY).toBe(SHARED_KEY);
  });

  it("passes the host's failure reason through and treats anything else as unavailable", () => {
    expect(readOfficialAuth(undefined)).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    expect(
      readOfficialAuth({
        [OFFICIAL_MCP_AUTH_META_KEY]: {
          ok: false,
          reason: "official_auth_plan_required",
        },
      }),
    ).toEqual({ ok: false, reason: "official_auth_plan_required" });
    expect(
      readOfficialAuth({
        [OFFICIAL_MCP_AUTH_META_KEY]: { ok: false, reason: "weird" },
      }),
    ).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    expect(
      readOfficialAuth({
        [OFFICIAL_MCP_AUTH_META_KEY]: { ok: true, headers: {} },
      }),
    ).toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
  });
});

describe("createSitesApi", () => {
  it("sends the identity headers and app version and returns data", async () => {
    const { fetch, call } = api(() =>
      envelope({ code: 0, msg: "", data: { id: "1" }, logid: "l" }),
    );
    await expect(
      call(authed, "PATCH", "/api/v1/sites/1", { name: "a" }),
    ).resolves.toEqual({
      data: { id: "1" },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/v1/sites/1`);
    expect(init).toMatchObject({
      method: "PATCH",
      body: '{"name":"a"}',
      redirect: "manual",
      headers: {
        ...headers,
        "X-ZCode-App-Version": "3.16.2",
        "Content-Type": "application/json",
      },
    });
  });

  it("returns null data when a DELETE succeeds without a body field", async () => {
    const { fetch, call } = api(() =>
      envelope({ code: 0, msg: "", logid: "l" }),
    );
    await expect(call(authed, "DELETE", "/api/v1/sites/1")).resolves.toEqual({
      data: null,
    });
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({ method: "DELETE" });
    expect(init).not.toHaveProperty("body");
  });

  it("does not send anything without identity headers", async () => {
    const { fetch, call } = api(() => envelope({ code: 0 }));
    await expect(call({}, "GET", "/api/v1/sites")).resolves.toEqual({
      error: { reason: "official_auth_unavailable" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps business errors, 401, bad bodies and network failures", async () => {
    await expect(
      api(() =>
        envelope(
          { code: 3601, msg: "not found", data: null, logid: "abc" },
          404,
        ),
      ).call(authed, "GET", "/x"),
    ).resolves.toEqual({ error: { code: 3601, logid: "abc" } });
    await expect(
      api(() => new Response(null, { status: 401 })).call(authed, "GET", "/x"),
    ).resolves.toEqual({
      error: { reason: "unauthenticated" },
    });
    await expect(
      api(() => new Response("<html>", { status: 502 })).call(
        authed,
        "GET",
        "/x",
      ),
    ).resolves.toEqual({
      error: { reason: "bad_response" },
    });
    await expect(
      api(() => new Response(null, { status: 302 })).call(authed, "GET", "/x"),
    ).resolves.toEqual({
      error: { reason: "bad_response" },
    });
    await expect(
      api(() => {
        throw new TypeError("fetch failed");
      }).call(authed, "GET", "/x"),
    ).resolves.toEqual({ error: { reason: "network" } });
  });
});
