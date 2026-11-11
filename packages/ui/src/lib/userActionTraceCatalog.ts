import type { RendererActionTraceGroup } from "@zcode/shared";

export const CORE_USER_ACTION_FEATURES = {
  "workspace.local.lifecycle": ["open", "switch", "close"],
  "workspace.remote.lifecycle": ["open_dialog", "connect", "reconnect", "disconnect"],
  "workspace.project_binding": ["attach", "detach", "work_outside_project"],
  "task.lifecycle": ["create", "open", "archive", "rename", "delete"],
  "task.layout": ["open_split", "split_right", "split_down", "close_pane"],
  "conversation.composer.message": ["send", "stop"],
  "conversation.composer.attachment": ["add", "remove", "retry_upload"],
  "conversation.composer.config": ["change_model", "change_thought_level", "change_mode"],
  "conversation.queue.item": ["send_now", "edit", "remove", "reorder"],
  "conversation.queue.policy": [
    "resume",
    "toggle_auto_drain",
    "toggle_followup",
    "clear_and_send",
    "keep_and_send",
  ],
  "conversation.history.branch": ["retry", "edit", "fork", "rewind_files"],
  "conversation.history.feedback": ["like", "dislike", "clear_feedback", "copy"],
  "conversation.blocking.user_input": ["select_option", "submit_text", "cancel"],
  "conversation.blocking.hook": ["review", "dismiss"],
  "conversation.navigation": ["load_older", "jump_bottom", "open_turn"],
  "conversation.subagent": ["expand", "open_side_pane", "open_split"],
  "conversation.background_work": ["open", "cancel"],
  "workbench.file": ["open_tree", "refresh", "open_file", "open_preview"],
  "workbench.terminal": ["open", "close"],
  "workbench.browser": ["open", "navigate", "back", "forward", "refresh", "open_external"],
  "workbench.git": ["open", "commit", "generate_commit_message", "run_action"],
  "extension.plugin": [
    "open_store",
    "search",
    "open_detail",
    "install",
    "enable",
    "disable",
    "update",
    "uninstall",
    "save_config",
  ],
  "extension.mcp": ["authorize", "refresh", "enable", "disable"],
  "automation.lifecycle": [
    "create",
    "update",
    "run_now",
    "enable",
    "disable",
    "pause",
    "resume",
    "delete",
  ],
} as const;

export const SETTINGS_USER_ACTION_FEATURES = {
  "settings.navigation": ["open_section", "back_to_workspace", "open_onboarding"],
  "settings.locale": ["change_locale"],
  "settings.appearance": [
    "change_theme",
    "change_ui_font_size",
    "change_code_light_theme",
    "change_code_dark_theme",
    "toggle_code_line_numbers",
    "toggle_code_line_wrap",
    "change_code_font_size",
  ],
  "settings.terminal": ["toggle_system_profile", "save_font_family", "change_shell"],
  "settings.search": ["toggle_native_search"],
  "settings.network": ["save_http_proxy", "save_no_proxy", "save_ca_certificate"],
  "settings.desktop": ["toggle_hardware_acceleration", "toggle_close_to_tray", "toggle_keep_awake"],
  "settings.update": ["toggle_preview_updates", "toggle_auto_update"],
  "settings.notification": [
    "toggle_notification",
    "toggle_notification_sound",
    "toggle_mobile_push",
  ],
  "settings.conversation": [
    "change_interaction_behavior",
    "toggle_ask_user_auto_resolution",
    "toggle_model_io_retention",
    "toggle_show_reasoning",
    "toggle_show_todos",
  ],
  "settings.task": ["toggle_auto_archive", "change_auto_archive_days"],
  "settings.storage": ["change_data_directory"],
  "settings.memory": ["toggle_memory", "refresh_memory", "change_memory_scope"],
  "settings.browser": [
    "toggle_browser_use",
    "import_browser_data",
    "toggle_insecure_certificates",
    "clear_cache",
    "clear_all_data",
  ],
} as const;

export type CoreUserActionFeatureId = keyof typeof CORE_USER_ACTION_FEATURES;
export type SettingsUserActionFeatureId = keyof typeof SETTINGS_USER_ACTION_FEATURES;
export type UserActionFeatureId = CoreUserActionFeatureId | SettingsUserActionFeatureId;

type CatalogDefinition = Readonly<Record<string, readonly string[]>>;
export type UserActionOperationKind =
  | "navigation"
  | "preference"
  | "command"
  | "management"
  | "destructive";

export interface UserActionCatalogEntry {
  featureId: UserActionFeatureId;
  action: string;
  group: Extract<RendererActionTraceGroup, "core" | "settings">;
  operationKind: UserActionOperationKind;
  surface: string;
  timeoutMs: number;
}

function operationKindFor(featureId: string, action: string): UserActionOperationKind {
  if (action === "clear_all_data" || action === "delete" || action === "uninstall") {
    return "destructive";
  }
  if (
    featureId.endsWith("navigation") ||
    ["open", "open_dialog", "open_detail", "open_node", "open_section", "open_store"].includes(
      action,
    )
  ) {
    return "navigation";
  }
  if (
    featureId.startsWith("settings.") &&
    !["refresh_memory", "import_browser_data", "clear_cache"].includes(action)
  ) {
    return "preference";
  }
  if (featureId.startsWith("conversation.") || featureId.startsWith("task.")) {
    return "command";
  }
  return "management";
}

function entriesFrom(
  definitions: CatalogDefinition,
  group: "core" | "settings",
): UserActionCatalogEntry[] {
  return Object.entries(definitions).flatMap(([featureId, actions]) =>
    actions.map((action) => ({
      featureId: featureId as UserActionFeatureId,
      action,
      group,
      operationKind: operationKindFor(featureId, action),
      surface: featureId,
      timeoutMs: 30_000,
    })),
  );
}

export const USER_ACTION_CATALOG: readonly UserActionCatalogEntry[] = [
  ...entriesFrom(CORE_USER_ACTION_FEATURES, "core"),
  ...entriesFrom(SETTINGS_USER_ACTION_FEATURES, "settings"),
];

const USER_ACTION_CATALOG_BY_KEY = new Map(
  USER_ACTION_CATALOG.map((entry) => [`${entry.featureId}:${entry.action}`, entry]),
);

export function resolveUserActionCatalogEntry(
  featureId: string,
  action: string,
): UserActionCatalogEntry | undefined {
  return USER_ACTION_CATALOG_BY_KEY.get(`${featureId}:${action}`);
}
