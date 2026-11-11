import { execFile, spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// 非 CLI 进程（Electron/Host、存储准备 Worker）只加载模块，不拦截原始入口。
if (process.argv.includes("app-server") && process.argv.includes("--stdio")) {
  // 仅由本组 WDIO 预加载的透明 stdio 代理。真实 Host/CLI 完成保存、解析和执行；
  // 故障位于传输边界，不修改业务对象，也不记录其他 RPC 的鉴权或模型凭据。
  // WDIO 以 file:// URL 注入预加载（Windows 不接受裸绝对路径），这里按同一形式剥离。
  const preload = `--import=${JSON.stringify(import.meta.url)}`;
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    // 只移除当前代理预加载，保留覆盖采集等其他 Node 参数，防止递归启动代理。
    env: {
      ...process.env,
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "").replace(preload, "").trim(),
    },
  });
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR;
  const control = join(root, "subagent-config-control.json");
  const log = join(root, `subagent-config-rpc-${child.pid}.jsonl`);
  // 修复原因：Windows 上 CLI 由每个 CLI 独占的原生 helper（zcode-runtime-host.exe）在 Job 中创建，
  // process.ppid 是 helper 而不是 Host，"两个 CLI 属于同一 Host" 的断言会误报。父进程是该 helper 时
  // 再上取一级（helper 由 Host 直接启动）；其他平台与非 helper 父进程保持 process.ppid。
  const hostPid =
    process.platform === "win32"
      ? new Promise((resolveHostPid) =>
          execFile(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}"; "$($p.Name)|$($p.ParentProcessId)"`,
            ],
            { windowsHide: true },
            (error, stdout) => {
              const [name, parentPid] = String(stdout).trim().split("|");
              resolveHostPid(
                !error && name?.toLowerCase() === "zcode-runtime-host.exe" && Number(parentPid) > 0
                  ? Number(parentPid)
                  : process.ppid,
              );
            },
          ),
        )
      : Promise.resolve(process.ppid);
  const pending = new Map();
  let outbound = Promise.resolve(),
    inbound = Promise.resolve();
  const writeLog = async (event) =>
    appendFile(
      log,
      JSON.stringify({
        time: Date.now(),
        pid: child.pid,
        hostPid: await hostPid,
        cwd: process.cwd(),
        ...event,
      }) + "\n",
    );
  createInterface({ input: child.stdout }).on("line", (line) => {
    outbound = outbound
      .then(async () => {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          process.stdout.write(line + "\n");
          return;
        }
        if (frame.method === "subagents/readRuntimeConfig") {
          const state = JSON.parse(await readFile(control, "utf8").catch(() => "{}"));
          const sessionId = frame.params.sessionId;
          const failed = state.failedSessionIds?.includes(sessionId) === true;
          await writeLog({ kind: "read", sessionId, failed });
          // 重载不再阻塞 RPC；关闭用例在测试传输边界保持请求待决，独立验证真实断连取消。
          if (state.heldSessionIds?.includes(sessionId)) {
            await writeLog({ kind: "held", sessionId });
            return;
          }
          if (failed) {
            child.stdin.write(
              JSON.stringify({
                id: frame.id,
                error: { code: -32603, message: "E2E_CONFIG_UNAVAILABLE" },
              }) + "\n",
            );
            return;
          }
          pending.set(frame.id, sessionId);
        }
        process.stdout.write(line + "\n");
      })
      .catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
        child.kill();
      });
  });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      inbound = inbound
        .then(async () => {
          const frame = JSON.parse(line);
          if (pending.has(frame.id)) {
            await writeLog({
              kind: "snapshot",
              sessionId: pending.get(frame.id),
              snapshot: frame.result,
              error: frame.error,
            });
            pending.delete(frame.id);
          }
          child.stdin.write(line + "\n");
        })
        .catch((error) => {
          process.stderr.write(String(error));
          process.exitCode = 1;
          child.kill();
        });
    })
    .on("close", () => {
      void inbound.then(() => child.stdin.end());
    });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => {
    void Promise.all([inbound, outbound]).finally(() => process.exit(code ?? 1));
  });
  // 预加载阶段等待代理子进程退出，不能再次执行当前进程原定的 CLI 入口。
  await new Promise(() => {});
}
