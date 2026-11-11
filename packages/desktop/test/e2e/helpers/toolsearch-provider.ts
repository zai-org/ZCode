import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "./network-capture-proxy.js";

export const TOOLSEARCH_CALL_ID = "toolu_e2e_toolsearch";
export const TOOLSEARCH_TODO_CALL_ID = "toolu_e2e_toolsearch_todo";
export const TOOLSEARCH_DONE = "E2E_TOOLSEARCH_DONE";
export const TOOLSEARCH_NOTICE = "The following deferred tools are now available via ToolSearch.";
// 搜索样例用的 deferred 内置工具。TodoWrite 已转为常驻，改用始终注册、执行无副作用、
// 输入为空对象的 TodoRead；新会话读到的是空清单。
export const TOOLSEARCH_DEFERRED_TOOL = "TodoRead";

export interface ToolSearchBlock {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  tool_name?: string;
  is_error?: boolean;
  content?: string | ToolSearchBlock[];
}
export interface ToolSearchRequest {
  model: string;
  stream?: boolean;
  tools?: Array<{ name: string; defer_loading?: boolean; input_schema?: unknown }>;
  messages: Array<{ role: string; content: string | ToolSearchBlock[] }>;
  system?: unknown;
}
export type ToolSearchRecord = E2ENetworkCaptureRecord & { requestJson: ToolSearchRequest };

export function toolSearchBlocks(body: ToolSearchRequest): ToolSearchBlock[] {
  return body.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
}

export function isToolSearchCompact(body: ToolSearchRequest): boolean {
  return JSON.stringify(body).includes("Your task is to create a detailed summary");
}

interface ToolSearchFixtureResponse {
  id: string;
  stage: string;
  response: { statusCode: number; headers: Record<string, string>; body: string };
}

/** 只读取 case-local 响应；不存在的阶段直接失败，避免转正 fixture 沦为未使用的登记。 */
export async function loadToolSearchResponses(caseName: string) {
  const path = resolve("test/e2e/fixtures/upstream/conversation-session", `${caseName}.json`);
  const file = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    caseName: string;
    fixtures: ToolSearchFixtureResponse[];
  };
  if (file.version !== 1 || file.caseName !== caseName)
    throw new Error(`Invalid ToolSearch fixture: ${path}`);
  const stages = new Map<string, ToolSearchFixtureResponse>();
  for (const fixture of file.fixtures) {
    if (!fixture.stage || stages.has(fixture.stage) || typeof fixture.response.body !== "string")
      throw new Error(`Invalid or duplicate ToolSearch fixture stage: ${fixture.stage}`);
    stages.set(fixture.stage, fixture);
  }
  return {
    get(stage: string) {
      const fixture = stages.get(stage);
      if (!fixture) throw new Error(`Missing ToolSearch fixture: ${caseName}/${stage}`);
      return fixture;
    },
  };
}

/** 保留原请求阶段编排；正文和工具参数均由静态 fixture 提供。 */
export function toolSearchResponseStage(body: ToolSearchRequest): string {
  const text = JSON.stringify(body.messages);
  if (isToolSearchCompact(body)) return "summary";
  if (!text.includes("E2E_TOOLSEARCH_") || !body.tools?.length) return "auxiliary";
  if (text.includes("E2E_TOOLSEARCH_SETTINGS")) {
    const latestInput = body.messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("E2E_TOOLSEARCH_SETTINGS"),
    );
    if (
      !JSON.stringify(body.messages[latestInput]?.content).includes(
        "E2E_TOOLSEARCH_SETTINGS_SEARCH",
      )
    )
      return "done";
    const results = toolSearchBlocks({ ...body, messages: body.messages.slice(latestInput) });
    if (results.some((block) => block.tool_use_id === "toolu_settings_todo")) return "done";
    if (!results.some((block) => block.tool_use_id === "toolu_settings_search"))
      return "settings-search";
    return body.tools?.some((tool) => tool.name === "DeferredToolCall")
      ? "settings-local-todo"
      : "settings-todo";
  }
  if (/E2E_TOOLSEARCH_(COLD|OFF|ON|AFTER|FORK|EDITED)/u.test(text)) return "done";
  if (text.includes("E2E_TOOLSEARCH_CONTINUE")) {
    const partials = [...text.matchAll(/E2E_TOOLSEARCH_PARTIAL_(\d)/gu)];
    const step = Math.max(0, ...partials.map((match) => Number(match[1]))) + 1;
    return step <= 3 ? `partial-${step}` : "done";
  }
  const results = toolSearchBlocks(body).filter((block) => block.type === "tool_result");
  if (text.includes("E2E_TOOLSEARCH_INITIAL")) {
    if (
      body.tools?.some((tool) => tool.name === "ToolSearch") &&
      !results.some((block) => block.tool_use_id === TOOLSEARCH_CALL_ID)
    )
      return "search";
    if (!results.some((block) => block.tool_use_id === TOOLSEARCH_TODO_CALL_ID)) return "todo";
  }
  return "done";
}

export async function readToolSearchRequests(
  marker = "E2E_TOOLSEARCH_",
): Promise<ToolSearchRecord[]> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
  if (!capturePath) throw new Error("ToolSearch capture path is not configured");
  const artifact = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
  // 关闭请求没有 ToolSearch schema；按功能 marker 和主请求识别，避免漏掉整个降级分支。
  return artifact.records.filter((record) => {
    const body = record.requestJson as ToolSearchRequest | undefined;
    return (
      body?.messages &&
      (body.tools?.length ?? 0) > 0 &&
      JSON.stringify(body.messages).includes(marker) &&
      !isToolSearchCompact(body)
    );
  }) as ToolSearchRecord[];
}
