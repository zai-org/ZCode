import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "#e2e/helpers/conversation-session-network";
import {
  clickV4Send,
  getV4ComposerAttachments,
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4RowAttachments,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const FILE_BYTES = 16 * 1024 * 1024;
const LINE = "这是一个合法的中文文本附件。\n";
const GBK_LINE = Buffer.from("d6d0cec4".repeat(8) + "0a", "hex");
const ASCII_LINE = "a".repeat(63);
const REPLY = "LARGE_TEXT_ATTACHMENT_OK";
const CASES = [
  { name: "only", prompt: "", marker: "E2E_LARGE_TEXT_ONLY_CONTENT", encoding: "utf8" },
  {
    name: "with-query",
    prompt: "E2E_LARGE_TEXT_QUERY 请读取附件。",
    marker: "E2E_LARGE_TEXT_QUERY_CONTENT",
    encoding: "utf8",
  },
  {
    name: "gbk",
    prompt: "E2E_LARGE_TEXT_GBK 请读取附件。",
    marker: "E2E_LARGE_TEXT_GBK_CONTENT",
    encoding: "gbk",
  },
];

describe("T18：大文本附件编码采样边界", () => {
  const directory = resolveE2ERuntimePath("large-text-attachment");

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
    await clearAppData();
  });

  for (const testCase of CASES) {
    it(`T18 ${testCase.name}: provider 收到正确正文且限于前 2000 行`, async function () {
      this.timeout(180_000);
      await prepareV4ConversationE2E();
      await mkdir(directory, { recursive: true });
      const filename = `e2e-large-text-${testCase.name}.txt`;
      const path = join(directory, filename);
      // Bug 根因：4096 字节样本在中文字符中间结束，旧编码探测拒读后附件正文被过滤。
      // marker 位于样本之后且在前 2000 行以内，避免 marker 改变触发问题的字节边界。
      const isGbk = testCase.encoding === "gbk";
      const line = isGbk ? GBK_LINE : Buffer.from(LINE);
      // GBK 的 D6 | D0 位于采样边界；D6 单独是未完成 UTF-8 候选，补读 D0 后必须排除它。
      const prefix = isGbk
        ? Buffer.concat([Buffer.from(`${ASCII_LINE}\n`.repeat(63) + ASCII_LINE), GBK_LINE])
        : Buffer.from(LINE.repeat(200));
      const bytes = Buffer.concat([
        prefix,
        Buffer.from(`${testCase.marker}\n`),
        Buffer.alloc(Math.ceil(FILE_BYTES / line.length) * line.length).fill(line),
      ]);
      expect(bytes.byteLength).toBeGreaterThan(FILE_BYTES);
      if (isGbk) {
        expect(Array.from(bytes.subarray(4095, 4099))).toEqual([0xd6, 0xd0, 0xce, 0xc4]);
      } else {
        expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
      }
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096)),
      ).toThrow();
      await writeFile(path, bytes);

      await pickV4ComposerFiles([path]);
      await browser.waitUntil(
        async () => {
          const attachments = await getV4ComposerAttachments();
          return attachments.some(
            (item) => item.text.includes(filename) && item.uploadStatus === "ready",
          );
        },
        { timeout: 30_000, timeoutMsg: "本地文本附件未 ready" },
      );
      if (testCase.prompt) await setV4ComposerText(testCase.prompt);

      const query = {
        includes: testCase.prompt ? [testCase.prompt] : [],
        excludes: ["CRITICAL: Respond with TEXT ONLY"],
      };
      const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
      await clickV4Send();
      await browser.waitUntil(
        async () => (await getUpstreamRequestEvidence(query, { afterIndex })).length > 0,
        {
          timeout: 60_000,
          timeoutMsg: "附件发送未产生 provider 请求",
        },
      );
      // 抓取实际首个主请求，失败时直接显示缺失的正文，不能靠回复成功掩盖附件丢失。
      const [request] = await getUpstreamRequestEvidence(query, { afterIndex });
      const wire = JSON.stringify(request?.requestJson);
      expect({ marker: testCase.marker, present: wire.includes(testCase.marker) }).toEqual({
        marker: testCase.marker,
        present: true,
      });
      expect(wire).toContain(filename);
      const expectedLine = isGbk ? "中文".repeat(8) : LINE.trimEnd();
      expect(wire).toContain(`1\\t${isGbk ? ASCII_LINE : expectedLine}`);
      if (isGbk) expect(wire).toContain(`64\\t${ASCII_LINE}${expectedLine}`);
      expect(wire).toContain(`2000\\t${expectedLine}`);
      expect(wire).not.toContain("2001\\t");
      expect(wire).not.toContain("\uFFFD");
      if (testCase.prompt) expect(wire).toContain(testCase.prompt);
      await waitForV4TimelineContaining(REPLY, 60_000);
      await waitForV4Pane((snapshot) => !snapshot.canStop, "附件首发没有完成", 60_000);
      expect(await waitForV4RowAttachments(30_000, [filename])).toContain(filename);
      await browser.electron.restoreAllMocks();
    });
  }
});
