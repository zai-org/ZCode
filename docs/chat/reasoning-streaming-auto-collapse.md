# Reasoning Inline Streaming Summary

## 背景

Assistant thought / reasoning 块本身已经表达“模型正在思考”。流式阶段默认保持收起，触发器在 `Thinking ·` 后直接展示原始流式内容；摘要紧跟标签、宽度随内容增长，最大使用当前行剩余空间。用户仍可主动展开查看完整内容。

## 规则

- thought 块 `isStreaming=true` 时默认保持收起，触发器的 `Thinking` 文案继续使用 `animated-gradient-text`，保持轻量文字渐变，不新增颜色 token。
- 收起态格式为 `Thinking · <流式内容>`。中文运行态标签使用“正在思考”，完成态标签使用“思考”；英文保持 `Thinking` / `Thought`。
- 流式内容按换行边界派生摘要快照，但不把换行转换为 `<br>`：同一行内的新 token 原位更新；出现下一条非空行时，旧行向上退出、新行从下方进入。纵向切换复用工具摘要的队列与节奏（300ms 动画、500ms 停留、最多当前项加两条待播项），主线程卡顿或 reduced motion 时直接收敛到最新行。
- 当前行摘要视口紧跟分隔点，不使用 `ml-auto` 或 `text-right`。内容未撑满时从左向右自然增长；视口达到标签与箭头之外的剩余宽度后保持单行，并在当前行每次流式更新后滚到末尾，让旧内容向左移、最新 token 始终可见。
- 摘要发生横向溢出时，视口左右两侧同时使用 16px mask 淡出；未溢出时不挂 mask，避免短内容边缘变淡。容器或内容宽度变化时必须重新测量溢出状态。
- 流式摘要文字使用次要文字色 `text-foreground-subtle`；图标、分隔点与箭头继续使用更弱的 `text-foreground-subtlest`。
- 运行中展开 thought 后，头部切换为 `icon + **Thought** + · + duration`，隐藏单行流式摘要及其横向 mask；duration 从思考开始计时并每秒更新，完整 thought 在下方继续流式追加。
- 完成态显示为 `icon + **Thought** + · + duration`；三个文本节点使用 `gap-2`，中文为加粗的“思考”、普通字重的分隔点和普通字重的“持续了 N 秒”。
- 英文 duration 直接显示为 `N seconds`，不添加 `for` 或 `took`；例如 `Thought · 2 seconds`。
- 同一行 token 到达时直接更新当前文本节点；只有非空换行边界使用与 Explore 相同的纵向翻滚和摘要队列。reasoning 完成时立即切换为现有 `Thought · duration` 完成摘要并清空待播内容。
- 用户展开后，完整 thought 继续流式追加并沿用现有换行、折行和吸底规则；收起态的 `whitespace-nowrap` 不得影响展开内容。
- 用户仍可手动展开已完成 thought 查看内容。
- 展开的 thought 内容只有在实际产生纵向滚动时才显示边缘 mask；位于顶部时只显示底部渐隐，位于中间时显示上下渐隐，位于底部时只显示顶部渐隐。
- 展开的 thought 内容默认跟随底部；用户主动向上滚动离开底部后暂停吸底，用户回到底部后恢复吸底。
- `open` 受控时尊重外部传入状态，只负责同步耗时与内容延迟卸载。

## 流式摘要状态与回归（XSG03）

`QueuedSummaryContent` 只管理摘要身份切换的播放状态。当前摘要 key 不变时，正文、次要内容和尾部计数从当前输入派生，不在 effect 中逐 token 复制进 React state；关闭动画、分组预览和 reduced motion 直接显示输入。原因是连续同步投影提交与 effect 内的内容复制会持续留下待处理更新，触发 React #185。

```text
相同 key 的内容更新 → 直接显示最新输入，保留同一文本节点，不重播纵向动画
新 key → 当前项 + 两个待播项 → 300ms 切换 + 500ms 停留
关闭动画 / reduced motion → 释放播放状态和 timer → 直接显示最新输入
```

思考块作为 flex 摘要子项时允许收缩，不能由默认最小宽度撑开内部流式视口。横向溢出检测只有在布尔值改变时才调用状态 setter；相等判断放在 dispatch 之前，不能逐 token 提交返回旧值的 updater。

动画快照仅保存已提交的输入；当前项随后离开输入位置时，仍保留它最后一次已提交的正文与计数。等待项的同 key 内容更新替换原快照；队满时保留下一条，仅替换最后可插队项。关闭后重新开启动画不得恢复旧队列或闪回旧正文；组件卸载后 timer 不再推进。

浏览器回归使用生产 React、真实 `ReasoningTrigger` 与连续分组，覆盖 200 次连续同步更新、独立与双层摘要、同 key 文本节点保持、非空换行/摘要 key 切换、待播项刷新/有界队列、关闭/重开/reduced motion、完成态及卸载清理。桌面和手机尺寸、深浅主题、中英文共用此合同；该回归只验展示，不把合成更新当作真实远控网络回放。

## 兼容性

该变更只影响 UI 层 thought / reasoning 展示，不修改 ZCode Protocol、消息快照、desktop continuous 或 mobile replayable 语义。移动 Web 与桌面端消费同一 message parts，共用默认收起和单行原位流式摘要规则。
