import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserStateFileError,
  loadBrowserStorageState,
  resolveDefaultBrowserStatePath,
} from "../src/browser/storage-state.js";

const PLAYWRIGHT_EXPORTED_STATE = {
  cookies: [
    {
      name: "session",
      value: "cookie-value",
      domain: ".example.com",
      path: "/",
      expires: 1795000000.5,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      partitionKey: "https://example.com",
      _crHasCrossSiteAncestor: false,
    },
    {
      name: "pref",
      value: "dark",
      domain: "app.example.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "None",
    },
  ],
  origins: [
    {
      origin: "https://app.example.com",
      localStorage: [
        { name: "token", value: "storage-value" },
        { name: "theme", value: "dark" },
      ],
      indexedDB: [],
    },
  ],
};

const SECRET_COOKIE_VALUE = "secret-cookie-value";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcode-browser-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeState(content: unknown, name = "state.json"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

async function loadError(path: string): Promise<BrowserStateFileError> {
  const error = await loadBrowserStorageState(path).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BrowserStateFileError);
  return error as BrowserStateFileError;
}

function cookieWith(overrides: Record<string, unknown>, omit: string[] = []) {
  const cookie: Record<string, unknown> = {
    ...PLAYWRIGHT_EXPORTED_STATE.cookies[0],
    ...overrides,
  };
  for (const key of omit) delete cookie[key];
  return { cookies: [cookie], origins: [] };
}

describe("browser storage state loader", () => {
  it("loads a Playwright-exported file", async () => {
    const result = await loadBrowserStorageState(await writeState(PLAYWRIGHT_EXPORTED_STATE), {
      nowMs: () => 1_700_000_000_000,
    });

    expect(result.state).toEqual(PLAYWRIGHT_EXPORTED_STATE);
    expect(result.summary).toEqual({ cookieCount: 2, expiredCookieCount: 0, originCount: 1 });
    expect(result.unknownFields).toEqual([]);
  });

  it("counts expired cookies", async () => {
    const path = await writeState(cookieWith({ expires: 1000 }));

    const result = await loadBrowserStorageState(path, { nowMs: () => 2_000_000 });

    expect(result.summary.expiredCookieCount).toBe(1);
  });

  it("strips a UTF-8 BOM", async () => {
    const path = await writeState(`\uFEFF${JSON.stringify(PLAYWRIGHT_EXPORTED_STATE)}`);

    const result = await loadBrowserStorageState(path);

    expect(result.summary.cookieCount).toBe(2);
  });

  it("classifies file errors", async () => {
    expect((await loadError(join(directory, "missing.json"))).code).toBe("missing");

    const regularFile = await writeState("{}", "plain.json");
    expect((await loadError(join(regularFile, "nested.json"))).code).toBe("missing");

    const nestedDirectory = join(directory, "folder");
    await mkdir(nestedDirectory);
    expect((await loadError(nestedDirectory)).code).toBe("not_file");

    expect((await loadError(await writeState("{", "broken.json"))).code).toBe("invalid_json");
  });

  it("reports schema issues by field location", async () => {
    const cases: Array<[unknown, string]> = [
      [cookieWith({ sameSite: "lax" }), "cookies[0].sameSite"],
      [cookieWith({ url: "https://example.com/" }), "cookies[0]"],
      [cookieWith({}, ["domain", "path"]), "cookies[0]"],
      [cookieWith({ expires: 0 }), "cookies[0].expires"],
      [cookieWith({ expires: 253402300800 }), "cookies[0].expires"],
      [cookieWith({ domain: "" }), "cookies[0].domain"],
      [cookieWith({ url: "app.example.com" }, ["domain", "path"]), "cookies[0].url"],
      [cookieWith({ url: "about:blank" }, ["domain", "path"]), "cookies[0].url"],
      [
        { cookies: [], origins: [{ origin: "https://app.example.com/", localStorage: [] }] },
        "origins[0].origin",
      ],
      [
        { cookies: [], origins: [{ origin: "file:///tmp", localStorage: [] }] },
        "origins[0].origin",
      ],
    ];

    for (const [index, [content, issue]] of cases.entries()) {
      const error = await loadError(await writeState(content, `case-${index}.json`));
      expect(error.code).toBe("invalid_schema");
      expect(error.issues).toContain(issue);
    }
  });

  it("never leaks values or the path in error messages", async () => {
    const path = await writeState(cookieWith({ value: SECRET_COOKIE_VALUE, sameSite: "lax" }));

    const error = await loadError(path);

    expect(error.path).toBe(path);
    for (const text of [error.message, String(error)]) {
      expect(text).not.toContain(SECRET_COOKIE_VALUE);
      expect(text).not.toContain(path);
    }
  });

  it("collects unknown fields", async () => {
    const path = await writeState({
      version: 2,
      cookies: [{ ...PLAYWRIGHT_EXPORTED_STATE.cookies[1], sourcePort: 443 }],
      origins: [
        {
          origin: "https://app.example.com",
          localStorage: [{ name: "token", value: "storage-value", extra: true }],
          sessionStorage: [],
        },
      ],
    });

    const result = await loadBrowserStorageState(path);

    expect(result.unknownFields).toEqual([
      "version",
      "cookies[].sourcePort",
      "origins[].sessionStorage",
      "origins[].localStorage[].extra",
    ]);
    expect(result.state).toEqual({
      cookies: [PLAYWRIGHT_EXPORTED_STATE.cookies[1]],
      origins: [
        {
          origin: "https://app.example.com",
          localStorage: [{ name: "token", value: "storage-value" }],
        },
      ],
    });
  });

  it.skipIf(process.platform === "win32")("reports loose POSIX permissions", async () => {
    const path = await writeState(PLAYWRIGHT_EXPORTED_STATE);

    await chmod(path, 0o644);
    expect((await loadBrowserStorageState(path)).looseMode).toBe(0o644);

    await chmod(path, 0o600);
    expect((await loadBrowserStorageState(path)).looseMode).toBeUndefined();
  });

  it("skips the permission check on win32", async () => {
    const path = await writeState(PLAYWRIGHT_EXPORTED_STATE);
    await chmod(path, 0o644);

    const result = await loadBrowserStorageState(path, { platform: "win32" });

    expect(result.looseMode).toBeUndefined();
  });

  it("resolves the default path like os.homedir on each platform", () => {
    const env = { HOME: "/Users/dev", USERPROFILE: "C:\\Users\\dev" };
    expect(resolveDefaultBrowserStatePath(env, "darwin")).toBe(
      join("/Users/dev", ".zcode", "cli", "browser-state.json"),
    );
    expect(resolveDefaultBrowserStatePath(env, "win32")).toBe(
      join("C:\\Users\\dev", ".zcode", "cli", "browser-state.json"),
    );
    expect(resolveDefaultBrowserStatePath({}, "linux")).toBe(
      join(homedir(), ".zcode", "cli", "browser-state.json"),
    );
  });
});
