/**
 * 统一管理所有 data-testid，UI 组件和 E2E 测试共用此单一来源。
 * 新增 testid 时请在此文件添加，不要在组件中硬编码字符串。
 * 并且每个都需要中文注释
 */

// Login entry
/** 右上角登录触发按钮 */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** 用户菜单中的登录操作 */
export const TID_LOGIN_MENU_ITEM = "login-menu-item";
/** 登录页切换到 API Key 登录方式按钮 */
export const TID_LOGIN_USE_API_KEY_BUTTON = "login-use-api-key-button";
/** 登录页国内/海外登录区域切换按钮 */
export const TID_LOGIN_REGION_SWITCH = "login-region-switch";
/** API Key 登录 provider 选择触发器 */
export const TID_LOGIN_API_KEY_PROVIDER_TRIGGER = "login-api-key-provider-trigger";
/** API Key 登录 provider 选择项（动态后缀为 provider choice） */
export const TID_LOGIN_API_KEY_PROVIDER_ITEM = "login-api-key-provider-item";
/** API Key 登录密钥输入框 */
export const TID_LOGIN_API_KEY_INPUT = "login-api-key-input";
/** API Key 登录继续按钮 */
export const TID_LOGIN_API_KEY_CONTINUE_BUTTON = "login-api-key-continue-button";
/** API Key 登录取消按钮 */
export const TID_LOGIN_API_KEY_CANCEL_BUTTON = "login-api-key-cancel-button";
/** API Key 登录暂时跳过按钮 */
export const TID_LOGIN_API_KEY_SKIP_BUTTON = "login-api-key-skip-button";
/** API Key 登录错误提示 */
export const TID_LOGIN_API_KEY_ERROR = "login-api-key-error";
/** OAuth 弹窗内的登录按钮 */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
/** OAuth 弹窗取消按钮 */
export const TID_OAUTH_CANCEL = "oauth-cancel";
/** OAuth 等待态复制登录链接按钮 */
export const TID_OAUTH_COPY_LOGIN_LINK = "oauth-copy-login-link";
/** OAuth 错误提示文本 */
export const TID_OAUTH_ERROR = "oauth-error";

// App
/** 顶部导航栏 */
export const TID_APP_HEADER = "app-header";
/** 语言切换按钮 */
export const TID_LOCALE_TOGGLE = "locale-toggle";
/** 主题切换按钮 */
export const TID_THEME_TOGGLE = "theme-toggle";
/** 退出登录按钮 */
export const TID_LOGOUT_BUTTON = "logout-button";
/** 终端显隐切换按钮 */
export const TID_TERMINAL_TOGGLE = "terminal-toggle";
export const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";
/** Side Pane 完整视图：进入/退出按钮、对话 tab、对话宿主与浮窗各部件 */
export const TID_SIDE_PANE_FULL_VIEW_TOGGLE = "side-pane-full-view-toggle";
export const TID_SIDE_PANE_FULL_VIEW_CONVERSATION_TAB = "side-pane-full-view-conversation-tab";
export const TID_SIDE_PANE_FULL_VIEW_HOST = "side-pane-full-view-host";
export const TID_SIDE_PANE_FULL_VIEW_HEADER = "side-pane-full-view-floating-header";
export const TID_SIDE_PANE_FULL_VIEW_DRAWER = "side-pane-full-view-floating-drawer";
export const TID_SIDE_PANE_FULL_VIEW_EXPAND = "side-pane-full-view-floating-expand";
export const TID_SIDE_PANE_FULL_VIEW_RUNNING = "side-pane-full-view-floating-running";
export const TID_SIDE_PANE_FULL_VIEW_MINIMIZE = "side-pane-full-view-floating-minimize";
export const TID_SIDE_PANE_FULL_VIEW_HANDLE = "side-pane-full-view-floating-handle";
export const TID_SIDE_PANE_FULL_VIEW_BUBBLE = "side-pane-full-view-floating-bubble";
export const TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE = "side-pane-full-view-answer-bubble";
export const TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE =
  "side-pane-full-view-answer-bubble-close";
export const TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION =
  "side-pane-full-view-menu-open-conversation";
export const TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE = "side-pane-full-view-menu-minimize";
/** 终端面板关闭按钮 */
export const TID_TERMINAL_CLOSE_BUTTON = "terminal-close-button";
/** 浏览器显隐切换按钮 */
export const TID_BROWSER_TOGGLE = "browser-toggle";
/** Git 显隐切换按钮 */
export const TID_GIT_TOGGLE = "git-toggle";
/** 浏览器面板容器 */
export const TID_BROWSER_PANE = "browser-pane";
/** 浏览器面板关闭按钮 */
export const TID_BROWSER_CLOSE_BUTTON = "browser-close-button";
/** Git 面板容器 */
export const TID_GIT_PANE = "git-pane";
/** Git 面板关闭按钮 */
export const TID_GIT_CLOSE_BUTTON = "git-close-button";
/** 顶部 Git 提交或推送主入口 */
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
/** Git 提交弹窗 */
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
/** Git 提交信息输入框 */
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
/** Git 提交信息生成按钮 */
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
/** Git 提交弹窗包含未暂存更改开关 */
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
/** Git 提交弹窗底部 Command 动作列表 */
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
/** Git 提交弹窗底部动作项（动态后缀为动作 id） */
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
/** 浏览器地址栏输入框 */
export const TID_BROWSER_ADDRESS_INPUT = "browser-address-input";
/** 浏览器后退按钮 */
export const TID_BROWSER_BACK_BUTTON = "browser-back-button";
/** 浏览器前进按钮 */
export const TID_BROWSER_FORWARD_BUTTON = "browser-forward-button";
/** 浏览器刷新按钮 */
export const TID_BROWSER_REFRESH_BUTTON = "browser-refresh-button";
/** 浏览器自由尺寸模式按钮 */
export const TID_BROWSER_RESPONSIVE_BUTTON = "browser-responsive-button";
/** 浏览器自由尺寸视口 */
export const TID_BROWSER_RESPONSIVE_VIEWPORT = "browser-responsive-viewport";
/** 浏览器自由尺寸顶部控制条 */
export const TID_BROWSER_RESPONSIVE_TOOLBAR = "browser-responsive-toolbar";
/** 浏览器自由尺寸宽度输入框 */
export const TID_BROWSER_RESPONSIVE_WIDTH_INPUT = "browser-responsive-width-input";
/** 浏览器自由尺寸高度输入框 */
export const TID_BROWSER_RESPONSIVE_HEIGHT_INPUT = "browser-responsive-height-input";
/** 浏览器自由尺寸缩放选择器 */
export const TID_BROWSER_RESPONSIVE_ZOOM_SELECT = "browser-responsive-zoom-select";
export const TID_BROWSER_RESPONSIVE_PRESET_SELECT = "browser-responsive-preset-select";
export const TID_BROWSER_RESPONSIVE_PRESET_OPTION = "browser-responsive-preset-option";
/** 浏览器自由尺寸缩放选项（动态后缀为 zoom 值） */
export const TID_BROWSER_RESPONSIVE_ZOOM_OPTION = "browser-responsive-zoom-option";
/** 浏览器自由尺寸缩放后的画布占位 */
export const TID_BROWSER_RESPONSIVE_SCALED_FRAME = "browser-responsive-scaled-frame";
/** 浏览器自由尺寸左边拖拽条 */
export const TID_BROWSER_RESPONSIVE_RESIZE_LEFT = "browser-responsive-resize-left";
/** 浏览器自由尺寸右边拖拽条 */
export const TID_BROWSER_RESPONSIVE_RESIZE_WIDTH = "browser-responsive-resize-width";
/** 浏览器自由尺寸上边拖拽条 */
export const TID_BROWSER_RESPONSIVE_RESIZE_TOP = "browser-responsive-resize-top";
/** 浏览器自由尺寸下边拖拽条 */
export const TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT = "browser-responsive-resize-height";
/** 浏览器自由尺寸左上角拖拽区 */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT =
  "browser-responsive-resize-corner-top-left";
