// 插件 MCP skill 生命周期 e2e helper。
// 仅在 conversation-session/manual-review/pending/conversation-session-plugin-mcp-skill-*.test.ts
// 这几个 spec 里被使用；wdio 启动前在 seedE2EStartupState 阶段会把对应的
// plugin 安装记录落到 <E2E_HOME>/.zcode/cli/plugins/，并 patch cli config。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 修复原因：Windows 上 URL.pathname 是 `/C:/...`，resolve 后变成 `C:\C:\...`，
// 与 wdio 写入工作区配置的真实插件路径不一致；必须用 fileURLToPath 转本机路径。
const FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "plugin-mcp-skill",
);
const PLUGIN_ROOT = join(FIXTURES_ROOT, "e2e-plugin-mcp-ping");

export const PLUGIN_MCP_FIXTURE_DIR = FIXTURES_ROOT;
export const PLUGIN_MCP_PLUGIN_ROOT = PLUGIN_ROOT;
export const PLUGIN_MCP_PLUGIN_ID = "e2e-plugin-mcp-ping@e2e-fixture";
// Bugfix: agent adapter 注入 MCP 工具时把 namespaced server 名（`plugin:<name>:<server>`）
// 重写成符合模型 API 工具名约束的 `mcp__plugin_<name>_<server>__<tool>`，实际发给模型的就是这个名。
// 见 `apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts` 与
// `apps/zcode-cli/packages/adapters/src/mcp/index.ts:normalizeMcpToolDescriptor`。
export const PLUGIN_MCP_TOOL_NAME = "mcp__plugin_e2e-plugin-mcp-ping_ping__ping";
export const PLUGIN_MCP_MARKER_PREFIX = "E2E_PLUGIN_MCP_PING";

/**
 * 读取 upstream replay 捕获的请求记录，遍历 tools 数组，断言指定工具名是否注册。
 * 强证据：只有当 plugin MCP server 真正被 listTools 时，agent 才会把
 * `mcp__plugin_e2e-plugin-mcp-ping_ping__ping` 加进 `body.tools[]` 一并发送给模型。
 */
export function captureArtifactAdvertisesToolName(requestJson: unknown, toolName: string): boolean {
  if (!requestJson || typeof requestJson !== "object") return false;
  const tools = (requestJson as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.some(
    (tool) =>
      tool !== null && typeof tool === "object" && (tool as { name?: unknown }).name === toolName,
  );
}

/**
 * 找到包含 marker 的最后一条 capture 请求，导出 requestJson 给调用方继续断言。
 * 比 `countUpstreamRequests` 更进一步：返回 record，方便读 tools 数组。
 */
export async function findUpstreamRequestContaining(
  marker: string,
  timeoutMs = 30000,
  options?: { advertisedToolName?: string },
): Promise<{ method: string; path: string; requestJson: unknown } | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return null;
  const deadline = Date.now() + timeoutMs;
  let latest: { method: string; path: string; requestJson: unknown } | null = null;
  while (Date.now() < deadline) {
    const artifact = await readCaptureArtifact(capturePath);
    if (artifact) {
      for (const record of artifact.records) {
        if (
          containsText(record.requestJson, marker) &&
          (!options?.advertisedToolName ||
            captureArtifactAdvertisesToolName(record.requestJson, options.advertisedToolName))
        ) {
          latest = {
            method: record.method,
            path: record.path,
            requestJson: record.requestJson,
          };
        }
      }
    }
    // 修复原因：同一首发 prompt 会并发触发主请求与标题请求，两者都含 marker，
    // 但只有主请求携带 MCP tools。指定 advertisedToolName 时必须等到主请求落盘。
    if (latest) return latest;
    await sleep(250);
  }
  return latest;
}

async function readCaptureArtifact(capturePath: string): Promise<{
  records: Array<{ method: string; path: string; requestJson: unknown }>;
} | null> {
  try {
    const raw = await readFile(capturePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      records?: Array<{ method: string; path: string; requestJson?: unknown }>;
    };
    if (!parsed || !Array.isArray(parsed.records)) return null;
    return {
      records: parsed.records.map((record) => ({
        method: record.method,
        path: record.path,
        requestJson: record.requestJson ?? null,
      })),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function containsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => containsText(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsText(child, expected));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
