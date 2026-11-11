import { describe, expect, it } from "vitest";
import { modelInputMessageJsonSchema } from "@zcode/contracts";
import { validateJsonSchemaValue } from "../src/tool/json-schema.js";

describe("tool JSON schema validator", () => {
  it("accepts base64-only video message blocks and rejects URL fields", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "video",
          mediaType: "video/mp4",
          dataUrl: "data:video/mp4;base64,dmlkZW8=",
          source: { id: "video-1", kind: "inline" },
        },
      ],
    };

    expect(validateJsonSchemaValue(message, modelInputMessageJsonSchema).valid).toBe(true);
    expect(
      validateJsonSchemaValue(
        {
          ...message,
          content: [{ ...message.content[0], url: "https://example.test/video.mp4" }],
        },
        modelInputMessageJsonSchema,
      ).valid,
    ).toBe(false);
  });

  it("accepts blockIndex on assistant text and reasoning blocks and still rejects unknown fields", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "think", providerOptions: {}, blockIndex: 0 },
        { type: "text", text: "answer", blockIndex: 1 },
      ],
      toolCalls: [{ id: "call-1", name: "Read", input: {}, blockIndex: 2 }],
    };

    expect(validateJsonSchemaValue(message, modelInputMessageJsonSchema).valid).toBe(true);
    for (const block of [
      { type: "text", text: "answer", blockIndex: -1 },
      { type: "text", text: "answer", blockIndex: 1.5 },
      { type: "text", text: "answer", order: 1 },
      { type: "reasoning", text: "think", order: 1 },
    ]) {
      expect(
        validateJsonSchemaValue({ ...message, content: [block] }, modelInputMessageJsonSchema)
          .valid,
      ).toBe(false);
    }
  });

  it("validates object properties, required fields, and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: {
        status: { enum: ["ok", "failed"] },
        count: { type: "integer", minimum: 0 },
      },
      required: ["status", "count"],
      additionalProperties: false,
    };

    expect(validateJsonSchemaValue({ status: "ok", count: 2 }, schema).valid).toBe(true);

    const invalid = validateJsonSchemaValue({ status: "maybe", extra: true }, schema);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "$.count is required",
        '$.status must be one of "ok", "failed"',
        "$.extra is not allowed",
      ]),
    );
    expect(invalid.issues).toEqual([
      {
        code: "invalid_value",
        values: ["ok", "failed"],
        path: ["status"],
        message: 'Invalid option: expected one of "ok"|"failed"',
      },
      {
        expected: "number",
        code: "invalid_type",
        path: ["count"],
        message: "Invalid input: expected number, received undefined",
      },
      {
        code: "unrecognized_keys",
        keys: ["extra"],
        path: [],
        message: 'Unrecognized key: "extra"',
      },
    ]);
  });

  it("validates oneOf variants and array item schemas", () => {
    const schema = {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            values: {
              type: "array",
              items: { type: "integer" },
            },
          },
          required: ["values"],
          additionalProperties: false,
        },
      ],
    };

    expect(validateJsonSchemaValue("plain", schema).valid).toBe(true);
    expect(validateJsonSchemaValue({ values: [1, 2, 3] }, schema).valid).toBe(true);
    const invalid = validateJsonSchemaValue({ values: [1, "bad"] }, schema);
    expect(invalid.errors).toContain("$ must match exactly one oneOf schema, matched 0");
    expect(invalid.issues).toEqual([
      {
        code: "invalid_union",
        errors: [
          [
            {
              expected: "string",
              code: "invalid_type",
              path: [],
              message: "Invalid input: expected string, received object",
            },
          ],
          [
            {
              expected: "number",
              code: "invalid_type",
              path: ["values", 1],
              message: "Invalid input: expected number, received string",
            },
          ],
        ],
        path: [],
        message: "Invalid input",
      },
    ]);
  });

  it("emits source-compatible integer and multi-type issues", () => {
    expect(validateJsonSchemaValue(1.5, { type: "integer" }).issues).toEqual([
      {
        expected: "int",
        format: "safeint",
        code: "invalid_type",
        path: [],
        message: "Invalid input: expected int, received number",
      },
    ]);
    expect(validateJsonSchemaValue(true, { type: ["string", "number"] }).issues).toEqual([
      {
        code: "invalid_union",
        errors: [
          [
            {
              expected: "string",
              code: "invalid_type",
              path: [],
              message: "Invalid input: expected string, received boolean",
            },
          ],
          [
            {
              expected: "number",
              code: "invalid_type",
              path: [],
              message: "Invalid input: expected number, received boolean",
            },
          ],
        ],
        path: [],
        message: "Invalid input",
      },
    ]);
  });

  it("does not duplicate type issues after enum or const value constraints fail", () => {
    const invalid = validateJsonSchemaValue(
      {
        mode: 7,
      },
      {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "safe"] },
          literal: { type: "string", const: "fixed" },
        },
        required: ["mode", "literal"],
        additionalProperties: false,
      },
    );

    expect(invalid.errors).toEqual([
      "$.literal is required",
      '$.mode must be one of "fast", "safe"',
      "$.mode must be string",
    ]);
    expect(invalid.issues).toEqual([
      {
        code: "invalid_value",
        values: ["fast", "safe"],
        path: ["mode"],
        message: 'Invalid option: expected one of "fast"|"safe"',
      },
      {
        code: "invalid_value",
        values: ["fixed"],
        path: ["literal"],
        message: 'Invalid input: expected "fixed"',
      },
    ]);
  });

  it("emits source-compatible upper-bound issues for every supported value origin", () => {
    const invalid = validateJsonSchemaValue(
      {
        count: 3,
        label: "long",
        values: [1, 2],
      },
      {
        type: "object",
        properties: {
          count: { type: "number", maximum: 2 },
          label: { type: "string", maxLength: 3 },
          values: { type: "array", maxItems: 1 },
        },
        required: ["count", "label", "values"],
        additionalProperties: false,
      },
    );

    expect(invalid.issues).toEqual([
      {
        origin: "number",
        code: "too_big",
        maximum: 2,
        inclusive: true,
        path: ["count"],
        message: "Too big: expected number to be <=2",
      },
      {
        origin: "string",
        code: "too_big",
        maximum: 3,
        inclusive: true,
        path: ["label"],
        message: "Too big: expected string to have <=3 characters",
      },
      {
        origin: "array",
        code: "too_big",
        maximum: 1,
        inclusive: true,
        path: ["values"],
        message: "Too big: expected array to have <=1 items",
      },
    ]);
  });
});
