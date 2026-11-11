import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { z } from "zod";
import { providerProvisioningEnvelopeSchema } from "@zcode/shared";

const KEYS = [
  "oauth:active_provider",
  "oauth:session_revision",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "oauth:zai_cn:access_token",
  "oauth:zai_cn:refresh_token",
  "oauth:zai_cn:user_info",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "oauth:linked_bigmodel",
  "zcodejwttoken",
];
const empty = Object.fromEntries(KEYS.map((key) => [key, null]));
const primary = {
  ...empty,
  "oauth:active_provider": "zai_cn",
  "oauth:session_revision": "e2e-source-revision",
  "oauth:zai_cn:access_token": "e2e-cn-oauth",
  "oauth:zai_cn:user_info": JSON.stringify({ user_id: "e2e-primary-user", name: "CN" }),
  "oauth:linked_bigmodel": JSON.stringify({
    userId: "e2e-primary-user",
    customerId: "e2e-linked-customer",
    accessToken: "e2e-linked-business",
  }),
  zcodejwttoken: "e2e-primary-jwt",
};
class Runtime {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  sequence = 0;
  constructor(home: string) {
    const require = createRequire(import.meta.url);
    this.child = spawn(
      process.execPath,
      [require.resolve("tsx/cli"), resolve("test/e2e/fixtures/oauth-provisioning/runtime.ts")],
      {
        env: { ...process.env, HOME: home, ZCODE_DATA_BASE_DIR: home, ZCODE_ENV: "test" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.startsWith("E2E_PROVISIONING ")) return;
      const message = JSON.parse(line.slice("E2E_PROVISIONING ".length));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    this.child.stderr.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values())
        pending.reject(new Error(`fixture exited: ${code}`));
      this.pending.clear();
    });
  }
  call(command: string, payload: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  }
  async close() {
    if (this.child.exitCode === null) await this.call("close");
  }
}