/** 浏览器自由尺寸右上角拖拽区 */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT =
  "browser-responsive-resize-corner-top-right";
/** 浏览器自由尺寸左下角拖拽区 */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT =
  "browser-responsive-resize-corner-bottom-left";
/** 浏览器自由尺寸右下角拖拽区 */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER = "browser-responsive-resize-corner";
/** 浏览器网页元素选择按钮 */
export const TID_BROWSER_ELEMENT_PICKER_BUTTON = "browser-element-picker-button";
/** 浏览器地址栏更多操作按钮 */
export const TID_BROWSER_MORE_BUTTON = "browser-more-button";
/** 浏览器在默认浏览器中打开菜单项 */
export const TID_BROWSER_OPEN_EXTERNAL_ITEM = "browser-open-external-item";
/** 浏览器打开调试工具按钮 */
export const TID_BROWSER_DEVTOOLS_BUTTON = "browser-devtools-button";
export const TID_BROWSER_EXPORT_PNG_ITEM = "browser-export-png-item";
export const TID_BROWSER_EXPORT_PDF_ITEM = "browser-export-pdf-item";
export const TID_BROWSER_SITE_SETTINGS_ITEM = "browser-site-settings-item";
/** 浏览器设计模式（docs/browser-use/2026-11-03-browser-design-mode-spec.md） */
export const TID_BROWSER_DESIGN_TOOLBAR = "browser-design-toolbar";
export const TID_BROWSER_DESIGN_PANEL_BUTTON = "browser-design-panel-button";
export const TID_BROWSER_DESIGN_VARIANT_SELECT = "browser-design-variant-select";
export const TID_BROWSER_DESIGN_VARIANT_OPTION = "browser-design-variant-option";
export const TID_BROWSER_DESIGN_SLIDE_PREV = "browser-design-slide-prev";
export const TID_BROWSER_DESIGN_SLIDE_NEXT = "browser-design-slide-next";
export const TID_BROWSER_DESIGN_SLIDE_COUNTER = "browser-design-slide-counter";
/** 画布右侧的属性面板；字段带 data-design-field（元素属性）或 data-design-variable（页面变量） */
export const TID_BROWSER_DESIGN_INSPECTOR = "browser-design-inspector";
export const TID_BROWSER_DESIGN_INSPECTOR_CLOSE = "browser-design-inspector-close";
export const TID_BROWSER_DESIGN_SELECT_PARENT = "browser-design-select-parent";
/** 面板里「写回到哪个文件 / 为什么不能写回」那一行（data-writable） */
export const TID_BROWSER_DESIGN_SOURCE_STATUS = "browser-design-source-status";
/** 输入框里的网页元素 chip（data-count 为元素数） */
export const TID_WEB_ELEMENT_CONTEXT_CHIP = "web-element-context-chip";
/** 浏览器网页视图 */
export const TID_BROWSER_WEBVIEW = "browser-webview";
/** 浏览器空白页最近访问列表 */
export const TID_BROWSER_RECENT_VISITS = "browser-recent-visits";
/** 内置浏览器权限确认条容器 */
export const TID_BROWSER_PERMISSION_PROMPTS = "browser-permission-prompts";
/** 权限确认条「仅本次允许」按钮 */
export const TID_BROWSER_PERMISSION_ALLOW_ONCE = "browser-permission-allow-once";
/** 权限确认条「访问此网站时允许」按钮 */
export const TID_BROWSER_PERMISSION_ALLOW_ALWAYS = "browser-permission-allow-always";
/** 权限确认条「不允许」按钮（本次拒绝，不记忆） */
export const TID_BROWSER_PERMISSION_DENY = "browser-permission-deny";
export const TID_BROWSER_PERMISSION_DISMISS = "browser-permission-dismiss";
/** 浏览器页面加载失败的可读错误态 */
export const TID_BROWSER_LOAD_ERROR = "browser-load-error";
/** 浏览器加载失败错误态里的证书放行指引 */
export const TID_BROWSER_LOAD_ERROR_CERT_HINT = "browser-load-error-cert-hint";
/** 预览面板容器 */
export const TID_PREVIEW_PANE = "preview-pane";
/** 预览面板关闭按钮 */
export const TID_PREVIEW_CLOSE_BUTTON = "preview-close-button";
/** 预览面板上一段按钮 */
export const TID_PREVIEW_PREV_BUTTON = "preview-prev-button";
/** 预览面板下一段按钮 */
export const TID_PREVIEW_NEXT_BUTTON = "preview-next-button";
/** 工具调用里的“查看代码”按钮 */
export const TID_TOOL_CODE_VIEWER_BUTTON = "tool-code-viewer-button";
/** 工具调用摘要行触发按钮（动态后缀为 toolId） */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

// Terminal
/** 终端容器 */
export const TID_TERMINAL = "terminal";

// SSHDialog
/** 打开 SSH 连接弹窗的触发按钮 */
export const TID_SSH_CONNECT_TRIGGER = "ssh-connect-trigger";
/** SSH 连接弹窗容器 */
export const TID_SSH_DIALOG = "ssh-dialog";
/** 远程连接方式切换到 SSH */
export const TID_REMOTE_KIND_SSH = "remote-kind-ssh";
/** 远程连接方式切换到 Server */
export const TID_REMOTE_KIND_SERVER = "remote-kind-server";
/** 远程连接方式切换到 WSL */
export const TID_REMOTE_KIND_WSL = "remote-kind-wsl";
/** 远程连接方式切换到 Docker */
export const TID_REMOTE_KIND_DOCKER = "remote-kind-docker";
/** SSH 主机地址输入框 */
export const TID_SSH_HOST_INPUT = "ssh-host-input";
/** SSH 端口号输入框 */
export const TID_SSH_PORT_INPUT = "ssh-port-input";
/** SSH 用户名输入框 */
export const TID_SSH_USERNAME_INPUT = "ssh-username-input";
/** SSH config alias 选择框 */
export const TID_SSH_CONFIG_ALIAS_SELECT = "ssh-config-alias-select";
/** 设置入口「从 SSH config 导入」按钮。 */
export const TID_SSH_CONFIG_IMPORT = "remote-ssh-config-import";
/** 已关联 SSH config Host 的标签。 */
export const TID_SSH_CONFIG_ALIAS_CHIP = "remote-ssh-config-alias-chip";
/** 新建连接表单头部的实时目标预览。 */
export const TID_REMOTE_NEW_CONNECTION_PREVIEW = "remote-new-connection-preview";
/** SSH 密码输入框 */
export const TID_SSH_PASSWORD_INPUT = "ssh-password-input";
/** SSH 私钥路径输入框 */
export const TID_SSH_PRIVATE_KEY_INPUT = "ssh-private-key-input";
/** SSH 认证方式：密码 */
export const TID_SSH_AUTH_PASSWORD = "ssh-auth-password";
/** SSH 认证方式：私钥 */
export const TID_SSH_AUTH_PRIVATE_KEY = "ssh-auth-private-key";
/** WSL 发行版选择框 */
export const TID_WSL_DISTRO_SELECT = "wsl-distro-select";
/** WSL Linux 用户输入框 */
export const TID_WSL_USER_INPUT = "wsl-user-input";
/** Docker 容器选择框 */
export const TID_DOCKER_CONTAINER_SELECT = "docker-container-select";
/** Docker 容器名称/ID 输入框 */
export const TID_DOCKER_CONTAINER_INPUT = "docker-container-input";
/** Server 远程服务 URL 输入框 */
export const TID_SERVER_URL_INPUT = "server-url-input";
/** Server 远程服务名称输入框 */
export const TID_SERVER_NAME_INPUT = "server-name-input";
/** Server 远程服务 token 输入框 */
export const TID_SERVER_TOKEN_INPUT = "server-token-input";
/** Server 远程默认工作区路径输入框 */
export const TID_SERVER_WORKSPACE_PATH_INPUT = "server-workspace-path-input";
/** SSH 连接确认按钮 */
export const TID_SSH_CONNECT_BUTTON = "ssh-connect-button";
/** SSH 弹窗取消按钮 */
export const TID_SSH_CANCEL_BUTTON = "ssh-cancel-button";

