/**
 * 每个 ask 的 WebSearch 预算（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Search budget」）的 driver 层用例。直接持 runtimeFactory 交出的端口调用 charge()——那正是
 * core 的 WebSearch handler 会做的事。装配与 workflow-escalation.test.ts 相同：turn 永不结束的
 * stub runtime + 内存 journal。
 */

import { describe, expect, it } from "vitest";
import type { WorkflowWebSearchBudgetPort } from "@zcode/contracts";
import {
  DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
  InMemoryJournalStore,
  type ActorRef,
  type InstanceRef,
  type PersonaSpec,
  type SessionRef,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { fakeFileSystemPort, unsupportedExecutionPort } from "./workflow-driver.helpers.js";

const NOOP_SINK: WorkflowReportSink = {
  askSubmitAttempted: () => {},
  askTurnEnded: () => {},
  askProgress: () => {},
  askStats: () => {},
  askFailed: () => {},
};

async function openAsk(persona: PersonaSpec = {}): Promise<{
  driver: WorkflowDriver;
  port: WorkflowWebSearchBudgetPort;
  session: SessionRef;
  instance: InstanceRef;
}> {
  const runId = "dwfrun-55556666-7777-8888";
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running" });
  const ports: WorkflowWebSearchBudgetPort[] = [];
  const driver = createAgentRuntimeWorkflowDriver({
    journal,
    emit: () => {},
    escalationRegistry: createWorkflowEscalationRegistry(),
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    cwd: process.cwd(),
    runId,
    runtimeFactory: ({ webSearchBudgetPort }) => {
      ports.push(webSearchBudgetPort);
      return { executeTurn: () => new Promise(() => {}) } as never;
    },
  })(NOOP_SINK);
  const actor: ActorRef = { siteId: "actor#1", ordinal: 1 };
  const session = await driver.createActorSession(actor, persona);
  const instance: InstanceRef = { siteId: "ask#1", ordinal: 1 };
  driver.startAsk(session, instance, { instructions: "go", typed: false });
  const port = ports[0];
  if (port === undefined) throw new Error("runtimeFactory 没有交出 webSearchBudgetPort");
  return { driver, port, session, instance };
}

function chargeTimes(port: WorkflowWebSearchBudgetPort, times: number): string[] {
  return Array.from({ length: times }, () => port.charge().kind);
}

describe("workflow WebSearch budget", () => {
  it("allows the default number of calls per ask, then refuses with the limit in the message", async () => {
    const { port } = await openAsk();
    expect(chargeTimes(port, DEFAULT_WEB_SEARCH_BUDGET_PER_ASK).every((k) => k === "charged")).toBe(
      true,
    );
    const over = port.charge();
    expect(over).toMatchObject({ kind: "exhausted", limit: DEFAULT_WEB_SEARCH_BUDGET_PER_ASK });
    expect(over.kind === "exhausted" && over.message).toContain(
      `at most ${DEFAULT_WEB_SEARCH_BUDGET_PER_ASK} WebSearch calls`,
    );
  });

  it("uses the persona's own budget; 0 refuses the first call", async () => {
    const wide = await openAsk({ budget: { webSearch: 3 } });
    expect(chargeTimes(wide.port, 4)).toEqual(["charged", "charged", "charged", "exhausted"]);
    const none = await openAsk({ budget: { webSearch: 0 } });
    expect(none.port.charge().kind).toBe("exhausted");
  });

  it("shares the count with a nudge turn and resets it at the next ask", async () => {
    const { driver, port, session, instance } = await openAsk({ budget: { webSearch: 2 } });
    expect(chargeTimes(port, 2)).toEqual(["charged", "charged"]);

    // nudge 仍在同一个 ask 里：起新 turn 但不归零。
    driver.respondToSubmit(instance, { kind: "nudge" });
    expect(port.charge().kind).toBe("exhausted");

    // 下一个 ask：预算是满的。
    driver.startAsk(session, { siteId: "ask#2", ordinal: 1 }, { instructions: "next", typed: false });
    expect(chargeTimes(port, 3)).toEqual(["charged", "charged", "exhausted"]);
  });
});
