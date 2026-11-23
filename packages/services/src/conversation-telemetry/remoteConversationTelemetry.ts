import {
  ZCODE_AGENT_PROVIDER,
  sanitizeTelemetryEventDetail,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { ConversationTelemetryEngine } from "@zcode/shared/conversation-telemetry";
import { buildPromptTelemetryExtraDetail } from "@zcode/shared/conversation-telemetry/messageTelemetry";
import type { ConversationTelemetryInput } from "@zcode/shared/zcode-protocol-v4";

/** 只消费执行服务的 live facts，不依赖手机 attachment 或桌面 pane 的寿命。 */
export class RemoteConversationTelemetry {
  private readonly commands = new Set<string>();
  private readonly childSessions = new Set<string>();
  private readonly completed = new Map<string, { set: Set<string>; key: string }>();
  private rememberCompleted(set: Set<string>, key: string): void {
    const token = `${set === this.commands ? "command" : "child"}\0${key}`;
    this.completed.set(token, { set, key });
    // 在飞执行不淘汰；只保留最近 2000 个已结束身份，兼顾迟到事件与长期 workspace 内存。
    if (this.completed.size > 2000) {
      const oldest = this.completed.keys().next().value!;
      const item = this.completed.get(oldest)!;
      item.set.delete(item.key);
      this.completed.delete(oldest);
    }
  }
  private readonly engine: ConversationTelemetryEngine;
  private occurredAt = 0;

  constructor(options: {
    workspaceScopeKey: string;
    workspaceTelemetryDetail: {
      workspace_kind: "local" | "remote";
      remote_kind: "" | "ssh" | "wsl" | "docker" | "server";
    };
    report: (event: TelemetryEventPayload) => Promise<void>;
  }) {
    this.engine = new ConversationTelemetryEngine({
      workspaceScopeKey: `remote-execution\0${options.workspaceScopeKey}`,
      workspaceTelemetryDetail: options.workspaceTelemetryDetail,
      // 执行时长来自同一 CLI 时钟，不把 relay 到达延迟或手机时钟混入。
      now: () => this.occurredAt,
      platform: { reportTelemetryEvent: async () => {}, reportArmsCustomEvent: async () => {} },
      reportEvent: async (event) => {
        if (event.elementName !== "message_completion" && event.elementName !== "agent_step")
          return;
        await options.report({
          ...event,
          eventExtraDetail: sanitizeTelemetryEventDetail(event.elementName, {
            ...event.eventExtraDetail,
            client_kind: "mobile",
          }),
        });
      },
    });
  }

  /** 返回 true 的事实由执行侧独占，不能再交给 renderer reporter。 */
  acceptFact(fact: ConversationTelemetryInput): boolean {
    const key = `${fact.sessionId}\0${fact.sourceCommandId ?? ""}`;
    if (
      fact.kind === "turn.started" &&
      fact.inputOrigin === "mobile" &&
      fact.sourceCommandId &&
      !this.childSessions.has(fact.sessionId)
    ) {
      this.commands.add(key);
      // 只在权威开始事实建 seed，重连/重复 ACK 不会重复创建或产生 send_btn。
      if (fact.inputSource !== "background_task" && !fact.automationId && !fact.offPeakTaskId)
        this.engine.acceptPromptSeed(
          {
            sessionId: fact.sessionId,
            sourceCommandId: fact.sourceCommandId,
            sendTime: fact.occurredAt,
            memoryEnabled: fact.memoryEnabled,
            extraDetail: {
              ...buildPromptTelemetryExtraDetail({
                provider: ZCODE_AGENT_PROVIDER,
                modelName: fact.modelName,
              }),
              ...(fact.modelProvider ? { model_provider: fact.modelProvider } : {}),
              client_kind: "mobile",
              message_source: "chat",
              task_trigger: "",
            },
          },
          { reportSendButton: false },
        );
    }
    const knownChildLifecycle =
      fact.kind === "subagent.lifecycle" && this.childSessions.has(fact.childSessionId);
    if (!this.commands.has(key) && !this.childSessions.has(fact.sessionId) && !knownChildLifecycle)
      return false;
    if (
      (fact.kind === "subagent.lifecycle" || fact.kind === "workflow.lifecycle") &&
      fact.childSessionId
    ) {
      this.childSessions.add(fact.childSessionId);
    }
    this.occurredAt = fact.occurredAt;
    this.engine.handleFact(fact);
    if (fact.kind === "turn.terminal" && this.commands.has(key))
      this.rememberCompleted(this.commands, key);
    if (fact.kind === "subagent.lifecycle" && fact.phase === "stopped")
      this.rememberCompleted(this.childSessions, fact.childSessionId);
    if (fact.kind === "turn.terminal" && this.childSessions.has(fact.sessionId))
      this.rememberCompleted(this.childSessions, fact.sessionId);
    return true;
  }

  flushReportsForTest(): Promise<void> {
    return this.engine.flushReportsForTest();
  }
  dispose(): void {
    this.engine.dispose();
    this.commands.clear();
    this.childSessions.clear();
    this.completed.clear();
  }
}
