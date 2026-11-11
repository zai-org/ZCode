/**
 * conversation-share-interaction 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationShareInteractionModule = {
  id: "conversation-share-interaction",
  requires: ["services", "shared", "ui"],
  provides: ["conversation-share-interaction"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "ConversationSharePopover.tsx",
    "ConversationShareExpiryPicker.tsx",
    "ConversationSharePreflightStatus.tsx",
    "conversationSharePopoverActions.ts",
    "conversationSharePreflightRequest.ts",
    "conversationSharePreflightResponse.ts",
    "SettingsShareManagement.tsx",
  ],
} as const;
