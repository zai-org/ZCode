import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
// 复用完整的本地 MCP OAuth 授权、持久化及真实 CLI 工具回合，增加系统库 owner 断言。
import "#e2e/conversation-session/plugins/conversation-session-mcp-oauth-status-isolation.test";

after(async () => {
  const path = join(getE2EAppDataPaths().homeDir, "credential-owner.ndjson");
  const observations = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; role: string; pid: number });
  expect(observations.some((item) => item.event === "loaded" && item.role === "utility")).toBe(
    true,
  );
  const reads = observations.filter((item) => item.event === "get");
  expect(reads).toHaveLength(1);
  expect(reads[0]?.role).toBe("browser");
});
