import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSystemCredentialCipher,
  enablePrivateFileKeyFallback,
  type CredentialStoreResetEvent,
} from "@zcode/shared/credential-security";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

// 默认路径（不注入 KeyStore）才会创建原生条目对象；用 mock 替换原生模块。
// 回退开关与密钥缓存是进程级的：本文件独立运行（vitest 按文件隔离），模拟 Desktop Main。
const backend = vi.hoisted(() => ({ constructorError: null as Error | null }));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor() {
      if (backend.constructorError) throw backend.constructorError;
    }
    async getPassword() {
      return null;
    }
    async setPassword() {}
  },
}));

const resetWaiters: Array<(event: CredentialStoreResetEvent) => void> = [];
beforeAll(() => {
  enablePrivateFileKeyFallback({ onReset: (event) => resetWaiters.shift()?.(event) });
});
const dirs: string[] = [];
afterEach(async () => {
  backend.constructorError = null;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected credential storage failure");
    },
    (error: { code?: string; diagnostic?: unknown }) => error,
  );

describe("Desktop reset when the native system store cannot be opened", () => {
  // 评审复现（Linux 真实原生模块）：没有 D-Bus 或 Secret Service 时，模块能加载，
  // new AsyncEntry() 即抛错；该错误曾被标成 load（不触发重置），已绑定 os 的目录无法再登录。
  it("treats an entry construction failure as read, resets the bound store and falls back", async () => {
    backend.constructorError = new Error(
      "Platform failure: DBus error: org.freedesktop.secrets was not provided by any .service files",
    );
    const dir = await mkdtemp(join(tmpdir(), "zcode-desktop-native-open-"));
    dirs.push(dir);
    const file = join(dir, "credentials.json");
    await writeFile(join(dir, "credential-source"), "os\n");
    await writeFile(file, JSON.stringify({ token: `enc:v2:os:${"a".repeat(24)}:x.y.z` }));
    const store = createSharedZCodeCredentialStore({
      filePath: file,
      cipher: createSystemCredentialCipher({ filePath: file, env: {} }),
    });
    const reset = new Promise<CredentialStoreResetEvent>((resolve) => resetWaiters.push(resolve));

    const failure = await errorOf(store.save("zcodejwttoken", "after-reset"));
    expect(failure).toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
      diagnostic: { stage: "read" },
    });
    expect(await reset).toMatchObject({ status: "reset", diagnostic: { stage: "read" } });

    // 重置后目录未绑定，再次创建条目对象失败时走私有文件回退。
    await store.save("zcodejwttoken", "after-reset");
    expect(JSON.parse(await readFile(file, "utf8")).zcodejwttoken).toMatch(/^enc:v2:env:/);
    expect(await store.load("zcodejwttoken")).toBe("after-reset");
  });
});
