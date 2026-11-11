import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
  // 扩展进程是 Main 按需拉起的独立产物；未就绪就启动 Electron 会让首个 Window Host 拉起失败。
  { name: "extension-host", path: resolve(root, "out/.extension-host-build-ready") },
];
const waitLogIntervalMs = 3_000;
const require = createRequire(import.meta.url);

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // desktop 的 tsup 实际是 main/host/preload 三个独立 watch 构建。
  // 之前任意一个构建成功就可能放行，Electron 会在其余产物还未稳定时启动，读到半完成的 ESM/CJS 文件。
  // 现在必须等待三个构建各自写入 ready 标记，再额外确认 main bundle 已产出。
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // dev 启动卡在等待阶段时，终端最后一行常停在 tsup watch 日志，开发者无法判断缺哪个条件。
      // 这里定期打印等待状态，让 marker 或 main bundle 缺失能直接从日志定位。
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Vite 在不同本机 DNS/IPv6 配置下可能只监听 localhost/::1 或 127.0.0.1 其中之一。
  // 这里轮询多个 loopback 地址，避免 dev 脚本和 Vite 实际监听地址不一致导致 Electron 永远不启动。
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();
console.log("[dev] Starting Electron...");

const electronBinary = await ensureElectronRuntime();
let electronCommand = electronBinary;

if (process.platform === "darwin" && existsSync(electronBinary)) {
  // macOS 命令行启动的 raw Electron 没有 CFBundleURLTypes，LaunchServices 会把
  // zcode:// 交给一个没有项目入口的 Electron 默认壳。给本地启动副本补齐产品
  // Info.plist 后，线上 Share 页面无需感知 Dev，仍可把链接投递给已运行的 Dev 实例。
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const electronAppPath = resolve(electronBinary, "../../..");
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath,
    runtimeRoot: resolve(root, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });
  electronCommand = devBundle.executablePath;
  console.log(`[dev] Prepared macOS ZCode Dev bundle: ${devBundle.appPath}`);
}

const electron = spawn(electronCommand, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  windowsHide: true,
  detached: process.platform !== "win32",
});

let electronClosed = false;
let shuttingDown = false;
let forceKillTimer;
let hardExitTimer;

function signalElectronTree(signal) {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    electron.kill(signal);
    return;
  }

  try {
    process.kill(-electron.pid, signal);
  } catch {
    electron.kill(signal);
  }
}

function forceKillElectronTree() {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  signalElectronTree("SIGKILL");
}

function shutdownFromSignal(signal) {
  if (shuttingDown) {
    forceKillElectronTree();
    return;
  }

  shuttingDown = true;
  console.log(`[dev] Received ${signal}, stopping Electron...`);
  // concurrently 收到 Ctrl+C 后只会结束 node scripts/dev.mjs 这层包装进程，
  // Electron 在 macOS 上不会可靠响应 SIGINT/SIGTERM，之前会被 orphan 到 ppid=1 继续占用端口和日志。
  // 这里把 Electron 放进独立进程组并由 dev 脚本统一回收，超时后强制清掉整棵开发进程树。
  signalElectronTree("SIGTERM");
  forceKillTimer = setTimeout(forceKillElectronTree, 1_500);
  hardExitTimer = setTimeout(() => process.exit(0), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdownFromSignal(signal));
}

electron.on("error", (error) => {
  console.error("[dev] Failed to start Electron:", error);
  process.exit(1);
});

electron.on("close", (code, signal) => {
  electronClosed = true;
  clearTimeout(forceKillTimer);
  clearTimeout(hardExitTimer);
  if (shuttingDown) {
    process.exit(0);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
