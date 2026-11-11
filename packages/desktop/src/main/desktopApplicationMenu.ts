import { app, BrowserWindow, Menu } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isValidShortcutBinding,
  resolveLocaleFromLanguageTag,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import { CHECK_FOR_UPDATE_MENU_ID, setAutoUpdaterMenuLocale } from "./autoUpdater.js";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
} from "./desktopZoom.js";
import {
  HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
  HELP_TOGGLE_DEV_TOOLS_MENU_ID,
} from "./desktopCommandHandlers.js";

export const HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID = "help.zcode-endpoint.production";
export const HELP_ZCODE_ENDPOINT_TEST_MENU_ID = "help.zcode-endpoint.test";

export function getDesktopMenuLabel(
  locale: Locale,
  id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds],
) {
  return getDesktopMenuMessage(locale, id);
}

export function resolveSystemApplicationLocale(): Locale {
  // macOS 系统语言为中文时，Electron app.getLocale() 仍可能返回 en-US；
  // 优先读取系统首选语言列表，避免 System default 被误解析成英文。
  const systemLocale = app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
  // 「跟随系统」映射：zh*/ja*/ru*/ko* 到对应界面语言，其它走 en-US。
  return resolveLocaleFromLanguageTag(systemLocale);
}

export function updateZCodeStdioTapDevMenuState() {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID);
  if (!item) {
    return;
  }
  const state = readZCodeStdioTapDevState();
  item.checked = state.enabled;
  item.visible = state.visible;
}

