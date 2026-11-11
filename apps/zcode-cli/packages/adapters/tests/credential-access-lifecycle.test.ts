import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSystemCredentialCipher,
  createCredentialCipherBridge,
  executeCredentialCipherRequest,
} from "@zcode/shared/credential-security";
import {
  credentialCipherRequestSchema,
  credentialCipherReplySchema,
  isCredentialDecryptError,
  type CredentialCipherRequest,
} from "@zcode/shared";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

const backend = vi.hoisted(() => ({ reads: 0, fail: false }));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    async getPassword() {
      backend.reads++;
      if (backend.fail) throw new Error("synthetic access denied");
      return Buffer.alloc(32, 7).toString("base64url");
    }
  },
}));

const dirs: string[] = [];
beforeEach(() => {
  backend.reads = 0;
  backend.fail = false;
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "credential-access-lifecycle-"));
  dirs.push(dir);
  const filePath = join(dir, "credentials.json");
  const cipher = createSystemCredentialCipher({
    filePath,
    env: {},
    keyStore: {
      get: async () => Buffer.alloc(32, 7).toString("base64url"),
      set: async () => {
        throw new Error("unexpected synthetic key write");
      },
    },
  });
  const value = await cipher.encrypt("first-token");
  await writeFile(filePath, JSON.stringify({ zcodejwttoken: value }));
  return { filePath, cipher, value };
}

