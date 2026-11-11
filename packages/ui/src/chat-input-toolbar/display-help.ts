import type { ZCodeProvider } from "@zcode/shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    default: "mode.label.glm.default",
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    yolo: "mode.label.glm.yolo",
    guarded: "mode.label.glm.guarded",
  },
};

export const ZCODE_MODE_OPTION_DESCRIPTION_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    default: "mode.description.glm.default",
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    yolo: "mode.description.glm.yolo",
    guarded: "mode.description.glm.guarded",
  },
};

/** 审批框与输入框共用权限颜色，浅色/深色主题由语义 token 决定。 */
export function modeTriggerColor(mode: string) {
  if (mode === "guarded") return "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue";
  if (mode === "yolo") return "text-warning hover:text-warning";
  return undefined;
}
