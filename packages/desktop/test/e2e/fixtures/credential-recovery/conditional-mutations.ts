import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";

const home = await mkdtemp(join(tmpdir(), "credential-conditional-recovery-"));
process.env.ZCODE_DATA_BASE_DIR = home;
const { createCredentialService } = await import("@zcode/services/node");
const file = join(home, ".zcode", "v2", "credentials.json");
await mkdir(join(home, ".zcode", "v2"), { recursive: true });
const events: string[] = [];
const service = createCredentialService({
  cipherProvider: { encrypt: (value) => value, decrypt: (value) => value },
  onDidMutate: ({ operation }) => events.push(operation),
});
const results = [];
const originalMkdir = fs.mkdir;
let unlock: (() => Promise<void>) | undefined;
try {
  for (const method of ["saveIfAbsent", "deleteIfEquals"] as const) {
    await writeFile(file, method === "saveIfAbsent" ? "{}" : '{"synthetic":"old"}');
    unlock = await acquireFileLock(file, [], 0, 10000);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // 只观察真实 OS 锁的竞争，不改变锁或存储结果；证明请求已进入等待后再提交恢复。
    fs.mkdir = ((...args: Parameters<typeof originalMkdir>) => {
      if (String(args[0]) === `${file}.lock`) entered();
      return originalMkdir(...args);
    }) as typeof fs.mkdir;
    syncBuiltinESMExports();
    const pending = service[method]("synthetic", "old").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waiting;
    fs.mkdir = originalMkdir;
    syncBuiltinESMExports();
    // 等价于 recoverStore 的锁内提交：先推进代次，再替换空库。
    await atomicWritePrivateTextFile(`${file}.recovery-generation`, method);
    await atomicWritePrivateTextFile(file, "{}");
    await unlock();
    unlock = undefined;
    const result = await pending;
    assert.ok("error" in result && typeof result.error === "object" && result.error !== null);
    assert.equal((result.error as { code?: string }).code, "ZCODE_CREDENTIAL_STORE_CHANGED");
    assert.equal(await readFile(file, "utf8"), "{}");
    assert.equal(events.length, 0);
    assert.equal(await service.saveIfAbsent("synthetic", "new"), "new");
    assert.equal(await service.saveIfAbsent("synthetic", "ignored"), "new");
    await service.deleteIfEquals("synthetic", "wrong");
    assert.equal(await service.load("synthetic"), "new");
    await service.deleteIfEquals("synthetic", "new");
    assert.equal(await service.load("synthetic"), null);
    results.push({ method, staleRejected: true, newOperationsPreserved: true });
    events.length = 0;
  }
  const result = { results, realUserCredentials: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  fs.mkdir = originalMkdir;
  syncBuiltinESMExports();
  await unlock?.();
  await rm(home, { recursive: true, force: true });
}
