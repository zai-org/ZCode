// E2E 扩展 fixture（docs/plugins/extension-host.md §17.3、§17.8，P3c）：纯 JS，不需要构建。
// composer.status 的命令每次点击读一次插件目录旁的 e2e-ext-writes-step.json（用例写入），按顺序执行里面的
// ctx.sessions.* 操作，每个操作的结果或错误码写一行 E2E_WRITES_RESULT（结果只有身份与状态，不含提示词）。
// 操作带 subscribeRows 时，结果里一有会话就立即订阅它的行，复现「新建后立即订阅」的时序，记第一个事件或错误码。
// 操作带 watchRows 时（或操作名是 watchRows），持续订阅这个会话的行，每个事件写一行 E2E_WRITES_WATCH：
// 本轮状态（turnHeader 的 state）、助手文字的总字数、事件数；订阅以错误结束时写 ended=<错误码>。unwatchRows 退订。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 订阅行，等第一个事件或错误，然后退订。 */
function probeRows(ctx, sessionId, label) {
  return new Promise((resolve) => {
    let subscription = null;
    let done = false;
    const finish = (line) => {
      if (done) return;
      done = true;
      ctx.log.info(`E2E_WRITES_ROWS ${label} session=${sessionId} ${line}`);
      subscription?.dispose();
      resolve();
    };
    subscription = ctx.sessions.onDidChangeRows(
      { sessionId },
      (event) =>
        finish(`kind=${event.kind} rows=${event.kind === "reset" ? event.rows.length : 0}`),
      (error) => finish(`error=${error.code}`),
    );
    if (done) subscription.dispose();
  });
}

const watches = new Map();

/** 持续订阅行：宿主的行镜像每推一次，记一行摘要（不含正文）。 */
function watchRows(ctx, sessionId) {
  watches.get(sessionId)?.dispose();
  const rows = new Map();
  let events = 0;
  const subscription = ctx.sessions.onDidChangeRows(
    { sessionId },
    (event) => {
      if (event.kind === "reset") {
        rows.clear();
        for (const row of event.rows) rows.set(row.rowId, row);
      } else if (event.kind === "rows") {
        for (const row of event.upserted) rows.set(row.rowId, row);
      }
      events += 1;
      const all = [...rows.values()];
      const turns = all.filter((row) => row.kind === "turnHeader").map((row) => row.state);
      const replyChars = all
        .filter((row) => row.kind === "assistantText")
        .reduce((sum, row) => sum + (typeof row.text === "string" ? row.text.length : 0), 0);
      ctx.log.info(
        `E2E_WRITES_WATCH session=${sessionId} kind=${event.kind} turns=${turns.join(",")} replyChars=${replyChars} events=${events}`,
      );
    },
    (error) => {
      watches.delete(sessionId);
      ctx.log.info(`E2E_WRITES_WATCH session=${sessionId} ended=${error?.code ?? "unknown"}`);
    },
  );
  watches.set(sessionId, subscription);
  return { watching: sessionId };
}

async function runOp(ctx, op) {
  if (op.name === "watchRows") return watchRows(ctx, op.input.sessionId);
  if (op.name === "unwatchRows") {
    watches.get(op.input.sessionId)?.dispose();
    watches.delete(op.input.sessionId);
    return { unwatched: op.input.sessionId };
  }
  return ctx.sessions[op.name](op.input);
}

export async function activate(ctx) {
  const root = join(ctx.extension.path, "..");
  ctx.commands.register("run-step", async () => {
    const step = JSON.parse(await readFile(join(root, "e2e-ext-writes-step.json"), "utf8"));
    for (const [index, op] of step.ops.entries()) {
      const label = `seq=${step.seq} index=${index} op=${op.name}`;
      try {
        const result = await runOp(ctx, op);
        ctx.log.info(`E2E_WRITES_RESULT ${label} ok=${JSON.stringify(result ?? null)}`);
        const sessionId = result?.session?.sessionId;
        if (op.subscribeRows && sessionId) await probeRows(ctx, sessionId, label);
        if (op.watchRows && sessionId) watchRows(ctx, sessionId);
      } catch (error) {
        // 扩展错误的 message 是固定文案（session-control 的错误文本不含路径与正文）。
        ctx.log.info(
          `E2E_WRITES_RESULT ${label} error=${error?.code ?? "unknown"} message=${JSON.stringify(error?.message ?? "")}`,
        );
      }
    }
    ctx.log.info(`E2E_WRITES_DONE seq=${step.seq}`);
  });
  ctx.slots.update("run", { text: "E2E writes", tooltip: "E2E_WRITES" });
  ctx.log.info(`E2E_WRITES_ACTIVATED plugin=${ctx.extension.id}`);
}

export function deactivate() {}
