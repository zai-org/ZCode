import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import {
  OpenExtensionLogsContext,
  OpenExtensionViewContext,
} from "@/extension-slots/adapters/extensionViewsContext.js";
import {
  useExtensionSlotsState,
  useExtensionViewsService,
  useExtensionsService,
} from "@/extension-slots/adapters/useExtensionSlots.js";
import { useExtensionGrantRequests } from "@/extension-slots/adapters/useExtensionGrants.js";
import { selectStaticViews } from "@/extension-slots/domain/slotSelectors.js";
import type { NotificationsShowResult } from "@zcode/shared/extension-host";
import type {
  ExtensionViewSidePaneTab,
  OpenExtensionLogs,
  OpenExtensionView,
  StartExtensionDraft,
} from "@/extension-slots/contract.js";

/**
 * 扩展视图的打开入口（docs/plugins/extension-host.md §8）。侧栏标签的 owner 是 App 层的面板状态，
 * 这里只把「打开某个视图」翻译成一个 extension-view 标签交给它：
 * - 启动页「扩展」分区的视图条目经 useOpenExtensionView() 调用。
 * - 能力 views.open：Window Host 经 IExtensionViewsService 的事件请 Renderer 打开，打开后回执。
 * 产品只有一个侧栏，标签都开在当前工作区的侧栏里；视图实例的作用域跟随侧栏当前目标。
 * 视图声明来自 Window Host 的静态表（§16.1）。
 * 同时报告 App 环境（界面语言，§16.11）：语言只在 Renderer，扩展经能力 env.* 读。
 * 也提供打开扩展日志标签的入口（§16.8）：启动页「扩展日志」一行经 useOpenExtensionLogs() 调用。
 * 能力 workbench.startDraft（§18.1 H2）同样经 IExtensionViewsService 的事件到这里，交给 App 层的
 * onStartDraft（Root 的新建任务），接手后回执。
 * 能力 grants.request（§18.1 H12）经 IExtensionGrantsService 的事件到这里，弹授权对话框后回执。
 * 能力 notifications.show（§18.1 H8）经 IExtensionViewsService 的事件到这里：查设置页的系统通知开关，
 * 给标题加插件名前缀，经 preload 交给 Main；点了通知时打开该插件声明的视图。
 */
