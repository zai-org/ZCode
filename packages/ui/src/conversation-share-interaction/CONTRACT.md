# 分享浮窗交互

该模块连接分享浮窗、范围事务和预检请求。公开入口分别对应界面展示、store 动作工厂和请求响应处理；消费者不得从未登记文件导入实现。

- 范围草稿唯一 owner 为 conversationShareSelectionStore：勾选只修改 pending，确认提交，取消回滚；关闭、会话切换与发布锁定沿用既有语义。
- 预检缓存与发布状态唯一 owner 为 SessionPane。模块接收引用及回调，不保留第二份缓存，不写数据库。
- 请求按代际失效，effect 清理阻止旧响应写回；响应处理还校验当前 scope。条目构建成功后才提交元信息，处理异常写入可重试阻断。
- 顺序：用户勾选 → store 草稿 → SessionPane 发起预检 → 当前代际提交缓存 → 展示检查结果；确认后才改变最终范围。
- 浮窗使用外部受控状态；发布时禁止关闭，选择期间 Esc 只取消范围草稿。手机远控不增加分享入口。
- 有效期选择只展示预检返回的 `ttlOptions`（与发布同一权威），草稿值归 conversationShareSelectionStore；`resolveConversationSharePublishTtlMs` 是展示与发布共用的唯一取值规则，不在模块内缓存服务端范围。
- 拆分入口避免 store 消费方为了加载动作工厂而加载 React 视图。共享 UI、国际化、日志与服务类型通过既有依赖访问。
- 设置页分享管理（`SettingsShareManagement`，仅桌面端）：列表、游标、行状态由组件自身持有，服务端响应是唯一事实源，不做乐观更新；只提供复制、打开、跳转对话、停止/恢复、删除，不修改权限与有效期。跳转目标只读 Host 本地任务索引（`listTaskList` 的 `taskIds`），命中才显示，导航由 Root 注入的 `onOpenTask` 完成。
