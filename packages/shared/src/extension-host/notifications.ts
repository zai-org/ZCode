import { z } from "zod";
import { extensionLocalIdSchema } from "#src/extension-host/manifest.js";

// 能力 notifications.show（docs/plugins/extension-host.md §18.1 H8）：插件请宿主弹系统通知。
// 不弹不是错误：返回 shown: false 与原因。标题由宿主加插件名前缀；不允许自定义图标、声音、按钮或回复框。

export const NOTIFICATION_TITLE_MAX_LENGTH = 64;
export const NOTIFICATION_BODY_MAX_LENGTH = 240;
/** 限额：每插件 60 秒内 1 条、本机日期同一天 20 条，只计真正弹出的。 */
export const NOTIFICATION_MIN_INTERVAL_MS = 60_000;
export const NOTIFICATION_DAILY_LIMIT = 20;

export const notificationsShowInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX_LENGTH),
  body: z.string().trim().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
  /** 点击后打开的视图：本插件清单声明的视图本地 id。没有时只聚焦窗口。 */
  target: z.strictObject({ view: extensionLocalIdSchema }).optional(),
});
export type NotificationsShowInput = z.infer<typeof notificationsShowInputSchema>;

/**
 * 不弹的原因：muted 详情页开关关了；rate-limited 超过限额；disabled 设置页的系统通知开关关了；
 * focused 窗口在前台；unsupported 平台不能弹（Web、手机远控、系统不支持）。
 */
export const notificationSkipReasonSchema = z.enum([
  "muted",
  "rate-limited",
  "disabled",
  "focused",
  "unsupported",
]);
export type NotificationSkipReason = z.infer<typeof notificationSkipReasonSchema>;

export const notificationsShowResultSchema = z.strictObject({
  shown: z.boolean(),
  reason: notificationSkipReasonSchema.optional(),
});
export type NotificationsShowResult = z.infer<typeof notificationsShowResultSchema>;

/** Renderer 经 preload 交给 Main 的一条扩展通知（标题已加插件名前缀）。 */
export const extensionNotificationPayloadSchema = z.strictObject({
  pluginId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(NOTIFICATION_BODY_MAX_LENGTH),
  /** 点击后打开的视图全局 id（`<pluginId>/<viewId>`）。 */
  viewId: z.string().min(1).optional(),
});
export type ExtensionNotificationPayload = z.infer<typeof extensionNotificationPayloadSchema>;

/** 用户点了扩展通知：Main 把它发回发出请求的窗口。 */
export const extensionNotificationClickSchema = z.strictObject({
  pluginId: z.string().min(1),
  viewId: z.string().min(1).optional(),
});
export type ExtensionNotificationClick = z.infer<typeof extensionNotificationClickSchema>;
