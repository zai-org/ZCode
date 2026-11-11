import type {
  JsonSchema,
  ModelInputMessage,
  ModelId,
  ModelProviderId,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolContract,
} from "./index.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import type { ModelPropertiesData, ModelOptionSpecsData } from "@zcode/shared/model-config";
import type { ToolSearchCapability } from "../tools/tool-search.js";

export type { ModelSelection } from "@zcode/shared/model-selection";

// 仅保留 CLI 公共类型名，字段来自同一数据 Schema，不复制 Provider 配置定义。
export type {
  ModelInputFormatData as ModelInputFormat,
  ModelOutputFormatData as ModelOutputFormat,
  EnumOptionSpecData as EnumOptionSpec,
  LimitOptionSpecData as LimitOptionSpec,
} from "@zcode/shared/model-config";
export type ModelOptionSpecs = ModelOptionSpecsData;
export type ModelProperties = ModelPropertiesData;
export type ModelPropertiesInput = ModelProperties;

export interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}

export interface ModelRequest {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}

// 第一阶段沿用已经完成 Provider SDK 归一化的结果和流事件字段；
// 旧名字只保留在 Adapter 兼容边界，业务调用统一使用下面两个名字。
export type ModelResult = ModelTextResult;
export type ModelEvent = ModelStreamEvent;

export interface Model {
  readonly requestCapabilities?: {
    readonly toolSearch?: ToolSearchCapability;
    /** 协议会把 tool result 与其后的 user 文本合成同一条消息时为 true，投影据此把紧随的提醒并入 tool result。 */
    readonly foldRemindersIntoToolResults?: boolean;
    /** 协议的请求不带没有工具调用、没有可见内容（只有思考和空白文字）的回复时为 true，投影第一步删除这类回复。 */
    readonly dropReasoningOnlyOrBlankAssistants?: boolean;
  };
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;
  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** Model 的数据字段（不含调用方法）。 */
export type ModelDescriptor = Omit<Model, "bind" | "generateText" | "streamText">;

// 键表由类型强制写全：Model 新增数据字段而这里没有登记时，类型检查失败。
const MODEL_DESCRIPTOR_KEYS = {
  requestCapabilities: true,
  providerId: true,
  modelId: true,
  displayName: true,
  properties: true,
  optionSpecs: true,
  options: true,
} as const satisfies Record<keyof ModelDescriptor, true>;

/**
 * 包装 Model 的装饰器用它复制全部数据字段，只自己实现调用方法。
 * 修复原因：装饰器逐字段手抄时，闲时包装漏了后加的 requestCapabilities，闲时轮不并入
 * tool_result、ToolSearch 按协议不支持处理，同一会话出现两种请求形态。
 */
export function modelDescriptorOf(model: Model): ModelDescriptor {
  const descriptor: Partial<Record<keyof ModelDescriptor, unknown>> = {};
  for (const key of Object.keys(MODEL_DESCRIPTOR_KEYS) as Array<keyof ModelDescriptor>) {
    if (model[key] !== undefined) descriptor[key] = model[key];
  }
  return descriptor as ModelDescriptor;
}

/** 校验当前 ModelSelection 值；旧数据库格式只在版本化 migration 转换，不在普通读取时兜底。 */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
