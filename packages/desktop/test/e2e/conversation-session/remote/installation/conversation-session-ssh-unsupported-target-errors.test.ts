import { generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import ssh2 from "ssh2";
import { TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openRemoteConnectionSelection,
  prepareSSHConnectionPage,
  waitForSSHError,
} from "#e2e/helpers/ssh-remote-p0";

const MARKER = "E2E_SSH_UNSUPPORTED_TARGET_ERRORS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-unsupported-target-errors",
);

interface TargetCase {
  id: string;
  env: string;
  title: string;
  reason: string;
  forbidden: string[];
  /** 折叠的“详细信息”里必须保留的原始诊断片段。 */
  details?: string;
  /** 架构在用户确认安装、解析发行包时才被拒绝：先点“安装并继续”再等错误。 */
  confirmInstall?: boolean;
}

// RDUX-11-05、07：3.14/3.15 远程反馈复核中二次验证与 Windows 原生 shell 两类“目标不受支持”的失败，
// 连接中屏必须给出专用原因，而不是“检查密码”“远端环境检查失败”或乱码。
// RDUX-11-06（旧 glibc 拒绝）已撤销：旧 glibc / musl 改为只在连接日志警告并继续，
// 由 conversation-session-r3-install-environment 的 old-glibc 子用例覆盖。
// RDUX-11-08：只有乱码不是 Windows 证据，必须保持预检失败并保留原始 stderr。
// RDUX-11-09：提示轮数不是二次验证证据，重复问 Password 的主机输错密码仍是认证失败。
// RDUX-11-10：架构不受支持（riscv64）时显示系统不受支持，详细信息保留完整的中文原因。
const CASES: TargetCase[] = [
  {
    id: "RDUX-11-05",
    env: "ZCODE_E2E_SSH_SECOND_FACTOR_TARGET",
    title: "服务器要求额外验证",
    reason: "当前只支持密码、私钥和 SSH agent 登录",
    forbidden: ["请检查 SSH 用户名、密码或私钥"],
  },
  {
    // 登录 shell 模拟中文 PowerShell：GBK 报错里带英文 CommandNotFoundException 特征。
    id: "RDUX-11-07",
    env: "ZCODE_E2E_SSH_WINDOWS_SHELL_TARGET",
    title: "不支持该设备的系统",
    reason: "WSL",
    forbidden: ["远端环境检查失败", "�"],
  },
  {
    // 登录 shell 只输出 GBK 报错（中文 cmd 的“系统找不到指定的路径。”）后非零退出。
    id: "RDUX-11-08",
    env: "ZCODE_E2E_SSH_GARBLED_SHELL_TARGET",
    title: "远端环境检查失败",
    reason: "设备环境不满足安装要求",
    forbidden: ["不支持该设备的系统"],
    details: "�",
  },
  {
    // PATH 里的 `uname -m` 被包装成 riscv64；probe 成功。安装确认的预览会吞掉解析失败，
    // 用户确认安装后 release resolver 才拒绝该架构。
    // Bug 场景：原因写成“Linux / macOS”，脱敏把空格后的 `/` 当作路径，详细信息只剩“Linux [redacted-path]”。
    id: "RDUX-11-10",
    env: "ZCODE_E2E_SSH_RISCV64_TARGET",
    title: "不支持该设备的系统",
    reason: "远程连接只支持 Linux 和 macOS",
    forbidden: ["下载失败", "远端环境检查失败"],
    details: "当前不支持 linux-riscv64 设备：远程服务只提供 Linux、macOS 的 x64 与 arm64 版本",
    confirmInstall: true,
  },
];

function readTarget(item: TargetCase) {
  // 格式：user:password@host:port；目标是本机隔离 Docker sshd，凭据只用于测试容器。
  const match = /^([^:@]+):([^@]+)@([^:]+):(\d+)$/u.exec(process.env[item.env]?.trim() ?? "");
  if (!match) throw new Error(`${MARKER}: ${item.env} 需要 user:password@host:port`);
  return {
    username: match[1]!,
    password: match[2]!,
    host: match[3]!,
    port: Number(match[4]),
  };
}

async function captureErrorScreen(name: string) {
  await mkdir(artifactDir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await browser.execute((value) => {
      const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
        .__testActions;
      if (!actions) throw new Error("Missing theme test actions");
      actions.setTheme(value);
    }, theme);
    for (const width of [1440, 900]) {
      await browser.electron.execute((electron, size) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed())
          ?.setSize(size, 900);
      }, width);
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      await browser.saveScreenshot(join(artifactDir, `${name}-${theme}-${width}.png`));
    }
  }
}

// wdio 以原生 ESM 加载 spec，CJS 的 ssh2 没有具名导出，只能取默认导出。
const { Server: SSHServer } = ssh2;

// RDUX-11-09：Linux x64、未安装的环境探测输出；改正密码后连接停在安装确认，证明认证已通过。
const NOT_INSTALLED_PROBE_OUTPUT =
  "__ZCODE_PROBE_PLATFORM__\nLinux\n__ZCODE_PROBE_ARCH__\nx86_64\n" +
  "__ZCODE_PROBE_ROOT__\n/home/dev/.zcode/server\n__ZCODE_PROBE_KERNEL__\nLinux\n" +
  "__ZCODE_PROBE_LIBC__\nglibc 2.35\n__ZCODE_PROBE_INSTALLED__\n0\n" +
  "__ZCODE_PROBE_VERSION__\n\n__ZCODE_PROBE_STATUS__\n\n__ZCODE_PROBE_END__\n";

