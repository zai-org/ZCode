// E2E 扩展 fixture（docs/plugins/extension-host.md §16.6）：纯 JS，不需要构建。
// 命令 search 是 composer.mention 条目的 target：参数 { query }，返回候选项数组。
// query 越短返回越慢（每少一个字多等 1.5 秒，4 个字以上立即返回）：快速输入时，旧查询的结果晚于新查询到达，
// E2E 用它验证 Renderer 只采用最新一次。运行时证据写进日志（E2E_MENTION_*），不记候选内容以外的东西。
const SLOW_STEP_MS = 1500;
const FAST_LENGTH = 4;

export function activate(ctx) {
  ctx.commands.register("search", async ({ scope, args }) => {
    const query = String(args?.query ?? "");
    const delay = Math.max(0, FAST_LENGTH - query.length) * SLOW_STEP_MS;
    ctx.log.info(
      `E2E_MENTION_QUERY q=${JSON.stringify(query)} scope=${scope.kind}:${scope.sessionId ?? ""} delay=${delay}`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    ctx.log.info(`E2E_MENTION_DONE q=${JSON.stringify(query)}`);
    const tag = query || "all";
    return [1, 2, 3].map((n) => ({
      id: `${tag}-${n}`,
      label: `E2E ${tag} #${n}`,
      description: `Candidate ${n} for "${query}"`,
      icon: "file-text",
      insertText: `E2E_MENTION_INSERT[${tag}#${n}]`,
    }));
  });
}

export function deactivate() {}
