import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
  type SSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_INSTALL_ENVIRONMENT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-install-environment",
);
// old-glibc-runtime 需要真实 glibc < 2.28 的远端镜像，不注入 getconf。服务器队列没有该档位，
// 只能本机运行，构建与运行命令见 harness/remote/README.md「低版本 glibc 目标」。
type InstallEnvironmentCase =
  | "noexec-tmp"
  | "no-tar"
  | "no-forwarding"
  | "old-glibc"
  | "old-glibc-runtime";
const SUBCASES: InstallEnvironmentCase[] = [
  "noexec-tmp",
  "no-tar",
  "no-forwarding",
  "old-glibc",
  "old-glibc-runtime",
];
const SUBCASE = (process.env.R3_INSTALL_ENV_CASE ?? "") as InstallEnvironmentCase;

async function readRemoteFacts(config: SSHConnectionConfig) {
  const facts = await runSSHCommand(
    config,
    'echo "tmp=$(mount | grep " /tmp " | head -n1)"; echo "tar=$(command -v tar || echo none)"; ' +
      'echo "forwarding=$(grep -iE "^AllowTcpForwarding" /etc/ssh/sshd_config | tail -n1)"; ' +
      'echo "current=$(test -f "$HOME/.zcode/server/current.json" && grep -o \'"archiveSha256": *"[0-9a-f]*"\' "$HOME/.zcode/server/current.json" || echo none)"; ' +
      'echo "staging=$(ls -d "$HOME"/.zcode/server/staging* "$HOME"/.zcode/server/bootstrap* 2>/dev/null | tr "\\n" ",")"; ' +
      'echo "serverRoot=$(ls -A "$HOME/.zcode/server" 2>/dev/null | tr "\\n" ",")"; ' +
      'echo "libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || echo none)"; ' +
      'echo "tmpEntries=$(ls /tmp 2>/dev/null | tr "\\n" ",")"; echo "status=$(cat "$HOME/.zcode/server/run/status.json" 2>/dev/null | tr -d "\\n ")"',
  );
  return Object.fromEntries(
    facts.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  ) as Record<string, string>;
}

/** 沿现行项目优先流程完成首装、选目录和绑定；仅把真实向导错误作为失败结果。 */
async function connectUntilErrorOrReady(config: SSHRuntimeConfig): Promise<{
  errorText: string;
  connectionLog: string;
  ready: boolean;
}> {
  await openSSHRemoteDialog(CASE_MARKER);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  try {
    // 原脚本等向导自行关闭，但首连成功会停在目录页，导致成功连接也耗尽 180 秒。
    const phase = await waitForSSHDirectoryStep(CASE_MARKER, 180_000);
    expect(phase).toBe("directory");
    await selectSSHRemoteDirectory(config.workspacePaths[0]!, CASE_MARKER);
    const project = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0]!,
    });
    expect(project.remoteSessionId).toBeTruthy();
    return { errorText: "", connectionLog: "", ready: true };
  } catch (error) {
    const failure = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="ssh-error"]');
      if (!panel?.getClientRects().length) return null;
      return {
        errorText: panel.innerText.trim(),
        connectionLog:
          document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]')?.innerText ?? "",
        ready: false,
      };
    });
    if (!failure) throw error;
    return failure;
  }
}

