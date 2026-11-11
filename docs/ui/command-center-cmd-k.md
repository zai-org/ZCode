# Command Center Cmd+K Initial State

## 目标

`Cmd/Ctrl+K` 打开的 Command Center 需要同时承担工作区快捷入口和当前任务上下文入口。默认打开时优先展示当前任务最近变更、最近任务和按语义拆分的命令分组；输入搜索词后继续复用现有 commands / tasks / files 混合搜索能力。

## 默认内容

空搜索且范围为 `All` 时按以下顺序展示：

1. `Recent changes`
   - 数据来源是当前 active task 已加载的 assistant messages。
   - 与聊天区每轮 `summary changes` 保持同源：从 assistant tool calls 的 `raw` / `input` / `output` / `display` 结构中解析文件变更摘要。
   - 不读取 sqlite 的 `summary_*` 字段，不读取 `ZCodeTaskMeta.changeSummary`，也不从 `perTurnFileChangesByTaskId` / `perTurnSummariesByTaskId` 做兜底。
   - 只展示当前任务最近修改过的文件，不能使用整个 workspace 的 Git unstaged/staged 变更。
   - 默认展示最多 3 条。
   - 每行展示文件图标、workspace 相对路径、`+added -removed`。
   - 当前任务没有变更摘要时隐藏该分组。

2. `Recent tasks`
   - 数据来源是当前 workspace 已加载任务列表。
   - 默认展示最多 3 条最近更新任务。
   - 点击后切换到对应任务。

3. 命令分组
   - 原先单一 `Quick actions` 拆成 `Suggested`、`Chat`、`Navigation`、`Panels`、`Configure`、`App`。
   - 分组模型保持稳定；本轮没有默认命令的分组不展示空标题，但不能从 registry / i18n / section order 中删除。
   - `Suggested` 只展示 `New task`、`Open workspace`、`Settings`。
   - `Chat` 与 `Navigation` 暂无默认命令项，后续对话和导航动作仍回到对应分类承接。
   - `Panels` 展示 `Toggle sidebar`、`Toggle terminal`、`Toggle preview`、`Add terminal tab`、`Add browser tab`、`Add review tab`。
   - `Configure` 展示 `Settings`、`Switch theme to light/dark`、`Skills`、`MCP Servers`。
   - `App` 展示 `Feedback`、`Community`、`Product docs`、`Connect/Disconnect`。

## 范围 Tabs

搜索框下方始终展示范围 tabs：`All`、`Actions`、`Tasks`、`Files`。tabs 是范围筛选，不只是搜索前缀快捷入口；因此即使没有输入内容，切换 tab 也必须展示对应范围的默认内容。

- `All`
  - 空搜索时展示完整默认首页：`Recent changes`、`Recent tasks`、命令分组，其中上下文分组只展示最多 3 条预览。
  - 输入搜索词后混合搜索 actions、tasks、files；任务和文件结果按首页预览节奏折叠。
- `Actions`
  - 空搜索时只展示命令分组：`Suggested`、`Chat`、`Navigation`、`Panels`、`Configure`、`App`。
  - 输入搜索词后只搜索 actions。
- `Tasks`
  - 空搜索时只展示最近任务，不能沿用 `All` 首页的 3 条预览限制。
  - 输入搜索词后只搜索 tasks，并直接展示任务结果列表，不沿用 `All` 的 3 条预览限制。
- `Files`
  - 空搜索时只展示当前 active task 修改过的文件，即 `Recent changes`，不能沿用 `All` 首页的 3 条预览限制。
  - 输入搜索词后只搜索 workspace files，并直接展示文件结果列表，不沿用 `All` 的 3 条预览限制。
  - workspace files 与 Composer `@` 文件候选复用同一个 Host 侧 `listWorkspaceFiles` 索引和[默认过滤器](../superpowers/specs/2026-08-07-workspace-file-search-default-filter-design.md)；UI 不维护独立黑名单，本期不提供自定义规则配置入口。

视觉上搜索框和范围 tabs 属于同一个 header block，header block 使用紧凑的 8px 横向 padding，中间不放分割线；只在 tabs 下方进入结果列表前使用弱分隔。搜索框本体使用带边框的胶囊输入壳，遵循 input 背景、边框、hover 与 focus token。tabs 使用小尺寸胶囊按钮，保持紧凑、可横向滚动，避免移动端长文案挤压搜索框。

## 搜索状态

输入搜索词后，保留现有 Command Center 搜索语义：

- 无前缀时同时搜索 commands、tasks、files。
- `>` 限定 commands。
- `#` 限定 tasks。
- `@` 限定 files。
- 搜索结果仍按命令、任务、文件分组展示，并保留搜索历史。

## 历史任务搜索范围

