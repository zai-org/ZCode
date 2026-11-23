import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLegacyCredentialCipher,
  createSystemCredentialCipher,
  enablePrivateFileKeyFallback,
  prepareServerCredentialStorage,
  type CredentialKeyStore,
  type CredentialStoreResetEvent,
} from "@zcode/shared/credential-security";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

// 回退开关是进程级的：本文件独立运行（vitest 按文件隔离），模拟开启回退的 Desktop Main
// （macOS、Windows、Linux 相同）。未开启时的默认行为（Server/独立 CLI）由
// credential-security.test.ts 覆盖。
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
let fallbacks = 0;
let lastFallbackReason: unknown;
let enabled = false;
const resets: CredentialStoreResetEvent[] = [];
const resetWaiters: Array<(event: CredentialStoreResetEvent) => void> = [];
beforeAll(() => {
  enabled = enablePrivateFileKeyFallback({
    onFallback: (diagnostic) => {
      fallbacks++;
      lastFallbackReason = diagnostic;
    },
    onReset: (event) => {
      resets.push(event);
      resetWaiters.shift()?.(event);
    },
  });
});
// 自动重置在后台执行；测试按通知顺序等待，不用定时器猜测完成时机。
function nextReset(): Promise<CredentialStoreResetEvent> {
  return new Promise((resolve) => resetWaiters.push(resolve));
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-desktop-key-fallback-"));
  dirs.push(dir);
  return {
    dir,
    file: join(dir, "credentials.json"),
    secretFile: join(dir, "credential-secret"),
    sourceFile: join(dir, "credential-source"),
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
// 每个注入的 KeyStore 实例有独立密钥缓存，等价于一个新进程。
function unavailableKeyStore(error: unknown = new Error("Secret Service is not available")) {
  const calls = { get: 0, set: 0 };
  return {
    calls,
    keyStore: {
      get: async (): Promise<string | null> => {
        calls.get++;
        throw error;
      },
      set: async () => {
        calls.set++;
        throw error;
      },
    } satisfies CredentialKeyStore,
  };
}
function workingKeyStore(initial: string | null = null) {
  let saved = initial;
  return {
    keyStore: {
      get: async () => saved,
      set: async (value: string) => {
        saved = value;
      },
    } satisfies CredentialKeyStore,
  };
}
// 同一系统库条目被多个“进程”共用：每次 process() 返回新的 KeyStore 实例（独立密钥缓存）。
function sharedKeychain() {
  let saved: string | null = null;
  return {
    remove: () => {
      saved = null;
    },
    process: (): CredentialKeyStore => ({
      get: async () => saved,
      set: async (value: string) => {
        saved = value;
      },
    }),
  };
}
const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code?: string }) => error?.code,
  );
const OS_VALUE = `enc:v2:os:${"a".repeat(24)}:x.y.z`;
const ENV_VALUE = `enc:v2:env:${"b".repeat(24)}:x.y.z`;
async function backups(fixture: Fixture, prefix: string) {
  return (await readdir(fixture.dir)).filter((name) => name.startsWith(prefix));
}

describe("Desktop private file key fallback", () => {
  it("is enabled before the first credential access", () => {
    expect(enabled).toBe(true);
  });

  it("saves a login without the OS store and reuses the private key without touching it", async () => {
    const fixture = await setup();
    const first = unavailableKeyStore();
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...first }),
    });
    const before = fallbacks;
    await store.save("zcodejwttoken", "fallback-login-token");
    expect(fallbacks).toBe(before + 1);
    // 回退时带上系统库失败的阶段，便于排查；不含原生错误正文。
    expect(lastFallbackReason).toEqual({ stage: "read" });
    expect(JSON.parse(await readFile(fixture.file, "utf8")).zcodejwttoken).toMatch(/^enc:v2:env:/);
    // 修复原因：本文件由 Linux 专用扩展为全平台后，0600 断言在 Windows 上恒失败（stat 报 0666）。
    // Windows 没有 POSIX 权限位，私有文件依赖用户目录的 NTFS ACL（见凭据存储 spec），与同目录
    // credential-security.test.ts 一致，只在非 Windows 上断言权限。
    if (process.platform !== "win32")
      expect((await stat(fixture.secretFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(fixture.dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(readFile(fixture.sourceFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");

    const next = unavailableKeyStore();
    const reopened = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...next }),
    });
    expect(await reopened.load("zcodejwttoken")).toBe("fallback-login-token");
    expect(next.calls).toEqual({ get: 0, set: 0 });
    expect(fallbacks).toBe(before + 1);
  });

  it("migrates a legacy Desktop login after the OS prompt is dismissed, without re-authorization", async () => {
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

  it("keeps a working OS store as the key source", async () => {
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
    // Windows 没有 POSIX 权限位（原因同上），只在非 Windows 上断言 0600。
    if (process.platform !== "win32")
      expect((await stat(fixture.secretFile)).mode & 0o777).toBe(0o600);
  });
});

