# Git Graph

Git Graph 是 Git 操作下拉菜单里的只读提交图入口，用于查看当前仓库最近提交、分支泳道、merge 边和 refs。

## 设计边界

- UI 只通过 `IGitService.getCommitGraph({ workspacePath, maxCount, skip })` 分页消费结构化数据，不直接调用 Git CLI。
- services/repo 层使用 `git log --all --topo-order --date-order` 读取 commit、parents、refs、author 和时间。
- `layoutGitGraph(commits)` 是纯函数，输入 topo/date 排序后的提交，输出行坐标、lane、edge path 和截断状态。
- SVG renderer 只负责展示节点、线、hover、selected、ref chip；窗口外 parent 用 dashed edge 表示截断。
- UI 使用 `DESIGN.md` 的语义 token，避免新增图形库，兼容桌面端和 Web 端主题。
- 弹窗保持固定高度。少量提交时，左侧图轨列的背景与右分隔线延伸到列表可视区域底部；节点和连线不拉伸。大量提交时由列表统一滚动，图轨与提交行保持对齐。

## 当前限制

- 默认每页加载 50 条提交，点击“加载更多提交”后通过 `skip` 读取下一页；repo 层单页最多允许 200 条。
- 当前入口是弹窗视图，暂不做无限滚动、搜索、checkout 或 diff 联动。
- 空仓库返回空列表，UI 显示空状态。
