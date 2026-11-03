import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createOfficialMcpTrustedOriginRegistry } from "@zcode/shared";
import { createZCodeAgentService, getDataBaseDir, setDataBaseDir } from "@zcode/services/node";
import {
  getTasksIndexDatabasePath,
  prepareTasksIndexStorage,
} from "@zcode/services/storage-startup";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  OFFICIAL_AUTH_ROUTING_PLUGIN,
  OFFICIAL_AUTH_ROUTING_SERVER,
} from "#e2e/helpers/mcp-official-auth-routing-fixture";

/** 可重复运行时场景：真实 service + CLI + MCP；只替代凭证端口并注入恶意反向协议帧。 */
export async function runOfficialMcpRoutingRuntime(artifactDir: string): Promise<void> {
  const paths = getE2EAppDataPaths();
  const home = await mkdtemp(join(paths.homeDir, "mcp-auth-runtime-"));
  const previous = getDataBaseDir();
  const origin = process.env.ZCODE_E2E_OFFICIAL_AUTH_ROUTING_URL;
  assert(origin, "Missing controlled MCP origin");
  const evidenceFile = join(home, "rejected-requests.ndjson");
  const cliRoot = join(home, ".zcode", "cli");
  const workspaceA = join(home, "project-a");
  const workspaceB = join(home, "project-b");
  await Promise.all(
    [cliRoot, workspaceA, workspaceB].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(evidenceFile, "");
  await writeFile(
    join(cliRoot, "config.json"),
    JSON.stringify({
      plugins: {
        enabled: true,
        dirs: [join(paths.storageRoot, "cli", "e2e-fixtures", OFFICIAL_AUTH_ROUTING_PLUGIN)],
      },
    }),
  );
  setDataBaseDir(home);
  let loggedIn = true;
  const issued: Array<{ key: string; workspace: string }> = [];
  const exited: number[] = [];
  try {
    await prepareTasksIndexStorage(getTasksIndexDatabasePath(), () => {});
    const service = createZCodeAgentService({
      mcpStatusIdleTimeoutMs: 1_000,
      commandResolver: ({ workspacePath }) => ({
        command: process.execPath,
        args: [
          resolve("test/e2e/fixtures/mcp/official-auth-routing-proxy.mjs"),
          resolve("../../apps/zcode-cli/packages/cli/dist/zcode.cjs"),
          evidenceFile,
          workspacePath.endsWith("plugin-workspace") ? "probe" : "passthrough",
        ],
        env: {
          HOME: home,
          USERPROFILE: home,
          ZCODE_DATA_BASE_DIR: home,
          ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS: origin,
        },
      }),
      officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: origin,
        resolveZCodeApiOrigin: () => "https://example.com",
      }),
      officialMcpAuthHeadersResolver: {
        async resolveHeaders(request) {
          issued.push({ key: request.mcpKey, workspace: request.workspace.workspaceKey });
          return loggedIn
            ? { ok: true, headers: { Authorization: "Bearer mock-token" } }
            : { ok: false, reason: "official_auth_unavailable" };
        },
      },
      processLifecycleReporter: {
        onSpawn() {},
        onExit(event) {
          if (event.lane === "mcp-status") exited.push(event.pid);
        },
      },
    });
    try {
      const connected = async (workspacePath: string) => {
        const result = await service.listMcpServerStatuses({ workspacePath });
        assert.equal(result.statuses[OFFICIAL_AUTH_ROUTING_SERVER]?.status, "connected");
      };
      // 尚无聊天进程时，管理进程已能反向取身份。
      await connected(workspaceA);
      await assert.rejects(service.getWorkspaceRuntimeIdentity({ workspacePath: workspaceA }));
      // 同一项目已有真实聊天 CLI 后，控制面仍独立工作。
      await service.listSessions({ workspacePath: workspaceA });
      const chatBefore = await service.getWorkspaceRuntimeIdentity({ workspacePath: workspaceA });
      await Promise.all([connected(workspaceB), connected(workspaceA)]);
      assert.deepEqual(
        await service.getWorkspaceRuntimeIdentity({ workspacePath: workspaceA }),
        chatBefore,
      );
      assert(issued.some((entry) => entry.workspace === workspaceA));
      assert(issued.some((entry) => entry.workspace === workspaceB));
      const waitForIdleExit = async () => {
        const previousExits = exited.length;
        const deadline = Date.now() + 10_000;
        while (exited.length === previousExits && Date.now() < deadline) await pause(25);
        assert(exited.length > previousExits, "MCP status lane did not exit after idle timeout");
      };
      await waitForIdleExit();
      await connected(workspaceA);
      assert.deepEqual(
        await service.getWorkspaceRuntimeIdentity({ workspacePath: workspaceA }),
        chatBefore,
      );
      loggedIn = false;
      // 等待当前控制面按既有 idle 策略退出，下一次刷新必须在新进程中重新取身份。
      await waitForIdleExit();
      const signedOut = await service.listMcpServerStatuses({ workspacePath: workspaceA });
      await writeFile(
        join(artifactDir, "OMCP-SETTINGS-signout.json"),
        JSON.stringify(signedOut, null, 2),
      );
      assert.equal(
        signedOut.statuses[OFFICIAL_AUTH_ROUTING_SERVER]?.failureKind,
        "not_authenticated",
      );
      const probes = (await readFile(evidenceFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const kind of ["unregistered", "identity", "consumer", "malformed"]) {
        assert(
          probes.some((probe) => probe.kind === kind && probe.code === -32602),
          kind,
        );
      }
      assert(
        probes.some(
          (probe) => probe.kind === "origin" && probe.reason === "official_mcp_origin_untrusted",
        ),
      );
      assert(
        !issued.some((entry) => entry.key.startsWith("probe-")),
        "Rejected request read credentials",
      );
      await writeFile(
        join(artifactDir, "OMCP-SETTINGS-02-03-runtime.json"),
        JSON.stringify({ issued, probes, exited }, null, 2),
      );
    } finally {
      await service.disposeAllAndWait();
    }
  } finally {
    setDataBaseDir(previous);
  }
}
