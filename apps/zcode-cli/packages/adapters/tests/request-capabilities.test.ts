import { expect, it } from "vitest";
import { resolveModelRequestCapabilities } from "../src/model/tool-search.js";

it.each([
  ["anthropic-messages", true],
  ["openai-chat-completions", false],
  ["openai-responses", false],
])("uses the Anthropic request shape only on the Anthropic protocol (%s)", (apiType, anthropic) => {
  const capabilities = resolveModelRequestCapabilities(apiType, { type: "api-key" });
  expect(capabilities.foldRemindersIntoToolResults).toBe(anthropic);
  expect(capabilities.dropReasoningOnlyOrBlankAssistants).toBe(anthropic);
  expect(capabilities.toolSearch?.protocolSupported).toBe(anthropic);
});
