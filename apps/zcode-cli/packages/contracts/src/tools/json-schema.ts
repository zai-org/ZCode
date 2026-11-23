// ============================================================
// Zod -> provider-neutral JSON Schema for tool contracts
// ============================================================

import { z } from "zod";
import type { JsonSchema } from "../model/index.js";

export const TOOL_JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

// anyOf / allOf 分支上的临时标记，值是 undefined。zod 会把只有 type 的分支合并成 `type: [...]`，
// 带上这个键后分支不再是“只有 type”，保留 `anyOf: [{type}, {type: "null"}]` 的形状；
// zod 生成结束时做一次 JSON 序列化，值为 undefined 的键随之消失。
const KEEP_BRANCH_KEY = "x-zcode-keep-branch";

type ZodNode = z.core.$ZodType;
type JsonNode = Record<string, unknown>;

/**
 * 把工具的 zod schema 转成发给模型的 JSON Schema，规则见
 * docs/design/v2/tool/00-tool-change-chain.md「工具 JSON Schema 生成」。contracts 里的工具 schema 都走这里，
 * runtime 校验与 provider-visible 参数来自同一份 zod 定义。JSON Schema 表达不了的类型按 zod 默认的
 * `unrepresentable: "throw"` 直接报错。
 * 修复原因：原来用 `"any"` 加一份自定义类型清单报错，清单漏了 undefined 等类型，它们会静默变成 `{}`。
 */
export function toToolJsonSchema(schema: ZodNode): JsonSchema {
  return z.toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => normalizeNode(zodSchema, jsonSchema as JsonNode),
  }) as JsonSchema;
}

function normalizeNode(schema: ZodNode, node: JsonNode): void {
  if (schema._zod.def.type === "union" && node.oneOf !== undefined) {
    node.anyOf = node.oneOf;
    delete node.oneOf;
  }
  markBranches(node.anyOf);
  markBranches(node.allOf);
  moveMetadataFirst(schema, node);
}

function markBranches(branches: unknown): void {
  if (!Array.isArray(branches)) return;
  for (const branch of branches) {
    if (branch && typeof branch === "object") (branch as JsonNode)[KEEP_BRANCH_KEY] = undefined;
  }
}

// description 等元数据键排在最前，其余键保持 zod 的输出顺序。
function moveMetadataFirst(schema: ZodNode, node: JsonNode): void {
  const metadata = z.globalRegistry.get(schema);
  if (!metadata) return;
  for (const key of Object.keys(node)) {
    if (Object.hasOwn(metadata, key)) continue;
    const value = node[key];
    delete node[key];
    node[key] = value;
  }
}
