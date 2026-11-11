// E2E 扩展 fixture（docs/plugins/extension-host.md §17.12，P3e）：纯 JS，不需要构建。
// composer.status 的命令每次点击读一次插件目录旁的 e2e-ext-approvals-step.json（用例写入），按顺序执行里面的操作：
// - watch / unwatch：订阅或退订 ctx.sessions.onDidChangeInteractions，每个事件写一行 E2E_APPROVALS_EVENT
//   （会话、模式、交互的 id 与种类、审批选项的 kind:optionId），订阅以错误结束时写 E2E_APPROVALS_WATCH_ERROR。
// - watchRows / unwatchRows：订阅或退订这个会话的行，每个事件写一行 E2E_APPROVALS_ROWS（工具行的
//   工具名:状态，不含参数与输出）。
// - 其余是 ctx.sessions.* 的单个操作；结果或错误码写一行 E2E_APPROVALS_RESULT。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const watches = new Map();
const rowWatches = new Map();

/** 行镜像里工具行的状态（toolCall 行的 status）：插件靠它画「等你确认」与执行结果。 */
function watchRows(ctx, sessionId) {
  rowWatches.get(sessionId)?.dispose();
  const rows = new Map();
  const subscription = ctx.sessions.onDidChangeRows(
    { sessionId },
    (event) => {
      if (event.kind === "reset") {
        rows.clear();
        for (const row of event.rows) rows.set(row.rowId, row);
      } else if (event.kind === "rows") {
        for (const row of event.upserted) rows.set(row.rowId, row);
      }
      const tools = [...rows.values()]
        .filter((row) => row.kind === "toolCall")
        .map((row) => `${row.toolName}:${row.status}`);
      ctx.log.info(
        `E2E_APPROVALS_ROWS session=${sessionId} kind=${event.kind} tools=${tools.join(",")}`,
      );
    },
    (error) => {
      rowWatches.delete(sessionId);
      ctx.log.info(`E2E_APPROVALS_ROWS session=${sessionId} ended=${error?.code ?? "unknown"}`);
    },
  );
  rowWatches.set(sessionId, subscription);
  return { watchingRows: sessionId };
}

function describeInteraction(interaction) {
  const options =
    interaction.payload.kind === "permission"
      ? [
          ...interaction.payload.options.map((option) => `${option.kind}:${option.optionId}`),
          ...(interaction.payload.fullAccessOption
            ? [`fullAccess:${interaction.payload.fullAccessOption.optionId}`]
            : []),
        ]
      : // 提问带每个问题的选项（宿主投影里的 label），E2E 断言插件看到的选项与模型给的一致。
        (interaction.payload.questions ?? []).flatMap((question) => [
          `question:${question.question}`,
          ...question.options.map((option) => `choice:${option.label}`),
        ]);
  return { id: interaction.interactionId, kind: interaction.kind, options };
}

function watch(ctx, sessionId) {
  watches.get(sessionId)?.dispose();
  const subscription = ctx.sessions.onDidChangeInteractions(
    { sessionId },
    (event) => {
      ctx.log.info(
        `E2E_APPROVALS_EVENT session=${event.sessionId} mode=${event.mode} interactions=${JSON.stringify(
          event.interactions.map(describeInteraction),
        )}`,
      );
    },
    (error) => {
      watches.delete(sessionId);
      ctx.log.info(
        `E2E_APPROVALS_WATCH_ERROR session=${sessionId} error=${error?.code ?? "unknown"}`,
      );
    },
  );
  watches.set(sessionId, subscription);
  return { watching: sessionId };
}

async function runOp(ctx, op) {
  if (op.name === "watch") return watch(ctx, op.input.sessionId);
  if (op.name === "watchRows") return watchRows(ctx, op.input.sessionId);
  if (op.name === "unwatchRows") {
    rowWatches.get(op.input.sessionId)?.dispose();
    rowWatches.delete(op.input.sessionId);
    return { unwatchedRows: op.input.sessionId };
  }
  if (op.name === "unwatch") {
    watches.get(op.input.sessionId)?.dispose();
    watches.delete(op.input.sessionId);
    return { unwatched: op.input.sessionId };
  }
  return ctx.sessions[op.name](op.input);
}

export async function activate(ctx) {
  const root = join(ctx.extension.path, "..");
  ctx.commands.register("run-step", async () => {
    const step = JSON.parse(await readFile(join(root, "e2e-ext-approvals-step.json"), "utf8"));
    for (const [index, op] of step.ops.entries()) {
      const label = `seq=${step.seq} index=${index} op=${op.name}`;
      try {
        const result = await runOp(ctx, op);
        ctx.log.info(`E2E_APPROVALS_RESULT ${label} ok=${JSON.stringify(result ?? null)}`);
      } catch (error) {
        ctx.log.info(`E2E_APPROVALS_RESULT ${label} error=${error?.code ?? "unknown"}`);
      }
    }
    ctx.log.info(`E2E_APPROVALS_DONE seq=${step.seq}`);
  });
  ctx.slots.update("run", { text: "E2E approvals", tooltip: "E2E_APPROVALS" });
  ctx.log.info(
    `E2E_APPROVALS_ACTIVATED plugin=${ctx.extension.id} dataPath=${JSON.stringify(ctx.extension.dataPath)}`,
  );
}

export function deactivate() {
  for (const subscription of watches.values()) subscription.dispose();
  watches.clear();
}