/**
 * 同一次 keyboard-interactive 交换里最多连问 3 次 `Password:` 的模拟服务端。
 * OpenSSH + Linux-PAM 的 pam_get_authtok 会复用已缓存的密码，造不出这种主机，所以在测试进程内启动。
 */
async function startRepeatedPasswordPromptServer(password: string) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const clients = new Set<{ end(): void }>();
  const server = new SSHServer({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      if (ctx.method !== "keyboard-interactive") {
        ctx.reject(["keyboard-interactive"]);
        return;
      }
      let round = 0;
      const ask = () =>
        ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
          if (answers[0] === password) ctx.accept();
          else if (++round < 3) ask();
          else ctx.reject();
        });
      ask();
    });
    client.on("session", (acceptSession) => {
      acceptSession().on("exec", (acceptExec) => {
        const stream = acceptExec();
        stream.write(NOT_INSTALLED_PROBE_OUTPUT);
        stream.exit(0);
        stream.end();
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    // 应用停在安装确认时仍保持 SSH 连接；server.close 会等所有连接结束，先主动断开。
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        for (const client of clients) client.end();
      }),
  };
}

async function confirmInstallInDialog(caseLabel: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find(
          (item) =>
            !item.disabled && /^(安装并继续|Install and continue)$/u.test(item.innerText.trim()),
        );
        button?.click();
        return Boolean(button);
      }),
    { timeout: 60_000, interval: 500, timeoutMsg: `${caseLabel}: 没有出现安装确认` },
  );
}

async function closeSSHDialog() {
  await browser.keys("Escape");
  await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true, timeout: 15_000 });
}

describe(`${MARKER}: 不受支持目标的连接错误`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-11-05/07/08/10 二次验证、Windows 原生 shell、乱码与不支持架构失败的原因", async function () {
    this.timeout(15 * 60_000);
    await prepareSSHConnectionPage(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    for (const item of CASES) {
      const target = readTarget(item);
      await openRemoteConnectionSelection();
      await $('[data-testid="remote-kind-ssh"]').click();
      await fillSSHPasswordSettings(target);
      await clickLastEnabledSSHDialogButton(MARKER);
      if (item.confirmInstall) await confirmInstallInDialog(`${MARKER} ${item.id}`);

      const errorText = await waitForSSHError(`${MARKER} ${item.id}`);
      expect(errorText).toContain(item.title);
      expect(errorText).toContain(item.reason);
      for (const text of item.forbidden) expect(errorText).not.toContain(text);
      if (item.details) {
        const details = await browser.execute(
          () => document.querySelector('[data-testid="ssh-error"] details pre')?.textContent ?? "",
        );
        expect(details).toContain(item.details);
      }
      const panel = await browser.execute(() => {
        const dialog = document.querySelector('[data-testid="ssh-dialog"]');
        return {
          // 二次验证不能引导用户重输密码；其余两类也不能落到凭据补充交互。
          passwordInError: Boolean(
            document.querySelector('[data-testid="ssh-error"] input[type="password"]'),
          ),
          installConfirmation: Array.from(dialog?.querySelectorAll("button") ?? []).some((button) =>
            /安装并继续|Install and continue/u.test(button.textContent ?? ""),
          ),
        };
      });
      expect(panel).toEqual({ passwordInError: false, installConfirmation: false });
      await captureErrorScreen(item.id);
      await closeSSHDialog();
    }
  });

  it("RDUX-11-09 重复问 Password 的主机输错密码后仍可就地补密码", async function () {
    this.timeout(5 * 60_000);
    const correctPassword = "e2e-correct-password";
    const server = await startRepeatedPasswordPromptServer(correctPassword);
    try {
      await openRemoteConnectionSelection();
      await $('[data-testid="remote-kind-ssh"]').click();
      await fillSSHPasswordSettings({
        username: "dev",
        password: "e2e-wrong-password",
        host: "127.0.0.1",
        port: server.port,
      });
      await clickLastEnabledSSHDialogButton(MARKER);

      // Bug 场景：服务端同一轮连问 3 次 Password，旧逻辑按轮数判成“要求额外验证”，不给密码框。
      const errorText = await waitForSSHError(`${MARKER} RDUX-11-09`);
      expect(errorText).toContain("SSH 认证失败");
      expect(errorText).not.toContain("服务器要求额外验证");
      const inlineCredentials = await browser.execute(() =>
        Boolean(
          document.querySelector('[data-testid="ssh-error"] input[type="password"]')?.closest("li"),
        ),
      );
      expect(inlineCredentials).toBe(true);
      await captureErrorScreen("RDUX-11-09");

      await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, correctPassword);
      await clickLastEnabledSSHDialogButton(MARKER);
      await browser.waitUntil(
        async () =>
          await browser.execute(() =>
            Array.from(
              document.querySelector('[data-testid="ssh-dialog"]')?.querySelectorAll("button") ??
                [],
            ).some((button) => /安装并继续|Install and continue/u.test(button.textContent ?? "")),
          ),
        {
          timeout: 60_000,
          interval: 500,
          timeoutMsg: `${MARKER} RDUX-11-09: 改正密码后没有进入安装确认`,
        },
      );
      await closeSSHDialog();
    } finally {
      await server.close();
    }
  });
});
