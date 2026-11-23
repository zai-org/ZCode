# 二次确认弹窗

## 目标

- 为 `packages/ui` 提供一个全局可复用的二次确认弹窗。
- 先覆盖两个高风险操作：删除 task、移除 project。

## 实现

- `packages/ui/src/store/confirmDialogStore.ts` 用 Zustand 管理单例确认请求，调用侧通过 Promise 等待结果。
- `packages/ui/src/ConfirmDialog.tsx` 负责渲染弹窗，布局和按钮区对齐 `z-work` 的确认弹窗样式。
- `packages/ui/src/Root.tsx` 在根节点挂载 `ConfirmDialogHost`，保证 desktop、web、本地、remote 都走同一套 UI 逻辑。

## 接入点

- `packages/ui/src/TaskList.tsx` 删除 task 前先弹确认框。
- `packages/ui/src/WorkspaceSidebar.tsx` 移除 project 前先弹确认框。

## 更新确认的窄窗口布局（2026-11-19）

- 更新重启确认声明 `presentation: "update-confirmation"`，仅影响这个请求，不改变其他确认弹窗。
- 独立更新窗口宽度为 512px，不能用 viewport 的 `sm` 断点把桌面操作区变成全宽纵向按钮。
- 更新确认标题用 `text-ui-base font-medium`，说明用 `text-ui-sm text-foreground-subtle`，正文自然换行。
- 按钮按内容宽度横排靠右，空间不足时自然换行；使用共享 Button 的 `lg`（32px）尺寸，隐藏 Enter/Esc 提示文字。
- 表面使用 `bg-popover`，不额外拼接透明度；按钮保留现有主/次按钮主题令牌。
- Enter 确认、Escape 取消、活动任务检查和确认后更新路径都不变。
- 验收覆盖 512px、390px 和宽窗口、Zai Light/Dark、中英文；同时检查默认确认框不受影响。

浏览器验收入口：`node --test packages/ui/test/browser/manual-review/pending/update-confirmation.test.mjs`。
使用真实 `ConfirmDialogHost`、主题与国际化，共 12 组通过；检查按钮横排、32px 高度、16px 侧边距、
文字层级、默认确认框不变及 Enter/Escape 结算。截图位于
`packages/desktop/.e2e-artifacts/update-confirmation-browser/`。不调用真实更新安装，不代表原生窗口或安装链验收。

## 交互约束

- `Esc` 取消，`Enter` 确认。
- 关闭 project 只移除侧边栏项目，不影响磁盘文件。
