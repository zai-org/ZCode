// GetWorkflowRun 的摘要拼装与「多久以前」这把尺（docs/dynamic-workflow/launch.md「`GetWorkflowRun`」）。
//
// 这两件东西被单独钉住，是因为模型面上每一句话都建立在它们之上：摘要是确定性的（同一份
// 快照永远同一句话），年龄是对 `generatedAt` 算的（一次输出一把尺）。任何一处飘了，
// 整段情势报告就开始说一些它并不知道的事。

import { describe, expect, it } from "vitest";
import type { GetWorkflowRunOutput } from "@zcode/contracts";
import { buildWorkflowRunSummary } from "../src/tool/handlers/get-workflow-run-summary.js";
import {
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
  formatWorkflowRunInstant,
} from "../src/tool/handlers/workflow-run-introspection.js";

const NOW = Date.UTC(2026, 7, 21, 9, 5, 40);

/** 一个最小但完整的输出：五个必填字段齐备，其余由各用例按需覆盖。 */
const BASE: Omit<GetWorkflowRunOutput, "summary"> = {
  runId: "dwfrun-1",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  generatedAt: NOW,
  usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
  actors: [],
  logTail: [],
  subagents: [],
  health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
};

function summaryOf(patch: Partial<Omit<GetWorkflowRunOutput, "summary">>): string {
  return buildWorkflowRunSummary({ ...BASE, ...patch });
}

describe("workflow run duration and age", () => {
  // 四级阶梯：秒、分秒、时分、日时。分与秒补零（`1m 5s` 与 `1m 50s` 一眼难分）。
  it("writes two units at most, padding the 60-base ones", () => {
    expect(formatWorkflowRunDuration(40_000)).toBe("40s");
    expect(formatWorkflowRunDuration(310_000)).toBe("5m 10s");
    expect(formatWorkflowRunDuration(65_000)).toBe("1m 05s");
    expect(formatWorkflowRunDuration(8_100_000)).toBe("2h 15m");
    expect(formatWorkflowRunDuration(266_400_000)).toBe("3d 2h");
  });

  // 时钟回拨或坏值不该让一条时间戳把整个工具结果变成 NaN。
  it("folds a negative or non-finite span to zero", () => {
    expect(formatWorkflowRunDuration(-5_000)).toBe("0s");
    expect(formatWorkflowRunDuration(Number.NaN)).toBe("0s");
  });

  // 缺席读作「不知道」：老 journal 没有时间列，那样的行就没有年龄，而不是「0s ago」。
  it("returns nothing when the instant is unknown", () => {
    expect(formatRelativeAge(NOW, undefined)).toBeUndefined();
    expect(formatRelativeAge(NOW, Number.NaN)).toBeUndefined();
    expect(formatRelativeAge(NOW, NOW - 40_000)).toBe("40s ago");
  });

  it("writes an instant as ISO plus its age", () => {
    expect(formatWorkflowRunInstant(NOW, NOW - 40_000)).toBe("2026-08-21T09:05:00.000Z (40s ago)");
  });

  // 千分位自己插逗号：`toLocaleString` 的结果取决于宿主 ICU，而模型面要能逐字钉住。
  it("groups thousands without leaning on the host locale", () => {
    expect(formatWorkflowRunCount(6_210)).toBe("6,210");
    expect(formatWorkflowRunCount(41_200)).toBe("41,200");
    expect(formatWorkflowRunCount(999)).toBe("999");
    expect(formatWorkflowRunCount(1_000_000)).toBe("1,000,000");
  });
});

