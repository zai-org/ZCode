import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import {
  isSessionGrant,
  type ExtensionAuditEntry,
  type ExtensionGrant,
  type ExtensionGrantState,
} from "@zcode/shared/extension-host";
import type { IExtensionGrantsService } from "@zcode/services";
import {
  TID_EXTENSION_ACTIVATION_DIALOG,
  TID_EXTENSION_ENABLE_CONFIRM_DIALOG,
  TID_EXTENSION_GRANT_DIALOG,
} from "@zcode/shared/test-ids";
import { toast } from "@/components/ui/toast.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  getExtensionGrantsStore,
  type ExtensionGrantsState,
} from "@/extension-slots/app/extensionGrantsStore.js";

// 扩展授权的 Renderer 入口（docs/plugins/extension-host.md §17.7）：授权状态的最近一份、授权对话框、撤销、
// 启用确认与「最近操作」。门面只在桌面本机 Host 注册；Web 与手机远控没有它，这些入口不显示。
// 两个对话框复用全局 ConfirmDialog（同一套样式与键盘行为），不另做弹窗组件。

const EMPTY_STORE = createStore<ExtensionGrantsState>(() => ({ snapshot: null }));

export function useExtensionGrantsService(): IExtensionGrantsService | null {
  return useOptionalBaseWorkspaceServices()?.extensionGrantsService ?? null;
}

/** 订阅授权状态，按 selector 取值（浅比较）。 */
export function useExtensionGrantsState<T>(selector: (state: ExtensionGrantsState) => T): T {
  const service = useExtensionGrantsService();
  const entry = service ? getExtensionGrantsStore(service) : null;
  useEffect(() => entry?.retain(), [entry]);
  return useStore(entry?.store ?? EMPTY_STORE, useShallow(selector));
}

/** 一个插件的授权状态；没有声明档位、也没有记录时为 null。 */
export function useExtensionGrantState(pluginId: string): ExtensionGrantState | null {
  return useExtensionGrantsState(
    (state) => state.snapshot?.plugins.find((plugin) => plugin.pluginId === pluginId) ?? null,
  );
}

/** 档位的显示文字：`读取会话`、`读写会话`。 */
export function useFormatGrants(): (grants: readonly ExtensionGrant[]) => string {
  const { intl, locale } = useZCodeIntl();
  return useCallback(
    (grants) =>
      new Intl.ListFormat(locale, { type: "conjunction" }).format(
        grants.map((grant) => intl.formatMessage({ id: `extensions.grants.tier.${grant}` })),
      ),
    [intl, locale],
  );
}

/**
 * 打开授权对话框（§17.7 的原文），确认后经 IExtensionGrantsService.grant 授予清单当前声明的档位。
 * 返回是否已授予。
 */
