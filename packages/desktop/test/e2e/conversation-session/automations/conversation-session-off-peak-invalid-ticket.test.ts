import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_AUTOMATIONS_OPEN,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

/**
 * 让真实闲时 scheduler 收到 3106：任务必须明确失败并停止自动补号，不能把这次请求
 * 换成普通 Chat provider。数据库断言同时验证原始 modelSelection 没被错误覆盖。
 */
describe("闲时任务无效票据 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-OFFPEAK-006: 3106 运行超时失败收口、不补号并保留原任务身份", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });

    const title = `E2E_OFFPEAK_INVALID_TICKET_${Date.now()}`;
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有 Automations" });
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, { timeoutMsg: "闲时任务入口没有出现" });
    await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, title);
    await setInputValueByTestIdDom(
      TID_OFFPEAK_FORM_INSTRUCTIONS,
      "E2E invalid-ticket request: keep the original task configuration.",
    );
    await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, { timeoutMsg: "闲时任务提交失败" });

    const row = await waitForTaskRow(title);
    expect(row.modelSelection).toMatchObject({
      providerId: expect.any(String),
      modelId: expect.any(String),
    });
    expect(row.serverTicketId).toBeTruthy();

    const gateway = await waitForInvalidTicketResponse();
    expect(gateway.invalidTicketRequests).toBeGreaterThan(0);
    expect(gateway.requests).toHaveLength(0);

    await browser.waitUntil(async () => (await readTaskRow(title))?.status === "failed", {
      timeout: 30000,
      interval: 200,
      timeoutMsg: "票据过期后仍在自动续跑或等待换票",
    });
    const failed = (await readTaskRow(title))!;
    expect(failed.modelSelection).toEqual(row.modelSelection);
    expect(failed.serverTicketId).toBe(row.serverTicketId);
    expect(failed.failureReason).toBe("off-peak-ticket-expired");
    expect(failed.schedulable).toBe(0);
    const stoppedGateway = await waitForInvalidTicketResponse();
    expect(stoppedGateway.issuedTicketCount).toBe(1);
    expect(stoppedGateway.requests).toHaveLength(0);
  });
});

interface TaskRow {
  serverTicketId: string;
  failureReason: string | null;
  schedulable: number;
  modelSelection: { modelId?: string; providerId?: string } | null;
  status: string;
}

async function waitForTaskRow(title: string): Promise<TaskRow> {
  let row: TaskRow | null = null;
  await browser.waitUntil(
    async () => {
      row = await readTaskRow(title);
      return row !== null;
    },
    { timeout: 30000, interval: 500, timeoutMsg: "无效票据任务没有写入本地任务索引" },
  );
  if (!row) throw new Error("无效票据任务索引行为空");
  return row;
}

async function readTaskRow(title: string): Promise<TaskRow | null> {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        "SELECT status, model_selection, server_ticket_id, failure_reason, schedulable FROM off_peak_tasks WHERE title = ?",
      )
      .get(title) as
      | {
          model_selection: string | null;
          status: string;
          server_ticket_id: string;
          failure_reason: string | null;
          schedulable: number;
        }
      | undefined;
    if (!row) return null;
    return {
      modelSelection: row.model_selection ? JSON.parse(row.model_selection) : null,
      status: row.status,
      serverTicketId: row.server_ticket_id,
      failureReason: row.failure_reason,
      schedulable: row.schedulable,
    };
  } finally {
    database.close();
  }
}

async function waitForInvalidTicketResponse(): Promise<{
  invalidTicketRequests: number;
  issuedTicketCount: number;
  requests: unknown[];
}> {
  const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT ?? "45197");
  let latest = { invalidTicketRequests: 0, issuedTicketCount: 0, requests: [] as unknown[] };
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__e2e/off-peak/requests`);
        if (!response.ok) return false;
        latest = (await response.json()) as typeof latest;
        return latest.invalidTicketRequests > 0;
      } catch {
        return false;
      }
    },
    { timeout: 90000, interval: 500, timeoutMsg: "闲时 mock 没有返回 3106 运行超时" },
  );
  return latest;
}
