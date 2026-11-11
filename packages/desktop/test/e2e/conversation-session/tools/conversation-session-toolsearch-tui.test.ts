import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { startToolSearchTerminal } from "#e2e/helpers/toolsearch-terminal";
import {
  TOOLSEARCH_NOTICE,
  TOOLSEARCH_DONE,
  toolSearchResponseStage,
  type ToolSearchRequest,
} from "#e2e/helpers/toolsearch-provider";

describe("ToolSearch TUI 真实终端", () => {
  it("TS02-TUI: 强开搜索、resume 默认关闭、continue 再开启恢复真实引用", async function () {
    this.timeout(180_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-tui");
    let terminal: ReturnType<typeof startToolSearchTerminal> | undefined;
    const typeAndPaint = async (keys: string) => {
      const before = terminal!.frameCount();
      terminal!.write(keys);
      await browser.waitUntil(async () => terminal!.frameCount() > before, {
        timeout: 10_000,
        timeoutMsg: "TUI 按键后没有绘制新帧",
      });
    };
    const submit = async (value: string) => {
      // 动画也会触发重绘；仅等帧数会在输入状态尚未提交时按 Enter，导致旧文本回写。
      // 使用终端粘贴协议，并等待本次输入实际绘制，保持输入与提交的真实顺序。
      const before = terminal!.output().length;
      terminal!.write(`\x1b[200~${value}\x1b[201~`);
      await browser.waitUntil(async () => terminal!.output().slice(before).includes(value), {
        timeout: 10_000,
        timeoutMsg: "TUI 本次输入尚未绘制",
      });
      terminal!.write("\r");
    };
    const turn = async (args: string[], marker: string) => {
      const before = fixture.requests.length;
      const completed = `${TOOLSEARCH_DONE}_${marker}`;
      fixture.setResponse((body, response) => {
        const stage = toolSearchResponseStage(body);
        fixture.reply(
          body,
          response,
          stage === "done" ? `done-${marker.split("_").at(-1)!.toLowerCase()}` : stage,
        );
      });
      terminal = startToolSearchTerminal(fixture, args);
      await browser.waitUntil(async () => terminal!.ready(), {
        timeout: 30_000,
        timeoutMsg: "TUI 未完成首帧终端绘制",
      });
      const beforeModel = terminal.output().length;
      await submit("/model toolsearch-process/test-toolsearch");
      await browser.waitUntil(
        async () => {
          const rendered = terminal!.output().slice(beforeModel);
          // 终端增量绘制只会重画变化后缀；完整占位文字不一定再次出现在 PTY 流中。
          return rendered.includes("Model switched to toolsearch-process/test-toolsearch");
        },
        {
          timeout: 15_000,
          timeoutMsg: "TUI 未切换到隔离的普通 Anthropic provider",
        },
      );
      const beforeEffort = terminal.output().length;
      await submit("/effort disabled");
      await browser.waitUntil(
        async () => {
          const rendered = terminal!.output().slice(beforeEffort);
          return rendered.includes("Reasoning effort switched to disabled");
        },
        { timeout: 15_000, timeoutMsg: "TUI 未确认测试模型的思考档位" },
      );
      await submit(marker);
      await browser.waitUntil(async () => terminal!.output().includes(completed), {
        timeout: 30_000,
        timeoutMsg: "TUI 没有显示模型完成文本",
      });
      // 增量重绘只输出变化的字符，原始 PTY 文本不保证含完整退出提示；等新帧后确认退出。
      await typeAndPaint("\x03");
      terminal.write("\x03");
      expect(await terminal.done).toBe(0);
      await terminal.close();
      terminal = undefined;
      return fixture.requests
        .slice(before)
        .filter(({ body }) => body.tools?.length)
        .map(({ body }) => body);
    };
    const loaded = (body: ToolSearchRequest) => {
      expect(body.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(true);
      expect(JSON.stringify(body.messages)).toContain(
        '"type":"tool_reference","tool_name":"TodoRead"',
      );
      expect(JSON.stringify(body.messages).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
    };
    try {
      // TUI 现有登录门槛要求一个有效计划连接；请求仍选择隔离的普通测试 Provider。
      // 只在隔离 HOME 中写虚构身份，不读取或复用本机登录凭据。
      await mkdir(join(fixture.root, ".zcode", "v2"), { recursive: true });
      await writeFile(
        join(fixture.root, ".zcode", "v2", "credentials.json"),
        JSON.stringify({
          "account-provider:account:zai-individual-coding-plan:identity": "toolsearch-e2e",
          "account-provider:coding-plan:account:zai-individual-coding-plan:account:toolsearch-e2e:api-key":
            "test-only",
        }),
      );
      const initial = await turn(["--toolsearch-mode", "native"], "E2E_TOOLSEARCH_INITIAL");
      expect(initial).toHaveLength(3);
      expect(initial[0]!.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
      loaded(initial[1]!);
      const db = new DatabaseSync(join(fixture.root, "session.sqlite"), { readOnly: true });
      let sessionId: string;
      try {
        sessionId = (
          db.prepare("SELECT id FROM session ORDER BY time_created DESC LIMIT 1").get() as {
            id: string;
          }
        ).id;
      } finally {
        db.close();
      }
      const off = await turn(["--resume", sessionId], "E2E_TOOLSEARCH_OFF");
      expect(off).toHaveLength(1);
      expect(off[0]!.tools?.some((tool) => tool.name === "TodoRead")).toBe(true);
      expect(off[0]!.tools?.some((tool) => tool.name === "ToolSearch" || tool.defer_loading)).toBe(
        false,
      );
      expect(JSON.stringify(off[0]!.messages)).not.toContain("tool_reference");
      expect(JSON.stringify(off[0]!.messages)).not.toContain(TOOLSEARCH_NOTICE);
      const on = await turn(["--toolsearch-mode", "native", "--continue"], "E2E_TOOLSEARCH_ON");
      expect(on).toHaveLength(1);
      loaded(on[0]!);
    } finally {
      await terminal?.close();
      await fixture.close();
    }
  });
});