- 输入关键词时，桌面和手机共享的 Command Center 请求当前 Host 的全部持久化任务。UI 只提交关键词、排序、数量上限及 `workspaceScopes: "host"`，不能用 `tabStore` 或已加载任务裁剪范围。
- Host 从自己的 `tasks-index.sqlite` 查询标题和已索引正文，按存储 `host_id` 隔离。包括未打开目录、未归类、置顶和已归档任务；排除 App/CLI 已删除任务及其他 Host 的缓存。不依赖 CLI 启动，也不为搜索连接离线设备。
- `kind: "all"` 表示全部未删除 membership；已有按 workspace 的 active/pinned/archived/timeline 列表及空关键词的当前工作区最近任务保持既有语义。
- 搜索结果由 Host 完成筛选和排序。重新打开搜索或更换关键词必须重新读取 Host，不能复用仅覆盖已打开 workspace 的永久缓存。
- 点击未打开本地目录的搜索结果时，复用任务导航入口打开目标 workspace，再选择目标任务；读取已归档任务不改变归档状态。
- 本次不增加历史正文回填。索引为空的旧正文仍不匹配；当前 continuous 订阅只保证历史可读，不能视为正文索引已经回填。

```text
桌面 / 手机关键词 → Window Host → 当前 host_id 的持久化索引 → 排序和片段 → UI
点击结果 → 打开目标 workspace → 选择任务 → 既有 continuous / replayable 历史读取
```

| ID            | 操作                                                                 | 断言                                                                   |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| CC-HISTORY-01 | 冷启动，仅打开一个目录，搜索 36 天前其他目录及未归类任务的标题和正文 | 无需打开任务或启动其 CLI 即可命中；包括置顶、归档，不含删除和其他 Host |
| CC-HISTORY-02 | 点击未打开目录的搜索结果，再关闭和重开搜索                           | 打开正确任务；范围不随 tab 改变；归档状态不变                          |
| CC-HISTORY-03 | 手机通过真实 shared-host 配对后搜索同一批历史任务                    | 使用同一 Host 索引与隔离范围                                           |

正式用例：`packages/desktop/test/e2e/ui-shell/navigation/command-center-history-search.test.ts`。使用隔离持久化历史，不发送模型请求。

## 任务行选中身份

- cmdk 是面板选中状态的唯一持有者；React `key` 与 cmdk `value` 都必须使用稳定的行身份。
- 最近任务的 `value` 使用 `recent-task:${workspaceKey}:${taskId}`；任务搜索结果使用 `task-result:${row.key}`，其中 `row.key` 已包含工作区身份、任务 ID 和有正文片段时的片段序号。
- 标题、工作区显示名和搜索片段只用于展示和现有搜索匹配，不能作为选中身份。原因是同工作区的重名任务会得到相同文本，cmdk 按 `value` 判断选中时会同时高亮多行，并影响键盘定位。
- 鼠标移动或键盘上下移动后，只允许目标行处于 `aria-selected=true`；Enter 和点击继续通过该行原有回调打开对应任务/正文片段。
- 本地任务使用路径 fallback，远程任务使用 `workspaceIdentity?.trim() || workspacePath`；同路径、同标题甚至同任务 ID 的不同远程工作区不能共用选中值。
- 这是共享 UI 内的行身份修复，不新增持久化或迁移，不改变桌面 continuous、手机 replayable、Host/CLI 的任务数据与事件边界。

```text
鼠标移动 / 键盘上下键 → cmdk 保存唯一行 value → 仅目标行选中 → 原有任务打开回调
```

### 回归用例

| ID           | 前置状态与操作                                              | 断言                                                             |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| CC-SELECT-01 | 最近任务有三个同工作区的重名任务；依次 hover、上下键、Enter | 始终仅目标行选中，打开目标任务                                   |
| CC-SELECT-02 | 搜索返回同标题、同工作区显示名、同正文片段的不同任务        | 每行可独立选中；不同远程 identity 和同任务的不同片段也可独立选中 |

组件回归：`packages/ui/test/commandCenterSelection.test.ts`。
桌面交互候选：`packages/desktop/test/e2e/ui-shell/navigation/command-center-selection.test.ts`，验证真实索引列表与 cmdk 鼠标/键盘交互；不发送模型请求。

## 视觉细节

- 搜索框聚焦时只使用外层胶囊的 focus 边框和背景，内部输入元素不额外显示矩形 outline；深浅主题与窄屏保持一致。全局不再按弹窗、远程控件或设置导航强制添加 outline，命令中心不保留对应的 `!important` 局部覆盖。`ui-shell/manual-review/pending/command-center-focus.test.ts`（CC-FOCUS-01）独立检查内部 `outline-style: none`、无 box-shadow 且外层边框保留，不依赖任务列表数据。Electron 44 的计算样式在 `outline-style: none` 时仍可返回 `outline-width: 3px`；不能用该数值判断是否绘制边框。
- Command Center 与 QuickPick 的列表 item 使用 `rounded-xl`，让键盘选中态和 hover 态更柔和。
- 底层 `CommandItem` 保持 `rounded-lg` 默认值；Cmd+K/QuickPick 通过共享 item class 覆盖为更大圆角，避免影响其它命令列表。
- 命令图标优先复用对应既有入口的 Lucide 图标；同一动作在 Header、Sidebar、Side pane 与 Cmd+K 中不能使用不同语义图标。

## 兼容边界

- UI 必须兼容桌面端和 Web 端。
- 主快捷键继续遵循平台规则：macOS 使用 Command，Windows/Linux 使用 Ctrl。
- 本地和远程 workspace 的最近任务仍走已有 task list 服务边界，UI 不直接读取 session JSON。
- `workspaceIdentity?.trim() || workspacePath` 继续作为任务与历史隔离 key。