/** 菜单通道命令的快捷键共享 options 类型（shortcutBindings 为 setting.json 里的用户覆盖）。 */
interface ApplicationMenuShortcutOptions {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * 从用户覆盖解析菜单 accelerator：显式空数组 = 抢绑后的「未设置」（无 accelerator）；
 * 覆盖全部非法时回退硬编码默认值（与 renderer 生效表语义一致）。
 * main 进程只需要"命令 → accelerator 字符串"，完整生效表语义在 ui 快捷键内核。
 * 录制态返回 undefined（菜单项不带 accelerator，仍可点击），防止录制按键触发原命令。
 */
function resolveMenuAccelerator(
  options: ApplicationMenuShortcutOptions & { disableShortcutAccelerators?: boolean },
  commandId: string,
  fallback: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  // `?.find(isValid) ?? fallback` 会把「显式空数组 = 未设置」和
  // 「全部非法 = 回退默认」压成同一条路径，抢绑后被抢命令的默认 accelerator 复活，
  // 同键双动作且与「被抢命令变未设置」的 UI 承诺矛盾。
  const overrideList = options?.shortcutBindings?.[commandId];
  if (overrideList !== undefined) {
    if (overrideList.length === 0) {
      return undefined;
    }
    return overrideList.find((binding) => isValidShortcutBinding(binding)) ?? fallback;
  }
  return fallback;
}

function buildApplicationMenuTemplate(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** 快捷键设置页录制态：true 时摘掉全部可配置 accelerator */
  disableShortcutAccelerators?: boolean;
}): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuLabel(options.currentApplicationLocale, id);
  const getAppLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getLabel(id).replaceAll("{appName}", app.name);
  const stdioTapState = readZCodeStdioTapDevState();
  const isLocalDevelopmentRuntime = !app.isPackaged;
  const currentZoomLevel = clampDesktopZoomLevel(options.currentZoomLevel ?? 0);
  const canResetZoom = currentZoomLevel !== 0;
  const canZoomIn = currentZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = currentZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // zoomIn 主绑定含 "=" 时保留 Plus 可见 + "=" 隐藏的双条目（Plus 在菜单显示更好，"=" 兜底 Windows 无 Shift 直按）。
  // 录制态 accelerator 为 undefined（摘掉键位，菜单项保留可点击）。
  const zoomInBinding = resolveMenuAccelerator(options, "zoomIn", "CmdOrCtrl+=");
  const zoomInVisibleAccelerator = zoomInBinding?.replace("=", "Plus");

  return [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              // 更新入口跟随产品身份：Preview 禁用更新器，生产后端的 Preview 也不例外。
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.appServices),
                role: "services" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appHide),
                role: "hide" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appHideOthers),
                role: "hideOthers" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appShowAll),
                role: "unhide" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appQuit),
                role: "quit" as const,
              },
            ],
          },
        ]
      : []),
    {
      label: getLabel(desktopMenuMessageIds.file),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          accelerator: resolveMenuAccelerator(options, "newTask", "CmdOrCtrl+N"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          accelerator: resolveMenuAccelerator(options, "openWorkspace", "CmdOrCtrl+O"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.fileCloseWindow),
          accelerator: resolveMenuAccelerator(options, "closeActiveContext", "CmdOrCtrl+W"),
          // Electron 的 close role 会在 main 进程直接关闭窗口，renderer 没机会判断
          // 右侧 side pane 是否有 active tab。这里改为业务命令，让快捷键先进入 workspace 状态机。
          click: () => void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.edit),
      // 顶层使用 Electron 的 editMenu/windowMenu role 会按系统/Electron locale 生成文案，
      // 和应用内 currentApplicationLocale 混用后出现“文件 Edit 视图 Window 帮助”的中英混排。
      submenu: [
        { label: getLabel(desktopMenuMessageIds.editUndo), role: "undo" as const },
        { label: getLabel(desktopMenuMessageIds.editRedo), role: "redo" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editCut), role: "cut" as const },
        { label: getLabel(desktopMenuMessageIds.editCopy), role: "copy" as const },
        { label: getLabel(desktopMenuMessageIds.editPaste), role: "paste" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editSelectAll), role: "selectAll" as const },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.view),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.viewToggleFullScreen),
          role: "togglefullscreen" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleFullScreen),
        },
        { type: "separator" as const },
        // zoom 命令的 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）。
        {
          label: getLabel(desktopMenuMessageIds.viewZoomIn),
          accelerator: zoomInVisibleAccelerator,
          enabled: canZoomIn,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
        },
        ...(zoomInVisibleAccelerator !== undefined && zoomInVisibleAccelerator !== zoomInBinding
          ? [
              {
                label: getLabel(desktopMenuMessageIds.viewZoomIn),
                accelerator: zoomInBinding,
                visible: false,
                enabled: canZoomIn,
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.viewZoomOut),
          accelerator: resolveMenuAccelerator(options, "zoomOut", "CmdOrCtrl+-"),
          enabled: canZoomOut,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomOut),
        },
        {
          label: getLabel(desktopMenuMessageIds.viewActualSize),
          accelerator: resolveMenuAccelerator(options, "resetZoom", "CmdOrCtrl+0"),
          enabled: canResetZoom,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ResetZoom),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.window),
      submenu: [
        { label: getLabel(desktopMenuMessageIds.windowMinimize), role: "minimize" as const },
        ...(process.platform === "darwin"
          ? [
              { label: getLabel(desktopMenuMessageIds.windowZoom), role: "zoom" as const },
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.windowBringAllToFront),
                role: "front" as const,
              },
            ]
          : []),
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.help),
      submenu: [
        ...(process.platform !== "darwin"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpWhatsNew),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenChangelog),
        },
        { type: "separator" as const },
        ...(isLocalDevelopmentRuntime && stdioTapState.visible
          ? [
              {
                id: HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
                label: getLabel(desktopMenuMessageIds.helpToggleZCodeStdioTap),
                type: "checkbox" as const,
                checked: stdioTapState.enabled,
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy),
              },
              { type: "separator" as const },
            ]
          : []),
        ...(ZCODE_ENV === "test"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpZCodeEndpoint),
                submenu: [
                  {
                    id: HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointProduction),
                    type: "radio" as const,
                    checked: (options.zcodeEndpointSelection ?? "production") === "production",
                    click: () =>
                      void options.executeDesktopCommand(
                        DesktopCommandIds.SetZCodeEndpointProduction,
                      ),
                  },
                  {
                    id: HELP_ZCODE_ENDPOINT_TEST_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointTest),
                    type: "radio" as const,
                    checked: options.zcodeEndpointSelection === "test",
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointTest),
                  },
                  { type: "separator" as const },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointCustom),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointCustom),
                  },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointReset),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.ResetZCodeEndpoint),
                  },
                ],
              },
              { type: "separator" as const },
            ]
          : []),
        {
          id: HELP_TOGGLE_DEV_TOOLS_MENU_ID,
          label: getLabel(desktopMenuMessageIds.helpToggleDevTools),
          role: "toggleDevTools" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleDevTools),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpResourceManager),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpFeedback),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ClearAllData),
        },
      ],
    },
  ];
}

export function rebuildApplicationMenu(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** 快捷键设置页录制态：true 时摘掉全部可配置 accelerator */
  disableShortcutAccelerators?: boolean;
}) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        currentApplicationLocale: options.currentApplicationLocale,
        zcodeEndpointSelection: options.zcodeEndpointSelection,
        executeDesktopCommand: options.executeDesktopCommand,
        currentZoomLevel: options.currentZoomLevel,
        shortcutBindings: options.shortcutBindings,
        disableShortcutAccelerators: options.disableShortcutAccelerators,
      }),
    ),
  );
  setAutoUpdaterMenuLocale(options.currentApplicationLocale);
  if (!app.isPackaged) {
    updateZCodeStdioTapDevMenuState();
  }
}
