import {
  CircleAlertIcon,
  KeyRoundIcon,
  OctagonXIcon,
  ScrollTextIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import {
  TID_SIDE_PANE_EXTENSIONS,
  TID_SIDE_PANE_EXTENSIONS_STOPPED,
  TID_SIDE_PANE_EXTENSION_ACTIVATION,
  TID_SIDE_PANE_EXTENSION_GRANT,
  TID_SIDE_PANE_EXTENSION_LOGS_ITEM,
  TID_SIDE_PANE_EXTENSION_PROBLEM,
  TID_SIDE_PANE_EXTENSION_VIEW_ITEM,
} from "@zcode/shared/test-ids";
import { SidePaneLauncherRow } from "@/plugin-ui/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useExtensionLauncher } from "@/extension-slots/adapters/useExtensionSlots.js";
import {
  useDecideExtensionActivation,
  useExtensionGrantsState,
  useFormatGrants,
  useRequestExtensionGrant,
} from "@/extension-slots/adapters/useExtensionGrants.js";
import { resolveExtensionIcon } from "@/extension-slots/components/extensionIcons.js";
import { resolveLocalizedText } from "@/extension-slots/domain/slotSelectors.js";
import type {
  ExtensionLauncherSectionProps,
  ExtensionProblem,
} from "@/extension-slots/contract.js";

const STATE_LABEL_IDS: Record<string, string> = {
  failed: "extensions.state.failed",
  invalid: "extensions.state.invalid",
  incompatible: "extensions.state.incompatible",
};

/**
 * 启动页「扩展」分区（docs/plugins/extension-host.md §6、§16.1）。不依赖会话。
 * 顺序：「扩展已停止」→「需要确认」（§17.7，商店安装后等待激活）→「需要授权」（§17.7，点击打开授权对话框）→
 * 视图条目（点击打开扩展视图标签）→
 * 「扩展日志」（§16.8）→ 问题行（failed / invalid / incompatible）。
 * 条目与问题行来自 Window Host 的静态表，扩展进程停止时照常显示；此时视图条目显示「扩展已停止」，
 * 操作改为重新加载。没有任何要显示的行时整个分区不渲染。
 */
export function ExtensionLauncherSection(props: ExtensionLauncherSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const model = useExtensionLauncher(props);
  // 需要授权的插件（owner：Window Host 的授权记录）。未授权时扩展照常激活，会话能力报 not-granted。
  const grantRequests = useExtensionGrantsState(
    (state) => state.snapshot?.plugins.filter((plugin) => plugin.status === "needs-consent") ?? [],
  );
  const requestGrant = useRequestExtensionGrant();
  const decideActivation = useDecideExtensionActivation();
  const formatGrants = useFormatGrants();
  if (
    !model ||
    (!model.stopped &&
      model.problems.length === 0 &&
      model.views.length === 0 &&
      !model.openLogs &&
      grantRequests.length === 0 &&
      model.pendingActivations.length === 0)
  )
    return null;
  const openView = model.openView;
  const reload = model.reload;
  const stoppedLabel = intl.formatMessage({ id: "extensions.launcher.stopped" });
  const reloadLabel = intl.formatMessage({ id: "extensions.launcher.reload" });
  const describeProblem = (entry: ExtensionProblem) =>
    entry.path
      ? intl.formatMessage(
          { id: "extensions.state.reasonWithPath" },
          { path: entry.path, reason: entry.reason ?? "" },
        )
      : (entry.reason ?? "");
  return (
    <>
      <div aria-hidden="true" className="my-4 h-px w-24 self-center bg-border" />
      <section className="min-w-0" data-testid={TID_SIDE_PANE_EXTENSIONS}>
        <h2 className="pb-2 pl-2 text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "extensions.launcher.title" })}
        </h2>
        <div className="mt-2 grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
          {model.stopped ? (
            <SidePaneLauncherRow
              itemId="extensions-stopped"
              testId={TID_SIDE_PANE_EXTENSIONS_STOPPED}
              icon={OctagonXIcon}
              label={stoppedLabel}
              description={intl.formatMessage({ id: "extensions.launcher.stoppedDescription" })}
              actionLabel={reloadLabel}
              {...(reload ? { onOpen: reload } : {})}
            />
          ) : null}
          {model.pendingActivations.map((plugin) => (
            <SidePaneLauncherRow
              key={plugin.pluginId}
              itemId={`extension-activation:${plugin.pluginId}`}
              testId={TID_SIDE_PANE_EXTENSION_ACTIVATION}
              icon={ShieldQuestionIcon}
              label={plugin.name}
              descriptionTag={intl.formatMessage({ id: "extensions.activation.needsConfirmation" })}
              description={intl.formatMessage({ id: "extensions.activation.description" })}
              actionLabel={intl.formatMessage({ id: "extensions.activation.review" })}
              {...(decideActivation ? { onOpen: () => void decideActivation(plugin) } : {})}
            />
          ))}
          {grantRequests.map((state) => (
            <SidePaneLauncherRow
              key={state.pluginId}
              itemId={`extension-grant:${state.pluginId}`}
              testId={TID_SIDE_PANE_EXTENSION_GRANT}
              icon={KeyRoundIcon}
              label={state.name}
              descriptionTag={intl.formatMessage({ id: "extensions.grants.needsConsent" })}
              description={formatGrants(state.declared)}
              actionLabel={intl.formatMessage({ id: "extensions.grants.grant" })}
              {...(requestGrant ? { onOpen: () => void requestGrant(state) } : {})}
            />
          ))}
          {model.views.map((view) =>
            view.hostStopped ? (
              // 扩展进程已停止：视图打不开。行照常显示，标签说明原因，操作改为重新加载。
              <SidePaneLauncherRow
                key={view.itemId}
                itemId={`extension-view:${view.itemId}`}
                testId={TID_SIDE_PANE_EXTENSION_VIEW_ITEM}
                icon={resolveExtensionIcon(view.icon)}
                label={resolveLocalizedText(view.title, locale)}
                descriptionTag={stoppedLabel}
                description={view.pluginName}
                actionLabel={reloadLabel}
                {...(reload ? { onOpen: reload } : {})}
              />
            ) : (
              <SidePaneLauncherRow
                key={view.itemId}
                itemId={`extension-view:${view.itemId}`}
                testId={TID_SIDE_PANE_EXTENSION_VIEW_ITEM}
                icon={resolveExtensionIcon(view.icon)}
                label={resolveLocalizedText(view.title, locale)}
                description={view.pluginName}
                {...(view.tooltip ? { title: view.tooltip } : {})}
                {...(openView ? { onOpen: () => openView(view.viewId) } : {})}
              />
            ),
          )}
          {model.openLogs ? (
            <SidePaneLauncherRow
              itemId="extension-logs"
              testId={TID_SIDE_PANE_EXTENSION_LOGS_ITEM}
              icon={ScrollTextIcon}
              label={intl.formatMessage({ id: "extensions.logs.title" })}
              description={intl.formatMessage({ id: "extensions.logs.launcherDescription" })}
              onOpen={model.openLogs}
            />
          ) : null}
          {model.problems.map((entry) => (
            <SidePaneLauncherRow
              key={entry.pluginId}
              itemId={`extension-problem:${entry.pluginId}`}
              testId={TID_SIDE_PANE_EXTENSION_PROBLEM}
              icon={CircleAlertIcon}
              label={entry.name}
              descriptionTag={intl.formatMessage({
                id: STATE_LABEL_IDS[entry.state] ?? "extensions.state.failed",
              })}
              description={entry.version}
              title={describeProblem(entry)}
            />
          ))}
        </div>
      </section>
    </>
  );
}
