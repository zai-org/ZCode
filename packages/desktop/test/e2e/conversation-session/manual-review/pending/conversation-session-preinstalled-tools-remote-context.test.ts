import { preinstalledFixtureRecordPath } from "#e2e/helpers/preinstalled-tools-fixture";
import { writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { prepareSSHConnectionPage, readSSHRuntimeConfig } from "#e2e/helpers/ssh-remote-p0";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";

import {
  createSSHLifecycleProvider,
  connectSSHWorkspaceAndSendFirstTurn,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";

const MARKER = "E2E_LOP_REMOTE_CONTEXT";

describe("远端工作区的本机预装工具（待审核）", () => {
  let provider: SSHLifecycleProvider | undefined;
  after(async () => {
    await provider?.tunnel.close();
  });
  it("LOP-24: 远端提示明确，取消只作用于本机准备", async function () {
    this.timeout(8 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const container = readRemoteDockerContainer(MARKER);
    await prepareSSHConnectionPage(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 仅连接项目可能没有 Agent，空进程集合曾让环境隔离断言无条件通过。
    provider = await createSSHLifecycleProvider(config, MARKER, { apiType: "anthropic-messages" });
    const remote = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: MARKER,
      config,
      provider,
      label: "A",
      workspacePath: config.workspacePaths[0],
    });
    expect(remote.remoteSessionId).toBeTruthy();
    const before = await execInRemoteContainer(container, [
      "sh",
      "-c",
      'test ! -e "$HOME/.zcode/preinstalled-tools" && printf "E2E_LOP_REMOTE_ABSENT\\n"',
    ]);
    expect(before.stdout.trim()).toBe("E2E_LOP_REMOTE_ABSENT");
    await $('[data-testid="workspace-help-menu-trigger"]').click();
    await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
    await $('[data-testid="preinstalled-tools-remote-notice"]').waitForDisplayed();
    expect(await $('[data-testid="preinstalled-tools-remote-notice"]').getText()).toBe(
      "当前打开的是远端工作区。这里管理的是本机，不会安装到远端。",
    );
    await browser.waitUntil(
      async () =>
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-status")) === "preparing",
      { timeout: 30000 },
    );
    const fixtureUrl = process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
    const initial = (await (await fetch(`${fixtureUrl}/status`)).json()) as {
      requests: number;
      pending: number;
    };
    expect(initial).toMatchObject({ requests: 1, pending: 1 });
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-remote-context-preparing.png`,
    );
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
          "aria-checked",
        )) === "false" && (await $('[data-testid="preinstalled-tools-auto-install"]').isEnabled()),
      { timeout: 10000 },
    );
    await $('[data-testid="preinstalled-tools-cancel"]').click();
    await browser.waitUntil(
      async () =>
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-status")) === "not-installed",
      { timeout: 30000 },
    );
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    await expect(stat(await preinstalledFixtureRecordPath(root))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);
    const after = await execInRemoteContainer(container, [
      "sh",
      "-c",
      'test ! -e "$HOME/.zcode/preinstalled-tools" && printf "E2E_LOP_REMOTE_ABSENT\\n"',
    ]);
    expect(after.stdout.trim()).toBe("E2E_LOP_REMOTE_ABSENT");
    // CLI 会设置 process.title，Linux 的 cmdline 因而不再保留 app-server 参数。
    // 按实际进程名识别自然启动的 CLI，只读目标变量是否存在，不输出完整环境。
    const environment = await execInRemoteContainer(container, [
      "sh",
      "-c",
      `
for file in /proc/[0-9]*/cmdline; do
  pid="\${file%/cmdline}"; pid="\${pid##*/}"
  [ "$pid" = "$$" ] && continue
  [ -r "$file" ] || continue
  command=$(tr '\\000' ' ' < "$file" 2>/dev/null) || continue
  case "$command" in
    "zcode-cli "*|*" app-server --stdio"*)
      if grep -zq '^ZCODE_PREINSTALLED_TOOLS_AVAILABLE=' "/proc/$pid/environ"; then
        available=present
      else
        result=$?
        [ "$result" = 1 ] || exit "$result"
        available=absent
      fi
      if grep -zq '^PATH=.*preinstalled-tools' "/proc/$pid/environ"; then
        bin=present
      else
        result=$?
        [ "$result" = 1 ] || exit "$result"
        bin=absent
      fi
      printf '%s %s %s\\n' "$pid" "$available" "$bin"
      ;;
  esac
done
`,
    ]);
    const agents = environment.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, value, bin] = line.split(" ");
        expect(["present", "absent"]).toContain(bin);
        expect(["present", "absent"]).toContain(value);
        expect(Number.isSafeInteger(Number(pid)) && Number(pid) > 0).toBe(true);
        return {
          pid: Number(pid),
          availabilityPresent: value === "present",
          binPresent: bin === "present",
        };
      });
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.availabilityPresent).toBe(false);
      expect(agent.binPresent).toBe(false);
    }
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-remote-context.json"),
      JSON.stringify(
        {
          localPlatform: process.platform,
          localArch: process.arch,
          remoteWorkspaceIdentity: remote.identity,
          initialLocalDownload: initial,
          localRecordAbsent: true,
          remoteResourcesAbsent: true,
          observedRemoteAgents: agents,
        },
        null,
        2,
      ),
    );
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-remote-context-cancelled.png`,
    );
  });
});
