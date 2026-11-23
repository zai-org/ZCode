import { zcodeProtocolMethods } from "@zcode/shared";
import type { ZCodeProtocolAgentServer } from "../../src/zcode-protocol/server.js";

/**
 * 假 Host 应答 session/readReplyLanguage，结果与没有设置回复语言的 Host 相同（language: null，不发语言公告）。
 * 真实 Host 总会马上应答这个请求；只回应自己关心的方法的假 Host 不应答时，
 * CLI 每次收集输入附件都要等到请求超时，用例会被拖慢甚至超时。
 */
export function answerReplyLanguageRequest(
  server: Pick<ZCodeProtocolAgentServer, "handleMessage">,
  message: { id?: unknown; method?: unknown },
): boolean {
  if (message.method !== zcodeProtocolMethods.sessionReadReplyLanguage) return false;
  if (typeof message.id !== "string" && typeof message.id !== "number") return false;
  void server.handleMessage({ id: message.id, result: { language: null } });
  return true;
}
