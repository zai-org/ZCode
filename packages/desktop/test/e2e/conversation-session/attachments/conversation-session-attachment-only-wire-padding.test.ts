// T06W：附件-only query 的 UI/session 事实保持空正文，只在 provider wire 边界补固定 (no content)。
// 证据层 L3：真实 paste → begin/chunk/commit → draft firstInput → Anthropic Messages request matcher。
import { TID_V4_COMPOSER_INPUT, TID_V4_ROW_ATTACHMENTS } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  waitForV4Pane,
  waitForV4RowAttachments,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const FILENAME = "e2e-attachment-wire-padding.txt";
const ATTACHMENT_CONTENT = "E2E_ATTACHMENT_WIRE_CONTEXT";
const REPLY_MARKER = "ATTACHMENT_WIRE_PADDING_OK";

describe("T06W：attachment-only provider wire padding", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("空正文附件首发只在 provider wire user content 补固定 fallback", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    expect(await pasteTextAttachment()).toBe(true);
    await clickV4Send();

    const capture = await waitForUpstreamNetworkCapture(ATTACHMENT_CONTENT);
    // 当前 adapter 契约使用非空 fallback，避免 Provider trim 掉旧版空格占位。
    expect(
      readUserWireTextParts(capture.requestJson).filter((part) => part === "(no content)"),
    ).toHaveLength(1);
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "T06W attachment-only 首发后没有回到 completed session",
      60_000,
    );

    // Bug 根因：附件上下文从 user query 拆出后，provider 会收到空 user content 并拒绝。
    // 补位必须只发生在 adapter wire 边界；user row 仍只展示真实附件，不新增可见正文。
    const attachmentsText = await waitForV4RowAttachments(30_000);
    expect(attachmentsText).toContain(FILENAME);
    const userRowText = await browser.execute(
      (prefix) =>
        document.querySelector(`[data-testid^="${prefix}-"]`)?.closest<HTMLElement>("[data-row-id]")
          ?.innerText ?? null,
      TID_V4_ROW_ATTACHMENTS,
    );
    expect(userRowText).not.toBeNull();
    expect(userRowText).not.toContain("(no content)");
  });
});

async function pasteTextAttachment(): Promise<boolean> {
  return browser.execute(
    (inputTestId, filename, content) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const editable =
        input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        (input?.getAttribute("contenteditable") === "true" ? input : null);
      if (!editable) return false;

      const clipboard = new DataTransfer();
      clipboard.items.add(new File([content], filename, { type: "text/plain" }));
      // Bug 根因：文本附件会被拆成 prompt-attachment reminder，真实 user query 因而为空；
      // 这里必须只提供 File、不附带 clipboard plain text，才能稳定命中 adapter padding 分支。
      editable.focus();
      editable.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    },
    TID_V4_COMPOSER_INPUT,
    FILENAME,
    ATTACHMENT_CONTENT,
  );
}

function readUserWireTextParts(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];

  const parts: string[] = [];
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "user"
    ) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts;
}
