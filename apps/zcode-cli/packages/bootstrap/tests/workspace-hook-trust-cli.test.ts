import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "../src/workspace-hook-trust-cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-trust-cli-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const storagePath = join(root, "user-data");
  const userConfigPath = join(root, "config.json");
  await mkdir(join(workspacePath, ".zcode"), { recursive: true });
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { dir: storagePath }, hooks: { enabled: true, events: {} } }),
  );
  await writeFile(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              matcher: "startup",
              // process 写法在所有平台都绑定入口（Windows 上 command 不绑定），Windows CI 上断言同样成立。
              hooks: [{ type: "process", command: "sh", args: ["start.sh"] }],
            },
          ],
        },
      },
    }),
  );
  // 入口脚本必须存在才可授权（D24）。
  await writeFile(join(workspacePath, "start.sh"), "echo one\n", "utf8");
  return { storagePath, workspacePath, userConfigPath };
}

describe("Workspace Hook Trust CLI domain", () => {
  it("status exposes exact bundle/declaration digests and exact grant/revoke persists", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    expect(pending.reasonCode).toBe("workspace_hooks_pending_trust");
    expect(pending.bundleDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(pending.items).toHaveLength(1);
    const digest = pending.items[0]!.hookDeclarationDigest;

    const granted = await grantWorkspaceHookTrust({
      ...target,
      hookDeclarationDigests: [digest],
      appVersion: "test",
    });
    expect(granted.reasonCode).toBe("workspace_hooks_trusted_persistent");
    expect(granted.items[0]?.trustState).toBe("trusted_persistent");

    const revoked = await revokeWorkspaceHookTrustCli({
      ...target,
      hookDeclarationDigests: [digest],
    });
    expect(revoked.reasonCode).toBe("workspace_hooks_pending_trust");
  });

  it("all-current rejects a stale bundle without writing Trust", async () => {
    const target = await fixture();
    await expect(
      grantWorkspaceHookTrust({
        ...target,
        allCurrent: true,
        bundleDigest: "f".repeat(64),
      }),
    ).rejects.toThrow("workspace_hooks_bundle_changed");
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe("pending_trust");
  });

  it("exact grant rejects a stale Settings bundle before writing Trust", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    await expect(
      grantWorkspaceHookTrust({
        ...target,
        bundleDigest: "f".repeat(64),
        hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
      }),
    ).rejects.toThrow("workspace_hooks_bundle_changed");
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe("pending_trust");
  });

  it("corrupt Trust store rejects the first grant instead of silently replacing it", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    const securityPath = join(target.storagePath, "security");
    await mkdir(securityPath, { recursive: true });
    await writeFile(join(securityPath, "workspace-hook-trust-v1.json"), "{ invalid json");

    await expect(
      grantWorkspaceHookTrust({
        ...target,
        bundleDigest: pending.bundleDigest!,
        hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
      }),
    ).rejects.toThrow("workspace_hooks_trust_store_corrupt");
  });

  // SG-02 回归：status 对损坏 store 必须显式报 corrupt，不能伪装成 pending_trust——
  // 否则用户按提示执行 grant 只会得到 trust_store_corrupt，恢复指引自相矛盾。
  it("status surfaces corrupt Trust store as its own reasonCode instead of pending_trust", async () => {
    const target = await fixture();
    const securityPath = join(target.storagePath, "security");
    await mkdir(securityPath, { recursive: true });
    // JSON 合法但结构非法（缺 schemaVersion/必需字段），schema 校验失败同样 corrupt。
    await writeFile(
      join(securityPath, "workspace-hook-trust-v1.json"),
      JSON.stringify({ schemaVersion: 1, records: [{ workspaceIdentity: "/anywhere" }] }),
    );

    const status = await inspectWorkspaceHookTrust(target);
    expect(status.reasonCode).toBe("workspace_hooks_trust_store_corrupt");
    // corrupt 下任何 digest 都不可信：全部条目不得展示 trusted_persistent。
    for (const item of status.items) {
      expect(item.trustState).toBe("pending_trust");
    }
  });
});

/**
 * D24（ZP-20261110-06）：入口脚本不存在或无法读取时没有可审核的内容，拒绝授权；
 * 已授权脚本内容变化后旧 Trust 不再命中。
 */
describe("Workspace Hook Trust CLI 入口脚本绑定（D24）", () => {

  it("脚本内容变化后旧 Trust 不命中，重新授权后恢复", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    await grantWorkspaceHookTrust({
      ...target,
      hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
    });
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe(
      "trusted_persistent",
    );

    await writeFile(join(target.workspacePath, "start.sh"), "echo two\n", "utf8");
    const changed = await inspectWorkspaceHookTrust(target);
    expect(changed.items[0]?.trustState).toBe("pending_trust");
    expect(changed.items[0]?.hookDeclarationDigest).not.toBe(
      pending.items[0]!.hookDeclarationDigest,
    );

    await grantWorkspaceHookTrust({
      ...target,
      hookDeclarationDigests: [changed.items[0]!.hookDeclarationDigest],
    });
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe(
      "trusted_persistent",
    );
  });

  it("脚本不存在：status 为 blocked_untrusted，exact 与 all-current 授权都拒绝且不写 store", async () => {
    const target = await fixture();
    await rm(join(target.workspacePath, "start.sh"));
    const status = await inspectWorkspaceHookTrust(target);
    expect(status.items[0]?.trustState).toBe("blocked_untrusted");
    expect(status.reasonCode).toBe("workspace_hook_script_unavailable");

    await expect(
      grantWorkspaceHookTrust({
        ...target,
        hookDeclarationDigests: [status.items[0]!.hookDeclarationDigest],
      }),
    ).rejects.toThrow("workspace_hook_script_unavailable");
    await expect(
      grantWorkspaceHookTrust({
        ...target,
        allCurrent: true,
        bundleDigest: status.bundleDigest!,
      }),
    ).rejects.toMatchObject({
      message: "workspace_hook_script_unavailable",
      unavailableItems: [expect.stringContaining("sh start.sh")],
    });

    // 文件出现后按实际内容生成新 digest，由用户首次授权。
    await writeFile(join(target.workspacePath, "start.sh"), "echo one\n", "utf8");
    const created = await inspectWorkspaceHookTrust(target);
    expect(created.items[0]?.trustState).toBe("pending_trust");
    expect(created.items[0]?.hookDeclarationDigest).not.toBe(
      status.items[0]!.hookDeclarationDigest,
    );
  });

  it("已授权脚本被删除：旧 Trust 不再放行", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    await grantWorkspaceHookTrust({
      ...target,
      hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
    });
    await rm(join(target.workspacePath, "start.sh"));
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe(
      "blocked_untrusted",
    );
  });
});