// Sidebar
/** 侧边栏容器 */
export const TID_SIDEBAR = "sidebar";
/** 项目视图里的对话二级分区 */
export const TID_CONVERSATION_SECTION = "conversation-section";
/** 项目视图里的项目二级分区 */
export const TID_PROJECT_SECTION = "project-section";
/** 项目分区新建项目按钮 */
export const TID_VIRTUAL_PROJECT_ADD = "virtual-project-add";
/** 任务分区新建任务按钮（全局新建，cwd 为默认执行目录） */
export const TID_VIRTUAL_PROJECT_NEW_TASK = "virtual-project-new-task";
/** 项目行（父级 section 带 data-project-id / data-project-name） */
export const TID_VIRTUAL_PROJECT_ROW = "virtual-project-row";
/** 项目行展开/收起触发器（aria-expanded 表示任务列表是否展开） */
export const TID_VIRTUAL_PROJECT_TOGGLE = "virtual-project-toggle";
/** 项目行折叠态未读指示 */
export const TID_VIRTUAL_PROJECT_UNREAD = "virtual-project-unread";
/** 项目行任务列表容器 */
export const TID_VIRTUAL_PROJECT_TASKS = "virtual-project-tasks";
/** 项目行 hover 操作区 */
export const TID_VIRTUAL_PROJECT_ACTIONS = "virtual-project-actions";
/** 项目行更多菜单触发器 */
export const TID_VIRTUAL_PROJECT_MENU = "virtual-project-menu";
/** 项目行打开文件树按钮（多 root 时为下拉触发器） */
export const TID_VIRTUAL_PROJECT_FILES = "virtual-project-files";
/** 项目行新建任务按钮（cwd = 项目主要目录） */
export const TID_VIRTUAL_PROJECT_CREATE_TASK = "virtual-project-create-task";
/** 项目行菜单 / 右键动作前缀，见 virtualProjectActionTestId */
export const TID_VIRTUAL_PROJECT_ACTION_PREFIX = "virtual-project";
/** 全局置顶任务区 */
export const TID_PROJECT_PINNED_TASKS = "project-pinned-tasks";
/** 远端 host 分组（data-host-id 为 host id） */
export const TID_REMOTE_PROJECT_HOST = "remote-project-host";
/** Composer workspace 选择触发器 */
export const TID_COMPOSER_WORKSPACE_TRIGGER = "composer-workspace-trigger";
/** Composer workspace 菜单的远程连接入口 */
export const TID_COMPOSER_REMOTE_CONNECTION = "composer-remote-connection";
/** Composer 当前项目解绑按钮 */
export const TID_COMPOSER_PROJECT_DETACH = "composer-project-detach";
/** Composer workspace 菜单的非项目工作入口 */
export const TID_COMPOSER_WORK_OUTSIDE_PROJECT = "composer-work-outside-project";
// ChatView
/** 聊天视图容器 */
export const TID_CHAT_VIEW = "chat-view";
/** 聊天消息列表 */
export const TID_CHAT_MESSAGES = "chat-messages";
/** 聊天输入区上方的错误横幅 */
export const TID_CHAT_ERROR_BANNER = "chat-error-banner";
/** Hook 阻断错误的详情按钮 */
export const TID_CHAT_ERROR_DETAILS_BUTTON = "chat-error-details-button";
/** Hook 阻断错误横幅左侧图标 */
export const TID_CHAT_ERROR_HOOK_ICON = "chat-error-hook-icon";
/** 聊天空状态容器 */
export const TID_CHAT_EMPTY = "chat-empty";
/** 聊天输入框 */
export const TID_CHAT_INPUT = "chat-input";
/** 聊天附件按钮 */
export const TID_CHAT_ATTACHMENT_BUTTON = "chat-attachment-button";
/** 聊天附件菜单项 */
export const TID_CHAT_ATTACHMENT_MENU_ITEM = "chat-attachment-menu-item";
/** 聊天发送按钮 */
export const TID_CHAT_SEND_BUTTON = "chat-send-button";
/** 聊天停止按钮 */
export const TID_CHAT_STOP_BUTTON = "chat-stop-button";
/** 聊天加载指示器 */
export const TID_CHAT_LOADING = "chat-loading";
/** 聊天右上角状态摘要面板 */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
/** 聊天上下文压缩 timeline 横条（动态后缀为 inputId 或 operationId） */
export const TID_CHAT_COMPACT_MARKER = "chat-compact-marker";
/** 聊天上下文压缩失败/中断后的重试按钮（动态后缀为 inputId 或 operationId） */
export const TID_CHAT_COMPACT_RETRY_BUTTON = "chat-compact-retry-button";
/** 聊天 goal verification timeline 横条（动态后缀为 targetId:goalIteration 或 verificationId） */
export const TID_CHAT_GOAL_VERIFICATION_MARKER = "chat-goal-verification-marker";
/** 聊天队列面板 */
export const TID_CHAT_QUEUE_PANEL = "chat-queue-panel";
/** 聊天队列项（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_ITEM = "chat-queue-item";
/** 聊天队列项内容（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_ITEM_CONTENT = "chat-queue-item-content";
/** 聊天队列项立即发送按钮（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_SEND_NOW_BUTTON = "chat-queue-send-now-button";
/** 聊天队列项编辑按钮（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_EDIT_BUTTON = "chat-queue-edit-button";
/** 聊天队列项编辑输入框（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_EDIT_INPUT = "chat-queue-edit-input";
/** 聊天队列项编辑保存按钮（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_EDIT_SAVE_BUTTON = "chat-queue-edit-save-button";
/** 聊天队列项编辑取消按钮（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON = "chat-queue-edit-cancel-button";
/** 聊天队列项删除按钮（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_REMOVE_BUTTON = "chat-queue-remove-button";
/** 聊天队列项拖拽手柄（动态后缀为 queueItemId） */
export const TID_CHAT_QUEUE_DRAG_HANDLE = "chat-queue-drag-handle";
/** 聊天用户消息容器（动态后缀为 messageId） */
export const TID_CHAT_USER_MESSAGE = "chat-user-message";
/** 聊天助手消息容器（动态后缀为 messageId） */
export const TID_CHAT_ASSISTANT_MESSAGE = "chat-assistant-message";
/** 聊天助手消息历史折叠触发器（动态后缀为 historyStateKey） */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER = "chat-assistant-history-trigger";
/** 聊天助手消息历史折叠内容（动态后缀为 historyStateKey） */
export const TID_CHAT_ASSISTANT_HISTORY_CONTENT = "chat-assistant-history-content";
/** 独立后台结果轮的任务标题（动态后缀为 turn key） */
export const TID_CHAT_BACKGROUND_RESULT_TITLE = "chat-background-result-title";
/** 聊天工具调用块容器（动态后缀为 toolCallId） */
export const TID_CHAT_TOOL_CALL_BLOCK = "chat-tool-call-block";
/** 聊天用户消息编辑按钮（动态后缀为 messageId） */
export const TID_CHAT_MESSAGE_EDIT_BUTTON = "chat-message-edit-button";
/** 聊天用户消息编辑输入框（动态后缀为 messageId） */
export const TID_CHAT_MESSAGE_EDIT_INPUT = "chat-message-edit-input";
/** 聊天用户消息编辑提交按钮（动态后缀为 messageId） */
export const TID_CHAT_MESSAGE_EDIT_SUBMIT = "chat-message-edit-submit";
/** 聊天用户消息编辑取消按钮（动态后缀为 messageId） */
export const TID_CHAT_MESSAGE_EDIT_CANCEL = "chat-message-edit-cancel";
/** 聊天助手消息 fork 按钮（动态后缀为 messageId） */
export const TID_CHAT_MESSAGE_FORK_BUTTON = "chat-message-fork-button";
/** 聊天变更摘要撤销/重新应用按钮（动态后缀为 messageId） */
export const TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON =
  "chat-change-summary-toggle-files-button";
