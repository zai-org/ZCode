import { completeNewModelSelection } from "@zcode/provider";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistProviderFamilyConnection } from "@/lib/providerFamilyConnectionTransition.js";
import {
  chooseConnectionModel,
  composerConnectionKey,
  type ComposerConnection,
} from "@/lib/composerPlanGroups.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { logger } from "@/logger.js";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import {
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelection,
  type ZCodeProvider,
} from "@zcode/shared";

export function useComposerConnectionSwitch({
  workspacePath,
  workspaceIdentity,
  agentProvider,
  normalizedValue,
  currentReasoningLevel,
  onSelectModel,
  onPendingChange,
  scopeId,
  waitForPresentation = false,
  presentationStatus = "ready",
  presentationRevision,
  presentationErrorRevision,
  refreshPresentation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  agentProvider: ZCodeProvider;
  normalizedValue: string;
  currentReasoningLevel?: string;
  onSelectModel: (value: string, reasoningLevel?: string) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
  scopeId?: string;
  waitForPresentation?: boolean;
  presentationStatus?: "ready" | "loading" | "error" | "unavailable";
  presentationRevision?: number;
  presentationErrorRevision?: number;
  refreshPresentation?: () => Promise<unknown>;
}) {
  const base = useBaseWorkspaceServices();
  const { services: target, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    undefined,
    workspaceIdentity,
  );
  const { update, refresh: refreshSettings } = useSettings({ services: base });
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const token = useMemo(() => ({}), [target, base, workspaceKey, scopeId]);
  const owner = useRef({ token, mounted: true });
  owner.current = { token, mounted: true };
  const inFlight = useRef(false);
  const [state, setState] = useState<{
    pending: boolean;
    error: string | null;
    previousKey?: string;
    expectedValue?: string;
    expectedRevision?: number;
  }>({
    pending: false,
    error: null,
  });
  // 根因：连接刷新先于选模完成，旧实现只锁菜单，发送仍可冻结旧 provider。
  // 同步通知提交门禁；完成仍以此 owner 的展示回执为准，不另设计时器。
  useLayoutEffect(() => {
    onPendingChange?.(state.pending);
  }, [state.pending, onPendingChange]);
  useLayoutEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    setState({ pending: false, error: null });
    inFlight.current = false;
    return () => {
      owner.current.mounted = false;
    };
  }, [target, base, workspaceKey, scopeId]);
  useEffect(() => {
    if (!state.expectedValue) return;
    if (
      presentationStatus === "error" ||
      presentationStatus === "unavailable" ||
      // 原因：旧 ready 可保留目录，但目标刷新失败必须是本次切换的终态。
      (presentationErrorRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationErrorRevision >= state.expectedRevision)
    ) {
      inFlight.current = false;
      setState({
        pending: false,
        error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    } else if (presentationStatus === "ready") {
      // 原因：选择 owner 在重读时保留旧 ready；只有目标目录版本到达才是本次展示回执。
      if (
        presentationRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationRevision < state.expectedRevision
      )
        return;
      // 原因：RPC 完成早于 Renderer 的选择重解析；提前结束 loading 会暴露新旧目录混合帧。
      inFlight.current = false;
      // 原因：有效选择可能被过滤或被另一草稿改写；ready 不匹配也必须结束等待，不能永久锁住工具条。
      const matched = normalizedValue === state.expectedValue;
      if (!matched)
        logger.lifecycle.warn("[composer-connection] 展示选择与目标不匹配", {
          expectedValue: state.expectedValue,
          normalizedValue,
        });
      setState({
        pending: false,
        error: matched ? null : intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    }
  }, [
    state.expectedValue,
    state.expectedRevision,
    presentationStatus,
    presentationRevision,
    presentationErrorRevision,
    normalizedValue,
    intl,
  ]);
  const select = useCallback(
    async (connection: ComposerConnection, previousKey?: string) => {
      if (inFlight.current || !rpcReady || connection.disabled) return;
      const currentOwner = owner.current;
      const stillCurrent = () =>
        owner.current.mounted && owner.current.token === currentOwner.token;
      inFlight.current = true;
      onPendingChange?.(true);
      setState({ pending: true, error: null, previousKey });
      let awaitingPresentation = false;
      try {
        const connectionKeyOf = (view: ProviderSettingsView) =>
          view.providers.find((p) => p.providerId === connection.providerId)?.accountState
            ?.connectionKey;
        const hasModels = (view: ModelSelectionView) =>
          Boolean(
            buildRegistryModelSelectGroups(agentProvider, view).find(
              (g) => g.key === `registry-provider:${connection.providerId}`,
            )?.items.length,
          );
        const readModels = async (restoring = false) => {
          if (!restoring && !stillCurrent()) throw new Error("Composer connection owner changed");
          // 配置写入由根 Host 管理；执行候选始终从目标 Host 读取，不向远端伪造本地目录。
          const baseView = await base.providerSettingsService.refresh("composer-connection");
          if (target !== base && stillCurrent()) {
            const targetView = await target.providerSettingsService.refresh("composer-connection");
            // 远端配置交付由既有 provisioning owner 管理；旧团队也可能有同名模型，
            // 必须核对账号连接身份，不能把目录非空误判成新团队已同步。
            const expected = connectionKeyOf(baseView);
            if (!restoring && (!expected || connectionKeyOf(targetView) !== expected))
              throw new Error("Target connection has not synchronized");
          }
          const view = await (stillCurrent() ? target : base).modelSelectionService.getView();
          if (!restoring && !hasModels(view))
            throw new Error("Selected connection has no available models");
          return view;
        };
        // 根因（ZCT-2118278184274395136）：普通 API 不写套餐设置，切回原套餐时连接仍已生效；
        // 旧实现仍无条件保存（同值也递增版本），远程工作区因此再推一轮 Provisioning，
        // 目标 refresh 还要等它写完，每次切回 1.5～8 秒。设置身份、目标身份和可用模型都已就绪时
        // 不保存、不等远端同步；任一项不满足仍走下方保存 → 同步 → 核对，远端未同步时由这次保存重新推送。
        const readEffectiveModels = async (selection: ProviderFamilyConnectionSelection) => {
          const settings = await base.settingService.get();
          const saved = settings.providerFamilyConnectionSelections?.[connection.family];
          if (
            settings.providerFamilyDomain !== connection.family ||
            !saved ||
            composerConnectionKey(connection.family, saved) !==
              composerConnectionKey(connection.family, selection)
          )
            return undefined;
          // 根因（CR-01）：根 Host 账号快照不一定按当前设置解析——同窗口写入后异步刷新，
          // 另一窗口写入时本窗口 Host 收不到通知、不刷新。只比根/目标两份缓存，两份同停在
          // 旧团队也会判为已生效，用旧团队目录选模且不报错。根 Host 先 refresh 取当前身份；
          // 目标 Host 仍只读缓存，不等远端 Provisioning（那才是慢的部分）。
          const baseView = await base.providerSettingsService.refresh("composer-connection");
          if (target !== base) {
            const expected = connectionKeyOf(baseView);
            const targetView = await target.providerSettingsService.getView();
            if (!expected || connectionKeyOf(targetView) !== expected) return undefined;
          }
          const view = await target.modelSelectionService.getView();
          if (!hasModels(view)) return undefined;
          // 原流程靠保存时的 update 刷新 Renderer 共享设置快照；快路径不保存，另一窗口写入后
          // 它仍是旧团队，Composer 勾选和连接标签会停在旧团队。
          await refreshSettings();
          return view;
        };
        const effectiveView = connection.selection
          ? await readEffectiveModels(connection.selection)
          : undefined;
        if (!stillCurrent()) return;
        const view =
          effectiveView ??
          (connection.selection
            ? await persistProviderFamilyConnection({
                family: connection.family,
                selection: connection.selection,
                read: () => base.settingService.get(),
                update,
                synchronize: readModels,
              })
            : await target.modelSelectionService.getView());
        if (!stillCurrent()) return;
        const group = buildRegistryModelSelectGroups(agentProvider, view).find(
          (g) => g.key === `registry-provider:${connection.providerId}`,
        );
        const model = chooseConnectionModel(
          group?.items ?? [],
          decodeCustomModelValue(normalizedValue)?.modelName,
        );
        if (!model) throw new Error("Selected connection has no available models");
        logger.debug("[composer-connection] 连接同步完成", {
          providerId: connection.providerId,
          connectionKey: connection.key,
          workspaceKey,
        });
        const source = decodeCustomModelValue(normalizedValue);
        const family = resolveModelProviderFamilySpecByProviderId(source?.providerId ?? "");
        const sameAccountModel =
          connection.selection &&
          family?.id === connection.family &&
          (source?.providerId === family.individualCodingPlanProviderId ||
            source?.providerId === family.teamCodingPlanProviderId) &&
          source?.modelName === model.name;
        // 同名账号模型也必须提交 Session，同时保留原档位，避免连接切换重置用户选择。
        const selection = completeNewModelSelection(view, {
          providerId: connection.providerId,
          modelId: model.name,
        });
        await onSelectModel(
          model.value,
          sameAccountModel ? currentReasoningLevel : selection?.options?.reasoningLevel,
        );
        if (waitForPresentation) {
          // 原因：重选同连接可能没有目录事件；每次显式读取当前展示 owner，不消费旧失败回执。
          await refreshPresentation?.();
          if (!stillCurrent()) return;
          awaitingPresentation = true;
          setState({
            pending: true,
            error: null,
            previousKey,
            expectedValue: model.value,
            expectedRevision: view.revision,
          });
        }
      } catch (error) {
        // 连接切换失败属于低频生命周期诊断，生产回放也需要保留明确失败原因。
        logger.lifecycle.warn("[composer-connection] 切换连接失败", {
          providerId: connection.providerId,
          workspaceKey,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          causes:
            error instanceof AggregateError
              ? error.errors.map((cause) => String(cause))
              : undefined,
        });
        if (stillCurrent())
          setState({
            pending: false,
            error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
          });
      } finally {
        if (stillCurrent() && !awaitingPresentation) {
          inFlight.current = false;
          setState((previous) => ({ ...previous, pending: false }));
        }
      }
    },
    [
      agentProvider,
      base,
      intl,
      normalizedValue,
      currentReasoningLevel,
      onSelectModel,
      onPendingChange,
      refreshSettings,
      rpcReady,
      target,
      update,
      workspaceKey,
      waitForPresentation,
      refreshPresentation,
    ],
  );
  return { ...state, select };
}
