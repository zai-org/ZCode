# plugin-ui

Renderer 模块，层序 `domain → app → adapters → components`；公开入口为 `index.ts`。

- 本地草稿复用预热 session。pane 提供有效 session 投影及保活能力，页面 owner 在创建时取得引用，真正销毁时释放；展示卸载不释放，重载连续持有。草稿换代先通知页面失效，首发提升只解除草稿槽位，不销毁原页面。审批、附件与 Composer 上下文使用同一有效 session；普通工具调用不产生聊天回合。范围与验收见 [草稿 UI spec](../../../../docs/plugins/draft-mcp-ui-session-spec.md)。

- 窗口唯一页面管理器统一管理 MCP 与 Gen UI 的容量和回收；`createPage` 持有 MCP controller、AppBridge、独立 workspace/session lease、通知 feed 和内存快照。卡片、侧栏只登记锚点。内联页面位于滚动容器内部，侧栏单独定位；原子移动保留同一 guest，不重读资源、不重新握手。解绑必须在 DOM 卸载前同步移入隐藏承载区。
- 页面承载容器只负责布局，不接收鼠标命中；webview 显式接收点击。webview 释放后的空容器不能遮挡宿主重载按钮，内联、侧栏与预览共用此规则。
- 侧栏展示由宿主工作区/主视图、展开状态和当前标签共同派生。隐藏卡片同步解绑展示锚点，按资源声明选择隐藏或可执行后台表面；回收前恢复复用同一 guest，不以保活 DOM 尺寸推断展示意图。
- 逻辑键包含 workspace identity（本地 fallback 为路径）、session、plugin、server、resource 和逻辑视图。surface 显式共享；普通工具只按明确的 widgetSessionId 与相同权限范围共享，否则按 toolCallId 隔离。禁止同回合同资源推断合并。
- UI 不接触插件 HTML、数据库和连接凭据。经 `IPluginUiBridgeService` 获取句柄，平台端口只校验 sandboxId/initId；请求与 live 通知绑定 Agent runtimeId/generation/token/appIdentity。
- 官方 ext-apps 2.0.0 每活页面一个 AppBridge；握手期限 15 秒。保留 `experimental["zcode/…"]` 的 widgetState、resourceSubscribe、surface、CSP、nestedFrames 扩展；旧宿主不宣告 nestedFrames，嵌套预览的页面据此降级；不模拟完整 OpenAI API。
- App-provided tools 在 initialized 后发现与登记；认领后用官方 SDK AbortSignal 执行，模型取消沿 live-only delta 到页面。callId 去重，终态结果不可再写入。页面调用 MCP 的目标由宿主固定，复用 Agent 的权限和审批路径，原始结果直接返回。
- 页面 `availableDisplayModes` 是硬约束，作用于锚点、hostContext 和模式请求；握手前使用后台表面，不展示 guest 或自动打开侧栏。只注册 fullscreen 时，对话显示插件图标、名称、状态和打开按钮，关闭侧栏仍为卡片；inline-only 不提供侧栏入口。未声明兼容双模式，空集合或仅 pip 不显示 guest。详见 [展示模式 spec](../../../../docs/plugin-ui-display-modes-spec.md)。高度默认 240px、范围 [80,1200]，hostContext 只回传 width/maxHeight，避免高度回环。
- widgetState 仅接受页面主动提交，唯一内存 store 按逻辑键隔离；重建时在 `hostContext["zcode/widgetState"]` 下发。切位置不复制；手动重试、任务淘汰、来源撤销清除；应用重启为空。
- MCP 页面仅在资源 `_meta.ui.backgroundRetention: true` 时申请后台保留；未声明恢复隐藏五分钟/容量回收。每窗口超过四个后台声明页时，按最久未活跃优先回收三十分钟未活跃且不忙的页面。四为软阈值；三十任务/六十四活页面准入保持，无可回收候选时拒绝新建。`PluginUiBackgroundRetention` 只持有 MCP 活跃时间与期限；Gen UI 仍使用原五分钟/容量规则。
- owner 准入后立即启动；能力握手前临时提供非零承载面让 guest 首次挂载，握手后只有声明页保留 inert 后台表面。只有声明页申请目标 guest 活动。可见期、模型/App 工具、sampling 与交付真实工作的 `_meta["zcode/activity"]: true` 更新活跃时间；空轮询、绘制与重复结果不续期。新工具结果可恢复已回收页面，重复投影不能复活它。详见 [后台执行 spec](../../../../docs/plugin-ui-background-execution.md)。
- 已获准的主动释放先按原 sandboxId 解除导航/崩溃监听，避免 Main 停止页面的 about:blank 导航误报崩溃；真实运行中的导航/崩溃仍进入 error，重试后重建。导航指 shell 主 frame 或插件 frame 自身（`zcode-sandbox:` 文档）的跨文档导航；插件文档内部的子 frame（如 srcdoc 预览）导航不是重载，不进入 error。
- 自动回收、显式重载、任务删除、窗口关闭和来源/runtime 失效释放 MCP 页面。顺序：失效凭证、取消调用和登记、有界 resource-teardown、关闭端口/guest、释放 feed/lease。迟到 prepare、注销和锚点清理只作用于捕获的原实例。卡片卸载不切断保活页面的订阅。
- `sendFollowUpMessage` 仍走既有会话动作和手势/可编辑确认；确认完成后验证实例。只读会话不登记动作。`updateModelContext` 只投递到该 workspace/session 的 composer，不是数据库状态。已附加的待发送上下文不随单个页面或连接失效清空；发送、任务删除或草稿 binding 失效才清理对应 session。
- `display.ui` 无效、Web/手机/远程、不支持平台或初始化失败继续普通 MCP 卡回退。工具行替代与折叠策略仍由投影派生；不会另建 accepted-input queue 或改变 continuous/replayable 语义。
- 工具失败、取消或 `display.ui.isError` 只保留普通工具记录，不占用 inline/侧栏区域、不自动开侧栏，手动固定/showInline/最近回合不能越过此门禁；失败不替代已有成功页面。原始错误结果及页面通知语义保持不变。

