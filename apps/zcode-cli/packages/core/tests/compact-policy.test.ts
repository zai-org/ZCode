import { describe, expect, it } from "vitest";

import {
  estimateMessageTokens,
  getAutoCompactOutputReserveTokens,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  shouldAutoCompact,
} from "../src/compact/index.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "../src/runtime/methods/model-token-limits.js";

const ENOUGH_MESSAGES = [
  { role: "user" as const, content: "old context" },
  { role: "assistant" as const, content: "old answer" },
];

describe("auto compact policy", () => {
  it("counts reasoning blocks in the local fallback estimate", () => {
    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "r".repeat(40) }],
        },
      ]),
    ).toBe(14);
    expect(
      estimateMessageTokens([
        {
          role: "assistant",
          content: [
            { type: "text", text: "text" },
            { type: "reasoning", text: "think" },
          ],
        },
      ]),
    ).toBe(4);
  });

  it("uses reasoning-inclusive fallback only when provider usage is unavailable", () => {
    const messages = [
      { role: "user" as const, content: "u" },
      {
        role: "assistant" as const,
        content: [{ type: "reasoning" as const, text: "r".repeat(4_000) }],
      },
    ];
    const config = {
      bufferTokens: 1_000,
      contextWindow: 3_000,
      maxOutputTokens: 1_000,
      modelContextBudgetStrategy: "preflight-v1" as const,
    };

    expect(shouldAutoCompact({ config, messages })).toMatchObject({
      estimatedTokenCount: 1_335,
      reason: "above_threshold",
      shouldCompact: true,
      tokenCount: 1_335,
      tokenSource: "estimate",
    });
    expect(
      shouldAutoCompact({
        config,
        messages,
        tokenOverride: { source: "provider_usage", tokenCount: 999 },
      }),
    ).toMatchObject({
      estimatedTokenCount: 1_335,
      reason: "below_threshold",
      shouldCompact: false,
      tokenCount: 999,
      tokenSource: "provider_usage",
    });
  });

  it("uses explicit output token reserve when it is below the compact cap", () => {
    const config = {
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(16_000);
    expect(getEffectiveContextWindowSize(config)).toBe(184_000);
    expect(getAutoCompactThreshold(config)).toBe(171_000);
  });

  it("uses small effective output limits without raising them to the default", () => {
    const config = {
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(8_000);
    expect(getEffectiveContextWindowSize(config)).toBe(192_000);
    expect(getAutoCompactThreshold(config)).toBe(179_000);
  });

  it("defaults to preflight-v1 when the effective output target is unknown", () => {
    const config = {
      contextWindow: 200_000,
    };

    expect(getEffectiveContextWindowSize(config)).toBe(179_000);
    expect(getAutoCompactThreshold(config)).toBe(166_000);
  });

  it("OTB06 兼容 legacy 输入也使用 21k reserve 和 94k threshold", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
      modelContextBudgetStrategy: "legacy" as const,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(21_000);
    expect(getEffectiveContextWindowSize(config)).toBe(107_000);
    expect(getAutoCompactThreshold(config)).toBe(94_000);
  });

  it("OTB08 defaults to preflight-v1, preserves 21k, and removes the 95 percent threshold", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(21_000);
    expect(getEffectiveContextWindowSize(config)).toBe(107_000);
    expect(getAutoCompactThreshold(config)).toBe(94_000);
    expect(
      shouldAutoCompact({
        config,
        messages: ENOUGH_MESSAGES,
        tokenOverride: { source: "provider_usage", tokenCount: 94_000 },
      }),
    ).toMatchObject({
      effectiveContextWindow: 107_000,
      modelContextBudgetStrategy: "preflight-v1",
      outputReserveTokens: 21_000,
      shouldCompact: true,
      threshold: 94_000,
      thresholdPercent: 100,
    });
  });

  it("keeps output reserves below 21k unchanged for preflight-v1", () => {
    const config = {
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      modelContextBudgetStrategy: "preflight-v1" as const,
    };

    expect(getAutoCompactOutputReserveTokens(config)).toBe(16_000);
    expect(getEffectiveContextWindowSize(config)).toBe(112_000);
    expect(getAutoCompactThreshold(config)).toBe(99_000);
  });

  it("兼容 legacy 输入仍以 preflight 阈值压缩并记录真实策略", () => {
    const below = shouldAutoCompact({
      config: {
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        source: "provider_usage",
        tokenCount: 93_999,
      },
    });
    const above = shouldAutoCompact({
      config: {
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        source: "provider_usage",
        tokenCount: 94_000,
      },
    });

    expect(below).toMatchObject({
      effectiveContextWindow: 107_000,
      outputReserveTokens: 21_000,
      reason: "below_threshold",
      threshold: 94_000,
    });
    expect(above).toMatchObject({
      reason: "above_threshold",
      shouldCompact: true,
      thresholdPercent: 100,
      modelContextBudgetStrategy: "preflight-v1",
    });
  });

  it("旧 percent override 不再改变统一算法", () => {
    expect(
      getAutoCompactThreshold({
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        modelContextBudgetStrategy: "legacy",
        thresholdPercentOverride: 50,
      }),
    ).toBe(166_000);
  });

  it.each([
    // 8% 不足 21K 时保持 21K，阈值与旧算法相同。
    { contextWindow: 262_500, maxOutputTokens: 128_000, reserve: 21_000, threshold: 228_500 },
    { contextWindow: 500_000, maxOutputTokens: 128_000, reserve: 40_000, threshold: 447_000 },
    { contextWindow: 1_000_000, maxOutputTokens: 128_000, reserve: 80_000, threshold: 907_000 },
    // 比例 reserve 仍不超过模型输出上限。
    { contextWindow: 1_000_000, maxOutputTokens: 64_000, reserve: 64_000, threshold: 923_000 },
  ])(
    "reserves max(21K, 8% of $contextWindow) capped by $maxOutputTokens",
    ({ contextWindow, maxOutputTokens, reserve, threshold }) => {
      const config = { contextWindow, maxOutputTokens };

      expect(getAutoCompactOutputReserveTokens(config)).toBe(reserve);
      expect(getEffectiveContextWindowSize(config)).toBe(contextWindow - reserve);
      expect(getAutoCompactThreshold(config)).toBe(threshold);
      expect(
        shouldAutoCompact({
          config,
          messages: ENOUGH_MESSAGES,
          tokenOverride: { source: "provider_usage", tokenCount: threshold },
        }),
      ).toMatchObject({ outputReserveTokens: reserve, shouldCompact: true, threshold });
    },
  );

  it("surfaces provider context usage as the token count truth source", () => {
    const decision = shouldAutoCompact({
      config: {
        contextWindow: 200_000,
        maxOutputTokens: 131_072,
      },
      messages: ENOUGH_MESSAGES,
      tokenOverride: {
        contextUsageTokenCount: 170_000,
        incrementalTokenCount: 1_000,
        source: "provider_usage",
        tokenCount: 171_000,
      },
    });

    expect(decision).toMatchObject({
      providerContextUsageTokenCount: 170_000,
      providerIncrementalTokenCount: 1_000,
      reason: "above_threshold",
      shouldCompact: true,
      tokenCount: 171_000,
    });
  });
});

