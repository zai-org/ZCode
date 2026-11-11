// E2E 扩展 fixture（docs/plugins/extension-host.md §8–§11）：纯 JS，不需要构建。
// - 视图 context 用写法一（宿主帮手）：页面经 window.zcode 调 snapshot 工具读 context 组成，
//   订阅 state 资源；context / workbench 变化时 view.notify 让页面刷新。
// - composer.status 显示生成速率；点击执行命令，经 ctx.views.open 打开视图。
// - 订阅 App 环境（ctx.env），语言变化写进日志。
// 运行时证据写进日志（E2E_VIEW_*），由 E2E 从 Main 日志取证。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function activate(ctx) {
  const stateUri = `ui://${ctx.extension.id}/state`;
  const views = new Set();
  let revision = 0;
  const notify = (sessionId) => {
    revision += 1;
    for (const view of views) {
      if (!sessionId || view.sessionId === sessionId) view.notify(stateUri);
    }
  };
  // 写法一的打开回调（§16.11）：实例打开时登记，关闭时移除。
  const track = (view) => {
    views.add(view);
    ctx.log.info(`E2E_VIEW_DID_OPEN instance=${view.id} scope=${view.scope.kind}`);
    view.onDidClose(() => {
      views.delete(view);
      ctx.log.info(`E2E_VIEW_CLOSED instance=${view.id}`);
    });
  };

  ctx.context.onDidChange((event) => {
    ctx.log.info(
      `E2E_VIEW_CONTEXT_CHANGED sessionId=${event.sessionId} revision=${event.revision}`,
    );
    notify(event.sessionId);
  });
  ctx.workbench.onDidChange((event) => {
    ctx.log.info(
      `E2E_VIEW_WORKBENCH ${JSON.stringify(event.sessions.map(({ sessionId, isDraft, focused }) => ({ sessionId, isDraft, focused })))}`,
    );
    notify();
  });
  ctx.models.onDidGenerate((metrics) => {
    ctx.slots.update(
      "tps",
      {
        text: `${metrics.outputTokensPerSecond.toFixed(2)} tok/s`,
        // 准确值带模型、输出 token 与首 token 时间（宿主 models.onDidGenerate 的 final 事件，§10）。
        tooltip: `E2E_TPS ${metrics.phase} ${metrics.model.modelId} out=${metrics.outputTokens ?? ""} ttft=${metrics.timeToFirstTokenMs ?? ""}`,
      },
      { sessionId: metrics.sessionId },
    );
    ctx.log.info(
      `E2E_VIEW_TPS phase=${metrics.phase} tps=${metrics.outputTokensPerSecond} requestId=${metrics.requestId} outputTokens=${metrics.outputTokens ?? ""} ttft=${metrics.timeToFirstTokenMs ?? ""}`,
    );
  });
  ctx.slots.update("tps", { text: "E2E tps", tooltip: "E2E_TPS idle" });
  // 插槽 silent 只在清单里声明、从不设置文字：宿主不显示它（§6「只在设置了 text 时显示」）。
  // App 环境（§16.11）：订阅后的第一个事件是当前语言，之后语言变化时推送。
  ctx.env.onDidChange((env) => ctx.log.info(`E2E_VIEW_ENV_CHANGED locale=${env.locale}`));
  ctx.env.get().then(
    (env) => ctx.log.info(`E2E_VIEW_ENV_GET locale=${env.locale}`),
    (error) => ctx.log.info(`E2E_VIEW_ENV_GET error=${error?.code}`),
  );

  ctx.commands.register("open-context", async (call) => {
    const scope = call.scope.kind === "session" ? { sessionId: call.scope.sessionId } : undefined;
    await ctx.views.open("context", scope);
    ctx.log.info(`E2E_VIEW_OPENED_BY_COMMAND scope=${call.scope.kind}`);
  });

  ctx.views.register("context", {
    entry: "./view.html",
    onDidOpen: track,
    tools: {
      snapshot: {
        description: "Read the context composition of the view's session",
        inputSchema: { type: "object", properties: {} },
        run: async (_input, call) => {
          const composition = call.view.sessionId
            ? await ctx.context.get({ sessionId: call.view.sessionId })
            : null;
          const sessions = await ctx.workbench.visibleSessions();
          return {
            composition,
            sessions,
            scope: call.view.scope,
            revision,
            instance: call.view.id,
          };
        },
      },
      rendered: {
        description: "The page reports what it rendered",
        inputSchema: { type: "object" },
        run: (input, call) => {
          ctx.log.info(`E2E_VIEW_RENDERED ${JSON.stringify({ instance: call.view.id, ...input })}`);
          return { ok: true };
        },
      },
    },
    resources: {
      [stateUri]: { mimeType: "application/json", read: async () => JSON.stringify({ revision }) },
    },
  });

  // 能力 views.open 的本地校验：未声明的视图在扩展进程内抛 not-declared。
  try {
    await ctx.views.open("undeclared");
  } catch (error) {
    ctx.log.info(`E2E_VIEW_OPEN_NOT_DECLARED ${error?.code}`);
  }

  await writeFile(
    join(ctx.extension.path, "..", "e2e-ext-view-state.json"),
    JSON.stringify({ pid: process.pid, activatedAt: Date.now() }),
  );
}

export function deactivate() {}
