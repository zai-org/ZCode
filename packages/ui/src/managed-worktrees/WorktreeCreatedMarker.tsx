// 会话历史中的"已创建 worktree"（docs/git/worktree.md §6.6.4）：由 CLI 写入历史，
// 桌面、手机与重启后看到的是同一项；默认收起，可展开查看 git 与拷贝输出。
import { TID_WORKTREE_CREATED_MARKER } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorktreeOutputBlock } from "./WorktreeOutputBlock.js";

export function WorktreeCreatedMarker({
  rowId,
  output,
}: {
  rowId: string | number;
  output: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div data-row-id={rowId} className="py-1">
      <WorktreeOutputBlock
        testId={TID_WORKTREE_CREATED_MARKER}
        title={intl.formatMessage({ id: "git.managedWorktree.created.title" })}
        status="done"
        output={output}
      />
    </div>
  );
}
