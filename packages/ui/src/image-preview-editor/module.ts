export const imagePreviewEditorModule = {
  id: "image-preview-editor",
  requires: ["ui", "shared", "ui-file-menu"],
  provides: ["image-preview-editor"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../hooks/useImageFilePreview.ts",
    "../lib/copyPreviewImage.ts",
    "../lib/imagePreviewDownload.ts",
    "../v4/ConversationImageFileMention.tsx",
  ],
} as const;
