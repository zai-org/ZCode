import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLegacyCredentialCipher,
  createSystemCredentialCipher,
  enablePrivateFileKeyFallback,
  prepareServerCredentialStorage,
} from "@zcode/shared/credential-security";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

// 回退开关是进程级的：本文件独立运行（vitest 按文件隔离），模拟开启回退的 Linux Desktop Main。
// 未开启回退时的默认行为（macOS/Windows/Server/独立 CLI）由 credential-security.test.ts 覆盖。
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
let fallbacks = 0;
let enabled = false;
beforeAll(() => {
  enabled = enablePrivateFileKeyFallback({ onFallback: () => fallbacks++ });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-linux-key-fallback-"));
  dirs.push(dir);
  return {
    dir,
    file: join(dir, "credentials.json"),
    secretFile: join(dir, "credential-secret"),
    sourceFile: join(dir, "credential-source"),
  };
}
// 每个注入的 KeyStore 实例有独立密钥缓存，等价于一个新进程。
function unavailableKeyStore() {
  const calls = { get: 0, set: 0 };
  return {
    calls,
    keyStore: {
      get: async (): Promise<string | null> => {
        calls.get++;
        throw new Error("Secret Service is not available");
      },
      set: async () => {
        calls.set++;
        throw new Error("Secret Service is not available");
      },
    },
  };
}
function workingKeyStore() {
  let saved: string | null = null;
  return {
    keyStore: {
      get: async () => saved,
      set: async (value: string) => {
        saved = value;
      },
    },
  };
}
const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code?: string }) => error?.code,
  );

describe("Linux Desktop private file key fallback", () => {
  it("is enabled before the first credential access", () => {
    expect(enabled).toBe(true);
  });

  it("saves a login without Secret Service and reuses the private key without touching the OS store", async () => {
    const fixture = await setup();
    const first = unavailableKeyStore();
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...first }),
    });
    const before = fallbacks;
    await store.save("zcodejwttoken", "linux-login-token");
    expect(fallbacks).toBe(before + 1);
    expect(JSON.parse(await readFile(fixture.file, "utf8")).zcodejwttoken).toMatch(/^enc:v2:env:/);
    expect((await stat(fixture.secretFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(fixture.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(readFile(fixture.sourceFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");

    const next = unavailableKeyStore();
    const reopened = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...next }),
    });
    expect(await reopened.load("zcodejwttoken")).toBe("linux-login-token");
    expect(next.calls).toEqual({ get: 0, set: 0 });
    expect(fallbacks).toBe(before + 1);
  });

  it("migrates a legacy Desktop login after the keyring prompt is dismissed, without re-authorization", async () => {
    const fixture = await setup();
    const legacy = createLegacyCredentialCipher({});
    await writeFile(
      fixture.file,
      JSON.stringify({ zcodejwttoken: legacy.encrypt("legacy-token"), plain: "plain-value" }),
    );
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        ...unavailableKeyStore(),
      }),
    });
    expect(await store.loadMany(["zcodejwttoken", "plain"])).toEqual({
      zcodejwttoken: "legacy-token",
      plain: "plain-value",
    });
    const raw = JSON.parse(await readFile(fixture.file, "utf8"));
    expect(raw.zcodejwttoken).toMatch(/^enc:v2:env:/);
    expect(raw.plain).toMatch(/^enc:v2:env:/);
  });

  it.each([
    [
      "an OS source marker",
      (f: Awaited<ReturnType<typeof setup>>) => writeFile(f.sourceFile, "os\n"),
    ],
    [
      "existing v2:os data",
      (f: Awaited<ReturnType<typeof setup>>) =>
        writeFile(f.file, JSON.stringify({ token: `enc:v2:os:${"a".repeat(24)}:x.y.z` })),
    ],
    [
      "v2:env data whose key file was lost",
      (f: Awaited<ReturnType<typeof setup>>) =>
        writeFile(f.file, JSON.stringify({ token: `enc:v2:env:${"a".repeat(24)}:x.y.z` })),
    ],
  ])("never switches the source of a directory already bound to %s", async (_name, arrange) => {
    const fixture = await setup();
    await arrange(fixture);
    const before = fallbacks;
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      ...unavailableKeyStore(),
    });
    expect(await errorCode(cipher.encrypt("token"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    await expect(stat(fixture.secretFile)).rejects.toHaveProperty("code", "ENOENT");
    expect(fallbacks).toBe(before);
  });

  it("keeps a working Secret Service as the key source", async () => {
    const fixture = await setup();
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      ...workingKeyStore(),
    });
    expect(await cipher.encrypt("token")).toMatch(/^enc:v2:os:/);
    expect(await readFile(fixture.sourceFile, "utf8")).toBe("os\n");
    await expect(stat(fixture.secretFile)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("keeps explicit managed configuration ahead of the OS store and the fallback", async () => {
    const fixture = await setup();
    const unavailable = unavailableKeyStore();
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: { ZCODE_CREDENTIAL_SECRET: "explicit-managed-secret-0123456789" },
      ...unavailable,
    });
    expect(await cipher.encrypt("token")).toMatch(/^enc:v2:env:/);
    await expect(stat(fixture.secretFile)).rejects.toHaveProperty("code", "ENOENT");
    expect(unavailable.calls.get).toBe(0);
  });

  it("converges concurrent first-time fallbacks on one private key", async () => {
    const fixture = await setup();
    const ciphers = Array.from({ length: 6 }, () =>
      createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...unavailableKeyStore() }),
    );
    const values = await Promise.all(ciphers.map((cipher, index) => cipher.encrypt(`v${index}`)));
    expect(new Set(values.map((value) => value.split(":")[3])).size).toBe(1);
    for (const [index, value] of values.entries()) {
      expect(await ciphers[(index + 1) % ciphers.length]!.decrypt(value)).toBe(`v${index}`);
    }
  });

  it("keeps remote preparation idempotent", async () => {
    const fixture = await setup();
    await prepareServerCredentialStorage({ filePath: fixture.file, env: {} });
    const prepared = await readFile(fixture.secretFile, "utf8");
    await prepareServerCredentialStorage({ filePath: fixture.file, env: {} });
    expect(await readFile(fixture.secretFile, "utf8")).toBe(prepared);
    expect((await stat(fixture.secretFile)).mode & 0o777).toBe(0o600);
  });

  it("does not reconfigure after the process already loaded a default key", async () => {
    const fixture = await setup();
    // 非法来源标记让默认 KeyStore 在访问系统库前失败，只登记进程内加载结果。
    await writeFile(fixture.sourceFile, "invalid\n");
    const cipher = createSystemCredentialCipher({ filePath: fixture.file, env: {} });
    expect(await errorCode(cipher.encrypt("token"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(enablePrivateFileKeyFallback()).toBe(false);
  });
});
