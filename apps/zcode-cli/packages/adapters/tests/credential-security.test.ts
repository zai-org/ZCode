import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSystemCredentialCipher,
  createServerCredentialCipher,
  createLegacyServerCredentialCipher,
  prepareServerCredentialStorage,
  createLegacyCredentialCipher,
  migrateCredentialRecord,
} from "@zcode/shared/credential-security";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-secure-credentials-"));
  dirs.push(dir);
  const file = join(dir, "credentials.json");
  let saved: string | null = null;
  let writes = 0;
  const keyStore = {
    get: async () => saved,
    set: async (key: string) => {
      writes++;
      saved = key;
    },
  };
  return {
    file,
    keyStore,
    writes: () => writes,
    forget: () => {
      saved = null;
    },
  };
}

describe("system credential security", () => {
  it.each([false, true])(
    "preserves the historical file key throughout legacy owner handoff (explicit=%s)",
    async (explicit) => {
      const fixture = await setup();
      const secret = " historical-file-secret-0123456789 \n";
      const path = explicit ? fixture.file + ".key" : join(fixture.file, "..", "credential-secret");
      await writeFile(path, secret, { mode: 0o600 });
      const old = createLegacyCredentialCipher({ ZCODE_CREDENTIAL_SECRET: secret });
      await writeFile(fixture.file, JSON.stringify({ token: old.encrypt("old-file-identity") }));
      const env = explicit ? { ZCODE_CREDENTIAL_SECRET_FILE: path } : {};
      const cipher = await createLegacyServerCredentialCipher({ filePath: fixture.file, env });
      const candidate = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
      expect(await candidate.load("token")).toBe("old-file-identity");
      await candidate.save("token", "still-readable-by-old-owner");
      expect(old.decrypt(JSON.parse(await readFile(fixture.file, "utf8")).token)).toBe(
        "still-readable-by-old-owner",
      );
      const current = createSharedZCodeCredentialStore({
        filePath: fixture.file,
        cipher: await createServerCredentialCipher({ filePath: fixture.file, env }),
      });
      expect(await current.load("token")).toBe("still-readable-by-old-owner");
      expect(JSON.parse(await readFile(fixture.file, "utf8")).token).toMatch(/^enc:v2:env:/);
      await expect(
        createLegacyServerCredentialCipher({
          filePath: fixture.file,
          env: { ZCODE_CREDENTIAL_SECRET: secret, ZCODE_CREDENTIAL_SECRET_FILE: path },
        }),
      ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    },
  );
  it("keeps a candidate Core readable by its legacy Supervisor until the runtime handoff", async () => {
    const fixture = await setup();
    const options = { filePath: fixture.file, env: {} };
    const legacy = createLegacyCredentialCipher({});
    await writeFile(fixture.file, JSON.stringify({ token: legacy.encrypt("before-update") }));
    await prepareServerCredentialStorage(options);
    const cipher = await createLegacyServerCredentialCipher(options);
    const candidate = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
    expect(await candidate.load("token")).toBe("before-update");
    await candidate.save("token", "candidate-update");
    expect(legacy.decrypt(JSON.parse(await readFile(fixture.file, "utf8")).token)).toBe(
      "candidate-update",
    );
    const modern = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: await createServerCredentialCipher(options),
    });
    expect(await modern.load("token")).toBe("candidate-update");
    const retained = await readFile(fixture.file, "utf8");
    await expect(createLegacyServerCredentialCipher(options)).rejects.toHaveProperty(
      "code",
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(await readFile(fixture.file, "utf8")).toBe(retained);
  });
  it("keeps the OS source when preparation races after initialization but before the first write", async () => {
    const fixture = await setup();
    const options = { filePath: fixture.file, env: {}, keyStore: fixture.keyStore };
    const first = await createServerCredentialCipher(options);
    await prepareServerCredentialStorage(options);
    await expect(stat(join(fixture.file, "..", "credential-secret"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    // 另一程序迟到放入文件时，也不能改变已经固定的 OS 来源。
    await writeFile(join(fixture.file, "..", "credential-secret"), "x".repeat(40), { mode: 0o600 });
    const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher: first });
    await store.save("token", "os-before-first-write");
    const reopened = await createServerCredentialCipher({
      ...options,
      keyStore: { ...fixture.keyStore },
    });
    expect(
      await createSharedZCodeCredentialStore({ filePath: fixture.file, cipher: reopened }).load(
        "token",
      ),
    ).toBe("os-before-first-write");
    expect(await readFile(join(fixture.file, "..", "credential-source"), "utf8")).toBe("os\n");
  });
  it("lets an independent CLI discover the same private Server key without configuring env", async () => {
    const fixture = await setup();
    await prepareServerCredentialStorage({ filePath: fixture.file, env: {} });
    const cipher = await createServerCredentialCipher({ filePath: fixture.file, env: {} });
    await createSharedZCodeCredentialStore({ filePath: fixture.file, cipher }).save(
      "token",
      "shared-remote-value",
    );
    const cli = createSharedZCodeCredentialStore({ filePath: fixture.file, env: {} });
    expect(await cli.load("token")).toBe("shared-remote-value");
    // 新 KeyStore 模拟冷进程，不能复用 Server 的进程内缓存来掩盖默认文件发现缺口。
    let systemReads = 0;
    const cold = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: createSystemCredentialCipher({
        filePath: fixture.file,
        env: {},
        keyStore: {
          get: async () => {
            systemReads++;
            throw new Error("Secret Service unavailable");
          },
          set: async () => {
            throw new Error("Secret Service unavailable");
          },
        },
      }),
    });
    expect(await cold.load("token")).toBe("shared-remote-value");
    expect(systemReads).toBe(0);
    await cli.save("token", "cli-updated-value");
    expect(
      await createSharedZCodeCredentialStore({ filePath: fixture.file, cipher }).load("token"),
    ).toBe("cli-updated-value");
  });
  it("prepares one private remote key concurrently and migrates fallback v1 without losing identity", async () => {
    const fixture = await setup();
    const legacy = createLegacyCredentialCipher({});
    const original = { zcodejwttoken: "old-token", "oauth:session_revision": "old-revision" };
    await writeFile(
      fixture.file,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(original).map(([key, value]) => [key, legacy.encrypt(value)]),
        ),
      ),
    );
    const options = { filePath: fixture.file, env: {} };
    await Promise.all(Array.from({ length: 8 }, () => prepareServerCredentialStorage(options)));
    const secretPath = join(fixture.file, "..", "credential-secret");
    const secret = await readFile(secretPath, "utf8");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    const keyStore = {
      get: async () => {
        throw new Error("no Secret Service");
      },
      set: async () => {
        throw new Error("must not write");
      },
    };
    const cipher = await createServerCredentialCipher({ ...options, keyStore });
    const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
    for (const [key, value] of Object.entries(original)) expect(await store.load(key)).toBe(value);
    const migrated = JSON.parse(await readFile(fixture.file, "utf8"));
    expect(Object.values(migrated).every((value) => String(value).startsWith("enc:v2:env:"))).toBe(
      true,
    );
    await prepareServerCredentialStorage(options);
    expect(await readFile(secretPath, "utf8")).toBe(secret);
    const reopened = createSharedZCodeCredentialStore({
      filePath: fixture.file,
      cipher: await createServerCredentialCipher({ ...options, keyStore }),
    });
    expect(await reopened.load("zcodejwttoken")).toBe(original.zcodejwttoken);
    expect(await readdir(join(fixture.file, ".."))).toEqual(
      expect.arrayContaining(["credentials.json", "credential-secret"]),
    );
    expect((await readdir(join(fixture.file, ".."))).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
  it("preserves existing keys, explicit configuration and v2 data when preparing a remote", async () => {
    const fixture = await setup();
    const secretPath = join(fixture.file, "..", "credential-secret");
    const options = { filePath: fixture.file, env: {} };
    await writeFile(secretPath, "existing-key-bytes\n", { mode: 0o600 });
    await prepareServerCredentialStorage(options);
    expect(await readFile(secretPath, "utf8")).toBe("existing-key-bytes\n");
    await rm(secretPath);
    for (const env of [
      { ZCODE_CREDENTIAL_SECRET: "explicit" },
      { ZCODE_CREDENTIAL_SECRET_FILE: secretPath },
    ]) {
      await prepareServerCredentialStorage({ ...options, env });
      await expect(stat(secretPath)).rejects.toHaveProperty("code", "ENOENT");
    }
    for (const source of ["os", "env"]) {
      const data = JSON.stringify({ token: `enc:v2:${source}:retained` });
      await writeFile(fixture.file, data);
      await prepareServerCredentialStorage(options);
      expect(await readFile(fixture.file, "utf8")).toBe(data);
      await expect(stat(secretPath)).rejects.toHaveProperty("code", "ENOENT");
    }
  });
  it("opens an administrator-created Server key without relying on a login shell", async () => {
    const fixture = await setup();
    const path = join(fixture.file, "..", "credential-secret");
    await writeFile(path, "s".repeat(40), { mode: 0o600 });
    const keyStore = {
      get: async (): Promise<string | null> => {
        throw new Error("no Secret Service");
      },
      set: async () => {
        throw new Error("unexpected system write");
      },
    };
    const first = await createServerCredentialCipher({ filePath: fixture.file, env: {}, keyStore });
    const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher: first });
    await store.updateMany({ "oauth:session_revision": "server-session", token: "server-token" });
    const second = await createServerCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore,
    });
    expect(
      await createSharedZCodeCredentialStore({ filePath: fixture.file, cipher: second }).load(
        "token",
      ),
    ).toBe("server-token");
  });
  it("gives actionable Server guidance without creating a file key or masking explicit configuration", async () => {
    const fixture = await setup();
    const keyStore = {
      get: async (): Promise<string | null> => {
        throw new Error("no Secret Service");
      },
      set: async () => {
        throw new Error("unexpected write");
      },
    };
    await expect(
      createServerCredentialCipher({ filePath: fixture.file, env: {}, keyStore }),
    ).rejects.toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
      message: expect.stringContaining("credential-secret"),
    });
    await expect(readFile(join(fixture.file, "..", "credential-secret"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await writeFile(join(fixture.file, "..", "credential-secret"), "s".repeat(40), { mode: 0o600 });
    await expect(
      createServerCredentialCipher({
        filePath: fixture.file,
        env: { ZCODE_CREDENTIAL_SECRET_FILE: fixture.file + ".missing" },
        keyStore,
      }),
    ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    if (process.platform !== "win32") {
      await chmod(join(fixture.file, "..", "credential-secret"), 0o644);
      await expect(
        createServerCredentialCipher({ filePath: fixture.file, env: {}, keyStore }),
      ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    }
  });
  it("preserves both Desktop and CLI v1 whitespace key rules during migration", async () => {
    for (const secret of ["ordinary-key", " padded-key ", "   "]) {
      for (const source of ["desktop", "cli"]) {
        const fixture = await setup();
        const old = createLegacyCredentialCipher({
          ZCODE_CREDENTIAL_SECRET: source === "cli" ? secret.trim() : secret,
        });
        await writeFile(fixture.file, JSON.stringify({ token: old.encrypt("legacy-value") }));
        const env = { ZCODE_CREDENTIAL_SECRET: secret };
        const store = createSharedZCodeCredentialStore({ filePath: fixture.file, env });
        expect(await store.load("token"), `${source}/${secret.length}`).toBe("legacy-value");
        expect(JSON.parse(await readFile(fixture.file, "utf8")).token).toMatch(/^enc:v2:env:/);
        expect(
          await createSharedZCodeCredentialStore({ filePath: fixture.file, env }).load("token"),
        ).toBe("legacy-value");
      }
    }
  });
  it("uses an explicit managed secret file without a system store and survives reopening", async () => {
    const fixture = await setup();
    const secretPath = fixture.file + ".secret";
    await writeFile(secretPath, "a".repeat(32) + "\n", { mode: 0o600 });
    const env = { ZCODE_CREDENTIAL_SECRET_FILE: secretPath };
    const cipher = createSystemCredentialCipher({ filePath: fixture.file, env });
    await cipher.initialize();
    const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
    await store.updateMany({
      "oauth:session_revision": "headless-revision",
      token: "headless-value",
    });
    expect(
      await createSharedZCodeCredentialStore({ filePath: fixture.file, env }).load("token"),
    ).toBe("headless-value");
    expect(JSON.parse(await readFile(fixture.file, "utf8")).token).toMatch(/^enc:v2:env:/);
  });
  it("rejects missing, short or ambiguous managed secret configuration before startup", async () => {
    const fixture = await setup();
    const secretPath = fixture.file + ".secret";
    for (const env of [
      { ZCODE_CREDENTIAL_SECRET_FILE: secretPath },
      { ZCODE_CREDENTIAL_SECRET_FILE: secretPath, ZCODE_CREDENTIAL_SECRET: "another" },
    ]) {
      await expect(
        createSystemCredentialCipher({ filePath: fixture.file, env }).initialize(),
      ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    }
    await writeFile(secretPath, "short");
    await expect(
      createSystemCredentialCipher({
        filePath: fixture.file,
        env: { ZCODE_CREDENTIAL_SECRET_FILE: secretPath },
      }).initialize(),
    ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
  });
  it("uses one system key for concurrent factories, supports empty values, and never persists the key", async () => {
    const fixture = await setup();
    const a = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: fixture.keyStore,
    });
    const b = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: fixture.keyStore,
    });
    const [first, second] = await Promise.all([a.encrypt("secret-a"), b.encrypt("")]);
    expect(first).toMatch(/^enc:v2:os:/);
    expect(await b.decrypt(first)).toBe("secret-a");
    expect(await a.decrypt(second)).toBe("");
    expect(fixture.writes()).toBe(1);
    await expect(readFile(fixture.file, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });
  it("does not recreate a missing system key or accept corruption as plaintext", async () => {
    const fixture = await setup();
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: fixture.keyStore,
    });
    const encrypted = await cipher.encrypt("token");
    fixture.forget();
    // 用新的注入适配器模拟重启；同一进程的既有适配器会继续复用已解锁密钥。
    const reopened = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: { ...fixture.keyStore },
    });
    await expect(reopened.decrypt(encrypted)).rejects.toHaveProperty(
      "code",
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(fixture.writes()).toBe(1);
    await expect(reopened.decrypt("enc:v9:broken")).rejects.toHaveProperty(
      "code",
      "ZCODE_CREDENTIAL_DECRYPT_FAILED",
    );
  });
  it("preserves records when the system key store is locked and does not treat it as a logout", async () => {
    const fixture = await setup();
    const keyStore = {
      get: async (): Promise<string | null> => {
        throw new Error("locked");
      },
      set: async () => {
        throw new Error("must not write");
      },
    };
    const cipher = createSystemCredentialCipher({ filePath: fixture.file, env: {}, keyStore });
    const raw = { zcodejwttoken: "legacy-token" };
    await writeFile(fixture.file, JSON.stringify(raw));
    await expect(migrateCredentialRecord(raw, cipher)).rejects.toHaveProperty(
      "code",
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual(raw);
  });
  it("retries the system key after another process held the keyring lock past the wait limit", async () => {
    const fixture = await setup();
    let reads = 0;
    const keyStore = {
      get: async () => {
        reads++;
        return Buffer.alloc(32, 7).toString("base64url");
      },
      set: async () => {
        throw new Error("must not write");
      },
    };
    // 另一存活进程持锁等待系统授权；同进程持锁只会在进程内排队，不会触发等待超时。
    const lock = `${fixture.file}.keyring.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, `owner-${process.pid}-foreign.json`),
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: `${process.pid}-foreign` })}\n`,
    );
    const cipher = createSystemCredentialCipher({ filePath: fixture.file, env: {}, keyStore });
    await expect(cipher.encrypt("token")).rejects.toHaveProperty("code", "ZCODE_FILE_LOCK_TIMEOUT");
    expect(reads).toBe(0);
    await rm(lock, { recursive: true });
    const encrypted = await cipher.encrypt("token");
    const reopened = createSystemCredentialCipher({ filePath: fixture.file, env: {}, keyStore });
    expect(await reopened.decrypt(encrypted)).toBe("token");
    expect(reads).toBe(1);
  }, 20_000);
  it("migrates old values, preserves an unrelated broken legacy field, and retains atomic session CAS", async () => {
    const fixture = await setup();
    const legacy = createLegacyCredentialCipher({ ZCODE_CREDENTIAL_SECRET: "migration-test" });
    const cipher = createSystemCredentialCipher({
      filePath: fixture.file,
      env: { ZCODE_CREDENTIAL_SECRET: "migration-test" },
      keyStore: fixture.keyStore,
    });
    await writeFile(
      fixture.file,
      JSON.stringify({
        zcodejwttoken: legacy.encrypt("old-token"),
        "oauth:active_provider": "zai",
        unused: "enc:v1:broken",
      }),
    );
    const store = createSharedZCodeCredentialStore({ filePath: fixture.file, cipher });
    const snapshot = await store.loadMany(["zcodejwttoken", "oauth:active_provider"]);
    expect(snapshot.zcodejwttoken).toBe("old-token");
    const disk = JSON.parse(await readFile(fixture.file, "utf8"));
    expect(disk.zcodejwttoken).toMatch(/^enc:v2:env:/);
    expect(disk.unused).toBe("enc:v1:broken");
    if (process.platform !== "win32") expect((await stat(fixture.file)).mode & 0o777).toBe(0o600);
    await store.save("zcodejwttoken", "new-token");
    expect(await store.updateMany({ zcodejwttoken: null }, { expected: snapshot })).toBe(false);
    expect(await store.load("zcodejwttoken")).toBe("new-token");
  });
  it("refuses new writes after the system key was lost", async () => {
    const fixture = await setup();
    const first = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: fixture.keyStore,
    });
    const token = await first.encrypt("old");
    await writeFile(fixture.file, JSON.stringify({ zcodejwttoken: token }));
    fixture.forget();
    const next = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: { ...fixture.keyStore },
    });
    await expect(next.encrypt("new")).rejects.toHaveProperty(
      "code",
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(fixture.writes()).toBe(1);
    expect(JSON.parse(await readFile(fixture.file, "utf8")).zcodejwttoken).toBe(token);
  });
  it("rejects authentication-tag tampering and reads an empty legacy value", async () => {
    const fixture = await setup();
    const env = { ZCODE_CREDENTIAL_SECRET: "empty-legacy-test" };
    const legacy = createLegacyCredentialCipher(env);
    const cipher = createSystemCredentialCipher({ filePath: fixture.file, env });
    expect(await cipher.decrypt(legacy.encrypt(""))).toBe("");
    const encrypted = await cipher.encrypt("private-value");
    const offset = encrypted.lastIndexOf(":") + 1;
    const tampered =
      encrypted.slice(0, offset) +
      (encrypted[offset] === "A" ? "B" : "A") +
      encrypted.slice(offset + 1);
    await expect(cipher.decrypt(tampered)).rejects.toHaveProperty(
      "code",
      "ZCODE_CREDENTIAL_DECRYPT_FAILED",
    );
  });
  it("does not partially migrate when an existing v2 credential belongs to another key source", async () => {
    const fixture = await setup();
    const configured = createSystemCredentialCipher({
      filePath: fixture.file,
      env: { ZCODE_CREDENTIAL_SECRET: "old-managed-key" },
    });
    const record = { existing: await configured.encrypt("preserve"), legacy: "legacy-value" };
    await writeFile(fixture.file, JSON.stringify(record));
    const next = createSystemCredentialCipher({
      filePath: fixture.file,
      env: {},
      keyStore: fixture.keyStore,
    });
    await expect(migrateCredentialRecord(record, next)).rejects.toHaveProperty(
      "code",
      "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(fixture.writes()).toBe(0);
    expect(JSON.parse(await readFile(fixture.file, "utf8"))).toEqual(record);
  });
});