/** 聊天输入框前缀提示面板 */
export const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
/** 聊天输入框前缀提示分组（动态后缀为分组 id） */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** 聊天输入框前缀提示选项（动态后缀为选项 id） */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** 聊天输入框前缀提示状态行（动态后缀为分组 id） */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

// TaskList
/** 任务列表容器 */
export const TID_TASK_LIST = "task-list";
/** 新建任务按钮 */
export const TID_TASK_NEW_BUTTON = "task-new-button";
/** 任务列表条目（动态后缀为 taskId） */
export const TID_TASK_ITEM = "task-item";
/** 任务列表空状态 */
export const TID_TASK_EMPTY = "task-empty";
/** 任务归档按钮（动态后缀为 taskId） */
export const TID_TASK_ARCHIVE = "task-archive";
/** 任务列表下方设置入口按钮 */
export const TID_TASK_SETTINGS_BUTTON = "task-settings-button";

// Settings
/** 设置页容器 */
export const TID_SETTINGS_PAGE = "settings-page";
/** 设置页返回工作区按钮 */
export const TID_SETTINGS_BACK_BUTTON = "settings-back-button";
/** 设置页左侧分区入口（动态后缀为 section id） */
export const TID_SETTINGS_SECTION_NAV = "settings-section-nav";
/** 个性化（用户自定义指令）编辑器 */
export const TID_SETTINGS_PERSONALIZATION_EDITOR = "settings-personalization-editor";
/** 个性化保存按钮 */
export const TID_SETTINGS_PERSONALIZATION_SAVE = "settings-personalization-save";
/** 个性化取消按钮 */
export const TID_SETTINGS_PERSONALIZATION_CANCEL = "settings-personalization-cancel";
/** 个性化内容超限提示 */
export const TID_SETTINGS_PERSONALIZATION_SIZE_HINT = "settings-personalization-size-hint";
/** 常规设置中的增强 Find/Grep 开关 */
export const TID_SETTINGS_TOOL_SEARCH_SELECT = "settings-tool-search-select";
export const TID_SETTINGS_TOOL_SEARCH_OPTION = "settings-tool-search-option";
export const TID_SETTINGS_NATIVE_SEARCH_SWITCH = "settings-native-search-switch";
/** 常规设置中的数据存储路径只读输入框 */
export const TID_SETTINGS_DATA_BASE_DIR_INPUT = "settings-data-base-dir-input";
/** 常规设置中的数据存储路径目录选择按钮 */
export const TID_SETTINGS_DATA_BASE_DIR_BROWSE = "settings-data-base-dir-browse";
/** 常规设置中的数据存储路径保存按钮 */
export const TID_SETTINGS_DATA_BASE_DIR_SAVE = "settings-data-base-dir-save";
/** 常规设置中的数据存储路径复制/待重启/失败状态 */
export const TID_SETTINGS_DATA_BASE_DIR_STATUS = "settings-data-base-dir-status";
/** 资源管理器顶部 tab（suffix=cpu|memory|storage） */
export const TID_RESOURCE_MANAGER_TAB = "resource-manager-tab";
/** 资源管理器「存储」tab：分区容器 */
export const TID_RESOURCE_MANAGER_STORAGE_SECTION = "resource-manager-storage-section";
/** 资源管理器「存储」tab：总占用数字 */
export const TID_RESOURCE_MANAGER_STORAGE_TOTAL = "resource-manager-storage-total";
/** 资源管理器「存储」tab：扫描状态（data-state=scanning|complete|cancelled|failed|idle） */
export const TID_RESOURCE_MANAGER_STORAGE_STATUS = "resource-manager-storage-status";
/** 资源管理器「存储」tab：重新计算按钮 */
export const TID_RESOURCE_MANAGER_STORAGE_RESCAN = "resource-manager-storage-rescan";
/** 资源管理器「存储」tab：磁盘卡片（suffix=卷 key 序号） */
export const TID_RESOURCE_MANAGER_STORAGE_DISK_CARD = "resource-manager-storage-disk-card";
/** 资源管理器「存储」tab：磁盘卡片里的根目录行（suffix=rootId） */
export const TID_RESOURCE_MANAGER_STORAGE_ROOT = "resource-manager-storage-root";
/** 资源管理器「存储」tab：类别行（suffix=categoryId） */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW = "resource-manager-storage-category-row";
/** 资源管理器「存储」tab：类别行大小（suffix=categoryId） */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE = "resource-manager-storage-category-size";
/** 资源管理器「存储」tab：类别清理按钮（suffix=categoryId） */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN =
  "resource-manager-storage-category-clean";
/** 资源管理器「存储」tab：类别明细视图 */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL = "resource-manager-storage-detail";
/** 资源管理器「存储」tab：明细返回按钮 */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK = "resource-manager-storage-detail-back";
/** 资源管理器「存储」tab：明细条目行 */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY = "resource-manager-storage-detail-entry";
/** 资源管理器「存储」tab：清理确认框 */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG =
  "resource-manager-storage-confirm-dialog";
