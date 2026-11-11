import {
  TID_EXTENSION_PERMISSIONS,
  TID_EXTENSION_PERMISSIONS_ACTION,
  TID_EXTENSION_PERMISSIONS_GRANT,
  TID_EXTENSION_PERMISSIONS_NOTIFICATIONS,
  TID_EXTENSION_PERMISSIONS_REVOKE,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useExtensionGrantState,
  useExtensionRecentActions,
  useFormatGrants,
  useRequestExtensionGrant,
  useRevokeExtensionGrant,
  useSetExtensionNotifications,
} from "@/extension-slots/adapters/useExtensionGrants.js";
import type { ExtensionPermissionsSectionProps } from "@/extension-slots/contract.js";

/** 八个写动作在「最近操作」里的动作名（§17.8）；其余能力显示能力 id。 */
const WRITE_ACTION_LABEL_IDS: Record<string, string> = {
  "sessions.createSession": "extensions.permissions.action.createSession",
  "sessions.forkSession": "extensions.permissions.action.forkSession",
  "sessions.sendToSession": "extensions.permissions.action.sendToSession",
  "sessions.interruptSession": "extensions.permissions.action.interruptSession",
  "sessions.renameSession": "extensions.permissions.action.renameSession",
  "sessions.openSession": "extensions.permissions.action.openSession",
  "sessions.setSessionArchived": "extensions.permissions.action.setSessionArchived",
  "sessions.setSessionPinned": "extensions.permissions.action.setSessionPinned",
  "sessions.resolveInteraction": "extensions.permissions.action.resolveInteraction",
  "sessions.setPermissionMode": "extensions.permissions.action.setPermissionMode",
};

const STATUS_LABEL_IDS = {
  granted: "extensions.permissions.status.granted",
  "needs-consent": "extensions.grants.needsConsent",
  inactive: "extensions.permissions.status.inactive",
} as const;

/**
 * 插件详情页的「权限」区块（docs/plugins/extension-host.md §17.7）：清单声明或已授予的会话权限、授权或撤销、
 * 系统通知开关（§18.1 H8）、最近操作（审计日志里该插件的行）。插件没有声明档位、也没有记录时不渲染；Web 与手机远控没有授权门面，也不渲染。
 */
export function ExtensionPermissionsSection({ pluginId }: ExtensionPermissionsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const state = useExtensionGrantState(pluginId);
  const requestGrant = useRequestExtensionGrant();
  const revoke = useRevokeExtensionGrant();
  const setNotifications = useSetExtensionNotifications();
  const formatGrants = useFormatGrants();
  const actions = useExtensionRecentActions(pluginId);
  if (!state) return null;
  const tiers =
    state.status === "granted"
      ? state.granted
      : state.status === "inactive"
        ? state.recorded
        : state.declared;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const actionLabel = (entry: NonNullable<typeof actions>[number]) => {
    const label = intl.formatMessage(
      {
        id:
          entry.capability === "grants.grant"
            ? "extensions.permissions.action.grant"
            : entry.capability === "grants.revoke"
              ? "extensions.permissions.action.revoke"
              : entry.capability === "grants.notifications.on"
                ? "extensions.permissions.action.notificationsOn"
                : entry.capability === "grants.notifications.off"
                  ? "extensions.permissions.action.notificationsOff"
                  : (WRITE_ACTION_LABEL_IDS[entry.capability] ??
                    "extensions.permissions.action.other"),
      },
      {
        tiers: entry.grant && entry.grant !== "none" ? formatGrants([entry.grant]) : "",
        capability: entry.capability,
      },
    );
    return entry.outcome === "error"
      ? intl.formatMessage({ id: "extensions.permissions.action.failed" }, { action: label })
      : label;
  };
  return (
    <section
      data-testid={TID_EXTENSION_PERMISSIONS}
      data-plugin-id={pluginId}
      data-grant-status={state.status}
    >
      <div className="border-b border-border pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "extensions.permissions.title" })}
        </h2>
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-ui-base text-foreground">
          <span className="inline-flex h-5 shrink-0 items-center rounded-sm bg-tag px-1.5 text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: STATUS_LABEL_IDS[state.status] })}
          </span>
          <span className="min-w-0 truncate">{formatGrants(tiers)}</span>
        </div>
        {state.status === "needs-consent" ? (
          requestGrant ? (
            <Button
              type="button"
              size="sm"
              data-testid={TID_EXTENSION_PERMISSIONS_GRANT}
              data-plugin-id={pluginId}
              onClick={() => void requestGrant(state)}
            >
              {intl.formatMessage({ id: "extensions.grants.grant" })}
            </Button>
          ) : null
        ) : revoke ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_EXTENSION_PERMISSIONS_REVOKE}
            data-plugin-id={pluginId}
            onClick={() => void revoke(state)}
          >
            {intl.formatMessage({ id: "extensions.permissions.revoke" })}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "extensions.permissions.note" })}
      </p>
      {state.notificationsEnabled !== undefined && setNotifications ? (
        // 系统通知开关（§18.1 H8，默认开）：只在通知档位生效时显示。
        <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "extensions.permissions.notifications" })}
            </div>
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "extensions.permissions.notificationsNote" })}
            </div>
          </div>
          <Switch
            data-testid={TID_EXTENSION_PERMISSIONS_NOTIFICATIONS}
            data-plugin-id={pluginId}
            aria-label={intl.formatMessage({ id: "extensions.permissions.notifications" })}
            checked={state.notificationsEnabled}
            onCheckedChange={(checked) => void setNotifications(state, checked)}
          />
        </div>
      ) : null}
      <h3 className="mt-4 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "extensions.permissions.recent" })}
      </h3>
      {actions && actions.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {actions.map((entry) => (
            <li
              key={`${entry.ts}:${entry.capability}`}
              data-testid={TID_EXTENSION_PERMISSIONS_ACTION}
              data-capability={entry.capability}
              data-grant={entry.grant ?? ""}
              data-outcome={entry.outcome}
              className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3 text-ui-base"
            >
              <span className="text-foreground-subtle tabular-nums">{time.format(entry.ts)}</span>
              <span className="min-w-0 truncate text-foreground">{actionLabel(entry)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: actions
              ? "extensions.permissions.recentEmpty"
              : "extensions.permissions.recentLoading",
          })}
        </p>
      )}
    </section>
  );
}
