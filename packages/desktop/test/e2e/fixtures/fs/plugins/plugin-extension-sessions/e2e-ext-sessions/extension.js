// E2E 扩展 fixture（docs/plugins/extension-host.md §17.3、§17.7）：纯 JS，不需要构建。
// 激活时与每次换语言（env.onDidChange）时探测一次会话读能力：
// - ctx.sessions.listSessions({})：成功记 E2E_SESSIONS_LIST ... ok count=N ids=…，失败记 error=<code>。
// - 列表里每个会话 ctx.sessions.readSession({ sessionId, view: "messages" })：记 E2E_SESSIONS_READ，
//   只记消息数、角色与是否含测试标记 E2E_EXT_SESSIONS，不记正文。
const PLUGIN = "e2e-ext-sessions@inline";
const MARKER = "E2E_EXT_SESSIONS";

async function probe(ctx, reason) {
  let list;
  try {
    list = await ctx.sessions.listSessions({});
  } catch (error) {
    ctx.log.info(
      `E2E_SESSIONS_LIST plugin=${PLUGIN} reason=${reason} error=${error?.code ?? "unknown"}`,
    );
    return;
  }
  const ids = list.sessions.map((item) => item.session.sessionId);
  ctx.log.info(
    `E2E_SESSIONS_LIST plugin=${PLUGIN} reason=${reason} ok count=${ids.length} ids=${ids.join(",")}`,
  );
  for (const sessionId of ids) {
    try {
      const read = await ctx.sessions.readSession({ sessionId, view: "messages" });
      const messages = read.view === "messages" ? read.messages : [];
      const roles = [...new Set(messages.map((message) => message.role))].sort().join(",");
      const marker = messages.some((message) => message.text.includes(MARKER));
      ctx.log.info(
        `E2E_SESSIONS_READ plugin=${PLUGIN} reason=${reason} id=${sessionId} view=${read.view} messages=${messages.length} roles=${roles} marker=${marker}`,
      );
    } catch (error) {
      ctx.log.info(
        `E2E_SESSIONS_READ plugin=${PLUGIN} reason=${reason} id=${sessionId} error=${error?.code ?? "unknown"}`,
      );
    }
  }
}

export function activate(ctx) {
  void probe(ctx, "activate");
  ctx.env.onDidChange(({ locale }) => {
    void probe(ctx, `locale-${locale}`);
  });
}

export function deactivate() {}
