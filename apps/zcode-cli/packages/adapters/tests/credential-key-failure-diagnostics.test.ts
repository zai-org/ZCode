import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLegacyCredentialCipher,
  createSystemCredentialCipher,
  migrateCredentialRecord,
  observeCredentialKeyFailures,
  type CredentialKeyFailureDiagnostic,
} from "@zcode/shared/credential-security";

// 3.18.2 Windows 用户一直登录失败：Credential Manager 已满时 CredWrite 返回
// ERROR_NOT_ENOUGH_MEMORY，但日志只有统一的“System credential storage is unavailable”，
// 排查用了多轮用户侧探针。这里固定每个失败点的受控诊断。
// 默认路径（不注入 KeyStore）才是 Desktop Main 实际走的路径；用 mock 替换原生模块。
const VALID_KEY = Buffer.alloc(32, 7).toString("base64url");
const backend = vi.hoisted(() => ({
  get: async (): Promise<string | null> => null,
  set: async (_value: string): Promise<void> => {},
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    getPassword() {
      return backend.get();
    }
    setPassword(value: string) {
      return backend.set(value);
    }
  },
}));

// 观察者是进程级的：本文件独立运行（vitest 按文件隔离），模拟 Desktop Main 启动时注册。
const failures: CredentialKeyFailureDiagnostic[] = [];
let registered = false;
beforeAll(() => {
  registered = observeCredentialKeyFailures((diagnostic) => failures.push(diagnostic));
});
const dirs: string[] = [];
beforeEach(() => {
  failures.length = 0;
  backend.get = async () => null;
  backend.set = async () => {};
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function credentialFile(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-credential-diagnostics-"));
  dirs.push(dir);
  const file = join(dir, "credentials.json");
  if (content !== undefined) await writeFile(file, content);
  return file;
}
// keyring-core 对 Windows 平台错误的固定格式（windows-native-keyring-store PlatformError）。
const windowsWriteFailure = () =>
  new Error("Platform failure: Windows error code 8") as Error & { code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected credential storage failure");
    },
    (error: { code?: string; diagnostic?: unknown; message?: string }) => error,
  );

describe("system credential key failure diagnostics", () => {
  it("registers the process observer once", () => {
    expect(registered).toBe(true);
    expect(observeCredentialKeyFailures(() => {})).toBe(false);
  });

  it("reports a Credential Manager write failure with the Windows error number", async () => {
    // 与事故相同：3.17.2 留下 v1 凭据，升级后首次迁移需要创建系统密钥。
    const v1 = createLegacyCredentialCipher({}).encrypt("legacy-login");
    const file = await credentialFile(JSON.stringify({ zcodejwttoken: v1 }));
    backend.set = async () => {
      throw windowsWriteFailure();
    };
    const cipher = createSystemCredentialCipher({ filePath: file, env: {} });

    const error = await failureOf(migrateCredentialRecord({ zcodejwttoken: v1 }, cipher));

    expect(error.code).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
    expect(error.diagnostic).toEqual({ stage: "create", osCode: 8 });
    expect(failures).toEqual([{ stage: "create", osCode: 8 }]);
    // 失败按进程缓存：后续请求不再访问系统库，也不重复通知。
    await failureOf(cipher.encrypt("next"));
    await failureOf(createSystemCredentialCipher({ filePath: file, env: {} }).encrypt("other"));
    expect(failures).toHaveLength(1);
  });

  it("distinguishes read, read-back and malformed entries", async () => {
    backend.get = async () => {
      throw new Error("Couldn't access platform storage: Windows ERROR_NO_SUCH_LOGON_SESSION");
    };
    const read = await failureOf(
      createSystemCredentialCipher({ filePath: await credentialFile(), env: {} }).encrypt("x"),
    );
    expect(read.diagnostic).toEqual({ stage: "read", osCode: 1312 });

    let stored: string | null = null;
    backend.get = async () => (stored === null ? null : "different-value");
    backend.set = async (value) => {
      stored = value;
    };
    const verify = await failureOf(
      createSystemCredentialCipher({ filePath: await credentialFile(), env: {} }).encrypt("x"),
    );
    expect(verify.diagnostic).toEqual({ stage: "verify" });

    backend.get = async () => "not-a-valid-key";
    const invalid = await failureOf(
      createSystemCredentialCipher({ filePath: await credentialFile(), env: {} }).encrypt("x"),
    );
    expect(invalid.diagnostic).toEqual({ stage: "invalid" });

    expect(failures.map((failure) => failure.stage)).toEqual(["read", "verify", "invalid"]);
  });

  it("reports a missing key for an os-bound directory without creating a replacement", async () => {
    const file = await credentialFile("{}\n");
    await writeFile(join(file, "..", "credential-source"), "os\n");
    let writes = 0;
    backend.set = async () => {
      writes++;
    };
    const error = await failureOf(
      createSystemCredentialCipher({ filePath: file, env: {} }).encrypt("x"),
    );
    expect(error.diagnostic).toEqual({ stage: "missing" });
    expect(writes).toBe(0);
  });

  it("reports an unknown source marker and an unreadable credential file", async () => {
    const marked = await credentialFile("{}\n");
    await writeFile(join(marked, "..", "credential-source"), "unknown\n");
    const source = await failureOf(
      createSystemCredentialCipher({ filePath: marked, env: {} }).encrypt("x"),
    );
    expect(source.diagnostic).toEqual({ stage: "source" });

    // 凭据文件位置被同名目录占用：读取得到 EISDIR，属于文件层错误而不是系统库错误。
    const occupied = await credentialFile();
    await mkdir(occupied);
    const file = await failureOf(
      createSystemCredentialCipher({ filePath: occupied, env: {} }).encrypt("x"),
    );
    expect(file.diagnostic).toEqual({ stage: "file", errorCode: "EISDIR" });
  });

  it("reports conflicting explicit configuration once per cipher", async () => {
    const cipher = createSystemCredentialCipher({
      filePath: await credentialFile(),
      env: {
        ZCODE_CREDENTIAL_SECRET: "explicit-secret-0123456789-0123456789",
        ZCODE_CREDENTIAL_SECRET_FILE: "credential-secret-file",
      },
    });
    expect((await failureOf(cipher.encrypt("x"))).diagnostic).toEqual({ stage: "config" });
    await failureOf(cipher.encrypt("y"));
    expect(failures).toEqual([{ stage: "config" }]);
  });

  it("never exposes key material, paths or native error text in diagnostics", async () => {
    const file = await credentialFile();
    // 原生错误正文与错误码字段都混入密钥和路径；诊断只能保留固定格式的数字错误号。
    backend.get = async () => {
      throw Object.assign(new Error(`os error 5 at ${file} key=${VALID_KEY}`), {
        code: `${VALID_KEY}`,
      });
    };
    const error = await failureOf(
      createSystemCredentialCipher({ filePath: file, env: {} }).encrypt("x"),
    );
    expect(error.diagnostic).toEqual({ stage: "read", osCode: 5 });
    const serialized = JSON.stringify(failures) + JSON.stringify(error.diagnostic) + error.message;
    expect(serialized).not.toContain(VALID_KEY);
    expect(serialized).not.toContain(file);
  });

  it("does not notify when the key loads and keeps the success path unchanged", async () => {
    const file = await credentialFile();
    backend.get = async () => VALID_KEY;
    const cipher = createSystemCredentialCipher({ filePath: file, env: {} });
    expect(await cipher.decrypt(await cipher.encrypt("ok"))).toBe("ok");
    expect(await readFile(join(file, "..", "credential-source"), "utf8")).toBe("os\n");
    expect(failures).toEqual([]);
  });

  it("isolates observer exceptions from the credential result", async () => {
    // 观察者已注册为本文件的 collector；用会抛错的 get 验证错误仍是受控存储错误。
    backend.get = async () => {
      throw new Error("Platform failure: Windows error code 1312");
    };
    const original = failures.push.bind(failures);
    failures.push = () => {
      throw new Error("observer failed");
    };
    try {
      const error = await failureOf(
        createSystemCredentialCipher({ filePath: await credentialFile(), env: {} }).encrypt("x"),
      );
      expect(error.code).toBe("CREDENTIAL_SECURE_STORAGE_UNAVAILABLE");
      expect(error.diagnostic).toEqual({ stage: "read", osCode: 1312 });
    } finally {
      failures.push = original;
    }
  });
});