组件只经 hooks/服务端口访问外部能力；controller 不导入适配器，domain 只做纯计算。侧栏 tab、composer 上下文仍由既有 UI owner 持有，不与页面状态重复写入。

`preferredDisplayMode: fullscreen` 在页面支持 fullscreen 时限制该调用只在侧栏展示，对话保留打开卡片，关闭侧栏不回 inline；能力未声明或双模式也适用，inline-only 仍按注册能力展示。surface 侧栏从既有 feed 的最后一次成功结果读取该选择。自动打开每次实际工具调用只消费一次；记录归既有侧栏内存，按 workspace/session/plugin/server/resource/toolCall 隔离，随其窗口缓存保留与淘汰。工具行重挂不能重新触发打开并覆盖收起偏好；已显示在侧栏时也消费该调用。所有切换只改变锚点，同一 WebView、内部状态和后台执行保留。

- Sampling 使用官方 oncreatesamplingmessage；只有可操作任务声明 sampling:{}。请求携带完整实例凭证，SDK signal 经显式 cancel 到 Agent；controller 将采样计入 busy，切展示位置不取消/重发。结果不进入主聊天；内容扩展和进度仍 pending。

`hostPrimitives.ts` 对 Gen UI 公开 MessagePort 传输、原子移动页面承载层、窗口级容量管理、主题投影和会话动作读取。Gen UI 不复用 MCP 工具调用控制器。绑定显式区分自然流、容器定位与侧栏；Gen UI 预览使用原容器 popover，不重新挂载页面。

上游整合：app/adapters 从 services 公共入口导入插件能力端口类型和 IServiceAccessor，不引用 Repo 或 Runtime 实现。

窗口级接收器通过本地桌面专用服务事件接收当前成功 UI 工具结果，即使会话未挂载也向唯一页面管理器申请创建；与卡片共享逻辑键和准入 Promise。历史回放不主动创建，后台结果只更新工具数据，不改变展示锚点或抢焦点。

手动固定状态的订阅快照按 sessionKey 隔离。时间线从 `getPluginUiDisclosureSnapshot(sessionKey)` 读取不可变映射；无关会话的固定操作不使当前时间线失效。单卡仍按 toolCallId 读取同一状态 owner。