export function ExtensionViewsProvider({
  onOpenTab,
  onOpenLogs,
  onStartDraft,
  children,
}: {
  onOpenTab: (tab: ExtensionViewSidePaneTab) => void;
  onOpenLogs: OpenExtensionLogs;
  onStartDraft: StartExtensionDraft;
  children: ReactNode;
}) {
  const service = useExtensionsService();
  const viewsService = useExtensionViewsService();
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const notificationEnabledRef = useRef(notificationEnabled);
  notificationEnabledRef.current = notificationEnabled;
  const intlRef = useRef(intl);
  intlRef.current = intl;
  const table = useExtensionSlotsState(service, (state) => state.table);
  const views = useMemo(() => selectStaticViews(table), [table]);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const onOpenTabRef = useRef(onOpenTab);
  onOpenTabRef.current = onOpenTab;
  // 订阅只随服务重建；回调读最新一份（App 层的回调随只读状态等变化）。
  const onStartDraftRef = useRef(onStartDraft);
  onStartDraftRef.current = onStartDraft;
  useExtensionGrantRequests();

  // 稳定的入口：读最新快照与回调，不因快照变化重建订阅。
  const openView = useCallback<OpenExtensionView>((viewId) => {
    const view = viewsRef.current.find((candidate) => candidate.id === viewId);
    if (!view) return false;
    onOpenTabRef.current({
      id: `extension-view:${view.id}`,
      type: "extension-view",
      viewId: view.id,
      title: view.title,
      ...(view.icon ? { icon: view.icon } : {}),
      ...(view.scope === "app" ? { appScoped: true as const } : {}),
    });
    return true;
  }, []);

  // 语言变化时报告；服务换了（Window Host 重连）也重新报告一次。
  useEffect(() => {
    if (!service) return;
    logger.lifecycle.info("[extension-slots] env report", { locale });
    void service.reportEnv({ locale }).catch((error: unknown) => {
      logger.lifecycle.warn("[extension-slots] env report failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [locale, service]);

  useEffect(() => {
    if (!viewsService) return;
    const subscription = viewsService.onDynamicViewOpenRequests(undefined)((request) => {
      const ok = openView(request.viewId);
      logger.lifecycle.info("[extension-slots] views.open", {
        viewId: request.viewId,
        scope: request.scope.kind,
        ok,
      });
      void viewsService
        .ackViewOpen({
          requestId: request.requestId,
          ok,
          ...(ok ? {} : { error: `view is not available: ${request.viewId}` }),
        })
        .catch((error: unknown) => {
          logger.lifecycle.warn("[extension-slots] views.open ack failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
    return () => subscription.dispose();
  }, [openView, viewsService]);

  useEffect(() => {
    if (!viewsService) return;
    const subscription = viewsService.onDynamicDraftRequests(undefined)((request) => {
      let ok = false;
      try {
        ok = onStartDraftRef.current({
          text: request.text,
          ...(request.workspace ? { workspace: request.workspace } : {}),
        });
      } catch (error) {
        logger.lifecycle.warn("[extension-slots] workbench.startDraft failed", {
          pluginId: request.pluginId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // 不记文字本身，只记长度。
      logger.lifecycle.info("[extension-slots] workbench.startDraft", {
        pluginId: request.pluginId,
        chars: request.text.length,
        workspace: request.workspace ? "explicit" : "current",
        ok,
      });
      void viewsService
        .ackDraftRequest({
          requestId: request.requestId,
          ok,
          ...(ok ? {} : { error: "this window cannot start a draft now" }),
        })
        .catch((error: unknown) => {
          logger.lifecycle.warn("[extension-slots] workbench.startDraft ack failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
    return () => subscription.dispose();
  }, [viewsService]);

  // notifications.show（§18.1 H8）：Window Host 已查档位、详情页开关与限额；这里查设置页开关，再交给 Main。
  useEffect(() => {
    if (!viewsService) return;
    const subscription = viewsService.onDynamicNotificationRequests(undefined)((request) => {
      const ack = (result: NotificationsShowResult) => {
        // 不记标题与正文。
        logger.lifecycle.info("[extension-slots] notifications.show", {
          pluginId: request.pluginId,
          shown: result.shown,
          reason: result.reason ?? null,
        });
        void viewsService
          .ackNotificationRequest({ requestId: request.requestId, result })
          .catch((error: unknown) => {
            logger.lifecycle.warn("[extension-slots] notifications.show ack failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          });
      };
      if (!notificationEnabledRef.current) {
        ack({ shown: false, reason: "disabled" });
        return;
      }
      const show = platform?.showExtensionNotification;
      if (!show) {
        ack({ shown: false, reason: "unsupported" });
        return;
      }
      const title = intlRef.current.formatMessage(
        { id: "extensions.notifications.title" },
        { plugin: request.pluginName, title: request.title },
      );
      void show({
        pluginId: request.pluginId,
        title,
        body: request.body,
        ...(request.viewId ? { viewId: request.viewId } : {}),
      }).then(ack, (error: unknown) => {
        logger.lifecycle.warn("[extension-slots] notifications.show failed", {
          pluginId: request.pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        ack({ shown: false, reason: "unsupported" });
      });
    });
    return () => subscription.dispose();
  }, [platform, viewsService]);

  // 点了扩展通知：只打开静态表里属于这个插件的视图（Main 已聚焦窗口）。
  useEffect(() => {
    if (!platform?.onExtensionNotificationClick) return;
    return platform.onExtensionNotificationClick((click) => {
      const view = click.viewId
        ? viewsRef.current.find((candidate) => candidate.id === click.viewId)
        : undefined;
      const opened = Boolean(view && view.pluginId === click.pluginId && openView(view.id));
      logger.lifecycle.info("[extension-slots] notification click", {
        pluginId: click.pluginId,
        view: Boolean(click.viewId),
        opened,
      });
    });
  }, [openView, platform]);

  return (
    <OpenExtensionViewContext.Provider value={service ? openView : null}>
      <OpenExtensionLogsContext.Provider value={service ? onOpenLogs : null}>
        {children}
      </OpenExtensionLogsContext.Provider>
    </OpenExtensionViewContext.Provider>
  );
}
