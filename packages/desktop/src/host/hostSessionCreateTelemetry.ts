import {
  HostResponseTypes,
  resolveWorkspaceTelemetryDetail,
  type AutomationSessionCreateTelemetry,
} from "@zcode/shared";

/** 仅实际新建并完成首发 admission 的派发分支调用；不从恢复订阅推断创建。 */
export function reportHostSessionCreate(
  port: { postMessage(message: unknown): void } | null | undefined,
  input: {
    sessionId: string;
    messageId: string;
    /** Host 的当前界面语言；缺省才用 Intl。Main 的 TelemetryCore 发送时还会再按界面语言覆盖。 */
    clientLanguage?: string;
    source: AutomationSessionCreateTelemetry["eventExtraDetail"]["create_source"];
    workspaceIdentity?: string;
  },
): void {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const event: AutomationSessionCreateTelemetry = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: input.sessionId,
      messageId: input.messageId,
      context: {
        clientTimezone: locale.timeZone,
        clientLanguage: input.clientLanguage ?? locale.locale,
        screenResolution: "",
      },
      eventExtraDetail: {
        create_source: input.source,
        client_kind: "desktop",
        ...resolveWorkspaceTelemetryDetail(input),
      },
    };
    port?.postMessage({ type: HostResponseTypes.SessionCreateTelemetry, event });
  } catch {
    // Main 已退出或 IPC 不可用时丢弃本次旁路上报，不能把 accepted 派发误判为失败。
  }
}
