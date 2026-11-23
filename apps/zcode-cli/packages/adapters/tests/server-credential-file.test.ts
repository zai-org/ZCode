import { link } from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerCredentialCipher,
  createSystemCredentialCipher,
  prepareServerCredentialFile,
  resolveServerCredentialFile,
} from "@zcode/shared/credential-security";

// 只替换 link，用于在密钥发布这一步注入失败；其余文件操作保持真实。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(link).mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 模拟同机 Desktop 已把共享库固定为系统库来源的 HOME。 */
async function setup(options: { pinOs?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "zcode-server-credential-file-"));
  dirs.push(home);
  const sharedDir = join(home, ".zcode", "v2");
  await mkdir(sharedDir, { recursive: true });
  if (options.pinOs ?? true) {
    await writeFile(join(sharedDir, "credential-source"), "os\n", { mode: 0o600 });
  }
  const serverRoot = join(home, ".zcode", "server");
  await mkdir(serverRoot, { recursive: true });
  return {
    serverRoot,
    serverDir: join(serverRoot, "credentials"),
    sharedFilePath: join(sharedDir, "credentials.json"),
    serverFilePath: join(serverRoot, "credentials", "credentials.json"),
  };
}

function countingKeyStore() {
  const calls = { get: 0, set: 0 };
  return {
    calls,
    keyStore: {
      get: async () => {
        calls.get++;
        return null;
      },
      set: async () => {
        calls.set++;
      },
    },
  };
}

const posixOnly = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

describe("Server-owned credential file (ZCT-2120452663971209216)", () => {
  it("publishes the Server-owned directory with its private key and keeps it on re-prepare", async () => {
    const layout = await setup();
    await expect(prepareServerCredentialFile({ ...layout, env: {} })).resolves.toBe(
      layout.serverFilePath,
    );
    const secret = await readFile(join(layout.serverDir, "credential-secret"), "utf8");
    if (process.platform !== "win32") {
      expect((await stat(layout.serverDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(layout.serverDir, "credential-secret"))).mode & 0o777).toBe(0o600);
    }
    // 临时发布目录不残留。
    expect((await readdir(layout.serverRoot)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    await expect(prepareServerCredentialFile({ ...layout, env: {} })).resolves.toBe(
      layout.serverFilePath,
    );
    expect(await readFile(join(layout.serverDir, "credential-secret"), "utf8")).toBe(secret);
    await expect(resolveServerCredentialFile(layout)).resolves.toBe(layout.serverFilePath);
  });

  it("does not expose a Server-owned directory without a key when key publication fails", async () => {
    const layout = await setup();
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("injected"), { code: "EIO" }));
    await expect(prepareServerCredentialFile({ ...layout, env: {} })).rejects.toThrow("injected");

    // 不经准备直接启动的 Core 不能选中无密钥的自有库，也不能访问系统库。
    const picked = await resolveServerCredentialFile(layout);
    expect(picked).toBe(layout.sharedFilePath);
    const { calls, keyStore } = countingKeyStore();
    if (picked === layout.serverFilePath) {
      await createServerCredentialCipher({ filePath: picked, env: {}, keyStore }).catch(() => {});
    }
    expect(calls).toEqual({ get: 0, set: 0 });

    // 失败后可重试，之后稳定使用同一文件密钥。
    await expect(prepareServerCredentialFile({ ...layout, env: {} })).resolves.toBe(
      layout.serverFilePath,
    );
    const secret = await readFile(join(layout.serverDir, "credential-secret"), "utf8");
    const cipher = await createServerCredentialCipher({
      filePath: layout.serverFilePath,
      env: {},
      keyStore,
    });
    await cipher.encrypt("value");
    expect(calls).toEqual({ get: 0, set: 0 });
    await prepareServerCredentialFile({ ...layout, env: {} });
    expect(await readFile(join(layout.serverDir, "credential-secret"), "utf8")).toBe(secret);
  });

  it("keeps a shared store that the explicit Server secret can read", async () => {
    const layout = await setup();
    const env = { ZCODE_CREDENTIAL_SECRET: "e".repeat(40) };
    const writer = createSystemCredentialCipher({
      filePath: layout.sharedFilePath,
      env,
      keyStore: countingKeyStore().keyStore,
    });
    await writeFile(
      layout.sharedFilePath,
      JSON.stringify({ "mcp:oauth:example": await writer.encrypt("token") }),
      { mode: 0o600 },
    );

    await expect(prepareServerCredentialFile({ ...layout, env })).resolves.toBe(
      layout.sharedFilePath,
    );
    await expect(stat(layout.serverDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveServerCredentialFile(layout)).resolves.toBe(layout.sharedFilePath);
  });

  it("still isolates an explicit-secret host whose shared store holds no Server-readable v2 data", async () => {
    const layout = await setup();
    const env = { ZCODE_CREDENTIAL_SECRET: "e".repeat(40) };
    await expect(prepareServerCredentialFile({ ...layout, env })).resolves.toBe(
      layout.serverFilePath,
    );
    // 自有目录总有文件密钥：去掉显式配置后也不会落到系统库。
    await expect(stat(join(layout.serverDir, "credential-secret"))).resolves.toBeTruthy();
  });

  it("refuses to change the credential store when the Server-owned path is not a directory", async () => {
    const layout = await setup();
    await writeFile(layout.serverDir, "not a directory");
    await expect(resolveServerCredentialFile(layout)).rejects.toThrow();
    await expect(prepareServerCredentialFile({ ...layout, env: {} })).rejects.toThrow();
  });

  posixOnly("refuses to change the credential store when the Server root is unreadable", async () => {
    const layout = await setup();
    await prepareServerCredentialFile({ ...layout, env: {} });
    await chmod(layout.serverRoot, 0o000);
    try {
      await expect(resolveServerCredentialFile(layout)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(layout.serverRoot, 0o700);
    }
  });
});
