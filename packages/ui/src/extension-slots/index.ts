export type {
  ComposerMentionGroup,
  ComposerMentionSlotProps,
  ComposerStatusSlotModel,
  ComposerStatusSlotProps,
  ExtensionLauncherModel,
  ExtensionLauncherSectionProps,
  ExtensionLauncherViewItem,
  ExtensionLogsSidePaneTab,
  ExtensionPermissionsSectionProps,
  ExtensionProblem,
  ExtensionSlotEntry,
  ExtensionSlotsSources,
  ExtensionViewPaneProps,
  ExtensionViewSidePaneTab,
  ExtensionViewTarget,
  FileViewerRoute,
  FileViewerRouter,
  NavPrimarySlotHost,
  NavPrimarySlotProps,
  OpenExtensionLogs,
  OpenExtensionView,
  StartExtensionDraft,
  WorkbenchPaneReport,
} from "@/extension-slots/contract.js";
export { ComposerStatusSlot } from "@/extension-slots/components/ComposerStatusSlot.js";
export { ExtensionLauncherSection } from "@/extension-slots/components/ExtensionLauncherSection.js";
export { ExtensionViewPane } from "@/extension-slots/components/ExtensionViewPane.js";
export { ExtensionLogsPane } from "@/extension-slots/components/ExtensionLogsPane.js";
export { ExtensionPermissionsSection } from "@/extension-slots/components/ExtensionPermissionsSection.js";
export {
  useConfirmExtensionEnable,
  useExtensionGrantState,
  useExtensionGrantsService,
} from "@/extension-slots/adapters/useExtensionGrants.js";
export { NavPrimarySlot } from "@/extension-slots/components/NavPrimarySlot.js";
export { resolveExtensionIcon } from "@/extension-slots/components/extensionIcons.js";
export {
  buildFileViewerTab,
  resolveLocalizedText,
  selectExtensionProblems,
  selectSlotEntries,
  selectStaticViews,
} from "@/extension-slots/domain/slotSelectors.js";
export { ExtensionViewsProvider } from "@/extension-slots/adapters/ExtensionViewsProvider.js";
export { useOpenExtensionView } from "@/extension-slots/adapters/extensionViewsContext.js";
export { useExtensionWorkbenchPane } from "@/extension-slots/adapters/useExtensionWorkbench.js";
export { useComposerMentionSlot } from "@/extension-slots/adapters/useComposerMentionSlot.js";
export { useExtensionMentionGroups } from "@/extension-slots/adapters/useExtensionMentionGroups.js";
export { ExtensionMentionOptionContent } from "@/extension-slots/components/ExtensionMentionOptionContent.js";
export { useFileViewerRouter } from "@/extension-slots/adapters/useFileViewerRouter.js";
export {
  useComposerStatusSlot,
  useExtensionLauncher,
  useExtensionSlotsState,
  useExtensionsService,
  useReloadExtensions,
} from "@/extension-slots/adapters/useExtensionSlots.js";
