import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConversationRewindTelemetryEvent,
  buildPermissionPromptResultTelemetryEvent,
  buildWorkflowRunResultTelemetryEvent,
  ConversationTelemetryEngine,
  createPermissionPromptShownClock,
  resolveConversationRewindTarget,
  resolveSendAckSettlement,
  WORKFLOW_RUN_RESULT_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "@zcode/shared/conversation-telemetry";
import { resetMessageTelemetryForTest } from "@zcode/shared/conversation-telemetry/messageTelemetry";
import {
  normalizeToolErrorCode,
  sanitizeTelemetryEventDetail,
  sanitizeToolErrorCode,
} from "@zcode/shared";
import type { ConversationTelemetryInput } from "@zcode/shared/zcode-protocol-v4";

describe("message 首响时序与独立通知", () => {
  const engines: ConversationTelemetryEngine[] = [];
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    resetMessageTelemetryForTest();
  });
  function setup(start = true) {
    const reports: Array<{ elementName: string; eventExtraDetail: Record<string, string> }> = [];
    let seq = 0;
    const engine = new ConversationTelemetryEngine({
      workspaceScopeKey: "test",
      now: () => 100 + seq,
      platform: { reportTelemetryEvent: async () => {}, reportArmsCustomEvent: async () => {} },
      reportEvent: async (report) => {
        reports.push(report);
      },
    });
    engines.push(engine);
    engine.acceptPromptSeed({
      sessionId: "s",
      sourceCommandId: "c",
      sendTime: 100,
      extraDetail: {},
    });
    const fact = (fields: Record<string, unknown>) =>
      engine.handleFact({
        version: 1,
        sessionId: "s",
        sourceCommandId: "c",
        turnId: "t",
        eventId: `e${++seq}`,
        eventSeq: seq,
        occurredAt: 100 + seq,
        ...fields,
      } as ConversationTelemetryInput);
    if (start) fact({ kind: "turn.started" });
    const request = (requestId: string, querySource = "main_turn") =>
      fact({
        kind: "model.request.status",
        requestId,
        status: "model_request_started",
        providerId: "p",
        modelId: "m",
        querySource,
        transport: "http",
        attempt: 1,
        maxAttempts: 2,
      });
    const metrics = (
      requestId: string,
      inputTokens = 100,
      cacheReadTokens: number | undefined = 20,
      querySource = "main_turn",
    ) =>
      fact({
        kind: "model.request.metrics",
        requestId,
        providerId: "p",
        modelId: "m",
        querySource,
        durationMs: 5,
        inputTokens,
        cacheReadTokens,
      });
    const output = () =>
      fact({ kind: "stream.chunk", channel: "text", firstChunk: true, chunkLength: 4 });
    const finish = async () => {
      fact({ kind: "turn.terminal", status: "success" });
      await engine.flushReportsForTest();
      return reports.find((r) => r.elementName === "message_completion")!.eventExtraDetail;
    };
    return { fact, request, metrics, output, finish, engine, reports };
  }
  it("A 无输出后重试 B，A 迟到 metrics 不污染 B", async () => {
    const t = setup();
    t.request("A");
    t.request("B");
    t.output();
    t.metrics("A", 900);
    t.metrics("B", 100);
    expect(await t.finish()).toMatchObject({
      ttft_request_id: "B",
      ttft_input_tokens: "100",
      ttft_cached_input_tokens: "20",
    });
  });
  it("metrics 先于 tool_call，工具首响保留同请求 usage", async () => {
    const t = setup();
    t.request("A");
    t.metrics("A", 100, 0);
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "tool", toolName: "Read" });
    expect(await t.finish()).toMatchObject({
      ttft_request_id: "A",
      ttft_output_kind: "tool",
      ttft_input_tokens: "100",
      ttft_cached_input_tokens: "0",
    });
  });
  it("首响冻结后 B 先完成、A 后完成，仍只取 A", async () => {
    const t = setup();
    t.request("A");
    t.output();
    t.request("B");
    t.metrics("B", 900);
    t.metrics("A", 100);
    expect(await t.finish()).toMatchObject({ ttft_request_id: "A", ttft_input_tokens: "100" });
  });
  it("没有输出时不把收到的 metrics 当成首响", async () => {
    const t = setup();
    t.request("A");
    t.metrics("A");
    expect(await t.finish()).toMatchObject({
      time_to_first_token: "-1",
      ttft_output_kind: "none",
      ttft_request_id: "",
      ttft_input_tokens: "",
      ttft_cached_input_tokens: "",
    });
  });
  it.each(["compact", "session_title", "subagent"])(
    "%s 请求不切候选，metrics 不污染主轮",
    async (source) => {
      const t = setup();
      t.request("A");
      t.request("side", source);
      t.metrics("side", 900, 800, source);
      t.output();
      t.metrics("A");
      expect(await t.finish()).toMatchObject({ ttft_request_id: "A", ttft_input_tokens: "100" });
    },
  );
  it("旧 CLI 只有 usage.delta 时仍可完成，首响 token 不猜累计值", async () => {
    const t = setup();
    t.request("A");
    t.output();
    t.fact({
      kind: "usage.delta",
      requestId: "A",
      inputTokens: 900,
      outputTokens: 2,
      totalTokens: 902,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(await t.finish()).toMatchObject({
      is_first_message: "unknown",
      send_mode: "unknown",
      input_tokens: "900",
      ttft_input_tokens: "",
      ttft_cached_input_tokens: "",
    });
  });
  it.each([true, false])(
    "admission 在 started 之前=%s，共用 eventId 不互相去重",
    async (before) => {
      const t = setup(false);
      const admission = () =>
        t.fact({
          kind: "turn.admission",
          eventId: "start",
          isFirstMessage: false,
          sendMode: "queued",
        });
      if (before) admission();
      t.fact({ kind: "turn.started", eventId: "start" });
      if (!before) admission();
      t.request("A");
      t.output();
      t.fact({
        kind: "model.request.status",
        eventId: "complete",
        status: "model_request_completed",
        requestId: "A",
        providerId: "p",
        modelId: "m",
        transport: "http",
        durationMs: 5,
      });
      t.fact({
        kind: "model.request.metrics",
        eventId: "complete",
        requestId: "A",
        providerId: "p",
        modelId: "m",
        durationMs: 5,
        inputTokens: 100,
      });
      const detail = await t.finish();
      expect(detail).toMatchObject({
        is_first_message: "0",
        send_mode: "queued",
        ttft_input_tokens: "100",
        ttft_cached_input_tokens: "",
      });
      t.metrics("A", 900);
      await t.engine.flushReportsForTest();
      expect(t.reports.filter((r) => r.elementName === "message_completion")).toHaveLength(1);
      expect(detail.ttft_input_tokens).toBe("100");
      expect(
        t.reports.find((r) => r.elementName === "send_btn")!.eventExtraDetail,
      ).not.toHaveProperty("send_mode");
      for (const r of t.reports.filter((r) => r.elementName === "agent_step"))
        expect(r.eventExtraDetail).not.toHaveProperty("is_first_message");
    },
  );
  it("child 请求即使复用 requestId 也不能覆盖父轮首响", async () => {
    const t = setup();
    t.request("A");
    t.output();
    t.metrics("A", 100, 20);
    t.fact({
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "agent",
      childSessionId: "child",
      parentToolCallId: "tool",
      background: false,
    });
    t.fact({
      kind: "model.request.metrics",
      sessionId: "child",
      requestId: "A",
      providerId: "p",
      modelId: "m",
      querySource: "main_turn",
      durationMs: 5,
      inputTokens: 900,
      cacheReadTokens: 800,
    });
    t.fact({
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent",
      childSessionId: "child",
      parentToolCallId: "tool",
      background: false,
    });
    expect(await t.finish()).toMatchObject({
      ttft_request_id: "A",
      ttft_input_tokens: "100",
      ttft_cached_input_tokens: "20",
    });
  });
});

