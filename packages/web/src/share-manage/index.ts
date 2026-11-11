// 分享管理页公开入口；开发态 mock 单独从 mockConversationShareManageClient.ts 动态加载，不进入生产包的静态依赖。
export { ConversationShareManageLoader } from "./ConversationShareManagePage.js";
export { ConversationShareManageClient } from "./conversationShareManageClient.js";
export type { ConversationShareManageApi } from "./contract.js";