export function useRequestExtensionGrant():
  | ((state: ExtensionGrantState) => Promise<boolean>)
  | null {
  const service = useExtensionGrantsService();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialogStore((store) => store.requestConfirmation);
  const request = useCallback(
    async (state: ExtensionGrantState): Promise<boolean> => {
      if (!service || state.declared.length === 0) return false;
      const fullAccess = state.declared.includes("sessions.fullAccess");
      const writes = fullAccess || state.declared.includes("sessions.write");
      const sessions = state.declared.some(isSessionGrant);
      const notifications = state.declared.includes("notifications");
      // 标题按会话档位；只申请通知时用通知标题。正文：会话档位的原文，申请了完全访问时单独写一行（§17.12），
      // 申请了通知时再加一段通知说明（§18.1 H8）。
      const description = [
        ...(sessions ? [intl.formatMessage({ id: "extensions.grants.dialog.body" })] : []),
        ...(fullAccess
          ? [intl.formatMessage({ id: "extensions.grants.dialog.fullAccessBody" })]
          : []),
        ...(notifications
          ? [intl.formatMessage({ id: "extensions.grants.dialog.notificationsBody" })]
          : []),
      ].join("\n\n");
      const confirmed = await requestConfirmation({
        title: intl.formatMessage(
          {
            id: writes
              ? "extensions.grants.dialog.titleWrite"
              : sessions
                ? "extensions.grants.dialog.titleRead"
                : "extensions.grants.dialog.titleNotifications",
          },
          { plugin: state.name },
        ),
        description,
        confirmLabel: intl.formatMessage({ id: "extensions.grants.grant" }),
        testId: TID_EXTENSION_GRANT_DIALOG,
        intent: "extension-grant",
        scrollableDescription: true,
        showKeyboardHints: false,
      });
      if (!confirmed) return false;
      try {
        await service.grant({ pluginId: state.pluginId, grants: [...state.declared] });
        logger.lifecycle.info("[extension-slots] grant", {
          pluginId: state.pluginId,
          grants: state.declared,
        });
        toast(intl.formatMessage({ id: "extensions.grants.grantedToast" }, { plugin: state.name }));
        return true;
      } catch (error) {
        // 清单在对话框打开期间变了（请求过期）或写文件失败：不显示原始错误文本。
        logger.lifecycle.warn("[extension-slots] grant failed", {
          pluginId: state.pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        toast(intl.formatMessage({ id: "extensions.grants.failedToast" }), { variant: "warning" });
        return false;
      }
    },
    [intl, requestConfirmation, service],
  );
  return service ? request : null;
}

/**
 * 能力 grants.request（§18.1 H12）：Window Host 请这个窗口弹授权对话框。用启动页「需要授权」同一个对话框
 * （useRequestExtensionGrant）；对话框结束、授予调用也结束后才回执，Window Host 这时读到的授权状态已含这次结果。
 * 用户取消不是失败（ok 为 true）；只有窗口没能弹出对话框时 ok 为 false。只挂一处（ExtensionViewsProvider）。
 */
export function useExtensionGrantRequests(): void {
  const service = useExtensionGrantsService();
  const requestGrant = useRequestExtensionGrant();
  const requestGrantRef = useRef(requestGrant);
  requestGrantRef.current = requestGrant;
  useEffect(() => {
    if (!service) return;
    const entry = getExtensionGrantsStore(service);
    const release = entry.retain();
    const subscription = service.onDynamicGrantRequests(undefined)((request) => {
      void (async () => {
        const state = entry.store
          .getState()
          .snapshot?.plugins.find((plugin) => plugin.pluginId === request.pluginId);
        const ask = requestGrantRef.current;
        const shown = Boolean(state && ask && state.status === "needs-consent");
        let granted = false;
        if (state && ask && shown) granted = await ask(state);
        logger.lifecycle.info("[extension-slots] grants.request", {
          pluginId: request.pluginId,
          shown,
          granted,
        });
        await service.ackGrantRequest({
          requestId: request.requestId,
          // 授权状态还没到这个窗口（或已不需要授权）时不弹，照常回执：Window Host 读的是自己的授权状态。
          ok: Boolean(ask),
          ...(ask ? {} : { error: "this window cannot ask for permissions" }),
        });
      })().catch((error: unknown) => {
        logger.lifecycle.warn("[extension-slots] grants.request ack failed", {
          name: error instanceof Error ? error.name : typeof error,
        });
      });
    });
    return () => {
      subscription.dispose();
      release();
    };
  }, [service]);
}

/** 详情页「系统通知」开关（§18.1 H8）：改动经 IExtensionGrantsService，新的授权状态到达后开关跟着变。 */
export function useSetExtensionNotifications():
  | ((state: ExtensionGrantState, enabled: boolean) => Promise<void>)
  | null {
  const service = useExtensionGrantsService();
  const { intl } = useZCodeIntl();
  const set = useCallback(
    async (state: ExtensionGrantState, enabled: boolean) => {
      if (!service) return;
      try {
        await service.setNotificationsEnabled({ pluginId: state.pluginId, enabled });
        logger.lifecycle.info("[extension-slots] notifications switch", {
          pluginId: state.pluginId,
          enabled,
        });
      } catch (error) {
        logger.lifecycle.warn("[extension-slots] notifications switch failed", {
          pluginId: state.pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        toast(intl.formatMessage({ id: "extensions.grants.failedToast" }), { variant: "warning" });
      }
    },
    [intl, service],
  );
  return service ? set : null;
}

/** 撤销该插件的全部授权。 */
export function useRevokeExtensionGrant(): ((state: ExtensionGrantState) => Promise<void>) | null {
  const service = useExtensionGrantsService();
  const { intl } = useZCodeIntl();
  const revoke = useCallback(
    async (state: ExtensionGrantState) => {
      if (!service) return;
      try {
        await service.revoke({ pluginId: state.pluginId });
        logger.lifecycle.info("[extension-slots] revoke", { pluginId: state.pluginId });
        toast(intl.formatMessage({ id: "extensions.grants.revokedToast" }, { plugin: state.name }));
      } catch (error) {
        logger.lifecycle.warn("[extension-slots] revoke failed", {
          pluginId: state.pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        toast(intl.formatMessage({ id: "extensions.grants.failedToast" }), { variant: "warning" });
      }
    },
    [intl, service],
  );
  return service ? revoke : null;
}

/**
 * 启用确认（§17.7，用户决策）：已有扩展持有会话权限时，启用任何带扩展代码的插件都要确认一次。
 * 返回是否继续启用。没有授权门面（Web、手机、远程目标）时直接继续。
 */
export function useConfirmExtensionEnable(): (
  pluginId: string,
  pluginName: string,
) => Promise<boolean> {
  const service = useExtensionGrantsService();
  const { intl, locale } = useZCodeIntl();
  const formatGrants = useFormatGrants();
  const requestConfirmation = useConfirmDialogStore((store) => store.requestConfirmation);
  return useCallback(
    async (pluginId, pluginName) => {
      if (!service) return true;
      let impact;
      try {
        impact = await service.describeEnable({ pluginId });
      } catch (error) {
        // 读不到依据时按需要确认处理：宁可多问一次，不能漏问。
        logger.lifecycle.warn("[extension-slots] describe enable failed", {
          pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        impact = null;
      }
      if (impact && !impact.confirm) return true;
      const holders = new Intl.ListFormat(locale, { type: "conjunction" }).format(
        (impact?.holders ?? []).map((holder) =>
          intl.formatMessage(
            { id: "extensions.grants.holder" },
            { plugin: holder.name, tiers: formatGrants(holder.granted) },
          ),
        ),
      );
      logger.lifecycle.info("[extension-slots] enable confirmation", {
        pluginId,
        holders: impact?.holders.length ?? null,
      });
      return requestConfirmation({
        title: intl.formatMessage({ id: "extensions.grants.enable.title" }, { plugin: pluginName }),
        description: intl.formatMessage(
          { id: impact ? "extensions.grants.enable.body" : "extensions.grants.enable.bodyUnknown" },
          { plugin: pluginName, holders },
        ),
        confirmLabel: intl.formatMessage({ id: "extensions.grants.enable.confirm" }),
        testId: TID_EXTENSION_ENABLE_CONFIRM_DIALOG,
        intent: "extension-enable",
        showKeyboardHints: false,
      });
    },
    [formatGrants, intl, locale, requestConfirmation, service],
  );
}

/**
 * 从插件商店安装后、激活前的确认（§17.7，P3b）：与设置页的启用确认同一份依据（describeEnable 的持有者），
 * 确认 → 激活；「不激活」→ 记为不激活；关闭对话框 → 仍在等待。状态的 owner 是 Window Host（grants.json → 静态表）。
 * 没有授权门面（Web、手机）时为 null。
 */
export function useDecideExtensionActivation():
  | ((plugin: { pluginId: string; name: string }) => Promise<void>)
  | null {
  const service = useExtensionGrantsService();
  const { intl, locale } = useZCodeIntl();
  const formatGrants = useFormatGrants();
  const requestChoice = useConfirmDialogStore((store) => store.requestChoice);
  const decide = useCallback(
    async ({ pluginId, name }: { pluginId: string; name: string }) => {
      if (!service) return;
      let impact;
      try {
        impact = await service.describeEnable({ pluginId });
      } catch (error) {
        logger.lifecycle.warn("[extension-slots] describe activation failed", {
          pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
        impact = null;
      }
      const holders = new Intl.ListFormat(locale, { type: "conjunction" }).format(
        (impact?.holders ?? []).map((holder) =>
          intl.formatMessage(
            { id: "extensions.grants.holder" },
            { plugin: holder.name, tiers: formatGrants(holder.granted) },
          ),
        ),
      );
      const choice = await requestChoice({
        title: intl.formatMessage({ id: "extensions.activation.dialog.title" }, { plugin: name }),
        description: intl.formatMessage(
          {
            id: impact
              ? "extensions.activation.dialog.body"
              : "extensions.activation.dialog.bodyUnknown",
          },
          { plugin: name, holders },
        ),
        confirmLabel: intl.formatMessage({ id: "extensions.activation.allow" }),
        cancelLabel: intl.formatMessage({ id: "extensions.activation.decline" }),
        testId: TID_EXTENSION_ACTIVATION_DIALOG,
        intent: "extension-activation",
        scrollableDescription: true,
        showKeyboardHints: false,
      });
      // 关闭对话框（Esc、遮罩）不算决定：仍在等待，「需要确认」一行保留。只有「不激活」按钮记为不激活。
      if (choice === "dismiss") return;
      const allow = choice === "confirm";
      try {
        await service.decideActivation({ pluginId, allow });
        logger.lifecycle.info("[extension-slots] activation decided", { pluginId, allow });
        toast(
          intl.formatMessage(
            {
              id: allow
                ? "extensions.activation.allowedToast"
                : "extensions.activation.declinedToast",
            },
            { plugin: name },
          ),
        );
      } catch (error) {
        // 插件已不在等待（例如另一处先做了决定）或写文件失败：不显示原始错误文本。
        logger.lifecycle.warn("[extension-slots] activation decision failed", {
          pluginId,
          allow,
          name: error instanceof Error ? error.name : typeof error,
        });
        toast(intl.formatMessage({ id: "extensions.activation.failedToast" }), {
          variant: "warning",
        });
      }
    },
    [formatGrants, intl, locale, requestChoice, service],
  );
  return service ? decide : null;
}

/**
 * 「最近操作」：读该插件最近的审计行。授权状态（rev）变化时重新读：P3a 的审计行只有授权与撤销，
 * 都会改变授权状态，所以不需要轮询。
 */
export function useExtensionRecentActions(pluginId: string): ExtensionAuditEntry[] | null {
  const service = useExtensionGrantsService();
  const rev = useExtensionGrantsState((state) => state.snapshot?.rev ?? null);
  const [result, setResult] = useState<{
    pluginId: string;
    entries: ExtensionAuditEntry[];
  } | null>(null);
  useEffect(() => {
    if (!service || rev === null) return;
    let cancelled = false;
    void service.getRecentActions({ pluginId, limit: 10 }).then(
      ({ entries }) => {
        if (!cancelled) setResult({ pluginId, entries });
      },
      (error: unknown) => {
        logger.lifecycle.warn("[extension-slots] recent actions failed", {
          pluginId,
          name: error instanceof Error ? error.name : typeof error,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pluginId, rev, service]);
  // rev 换了、新结果还没到时沿用同一插件的上一份，避免列表闪空；换了插件不沿用。
  return result?.pluginId === pluginId ? result.entries : null;
}