describe("编辑重发与回退埋点", () => {
  const engines: ConversationTelemetryEngine[] = [];
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    resetMessageTelemetryForTest();
  });

  it("send_type 随 seed 冻结到 send_btn、completion 和每条 step", async () => {
    const reports: Array<{ elementName: string; eventExtraDetail: Record<string, string> }> = [];
    let seq = 0;
    const engine = new ConversationTelemetryEngine({
      workspaceScopeKey: "test",
      now: () => 100 + seq,
      platform: { reportTelemetryEvent: async () => {}, reportArmsCustomEvent: async () => {} },
      reportEvent: async (report) => {
        reports.push(report);
      },
    });
    engines.push(engine);
    engine.acceptPromptSeed({
      sessionId: "s",
      sourceCommandId: "edit-cmd",
      sendTime: 100,
      extraDetail: { message_source: "chat", send_type: "edit" },
    });
    const fact = (fields: Record<string, unknown>) =>
      engine.handleFact({
        version: 1,
        sessionId: "s",
        sourceCommandId: "edit-cmd",
        turnId: "t",
        eventId: `e${++seq}`,
        eventSeq: seq,
        occurredAt: 100 + seq,
        ...fields,
      } as ConversationTelemetryInput);
    fact({ kind: "turn.started" });
    fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "tool", toolName: "Read" });
    fact({ kind: "tool.lifecycle", phase: "completed", toolCallId: "tool", toolName: "Read" });
    fact({ kind: "turn.terminal", status: "success" });
    await engine.flushReportsForTest();
    const names = reports.map((r) => r.elementName);
    expect(names).toContain("send_btn");
    expect(names).toContain("message_completion");
    expect(names).toContain("agent_step");
    for (const r of reports) expect(r.eventExtraDetail.send_type).toBe("edit");
  });

  it("文件冲突的编辑 ACK 直接落定 blocked，不进入待渲染", () => {
    expect(
      resolveSendAckSettlement({
        status: "accepted",
        result: { type: "editUserQuery", disposition: "blocked" },
      }),
    ).toEqual({ kind: "settle", status: "fail", ackStatus: "accepted", reasonCode: "blocked" });
    expect(
      resolveSendAckSettlement({
        status: "accepted",
        result: { type: "editUserQuery", disposition: "rewind" },
      }),
    ).toEqual({ kind: "awaitRender", ackStatus: "accepted" });
  });

  const rows = [
    {
      kind: "turnHeader",
      rowId: 1,
      turnId: "t1",
      sourceCommandId: "c1",
      state: "completedSuccess",
    },
    { kind: "userInput", rowId: 2, turnId: "t1" },
    {
      kind: "turnHeader",
      rowId: 10,
      turnId: "t2",
      sourceCommandId: "c2",
      state: "failed",
      fileChanges: { files: 3 },
    },
    { kind: "userInput", rowId: 11, turnId: "t2" },
    { kind: "assistant", rowId: 12, turnId: "t2" },
    { kind: "turnHeader", rowId: 20, turnId: "t3", sourceCommandId: "c3", state: "running" },
  ];

  it("目标轮取自用户行所在 turnHeader，丢弃轮数含其后全部轮次", () => {
    expect(resolveConversationRewindTarget(rows, 11)).toEqual({
      targetMessageId: "c2",
      targetTurnState: "failed",
      targetTurnFiles: "3",
      discardedTurns: 2,
    });
    expect(resolveConversationRewindTarget(rows, 99)).toEqual({
      targetMessageId: "",
      targetTurnState: "unknown",
      targetTurnFiles: "",
      discardedTurns: 0,
    });
  });

  it("编辑重发：accepted / blocked / rejected 与原因白名单", () => {
    const target = resolveConversationRewindTarget(rows, 11);
    const base = { action: "edit_resend" as const, sessionId: "s", commandId: "cmd", target };
    const accepted = buildConversationRewindTelemetryEvent({
      ...base,
      workspaceMode: "rewind",
      ack: { status: "accepted", result: { type: "editUserQuery", disposition: "rewind" } },
    });
    expect(accepted).toMatchObject({
      elementName: "conversation_rewind",
      eventRegion: "chat",
      eventType: "result",
      talkId: "s",
      messageId: "cmd",
    });
    expect(accepted.eventExtraDetail).toEqual({
      action: "edit_resend",
      workspace_mode: "rewind",
      result: "accepted",
      ack_status: "accepted",
      blocked_reason: "",
      target_message_id: "c2",
      target_turn_state: "failed",
      target_turn_files: "3",
      discarded_turns: "2",
      restored_files: "",
    });
    const blocked = (reasonCode: string) =>
      buildConversationRewindTelemetryEvent({
        ...base,
        workspaceMode: "rewind",
        ack: {
          status: "accepted",
          result: { type: "editUserQuery", disposition: "blocked", reasonCode },
        },
      }).eventExtraDetail;
    expect(blocked("guard.workspaceRewindUnsafeFiles")).toMatchObject({
      result: "blocked",
      blocked_reason: "unsafe_files",
    });
    // 未知 reasonCode 不原样透传。
    expect(blocked("guard.somethingNew /secret/path")).toMatchObject({ blocked_reason: "other" });
    expect(
      buildConversationRewindTelemetryEvent({ ...base, ack: { status: "stale" } }).eventExtraDetail,
    ).toMatchObject({ result: "rejected", ack_status: "stale", workspace_mode: "preserve" });
    expect(
      buildConversationRewindTelemetryEvent({ ...base, ack: { status: "weird" } }).eventExtraDetail
        .ack_status,
    ).toBe("other");
  });

  it("只撤销文件：只有 applied=true 才算成功并带文件数", () => {
    const target = resolveConversationRewindTarget(rows, 10);
    const event = (applied: boolean) =>
      buildConversationRewindTelemetryEvent({
        action: "file_only",
        sessionId: "s",
        commandId: "cmd",
        target,
        ack: {
          status: "accepted",
          result: { type: "applyFileRewind", applied, preview: { safeFiles: [{}, {}] } },
        },
      }).eventExtraDetail;
    expect(event(true)).toMatchObject({
      action: "file_only",
      workspace_mode: "",
      result: "accepted",
      restored_files: "2",
      discarded_turns: "",
    });
    expect(event(false)).toMatchObject({
      result: "blocked",
      blocked_reason: "not_applied",
      restored_files: "",
    });
  });
});

