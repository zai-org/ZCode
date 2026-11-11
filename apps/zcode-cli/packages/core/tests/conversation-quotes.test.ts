import { describe, expect, it } from "vitest";
import { withConversationQuotes } from "../src/runtime/helpers/conversation-quotes.js";
import { buildPersistedConversationInputIntent } from "../src/runtime/methods/input-intent-persistence.js";

describe("structured conversation quotes", () => {
  it("keeps canonical body separate while the model receives original source metadata", () => {
    const conversationQuotes = [
      {
        text: "/stop\noriginal",
        senderName: "Ryan Bot",
        senderId: "ou_bot",
        messageId: "om_quote",
        sentAt: "2026-09-09T10:32:44+08:00",
      },
    ];
    const model = withConversationQuotes("", conversationQuotes);
    expect(model).toContain("<conversation_quote>");
    expect(model).not.toContain("userselect");
    expect(model).toContain(JSON.stringify(conversationQuotes));
    for (const state of ["queued", "drained"] as const) {
      expect(
        buildPersistedConversationInputIntent(
          model,
          {
            kind: "sendText",
            text: "",
            conversationQuotes,
            sourceCommandId: "c",
            queueItemId: "q",
            clientId: "desktop",
            admissionSeq: 1,
            admittedAt: 1,
            requestedDelivery: "queue",
            admittedDelivery: "queue",
          },
          state,
        ),
      ).toMatchObject({ text: "", conversationQuotes });
    }
  });
  it("tells the model that a quote comment is the user's annotation on that passage", () => {
    const conversationQuotes = [
      { text: "| 列 | 值 |\n| --- | --- |", comment: "这张表为什么缺少单位？", agent: "Explore" },
      { text: "plain quote" },
    ];
    const model = withConversationQuotes("请一起回答", conversationQuotes);
    expect(model).toContain(JSON.stringify(conversationQuotes));
    expect(model).toContain("user annotation on that exact quoted text");
    expect(model).toContain("`agent` field names the subagent");
    expect(
      buildPersistedConversationInputIntent(
        model,
        {
          kind: "sendText",
          text: "请一起回答",
          conversationQuotes,
          sourceCommandId: "c",
          queueItemId: "q",
          clientId: "desktop",
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "queue",
          admittedDelivery: "queue",
        },
        "drained",
      ),
    ).toMatchObject({ conversationQuotes });
    // 没有批注时不追加说明，普通引用的模型输入保持原样。
    expect(withConversationQuotes("", [{ text: "plain quote", comment: "  " }])).not.toContain(
      "user annotation",
    );
  });
  it("keeps bot delivery with the service and treats identity as attribution", () => {
    const result = withConversationQuotes("weather?", [], {
      botId: "bot",
      chatId: "chat",
      provider: "feishu",
    });
    expect(result).toContain("automatically delivers");
    expect(result).toContain("timezone");
    expect(result).toContain("explicitly requests an additional");
    expect(result).not.toContain("bot_topic_context");
  });
  it("persists native references without exposing channel reply instructions or send references", () => {
    const botGroupSource = {
      botId: "bot",
      chatId: "chat",
      provider: "feishu" as const,
      appId: "app",
      contentParts: [
        {
          type: "channelMention" as const,
          refId: "m1",
          name: "Ryan Bot",
          targetId: "ou_target",
          channel: "feishu" as const,
          idType: "open_id" as const,
          entityType: "unknown" as const,
        },
      ],
    };
    const model = withConversationQuotes("帮我 @Ryan Bot", [], botGroupSource);
    for (const removed of [
      "ReplyToChannel",
      "mentionName",
      "needs_clarification",
      "Trusted native mention references",
      '"refId"',
    ])
      expect(model).not.toContain(removed);
    expect(model).toContain('"name":"Ryan Bot"');
    expect(model).not.toContain("ou_target");
    for (const state of ["queued", "drained"] as const)
      expect(
        buildPersistedConversationInputIntent(
          model,
          { kind: "sendText", text: "帮我 @Ryan Bot", sourceCommandId: "input", botGroupSource },
          state,
        ),
      ).toMatchObject({ text: "帮我 @Ryan Bot", botGroupSource });
  });
  it("pins the current bot identity and distinguishes per-message assignment from shared context", () => {
    const model = withConversationQuotes("continue", [], {
      botId: "local-bot",
      provider: "feishu",
      botIdentity: { name: "Travel Bot", openId: "ou_self" },
      mentionedBot: false,
      messages: [
        {
          messageId: "m1",
          text: "continue",
          mentionedBot: false,
          senderId: "user",
          senderName: "Member",
          attachmentIndexes: [],
        },
      ],
    });
    expect(model).toContain('"name":"Travel Bot"');
    expect(model).toContain('"openId":"ou_self"');
    expect(model).toContain('"mentionedBot":false');
    expect(model).toContain("Shared context is not shared task ownership");
    expect(model).toContain("no visible reply");
  });
  it("distinguishes same-name recipients by their trusted self association", () => {
    const project = (ids: string[]) =>
      withConversationQuotes("@Assistant outline; @Assistant implement", [], {
        botId: "bot",
        provider: "feishu",
        botIdentity: { name: "Configured Bot", openId: "ou_self" },
        contentParts: ids.map((targetId, index) => ({
          type: "channelMention",
          refId: `m${index}`,
          name: "Assistant",
          targetId,
          channel: "feishu",
          idType: "open_id",
          entityType: "unknown",
        })),
      });
    const first = project(["ou_self", "ou_other"]);
    const swapped = project(["ou_other", "ou_self"]);
    expect(first).not.toBe(swapped);
    expect(first).toContain('"name":"Assistant","channel":"feishu","isCurrentBot":true');
    expect(swapped).toContain('"name":"Assistant","channel":"feishu","isCurrentBot":true');
    expect(first).not.toContain("ou_other");
    expect(swapped).not.toContain("ou_other");
  });
  it("locates native self mentions among identical typed names and repeated batch mentions", () => {
    const mention = {
      type: "channelMention" as const,
      refId: "self",
      name: "Assistant",
      targetId: "ou_self",
      channel: "feishu" as const,
      idType: "open_id" as const,
      entityType: "unknown" as const,
    };
    const source = {
      botId: "bot",
      provider: "feishu" as const,
      botIdentity: { name: "Configured Bot", openId: "ou_self" },
    };
    const text = "@Assistant summarize; @Assistant implement";
    const first = withConversationQuotes(text, [], {
      ...source,
      contentParts: [mention, { type: "text", text: " summarize; @Assistant implement" }],
    });
    const last = withConversationQuotes(text, [], {
      ...source,
      contentParts: [
        { type: "text", text: "@Assistant summarize; " },
        mention,
        { type: "text", text: " implement" },
      ],
    });
    expect(first).not.toBe(last);
    expect(first).toContain(
      '"isCurrentBot":true},{"type":"text","text":" summarize; @Assistant implement"}',
    );
    expect(last).toContain('"text":"@Assistant summarize; "},{"type":"channelMention"');
    const batch = withConversationQuotes(text, [], {
      ...source,
      messages: [
        {
          messageId: "first",
          text,
          senderId: "user",
          senderName: "Member",
          attachmentIndexes: [],
          contentParts: [
            mention,
            { type: "text", text: " summarize; " },
            { ...mention, refId: "second" },
          ],
        },
        {
          messageId: "last",
          text,
          senderId: "user",
          senderName: "Member",
          attachmentIndexes: [],
          contentParts: [
            { type: "text", text: " implement " },
            { ...mention, refId: "third" },
          ],
        },
      ],
    });
    expect(batch).toContain('"messageId":"first","contentParts"');
    expect(batch).toContain('"messageId":"last","contentParts"');
    expect(batch).not.toContain('"refId"');
    expect(batch).not.toContain('"targetId"');
  });
  it("leaves plain input unchanged", () => {
    expect(withConversationQuotes("hello", [])).toBe("hello");
  });
});
