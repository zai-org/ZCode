import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { readAtomicTarget, recoverAtomicTargetSync } from "../src/plugins/atomic-directory.js";

/** 不存在的进程号：存活检查返回 ESRCH，事务视为无人持有。 */
const DEAD_OWNER_PID = 2 ** 31 - 2;
const TRANSACTION_ID = "transaction";
const MARKER = "generation.txt";

type Transaction = "none" | "v1" | "standalone" | "coordinated" | "committed";
interface AtomicCase {
  transaction: Transaction;
  live: boolean;
  hadTarget: boolean;
  target: boolean;
  backup: boolean;
}

const cases: AtomicCase[] = [];
for (const transaction of ["none", "v1", "standalone", "coordinated", "committed"] as const)
  for (const live of transaction === "none" || transaction === "v1" ? [false] : [false, true])
    for (const hadTarget of transaction === "none" || transaction === "v1"
      ? [false]
      : [false, true])
      for (const target of [false, true])
        for (const backup of [false, true])
          cases.push({ transaction, live, hadTarget, target, backup });

const root = await mkdtemp(join(tmpdir(), "plugin-atomic-state-"));
afterAll(() => rm(root, { recursive: true, force: true }));

async function generation(path: string): Promise<string> {
  return readFile(join(path, MARKER), "utf8").catch(() => "none");
}

it("enumerates every transaction state", () => {
  expect(cases).toHaveLength(56);
});

// 修复前同步恢复入口与异步只读入口各写一套判定，同一磁盘状态下读到的一代或稳定性不同。
it.each(cases)(
  "both entries agree on the committed generation: %o",
  async ({ transaction, live, hadTarget, target, backup }) => {
    const parent = await mkdtemp(join(root, "case-"));
    const targetPath = join(parent, "plugin");
    const backupPath = join(parent, ".plugin.backup");
    const authorityPath = join(parent, "installed.json");
    for (const [exists, path, name] of [
      [target, targetPath, "target"],
      [backup, backupPath, "backup"],
    ] as const) {
      if (!exists) continue;
      await mkdir(path);
      await writeFile(join(path, MARKER), name);
    }
    const coordinated = transaction === "coordinated" || transaction === "committed";
    await writeFile(
      authorityPath,
      JSON.stringify({
        plugins: transaction === "committed" ? [{ cacheTransactionId: TRANSACTION_ID }] : [],
      }),
    );
    if (transaction !== "none")
      await writeFile(
        join(parent, ".plugin.transaction.json"),
        JSON.stringify(
          transaction === "v1"
            ? { version: 1, stageName: ".plugin.stage-old" }
            : {
                version: 2,
                stageName: ".plugin.stage-old",
                transactionId: TRANSACTION_ID,
                ownerId: "other-process",
                // 父进程一定存活，用它模拟仍在写入的另一个进程。
                ownerPid: live ? process.ppid : DEAD_OWNER_PID,
                hadTarget,
                mode: coordinated ? "coordinated" : "standalone",
                ...(coordinated ? { authorityPath } : {}),
              },
        ),
      );

    const view = await readAtomicTarget(targetPath);
    const read = await generation(view.path);
    const before = await generation(targetPath);
    const recovered = await generation(recoverAtomicTargetSync(targetPath));
    expect(read).toBe(recovered);
    if (live) {
      // 仍有 writer：只有已提交且读 target 时才可作为执行根。
      expect(view.stable).toBe(transaction === "committed" && view.path === targetPath);
    } else {
      // 无人持有：恢复不需要搬动 target 时，读取方也应把 target 视为稳定。
      expect(view.stable).toBe(recovered === before);
    }
  },
);
