import {
  ARMS_CUSTOM_EVENT_PROPERTY_LIMIT,
  PROCESS_RESOURCE_EVENT_NAMES,
  checkProcessResourceEventProperties,
} from "@zcode/shared";
import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";

/**
 * PRT-023：开发态 / E2E 的 1 分钟趋势窗口过后，
 * main 侧必须已经把每个进程角色的 `perf_process_window` 与每设备一条 `perf_system_window`
 * 送到 ARMS 出口，且旧事件停发。
 * spec：docs/monitoring/process-resource-telemetry.md；复审修复后继续验证真实 Electron 出口。
 */

interface FinalArmsEntry {
  payload: { name: string; group: string; value: number; properties: Record<string, string> };
}

interface FinalArmsBridgeWindow extends Window {
  __zcodeFinalArmsCustomEventsE2E?: {
    read(): Promise<FinalArmsEntry[]>;
    clear(): Promise<void>;
    configure(request: { suppressedEventNames: string[] }): Promise<void>;
  };
}

const PROCESS_WINDOW_EVENT = PROCESS_RESOURCE_EVENT_NAMES.processWindow;
const SYSTEM_WINDOW_EVENT = PROCESS_RESOURCE_EVENT_NAMES.systemWindow;
const REQUIRED_ROLES = ["main", "renderer_main", "host"] as const;
/** 只有 Node 角色与 renderer_main 能拿到 heap（自采或 preload 桥）。 */
const HEAP_CAPABLE_ROLES = ["main", "host", "scheduler", "renderer_main", "cli_chat", "cli_aux"];
/** 开发态 / E2E 窗口 60 秒；留足一次窗口 + 调度抖动。 */
const WINDOW_WAIT_MS = 100_000;

describe("进程资源遥测 ARMS 角色事件", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PRT-023: 1 分钟窗口后读到 main / renderer_main / host 的 perf_process_window 与 perf_system_window，属性数不超 20", async function () {
    this.timeout(WINDOW_WAIT_MS + 60_000);

    await waitForDefaultWorkspaceReady(30_000);

    const bridgeReady = await browser.execute(
      async (suppressed: string[]) => {
        const bridge = (window as FinalArmsBridgeWindow).__zcodeFinalArmsCustomEventsE2E;
        if (!bridge) return false;
        // 抑制真实上报，只在 main 内存环里核对最终 payload，避免 E2E 往生产 ARMS 打点。
        await bridge.configure({ suppressedEventNames: suppressed });
        return true;
      },
      [PROCESS_WINDOW_EVENT, SYSTEM_WINDOW_EVENT],
    );
    if (!bridgeReady) {
      throw new Error("当前 E2E 会话没有开启 final ARMS custom event 桥");
    }

    let entries: FinalArmsEntry[] = [];
    await browser.waitUntil(
      async () => {
        entries = await browser.execute(async () => {
          const bridge = (window as FinalArmsBridgeWindow).__zcodeFinalArmsCustomEventsE2E;
          return bridge ? await bridge.read() : [];
        });
        const roles = new Set(
          entries
            .filter((entry) => entry.payload.name === PROCESS_WINDOW_EVENT)
            .map((entry) => entry.payload.properties.process_role),
        );
        const hasSystemWindow = entries.some((entry) => entry.payload.name === SYSTEM_WINDOW_EVENT);
        return REQUIRED_ROLES.every((role) => roles.has(role)) && hasSystemWindow;
      },
      {
        timeout: WINDOW_WAIT_MS,
        interval: 2_000,
        timeoutMsg: `1 分钟趋势窗口过后仍未读到 ${REQUIRED_ROLES.join(" / ")} 的 ${PROCESS_WINDOW_EVENT} 与 ${SYSTEM_WINDOW_EVENT}`,
      },
    );

    const processWindowEvents = entries.filter(
      (entry) => entry.payload.name === PROCESS_WINDOW_EVENT,
    );
    for (const entry of processWindowEvents) {
      expect(entry.payload.group).toBe("resource");
      expect(
        checkProcessResourceEventProperties(PROCESS_WINDOW_EVENT, entry.payload.properties).ok,
      ).toBe(true);
      expect(Object.keys(entry.payload.properties).length).toBeLessThanOrEqual(
        ARMS_CUSTOM_EVENT_PROPERTY_LIMIT,
      );
      expect(Number(entry.payload.properties.sample_count)).toBeGreaterThan(0);
      expect(entry.payload.properties.runtime_surface).toBe("local");
      // 环境隔离和完成去重只使用内存标识，最终 ARMS 事件不得携带这些新增内部字段。
      expect(entry.payload.properties).not.toHaveProperty("environmentKey");
      expect(entry.payload.properties).not.toHaveProperty("completionToken");
      // heap 只属于 Node 角色与 renderer_main，且两项同进同出（03 的 host / scheduler 自采、
      // 04 的 renderer 桥）。某个窗口恰好没赶上 60 秒自采时整条 heap 缺席，这里不强求出现。
      if (entry.payload.properties.heap_used_kb_mean !== undefined) {
        expect(HEAP_CAPABLE_ROLES).toContain(entry.payload.properties.process_role);
        expect(Number(entry.payload.properties.heap_used_kb_mean)).toBeGreaterThan(0);
        expect(Number(entry.payload.properties.heap_used_kb_peak)).toBeGreaterThanOrEqual(
          Number(entry.payload.properties.heap_used_kb_mean),
        );
      }
    }

    const systemWindowEvents = entries.filter(
      (entry) => entry.payload.name === SYSTEM_WINDOW_EVENT,
    );
    for (const entry of systemWindowEvents) {
      expect(entry.payload.group).toBe("resource");
      expect(
        checkProcessResourceEventProperties(SYSTEM_WINDOW_EVENT, entry.payload.properties).ok,
      ).toBe(true);
      // 设备级事件固定 17 个属性。
      expect(Object.keys(entry.payload.properties)).toHaveLength(17);
      expect(Number(entry.payload.properties.sample_count)).toBeGreaterThan(0);
      // 应用总量至少覆盖 Chromium 体系本身，遥测自身开销必须可观测。
      expect(Number(entry.payload.properties.app_rss_kb_total_peak)).toBeGreaterThan(0);
      expect(Number(entry.payload.properties.telemetry_self_ms)).toBeGreaterThanOrEqual(0);
    }

    // 三个旧资源事件必须停发，否则看板口径会双份。
    const eventNames = entries.map((entry) => entry.payload.name);
    expect(eventNames).not.toContain("perf_resource_window");
    expect(eventNames).not.toContain("perf_resource_agent");
    expect(eventNames).not.toContain("perf_mcp_memory");
  });
});
