# Git 文件变更查找只展开文件，未定位到命中文本

Status: needs-triage

2026-10-17 转正回放复现。按用户要求记录业务异常，保留 E2E 失败断言，不改业务实现。

- 用例：`packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts`。
- 前置：真实 Git 仓库中有 1300 行变更，第 80 行含唯一标记；会话长正文由 case-local Provider 真实返回。
- 复现：打开任务查找，完成会话范围的首次定位及上一个/下一个/Enter/Shift+Enter 回归，然后切换到文件变更范围，搜索唯一标记。
- 实际：结果计数 `1/1`，文件已经展开；Git 滚动容器 `scrollTop=0`、高度 `686px`，命中文本距视口中心 `1239px`，20 秒内仍未定位。会话范围的四种重复导航均已通过。
- 实现证据：`packages/ui/src/GitPane.tsx` 计算全局命中后展开文件，并通过虚拟列表 `scrollToIndex` 定位文件行；当前未将命中的行位置传给 diff 展示层，也未滚动真实文本命中。文件项定位不能替代文件内部文本定位。
- 运行证据：`pending-promotion-repair-proof-current-1-1-20261016-02001f1247` 的 `test-results.ndjson`、失败录像和桌面日志。
- 规格：[查找结果导航语义](../../ui/chat-find-placement.md) 要求两种范围均将命中重新居中。不能降低断言为只验证计数或展开。

```mermaid
flowchart LR
  A[输入唯一查询词] --> B[结果计数 1/1]
  B --> C[展开目标文件]
  C --> D[虚拟列表定位文件项]
  D --> E[文件内命中文本仍在视口外]
```

验收：首次搜索及滚离后重复导航都将命中文本居中；会话与文件两种范围、四种导航入口均通过。精确修复方案仍需结合渲染器的文本高亮与虚拟滚动归属确定。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-904-pending-20261019` 再次记录文件范围搜索 `1/1` 且 expanded=true，命中距视口中心 1239px，scrollTop=0，viewportHeight=686px；仍未完成文件内命中定位。
