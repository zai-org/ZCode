import { resolveModelSelectionAtAdmission } from "../src/zcode-protocol-v4/commands/input-admission.js";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  isConversationInputAdmissionCommand,
  resolveInputCommandForAdmission,
} from "../src/zcode-protocol/v4-bridge.js";
import { inputIntentMetadata } from "../src/zcode-protocol-v4/commands/input-intent.js";

function envelope(type: CommandEnvelope["type"], payload: unknown): CommandEnvelope {
  return {
    commandId: "cmd-new",
    clientId: "client-new",
    sessionId: "s-parent",
    type,
    payload,
    issuedAt: 1,
  };
}

describe("v4 input admission canonical intent", () => {
  it("在写接纳账本前分离旧尾块，并保存新快照字段", () => {
    const genUiContext = [{ path: "/project/example.html", state: { stage: "entry" } }];
    for (const payload of [
      { text: "question", genUiContext },
      {
        text: `question\n\n<untrusted_gen_ui_state>\n${JSON.stringify(genUiContext)}\n</untrusted_gen_ui_state>`,
      },
    ]) {
      expect(
        resolveInputCommandForAdmission(envelope("sendText", payload), "s-parent", vi.fn()),
      ).toMatchObject({ text: "question", genUiContext });
    }
  });
  it("gateway admission 接线包含 compact/edit/retry，排除非输入命令", () => {
    expect(isConversationInputAdmissionCommand("compact")).toBe(true);
    expect(isConversationInputAdmissionCommand("editUserQuery")).toBe(true);
    expect(isConversationInputAdmissionCommand("retryTurn")).toBe(true);
    expect(isConversationInputAdmissionCommand("applyFileRewind")).toBe(false);
  });

  it("非输入命令不创建 session_input", () => {
    expect(resolveInputCommandForAdmission(envelope("stop", {}), "s-parent", vi.fn())).toBeNull();
  });

  it("compact admission 保留 typed maintenance intent，不伪装成 sendText", () => {
    expect(resolveInputCommandForAdmission(envelope("compact", {}), "s-parent", vi.fn())).toEqual({
      kind: "compact",
      text: "/compact",
      attachments: [],
    });
  });

  it("sendText admission 保留 Highspeed message metadata", () => {
    const highspeed = {
      schemaVersion: 1 as const,
      cardId: "hsc-1",
      taskId: "s-parent",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
    };

    expect(
      resolveInputCommandForAdmission(
        envelope("sendText", { text: "accelerate", highspeedMeta: highspeed }),
        "s-parent",
        vi.fn(),
      ),
    ).toEqual({
      kind: "sendText",
      text: "accelerate",
      attachments: [],
      highspeed,
    });

    expect(
      inputIntentMetadata(
        {
          ...envelope("sendText", { text: "accelerate", highspeedMeta: highspeed }),
          __v4Admission: { admissionSeq: 1, admittedAt: 1, queueItemId: "queue-highspeed" },
        } as unknown as CommandEnvelope,
        { requestedDelivery: "startNow", text: "accelerate" },
      ).highspeed,
    ).toEqual(highspeed);
  });

  it("retry 以新 commandId admission，但保留 canonical kind/delivery/attachments/provenance", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "retryTurn",
      row: {},
      messageId: "msg-assistant",
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: false,
        intent: {
          kind: "sendGoalCommand",
          text: "original objective",
          inputOrigin: "mobile",
          botGroupSource: {
            provider: "feishu",
            botId: "bot",
            chatId: "group",
            senderId: "member",
            senderName: "Member",
            messageId: "message",
          },
          sourceCommandId: "cmd-original",
          clientId: "client-original",
          queueItemId: "queue-original",
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.goalUnsupported",
          attachments: [
            {
              ref: "attachment://a",
              fileName: "a.txt",
              mime: "text/plain",
              bytes: 1,
              sourceKind: "topic-history",
              messageCount: 1,
            },
          ],
          provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
        },
      },
    });

    expect(
      resolveInputCommandForAdmission(
        envelope("retryTurn", {
          target: { rowId: 7, entityId: "msg-assistant" },
        }),
        "s-parent",
        resolve,
      ),
    ).toEqual({
      kind: "sendGoalCommand",
      text: "original objective",
      inputOrigin: "mobile",
      botGroupSource: {
        provider: "feishu",
        botId: "bot",
        chatId: "group",
        senderId: "member",
        senderName: "Member",
        messageId: "message",
      },
      attachments: [
        {
          ref: "attachment://a",
          fileName: "a.txt",
          mime: "text/plain",
          bytes: 1,
          sourceKind: "topic-history",
          messageCount: 1,
        },
      ],
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      fallbackReasonCode: "guide.goalUnsupported",
      provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
    });
  });

  it("compact-covered edit 只在原 session admission", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "editUserQuery",
      row: {},
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: true,
        intent: {
          kind: "sendText",
          text: "old",
          sourceCommandId: "cmd-original",
        },
      },
    });
    const command = envelope("editUserQuery", {
      target: { rowId: 7, entityId: "msg-user" },
      newText: "edited",
    });

    expect(resolveInputCommandForAdmission(command, "s-parent", resolve)).toMatchObject({
      kind: "sendText",
      text: "edited",
      provenance: { sourceCommandId: "cmd-original" },
    });
  });
});

describe("Bot model selection admission", () => {
  const oldSelection = {
    providerId: "start",
    modelId: "same",
    options: { reasoningLevel: "high" },
  };
  const newSelection = {
    providerId: "bigmodel",
    modelId: "same",
    options: { reasoningLevel: "high" },
  };
  it("切换已确认后，旧异步读取不能覆盖当前会话选择", () => {
    expect(
      resolveModelSelectionAtAdmission(newSelection, {
        modelSelection: oldSelection,
        modelSelectionBasis: oldSelection,
      }),
    ).toEqual(newSelection);
  });
  it("依据仍有效时保留账号解析结果", () => {
    expect(
      resolveModelSelectionAtAdmission(oldSelection, {
        modelSelection: newSelection,
        modelSelectionBasis: oldSelection,
      }),
    ).toEqual(newSelection);
  });
  it("桌面显式提交和已冻结输入不受影响", () => {
    expect(
      resolveModelSelectionAtAdmission(newSelection, { modelSelection: oldSelection }),
    ).toEqual(oldSelection);
  });
});