describe("normal request output target", () => {
  it.each([
    { caseId: "OTB01", expected: 32_000, modelLimit: undefined },
    { caseId: "OTB02", expected: 16_000, modelLimit: 16_000 },
    { caseId: "OTB03", expected: 64_000, modelLimit: 64_000 },
    { caseId: "invalid zero", expected: 32_000, modelLimit: 0 },
    { caseId: "invalid negative", expected: 32_000, modelLimit: -1 },
    { caseId: "invalid non-finite", expected: 32_000, modelLimit: Number.NaN },
  ])("$caseId resolves model limit $modelLimit to $expected", ({ expected, modelLimit }) => {
    expect(
      resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: modelLimit,
      }),
    ).toBe(expected);
  });

  it.each([
    { available: 62_999, expected: 62_999 },
    { available: 3_000, expected: 3_000 },
    { available: 2_999, expected: 2_999 },
    { available: 1, expected: 1 },
    { available: 0, expected: 64_000 },
    { available: -1, expected: 64_000 },
  ])("preflight-v1 sends the positive available budget $available", ({ available, expected }) => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 127_000 - available,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(expected);
  });

  it("legacy 也应用 preflight cap，非法估算仍保留 baseline", () => {
    const common = {
      baselineMaxOutputTokens: 64_000,
      contextWindow: 128_000,
    };
    expect(
      resolveModelStepMaxOutputTokens({
        ...common,
        estimatedCurrentUsage: 64_001,
        modelContextBudgetStrategy: "legacy",
      }),
    ).toBe(62_999);
    expect(
      resolveModelStepMaxOutputTokens({
        ...common,
        estimatedCurrentUsage: Number.NaN,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(64_000);
  });

  it("defaults a missing strategy to the preflight-v1 model-step cap", () => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 64_001,
        modelContextBudgetStrategy: undefined,
      }),
    ).toBe(62_999);
  });

  it("keeps provider-specific reasoning out of the Core preflight calculation", () => {
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 64_000,
        contextWindow: 128_000,
        estimatedCurrentUsage: 116_000,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(11_000);
  });
});
