import { readFile } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { registerMentionSelectionCases } from "#e2e/helpers/mention-selection-cases";

// E2E_MENTION_SELECTION：仅编辑草稿；不发送 prompt，不需要 synthetic provider 响应。
describe("mention selection and canonical clipboard", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    await assertNoProviderRequests();
  });
  afterEach(async () => {
    await assertNoProviderRequests();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  registerMentionSelectionCases();
});

async function assertNoProviderRequests() {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath)
    throw new Error("Provider capture path is required for the no-request assertion");
  // 缺少取证文件不能被当作零请求，否则 fixture 隔离可能假通过。
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  expect(capture.records).toEqual([]);
}
