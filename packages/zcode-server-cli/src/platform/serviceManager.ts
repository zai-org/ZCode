import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { stablePathId, type ServerLayout } from "../runtime/paths.js";

export type ServicePlatform = "darwin" | "linux" | "win32";

export interface ServiceDescriptor {
  kind: "launchd" | "systemd" | "task-scheduler";
  name: string;
  content: string;
}

export interface ServiceCommandExecutor {
  run(command: string, args: readonly string[]): Promise<void>;
  runResult?: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ServiceCommandResult>;
}

export interface ServiceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function createDaemonServiceDescriptor(options: {
  platform: ServicePlatform;
  layout: ServerLayout;
}): ServiceDescriptor {
  return createServiceDescriptor({
    platform: options.platform,
    command: join(
      options.layout.stableBinDir,
      options.platform === "win32" ? "zcode.cmd" : "zcode",
    ),
    args: ["serve", "--supervisor", "--service-entry", "--server-root", options.layout.serverRoot],
    name: `com.zhipu.zcode.server.${stablePathId(options.layout.serverRoot)}`,
  });
}

export function serviceDescriptorPath(layout: ServerLayout, descriptor: ServiceDescriptor): string {
  const extension =
    descriptor.kind === "launchd" ? "plist" : descriptor.kind === "systemd" ? "service" : "json";
  return join(layout.serviceDir, `${descriptor.name}.${extension}`);
}