/** 资源管理器「存储」tab：清理确认框确认按钮 */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT =
  "resource-manager-storage-confirm-accept";
/** 资源管理器「存储」tab：清理确认框取消按钮 */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL =
  "resource-manager-storage-confirm-cancel";
/** Memory 设置模块中的总开关 */
export const TID_SETTINGS_MEMORY_SWITCH = "settings-memory-switch";
/** Memory 设置模块刷新按钮 */
export const TID_SETTINGS_MEMORY_REFRESH = "settings-memory-refresh";
/** Memory Workspace Scope 菜单触发器 */
export const TID_SETTINGS_MEMORY_SCOPE_TRIGGER = "settings-memory-scope-trigger";
/** Memory Workspace Scope 图标 */
export const TID_SETTINGS_MEMORY_SCOPE_ICON = "settings-memory-scope-icon";
/** Memory 当前 Workspace 文件数量 */
export const TID_SETTINGS_MEMORY_COUNT = "settings-memory-count";
/** Memory 文件名搜索输入框 */
export const TID_SETTINGS_MEMORY_SEARCH_INPUT = "settings-memory-search-input";
/** Memory 文件名搜索清空按钮 */
export const TID_SETTINGS_MEMORY_SEARCH_CLEAR = "settings-memory-search-clear";
/** Memory 项目文件列表返回项目列表按钮 */
export const TID_SETTINGS_MEMORY_BACK_PROJECTS = "settings-memory-back-projects";
/** Memory 文件正文返回项目文件列表按钮 */
export const TID_SETTINGS_MEMORY_BACK_MEMORIES = "settings-memory-back-memories";
/** Memory workspace 行（动态后缀为 workspace id） */
export const TID_SETTINGS_MEMORY_WORKSPACE = "settings-memory-workspace";

/** Memory 文件行（动态后缀为文件名） */
export const TID_SETTINGS_MEMORY_FILE = "settings-memory-file";
/** Memory 文件类型图标（动态后缀为文件名） */
export const TID_SETTINGS_MEMORY_FILE_ICON = "settings-memory-file-icon";
/** Memory 文件名称（动态后缀为文件名） */
export const TID_SETTINGS_MEMORY_FILE_NAME = "settings-memory-file-name";
/** Memory 文件更新时间（动态后缀为文件名） */
export const TID_SETTINGS_MEMORY_FILE_UPDATED_AT = "settings-memory-file-updated-at";
/** Memory 文件编辑器按钮组（动态后缀为文件名） */
export const TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS = "settings-memory-file-editor-actions";
/** Memory 原始 Markdown 预览 */
export const TID_SETTINGS_MEMORY_PREVIEW = "settings-memory-preview";
/** 常规设置中的 AskUserQuestion 自动继续开关 */
export const TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH =
  "settings-ask-user-question-auto-resolution-switch";
/** 设置页通用分区的界面语言下拉触发器 */
export const TID_SETTINGS_LOCALE_SELECT_TRIGGER = "settings-locale-select-trigger";
/** 设置页通用分区的界面语言下拉项（动态后缀为 locale preference） */
export const TID_SETTINGS_LOCALE_SELECT_ITEM = "settings-locale-select-item";
/** 用户/工作区 MCP 列表行（动态后缀为 MCP runtime 名称） */
export const TID_MCP_SERVER_ROW = "mcp-server-row";
/** 插件 MCP 列表行（动态后缀为 MCP runtime 名称） */
export const TID_PLUGIN_MCP_SERVER_ROW = "plugin-mcp-server-row";
/** MCP OAuth 授权按钮（动态后缀为 MCP runtime 名称） */
export const TID_MCP_OPEN_AUTHORIZATION_BUTTON = "mcp-open-authorization-button";
/** 子智能体列表行（动态后缀为子智能体名称） */
export const TID_SUBAGENT_ROW = "subagent-row";
/** 内置子智能体模型选择控件（动态后缀为子智能体名称） */
export const TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER = "subagent-built-in-model-trigger";
/** 设置页使用统计顶层 tab（动态后缀为 usage tab id） */
export const TID_SETTINGS_USAGE_TAB = "settings-usage-tab";
/** 侧边栏头像菜单使用统计入口 */
export const TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON = "sidebar-coding-plan-usage-button";

// Model Provider Settings
/** 模型供应商顶部添加按钮 */
export const TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON = "model-provider-add-provider-button";
/** 模型供应商 Template 选择页 */
export const TID_MODEL_PROVIDER_TEMPLATE_PICKER = "model-provider-template-picker";
/** 模型供应商 Template 选择项（动态后缀为 templateId，custom 表示纯自定义） */
export const TID_MODEL_PROVIDER_TEMPLATE_ITEM = "model-provider-template-item";
/** 模型供应商 Template 选择页返回当前 Provider 详情的按钮 */
export const TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON = "model-provider-template-back-button";
/** 模型供应商左侧导航条目（动态后缀为 provider node key） */
export const TID_MODEL_PROVIDER_NAV_ITEM = "model-provider-nav-item";
/** 模型供应商连接方式下拉触发器 */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER = "model-provider-connection-mode-trigger";
/** 设置页已有 Start Plan 的数量快捷入口。 */
export const TID_MODEL_PROVIDER_START_PLAN_COUNT_SHORTCUT =
  "model-provider-start-plan-count-shortcut";
export const TID_MODEL_PROVIDER_START_PLAN_SWITCH_PREFIX =
  "model-provider-start-plan-switch-prefix";
/** 模型供应商连接方式下拉项（动态后缀为连接方式 key） */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM = "model-provider-connection-mode-item";
/** 模型供应商详情 API Key 输入框 */
export const TID_MODEL_PROVIDER_API_KEY_INPUT = "model-provider-api-key-input";
/** 模型供应商名称编辑按钮 */
export const TID_MODEL_PROVIDER_NAME_EDIT_BUTTON = "model-provider-name-edit-button";
/** 模型供应商名称编辑输入框 */
export const TID_MODEL_PROVIDER_NAME_INPUT = "model-provider-name-input";
/** 模型供应商 Base URL 输入框 */
export const TID_MODEL_PROVIDER_BASE_URL_INPUT = "model-provider-base-url-input";
/** 模型供应商 API 格式下拉触发器 */
export const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "model-provider-api-format-trigger";
/** 模型供应商 API 格式下拉项（动态后缀为 API 格式） */
export const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "model-provider-api-format-item";
/** 模型供应商模型输入框（动态后缀为模型行号） */
export const TID_MODEL_PROVIDER_MODEL_INPUT = "model-provider-model-input";
/** 模型供应商模型删除按钮（动态后缀为模型行号） */
export const TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON = "model-provider-model-delete-button";
/** 模型供应商添加模型按钮 */
export const TID_MODEL_PROVIDER_ADD_MODEL_BUTTON = "model-provider-add-model-button";

