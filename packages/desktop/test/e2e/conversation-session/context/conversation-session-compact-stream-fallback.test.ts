// SF 是 catalog F08 的 transport 接线门禁：compact 必须先发 stream 请求，首腿失败后才回退到 non-stream。
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { countUpstreamRequestsContainingAll } from "#e2e/helpers/conversation-session-network";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const SEED_MARKER = "E2E_COMPACT_STREAM_FALLBACK_SEED";
const SEED_REPLY = "COMPACT_STREAM_FALLBACK_SEED_OK";
const COMPACT_PROMPT_MARKER = "CRITICAL: Respond with TEXT ONLY";

describe("SF compact stream-first fallback", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stream 首腿失败后只回退一次 non-stream，并完成 manual compact", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();

    await sendV4Prompt(`${SEED_MARKER} 请回复种子`);
    await waitForV4TimelineContaining(SEED_REPLY, 45000);
    await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
      "compact fallback seed 没有回到空闲态",
      45000,
    );

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "compact fallback composer 没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);

    const compactRequestMarkers = [SEED_MARKER, SEED_REPLY, COMPACT_PROMPT_MARKER];
    await browser.waitUntil(
      async () => (await countUpstreamRequestsContainingAll(compactRequestMarkers)) === 2,
      {
        timeout: 30000,
        timeoutMsg: "compact 没有形成 stream failure → non-stream success 两段请求",
      },
    );

    const fallbackCapture = await waitForUpstreamNetworkCapture(SEED_MARKER);
    expect(fallbackCapture.replay?.fixtureId).toBe("compact-stream-fallback-non-stream-success");
    expect(fallbackCapture.statusCode).toBe(200);
    expect((fallbackCapture.requestJson as { stream?: unknown }).stream).not.toBe(true);
  });
});
