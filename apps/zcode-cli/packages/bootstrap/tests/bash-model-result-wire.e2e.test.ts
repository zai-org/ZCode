// Bash 结果的模型可见文本走真实 runtime、真实 Bash adapter 与 `anthropic-messages` wire：
// 硬超时（04-bash.md「模型 result 映射规则」）、后台命令改目录的 cwd 说明、前台长 sleep 拦截与 Bash 描述
// （04-bash.md「前台 sleep 拦截」「Prompt 约束」）、token 预算提醒默认关闭与静默提醒计时
// （loop/meta-user-context.md「Total-tokens reminder」「Silent-turn reminder」），以及错误结果跑的 Hook 事件
// （hooks.md「失败的定义」）。每个场景都在新 app 里冷恢复，检查已发出的消息逐字节回放。
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  setupBashWireTest,
  escapeRegExp,
  assertSubagentBashText,
  createFixture,
  bashCall,
  toolResult,
  expectColdReplay,
  expectNoTotalTokens,
  systemTexts,
  type WireBody,
  SLEEP_ADVICE,
} from "./bash-model-result-wire-fixture.js";

setupBashWireTest();

describe.skipIf(process.platform === "win32")("Bash model result wire and cold resume", () => {
  it(
    "sends a hard timeout as Exit code 143 and replays it after a cold resume",
    { timeout: 30_000 },
    async () => {
      const f = await createFixture();
      f.script.set(1, bashCall("toolu_timeout", { command: "sleep 3", timeout: 1000 }));
      await f.run("run the timeout command");

      const live = f.bodies[1]!;
      expect(toolResult(live, "toolu_timeout")).toEqual({
        is_error: true,
        text: "Exit code 143\nCommand timed out after 1s",
      });
      await f.run("after resume", { resume: true });
      expectColdReplay(live, f.bodies[2]!);
      expectNoTotalTokens(f.bodies);
    },
  );

  it(
    "notes that a background command does not move the session cwd",
    { timeout: 30_000 },
    async () => {
      const f = await createFixture();
      await mkdir(join(f.workspace, "nested"));
      f.script.set(
        1,
        bashCall("toolu_bg_cd", { command: "cd nested && sleep 0.2", run_in_background: true }),
      );
      f.script.set(
        2,
        bashCall("toolu_bg_plain", { command: "sleep 0.2", run_in_background: true }),
      );
      // 两个后台任务完成后开启通知轮；等到第二个任务的通知送达再关闭 app、冷恢复。
      await f.run("run the background commands", {
        until: (body) => JSON.stringify(body).includes("toolu_bg_plain</tool-use-id>"),
      });

      const live = f.bodies.at(-1)!;
      const cdResult = toolResult(live, "toolu_bg_cd");
      expect(cdResult.is_error).toBe(false);
      expect(cdResult.text).toMatch(
        new RegExp(
          `^Command running in background with ID: \\S+\\. Output is being written to: \\S+\\. You will be notified when it completes\\. To check interim output, use Read on that file path\\.\\nSession cwd remains ${escapeRegExp(f.workspace)}; directory changes made by the backgrounded command do not apply to subsequent commands\\.$`,
        ),
      );
      // 没有改目录的后台命令不带这句。
      expect(toolResult(live, "toolu_bg_plain").text).not.toContain("Session cwd remains");
      const liveCount = f.bodies.length;
      await f.run("after resume", { resume: true });
      expectColdReplay(live, f.bodies[liveCount]!);
      expectNoTotalTokens(f.bodies);
    },
  );

  // hooks.md「失败的定义」：错误结果只跑 PostToolUseFailure，error 是模型看到的正文；
  // grep 退出 1 表示没有匹配，仍跑 PostToolUse。
  it(
    "runs PostToolUseFailure for a failed command and PostToolUse for grep without matches",
    { timeout: 30_000 },
    async () => {
      const f = await createFixture({ recordHooks: true });
      await writeFile(join(f.workspace, "sample.txt"), "AUDIT_SAMPLE first line\n");
      const missing = join(f.workspace, "deliberately-nonexistent");
      f.script.set(1, bashCall("toolu_hook_fail", { command: `ls ${missing}` }));
      f.script.set(
        2,
        bashCall("toolu_hook_grep", { command: "grep AUDIT_NO_SUCH_TEXT sample.txt" }),
      );
      await f.run("run the audit commands");

      const live = f.bodies[2]!;
      const failed = toolResult(live, "toolu_hook_fail");
      expect(failed.is_error).toBe(true);
      // ls 的退出码与错误文字随系统不同（macOS 1，Linux 2）。
      expect(failed.text).toMatch(/^Exit code \d+\nls: .*deliberately-nonexistent/u);
      expect(toolResult(live, "toolu_hook_grep")).toEqual({
        is_error: false,
        text: "(Bash completed with no output)",
      });
      expect(systemTexts(live).filter((text) => text.includes("hook additional context"))).toEqual([
        "PostToolUseFailure:Bash hook additional context: AUDIT_PostToolUseFailure",
        "PostToolUse:Bash hook additional context: AUDIT_PostToolUse",
      ]);
      const inputs = await f.hookInputs();
      expect(inputs.map((input) => [input.hook_event_name, input.tool_use_id])).toEqual([
        ["PostToolUseFailure", "toolu_hook_fail"],
        ["PostToolUse", "toolu_hook_grep"],
      ]);
      expect(inputs[0]).toMatchObject({ error: failed.text, is_interrupt: false });
      expect(inputs[0]).not.toHaveProperty("tool_response");

      await f.run("after resume", { resume: true });
      expectColdReplay(live, f.bodies[3]!);
    },
  );

  it(
    "blocks a long foreground sleep before it runs and replays the block after a cold resume",
    { timeout: 30_000 },
    async () => {
      const f = await createFixture();
      f.script.set(
        1,
        bashCall("toolu_sleep_block", { command: "sleep 30 && echo AUDIT_RAN > ran.txt" }),
      );
      // 后台与 25 秒以下的前台 sleep 照常运行。
      f.script.set(2, bashCall("toolu_sleep_bg", { command: "sleep 30", run_in_background: true }));
      f.script.set(3, bashCall("toolu_sleep_short", { command: "sleep 0.2 && echo AUDIT_SHORT" }));
      await f.run("wait for the build");

      const live = f.bodies[3]!;
      expect(toolResult(live, "toolu_sleep_block")).toEqual({
        is_error: true,
        text: `<tool_use_error>Blocked: sleep 30 followed by: echo AUDIT_RAN. ${SLEEP_ADVICE}</tool_use_error>`,
      });
      await expect(access(join(f.workspace, "ran.txt"))).rejects.toThrow();
      const background = toolResult(live, "toolu_sleep_bg");
      expect(background.is_error).toBe(false);
      expect(background.text).toMatch(/^Command running in background with ID: /u);
      expect(toolResult(live, "toolu_sleep_short")).toEqual({
        is_error: false,
        text: "AUDIT_SHORT",
      });
      const description = f.bodies[0]!.tools?.find((tool) => tool.name === "Bash")?.description;
      expect(description).toContain(
        "\n- `cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories.",
      );
      expect(description).toContain(
        "No `&` needed. Foreground `sleep` of 25 seconds or more is blocked; to wait on a condition, run an until-loop with `run_in_background`.\n",
      );
      expect(description).toContain(
        "\n- Use the `gh` CLI for GitHub operations (PRs, issues, API).\n- GitHub notifies the owner of any `@name` written in a PR, issue, or comment.",
      );
      expect(description).not.toContain("Working directory persists between calls");

      await f.run("after resume", { resume: true });
      expectColdReplay(live, f.bodies[4]!);
    },
  );

  // 静默提醒按时间判定：每次模型响应耗时 responseMs（伪造 Date）。25 秒一次时第 3 次响应后满 60 秒，
  // 第 4 个请求带提醒；很快的连续静默响应不带。冷恢复按原位置原字节回放。
  it.each([
    [25_000, [false, false, false, true]],
    [10, [false, false, false, false, false, false, false]],
  ])(
    "times the silent reminder with responses of %sms and replays it after a cold resume",
    { timeout: 30_000 },
    async (responseMs, expected) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const f = await createFixture();
        f.responseMs = responseMs;
        for (let request = 1; request < expected.length; request++) {
          f.script.set(request, bashCall(`toolu_quiet_${request}`, { command: "true" }));
        }
        await f.run("inspect quietly");

        const marker = "The user hasn't heard from you in a while.";
        expect(
          f.bodies.map((body) => systemTexts(body).some((text) => text.includes(marker))),
        ).toEqual(expected);
        const live = f.bodies.at(-1)!;
        const liveCount = f.bodies.length;
        await f.run("after resume", { resume: true });
        expectColdReplay(live, f.bodies[liveCount]!);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "Bash background text in subagents over the wire",
  () => {
    it(
      "an Agent with run_in_background=true gets the matching child Bash text",
      { timeout: 30_000 },
      () => assertSubagentBashText(true, "You will be notified when it completes."),
    );

    it("blocks a long foreground sleep in a subagent", { timeout: 30_000 }, async () => {
      const f = await createFixture();
      const isChild = (body: WireBody) => !(body.tools ?? []).some((tool) => tool.name === "Agent");
      let parentCalls = 0;
      let childCalls = 0;
      f.respond = (body) => {
        if (isChild(body)) {
          childCalls += 1;
          return childCalls === 1
            ? bashCall("toolu_child_sleep", { command: "sleep 120" })
            : undefined;
        }
        parentCalls += 1;
        if (parentCalls !== 1) return undefined;
        return {
          content: [
            {
              type: "tool_use",
              id: "toolu_agent_sleep",
              name: "Agent",
              input: {
                description: "child task",
                prompt: "Wait for two minutes.",
                subagent_type: "general-purpose",
                run_in_background: false,
              },
            },
          ],
          stop: "tool_use",
        };
      };
      await f.run("launch the child");

      expect(toolResult(f.bodies.filter(isChild)[1]!, "toolu_child_sleep")).toEqual({
        is_error: true,
        text: `<tool_use_error>Blocked: standalone sleep 120. ${SLEEP_ADVICE}</tool_use_error>`,
      });
    });
  },
);
