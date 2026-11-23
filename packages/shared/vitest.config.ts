import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 本次审核明确要求的时序回归；不恢复 shared/App 全量业务单测发现。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { include: ["test/messageTelemetry.test.ts"] },
});
