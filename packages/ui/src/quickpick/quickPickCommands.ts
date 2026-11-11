export type QuickPickCommandIcon =
  | "book"
  | "browser"
  | "community"
  | "diff"
  | "feedback"
  | "folder"
  | "login"
  | "logout"
  | "message"
  | "mcp"
  | "reload"
  | "logs"
  | "settings"
  | "sidebarClose"
  | "sidebarOpen"
  | "skills"
  | "themeDark"
  | "themeLight"
  | "terminal";

export type QuickPickCommandSectionId =
  | "suggested"
  | "chat"
  | "navigation"
  | "panels"
  | "configure"
  | "app";

export const QUICK_PICK_SECTION_ORDER: QuickPickCommandSectionId[] = [
  "suggested",
  "chat",
  "navigation",
  "panels",
  "configure",
  "app",
];

export interface QuickPickCommand {
  id: string;
  sectionId: QuickPickCommandSectionId;
  titleId: string;
  icon: QuickPickCommandIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface QuickPickCommandHandlers {
  createTask: () => void;
  openWorkspace: () => void;
  openSettings: () => void;
  openSkillsSettings: () => void;
  openMcpSettings: () => void;
  switchTheme: () => void;
  openFeedback: () => void | Promise<void>;
  openCommunity: () => void | Promise<void>;
  openProductDocs: () => void | Promise<void>;
  login?: () => void | Promise<void>;
  logout?: () => void | Promise<void>;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  togglePreview: () => void;
  openTerminalTab: () => void;
  openBrowserTab: () => void;
  openReviewTab: () => void;
  /** 只有桌面本机 Host 提供扩展门面时才有（docs/plugins/extension-host.md §12.1）。 */
  reloadExtensions?: () => void;
  /** 打开扩展日志标签（§16.8）：与 reloadExtensions 同一条件。 */
  openExtensionLogs?: () => void;
}

interface CreateQuickPickCommandsOptions {
  allowOpenWorkspace: boolean;
  canOpenCommunity: boolean;
  isSidebarVisible: boolean;
  isLoggedIn: boolean;
  supportsEmbeddedBrowser?: boolean;
  supportsTerminal?: boolean;
  supportsReview?: boolean;
  themeTarget: "dark" | "light";
  shortcuts: {
    newTask: string;
    openWorkspace: string;
    toggleSidebar: string;
    toggleTerminal: string;
  };
  handlers: QuickPickCommandHandlers;
}

export function createQuickPickCommands({
  allowOpenWorkspace,
  canOpenCommunity,
  isSidebarVisible,
  isLoggedIn,
  supportsEmbeddedBrowser = true,
  supportsTerminal = true,
  supportsReview = true,
  themeTarget,
  shortcuts,
  handlers,
}: CreateQuickPickCommandsOptions): QuickPickCommand[] {
  const commands: QuickPickCommand[] = [
    {
      id: "new-task",
      sectionId: "suggested",
      titleId: "quickPick.command.newTask",
      icon: "message",
      shortcut: shortcuts.newTask,
      keywords: ["new", "task", "任务", "新任务", "新建任务"],
      run: handlers.createTask,
    },
    {
      id: "open-workspace",
      sectionId: "suggested",
      titleId: "quickPick.command.openWorkspace",
      icon: "folder",
      shortcut: shortcuts.openWorkspace,
      keywords: ["open", "workspace", "folder", "project", "打开", "文件夹", "项目"],
      disabled: !allowOpenWorkspace,
      run: handlers.openWorkspace,
    },
    {
      id: "suggested-settings",
      sectionId: "suggested",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "toggle-sidebar",
      sectionId: "panels",
      titleId: "quickPick.command.toggleSidebar",
      icon: isSidebarVisible ? "sidebarClose" : "sidebarOpen",
      shortcut: shortcuts.toggleSidebar,
      keywords: ["sidebar", "left sidebar", "toggle sidebar", "侧栏", "侧边栏", "切换侧栏"],
      run: handlers.toggleSidebar,
    },
    {
      id: "toggle-terminal",
      sectionId: "panels",
      titleId: "quickPick.command.toggleTerminal",
      icon: "terminal",
      shortcut: shortcuts.toggleTerminal,
      keywords: ["terminal", "shell", "console", "终端"],
      run: handlers.toggleTerminal,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "toggle-preview",
            sectionId: "panels",
            titleId: "quickPick.command.togglePreview",
            icon: "browser",
            keywords: [
              "preview",
              "browser",
              "web",
              "show",
              "hide",
              "预览",
              "浏览器",
              "网页",
              "显示",
              "隐藏",
            ],
            run: handlers.togglePreview,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-terminal-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addTerminalTab",
      icon: "terminal",
      keywords: ["add", "terminal", "tab", "new terminal", "添加终端", "终端标签"],
      run: handlers.openTerminalTab,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "add-browser-tab",
            sectionId: "panels",
            titleId: "quickPick.command.addBrowserTab",
            icon: "browser",
            keywords: ["add", "browser", "tab", "preview", "添加浏览器", "浏览器标签"],
            run: handlers.openBrowserTab,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-review-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addReviewTab",
      icon: "diff",
      keywords: ["add", "review", "diff", "changes", "添加审查", "审查标签", "变更"],
      run: handlers.openReviewTab,
    },
    {
      id: "settings",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "switch-theme",
      sectionId: "configure",
      titleId:
        themeTarget === "dark"
          ? "quickPick.command.switchThemeToDark"
          : "quickPick.command.switchThemeToLight",
      icon: themeTarget === "dark" ? "themeDark" : "themeLight",
      keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
      run: handlers.switchTheme,
    },
    {
      id: "skills-settings",
      sectionId: "configure",
      titleId: "quickPick.command.skills",
      icon: "skills",
      keywords: ["skills", "skill", "配置", "技能"],
      run: handlers.openSkillsSettings,
    },
    {
      id: "mcp-settings",
      sectionId: "configure",
      titleId: "quickPick.command.mcpServers",
      icon: "mcp",
      keywords: ["mcp", "server", "servers", "MCP", "服务器"],
      run: handlers.openMcpSettings,
    },
  ];

  commands.push({
    id: "feedback",
    sectionId: "app",
    titleId: "quickPick.command.feedback",
    icon: "feedback",
    keywords: [
      "feedback",
      "issue",
      "support",
      "tickets",
      "问题上报",
      "问题反馈",
      "反馈",
      "我的反馈",
      "工单",
    ],
    run: handlers.openFeedback,
  });

  if (canOpenCommunity) {
    commands.push({
      id: "community",
      sectionId: "app",
      titleId: "quickPick.command.community",
      icon: "community",
      keywords: ["community", "users", "chat", "用户社群", "社群"],
      run: handlers.openCommunity,
    });
  }

  if (handlers.reloadExtensions) {
    commands.push({
      id: "reload-extensions",
      sectionId: "app",
      titleId: "quickPick.command.reloadExtensions",
      icon: "reload",
      keywords: ["extension", "extensions", "reload", "plugin", "扩展", "重新加载", "插件"],
      run: handlers.reloadExtensions,
    });
  }

  if (handlers.openExtensionLogs) {
    commands.push({
      id: "open-extension-logs",
      sectionId: "app",
      titleId: "quickPick.command.openExtensionLogs",
      icon: "logs",
      keywords: ["extension", "extensions", "logs", "console", "plugin", "扩展", "日志", "插件"],
      run: handlers.openExtensionLogs,
    });
  }

  commands.push({
    id: "product-docs",
    sectionId: "app",
    titleId: "quickPick.command.productDocs",
    icon: "book",
    keywords: ["docs", "documentation", "product docs", "文档", "产品文档"],
    run: handlers.openProductDocs,
  });

  if (isLoggedIn && handlers.logout) {
    commands.push({
      id: "logout",
      sectionId: "app",
      titleId: "quickPick.command.logout",
      icon: "logout",
      keywords: ["disconnect", "logout", "sign out", "断开连接", "登出"],
      run: handlers.logout,
    });
  } else if (!isLoggedIn && handlers.login) {
    commands.push({
      id: "login",
      sectionId: "app",
      titleId: "quickPick.command.login",
      icon: "login",
      // 命令面板的账号动作对用户表达为“连接/断开连接”，搜索词也要同步。
      keywords: ["connect", "login", "sign in", "连接", "登录"],
      run: handlers.login,
    });
  }

  return commands.filter(
    (command) =>
      (supportsTerminal ||
        (command.id !== "toggle-terminal" && command.id !== "add-terminal-tab")) &&
      (supportsReview || command.id !== "add-review-tab"),
  );
}
