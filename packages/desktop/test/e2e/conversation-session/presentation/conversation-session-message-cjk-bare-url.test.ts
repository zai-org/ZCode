import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_MESSAGE_CJK_BARE_URL";

describe("消息正文中文边界裸链接", () => {
  after(async () => {
    await clearAppData();
  });

  it("MLC02: 裸链接紧跟强调符与中文标点时只链接 URL 本身", async () => {
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${MARKER}: Reply with bare links next to CJK text.`);
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes(`${MARKER}_DONE`),
      "中文边界裸链接夹具未完成",
      60_000,
    );
    await browser.$('button[title="https://example.com/b"]').waitForDisplayed();

    const rendered = await browser.execute(() => {
      const linkAt = (url: string) => document.querySelector<HTMLElement>(`button[title="${url}"]`);
      const paragraphText = (prefix: string) =>
        Array.from(document.querySelectorAll("p"))
          .map((node) => node.textContent ?? "")
          .find((text) => text.startsWith(prefix));
      return {
        links: Array.from(document.querySelectorAll<HTMLElement>("button[title]"))
          .map((node) => ({ title: node.getAttribute("title"), text: node.textContent }))
          .filter((link) => link.title?.startsWith("https://example.com/")),
        strongWrapsSite: linkAt("https://example.com/site")?.closest("strong") != null,
        emphasisWrapsQuery: linkAt("https://example.com/a?q=1")?.closest("em") != null,
        boldLine: paragraphText("线上已替换"),
        emphasisLine: paragraphText("另见"),
        inlineCode: Array.from(document.querySelectorAll("code"))
          .map((node) => node.textContent)
          .find((text) => text?.includes("example.com/code")),
        blockCode: Array.from(document.querySelectorAll("[data-language] diffs-container"))
          .map((node) => node.shadowRoot?.textContent ?? "")
          .filter((text) => text.includes("-code")),
      };
    });

    expect(rendered.links).toEqual([
      { title: "https://example.com/site", text: "https://example.com/site" },
      { title: "https://example.com/a?q=1", text: "https://example.com/a?q=1" },
      { title: "https://example.com/b", text: "https://example.com/b" },
    ]);
    expect(rendered.strongWrapsSite).toBe(true);
    expect(rendered.emphasisWrapsQuery).toBe(true);
    expect(rendered.boldLine).toBe("线上已替换：https://example.com/site（115 秒，链接不变）");
    expect(rendered.emphasisLine).toBe(
      "另见 https://example.com/a?q=1，以及 https://example.com/b。结束",
    );
    expect(rendered.inlineCode).toBe("**https://example.com/code**（");
    expect(rendered.blockCode).toHaveLength(2);
    expect(rendered.blockCode[0]).toContain("引用代码：https://example.com/quote-code。");
    expect(rendered.blockCode[1]).toContain("列表代码：https://example.com/list-code。");
    expect(rendered.blockCode.join("")).not.toContain("<https://");
  }).timeout(120_000);
});
