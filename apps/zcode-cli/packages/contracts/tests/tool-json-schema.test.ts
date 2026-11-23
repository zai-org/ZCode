import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EditInputJsonSchema } from "../src/tools/edit.js";
import { toToolJsonSchema } from "../src/tools/json-schema.js";
import { EnterPlanModeInputJsonSchema } from "../src/tools/plan-mode.js";
import { SkillInputJsonSchema } from "../src/tools/skill.js";
import { ToolSearchInputJsonSchema } from "../src/tools/tool-search.js";
import { WebSearchInputJsonSchema } from "../src/tools/websearch.js";
import { WriteInputJsonSchema } from "../src/tools/write.js";

// input_schema 的固定字节：key 顺序也计入 tools 缓存前缀。
const EXPECTED_INPUT_SCHEMAS = {
  Edit: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"file_path":{"description":"The absolute path to the file to modify","type":"string"},"old_string":{"description":"The text to replace","type":"string"},"new_string":{"description":"The text to replace it with (must be different from old_string)","type":"string"},"replace_all":{"description":"Replace all occurrences of old_string (default false)","default":false,"type":"boolean"}},"required":["file_path","old_string","new_string"],"additionalProperties":false}',
  Write:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"file_path":{"description":"The absolute path to the file to write (must be absolute, not relative)","type":"string"},"content":{"description":"The content to write to the file","type":"string"}},"required":["file_path","content"],"additionalProperties":false}',
  EnterPlanMode:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}',
  Skill:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"skill":{"description":"The name of a skill from the available-skills list. Do not guess names.","type":"string"},"args":{"description":"Optional arguments for the skill","type":"string"}},"required":["skill"],"additionalProperties":false}',
  WebSearch:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"description":"The search query to use","type":"string","minLength":2},"allowed_domains":{"description":"Only include search results from these domains","type":"array","items":{"type":"string"}},"blocked_domains":{"description":"Never include search results from these domains","type":"array","items":{"type":"string"}}},"required":["query"],"additionalProperties":false}',
  ToolSearch:
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"description":"Query to find deferred tools. Use \\"select:<tool_name>\\" for direct selection, or keywords to search. Regular expressions are not supported.","type":"string"},"max_results":{"description":"Maximum number of results to return (default: 5)","default":5,"type":"number"}},"required":["query","max_results"],"additionalProperties":false}',
};

describe("tool JSON schema key order", () => {
  it("serializes shared tool input schemas byte-for-byte", () => {
    const actual = {
      Edit: EditInputJsonSchema,
      Write: WriteInputJsonSchema,
      EnterPlanMode: EnterPlanModeInputJsonSchema,
      Skill: SkillInputJsonSchema,
      WebSearch: WebSearchInputJsonSchema,
      ToolSearch: ToolSearchInputJsonSchema,
    };
    for (const [name, expected] of Object.entries(EXPECTED_INPUT_SCHEMAS)) {
      expect(JSON.stringify(actual[name as keyof typeof actual]), name).toBe(expected);
    }
  });

  it("puts $schema first, description and default before type, and array bounds before type", () => {
    const schema = toToolJsonSchema(
      z.object({
        tags: z.array(z.string().max(12)).min(1).max(4).describe("Tags"),
        count: z.number().int().min(0).max(9).default(3).describe("Count"),
      }),
    );

    // 只有 default、没有 optional 的字段在输出里一定有值，算必填。
    expect(JSON.stringify(schema)).toBe(
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"tags":{"description":"Tags","minItems":1,"maxItems":4,"type":"array","items":{"type":"string","maxLength":12}},"count":{"description":"Count","default":3,"type":"integer","minimum":0,"maximum":9}},"required":["tags","count"],"additionalProperties":false}',
    );
  });

  it("leaves optional fields out of required, including default-then-optional and preprocess", () => {
    const schema = toToolJsonSchema(
      z.object({
        flag: z.boolean().default(false).optional(),
        limit: z
          .preprocess((value) => value, z.number().int().min(1).max(50))
          .default(20)
          .optional(),
        offset: z.preprocess((value) => value, z.number().optional()),
        name: z.string(),
      }),
    );

    expect(schema.required).toEqual(["name"]);
  });

  it("writes unions and nullable fields as anyOf branches", () => {
    const schema = toToolJsonSchema(
      z.object({
        delay: z.number().int().positive().nullable().optional(),
        target: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a") }).strict(),
          z.object({ kind: z.literal("b") }).strict(),
        ]),
      }),
    );

    expect(JSON.stringify(schema.properties)).toBe(
      '{"delay":{"anyOf":[{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},{"type":"null"}]},"target":{"anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"a"}},"required":["kind"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"b"}},"required":["kind"],"additionalProperties":false}]}}',
    );
  });

  it("rejects zod types that JSON Schema cannot represent", () => {
    expect(() => toToolJsonSchema(z.object({ when: z.date() }))).toThrow(
      "Date cannot be represented in JSON Schema",
    );
    // 自定义清单曾漏掉 undefined：它会静默变成 `{}`，模型看到一个什么都接受的参数。
    expect(() => toToolJsonSchema(z.object({ gone: z.undefined() }))).toThrow(
      "Undefined cannot be represented in JSON Schema",
    );
  });

  it("keeps property declaration order even when a property is named like a schema keyword", () => {
    const schema = toToolJsonSchema(
      z.object({
        label: z.string(),
        description: z.string(),
        type: z.string(),
      }),
    );

    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      "label",
      "description",
      "type",
    ]);
  });
});
