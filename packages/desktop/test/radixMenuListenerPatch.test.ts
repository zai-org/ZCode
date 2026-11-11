import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ZCT-2114201711710621696 回归守护：@radix-ui/react-menu 的键盘检测 once 监听补丁必须存在。
//
// Chromium 对 once 监听的重复注册不去重（同 callback 同 capture 仍新增条目，偏离 DOM 规范；
// 规范实现如 jsdom 会去重，因此行为差异无法在 jsdom 单测里复现）。radix menu 的 handleKeyDown
// 每次按键都重新挂一对 pointerdown/pointermove once 监听，在 Chromium/Electron 里随按键次数
// 线性累积且无稳定清理路径——键盘密集会话（终端）一天可累积数十万监听器，撑爆 renderer 内存
// 触发 ANR。补丁改为挂新的一对前先移除上一轮未消费的旧监听，使每个菜单实例恒定最多一对。
//
// 本测试断言 patched 产物包含幂等移除逻辑，防止依赖重装或版本浮动后补丁静默丢失
// （pnpm patchedDependencies 与版本不符会报错，但同版本重装后此测试是最后防线）。

const menuDist = join(process.cwd(), "node_modules", "@radix-ui", "react-menu", "dist");

function readDist(fileName: string): string {
  return readFileSync(join(menuDist, fileName), "utf8");
}

function assertIdempotentRebind(bundle: string, source: string): void {
  const down = source.indexOf('document.addEventListener("pointerdown", handlePointer');
  const move = source.indexOf('document.addEventListener("pointermove", handlePointer');
  expect(down, `${bundle}: pointerdown once 监听注册必须存在`).toBeGreaterThan(-1);
  expect(move, `${bundle}: pointermove once 监听注册必须存在`).toBeGreaterThan(-1);

  // 补丁核心：每次 add 之前必须先 remove 同一 handler，保证 Chromium 语义下不随按键累积。
  const removeDown = source.lastIndexOf(
    'document.removeEventListener("pointerdown", handlePointer',
    down,
  );
  const removeMove = source.lastIndexOf(
    'document.removeEventListener("pointermove", handlePointer',
    move,
  );
  expect(
    removeDown,
    `${bundle}: 挂 pointerdown once 前必须先移除上一轮未消费的监听（ZCT-2114201711710621696）`,
  ).toBeGreaterThan(-1);
  expect(
    removeMove,
    `${bundle}: 挂 pointermove once 前必须先移除上一轮未消费的监听（ZCT-2114201711710621696）`,
  ).toBeGreaterThan(-1);
  expect(removeDown, `${bundle}: pointerdown 的移除必须紧邻其注册`).toBeGreaterThan(down - 400);
  expect(removeMove, `${bundle}: pointermove 的移除必须紧邻其注册`).toBeGreaterThan(move - 400);
}

describe("radix react-menu listener patch", () => {
  it("index.mjs 在挂 once 监听前幂等移除旧监听", () => {
    assertIdempotentRebind("index.mjs", readDist("index.mjs"));
  });

  it("index.js（CJS）在挂 once 监听前幂等移除旧监听", () => {
    assertIdempotentRebind("index.js", readDist("index.js"));
  });
});
