import { mkdtempSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, addAbortSignal } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkspaceHookScriptStates,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";

/**
 * CR-01（!3691）：discovery 的读取预算曾只是一个取消信号，stat/open/handle.stat 不响应它，
 * 脚本位于无响应的文件系统时，会话初始化与 Settings 加载会无限等待。
 * 这里注入挂起的文件操作，断言预算到期后返回 unverifiable，且迟到打开的句柄仍被关闭。
 */

const hang = vi.hoisted(() => ({
  target: "" as "" | "stat" | "open" | "handleStat" | "stream",
  late: undefined as undefined | (() => void),
  lateHandleClosed: false,
  inFlightStats: 0,
  maxInFlightStats: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const never = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      if (hang.target === "stat") return never();
      hang.inFlightStats += 1;
      hang.maxInFlightStats = Math.max(hang.maxInFlightStats, hang.inFlightStats);
      try {
        // 让出若干轮事件循环，使并发读取有机会重叠。
        await new Promise((resolve) => setImmediate(resolve));
        return await actual.stat(...args);
      } finally {
        hang.inFlightStats -= 1;
      }
    }) as typeof actual.stat,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (hang.target === "open") {
        // 预算到期后才返回句柄，模拟迟到的 open。
        await new Promise<void>((resolve) => {
          hang.late = resolve;
        });
      }
      const handle = await actual.open(...args);
      if (hang.target === "open") {
        return Object.assign(Object.create(handle) as FileHandle, {
          close: async () => {
            hang.lateHandleClosed = true;
            await handle.close();
          },
        });
      }
      if (hang.target === "stream") {
        // 读取流挂起但响应取消信号（与 fs 流一致）；句柄关闭被记录。
        return Object.assign(Object.create(handle) as FileHandle, {
          createReadStream: (options?: { signal?: AbortSignal }) => {
            const stream = new Readable({ read() {} });
            return options?.signal ? addAbortSignal(options.signal, stream) : stream;
          },
          close: async () => {
            hang.lateHandleClosed = true;
            await handle.close();
          },
        });
      }
      if (hang.target !== "handleStat") return handle;
      return Object.assign(Object.create(handle) as FileHandle, {
        stat: never,
        close: () => handle.close(),
      });
    }) as typeof actual.open,
  };
});

const roots: string[] = [];

afterEach(async () => {
  hang.target = "";
  hang.late = undefined;
  hang.lateHandleClosed = false;
  hang.inFlightStats = 0;
  hang.maxInFlightStats = 0;
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{ workspace: string; sources: WorkspaceHookSourceInput[] }> {
  const { writeFile, mkdir } = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  const workspace = mkdtempSync(join(tmpdir(), "zcode-hook-script-deadline-"));
  roots.push(workspace);
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(join(workspace, "x.sh"), "echo hi\n", "utf8");
  const hooks = workspaceHooksConfigSchema.parse({
    enabled: true,
    events: { SessionStart: [{ hooks: [{ type: "process", command: "sh", args: ["x.sh"] }] }] },
  });
  return {
    workspace,
    sources: [
      {
        canonicalPath: join(workspace, ".zcode", "config.json"),
        baseDir: workspace,
        discoveryOrder: 0,
        configFileKind: ".zcode/config.json",
        explicitProjectConfig: false,
        editable: true,
        hooks,
      },
    ],
  };
}

describe("readWorkspaceHookScriptStates 截止时间（CR-01）", () => {
  it.each(["stat", "open", "handleStat"] as const)(
    "%s 挂起时预算到期返回 unverifiable，不无限等待",
    async (target) => {
      const { workspace, sources } = await fixture();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      hang.target = target;
      const pending = readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
      await vi.advanceTimersByTimeAsync(5_000);
      const states = await pending;
      expect([...states.values()]).toEqual([{ kind: "unverifiable" }]);
    },
  );

  it("预算到期后才返回的句柄仍被关闭，迟到结果不改变已返回的状态", async () => {
    const { workspace, sources } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hang.target = "open";
    const pending = readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
    // 先等读取真正进入 open 再推进截止时间；否则并行负载下截止时间可能在 open 之前触发，
    // 迟到的 open 从未开始，句柄关闭也就无从断言（曾导致本用例在多文件并行运行时失败）。
    await vi.waitFor(() => expect(hang.late).toBeDefined());
    await vi.advanceTimersByTimeAsync(5_000);
    const states = await pending;
    expect([...states.values()]).toEqual([{ kind: "unverifiable" }]);

    hang.late?.();
    await vi.waitFor(() => expect(hang.lateHandleClosed).toBe(true));
    expect([...states.values()]).toEqual([{ kind: "unverifiable" }]);
  });

  it("读取流挂起时预算到期返回 unverifiable，句柄被关闭", async () => {
    const { workspace, sources } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hang.target = "stream";
    const pending = readWorkspaceHookScriptStates({ workspacePath: workspace, sources });
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...(await pending).values()]).toEqual([{ kind: "unverifiable" }]);
    await vi.waitFor(() => expect(hang.lateHandleClosed).toBe(true));
  });
});

/**
 * 第六轮验证项：大量不同脚本时限制同时打开的文件数，避免 EMFILE 波及进程内其他 I/O。
 * handle.stat 挂起时句柄无法强制关闭（fstat 不可取消），每个挂起文件最多占用一个句柄，
 * 且挂起的读取数受同一并发上限约束；这一点写入 spec，不在这里断言。
 */
describe("readWorkspaceHookScriptStates 并发上限", () => {
  it("同时进行的读取不超过上限，全部结果正确", async () => {
    const { writeFile, mkdir } = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const workspace = mkdtempSync(join(tmpdir(), "zcode-hook-script-many-"));
    roots.push(workspace);
    await mkdir(join(workspace, "s"), { recursive: true });
    const hookList = [];
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(workspace, "s", `h${index}.sh`), `echo ${index}\n`, "utf8");
      hookList.push({ type: "process", command: "sh", args: [`s/h${index}.sh`] });
    }
    const hooks = workspaceHooksConfigSchema.parse({
      enabled: true,
      events: { SessionStart: [{ hooks: hookList }] },
    });
    const states = await readWorkspaceHookScriptStates({
      workspacePath: workspace,
      sources: [
        {
          canonicalPath: join(workspace, ".zcode", "config.json"),
          baseDir: workspace,
          discoveryOrder: 0,
          configFileKind: ".zcode/config.json",
          explicitProjectConfig: false,
          editable: true,
          hooks,
        },
      ],
    });
    expect(states.size).toBe(40);
    expect([...states.values()].every((state) => state.kind === "file")).toBe(true);
    expect(hang.maxInFlightStats).toBeGreaterThan(1);
    expect(hang.maxInFlightStats).toBeLessThanOrEqual(8);
  });
});