describe("授权弹窗结果埋点", () => {
  const base = {
    sessionId: "s",
    messageId: "cmd-1",
    toolName: "Write",
    toolCallId: "toolu_1",
    fromSubagent: false,
    askMode: "build",
    shownAt: 1_000,
    respondedAt: 6_500,
    ackStatus: "accepted",
  };

  it("V4 optionId 映射为稳定枚举，未知 optionId 按 kind 归类", () => {
    const option = (optionId: string, kind?: string) =>
      buildPermissionPromptResultTelemetryEvent({ ...base, option: { optionId, kind } })
        .eventExtraDetail.option;
    expect(option("allowOnce", "allowOnce")).toBe("allow_once");
    expect(option("allowAlways", "allowAlways")).toBe("allow_project");
    expect(option("allowSession", "allowAlways")).toBe("allow_session");
    expect(option("fullAccess", "custom")).toBe("allow_full_access");
    expect(option("allowAndSwitchGuarded")).toBe("allow_switch_guarded");
    expect(option("deny", "deny")).toBe("deny");
    expect(option("workflowRefine", "custom")).toBe("workflow_refine");
    expect(option("somethingNew", "allowAlways")).toBe("allow_always_other");
    expect(option("somethingNew", "custom")).toBe("other");
  });

  it("完整字段：等待时长、是否写理由、子 agent 来源", () => {
    const event = buildPermissionPromptResultTelemetryEvent({
      ...base,
      option: { optionId: "deny", kind: "deny" },
      feedback: "  do not write  ",
      fromSubagent: true,
      modeSwitch: "choose",
    });
    expect(event).toMatchObject({
      elementName: "permission_prompt_result",
      eventRegion: "chat",
      eventType: "result",
      talkId: "s",
      messageId: "cmd-1",
    });
    expect(event.eventExtraDetail).toEqual({
      option: "deny",
      has_feedback: "1",
      tool_name: "Write",
      tool_call_id: "toolu_1",
      from_subagent: "1",
      ask_mode: "build",
      mode_switch: "choose",
      wait_ms: "5500",
      ack: "accepted",
    });
    // 反馈正文不出现在任何字段里。
    expect(JSON.stringify(event)).not.toContain("do not write");
  });

  it("空白反馈不算写了理由；不合规标识与未知值不透传", () => {
    const detail = buildPermissionPromptResultTelemetryEvent({
      ...base,
      messageId: "",
      option: { optionId: "deny", kind: "deny" },
      feedback: "   ",
      toolName: "Bash /etc/passwd",
      toolCallId: "x".repeat(200),
      askMode: undefined,
      modeSwitch: "weird",
      shownAt: undefined,
      ackStatus: "rejected",
    });
    expect(detail).not.toHaveProperty("messageId");
    expect(detail.eventExtraDetail).toMatchObject({
      has_feedback: "0",
      tool_name: "other",
      tool_call_id: "",
      ask_mode: "",
      mode_switch: "",
      wait_ms: "",
      ack: "failed",
    });
    // 批准时填写的反馈会被忽略，不算写了理由。
    expect(
      buildPermissionPromptResultTelemetryEvent({
        ...base,
        option: { optionId: "allowOnce" },
        feedback: "ignored",
      }).eventExtraDetail.has_feedback,
    ).toBe("0");
    // duplicate 视为已生效；noop（收件箱 / 网关判定无事可做）单列；其余都算失败。
    const ack = (ackStatus: string) =>
      buildPermissionPromptResultTelemetryEvent({
        ...base,
        option: { optionId: "deny" },
        ackStatus,
      }).eventExtraDetail.ack;
    expect([ack("duplicate"), ack("noop"), ack("failed"), ack("stale")]).toEqual([
      "accepted",
      "noop",
      "failed",
      "failed",
    ]);
    expect(
      buildPermissionPromptResultTelemetryEvent({
        ...base,
        toolName: "mcp__dbx__dbx_execute_query",
        option: { optionId: "allowOnce" },
      }).eventExtraDetail.tool_name,
    ).toBe("mcp__dbx__dbx_execute_query");
  });

  it("首次出现时间按 interaction 记录：切走再回来不重置，超出上限丢最早的", () => {
    const clock = createPermissionPromptShownClock(2);
    clock.markShown("p1", 1_000);
    // 切到别的会话（p2 出现）再回到 p1：p1 仍按首次出现计时。
    clock.markShown("p2", 2_000);
    clock.markShown("p1", 9_000);
    expect(clock.claimReport("p1", "failed")).toEqual({ report: true, shownAt: 1_000 });
    clock.markShown("p3", 3_000);
    // 上限 2：p1、p2、p3 中最早的 p1 被丢弃。
    expect(clock.claimReport("p1", "failed")).toEqual({ report: true, shownAt: undefined });
    expect(clock.claimReport("p3", "failed")).toEqual({ report: true, shownAt: 3_000 });
  });

  it("claimReport：accepted 后收口，重复应答不再上报、不再计时；failed / noop 不收口", () => {
    const clock = createPermissionPromptShownClock();
    clock.markShown("dup", 1_000);
    expect(clock.claimReport("dup", "accepted")).toEqual({ report: true, shownAt: 1_000 });
    // 弹窗消失前的双击 / 连点：CLI 仍返回 accepted，但不再上报。
    clock.markShown("dup", 1_100);
    expect(clock.claimReport("dup", "accepted")).toEqual({ report: false });
    expect(clock.claimReport("dup", "failed")).toEqual({ report: false });

    // failed → accepted：两次都上报，沿用同一起点。
    clock.markShown("retry", 2_000);
    expect(clock.claimReport("retry", "failed")).toEqual({ report: true, shownAt: 2_000 });
    clock.markShown("retry", 2_500);
    expect(clock.claimReport("retry", "accepted")).toEqual({ report: true, shownAt: 2_000 });
    expect(clock.claimReport("retry", "duplicate")).toEqual({ report: false });

    // noop 不能证明应答已送达：之后的有效应答照常上报。
    clock.markShown("noop", 3_000);
    expect(clock.claimReport("noop", "noop")).toEqual({ report: true, shownAt: 3_000 });
    expect(clock.claimReport("noop", "accepted")).toEqual({ report: true, shownAt: 3_000 });
    expect(clock.claimReport("noop", "accepted")).toEqual({ report: false });
  });
});

