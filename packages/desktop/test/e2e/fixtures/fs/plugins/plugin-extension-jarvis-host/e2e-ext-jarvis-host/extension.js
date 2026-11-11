// E2E 扩展 fixture（docs/plugins/extension-host.md §18.1）：Jarvis 要的宿主能力，纯 JS，不需要构建。
// - 视图 home：scope "app"（H5），从 nav.primary 打开；页面调工具 describe 读实例 id 与作用域。
// - 激活时报告 ctx.extension.dataPath 与目录是否存在（H6），以及 models.list 的结果（H9）。
// - 导航条目的未读标记（H11）：激活时设为 3；视图工具 setBadge 改成数字、"dot" 或 null（清除）。
// - 视图工具 requestGrants 调 grants.request（H12），把返回的生效档位记进日志。
// - 视图工具 notify 调 notifications.show（H8），把结果记进日志（不记标题与正文以外的东西）。
// - 每次激活在 dataPath 里的计数文件加一，日志记上一次的值（App 重启后数据还在，H6）；
//   插件目录旁写当前扩展进程的 pid，用例据此杀进程。
// 运行时证据写进日志（E2E_JARVISHOST_*）。
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function activate(ctx) {
  const dataPath = ctx.extension.dataPath;
  const isDirectory = await stat(dataPath).then(
    (info) => info.isDirectory(),
    () => false,
  );
  ctx.log.info(`E2E_JARVISHOST_DATAPATH ${JSON.stringify({ dataPath, isDirectory })}`);
  const counterPath = join(dataPath, "e2e-activations.json");
  const previous = await readFile(counterPath, "utf8").then(
    (text) => Number(JSON.parse(text).count) || 0,
    () => 0,
  );
  await writeFile(counterPath, JSON.stringify({ count: previous + 1 }));
  ctx.log.info(`E2E_JARVISHOST_DATA previous=${previous} count=${previous + 1}`);
  await writeFile(
    join(ctx.extension.path, "..", "e2e-ext-jarvis-host-state.json"),
    JSON.stringify({ pid: process.pid }),
  );
  ctx.views.register("home", {
    entry: "./view.html",
    onDidOpen(view) {
      ctx.log.info(
        `E2E_JARVISHOST_VIEW_OPEN instance=${view.id} scope=${view.scope.kind} session=${view.sessionId ?? "none"}`,
      );
      view.onDidClose(() => ctx.log.info(`E2E_JARVISHOST_VIEW_CLOSE instance=${view.id}`));
    },
    tools: {
      notify: {
        description: "Show a system notification",
        inputSchema: { type: "object", properties: { view: { type: "string" } } },
        run: async (input) => {
          try {
            const result = await ctx.notifications.show({
              title: "E2E title",
              body: "E2E body",
              ...(input?.view ? { target: { view: input.view } } : {}),
            });
            ctx.log.info(`E2E_JARVISHOST_NOTIFY ok ${JSON.stringify(result)}`);
            return result;
          } catch (error) {
            ctx.log.info(`E2E_JARVISHOST_NOTIFY error code=${error?.code ?? "unknown"}`);
            return { error: error?.code ?? "unknown" };
          }
        },
      },
      requestGrants: {
        description: "Ask the host to show the consent dialog",
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          try {
            const result = await ctx.grants.request();
            ctx.log.info(`E2E_JARVISHOST_GRANTS ok granted=${result.granted.join(",")}`);
            return result;
          } catch (error) {
            ctx.log.info(`E2E_JARVISHOST_GRANTS error code=${error?.code ?? "unknown"}`);
            return { error: error?.code ?? "unknown" };
          }
        },
      },
      setBadge: {
        description: "Set the nav badge",
        inputSchema: { type: "object", properties: { badge: {} } },
        run: (input) => {
          ctx.slots.update("home", { badge: input?.badge ?? null });
          return { badge: input?.badge ?? null };
        },
      },
      describe: {
        description: "Describe this view instance",
        inputSchema: { type: "object", properties: {} },
        run: (_input, call) => ({
          instance: call.view.id,
          scope: call.view.scope.kind,
          sessionId: call.view.sessionId ?? null,
        }),
      },
    },
  });
  ctx.slots.update("home", { badge: 3 });
  // 不阻塞激活：模型选择服务就绪前 getView 会等待。
  ctx.models.list().then(
    (models) => ctx.log.info(`E2E_JARVISHOST_MODELS ok ${JSON.stringify(models)}`),
    (error) => ctx.log.info(`E2E_JARVISHOST_MODELS error code=${error?.code ?? "unknown"}`),
  );
}

export function deactivate() {}
