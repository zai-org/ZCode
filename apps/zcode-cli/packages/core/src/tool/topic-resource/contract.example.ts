import type { ToolRegistry } from "../registry.js";
import { readTopicResourceToolEntry } from "../handlers/read-topic-resource.js";
import type { ReadTopicResourceInput } from "./contract.js";

/** 只在注入 topicResourcePort 的运行时登记；资源索引对象原样作为输入。 */
export function exampleReadTopicResource(
  registry: Pick<ToolRegistry, "register">,
): ReadTopicResourceInput {
  registry.register(readTopicResourceToolEntry);
  return { inputId: "input-a", messageId: "om_archive", index: 0 };
}