export function createServiceDescriptor(options: {
  platform: ServicePlatform;
  command: string;
  args?: string[];
  name?: string;
}): ServiceDescriptor {
  const name = options.name ?? "com.zhipu.zcode.server";
  const args = options.args ?? ["serve", "--daemon"];
  if (options.platform === "darwin") {
    return {
      kind: "launchd",
      name,
      // 正常 stop 会让 Supervisor 以 0 退出；只按异常退出重启，避免 launchd 的无条件
      // KeepAlive 把用户主动停止的 daemon 立即拉起。Supervisor 自身仍负责 Core 崩溃退避。
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[options.command, ...args].map((value) => `<string>${escapeXml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`,
    };
  }
  if (options.platform === "linux") {
    return {
      kind: "systemd",
      name,
      content: `[Unit]\nDescription=ZCode Server\n[Service]\nExecStart=${shellQuote(options.command)} ${args.map(shellQuote).join(" ")}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`,
    };
  }
  return {
    kind: "task-scheduler",
    name,
    content: JSON.stringify({
      taskName: name,
      command: options.command,
      args,
      trigger: "logon",
      runLevel: "leastPrivilege",
    }),
  };
}

async function defaultExecutorResult(
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Promise<ServiceCommandResult> {
  const { spawn } = await import("node:child_process");
  const env = await resolveServiceManagerEnvironment(command);
  return await new Promise<ServiceCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
      ...(options?.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (_code, signal) => {
      // Bug 原因：超时只杀死命令本身，后代持有管道会让 close 继续等待，阻塞 detached 启动。
      // 信号终止时关闭本端管道；正常退出仍等待 close 收齐响应，避免丢失 Version 属性。
      if (signal !== null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function defaultExecutor(command: string, args: readonly string[]): Promise<void> {
  const result = await defaultExecutorResult(command, args);
  if (result.exitCode !== 0) {
    const error = new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`,
    ) as Error & { exitCode?: number };
    error.exitCode = result.exitCode;
    throw error;
  }
}

const defaultServiceCommandExecutor: ServiceCommandExecutor = {
  run: defaultExecutor,
  runResult: defaultExecutorResult,
};

async function resolveServiceManagerEnvironment(
  command: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (command !== "systemctl" || typeof process.getuid !== "function") return undefined;
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim() || `/run/user/${process.getuid()}`;
  const busPath = join(runtimeDir, "bus");
  if (
    !(await access(busPath).then(
      () => true,
      () => false,
    ))
  )
    return undefined;
  const dbusAddress = process.env.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${busPath}`;
  if (
    process.env.XDG_RUNTIME_DIR === runtimeDir &&
    process.env.DBUS_SESSION_BUS_ADDRESS === dbusAddress
  ) {
    return undefined;
  }
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: dbusAddress,
  };
}

export async function isServiceManagerAvailable(
  platform: ServicePlatform,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<boolean> {
  if (!executor.runResult) return true;
  try {
    // Bug 原因：非交互 SSH 可能继承一个已失效的 D-Bus 地址，systemctl/launchctl 探测会
    // 占满连接预算。能力探测必须有界；真实 register/start 仍保留完整错误，不套该短超时。
    if (platform === "linux") {
      // Bug 原因：chroot/offline 会跳过 systemctl 探测但返回 0，导致无 user bus 时误入注册。
      // 必须收到 manager 的非空属性响应才确认可用，避免依赖本地化提示或覆盖离线设置。
      const result = await executor.runResult(
        "systemctl",
        ["--user", "show", "--property=Version"],
        { timeoutMs: 2_000 },
      );
      return result.exitCode === 0 && /^Version=\S.*$/mu.test(result.stdout);
    }
    if (platform === "darwin") {
      if (typeof process.getuid !== "function") return false;
      return (
        (
          await executor.runResult("launchctl", ["print", `user/${process.getuid()}`], {
            timeoutMs: 2_000,
          })
        ).exitCode === 0
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * systemd 注册失败的阶段：load 为 daemon-reload / enable，本次没有启动任何 unit；
 * start 为 unit 已启用后的 start。launchd 与 Task Scheduler 的注册错误不带阶段。
 */
type ServiceRegistrationStage = "load" | "start";

export function isServiceLoadFailure(error: unknown): boolean {
  return error instanceof Error && (error as { stage?: unknown }).stage === "load";
}

export async function registerService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  let stage: ServiceRegistrationStage | undefined;
  try {
    if (descriptor.kind === "launchd") {
      // Label 稳定但 plist 内容可能变化；先卸载旧 job，避免 load 失败后 start 唤醒旧参数。
      try {
        await executor.run("launchctl", ["unload", "-w", descriptorPath]);
      } catch (error: unknown) {
        if (!isServiceMissingError(error)) throw error;
      }
      await executor.run("launchctl", ["load", "-w", descriptorPath]);
      await executor.run("launchctl", ["start", descriptor.name]);
    } else if (descriptor.kind === "systemd") {
      // Bug 原因：`enable --now` 把装载和启动合成一次调用，失败时无法知道 unit 是否已启动，
      // 调用方只能一律报错。拆开后按失败阶段决定：装载失败时没有启动任何 unit，可以安全回退。
      stage = "load";
      await executor.run("systemctl", ["--user", "daemon-reload"]);
      await executor.run("systemctl", ["--user", "enable", descriptorPath]);
      stage = "start";
      // enable 按文件名创建 unit；用完整文件名 start，不依赖 systemd 补全后缀。
      await executor.run("systemctl", ["--user", "start", basename(descriptorPath)]);
    } else {
      const parsed = JSON.parse(descriptor.content) as {
        taskName: string;
        command: string;
        args: string[];
      };
      await executor.run("schtasks", [
        "/Create",
        "/TN",
        parsed.taskName,
        "/TR",
        [parsed.command, ...parsed.args]
          .map((value) => `"${value.replaceAll('"', '\\"')}"`)
          .join(" "),
        "/SC",
        "ONLOGON",
        "/F",
      ]);
      await executor.run("schtasks", ["/Run", "/TN", parsed.taskName]);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(`Failed to register service ${descriptor.name} (${descriptorPath}): ${message}`, {
        cause: error,
      }),
      stage ? { stage } : {},
    );
  }
}

const SYSTEMD_STATE_PROPERTIES = [
  "ActiveState",
  "SubState",
  "Result",
  "ExecMainStatus",
  "NRestarts",
] as const;

/**
 * 读取 OS service 当前状态的一行摘要，只用于 serve --daemon 等待失败时的错误详情（R2 §7.1）；查询有界，
 * 失败返回 undefined。
 *
 * Bug 原因（ZCT-2117253090228297728）：OS service 模式下 CLI 只按 status.json 等待 ready。unit 无法执行、
 * 被信号或 OOM 结束、重启次数耗尽，或进程仍在却不写状态时，错误都只有 "Timed out waiting for Server ready"，
 * 原因只留在服务管理器里，工单无从区分。
 */
export async function describeServiceState(
  descriptor: ServiceDescriptor,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<string | undefined> {
  if (!executor.runResult) return undefined;
  try {
    if (descriptor.kind === "systemd") {
      const result = await executor.runResult(
        "systemctl",
        [
          "--user",
          "show",
          `${descriptor.name}.service`,
          `--property=${SYSTEMD_STATE_PROPERTIES.join(",")}`,
        ],
        { timeoutMs: 2_000 },
      );
      if (result.exitCode !== 0) return undefined;
      const values = new Map(
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      const parts = SYSTEMD_STATE_PROPERTIES.flatMap((key) =>
        values.get(key) ? [`${key}=${values.get(key)}`] : [],
      );
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (descriptor.kind === "launchd") {
      const result = await executor.runResult("launchctl", ["list", descriptor.name], {
        timeoutMs: 2_000,
      });
      if (result.exitCode !== 0) return undefined;
      const pid = /"PID"\s*=\s*(\d+);/u.exec(result.stdout)?.[1];
      const lastExitStatus = /"LastExitStatus"\s*=\s*(-?\d+);/u.exec(result.stdout)?.[1];
      const parts = [
        ...(pid ? [`PID=${pid}`] : []),
        ...(lastExitStatus ? [`LastExitStatus=${lastExitStatus}`] : []),
      ];
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function unregisterService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  try {
    if (descriptor.kind === "launchd")
      await executor.run("launchctl", ["unload", "-w", descriptorPath]);
    else if (descriptor.kind === "systemd")
      await executor.run("systemctl", ["--user", "disable", "--now", descriptorPath]);
    else {
      if (await isMissingWindowsTask(descriptor, executor)) return;
      await executor.run("schtasks", ["/Delete", "/TN", descriptor.name, "/F"]);
    }
  } catch (error) {
    // 注册命令可能在写 descriptor 后失败，卸载时 OS 中并不存在对应服务。
    // 仅容忍“未注册/不存在”，权限或命令执行等真实失败仍需阻止删除运行数据。
    if (!isServiceMissingError(error, descriptor.kind === "task-scheduler")) throw error;
  }
}

function isServiceMissingError(error: unknown, allowWindowsFileNotFound = false): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode =
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
      ? error.exitCode
      : undefined;
  const commonMissingMessage =
    /could not find specified service|not loaded|does not exist|specified (?:service|task).*not (?:exist|found)|unit .* not found/iu.test(
      message,
    );
  const windowsMissingMessage = /cannot find the file specified/iu.test(message);
  return (
    commonMissingMessage || (allowWindowsFileNotFound && (exitCode === 2 || windowsMissingMessage))
  );
}

async function isMissingWindowsTask(
  descriptor: ServiceDescriptor,
  executor: ServiceCommandExecutor,
): Promise<boolean> {
  if (!executor.runResult) return false;
  const result = await executor.runResult("schtasks", [
    "/Query",
    "/TN",
    descriptor.name,
    "/HResult",
  ]);
  if (result.exitCode === 0) return false;
  // schtasks /Query /HResult returns HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) for a
  // missing task. Keep permission/service failures fatal instead of treating every non-zero
  // probe result as an idempotent absence.
  if (result.exitCode === 2 || result.exitCode === 0x80070002 || result.exitCode === -2147024894)
    return true;
  const error = new Error(
    `schtasks /Query /TN ${descriptor.name} failed (${result.exitCode}): ${result.stderr}`,
  ) as Error & { exitCode?: number };
  error.exitCode = result.exitCode;
  throw error;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