// Chat Toolbar
/** 聊天工具栏模型选择按钮 */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** 聊天工具栏模型供应商分组（动态后缀为 provider group key） */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** 聊天工具栏模型选择条目（动态后缀为模型 value） */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** 聊天工具栏思考深度选择按钮 */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER = "chat-thought-level-select-trigger";
/** 聊天工具栏思考深度选择条目（动态后缀为思考深度 value） */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM = "chat-thought-level-select-item";
/** 聊天工具栏模式选择按钮（v4 switchCollaborationMode e2e 锚点） */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** 聊天工具栏模式选择条目（动态后缀为 mode value） */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** 聊天工具栏 context 消耗按钮 */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** 思考块折叠触发按钮 */
export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
/** 思考块折叠内容容器 */
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

// Workspace
/** 主内容区 header */
export const TID_WORKSPACE_HEADER = "workspace-header";
/** 工作区标题 */
export const TID_WORKSPACE_TITLE = "workspace-title";
/** 工作区路径 */
export const TID_WORKSPACE_PATH = "workspace-path";
/** 工作区 Header 更多菜单按钮 */
export const TID_WORKSPACE_MORE_BUTTON = "workspace-more-button";
/** 右上角问号帮助菜单触发按钮 */
export const TID_WORKSPACE_HELP_MENU_TRIGGER = "workspace-help-menu-trigger";
/** 问号帮助菜单里的「资源管理器」项（仅桌面端） */
export const TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER = "workspace-help-menu-resource-manager";
/** 工作区文件树面板 */
export const TID_WORKSPACE_FILE_TREE_PANEL = "workspace-file-tree-panel";
/** 工作区文件树刷新按钮 */
export const TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON = "workspace-file-tree-refresh-button";
/** 工作区文件树条目（动态后缀为文件绝对路径） */
export const TID_WORKSPACE_FILE_TREE_ROW = "workspace-file-tree-row";
// SSH 错误提示
/** SSH 连接错误信息 */
export const TID_SSH_ERROR = "ssh-error";
/** SSH 连接成功提示 */
export const TID_SSH_SUCCESS = "ssh-success";

// V4 会话 pane（protocol-v4 竖切；定位协议带 paneId 维度：同 session 双 pane 时靠 paneId 后缀区分）
/** v4 会话 pane 容器（动态后缀为 paneId） */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 消息时间线容器 */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 投影行（动态后缀为 rowId） */
export const TID_V4_ROW = "v4-row";
/** v4 composer 工作区 Hook 待审核入口与未读点 */
export const TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER = "v4-workspace-hook-pending-trigger";
export const TID_V4_WORKSPACE_HOOK_PENDING_UNREAD = "v4-workspace-hook-pending-unread";
/** v4 工作区 Hook 待审核点击浮层 */
export const TID_V4_WORKSPACE_HOOK_PENDING_POPOVER = "v4-workspace-hook-pending-popover";
/** v4 工作区 Hook 待审核浮层「去审核」按钮 */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** v4 工作区 Hook 待审核浮层「忽略」按钮 */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 composer 工作区 MCP 待审核入口、未读点与点击浮层 */
export const TID_V4_WORKSPACE_MCP_PENDING_TRIGGER = "v4-workspace-mcp-pending-trigger";
export const TID_V4_WORKSPACE_MCP_PENDING_UNREAD = "v4-workspace-mcp-pending-unread";
export const TID_V4_WORKSPACE_MCP_PENDING_POPOVER = "v4-workspace-mcp-pending-popover";
export const TID_V4_WORKSPACE_MCP_PENDING_REVIEW = "v4-workspace-mcp-pending-review";
export const TID_V4_WORKSPACE_MCP_PENDING_DISMISS = "v4-workspace-mcp-pending-dismiss";
/** v4 composer 容器 */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 composer 文本输入 */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** v4 composer 当前会话后台任务入口 */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** v4 composer 电脑操作（CUA）常驻入口按钮 */
export const TID_V4_COMPOSER_CUA_ENTRY = "v4-composer-cua-entry";
/** v4 composer 发送按钮 */
export const TID_V4_COMPOSER_SEND = "v4-composer-send";
/** v4 composer 语音输入按钮（data-voice-state 标记 idle / requesting / recording / finishing） */
export const TID_V4_COMPOSER_VOICE_INPUT = "v4-composer-voice-input";
/** v4 composer 语音输入音量点阵（data-voice-active-dots 为当前有音量的点数） */
export const TID_V4_COMPOSER_VOICE_WAVEFORM = "v4-composer-voice-waveform";
/** v4 暂停队列发送确认：清空队列并发送 */
export const TID_V4_COMPOSER_CLEAR_QUEUE_SEND = "v4-composer-clear-queue-send";
/** v4 暂停队列发送确认：保留队列并发送 */
export const TID_V4_COMPOSER_KEEP_QUEUE_SEND = "v4-composer-keep-queue-send";
/** v4 暂停队列发送确认弹窗 */
export const TID_V4_PAUSED_QUEUE_SEND_DIALOG = "v4-paused-queue-send-dialog";
/** V4 composer 附件 chip（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT = "v4-attachment";
/** V4 composer 附件上传进度（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** V4 composer 附件上传重试（动态后缀为附件 id） */
export const TID_V4_ATTACHMENT_UPLOAD_RETRY = "v4-attachment-upload-retry";
/** v4 stop 按钮 */
export const TID_V4_STOP = "v4-stop";
/** v4 assistant 行 fork 按钮（动态后缀为 rowId） */
export const TID_V4_FORK = "v4-fork";
/** v4 fork 目的地菜单：在当前目录分叉（动态后缀为 rowId） */
export const TID_V4_FORK_HERE = "v4-fork-here";
/** v4 fork 目的地菜单：在新 worktree 中分叉（动态后缀为 rowId） */
export const TID_V4_FORK_TO_WORKTREE = "v4-fork-to-worktree";
/** 新建任务 composer 头部的 worktree 复选框 */
export const TID_WORKTREE_TOGGLE = "composer-worktree-toggle";
/** worktree 创建视图的进度卡片（data-phase = creating / starting-session / failed） */
export const TID_WORKTREE_CREATION_CARD = "worktree-creation-card";
/** 创建失败：重试 */
export const TID_WORKTREE_CREATION_RETRY = "worktree-creation-retry";
/** 创建失败：不使用 worktree */
export const TID_WORKTREE_CREATION_CONTINUE_LOCAL = "worktree-creation-continue-local";
/** 创建失败：放弃 */
export const TID_WORKTREE_CREATION_DISMISS = "worktree-creation-dismiss";
/** 会话历史中的"已创建 worktree"标记 */
export const TID_WORKTREE_CREATED_MARKER = "worktree-created-marker";
/** 侧栏中正在创建 worktree 的任务行 */
export const TID_WORKTREE_CREATING_ROW = "worktree-creating-row";
/** 侧栏任务行的 worktree 图标 */
export const TID_TASK_ROW_WORKTREE_ICON = "task-row-worktree-icon";
/** v4 assistant 行 retry 按钮（动态后缀为 rowId） */
export const TID_V4_RETRY = "v4-retry";
/** v4 assistant 行点赞按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** v4 assistant 行点踩按钮（动态后缀为 rowId） */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** v4 turn Hook 详情按钮（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** v4 turn Hook 详情 Popover（动态后缀为 product turnId） */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** v4 user 行 edit 按钮（动态后缀为 rowId） */
export const TID_V4_EDIT = "v4-edit";
/** v4 user query 编辑输入框（动态后缀为 rowId） */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** v4 user query 编辑提交按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** v4 user query 编辑取消按钮（动态后缀为 rowId） */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** v4 user query 编辑附件删除按钮（动态后缀为 rowId-index） */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit 文件冲突弹窗 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** v4 edit 文件冲突后降级为仅裁剪对话 */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/**
 * v4 composer 编辑态状态条。属性：data-edit-target-kind（userQuery|queueItem）、
 * data-edit-target-id（rowId|queueItemId）、data-edit-state（editing|invalid）、
 * data-edit-invalid-reason（notLatest|queueItemRemoved|editLockLost）
 */