describe("workflow run summary — the live shapes", () => {
  it("says how long it has been running and how far the steps got", () => {
    expect(
      summaryOf({
        // 计数与花名册对齐：活相位的子代理各占一条还在跑的 ask 行，observed 是三态之和。
        usage: {
          spentTokens: 10,
          nodesObserved: 7,
          nodesRunning: 2,
          nodesCompleted: 5,
          nodesFailed: 0,
        },
        subagents: [
          {
            siteId: "a",
            ordinal: 1,
            state: "executing",
            stepsSettled: 0,
            stepsFailed: 0,
            tokens: 0,
          },
          { siteId: "b", ordinal: 1, state: "waiting", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        ],
      }),
    ).toBe(
      "Running for 5m 40s. 5 of 7 dispatched steps settled, 2 running (1 executing, 1 waiting).",
    );
  });

  // 花名册读不出来时（只有计数、没有 actor 行）宁可不给括号，也不拿计数去编一个细分。
  it("omits the breakdown instead of inventing one when the roster is empty", () => {
    const summary = summaryOf({
      usage: {
        spentTokens: 10,
        nodesObserved: 7,
        nodesRunning: 2,
        nodesCompleted: 5,
        nodesFailed: 0,
      },
    });
    expect(summary).toContain("2 running.");
    expect(summary).not.toContain("(");
  });

  // 在飞那几步分别在干什么，从花名册的相位数出来——「2 running」本身不回答「卡住了没」。
  it("breaks the running steps down by what the roster says they are doing", () => {
    const summary = summaryOf({
      usage: {
        spentTokens: 10,
        nodesObserved: 7,
        nodesRunning: 3,
        nodesCompleted: 4,
        nodesFailed: 0,
      },
      subagents: [
        { siteId: "a", ordinal: 1, state: "executing", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        { siteId: "b", ordinal: 1, state: "waiting", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
        { siteId: "c", ordinal: 1, state: "parked", stepsSettled: 0, stepsFailed: 0, tokens: 0 },
      ],
    });
    expect(summary).toContain("3 running (1 executing, 1 waiting, 1 parked)");
  });

  it("points at the current phase while one is current", () => {
    expect(
      summaryOf({
        phases: [
          { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0 },
          { name: "judge", state: "current", rounds: 1, nodesSettled: 0, nodesRunning: 1 },
          { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
        ],
      }),
    ).toContain("in phase 2 of 3 (judge)");
  });

  // 脚本没有阶段就不提阶段：一句「across 0 phases」是在回答一个没人问的问题。
  it("says nothing about phases when the run has none", () => {
    expect(summaryOf({})).not.toContain("phase");
  });

  it("counts the questions that are waiting, and stays silent when none are", () => {
    expect(
      summaryOf({
        pendingQuestions: [
          { qid: "q1", actor: "a@1", question: "?", askedAt: NOW },
          { qid: "q2", actor: "b@1", question: "?", askedAt: NOW },
        ],
      }),
    ).toContain("2 questions awaiting your answer.");
    expect(summaryOf({})).not.toContain("awaiting your answer");
  });

  // 「没有人在等」与「查不到」是两个不同的事实，而沉默会把后者读成前者。
  it("says outright that pending questions are unknown when they are", () => {
    expect(summaryOf({ health: { ...BASE.health, pendingQuestionsKnown: false } })).toContain(
      "Pending questions are unknown from this session.",
    );
  });

  it("reports the last progress and names a stall", () => {
    expect(summaryOf({ health: { ...BASE.health, lastProgressAt: NOW - 40_000 } })).toContain(
      "Last progress 40s ago.",
    );
    expect(
      summaryOf({
        health: { ...BASE.health, lastProgressAt: NOW - 40_000, stalledSince: NOW - 30_000 },
      }),
    ).toContain("Stalled, last progress 40s ago.");
  });

  it("marks a run this session does not own", () => {
    expect(summaryOf({ ownedByThisSession: false })).toContain("Owned by another session.");
    expect(summaryOf({})).not.toContain("Owned by another session.");
  });
});

describe("workflow run summary — the terminal shapes", () => {
  it("totals the settled steps and tokens for a completed run", () => {
    expect(
      summaryOf({
        status: "completed",
        usage: {
          spentTokens: 41_200,
          nodesObserved: 12,
          nodesRunning: 0,
          nodesCompleted: 12,
          nodesFailed: 0,
        },
      }),
    ).toBe("Completed in 5m 00s. 12 steps settled, 41,200 tokens.");
  });

  it("names the failure code so the model can tell a dead process from a bad script", () => {
    expect(
      summaryOf({ status: "errored", error: { code: "DriverError", message: "the script threw" } }),
    ).toContain("Failure: DriverError.");
    // 普通的 user 取消没有失败可报。
    expect(summaryOf({ status: "stopped", stopReason: "user" })).not.toContain("Failure:");
  });

  // 终态 run 里标着 running 的那些行是进程死在它们下面的残留，恢复会重派它们。
  it("explains the leftovers of an exited process instead of counting them as running", () => {
    expect(
      summaryOf({
        status: "stopped",
        stopReason: "interrupted",
        usage: {
          spentTokens: 10,
          nodesObserved: 7,
          nodesRunning: 2,
          nodesCompleted: 5,
          nodesFailed: 0,
        },
        health: { ...BASE.health, leftoverRunning: 2 },
      }),
    ).toContain(
      "2 were still running when the owning process exited and will be re-dispatched on resume",
    );
  });

  // 只有 interrupted 才是进程死了；修订替代的 run 恢复会被拒，不能说「恢复时重派」。
  it("says who owns the leftovers of a superseded run", () => {
    const text = summaryOf({
      status: "stopped",
      stopReason: "superseded",
      usage: {
        spentTokens: 10,
        nodesObserved: 3,
        nodesRunning: 1,
        nodesCompleted: 2,
        nodesFailed: 0,
      },
      health: { ...BASE.health, leftoverRunning: 1 },
    });
    expect(text).toContain("1 was still running when the run was superseded; the new run owns it");
    expect(text).not.toContain("owning process exited");
    expect(text).not.toContain("re-dispatched");
  });

  it("does not blame a dead process for the leftovers of a run the user stopped", () => {
    const text = summaryOf({
      status: "stopped",
      stopReason: "user",
      usage: {
        spentTokens: 10,
        nodesObserved: 3,
        nodesRunning: 1,
        nodesCompleted: 2,
        nodesFailed: 0,
      },
      health: { ...BASE.health, leftoverRunning: 1 },
    });
    expect(text).toContain(
      "1 was still running when the run stopped and will be re-dispatched on resume",
    );
  });

  it("does not count phases the run never entered", () => {
    expect(
      summaryOf({
        status: "stopped",
        stopReason: "user",
        phases: [
          { name: "a", state: "done", rounds: 1, nodesSettled: 1, nodesRunning: 0 },
          { name: "b", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
        ],
      }),
    ).toContain(", across 1 phase.");
  });

  it("counts the phases instead of pointing at one once they are all behind it", () => {
    expect(
      summaryOf({
        status: "completed",
        phases: [
          { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0 },
          { name: "judge", state: "done", rounds: 1, nodesSettled: 6, nodesRunning: 0 },
        ],
      }),
    ).toContain("across 2 phases");
  });

  it("points the reader at the deliverable of a completed run", () => {
    expect(
      summaryOf({
        status: "completed",
        artifacts: [
          { id: "notes", kind: "markdown", version: 1, itemCount: 0 },
          {
            id: "report",
            kind: "markdown",
            title: "Nightly triage report",
            version: 1,
            itemCount: 0,
            primary: true,
          },
        ],
      }),
    ).toContain("Deliverable: Nightly triage report (markdown, primary).");
    // 没有 primary 的 run 不去挑一件充数。
    expect(
      summaryOf({
        status: "completed",
        artifacts: [{ id: "notes", kind: "markdown", version: 1, itemCount: 0 }],
      }),
    ).not.toContain("Deliverable");
  });
});

describe("workflow run summary — the budget", () => {
  // 上界是整句整句地丢尾巴，而不是从中间切断一句话；头两句（处境 + 步数）任何预算下都在。
  it("drops whole trailing sentences to stay inside 400 characters", () => {
    const longTitle = "R".repeat(360);
    const summary = summaryOf({
      status: "completed",
      ownedByThisSession: false,
      usage: {
        spentTokens: 41_200,
        nodesObserved: 12,
        nodesRunning: 0,
        nodesCompleted: 12,
        nodesFailed: 0,
      },
      artifacts: [
        {
          id: "report",
          kind: "markdown",
          title: longTitle,
          version: 1,
          itemCount: 0,
          primary: true,
        },
      ],
    });
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toContain("Completed in 5m 00s.");
    expect(summary).toContain("12 steps settled");
    expect(summary).not.toContain(longTitle);
  });
});
