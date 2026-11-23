import { expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";

const DISABLED_SERVER = { type: "stdio", command: "unused", enabled: false } as const;
const LISTENER_ERROR = "listener failed";

function createLogger() {
  const error = vi.fn();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error } as Record<string, unknown>;
  logger.child = () => logger;
  return { logger: logger as unknown as Logger, error };
}

it.each(["adapter", "pool"] as const)(
  "keeps notifying %s snapshot listeners after one of them throws",
  async (owner) => {
    const { logger, error } = createLogger();
    const adapter = createMcpAdapter({ env: {}, ...(owner === "adapter" ? { logger } : {}) });
    const pool = createMcpConnectionPool({
      createAdapter: () => adapter,
      idleGraceMs: 0,
      ...(owner === "pool" ? { logger } : {}),
    });
    const port = owner === "adapter" ? adapter : pool.acquireLease({ sessionId: "session" });
    const later = vi.fn();
    port.onSnapshotChanged!(() => {
      throw new Error(LISTENER_ERROR);
    });
    port.onSnapshotChanged!(later);
    try {
      await port.connectServer("off", DISABLED_SERVER);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 修复前抛错的 listener 在 microtask 里成为未捕获异常（CLI 进程按致命错误退出），
      // 排在后面的 listener（其他会话的目录发布）收不到通知。
      expect(later).toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "MCP snapshot listener failed",
        expect.objectContaining({ message: LISTENER_ERROR }),
        expect.objectContaining({ event: "mcp.snapshot.listener_failed" }),
      );
    } finally {
      await pool.close();
      await adapter.close();
    }
  },
);
