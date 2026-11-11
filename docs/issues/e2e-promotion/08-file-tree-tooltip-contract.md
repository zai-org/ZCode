# 文件树更多按钮未提供 SBT03 约定的悬停提示

Status: done

2026-10-17 转正回放再次复现。按用户要求仅记录，不改业务代码，不删除失败断言。

- 用例：`packages/desktop/test/e2e/ui-shell/navigation/sidebar-tooltips.test.ts`。
- 复现：打开项目文件树，将真实鼠标移到“更多”按钮；此前左侧入口的延迟断言均通过。
- 实际：鼠标命中按钮，按钮含 `aria-label="更多"` 与原生 `title="更多"`，没有生成共享 Tooltip。等待 5 秒后仍没有 `tooltip-content`。
- 实现：`packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx` 的更多按钮包裹 `SidebarNativeTooltip`；该组件在 `SidebarTooltipProvider` 范围外保留原生 title。文件树移到右侧后走了此分支，因此不是鼠标未命中或提示计时变慢。
- 证据：回放 `pending-promotion-repair-secondary-1-2-20261016-02001f1247` 的失败录像，以及 `packages/desktop/.e2e-artifacts/sidebar-tooltips-desktop/failure.json` 中的实际元素、鼠标坐标和空提示列表；前一轮相同位置也失败。
- 规格：[SBT03](../../ui/sidebar-tooltips.md) 明确列出文件树按钮的 300ms 提示，并要求替换原生 title；[文件树](../../ui/workspace-file-tree.md) 已将文件树移到右侧独立标签。

需确认范围：SBT03 的文件树要求是否继续适用于右侧标签。若继续适用，这是迁移后的业务回归；若该要求只适用于已移除的左侧文件树，应先更新规格再调整 E2E。当前不能仅因文件树移到右侧就把失败计为通过。

## 2026-10-18 裁决与验证

用户确认按当前范围验收：左侧维持 300ms，右侧已有原生 title 保持原生，刷新按钮继续使用共享自定义提示。旧 SBT03 范围过期，属于 E2E/spec 问题。更新后 `pending-promotion-contract-tooltip-final-1-1-20261016-02001f1247` 1/1 PASS，验证左侧计时、右侧提示、更多菜单、刷新和搜索清除。菜单关闭后等待真实关闭状态并重新聚焦搜索框，避免关闭时焦点恢复吞掉输入。未改业务逻辑。
