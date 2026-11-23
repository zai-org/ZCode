import type { ReactNode } from "react";
import { Anchor, Download, ShieldCheck } from "lucide-react";
import type { Hook, PluginHookDetail, PluginScope } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginInstallEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { requiresWorkspaceHookTrust } from "@/settings/WorkspaceHookTrustNotice.js";

export type HookScope = "user" | "project";

export interface PluginHookRow {
  detail: PluginHookDetail;
  pluginEnabled: boolean;
  pluginId: string;
  pluginName: string;
  pluginScope?: PluginScope;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
}

type HookSection =
  | { kind: "installed"; title: "Installed"; count: number; hooks: Hook[] }
  | { kind: "legacy"; title: "Legacy"; count: number; hooks: Hook[] }
  | { kind: "plugin"; title: string; pluginId: string; count: number; hooks: PluginHookRow[] };

export function groupHookSections(
  editableHooks: Hook[],
  compatibilityHooks: Hook[],
  pluginHooks: PluginHookRow[],
): HookSection[] {
  const sections: HookSection[] = [];
  if (editableHooks.length > 0) {
    sections.push({
      kind: "installed",
      title: "Installed",
      count: editableHooks.length,
      hooks: editableHooks,
    });
  }
  const pluginGroups = new Map<string, PluginHookRow[]>();
  for (const hook of pluginHooks) {
    const key = hook.pluginId || hook.pluginName.trim().toLocaleLowerCase();
    pluginGroups.set(key, [...(pluginGroups.get(key) ?? []), hook]);
  }
  for (const [, hooks] of [...pluginGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    sections.push({
      kind: "plugin",
      pluginId: hooks[0]?.pluginId ?? "",
      title: hooks[0]?.pluginName ?? "",
      count: hooks.length,
      hooks,
    });
  }
  if (compatibilityHooks.length > 0) {
    sections.push({
      kind: "legacy",
      title: "Legacy",
      count: compatibilityHooks.length,
      hooks: compatibilityHooks,
    });
  }
  return sections;
}

export function HooksList({
  compatibilityHooks,
  editableHooks,
  operatingHookId,
  pluginHooks,
  trustActionAvailable = false,
  trustingHookId,
  onEdit,
  onImport,
  onTrust,
  onToggle,
  formatPluginName = (name) => name,
  installedAction,
  installedEmptyActions,
  installedEmptyDescription,
  installedEmptyTitle,
  showInstalledSection = false,
}: {
  compatibilityHooks: Hook[];
  editableHooks: Hook[];
  operatingHookId: string | null;
  pluginHooks: PluginHookRow[];
  trustActionAvailable?: boolean;
  trustingHookId?: string | null;
  onEdit: (hook: Hook) => void;
  onImport: (hook: Hook) => Promise<void>;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  formatPluginName?: (name: string, pluginId?: string) => string;
  installedAction?: ReactNode;
  installedEmptyActions?: ReactNode;
  installedEmptyDescription?: string;
  installedEmptyTitle?: string;
  showInstalledSection?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const groupedSections = groupHookSections(editableHooks, compatibilityHooks, pluginHooks);
  const sections: HookSection[] =
    showInstalledSection && editableHooks.length === 0
      ? [{ kind: "installed", title: "Installed", count: 0, hooks: [] }, ...groupedSections]
      : groupedSections;

  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section
          key={`${section.kind}:${section.kind === "plugin" ? section.pluginId : section.title}`}
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
              {section.kind === "plugin"
                ? formatPluginName(section.title, section.pluginId)
                : intl.formatMessage({
                    id:
                      section.kind === "installed"
                        ? "settings.hooks.group.installed"
                        : "settings.hooks.group.legacy",
                  })}
              <span className="text-ui-sm font-normal text-foreground-subtle">{section.count}</span>
            </h3>
            {section.kind === "installed" ? installedAction : null}
          </div>
          {section.kind === "installed" && section.hooks.length === 0 ? (
            <PluginInstallEmptyState
              title={installedEmptyTitle ?? ""}
              description={installedEmptyDescription ?? ""}
              actions={installedEmptyActions}
            />
          ) : (
            <div className="overflow-hidden rounded-xl bg-surface">
              {section.kind === "plugin"
                ? section.hooks.map((hook, index) => (
                    <div key={`${hook.pluginId}-${hook.detail.sourcePath}-${index}`}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      <PluginHookItem hook={hook} />
                    </div>
                  ))
                : section.hooks.map((hook, index) => (
                    <div key={hook.id}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      {section.kind === "installed" ? (
                        <ConfiguredHookRow
                          hook={hook}
                          busy={operatingHookId === hook.id}
                          readOnly={hook.editable === false}
                          requiresTrust={requiresWorkspaceHookTrust(hook)}
                          trustActionAvailable={trustActionAvailable}
                          trusting={trustingHookId === hook.id}
                          onToggle={onToggle}
                          onEdit={onEdit}
                          onTrust={onTrust}
                        />
                      ) : (
                        <CompatibilityHookRow hook={hook} busy={operatingHookId === hook.id} onImport={onImport} />
                      )}
                    </div>
                  ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function HookItemFrame({
  actions,
  children,
  onEdit,
  pluginIconItem,
  testId,
}: {
  actions?: ReactNode;
  children: ReactNode;
  onEdit?: () => void;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  testId?: string;
}) {
  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${onEdit ? "transition-colors hover:bg-hover" : ""}`}
      data-testid={testId}
      {...settingsResourceRowInteraction(onEdit)}
    >
      {pluginIconItem ? (
        <PluginStoreAvatar
          item={pluginIconItem}
          className="size-9 bg-background"
          iconClassName="size-4"
          fallbackIcon={<Anchor className="size-4" />}
        />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Anchor className="size-4" />
        </div>
      )}
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="col-start-2 flex shrink-0 items-center justify-end gap-2 sm:col-start-auto">{actions}</div>
      ) : null}
    </div>
  );
}

function HookContent({
  event,
  command,
  trailingBadges,
}: {
  event: string;
  command: string;
  trailingBadges?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{event}</span>
        {trailingBadges}
      </div>
      <p className="mt-1 truncate font-mono text-ui-sm text-foreground-subtle">{command}</p>
    </>
  );
}

function ConfiguredHookRow({
  busy,
  hook,
  onEdit,
  onTrust,
  onToggle,
  readOnly = false,
  requiresTrust,
  trustActionAvailable,
  trusting,
}: {
  busy: boolean;
  hook: Hook;
  onEdit: (hook: Hook) => void;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  /** 上游/祖先 zcode.json 的只读工作区 Hook：不可编辑、不可 toggle，但仍可逐条 Trust。 */
  readOnly?: boolean;
  requiresTrust: boolean;
  trustActionAvailable: boolean;
  trusting: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      testId="configured-hook-row"
      onEdit={busy || readOnly ? undefined : () => onEdit(hook)}
      actions={
        <>
          {/* workspace-hook-trust（D24）：入口脚本不存在或无法读取时没有可审核的内容，
              不提供信任按钮，只说明原因；Switch 仍按未信任锁定关闭。 */}
          {hook.workspaceHook?.scriptUnavailable ? (
            <Badge variant="secondary" className="text-foreground-subtle">
              {intl.formatMessage({ id: "settings.hooks.review.scriptUnavailable" })}
            </Badge>
          ) : requiresTrust && onTrust ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || trusting || !trustActionAvailable}
              title={trustActionAvailable ? undefined : intl.formatMessage({ id: "settings.hooks.review.unavailable" })}
              onClick={(event) => {
                event.stopPropagation();
                void onTrust(hook);
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.review.trust" })}
            </Button>
          ) : null}
          {/* workspace-hook-trust：未通过信任审核的工作区 Hook 禁止直接启用，
              Switch 强制关闭并禁用，引导用户先完成 Trust 审核流程。
              只读行（上游 zcode.json）的 Switch 始终禁用：信任后展示真实配置状态，
              但启用/禁用必须去源文件改，Settings 不提供写入口。 */}
          <Switch
            checked={requiresTrust ? false : hook.enabled}
            onCheckedChange={(value) => void onToggle(hook, value)}
            onClick={(event) => event.stopPropagation()}
            disabled={busy || trusting || requiresTrust || readOnly}
          />
        </>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}

function CompatibilityHookRow({
  busy,
  hook,
  onImport,
}: {
  busy: boolean;
  hook: Hook;
  onImport: (hook: Hook) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      actions={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void onImport(hook)}>
          <Download className="size-3" />
          {intl.formatMessage({ id: "settings.hooks.import" })}
        </Button>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}

function PluginHookItem({ hook }: { hook: PluginHookRow }) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame testId="plugin-hook-row" pluginIconItem={hook.pluginIconItem}>
      <HookContent
        event={hook.detail.event}
        command={[hook.detail.command, ...(hook.detail.args ?? [])].join(" ")}
        trailingBadges={
          !hook.pluginScope ? (
            <Badge variant="secondary" className="bg-surface text-foreground-subtle">
              {intl.formatMessage({ id: "settings.hooks.scopeUnknown" })}
            </Badge>
          ) : null
        }
      />
    </HookItemFrame>
  );
}