describe("system credential access lifecycle", () => {
  it("roundtrips the exact UTF-8 boundary for ASCII and multibyte plaintext", async () => {
    const { cipher } = await fixture();
    for (const value of ["a".repeat(1048576), "界".repeat(349525), "😀".repeat(262144)]) {
      const encrypted = await executeCredentialCipherRequest(cipher, {
        requestId: "7a648738-5de1-4b7d-a26e-2b6e6d91d174",
        operation: "encrypt",
        value,
      });
      expect(credentialCipherReplySchema.safeParse(encrypted).success).toBe(true);
      if (!encrypted.result.ok) throw new Error("Expected successful boundary encryption");
      const decrypted = await executeCredentialCipherRequest(cipher, {
        requestId: "7a648738-5de1-4b7d-a26e-2b6e6d91d174",
        operation: "decrypt",
        value: encrypted.result.value,
      });
      expect(decrypted.result).toEqual({ ok: true, value });
    }
  });
  it("migrates a large legacy value through the real bridge and releases its lock", async () => {
    const { filePath, cipher } = await fixture();
    const bridge = createCredentialCipherBridge((request) => {
      void executeCredentialCipherRequest(cipher, request).then((reply) => {
        // 与 Host 的接收路径相同；超限回复不能被静默丢弃后挂起迁移。
        if (credentialCipherReplySchema.safeParse(reply).success) bridge.receive(reply);
      });
    });
    try {
      const value = "a".repeat(800000);
      await writeFile(filePath, JSON.stringify({ profile: value }));
      const store = createSharedZCodeCredentialStore({ filePath, cipher: bridge.cipher });
      expect(await store.load("profile")).toBe(value);
      await store.save("later", "still-available");
      expect(await store.load("later")).toBe("still-available");
    } finally {
      bridge.dispose();
    }
  });
  it("rejects a malformed correlated reply and releases the migration lock", async () => {
    const { filePath } = await fixture();
    const bridge = createCredentialCipherBridge((request) => {
      bridge.receive({ requestId: request.requestId, result: { ok: true, value: 42 } } as never);
    });
    try {
      await writeFile(filePath, JSON.stringify({ profile: "legacy" }));
      const store = createSharedZCodeCredentialStore({ filePath, cipher: bridge.cipher });
      await expect(store.load("profile")).rejects.toHaveProperty(
        "code",
        "CREDENTIAL_CIPHER_INVALID_PAYLOAD",
      );
      await expect(store.load("profile")).rejects.toHaveProperty(
        "code",
        "CREDENTIAL_CIPHER_INVALID_PAYLOAD",
      );
    } finally {
      bridge.dispose();
    }
  });
  it("rejects oversized output with a valid error and bounds UTF-8 input", async () => {
    const request = {
      requestId: "7a648738-5de1-4b7d-a26e-2b6e6d91d174",
      operation: "encrypt" as const,
      value: "valid",
    };
    const reply = await executeCredentialCipherRequest(
      { encrypt: () => "a".repeat(2_000_000), decrypt: () => "" },
      request,
    );
    expect(credentialCipherReplySchema.safeParse(reply).success).toBe(true);
    expect(reply.result.ok).toBe(false);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "界".repeat(400000) }).success,
    ).toBe(false);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "a".repeat(1048576) }).success,
    ).toBe(true);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "a".repeat(1048577) }).success,
    ).toBe(false);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "界".repeat(349525) }).success,
    ).toBe(true);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "😀".repeat(262144) }).success,
    ).toBe(true);
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, value: "😀".repeat(262145) }).success,
    ).toBe(false);
  });
  it("correlates delegated crypto replies and rejects pending work on disconnect", async () => {
    const sent: CredentialCipherRequest[] = [];
    const bridge = createCredentialCipherBridge((request) => sent.push(request));
    const first = bridge.cipher.encrypt("first");
    const second = bridge.cipher.decrypt("second");
    bridge.receive({ requestId: sent[1]!.requestId, result: { ok: true, value: "decoded" } });
    bridge.receive({ requestId: sent[0]!.requestId, result: { ok: true, value: "encoded" } });
    expect(await first).toBe("encoded");
    expect(await second).toBe("decoded");
    const interrupted = bridge.cipher.decrypt("pending");
    const rejection = expect(interrupted).rejects.toThrow("closed");
    bridge.dispose();
    await rejection;
    bridge.receive({ requestId: sent[2]!.requestId, result: { ok: true, value: "late" } });
    await expect(bridge.cipher.encrypt("closed")).rejects.toThrow("closed");
    expect(sent).toHaveLength(3);
  });

  it("limits the delegated API and preserves error classification without native details", async () => {
    const request = {
      requestId: "7a648738-5de1-4b7d-a26e-2b6e6d91d174",
      operation: "decrypt" as const,
      value: "invalid",
    };
    expect(
      credentialCipherRequestSchema.safeParse({ ...request, filePath: "/another-account" }).success,
    ).toBe(false);
    const result = await executeCredentialCipherRequest(
      {
        encrypt: () => "",
        decrypt: () => {
          throw Object.assign(new Error("private native detail"), {
            code: "ZCODE_CREDENTIAL_DECRYPT_FAILED",
          });
        },
      },
      request,
    );
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("Expected failure");
    expect(result.result.error.message).not.toContain("private native detail");
    expect(
      isCredentialDecryptError(
        Object.assign(new Error(result.result.error.message), { code: result.result.error.code }),
      ),
    ).toBe(true);
  });

  it("shares one system lookup across sequential and concurrent default cipher instances", async () => {
    const { filePath, value } = await fixture();
    for (let i = 0; i < 3; i++) {
      const cipher = createSystemCredentialCipher({ filePath, env: {} });
      expect(await cipher.decrypt(value)).toBe("first-token");
    }
    await Promise.all(
      Array.from({ length: 8 }, () =>
        createSystemCredentialCipher({ filePath, env: {} }).decrypt(value),
      ),
    );
    expect(backend.reads).toBe(1);
  });

  it("uses the canonical path to share access and keeps different directories isolated", async () => {
    const first = await fixture();
    const second = await fixture();
    const alias = join(first.filePath, "..", "credentials.json");
    await createSystemCredentialCipher({ filePath: first.filePath, env: {} }).decrypt(first.value);
    await createSystemCredentialCipher({ filePath: alias, env: {} }).decrypt(first.value);
    await createSystemCredentialCipher({ filePath: second.filePath, env: {} }).decrypt(
      second.value,
    );
    expect(backend.reads).toBe(2);
  });

  it("retains denied access across instances without retrying or clearing credential data", async () => {
    const { filePath, value } = await fixture();
    backend.fail = true;
    for (let i = 0; i < 3; i++) {
      const store = createSharedZCodeCredentialStore({ filePath, env: {} });
      await expect(store.load("zcodejwttoken")).rejects.toHaveProperty(
        "code",
        "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
      );
    }
    backend.fail = false;
    await expect(
      createSystemCredentialCipher({ filePath, env: {} }).decrypt(value),
    ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(backend.reads).toBe(1);
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(filePath, "utf8")).zcodejwttoken).toBe(value);
  });

  it("reads current tokens from disk while reusing only the system key", async () => {
    const { filePath, cipher } = await fixture();
    const first = createSharedZCodeCredentialStore({ filePath, env: {} });
    expect(await first.load("zcodejwttoken")).toBe("first-token");
    await writeFile(
      filePath,
      JSON.stringify({ zcodejwttoken: await cipher.encrypt("replacement-token") }),
    );
    const second = createSharedZCodeCredentialStore({ filePath, env: {} });
    expect(await second.load("zcodejwttoken")).toBe("replacement-token");
    expect(backend.reads).toBe(1);
  });

  it("shares an injected adapter within its scope without poisoning another adapter", async () => {
    const { filePath, value } = await fixture();
    let reads = 0;
    const denied = {
      get: async (): Promise<string | null> => {
        reads++;
        throw new Error("synthetic access denied");
      },
      set: async () => {},
    };
    for (let i = 0; i < 2; i++) {
      await expect(
        createSystemCredentialCipher({ filePath, env: {}, keyStore: denied }).decrypt(value),
      ).rejects.toHaveProperty("code", "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    }
    expect(reads).toBe(1);
    const available = {
      get: async () => Buffer.alloc(32, 7).toString("base64url"),
      set: async () => {},
    };
    expect(
      await createSystemCredentialCipher({ filePath, env: {}, keyStore: available }).decrypt(value),
    ).toBe("first-token");
  });
});
