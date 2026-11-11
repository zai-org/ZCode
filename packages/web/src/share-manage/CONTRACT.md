# 分享管理页（web-share-manage）

Web 分享站 `/share/manage`、`/cn/share/manage` 的管理页：列出当前登录用户的分享，支持撤销、恢复、删除、修改有效期与访问权限。规格见 `docs/conversation-share-v1.md`「分享有效期与分享管理」，服务端契约见 zcode-server 设计文档第 17 节。

不变量：

- 列表、分页游标、行状态与确认对话框只由 `ConversationShareManageLoader` 持有；服务端响应是唯一事实源，不做乐观更新，不在客户端推算过期。
- 有效期选项的唯一来源是服务端 capabilities 的 `[min_ttl_ms, max_ttl_ms]`，规则与发布端相同（`conversationShareTtlChoices`）；未声明范围或读取失败时不显示有效期分组。
- 同一行的操作串行：进行中禁用该行全部控件；不同行互不影响。
- 3211/3212 视为分享已不可管理，从列表移除；401 清理登录态回到登录页。
- 首屏请求的响应只在返回时 token 仍是发请求时的 token 才写入状态；任一请求 401 清理登录态后，迟到的其他首屏响应一律丢弃。
- 扩大可见范围（仅自己 → 凭链接查看）、撤销、删除都必须经过确认对话框。
- 登录卡片、错误卡片与主题切换复用 `share/ConversationShareLandingPage`，错误分类复用 `@zcode/shared` 的 `classifyConversationShareError`。
- 开发态 mock 只经 `mockConversationShareManageClient.ts` 动态加载，不进入生产包静态依赖。
