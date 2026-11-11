import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";

import {
  hasRequiredSshE2EEnvironment,
  isFormalSpecAdmittedByEnvironment,
  isSshFormalSpec,
  isExplicitE2ESpecSelection,
  MANUAL_REVIEW_SPEC_GLOB,
  resolveEnvironmentGatedFormalSpecExcludes,
  SSH_FORMAL_SPEC_GLOB,
} from "../scripts/e2e-formal-spec-selection.mjs";

describe("desktop E2E environment-gated formal spec admission", () => {
  it("loads public admission rules without the internal remote harness", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "e2e-public-admission-"));
    try {
      const scripts = join(fixture, "packages/desktop/scripts");
      await mkdir(scripts, { recursive: true });
      for (const file of [
        "e2e-formal-spec-selection.mjs",
        "e2e-remote-target-specs.json",
        "r3-remote-spec-inventory.mjs",
      ]) {
        await copyFile(resolve("packages/desktop/scripts", file), join(scripts, file));
      }
      const admission = await import(
        pathToFileURL(join(scripts, "e2e-formal-spec-selection.mjs")).href
      );
      expect(
        admission.resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
      ).toContain(
        "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
      );
      expect(
        admission.isSshFormalSpec(
          "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
        ),
      ).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("excludes every manual-review domain from the default recursive glob", () => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(scheduled).toContain("test/e2e/infrastructure/smoke/smoke.test.ts");
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
  });

  it.each(["bots", "settings", "feedback"])(
    "keeps explicit %s candidates discoverable",
    async (domain) => {
      const fixture = await mkdtemp(join(tmpdir(), "e2e-spec-discovery-"));
      try {
        // 转正后领域可以没有候选；发现规则必须使用独立 fixture，不能依赖仓库一直留有 pending。
        const directory = join(fixture, "test/e2e", domain, "manual-review/pending");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "example.test.ts"), "");
        const scheduled = resolveE2EScheduledSpecFiles({
          baseDir: fixture,
          specs: [`./test/e2e/${domain}/manual-review/**/*.test.ts`],
          exclude: [],
        });
        expect(scheduled).toEqual([`test/e2e/${domain}/manual-review/pending/example.test.ts`]);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("applies environment gates to formal globs but keeps exact-file runs fail-closed", () => {
    const glob = ["./test/e2e/conversation-session/*.test.ts"];
    // 此处验证 canonical 正式目标；实际候选可以暂留 pending，不能随目录回退改掉门禁输入。
    const file = [
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    ];
    expect(isExplicitE2ESpecSelection(glob)).toBe(false);
    expect(isExplicitE2ESpecSelection([])).toBe(false);
    expect(isExplicitE2ESpecSelection(file)).toBe(true);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(glob),
      }),
    ).toContain(file[0]);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(file),
      }),
    ).toEqual([]);
  });

  it("gates promoted remote targets while retaining local offline coverage", () => {
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/navigation/conversation-session-chat-remote-folder.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
      ),
    ).toBe(false);
    expect(isSshFormalSpec("./test/e2e/bots/runtime/bot-r3-workspace-identity.test.ts")).toBe(
      false,
    );
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    );
  });

  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/**/conversation-session-ssh-remote*.test.ts",
    );
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
      ZCODE_E2E_SSH_CONTAINER: "zcode-r3-server-example",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toEqual([]);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it("requires the harness container for queued remote targets", () => {
    // 远程队列按 case 准备干净目标；只有共享 SSH 凭据的 runner 不能运行这些用例。
    const credentials = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    const queued =
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts";
    const queuedSshRemote =
      "./test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-development-p0.test.ts";
    // 尚未排进队列的 ssh-remote 用例只依赖真实服务器凭据。
    const unqueuedSshRemote =
      "./test/e2e/conversation-session/conversation-session-ssh-remote-example.test.ts";
    const excludes = resolveEnvironmentGatedFormalSpecExcludes({
      env: credentials,
      targeted: false,
    });
    expect(excludes).toContain(queued);
    expect(excludes).toContain(queuedSshRemote);
    expect(excludes).not.toContain(SSH_FORMAL_SPEC_GLOB);
    expect(isFormalSpecAdmittedByEnvironment(queued, credentials)).toBe(false);
    expect(isFormalSpecAdmittedByEnvironment(queuedSshRemote, credentials)).toBe(false);
    expect(isFormalSpecAdmittedByEnvironment(unqueuedSshRemote, credentials)).toBe(true);
    expect(isFormalSpecAdmittedByEnvironment(unqueuedSshRemote, {})).toBe(false);
    expect(
      isFormalSpecAdmittedByEnvironment(queued, {
        ...credentials,
        ZCODE_E2E_SSH_CONTAINER: "zcode-r3-server-example",
      }),
    ).toBe(true);
    expect(
      isFormalSpecAdmittedByEnvironment(
        "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
        {},
      ),
    ).toBe(true);
  });

  it("keeps nested formal scenarios discoverable and nested candidates excluded", () => {
    const formal = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/conversation-session/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(formal).toContain(
      "test/e2e/conversation-session/composer/conversation-session-first-send.test.ts",
    );
    expect(formal).toContain(
      "test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-banner-reconnect.test.ts",
    );
    expect(formal.some((spec) => spec.includes("/manual-review/"))).toBe(false);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-example.test.ts",
      ),
    ).toBe(true);
  });

  it("uses the shared admission helper in the WDIO exclude list", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveEnvironmentGatedFormalSpecExcludes({");
    expect(source).toContain("hasRequiredSshE2EEnvironment(process.env)");
  });
});
