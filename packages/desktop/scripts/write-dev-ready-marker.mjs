import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
const readyMarkerNames = {
  main: ".main-build-ready",
  host: ".host-build-ready",
  preload: ".preload-build-ready",
  // scheduler 已成为独立 tsup target，onSuccess 会调用同一 marker 脚本。
  // 旧白名单缺少该 target，导致 production build 在 bundle 成功后仍以 unknown target 失败。
  scheduler: ".scheduler-build-ready",
  // 扩展进程（docs/plugins/extension-host.md §12.1）：独立 tsup target，dev.mjs 等待它就绪。
  "extension-host": ".extension-host-build-ready",
};

if (!Object.hasOwn(readyMarkerNames, target)) {
  throw new Error(`unknown ready marker target: ${target ?? "<empty>"}`);
}

const readyMarkerPath = resolve(root, "out", readyMarkerNames[target]);

mkdirSync(dirname(readyMarkerPath), { recursive: true });

// tsup 的 CLI 级 onSuccess 会被每个子构建单独触发，不能代表 desktop 整体构建完成。
// 这里改成 main/host/preload 各自写独立 marker，dev.mjs 只有在三者都就绪后才会启动 Electron。
writeFileSync(readyMarkerPath, `${new Date().toISOString()}\n`, "utf8");
