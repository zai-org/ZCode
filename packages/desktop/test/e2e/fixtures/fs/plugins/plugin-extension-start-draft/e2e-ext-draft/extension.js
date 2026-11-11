// E2E 扩展 fixture（docs/plugins/extension-host.md §18.1 H2）：纯 JS，不需要构建。
// composer.status 条目 draft 点击执行 start-draft：经 ctx.workbench.startDraft 开一个预填文字的新草稿，
// 与 GitLab 面板「用 ZCode 审查」同一条路径。奇数次点击用当前工作区，偶数次显式传命令作用域的工作区。
// 第一次点击后另试两个不合规的入参（超长、空白），都应在扩展进程内报 invalid-input。
// 日志只记点击序号、长度与结果，不记文字本身。
const DRAFT_TEXT =
  "E2E_START_DRAFT review https://gitlab.example.com/group/project/-/merge_requests/7";
const TEXT_LIMIT = 4000;

export function activate(ctx) {
  let clicks = 0;
  ctx.slots.update("draft", { text: "E2E draft", tooltip: "E2E_START_DRAFT" });
  ctx.commands.register("start-draft", async (call) => {
    clicks += 1;
    const click = clicks;
    const workspace = call.scope.kind === "app" ? undefined : call.scope.workspace;
    const explicit = click % 2 === 0 && workspace !== undefined;
    // 不用「#N」后缀：# 是输入框的会话提及触发符，光标停在它后面会打开提及面板。
    const text = `${DRAFT_TEXT} (click ${click})`;
    try {
      await ctx.workbench.startDraft(explicit ? { text, workspace } : { text });
      ctx.log.info(
        `E2E_START_DRAFT ok click=${click} workspace=${explicit ? "explicit" : "current"} chars=${text.length}`,
      );
    } catch (error) {
      ctx.log.info(`E2E_START_DRAFT failed click=${click} code=${error?.code ?? "unknown"}`);
    }
    if (click !== 1) return;
    for (const [name, bad] of [
      ["too-long", "x".repeat(TEXT_LIMIT + 1)],
      ["blank", "   "],
    ]) {
      try {
        await ctx.workbench.startDraft({ text: bad });
        ctx.log.info(`E2E_START_DRAFT_INVALID ${name} ok`);
      } catch (error) {
        ctx.log.info(`E2E_START_DRAFT_INVALID ${name} code=${error?.code ?? "unknown"}`);
      }
    }
  });
}

export function deactivate() {}