describe("OAuth provisioning runtime", () => {
  let root: string;
  let source: Runtime;
  let target: Runtime;
  before(async function () {
    this.timeout(90_000);
    root = await mkdtemp(join(tmpdir(), "oauth-provisioning-e2e-"));
    source = new Runtime(join(root, "source"));
    target = new Runtime(join(root, "target"));
    await source.call("seed", { values: primary });
    await target.call("seed", { values: { ...empty, "manual:e2e:key": "e2e-manual" } });
  });
  after(async function () {
    this.timeout(30_000);
    await Promise.all([source?.close(), target?.close()]);
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("v3 整组同步国内主会话与关联，旧 schema 写入前拒绝", async function () {
    this.timeout(90_000);
    const envelope = await source.call("source", { syncId: "e2e-v3" });
    expect(envelope.schemaVersion).toBe(3);
    const oldSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) });
    expect(oldSchema.safeParse(envelope).success).toBe(false);
    expect(providerProvisioningEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const applied = await target.call("apply", { envelope });
    expect(applied.status).toBe("applied");
    expect(applied.mutations).toHaveLength(1);
    expect(applied.mutations[0].operation).toBe("batch");
    expect(applied.mutations[0].keys.sort()).toEqual([...KEYS].sort());
    const first = await target.call("read", { keys: KEYS });
    expect({ ...first, "oauth:session_revision": null }).toEqual({
      ...primary,
      "oauth:session_revision": null,
    });
    expect(first["oauth:session_revision"]).not.toBe(primary["oauth:session_revision"]);
    const repeated = await target.call("apply", { envelope });
    expect(repeated.status).toBe("already-applied");
    expect(repeated.mutations).toHaveLength(0);
    expect(await target.call("read", { keys: KEYS })).toEqual(first);
    await target.call("apply", { envelope: { ...envelope, syncId: "e2e-v3-new-delivery" } });
    expect((await target.call("read", { keys: KEYS }))["oauth:session_revision"]).not.toBe(
      first["oauth:session_revision"],
    );
    const availability = await target.call("availability");
    expect(availability.loginProvider).toBe("zai_cn");
    expect(availability.families).toContain("bigmodel");
  });
  it("写入后失败整组回滚，并保留并发新登录", async function () {
    this.timeout(90_000);
    await target.call("seed", {
      values: {
        ...primary,
        "oauth:session_revision": "e2e-before",
        zcodejwttoken: "e2e-before-primary",
      },
    });
    const before = await target.call("read", { keys: KEYS });
    const envelope = await source.call("source", { syncId: "e2e-rollback" });
    await target.call("hold-profile");
    await target.call("fault", { mode: "after-write" });
    expect((await target.call("apply", { envelope })).status).toBe("failed");
    const restored = await target.call("read", { keys: KEYS });
    expect({ ...restored, "oauth:session_revision": null }).toEqual({
      ...before,
      "oauth:session_revision": null,
    });
    expect(await target.call("finish-profile")).toBe(false);
    expect(restored["oauth:session_revision"]).not.toBe(before["oauth:session_revision"]);
    await target.call("fault", { mode: "concurrent-login" });
    const conflict = await target.call("apply", {
      envelope: { ...envelope, syncId: "e2e-conflict" },
    });
    expect(conflict.status).toBe("rollback_failed");
    expect(await target.call("read", { keys: KEYS })).toEqual({
      ...primary,
      "oauth:session_revision": "e2e-concurrent-revision",
      zcodejwttoken: "e2e-concurrent-primary",
    });
  });
  it("旧 v2 不继承目标关联和 revision，手工 Key 保留", async function () {
    this.timeout(90_000);
    const sourceEnvelope = await source.call("source", { syncId: "e2e-legacy" });
    const credentials = [
      { scope: "oauth-session", key: "oauth:active_provider", value: "bigmodel" },
      { scope: "oauth-session", key: "oauth:bigmodel:access_token", value: "e2e-legacy-business" },
      {
        scope: "oauth-session",
        key: "oauth:bigmodel:user_info",
        value: JSON.stringify({ id: "e2e-legacy", username: "legacy" }),
      },
      { scope: "oauth-session", key: "zcodejwttoken", value: "e2e-legacy-primary" },
    ];
    const result = await target.call("apply", {
      envelope: { ...sourceEnvelope, schemaVersion: 2, credentials },
    });
    expect(result.status).toBe("applied");
    const saved = await target.call("read", { keys: [...KEYS, "manual:e2e:key"] });
    expect(saved["oauth:linked_bigmodel"]).toBeNull();
    expect(saved["oauth:zai_cn:access_token"]).toBeNull();
    expect(saved["oauth:session_revision"]).toBeTruthy();
    expect(saved["oauth:session_revision"]).not.toBe("e2e-concurrent-revision");
    expect(saved["manual:e2e:key"]).toBe("e2e-manual");
  });
  it("拒绝旧版本夹带新字段和重复字段，保持目标零写入", async function () {
    this.timeout(90_000);
    const envelope = await source.call("source", { syncId: "e2e-invalid" });
    const before = await target.call("read", { keys: KEYS });
    await expect(
      target.call("apply", { envelope: { ...envelope, schemaVersion: 2 } }),
    ).rejects.toThrow("不允许同步");
    await expect(
      target.call("apply", {
        envelope: {
          ...envelope,
          syncId: "e2e-duplicate",
          credentials: [...envelope.credentials, envelope.credentials[0]],
        },
      }),
    ).rejects.toThrow("重复");
    expect(await target.call("read", { keys: KEYS })).toEqual(before);
  });
  it("退出同步清除整组账号材料，保留手工 Key", async function () {
    this.timeout(90_000);
    await source.call("seed", { values: empty });
    const envelope = await source.call("source", { syncId: "e2e-logout" });
    expect((await target.call("apply", { envelope })).status).toBe("applied");
    const saved = await target.call("read", { keys: KEYS });
    expect({ ...saved, "oauth:session_revision": null }).toEqual(empty);
    expect(saved["oauth:session_revision"]).toBeTruthy();
    expect(await target.call("availability")).toMatchObject({
      loginProvider: null,
      userId: null,
      families: [],
    });
    expect(await target.call("read", { keys: ["manual:e2e:key"] })).toEqual({
      "manual:e2e:key": "e2e-manual",
    });
  });
});