describe("工具失败原因码 agent_step.error_code", () => {
  const engines: ConversationTelemetryEngine[] = [];
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    resetMessageTelemetryForTest();
  });

  it("白名单归一：命名 code 转小写，1–4 位数字写成 h<数字>，其余 other，缺失 unknown", () => {
    expect(normalizeToolErrorCode("TOOL_TIMEOUT")).toBe("tool_timeout");
    expect(normalizeToolErrorCode("tool_timeout")).toBe("tool_timeout");
    expect(normalizeToolErrorCode(" INVALID_INPUT ")).toBe("invalid_input");
    expect(normalizeToolErrorCode("TOOL_EXECUTION_FAILED")).toBe("tool_execution_failed");
    expect(normalizeToolErrorCode("agent_child_runtime_failed")).toBe("agent_child_runtime_failed");
    expect(normalizeToolErrorCode("8")).toBe("h8");
    expect(normalizeToolErrorCode("1302")).toBe("h1302");
    expect(normalizeToolErrorCode("12345")).toBe("other");
    expect(normalizeToolErrorCode("-32001")).toBe("other");
    expect(normalizeToolErrorCode("webfetch_fetch_failed")).toBe("other");
    expect(normalizeToolErrorCode("Error")).toBe("other");
    expect(normalizeToolErrorCode("ENOENT: no such file '/home/u/secret.txt'")).toBe("other");
    expect(normalizeToolErrorCode("")).toBe("unknown");
    expect(normalizeToolErrorCode(undefined)).toBe("unknown");
  });

  it("白名单与 CLI 的 CoreErrorType、AgentErrorCode 和 fact 里写死的 code 同步", () => {
    const cliSource = (path: string) =>
      readFileSync(new URL(`../../../apps/zcode-cli/packages/${path}`, import.meta.url), "utf8");
    const constValues = (source: string, name: string) => {
      const body = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`, "u").exec(
        source,
      )?.[1];
      return [...(body ?? "").matchAll(/:\s*"([a-z_]+)"/gu)].map((m) => m[1]!);
    };
    const agentCodes = constValues(cliSource("contracts/src/tools/agent.ts"), "AgentErrorCode");
    expect(agentCodes).toHaveLength(4);
    for (const code of agentCodes) {
      expect(normalizeToolErrorCode(code)).toBe(code);
      expect(sanitizeToolErrorCode(code)).toBe(code);
    }
    // fact 归一器里写死的 errorCode（如被用户停止的 turn 的 USER_INTERRUPT）同样要能识别。
    const factCodes = [
      ...cliSource("bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts").matchAll(
        /errorCode: "([A-Z_]+)"/gu,
      ),
    ].map((m) => m[1]!);
    expect(factCodes.length).toBeGreaterThan(0);
    for (const code of factCodes) {
      expect(normalizeToolErrorCode(code)).toBe(code.toLowerCase());
    }
    const source = cliSource("contracts/src/errors/index.ts");
    const block = /export const CoreErrorType = \{([\s\S]*?)\} as const;/u.exec(source)?.[1] ?? "";
    const types = [...block.matchAll(/:\s*"([a-z_]+)"/gu)].map((m) => m[1]!);
    expect(types).toHaveLength(27);
    for (const type of types) {
      expect(normalizeToolErrorCode(type.toUpperCase())).toBe(type);
      expect(sanitizeToolErrorCode(type)).toBe(type);
    }
  });

  it("出网兜底只放行归一后的取值，且幂等", () => {
    for (const raw of ["TOOL_TIMEOUT", "8", "x", undefined, "agent_unknown_type"]) {
      const normalized = normalizeToolErrorCode(raw);
      expect(sanitizeToolErrorCode(normalized)).toBe(normalized);
    }
    expect(sanitizeToolErrorCode("")).toBe("");
    expect(sanitizeToolErrorCode("TOOL_TIMEOUT")).toBe("other");
    expect(sanitizeToolErrorCode("8")).toBe("other");
    expect(sanitizeToolErrorCode("h12345")).toBe("other");
    expect(sanitizeToolErrorCode("/Users/me/.ssh/id_rsa")).toBe("other");
    expect(
      sanitizeTelemetryEventDetail("agent_step", {
        error_code: "ENOENT /home/u/a.txt",
        error_msg: "ENOENT /home/u/a.txt",
      }),
    ).toMatchObject({ error_code: "other", error_msg: "[redacted]" });
    expect(sanitizeTelemetryEventDetail("agent_step", { error_code: "h8" }).error_code).toBe("h8");
    // 其他事件同名字段（自动化创建结果）不受影响。
    expect(
      sanitizeTelemetryEventDetail("automation_create_result", { error_code: "limit" }).error_code,
    ).toBe("limit");
  });

  function setup() {
    const reports: Array<{ elementName: string; eventExtraDetail: Record<string, string> }> = [];
    let seq = 0;
    const engine = new ConversationTelemetryEngine({
      workspaceScopeKey: "test",
      now: () => 100 + seq,
      platform: { reportTelemetryEvent: async () => {}, reportArmsCustomEvent: async () => {} },
      reportEvent: async (report) => {
        reports.push(report);
      },
    });
    engines.push(engine);
    engine.acceptPromptSeed({
      sessionId: "s",
      sourceCommandId: "c",
      sendTime: 100,
      extraDetail: {},
    });
    const fact = (fields: Record<string, unknown>) =>
      engine.handleFact({
        version: 1,
        sessionId: "s",
        sourceCommandId: "c",
        turnId: "t",
        eventId: `e${++seq}`,
        eventSeq: seq,
        occurredAt: 100 + seq,
        ...fields,
      } as ConversationTelemetryInput);
    const steps = async () => {
      await engine.flushReportsForTest();
      return reports.filter((r) => r.elementName === "agent_step").map((r) => r.eventExtraDetail);
    };
    fact({ kind: "turn.started" });
    return { fact, steps };
  }

  it("CLI 工具终态的 errorCode 一路带到失败 tool step；成功和非工具 step 为空串", async () => {
    const t = setup();
    t.fact({ kind: "stream.chunk", channel: "text", firstChunk: true, chunkLength: 4 });
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "edit", toolName: "Edit" });
    t.fact({
      kind: "tool.lifecycle",
      phase: "failed",
      toolCallId: "edit",
      toolName: "Edit",
      errorCode: "8",
      errorMessage: "String to replace not found in /home/u/a.ts",
    });
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "fetch", toolName: "WebFetch" });
    t.fact({
      kind: "tool.lifecycle",
      phase: "failed",
      toolCallId: "fetch",
      toolName: "WebFetch",
      errorCode: "TOOL_TIMEOUT",
      errorMessage: "timed out",
    });
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "bare", toolName: "Bash" });
    t.fact({ kind: "tool.lifecycle", phase: "failed", toolCallId: "bare", toolName: "Bash" });
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "read", toolName: "Read" });
    t.fact({ kind: "tool.lifecycle", phase: "completed", toolCallId: "read", toolName: "Read" });
    t.fact({ kind: "turn.terminal", status: "success" });
    const steps = await t.steps();
    const byTool = (name: string) => steps.find((s) => s.tool_name === name)!;
    expect(byTool("Edit")).toMatchObject({
      status: "fail",
      error_type: "TOOL_EXEC_ERROR",
      error_code: "h8",
    });
    expect(byTool("WebFetch")).toMatchObject({ status: "fail", error_code: "tool_timeout" });
    expect(byTool("Bash")).toMatchObject({ status: "fail", error_code: "unknown" });
    expect(byTool("Read")).toMatchObject({ status: "success", error_code: "" });
    const generation = steps.find((s) => s.step_type === "generation")!;
    expect(generation.error_code).toBe("");
    for (const step of steps) expect(Object.hasOwn(step, "error_code")).toBe(true);
  });

  it("整轮失败时被一并关闭的工具 step 没有工具级 code，记 unknown", async () => {
    const t = setup();
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "bash", toolName: "Bash" });
    t.fact({ kind: "turn.terminal", status: "failed", errorCode: "MODEL_ERROR" });
    const steps = await t.steps();
    expect(steps.find((s) => s.tool_name === "Bash")).toMatchObject({
      status: "fail",
      error_code: "unknown",
    });
  });

  it("后台子 agent 的 Agent 汇总 step 取子会话 turn.terminal 的 errorCode", async () => {
    const t = setup();
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "agent", toolName: "Agent" });
    t.fact({
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "a1",
      childSessionId: "child",
      parentToolCallId: "agent",
      background: true,
    });
    t.fact({ kind: "tool.lifecycle", phase: "completed", toolCallId: "agent", toolName: "Agent" });
    t.fact({
      sessionId: "child",
      kind: "turn.terminal",
      status: "failed",
      errorCode: "MODEL_RATE_LIMITED",
      errorMessage: "429 quota",
    });
    const steps = await t.steps();
    const summary = steps.find((s) => s.tool_name === "Agent" && s.status === "fail");
    expect(summary).toMatchObject({ error_code: "model_rate_limited" });
  });

  it("后台子 agent 被用户停止时，Agent 汇总 step 记 user_interrupt 而不是 other", async () => {
    const t = setup();
    t.fact({ kind: "tool.lifecycle", phase: "started", toolCallId: "agent", toolName: "Agent" });
    t.fact({
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "a1",
      childSessionId: "child",
      parentToolCallId: "agent",
      background: true,
    });
    t.fact({ kind: "tool.lifecycle", phase: "completed", toolCallId: "agent", toolName: "Agent" });
    t.fact({
      sessionId: "child",
      kind: "turn.terminal",
      status: "interrupted",
      errorCode: "USER_INTERRUPT",
    });
    const steps = await t.steps();
    const summary = steps.find((s) => s.tool_name === "Agent" && s.status === "fail");
    expect(summary).toMatchObject({ error_code: "user_interrupt" });
  });
});

describe("Workflow run 结果 workflow_run_result", () => {
  const engines: ConversationTelemetryEngine[] = [];
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    resetMessageTelemetryForTest();
  });

  const base = { sessionId: "s", sourceCommandId: "launch-1", runId: "dwfrun-1", actorCount: 2 };

  it("终态与停止原因按白名单归一；非 stopped 时 stop_reason 为空串", () => {
    const detail = (status?: string, stopReason?: string) =>
      buildWorkflowRunResultTelemetryEvent({ ...base, status, stopReason }).eventExtraDetail;
    expect(detail("completed")).toEqual({
      workflow_run_id: "dwfrun-1",
      status: "completed",
      stop_reason: "",
      actor_count: "2",
    });
    expect(detail("errored", "user")).toMatchObject({ status: "errored", stop_reason: "" });
    for (const reason of WORKFLOW_RUN_STOP_REASONS) {
      expect(detail("stopped", reason)).toMatchObject({ status: "stopped", stop_reason: reason });
    }
    // stopped 却缺原因（CLI 丢掉了不认识的引擎原因）或原因不在白名单：other。
    expect(detail("stopped")).toMatchObject({ stop_reason: "other" });
    expect(detail("stopped", "quota /home/u")).toMatchObject({ stop_reason: "other" });
    expect(detail("weird")).toMatchObject({ status: "other", stop_reason: "" });
    expect(detail(undefined)).toMatchObject({ status: "other" });
  });

  it("事件属性：父会话、发起轮；不合规 run id 与计数不透传", () => {
    const event = buildWorkflowRunResultTelemetryEvent({ ...base, status: "completed" });
    expect(event).toMatchObject({
      elementName: "workflow_run_result",
      eventRegion: "app",
      eventType: "result",
      talkId: "s",
      messageId: "launch-1",
    });
    const odd = buildWorkflowRunResultTelemetryEvent({
      sessionId: "s",
      sourceCommandId: "",
      runId: "run /Users/me/secret",
      status: "completed",
      actorCount: Number.NaN,
    });
    expect(odd).not.toHaveProperty("messageId");
    expect(odd.eventExtraDetail).toMatchObject({ workflow_run_id: "", actor_count: "0" });
    expect(
      buildWorkflowRunResultTelemetryEvent({ ...base, actorCount: 3.7 }).eventExtraDetail
        .actor_count,
    ).toBe("3");
    expect(
      buildWorkflowRunResultTelemetryEvent({ ...base, actorCount: -1 }).eventExtraDetail
        .actor_count,
    ).toBe("0");
  });

  it("白名单与 fact schema、CLI 派生器、dwf 引擎的 RunStatus / RunStopReason 同步", () => {
    const read = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    const literals = (text: string) => [...text.matchAll(/"([a-z]+)"/gu)].map((m) => m[1]!).sort();
    const reasons = [...WORKFLOW_RUN_STOP_REASONS].sort();
    const statuses = [...WORKFLOW_RUN_RESULT_STATUSES].sort();

    const schema = read("packages/shared/src/zcode-protocol-v4/telemetry.ts");
    const schemaBlock =
      /const workflowLifecycleFactSchema = z([\s\S]*?)\.strict\(\);/u.exec(schema)?.[1] ?? "";
    expect(literals(/stopReason: z\.enum\(\[([^\]]*)\]\)/u.exec(schemaBlock)?.[1] ?? "")).toEqual(
      reasons,
    );
    expect(literals(/status: z\.enum\(\[([^\]]*)\]\)/u.exec(schemaBlock)?.[1] ?? "")).toEqual(
      statuses,
    );

    const cli = read(
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-workflow-facts.ts",
    );
    expect(literals(/type WorkflowRunStopReason = ([^;]*);/u.exec(cli)?.[1] ?? "")).toEqual(
      reasons,
    );
    expect(literals(/type WorkflowRunSettledStatus = ([^;]*);/u.exec(cli)?.[1] ?? "")).toEqual(
      statuses,
    );

    const engineTypes = read("apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts");
    expect(literals(/export type RunStopReason = ([^;]*);/u.exec(engineTypes)?.[1] ?? "")).toEqual(
      reasons,
    );
    // RunStatus 另含 pending / running 两个非终态。
    expect(literals(/export type RunStatus = ([^;]*);/u.exec(engineTypes)?.[1] ?? "")).toEqual(
      [...statuses, "pending", "running"].sort(),
    );
  });

  function setup() {
    const reports: Array<{
      elementName: string;
      eventExtraDetail: Record<string, string>;
      talkId?: string;
      messageId?: string;
    }> = [];
    let seq = 0;
    const engine = new ConversationTelemetryEngine({
      workspaceScopeKey: "test",
      now: () => 100 + seq,
      platform: { reportTelemetryEvent: async () => {}, reportArmsCustomEvent: async () => {} },
      reportEvent: async (report) => {
        reports.push(report);
      },
    });
    engines.push(engine);
    const fact = (fields: Record<string, unknown>) =>
      engine.handleFact({
        version: 1,
        sessionId: "parent",
        sourceCommandId: "launch-1",
        eventId: `e${++seq}`,
        eventSeq: seq,
        occurredAt: 100 + seq,
        kind: "workflow.lifecycle",
        runId: "dwfrun-1",
        ...fields,
      } as ConversationTelemetryInput);
    const spawn = (agentId: string, childSessionId: string) =>
      fact({ phase: "actor-spawned", agentId, childSessionId, toolCallId: "create" });
    const settle = (fields: Record<string, unknown>) => fact({ phase: "run-settled", ...fields });
    const results = async () => {
      await engine.flushReportsForTest();
      return reports.filter((r) => r.elementName === "workflow_run_result");
    };
    return { fact, spawn, settle, results, reports, engine };
  }

  it("没有子 agent 的 run 也上报；错误原文不出本机", async () => {
    const t = setup();
    t.settle({ status: "errored", errorMessage: "SyntaxError at /home/u/flow.ts:3" });
    const results = await t.results();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      talkId: "parent",
      messageId: "launch-1",
      eventExtraDetail: {
        workflow_run_id: "dwfrun-1",
        status: "errored",
        stop_reason: "",
        actor_count: "0",
      },
    });
    expect(JSON.stringify(t.reports)).not.toContain("SyntaxError");
    expect(JSON.stringify(t.reports)).not.toContain("/home/u");
  });

  it("有子 agent 的 run：计数按 agentId 去重，原有子 agent 汇总 step 照旧", async () => {
    const t = setup();
    t.spawn("site@0", "child-a");
    t.spawn("site@1", "child-b");
    // 同一子 agent 的 actor-created 重发（resume）不重复计数。
    t.spawn("site@0", "child-a");
    t.settle({
      status: "stopped",
      stopReason: "user",
      errorMessage: "Workflow run stopped (user)",
    });
    const results = await t.results();
    expect(results.map((r) => r.eventExtraDetail)).toEqual([
      { workflow_run_id: "dwfrun-1", status: "stopped", stop_reason: "user", actor_count: "2" },
    ]);
    const summaries = t.reports.filter(
      (r) =>
        r.elementName === "agent_step" &&
        r.eventExtraDetail.tool_call_id?.startsWith("tool_workflow_"),
    );
    expect(summaries).toHaveLength(2);
    for (const step of summaries) {
      expect(step.eventExtraDetail).toMatchObject({ status: "fail", workflow_run_id: "dwfrun-1" });
    }
  });

  it("同一 runId 每次结算都报（停下后恢复再跑完），计数跨结算累计；同一 fact 重投不重复", async () => {
    const t = setup();
    t.spawn("site@0", "child-a");
    t.settle({ status: "stopped", stopReason: "provider" });
    // 恢复后同一个 run：做完的子 agent 不一定重发 actor-created，新派的子 agent 照常登记。
    t.spawn("site@1", "child-b");
    t.fact({ eventId: "settle-2", phase: "run-settled", status: "completed" });
    t.fact({ eventId: "settle-2", phase: "run-settled", status: "completed" });
    const results = await t.results();
    expect(results.map((r) => r.eventExtraDetail)).toEqual([
      { workflow_run_id: "dwfrun-1", status: "stopped", stop_reason: "provider", actor_count: "1" },
      { workflow_run_id: "dwfrun-1", status: "completed", stop_reason: "", actor_count: "2" },
    ]);
    expect(results.every((r) => r.messageId === "launch-1")).toBe(true);
  });

  it("修订：旧 run 记 superseded，新 run 另起 runId、沿用发起轮", async () => {
    const t = setup();
    t.spawn("site@0", "child-a");
    t.settle({ status: "stopped", stopReason: "superseded" });
    t.fact({ runId: "dwfrun-2", phase: "actor-spawned", agentId: "site@0", childSessionId: "c2" });
    t.fact({ runId: "dwfrun-2", phase: "run-settled", status: "completed" });
    const results = await t.results();
    expect(results.map((r) => [r.messageId, r.eventExtraDetail])).toEqual([
      [
        "launch-1",
        {
          workflow_run_id: "dwfrun-1",
          status: "stopped",
          stop_reason: "superseded",
          actor_count: "1",
        },
      ],
      [
        "launch-1",
        { workflow_run_id: "dwfrun-2", status: "completed", stop_reason: "", actor_count: "1" },
      ],
    ]);
  });
});