export const TID_V4_COMPOSER_EDIT_BAR = "v4-composer-edit-bar";
/** v4 composer 编辑态「取消」按钮 */
export const TID_V4_COMPOSER_EDIT_CANCEL = "v4-composer-edit-cancel";
/** v4 composer 编辑态切换目标时的未保存改动确认弹窗（复用 ConfirmDialog，确认按钮为 TID_CONFIRM_DIALOG_CONFIRM） */
export const TID_V4_COMPOSER_EDIT_SWITCH_DIALOG = "v4-composer-edit-switch-dialog";
/** v4 composer 编辑提交后「是否也应用于所有排队消息」弹窗（复用 ConfirmDialog，确认 = 应用到排队消息） */
export const TID_V4_COMPOSER_EDIT_APPLY_QUEUE_DIALOG = "v4-composer-edit-apply-queue-dialog";
/** v4 被编辑 user 行的「正在下方编辑」占位（动态后缀为 rowId） */
export const TID_V4_EDIT_IN_COMPOSER_HINT = "v4-edit-in-composer-hint";
/** v4 文件摘要「撤销」因 session 锁禁用时承接 hover 提示的外层 */
export const TID_V4_FILE_SUMMARY_UNDO_LOCKED = "v4-file-summary-undo-locked";
/** v4 文件撤销弹窗「撤销文件」因 session 锁禁用时承接 hover 提示的外层 */
export const TID_V4_FILE_REWIND_CONFIRM_LOCKED = "v4-file-rewind-confirm-locked";
/** v4 queue 面板容器 */
export const TID_V4_QUEUE = "v4-queue";
/** v4 暂停队列原因/恢复提示条 */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** v4 暂停队列继续自动消费按钮 */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** v4 queue 项行内编辑输入框（动态后缀为 queueItemId） */
/** v4 queue 项（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** v4 queue 项删除按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** v4 queue 项编辑按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/**
 * v4 queue 项编辑锁占位（动态后缀为 queueItemId）。data-edit-lock-owner=self 表示本编辑器
 * 持有，显示「正在下方编辑」；other 表示其他窗口或设备持有。
 */
export const TID_V4_QUEUE_ITEM_EDIT_LOCK = "v4-queue-item-edit-lock";
/** v4 queue 项手动解除编辑锁按钮（动态后缀为 queueItemId，仅 owner=other 时出现） */
export const TID_V4_QUEUE_ITEM_RELEASE_EDIT = "v4-queue-item-release-edit";
/** v4 queue 项立即发送按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** v4 queue 项上移按钮（动态后缀为 queueItemId） */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 输入控制：queue autoDrain 开关按钮（setAutoDrain 命令） */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 输入控制：followup 路由模式开关按钮（setFollowupMode 命令） */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 会话标题显示（meta.title，空则显示占位） */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 会话重命名输入框（renameSession 命令） */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 会话重命名提交按钮（renameSession 命令） */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal 状态横幅（objective + status，sendGoalCommand/resumeGoal 效果投影） */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 会话删除按钮（deleteSession 命令；删除后回 draft） */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 后台工作面板（backgroundWorks 投影） */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 后台工作项（动态后缀为 workId） */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** v4 后台工作取消按钮（cancelBackgroundWork 命令；动态后缀为 workId） */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 模型配置显示（data-provider/data-model/data-thought，switchModelConfig 效果投影） */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply（调试表单）已退役——模型切换由 composer 工具条的
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_* 承载。
/** v4 订阅失败重连按钮 */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput 交互弹窗容器 */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput 选项按钮（动态后缀为 optionId） */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput 自由文本输入 */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** v4 时间线「回到底部」按钮（解除底部跟随后出现，虚拟滚动锚定） */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane 外壳（Layout/Focus 层包装，动态后缀为 paneId；data-focused 标记焦点 pane，分屏） */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** v4 向右拆分窗格按钮（pane header；一期为「打开分屏」，二期语义泛化为拆分） */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** v4 向下拆分窗格按钮（pane header，网格布局） */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** v4 关闭窗格按钮（非 primary pane header；一期为「关闭分屏」） */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** v4 分屏拖拽分隔条（pointer 拖动调宽；data-split-id 标记分割节点） */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** v4 pane header 的 workspace 徽标（跨 workspace pane 显示归属） */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** v4 时间线「加载更早」按钮（游标分页；窗口首行未到全序首行时出现） */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** v4 对话轮次全局导航 rail（宽屏 2+ 可导航 turn 时出现） */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 对话轮次导航项（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 对话轮次导航 HoverCard 预览（动态后缀为 render unit key） */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent 行下钻开关（动态后缀为 rowId；有 childSessionId 才可点） */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** v4 subagent 下钻迷你时间线容器（动态后缀为 childSessionId） */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** v4 subagent 下钻「在分屏打开」入口（动态后缀为 childSessionId） */
/** @deprecated subagent 详情已迁移到右侧 tabs；保留常量避免外部旧测试编译失败。 */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput 行附件列表（动态后缀为 rowId） */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";

// Plugin 商店
/** Plugin 设置页里进入插件商店的入口按钮（商店是 WorkspaceShell 主视图，不是设置页分区） */
export const TID_PLUGIN_STORE_BROWSE = "plugin-store-browse";

