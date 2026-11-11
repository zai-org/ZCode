import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as fileSystem from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  acquireFileLock,
  captureCredentialFileGuard,
  withCredentialFileRead,
  withFileLock,
} from "@zcode/shared/node";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), mkdir: vi.fn(actual.mkdir) };
});

it("正常读取不等待另一进程的写锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-read-lock-"));
  const file = join(root, "credentials.json");
  const store = createSharedZCodeCredentialStore({ filePath: file });
  await store.save("healthy", "value");
  const unlock = await acquireFileLock(file, [], 0, 10000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("read waited for writer lock")), 1000);
    });
    expect(await Promise.race([store.load("healthy"), timedOut])).toBe("value");
  } finally {
    clearTimeout(timeout);
    await unlock();
    await rm(root, { recursive: true, force: true });
  }
});

it("恢复推进代次但尚未替换时，损坏原件不能被读为有效凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-admission-"));
  const file = join(root, "credentials.json");
  await writeFile(file, '{"unfinished":');
  const unlock = await acquireFileLock(file, [], 0, 10000);
  try {
    await writeFile(`${file}.recovery-generation`, "new");
    const store = createSharedZCodeCredentialStore({ filePath: file });
    await expect(store.load("old")).rejects.toThrow();
    await writeFile(file, "{}");
    expect(await store.load("old")).toBeNull();
  } finally {
    await unlock();
    await rm(root, { recursive: true, force: true });
  }
});

it("非法 UTF-8 的容器不能返回有效字段或被写回覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-utf8-"));
  const file = join(root, "credentials.json");
  const store = createSharedZCodeCredentialStore({ filePath: file });
  try {
    await store.save("ok", "valid-value");
    const valid = await readFile(file);
    const invalid = Buffer.concat([
      Buffer.from('{"k'),
      Buffer.from([0xff]),
      Buffer.from('":"v",'),
      valid.subarray(1),
    ]);
    await writeFile(file, invalid);
    await writeFile(`${file}.recovery-generation`, "new");
    await expect(store.load("ok")).rejects.toThrow("credentials are corrupt");
    await expect(store.save("other", "new-value")).rejects.toThrow("credentials are corrupt");
    expect(await readFile(file)).toEqual(invalid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("恢复前开始的流程不能在网络返回后重新取得新库的写入资格", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-flow-"));
  const file = join(root, "credentials.json");
  try {
    await writeFile(file, "{}");
    const guard = await captureCredentialFileGuard(file);
    await writeFile(`${file}.recovery-generation`, "new-flow-generation");
    const store = createSharedZCodeCredentialStore({ filePath: file });
    await expect(guard(async () => store.save("old-flow", "old-value"))).rejects.toThrow(
      "Credential store changed",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    await store.save("new-flow", "new-value");
    expect(await store.load("new-flow")).toBe("new-value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("另一个进程已取得的旧读取在恢复后同样失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-recovery-process-"));
  const file = join(root, "credentials.json");
  await writeFile(file, '{"old":"value"}');
  const child = fork(
    fileURLToPath(new URL("./fixtures/credential-recovery-reader.ts", import.meta.url)),
    [file],
    {
      execArgv: ["--import", "tsx"],
      silent: true,
    },
  );
  try {
    expect((await once(child, "message"))[0]).toEqual({ type: "admitted" });
    await withFileLock(file, async () => {
      await writeFile(`${file}.recovery-generation`, "new-process-generation");
      await writeFile(file, "{}");
    });
    const response = once(child, "message");
    child.send("release");
    expect((await response)[0]).toEqual({ type: "failed", code: "ZCODE_CREDENTIAL_STORE_CHANGED" });
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("恢复代次变化后，已经取得的旧读取结果不能返回", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-recovery-"));
  const file = join(root, "credentials.json");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await writeFile(file, '{"old":"value"}');
    const read = withCredentialFileRead(file, async () => {
      const value = await readFile(file, "utf8");
      entered();
      await hold;
      return value;
    });
    const rejected = expect(read).rejects.toThrow("Credential store changed");
    await ready;
    await withFileLock(file, async () => {
      await writeFile(`${file}.recovery-generation`, "new-generation");
      await writeFile(file, "{}");
    });
    release();
    await rejected;
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

it("恢复后的并发 CLI 保存继续锁内合并，不丢失独立 key", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-recovery-"));
  const file = join(root, "credentials.json");
  try {
    await writeFile(file, "{}");
    await writeFile(`${file}.recovery-generation`, "recovered");
    const store = createSharedZCodeCredentialStore({ filePath: file });
    await Promise.all([store.save("first", "one"), store.save("second", "two")]);
    expect(await store.loadMany(["first", "second"])).toEqual({ first: "one", second: "two" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("确认恢复之后，已接收但尚未取得文件锁的 CLI 保存必须失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-recovery-"));
  const file = join(root, "credentials.json");
  const generationFile = `${file}.recovery-generation`;
  const actualRead = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
    .readFile;
  let release!: () => void;
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const spy = vi.mocked(fileSystem.readFile).mockImplementation((async (
    ...args: Parameters<typeof actualRead>
  ) => {
    const value = await actualRead(...args);
    if (args[0] === generationFile && first) {
      first = false;
      admitted();
      await hold;
    }
    return value;
  }) as typeof actualRead);
  try {
    await writeFile(file, "{}");
    await writeFile(generationFile, "old");
    const store = createSharedZCodeCredentialStore({ filePath: file });
    const save = store.save("late", "must-not-return");
    const rejected = expect(save).rejects.toThrow("Credential store changed");
    await ready;
    await withFileLock(file, async () => {
      await writeFile(generationFile, "new");
      await writeFile(file, "{}");
    });
    release();
    await rejected;
    expect(JSON.parse(await actualRead(file, "utf8"))).toEqual({});
  } finally {
    release?.();
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
