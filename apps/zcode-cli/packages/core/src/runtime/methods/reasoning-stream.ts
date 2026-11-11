import type { ModelReasoningContentBlock, ModelTextContentBlock } from "../deps.js";

const DEFAULT_REASONING_STREAM_ID = "__zcode_default_reasoning__";
const DEFAULT_TEXT_STREAM_ID = "__zcode_default_text__";

export function getOrCreateReasoningBlock(input: {
  id?: string;
  providerMetadata?: Record<string, unknown>;
  reasoning: ModelReasoningContentBlock[];
  reasoningById: Map<string, ModelReasoningContentBlock>;
  allocateBlockIndex: () => number;
}): ModelReasoningContentBlock {
  const id = input.id ?? DEFAULT_REASONING_STREAM_ID;
  const existing = input.reasoningById.get(id);
  if (existing) {
    return existing;
  }

  // Anthropic-compatible providers can emit thinking deltas without a
  // distinct start event. Preserve the block so later tool_result requests can
  // replay assistant thinking alongside tool_use.
  const block: ModelReasoningContentBlock = {
    type: "reasoning",
    text: "",
    providerOptions: input.providerMetadata,
    blockIndex: input.allocateBlockIndex(),
  };
  input.reasoningById.set(id, block);
  input.reasoning.push(block);
  return block;
}

/**
 * 文字块按到达顺序编号（docs/design/v2/model/assistant-block-order.md）。
 * openai-compatible 在工具调用之后不关闭文字块，后续文字复用同一个 id（`txt-0`）；
 * 因此同一 id 的块之后已经分配过其他块时，新开一个块，保持流顺序。
 * 返回 `created`，调用方据此给没有 text_start 的新块补发 text_start，让 live 界面分行。
 */
export function getOrCreateTextBlock(input: {
  id?: string;
  textBlocks: ModelTextContentBlock[];
  textById: Map<string, ModelTextContentBlock>;
  allocateBlockIndex: () => number;
  lastAllocatedBlockIndex: () => number | undefined;
}): { block: ModelTextContentBlock; created: boolean } {
  const id = input.id ?? DEFAULT_TEXT_STREAM_ID;
  const existing = input.textById.get(id);
  if (existing && existing.blockIndex === input.lastAllocatedBlockIndex()) {
    return { block: existing, created: false };
  }
  return { block: createTextBlock({ ...input, id }), created: true };
}

export function createTextBlock(input: {
  id?: string;
  textBlocks: ModelTextContentBlock[];
  textById: Map<string, ModelTextContentBlock>;
  allocateBlockIndex: () => number;
}): ModelTextContentBlock {
  const block: ModelTextContentBlock = {
    type: "text",
    text: "",
    blockIndex: input.allocateBlockIndex(),
  };
  input.textById.set(input.id ?? DEFAULT_TEXT_STREAM_ID, block);
  input.textBlocks.push(block);
  return block;
}
