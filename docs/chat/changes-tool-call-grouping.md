> 已退役：会话工具聚合能力已移除。当前行为见 [Tool Display Rendering](../ui/tool-display-rendering.md)。下文仅保留设计历史。

# Changes Tool Call Grouping

## 发布状态

功能已实现且用户设置默认关闭。Settings 中的“分组文件更改”持久化为应用级
`toolGroupingChangesEnabled`；缺失时由 `ENABLE_CHANGES_TOOL_CALL_GROUPING=false` 兜底。关闭时生产 UI
保留连续的 Write/Edit/ApplyPatch 原始工具行。Changes renderer、响应式 summary 与 focused tests 继续
保留，不新增 session、协议或 runtime 状态。

## 目标

连续的文件写入类 `ToolCallRow` 在 conversation UI 中聚合为一个 `Changes` 父组。父组只是共享
renderer 的展示节点，不新增协议、runtime、持久化或 replayable 状态；原始 Write/Edit/ApplyPatch
仍作为 children 保留完整 diff、错误和 snapshot field notice。

## 状态与时序

```text
Write/Edit ── Write/Edit ── Write/Edit ── 可见非 file-write row
     └──────── Changes: in_progress ────────┘
                                             └─ Changes: completed
```

- 父级运行态只由可见阶段边界决定：位于 running work segment 的最后一个可见 chunk 时为
  `in_progress`，否则为 `completed`。
- child 的 running/completed/failed/stopped 不反向决定父状态；错误只在对应 child 展示。
- 隐藏的非首 reasoning 不构成边界；可见 reasoning、Explore、Terminal、Agent、正文和其他可见
  tool 都结束当前 Changes。
- 父 key/tool id 锚定首个真实 file-write row，新增 child 不得重建父组件或丢失展开状态。

## Summary 合同

| 父状态 | 展开状态 | Summary                                                                          |
| ------ | -------- | -------------------------------------------------------------------------------- |
| 进行中 | 收起     | `Changes · N files · Editing/Writing <file chip> <diff count>`；最新快照纵向滚动 |
| 进行中 | 展开     | `Changes · N files`                                                              |
| 完成   | 展开     | `Changes · N files`                                                              |
| 完成   | 收起     | 多文件：`Changes · N files · <file chips>`；单文件：`Changes · <file chip>`      |

当运行中的 Write/Edit 已经进入分组、但流式 JSON 尚未提供可解析的文件路径时，父摘要显示
`Changes · N tools`，其中 N 是当前分组 child 数量。此阶段不得显示悬空分隔符或 `0 files`；展开后
仍保留原始 child，即使文件路径尚未到达、暂时只能显示 `Writing`/`Editing`。路径到达后父摘要再切换
到正常的 file summary。

- 文件数按规范化后的完整 path 去重，顺序取首次出现顺序；单个 Edit 自带多个 file summary 时先
  扁平化，再与其他 children 一起去重。
- 完成收起态只有一个唯一文件时省略 `1 file ·`，直接显示 file chip；这是单文件摘要的精简例外。
- 完成收起态首次渲染完整 file chip 列表，再按 summary 实际可用宽度保留尽可能多的前序 chip，
  剩余项显示 `+N`；`ResizeObserver` 在桌面窗口、侧栏或手机布局宽度变化时重新计算，变宽后恢复
  更多文件。容器不得产生横向溢出。chip 复用现有文件图标、tooltip 与代码预览点击行为。
- 运行态收起时用最新具有 file summary 的 child；动作由该 child 的 operation 语义决定。
- 运行态的 `N files` 按当前已解析路径实时去重；动作、文件名、路径和 diff count 属于同一动态
  内容层级，彼此只用普通间距，不再插入 `·`。`·` 仅分隔 Changes、文件总数和动态内容。
- 运行态滚动快照必须同时保存该 child 的 diff count。文件摘要切换完成后，diff 数字在同一
  快照尾部独立翻动，不能提前显示下一条 child 的统计，也不能等 child 完成后才挂载最终值。
- 父组展开期间，子 Write/Edit 的 diff count 必须保留首次流式统计的进入动画；分组不得因为
  child 延迟挂载而把运行过程退化成完成后静态显示最终统计。
- 展开会立即停止父 summary 动画并显示唯一文件数，当前动作由下方 child summary 表达。
- 最小窗口下若剩余宽度放不下一枚 file chip，完成态只显示 `+N`；E2E 校验可见文件数与隐藏数之和、首次出现顺序，以及变宽后的恢复，不假设窄窗口必定显示首个文件。
- Changes 父组固定使用 16px 铅笔图标；运行中保持静态，不切换 loading spinner。
- Edit 与 Changes 共用的 file chip 文件名使用 `text-foreground-subtle`；相对目录继续使用更低一级的 `text-foreground-subtlest`。

## 多端边界

分组只消费 desktop continuous 或 web-remote replayable 最终投影出的相同 rows，不改变 transport、
snapshot、gap、queue 或 owner 语义。共享 renderer 同时用于桌面和手机 Web；窄屏通过 `min-w-0`、
截断和固定 chip 上限保护布局。