describe("Desktop automatic reset of a bound credential store", () => {
  it.each([
    [
      "an OS source marker",
      "read",
      async (f: Fixture) => {
        await writeFile(f.sourceFile, "os\n");
        await writeFile(f.file, JSON.stringify({ token: OS_VALUE }));
      },
      () => unavailableKeyStore(),
    ],
    [
      "v2:os data written before the marker existed",
      "read",
      (f: Fixture) => writeFile(f.file, JSON.stringify({ token: OS_VALUE })),
      () => unavailableKeyStore(),
    ],
    [
      "v2:env data whose key file was lost",
      "managed",
      (f: Fixture) => writeFile(f.file, JSON.stringify({ token: ENV_VALUE })),
      () => unavailableKeyStore(),
    ],
  ])(
    "resets a store bound to %s after the failed request, then falls back on the next login",
    async (_name, stage, arrange, keyStoreOf) => {
      const fixture = await setup();
      await arrange(fixture);
      const original = await readFile(fixture.file);
      const generationBefore = await readFile(`${fixture.file}.recovery-generation`, "utf8").catch(
        () => "",
      );
      const cipher = createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        ...keyStoreOf(),
      });
      const reset = nextReset();
      // 失败的请求本身不切换来源：它可能来自正持有凭据文件锁的 Host。
      expect(await errorCode(cipher.encrypt("token"))).toBe(
        "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
      );
      const event = await reset;
      expect(event).toMatchObject({ status: "reset", diagnostic: { stage }, clearedEntries: 1 });
      expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual({});
      // 备份逐字节保留旧密文，永久保留供以后恢复。
      const [backup] = await backups(fixture, "credentials.json.key-unavailable-");
      expect(backup).toBeDefined();
      expect(event.status === "reset" && event.backupPath).toBe(join(fixture.dir, backup!));
      expect((await readFile(join(fixture.dir, backup!))).equals(original)).toBe(true);
      await expect(readFile(fixture.sourceFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");
      // 推进恢复代次，使跨进程旧读写作废。
      expect(await readFile(`${fixture.file}.recovery-generation`, "utf8")).not.toBe(
        generationBefore,
      );

      // 同一进程无需重启：失败缓存已清除，重新登录走回退并只清空一次。
      const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
      await store.save("zcodejwttoken", "after-reset");
      expect(JSON.parse(await readFile(fixture.file, "utf8")).zcodejwttoken).toMatch(
        /^enc:v2:env:/,
      );
      const reopened = createSharedZCodeCredentialStore({
        filePath: fixture.file,
        cipher: createSystemCredentialCipher({
          filePath: fixture.file,
          env: {},
          ...unavailableKeyStore(),
        }),
      });
      expect(await reopened.load("zcodejwttoken")).toBe("after-reset");
      expect(await backups(fixture, "credentials.json.key-unavailable-")).toHaveLength(1);
    },
  );

  it.each([
    ["missing", null],
    ["invalid", "not-a-valid-key"],
  ])(
    "resets when the OS entry is %s and re-creates an OS key when the store works",
    async (stage, entry) => {
      const fixture = await setup();
      await writeFile(fixture.sourceFile, "os\n");
      await writeFile(fixture.file, JSON.stringify({ token: OS_VALUE }));
      const working = workingKeyStore(entry);
      const cipher = createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...working });
      const reset = nextReset();
      expect(await errorCode(cipher.decrypt(OS_VALUE))).toBe(
        "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
      );
      expect(await reset).toMatchObject({ status: "reset", diagnostic: { stage } });
      if (stage === "missing") {
        // 来源重新解析，不固定为文件：系统库可用时重建系统密钥。
        expect(await cipher.encrypt("token")).toMatch(/^enc:v2:os:/);
        expect(await readFile(fixture.sourceFile, "utf8")).toBe("os\n");
      } else {
        // 旧条目不删除；仍不合法时回退到私有文件。
        expect(await cipher.encrypt("token")).toMatch(/^enc:v2:env:/);
      }
    },
  );

  it("moves an invalid private key file aside so the reset does not loop", async () => {
    const fixture = await setup();
    await writeFile(fixture.file, JSON.stringify({ token: ENV_VALUE }));
    // 32–4096 字节以外的文件在所有平台都无效（Windows 不检查权限位）。
    await writeFile(fixture.secretFile, "short", { mode: 0o600 });
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      ...unavailableKeyStore(),
    });
    const reset = nextReset();
    expect(await errorCode(cipher.encrypt("token"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    const event = await reset;
    expect(event).toMatchObject({ status: "reset", diagnostic: { stage: "managed" } });
    const [moved] = await backups(fixture, "credential-secret.invalid-");
    expect(await readFile(join(fixture.dir, moved!), "utf8")).toBe("short");
    expect(await cipher.encrypt("token")).toMatch(/^enc:v2:env:/);
    expect(await readFile(fixture.secretFile, "utf8")).not.toBe("short");
  });

  it("only moves an invalid private key file when no data depends on it", async () => {
    const fixture = await setup();
    await writeFile(fixture.file, JSON.stringify({ plain: "plain-value" }));
    await writeFile(fixture.secretFile, "short", { mode: 0o600 });
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        ...unavailableKeyStore(),
      }),
    });
    const reset = nextReset();
    expect(await errorCode(store.load("plain"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(await reset).toMatchObject({ status: "reset", clearedEntries: 0 });
    expect(await backups(fixture, "credentials.json.key-unavailable-")).toEqual([]);
    expect(await store.load("plain")).toBe("plain-value");
  });

  it("resets once when several processes fail on the same store", async () => {
    const fixture = await setup();
    await writeFile(fixture.sourceFile, "os\n");
    await writeFile(fixture.file, JSON.stringify({ token: OS_VALUE }));
    const ciphers = Array.from({ length: 3 }, () =>
      createSystemCredentialCipher({ filePath: fixture.file, env: {}, ...unavailableKeyStore() }),
    );
    const events = Array.from({ length: 3 }, () => nextReset());
    // 同时发起：三个“进程”都在重置前失败；先完成的重置解除绑定后，其余复核不再满足而放弃。
    const codes = await Promise.all(ciphers.map((cipher) => errorCode(cipher.encrypt("token"))));
    expect(codes).toEqual(Array(3).fill("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"));
    const statuses = (await Promise.all(events)).map((event) => event.status).sort();
    expect(statuses).toEqual(["reset", "skipped", "skipped"]);
    expect(await backups(fixture, "credentials.json.key-unavailable-")).toHaveLength(1);
  });

  it.each([
    [
      "the native module failed to load",
      // 与 systemKeyStore 加载原生模块失败时抛出的受控错误形态一致。
      Object.assign(new Error("load failed"), {
        code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
        diagnostic: { stage: "load" },
      }),
      async (f: Fixture) => {
        await writeFile(f.sourceFile, "os\n");
        await writeFile(f.file, JSON.stringify({ token: OS_VALUE }));
      },
    ],
    [
      "the source marker is invalid",
      new Error("unused"),
      async (f: Fixture) => {
        await writeFile(f.sourceFile, "invalid\n");
        await writeFile(f.file, JSON.stringify({ token: OS_VALUE }));
      },
    ],
  ])("keeps the store when %s", async (_name, error, arrange) => {
    const fixture = await setup();
    await arrange(fixture);
    const original = await readFile(fixture.file);
    const before = resets.length;
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      ...unavailableKeyStore(error),
    });
    expect(await errorCode(cipher.encrypt("token"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    // 不触发的失败不会调度重置；再发一次请求命中同一缓存，确认文件保持原样。
    expect(await errorCode(cipher.encrypt("token"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(resets.length).toBe(before);
    expect((await readFile(fixture.file)).equals(original)).toBe(true);
    expect(await backups(fixture, "credentials.json.key-unavailable-")).toEqual([]);
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

describe("new OS ciphertext requires an OS source marker", () => {
  it("rejects a stale cached OS key writing after the store was reset", async () => {
    const fixture = await setup();
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        ...workingKeyStore(),
      }),
    });
    await store.save("first", "value");
    // 模拟另一进程的自动重置：清空库并解除绑定；本进程仍缓存着系统密钥。
    await writeFile(fixture.file, "{}\n");
    await rm(fixture.sourceFile);
    expect(await errorCode(store.save("second", "value"))).toBe(
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(await readFile(fixture.file, "utf8")).toBe("{}\n");
  });

  // 评审复现：missing 重置后 Desktop 重新登录建立新系统密钥并再次固定 os，旧进程仍用缓存的
  // 旧密钥写入，标记检查放行，保存成功但冷启动无法解密（会覆盖刚保存的新登录）。
  it("switches a process with a stale cached OS key to the re-created key after a reset", async () => {
    const fixture = await setup();
    const keychain = sharedKeychain();
    const storeOf = () =>
      createSharedZCodeCredentialStore({
        filePath: fixture.file,
        cipher: createSystemCredentialCipher({
          filePath: fixture.file,
          env: {},
          keyStore: keychain.process(),
        }),
      });
    const stale = storeOf();
    await stale.save("old", "old-value");
    keychain.remove();
    const desktop = storeOf();
    const reset = nextReset();
    expect(await errorCode(desktop.load("old"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(await reset).toMatchObject({ status: "reset", diagnostic: { stage: "missing" } });
    await desktop.save("new", "desktop-login");
    await stale.save("new", "stale-overwrite");
    await stale.save("later", "stale-later");
    expect(await storeOf().loadMany(["new", "later"])).toEqual({
      new: "stale-overwrite",
      later: "stale-later",
    });
  });

  // 评审复现（Host 经凭据桥由 Main 加密）：加密在自动重置前完成、写盘在重置后，旧密钥密文
  // 覆盖新登录且返回成功。写入方须在加密前领取代次，由锁内代次屏障拒绝这次写入。
  it("rejects a save whose ciphertext was produced before a reset", async () => {
    const fixture = await setup();
    const keychain = sharedKeychain();
    const owner = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: keychain.process(),
    });
    // 模拟凭据桥：密钥 owner 完成加密，回复可延迟交付给写入方。
    let holdNextReply = false;
    let replyHeld!: () => void;
    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (replyHeld = resolve));
    const delivered = new Promise<void>((resolve) => (deliver = resolve));
    const bridged = {
      ...owner,
      async encrypt(value: string) {
        const encrypted = await owner.encrypt(value);
        if (holdNextReply) {
          holdNextReply = false;
          replyHeld();
          await delivered;
        }
        return encrypted;
      },
    };
    const writer = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher: bridged });
    await writer.save("old", "old-value");
    holdNextReply = true;
    const stale = errorCode(writer.save("new", "stale-value"));
    await held;
    keychain.remove();
    const desktop = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        keyStore: keychain.process(),
      }),
    });
    const reset = nextReset();
    expect(await errorCode(desktop.load("old"))).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(await reset).toMatchObject({ status: "reset", diagnostic: { stage: "missing" } });
    await desktop.save("new", "desktop-login");
    deliver();
    expect(await stale).toBe("ZCODE_CREDENTIAL_STORE_CHANGED");
    expect(await desktop.load("new")).toBe("desktop-login");
    // 重试换用当前密钥。
    await writer.save("new", "retried-value");
    expect(await desktop.load("new")).toBe("retried-value");
  });

  it("keeps existing OS ciphertext without a marker when another writer rewrites the record", async () => {
    const fixture = await setup();
    await writeFile(fixture.file, JSON.stringify({ legacy: OS_VALUE }));
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: { ZCODE_CREDENTIAL_SECRET: "explicit-managed-secret-0123456789" },
      }),
    });
    await store.save("server", "value");
    const raw = JSON.parse(await readFile(fixture.file, "utf8"));
    expect(raw.legacy).toBe(OS_VALUE);
    expect(raw.server).toMatch(/^enc:v2:env:/);
  });

  it("allows env ciphertext in a store pinned to the OS source", async () => {
    const fixture = await setup();
    await writeFile(fixture.sourceFile, "os\n");
    const store = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: { ZCODE_CREDENTIAL_SECRET: "explicit-managed-secret-0123456789" },
      }),
    });
    await store.save("server", "value");
    expect(await store.load("server")).toBe("value");
  });
});
