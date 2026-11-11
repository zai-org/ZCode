// E2E 扩展 fixture（docs/plugins/extension-host.md §17.3）：清单没有声明 grants，调用会话能力应报 not-declared。
const PLUGIN = "e2e-ext-sessions-nogrant@inline";

export function activate(ctx) {
  ctx.sessions.listSessions({}).then(
    () => ctx.log.info(`E2E_SESSIONS_NOGRANT plugin=${PLUGIN} ok`),
    (error) =>
      ctx.log.info(`E2E_SESSIONS_NOGRANT plugin=${PLUGIN} error=${error?.code ?? "unknown"}`),
  );
}

export function deactivate() {}