// Automations / 定时任务
export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** 定时 / 闲时列表共用的状态筛选胶囊行（全部 / 进行中 / 已完成 / 失败） */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// 闲时任务（off-peak，独立面）
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** 闲时卡片脚注：绑定会话标题（会话内创建）。 */
export const TID_OFFPEAK_CARD_SESSION = "offpeak-card-session";
export const TID_OFFPEAK_CARD_MENU = "offpeak-card-menu";
export const TID_OFFPEAK_EDIT_VIEW = "offpeak-edit-view";
export const TID_OFFPEAK_EDIT_SUBMIT = "offpeak-edit-submit";
export const TID_OFFPEAK_FORM_TITLE = "offpeak-form-title";
export const TID_OFFPEAK_FORM_INSTRUCTIONS = "offpeak-form-instructions";
export const TID_OFFPEAK_ACTION_PAUSE = "offpeak-action-pause";
export const TID_OFFPEAK_ACTION_CONTINUE = "offpeak-action-continue";
export const TID_OFFPEAK_ACTION_DELETE = "offpeak-action-delete";
export const TID_OFFPEAK_TAB = "offpeak-tab";
export const TID_AUTOMATION_CARD_MENU = "automation-card-menu";
export const TID_AUTOMATION_ACTION_TOGGLE = "automation-action-toggle";
export const TID_AUTOMATION_ACTION_DELETE = "automation-action-delete";
export const TID_AUTOMATION_FORM_TITLE = "automation-form-title";
export const TID_AUTOMATION_FORM_PROMPT = "automation-form-prompt";
export const TID_AUTOMATION_FORM_SUBMIT = "automation-form-submit";
export const TID_AUTOMATION_RUN_NOW = "automation-run-now";
export const TID_AUTOMATION_EDIT_BACK = "automation-edit-back";
// 调度 builder / 自定义重复 / 年度月日选择器（e2e 稳定锚点）
export const TID_AUTOMATION_FREQUENCY_SELECT = "automation-frequency-select";
export const TID_AUTOMATION_FREQUENCY_OPTION = "automation-frequency-option";
export const TID_AUTOMATION_CUSTOM_UNIT_SELECT = "automation-custom-unit-select";
export const TID_AUTOMATION_CUSTOM_UNIT_OPTION = "automation-custom-unit-option";
export const TID_AUTOMATION_CUSTOM_INTERVAL_SELECT = "automation-custom-interval-select";
export const TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT = "automation-custom-interval-increment";
export const TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT = "automation-custom-interval-decrement";
export const TID_AUTOMATION_CUSTOM_INTERVAL_OPTION = "automation-custom-interval-option";
export const TID_AUTOMATION_CUSTOM_REPEAT_EDIT = "automation-custom-repeat-edit";
export const TID_AUTOMATION_CUSTOM_CONFIRM = "automation-custom-confirm";
export const TID_AUTOMATION_YEAR_MONTHDAY = "automation-year-monthday";
export const TID_AUTOMATION_YEAR_MONTH_OPTION = "automation-year-month-option";
export const TID_AUTOMATION_YEAR_DAY_OPTION = "automation-year-day-option";
export const TID_AUTOMATION_SCHEDULE_PREVIEW = "automation-schedule-preview";
export const TID_AUTOMATION_SCHEDULE_ADD = "automation-schedule-add";
export const TID_AUTOMATION_SCHEDULE_DELETE = "automation-schedule-delete";
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";
export const TID_CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";

/** 为动态元素生成带后缀的 testid，如 file-tree-item-/home/user */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

/**
 * 项目行菜单 / 右键动作的 test id（动作 id 如 edit / pin / delete / remove-entry / create-task /
 * files-<index>）。右键菜单里 create-task 与 files-* 带 `context-` 前缀，和更多菜单区分。
 */
export function virtualProjectActionTestId(actionId: string, context = false): string {
  const scoped = context && (actionId.startsWith("files-") || actionId === "create-task");
  return `${TID_VIRTUAL_PROJECT_ACTION_PREFIX}-${scoped ? "context-" : ""}${actionId}`;
}

/** 左侧栏头像上方的可手动领取 Start Plan banner。 */
export const TID_MANUAL_CLAIM_PLAN_BANNER = "manual-claim-plan-banner";

/** 插件 UI 沙箱卡片容器与其中的 webview。 */
export const TID_PLUGIN_UI_CARD = "plugin-ui-card";
export const TID_PLUGIN_UI_OPEN_SIDE_PANE = "plugin-ui-open-side-pane";
export const TID_PLUGIN_UI_WEBVIEW = "plugin-ui-webview";
export const TID_START_PLAN_RECOMMENDATION_DIALOG = "start-plan-recommendation-dialog";

/** 用户反馈的诊断日志授权开关 */
export const TID_FEEDBACK_LOGS_OPT_IN = "feedback-logs-opt-in";

/** 扩展插槽（docs/plugins/extension-host.md §6）：输入框 composer.status 条目与启动页「扩展」分区。 */
export const TID_EXTENSION_COMPOSER_STATUS = "extension-composer-status";
export const TID_SIDE_PANE_EXTENSIONS = "side-pane-extensions";
export const TID_SIDE_PANE_EXTENSIONS_STOPPED = "side-pane-extensions-stopped";
export const TID_SIDE_PANE_EXTENSION_PROBLEM = "side-pane-extension-problem";
/** 扩展视图（docs/plugins/extension-host.md §8）：启动页的视图条目与 extension-view 标签页。 */
export const TID_SIDE_PANE_EXTENSION_VIEW_ITEM = "side-pane-extension-view-item";
export const TID_EXTENSION_VIEW = "extension-view";
/**
 * 扩展日志控制台（docs/plugins/extension-host.md §16.8）：启动页「扩展日志」一行与 extension-logs 标签页。
 * 每行带 `data-seq`、`data-level`、`data-gen`、`data-plugin-id`（扩展进程与监管器的行没有）。
 */
export const TID_SIDE_PANE_EXTENSION_LOGS_ITEM = "side-pane-extension-logs-item";
export const TID_EXTENSION_LOGS = "extension-logs";
export const TID_EXTENSION_LOGS_ROW = "extension-logs-row";
export const TID_EXTENSION_LOGS_SOURCE_FILTER = "extension-logs-source-filter";
export const TID_EXTENSION_LOGS_LEVEL_FILTER = "extension-logs-level-filter";
export const TID_EXTENSION_LOGS_AUTO_SCROLL = "extension-logs-auto-scroll";
export const TID_EXTENSION_LOGS_COPY = "extension-logs-copy";
export const TID_EXTENSION_LOGS_CLEAR = "extension-logs-clear";
/**
 * 扩展授权（docs/plugins/extension-host.md §17.7）：启动页「需要授权」一行（`data-side-pane-open-tab-item`
 * 为 `extension-grant:<pluginId>`）、授权对话框与启用确认（复用 ConfirmDialog，确认按钮为
 * TID_CONFIRM_DIALOG_CONFIRM）、插件详情页的「权限」区块（带 `data-plugin-id`、`data-grant-status`）。
 */
export const TID_SIDE_PANE_EXTENSION_GRANT = "side-pane-extension-grant";
export const TID_EXTENSION_GRANT_DIALOG = "extension-grant-dialog";
export const TID_EXTENSION_ENABLE_CONFIRM_DIALOG = "extension-enable-confirm-dialog";
/**
 * 从插件商店安装后、激活前的确认（§17.7，P3b）：启动页「需要确认」一行（`data-side-pane-open-tab-item`
 * 为 `extension-activation:<pluginId>`）与确认框（确认按钮 TID_CONFIRM_DIALOG_CONFIRM，取消即「不激活」）。
 */
export const TID_SIDE_PANE_EXTENSION_ACTIVATION = "side-pane-extension-activation";
export const TID_EXTENSION_ACTIVATION_DIALOG = "extension-activation-dialog";
export const TID_EXTENSION_PERMISSIONS = "extension-permissions";
export const TID_EXTENSION_PERMISSIONS_GRANT = "extension-permissions-grant";
export const TID_EXTENSION_PERMISSIONS_REVOKE = "extension-permissions-revoke";
/** 插件详情页「权限」区块的「系统通知」开关（§18.1 H8） */
export const TID_EXTENSION_PERMISSIONS_NOTIFICATIONS = "extension-permissions-notifications";
/** 「最近操作」的一行：`data-capability`、`data-grant`。 */
export const TID_EXTENSION_PERMISSIONS_ACTION = "extension-permissions-action";
/** 左侧主导航的 nav.primary 插槽条目（docs/plugins/extension-host.md §16.4）；`data-extension-item` 是条目全局 id。 */
export const TID_NAV_PRIMARY_ITEM = "nav-primary-slot-item";
