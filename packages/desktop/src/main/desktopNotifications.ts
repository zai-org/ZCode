import { app, BrowserWindow, Notification } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TaskNotificationPayload } from "@zcode/shared";
import {
  extensionNotificationPayloadSchema,
  type ExtensionNotificationClick,
  type NotificationsShowResult,
} from "@zcode/shared/extension-host";
import { formatZodError, PlatformChannels, taskNotificationPayloadSchema } from "@zcode/shared";

const TASK_NOTIFICATION_DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_TASK_NOTIFICATIONS = 100;
const recentTaskNotificationTimestamps = new Map<string, number>();
const activeTaskNotifications = new Set<Notification>();

function isAnyAppWindowFocused() {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function shouldSuppressDuplicateTaskNotification(
  taskId: string,
  status: TaskNotificationPayload["status"],
  requestId?: string,
) {
  const now = Date.now();

  for (const [key, timestamp] of recentTaskNotificationTimestamps) {
    if (now - timestamp > TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentTaskNotificationTimestamps.delete(key);
    }
  }

  // elicitation_request 和 permission_request 一样代表一次具体的人机阻塞请求。
  // 如果仍按 taskId 去重，同一任务连续 AskUserQuestion/计划确认会在 3 秒内漏掉第二条通知。
  const dedupeTarget =
    status === "permission_request" || status === "elicitation_request"
      ? requestId?.trim() || taskId
      : taskId;
  const dedupeKey = `${status}:${dedupeTarget}`;
  const lastTimestamp = recentTaskNotificationTimestamps.get(dedupeKey);
  if (lastTimestamp != null && now - lastTimestamp < TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentTaskNotificationTimestamps.set(dedupeKey, now);
  return false;
}

function retainTaskNotification(notification: Notification) {
  activeTaskNotifications.add(notification);

  if (activeTaskNotifications.size <= MAX_ACTIVE_TASK_NOTIFICATIONS) {
    return;
  }

  const oldestNotification = activeTaskNotifications.values().next().value;
  if (oldestNotification) {
    activeTaskNotifications.delete(oldestNotification);
  }
}

function releaseTaskNotification(notification: Notification) {
  activeTaskNotifications.delete(notification);
}

export function getActiveTaskNotificationCountForTest() {
  return activeTaskNotifications.size;
}

export function resetActiveTaskNotificationsForTest() {
  activeTaskNotifications.clear();
  recentTaskNotificationTimestamps.clear();
}

export function focusTaskNotificationWindow(senderWindow: BrowserWindow) {
  if (senderWindow.isMinimized()) {
    senderWindow.restore();
  }

  if (!senderWindow.isVisible()) {
    senderWindow.show();
  }

  // macOS 点通知时如果窗口曾被隐藏/最小化，必须先恢复窗口，再激活 app，
  // 最后聚焦 BrowserWindow；否则 app.focus 抢到前台时没有可显示窗口，后续 focus 可能被系统忽略。
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }

  senderWindow.focus();
}

export function dispatchTaskNotification(options: {
  event: IpcMainEvent | IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): boolean {
  const result = taskNotificationPayloadSchema.safeParse(options.payload);
  if (!result.success) {
    options.logger.warn("[show-task-notification] invalid payload:", formatZodError(result.error));
    return false;
  }

  if (!Notification.isSupported()) {
    options.logger.warn("[show-task-notification] notification is not supported on this platform");
    return false;
  }

  if (isAnyAppWindowFocused()) {
    return false;
  }

  const { taskId, status, requestId, title, body } = result.data;
  const notificationTitle = title.trim();
  const notificationBody = body.trim();
  if (!notificationTitle || !notificationBody) {
    // main process 没有 renderer 当前语言上下文，不能在这里兜底生成中文通知文案。
    // 通知文案必须由 renderer 侧按 i18n 生成后传入；缺失时直接拒绝展示，避免英文界面弹出中文硬编码。
    options.logger.warn("[show-task-notification] missing localized notification copy", {
      taskId,
      status,
      hasTitle: Boolean(notificationTitle),
      hasBody: Boolean(notificationBody),
    });
    return false;
  }

  if (shouldSuppressDuplicateTaskNotification(taskId, status, requestId)) {
    return false;
  }

  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    silent: true,
  });

  // Electron 原生 Notification 如果只存在于函数局部变量里，系统通知仍能显示，
  // 但主进程 JS 对象可能在用户点击前被回收，导致 click listener 丢失。
  // 这里显式持有对象，等点击/关闭后释放，保证“有通知”与“点击可唤起”属于同一生命周期。
  retainTaskNotification(notification);

  notification.once("click", () => {
    releaseTaskNotification(notification);

    if (!senderWindow || senderWindow.isDestroyed()) {
      options.logger.warn("[show-task-notification] click ignored: sender window is gone", {
        taskId,
      });
      return;
    }

    focusTaskNotificationWindow(senderWindow);
    senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId);
    options.logger.info("[show-task-notification] notification click handled", {
      taskId,
      windowId: senderWindow.id,
    });
  });
  notification.once("close", () => {
    releaseTaskNotification(notification);
  });

  notification.show();
  options.event.sender.send(PlatformChannels.TaskNotificationSound);
  return true;
}

/**
 * 扩展的系统通知（docs/plugins/extension-host.md §18.1 H8）。Window Host 已查过档位、详情页开关与限额，
 * Renderer 已查过设置页的系统通知开关并给标题加了插件名前缀。这里只做 Main 才知道的判断：
 * 任何窗口有焦点时不弹（focused），平台不支持时不弹（unsupported）。不允许插件自定义图标、声音或按钮：
 * 用默认图标、silent，也不发任务通知的提示音。点击时恢复并聚焦发出请求的窗口，把视图发回给它打开。
 * 日志只记插件 id 与结果，不记标题与正文。
 */
export function dispatchExtensionNotification(options: {
  event: IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): NotificationsShowResult {
  const parsed = extensionNotificationPayloadSchema.safeParse(options.payload);
  if (!parsed.success) {
    options.logger.warn(
      "[show-extension-notification] invalid payload:",
      formatZodError(parsed.error),
    );
    return { shown: false, reason: "unsupported" };
  }
  const { pluginId, title, body, viewId } = parsed.data;
  if (!Notification.isSupported()) {
    options.logger.info("[show-extension-notification] skipped", {
      pluginId,
      reason: "unsupported",
    });
    return { shown: false, reason: "unsupported" };
  }
  if (isAnyAppWindowFocused()) {
    options.logger.info("[show-extension-notification] skipped", { pluginId, reason: "focused" });
    return { shown: false, reason: "focused" };
  }
  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  const notification = new Notification({ title, body, silent: true });
  // 与任务通知相同：显式持有对象，避免用户点击前被回收、click 监听丢失。
  retainTaskNotification(notification);
  notification.once("click", () => {
    releaseTaskNotification(notification);
    if (!senderWindow || senderWindow.isDestroyed()) {
      options.logger.warn("[show-extension-notification] click ignored: window is gone", {
        pluginId,
      });
      return;
    }
    focusTaskNotificationWindow(senderWindow);
    const click: ExtensionNotificationClick = { pluginId, ...(viewId ? { viewId } : {}) };
    senderWindow.webContents.send(PlatformChannels.ExtensionNotificationClick, click);
    options.logger.info("[show-extension-notification] click handled", {
      pluginId,
      view: Boolean(viewId),
    });
  });
  notification.once("close", () => releaseTaskNotification(notification));
  notification.show();
  options.logger.info("[show-extension-notification] shown", { pluginId, view: Boolean(viewId) });
  return { shown: true };
}