describe(`${CASE_MARKER}: 受限远端环境下的安装与连接（${SUBCASE}）`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`R3A-BLD-09/CON-06 ${SUBCASE}`, async function () {
    this.timeout(20 * 60_000);
    if (!SUBCASES.includes(SUBCASE)) {
      throw new Error(`${CASE_MARKER}: R3_INSTALL_ENV_CASE 必须为 ${SUBCASES.join("|")}`);
    }
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const before = await readRemoteFacts(config);
    expect(before.current).toBe("none");
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      const state = window as Window & {
        __installEnvironmentLogs?: Array<{ message: string; level: string }>;
        zcode?: {
          onRemoteConnectionLog: (
            callback: (entry: { message: string; level: string }) => void,
          ) => () => void;
        };
      };
      state.__installEnvironmentLogs = [];
      if (!state.zcode) throw new Error("Missing desktop platform");
      state.zcode.onRemoteConnectionLog(({ message, level }) =>
        state.__installEnvironmentLogs!.push({ message, level }),
      );
    });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    const outcome = await connectUntilErrorOrReady(config);
    const connectionLogs = await browser.execute(
      () =>
        (
          window as Window & {
            __installEnvironmentLogs?: Array<{ message: string; level: string }>;
          }
        ).__installEnvironmentLogs ?? [],
    );
    const after = await readRemoteFacts(config);
    const hosts = await readHostProcesses();
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, `${SUBCASE}.json`),
      JSON.stringify({ subcase: SUBCASE, before, outcome, connectionLogs, after, hosts }, null, 2),
    );
    expect(hosts).toEqual(initialHosts);
    expect(outcome.errorText).not.toContain(config.password);

    if (SUBCASE === "noexec-tmp") {
      // /tmp 为受限 noexec tmpfs：archive 与 bootstrap 必须落在 Server root 私有 staging，安装照常成功。
      expect(before.tmp).toContain("noexec");
      if (!outcome.ready)
        throw new Error(`${CASE_MARKER}: noexec-tmp 安装失败: ${outcome.errorText}`);
      expect(after.current).toMatch(/archiveSha256/u);
      expect(after.status).toContain('"state":"ready"');
      expect(after.tmpEntries).not.toContain("zcode-server");
      return;
    }
    if (SUBCASE === "no-tar") {
      // tar 缺失应在上传前 preflight 早失败：不上传 74MB、不留 staging、不写 current。
      expect(before.tar).toBe("none");
      expect(outcome.ready).toBe(false);
      // 主面板按当前合同给出环境分类，缺失工具的原始原因在展开的连接日志中。
      expect(outcome.errorText).toMatch(/环境|environment/iu);
      expect(outcome.connectionLog.toLowerCase()).toContain("tar");
      expect(outcome.connectionLog).not.toMatch(/Uploading|上传/u);
      expect(after.current).toBe("none");
      return;
    }
    if (SUBCASE === "old-glibc") {
      // 仅注入 getconf 的低版本报告，真实 runtime 仍可运行：警告不得阻断首装、握手和项目绑定。
      expect(before.libc).toBe("glibc 2.17");
      expect(connectionLogs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(/glibc 2\.17.*glibc 2\.28.*may fail.*Continuing/u),
        }),
      );
      expect(outcome.errorText).toBe("");
      expect(outcome.ready).toBe(true);
      expect(after.current).toMatch(/archiveSha256/u);
      expect(after.status).toContain('"state":"ready"');
      return;
    }
    if (SUBCASE === "old-glibc-runtime") {
      // 真实低版本 glibc：随包 Node 在解压后的 update 命令里动态链接失败，安装按原错误通道失败。
      // ZCT-2115996335380615168：连接日志须遮住路径，但保留动态链接器给出的缺失符号。
      expect(before.libc).toMatch(/^glibc 2\.(?:1\d|2[0-7])$/u);
      expect(outcome.ready).toBe(false);
      expect(connectionLogs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(/glibc 2\.\d+.*glibc 2\.28.*may fail.*Continuing/u),
        }),
      );
      const errorLogs = connectionLogs.filter((entry) => entry.level === "error");
      expect(errorLogs.map((entry) => entry.message).join("\n")).toMatch(
        /\[redacted-path\]: version `GLIBC_2\.28' not found \(required by \[redacted-path\]\)/u,
      );
      for (const entry of connectionLogs) {
        expect(entry.message).not.toMatch(/\/home\/dev|\.bootstrap-/u);
      }
      expect(after.current).toBe("none");
      return;
    }
    // 主规格与 Transport Adapter 明确支持 direct-tcpip 被禁后回退 proxy-stdio。
    // 任意非空错误不能算通过；必须证明安装、握手、目录 RPC 和项目绑定都成功。
    expect((before.forwarding ?? "").toLowerCase()).toContain("allowtcpforwarding no");
    expect(outcome.errorText).toBe("");
    expect(outcome.ready).toBe(true);
    expect(after.current).toMatch(/archiveSha256/u);
    expect(after.status).toContain('"state":"ready"');
    expect(
      (await readRemoteTabSnapshot(undefined, config.workspacePaths[0])).remoteSessionId,
    ).toBeTruthy();
  });
});
