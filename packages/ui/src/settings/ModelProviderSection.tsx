/* eslint-disable max-lines -- Model Provider 设置页需要集中编排导航、表单和 OAuth 交互，后续整体拆分时再收敛。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import {
  getProviderFormApiKey,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DesktopCommandIds,
  isStartPlanModelProviderId,
  type BuiltinModelProviderId,
  type ModelConnectivityResult,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type OAuthProviderId,
  type OAuthAccountAvailability,
  isZaiOAuthProvider,
  resolveModelProviderFamilyIdByProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  resolveStartPlanFamilyFromOAuthProvider,
  toZhOrEnLocale,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  PRESET_PROVIDER_SPECS,
  PRESET_SUBSCRIPTION_TIMEOUT_MS,
  BIGMODEL_REGISTRATION_URL,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "./model-provider-section/constants.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import type { CodingPlanLoginOptions } from "./model-provider-section/codingPlanPricingCards.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { reportPresetSubscriptionSuccess } from "./model-provider-section/oauthActions.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "./model-provider-section/utils.js";
import {
  confirmAndDeleteModelProvider,
  refreshModelProviderSection,
  refreshProviderPanelAfterAuthChange as refreshModelProviderPanelAfterAuthChange,
} from "./model-provider-section/modelProviderActions.js";
import {
  useCodingPlanAccessRefresh,
  useCodingPlanEntitlements,
} from "./model-provider-section/useCodingPlanEntitlements.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { readCodingPlanPurchaseTokenState } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

type CodingPlanConnectionNavItem = Extract<
  ModelProviderNavGroup["items"][number],
  { type: "codingPlan" | "teamPlan" }
>;

export function resolveCodingPlanProviderSyncAttemptKey({
  accountAvailability,
  oauthProviderId,
  providerId,
}: {
  accountAvailability: OAuthAccountAvailability | null;
  oauthProviderId: OAuthProviderId;
  providerId: BuiltinModelProviderId;
}): string | null {
  const family = resolveProviderFamilyDomainFromOAuthProvider(oauthProviderId);
  if (!family || !accountAvailability?.families.includes(family)) return null;
  return `${providerId}:${accountAvailability.userId}:${accountAvailability.sessionRevision}`;
}

export function shouldRetryUnchangedCodingPlanProviderSync({
  attemptKey,
  attemptStatus,
  modeUnchanged,
  selectedKeyUnchanged,
}: {
  attemptKey: string | null;
  attemptStatus: "inFlight" | "succeeded" | "failed" | undefined;
  modeUnchanged: boolean;
  selectedKeyUnchanged: boolean;
}): boolean {
  return modeUnchanged && selectedKeyUnchanged && attemptKey !== null && attemptStatus === "failed";
}

function resolveCodingPlanIntentProviderId(
  target: SettingsModelProviderTarget | undefined,
): BuiltinModelProviderId | null {
  switch (target?.providerId) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return target.providerId;
    default:
      return null;
  }
}

function shouldRefreshCodingPlanEntitlementsAfterSave(
  previousProvider: ProviderSettingsFormProvider | undefined,
  nextProvider: ProviderSettingsFormProvider,
): boolean {
  const isCodingPlanProvider =
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    nextProvider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  if (!isCodingPlanProvider) {
    return false;
  }

  // 只比较手工 Key 配置；OAuth account access 不读取旧 Key，由账号/权益事件刷新。
  // Bugfix: enabled/name/models 这类 UI 配置不会改变权益查询凭据。
  // 之前保存任意 Coding Plan 字段都会刷新状态，导致侧栏短暂进入 loading 并冲掉当前选中。
  return (
    (previousProvider ? getProviderFormApiKey(previousProvider).trim() : "") !==
    getProviderFormApiKey(nextProvider).trim()
  );
}

function resolveBuiltinPresetOAuthProvider(
  presetId: BuiltinModelProviderId,
): OAuthProviderId | null {
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  ) {
    return ZAI_PROVIDER_ID;
  }
  if (
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return BIGMODEL_PROVIDER_ID;
  }
  return null;
}

function shouldShowPresetProviderForActiveOAuth(
  presetId: BuiltinModelProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null | undefined,
  availableFamilies: readonly ProviderFamilyDomain[] = [],
): boolean {
  const presetOAuthProvider = resolveBuiltinPresetOAuthProvider(presetId);
  if (!providerFamilyDomain || !presetOAuthProvider) {
    return true;
  }
  const family = resolveModelProviderFamilyIdByProviderId(presetId);
  return family === providerFamilyDomain || (family !== null && availableFamilies.includes(family));
}

function clearPendingProviderFamilyConnectionSelection(
  selections: ProviderFamilyConnectionSelectionSettings,
  familyId: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
): ProviderFamilyConnectionSelectionSettings {
  if (JSON.stringify(selections[familyId]) !== JSON.stringify(selection)) {
    return selections;
  }
  const { [familyId]: _removed, ...rest } = selections;
  return rest;
}

function resolveProviderFamilySideNodeKey(providerId: BuiltinModelProviderId): string | null {
  if (isStartPlanModelProviderId(providerId)) return createCodingPlanProviderNodeKey(providerId);
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  return familySpec ? createPresetProviderNodeKey(familySpec.startPlanProviderId) : null;
}

function resolveConnectionSelectionForNavItem(
  item: Extract<
    ModelProviderNavGroup["items"][number],
    { type: "preset" | "codingPlan" | "teamPlan" }
  >,
): ProviderFamilyConnectionSelection | null {
  if (item.type === "preset") return null;
  if (item.type === "teamPlan") {
    const productId = item.currentProductId?.trim() ?? "";
    const organizationId = item.organizationId?.trim() ?? "";
    const projectId = item.projectId?.trim() ?? "";
    return productId && organizationId && projectId
      ? { kind: "team-coding-plan", productId, organizationId, projectId }
      : null;
  }
  return isStartPlanModelProviderId(item.presetId) ? null : { kind: "individual-coding-plan" };
}

export function resolveModelProviderSideSelectionKey(
  item: ModelProviderNavGroup["items"][number],
): string {
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (
    item.type === "preset" ||
    (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId))
  )
    return item.key;
  return resolveProviderFamilySideNodeKey(item.presetId) ?? item.key;
}

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const { modelSelectionService, oauthService } = useServices();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const entitledAccountProviderIds = useMemo<ReadonlySet<string>>(() => {
    return new Set(
      (providerSettingsView?.providers ?? [])
        .filter(
          (provider) =>
            provider.effectiveConfig.access?.type === "zhipu-account" &&
            provider.effectiveConfig.access.entitled === true,
        )
        .map((provider) => provider.providerId),
    );
  }, [providerSettingsView]);
  const providerConnectionRefreshSignal = providerSettingsView?.revision;
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(() =>
    Boolean(
      initialModelProviderTarget && !resolveCodingPlanIntentProviderId(initialModelProviderTarget),
    ),
  );
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = resolveCodingPlanIntentProviderId(initialModelProviderTarget);
    return providerId ? resolveProviderFamilySideNodeKey(providerId) : null;
  });
  const [presetSubscriptionProviderId, setPresetSubscriptionProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanStatusSyncProviderId, setCodingPlanStatusSyncProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  const [codingPlanDisconnectProviderId, setCodingPlanDisconnectProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 死代码清理：refreshToken 只被已下线的原生购买面板消费，这里仅保留 setter 供
  // 登录/解绑后的 refreshCodingPlanProducts 契约调用（保持共享 helper 签名不变）。
  const [, setCodingPlanProductsRefreshToken] = useState(0);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider 会先发布共享快照，再异步落盘；React 在高负载下可能先提交
    // selectedNodeKey、后提交 provider 列表。导航校正会把暂时不存在的 custom key 回退，
    // 新 provider 随后出现也不会再自动选中。只在列表事实可见后完成选中与草稿清理。
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = resolveCodingPlanIntentProviderId(target);
      if (!providerId) {
        // 未知 ID 不能只静默忽略：pending 指令不消费的话，外部输入错误会困住导航。
        // 仅显示错误，保留当前可操作页面和持久连接，后续合法导航/手动选择可恢复。
        logger.warn("[ModelProviderSection] 无法打开目标供应商", { providerId: target.providerId });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(resolveProviderFamilySideNodeKey(providerId));
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) {
      return;
    }
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );
  const [accountAvailability, setAccountAvailability] = useState<OAuthAccountAvailability | null>(
    null,
  );
  const activeOAuthProvider = accountAvailability?.loginProvider ?? null;
  const codingPlanPurchaseTokenAuthenticatedByProviderId = useMemo(
    () => readCodingPlanPurchaseTokenState(accountAvailability),
    [accountAvailability],
  );
  const purchaseAuthReadSequence = useRef(0);
  const [pendingConnectionSelections, setPendingConnectionSelections] =
    useState<ProviderFamilyConnectionSelectionSettings>({});
  const presetSubscriptionCompletionProviderIdRef = useRef<BuiltinModelProviderId | null>(null);
  const codingPlanStatusSyncAttemptsRef = useRef(
    new Map<string, "inFlight" | "succeeded" | "failed">(),
  );
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setUser = useZCodeStore((state) => state.setUser);
  const oauthError = useZCodeStore((state) => state.oauthError);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const {
    settings: sharedSettings,
    loading: sharedSettingsLoading,
    error: sharedSettingsError,
    update: updateSharedSettings,
  } = useSettings();
  const authenticatedEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "bigmodel",
  });
  // zai 与 bigmodel Team Plan 对称化。原仅 bigmodel 调 hook，
  // zai 团队订阅永远拉不到、也无法展示对应团队。
  // zai 独立调 hook（zai family 走 zai provider），下游合并两 family 的订阅产品。
  const authenticatedZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      codingPlanPurchaseTokenAuthenticatedByProviderId[
        BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
      ] === true,
    authenticated: true,
    family: "zai",
  });
  const refreshAuthenticatedEnterpriseProducts = useCallback(async () => {
    await Promise.all([
      authenticatedEnterpriseProducts.refresh(),
      authenticatedZaiEnterpriseProducts.refresh(),
    ]);
  }, [authenticatedEnterpriseProducts, authenticatedZaiEnterpriseProducts]);
  const subscribedTeamProducts = useMemo(
    () => [
      ...(authenticatedEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(authenticatedZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      authenticatedEnterpriseProducts.snapshot?.productList,
      authenticatedZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  const connectionSelections = sharedSettings?.providerFamilyConnectionSelections ?? {};
  const familyConnectionSettingsFailed = sharedSettingsError !== null && sharedSettings === null;
  const effectiveConnectionSelections = useMemo(
    () => ({
      ...connectionSelections,
      ...pendingConnectionSelections,
    }),
    [connectionSelections, pendingConnectionSelections],
  );
  // 原仅检查 bigmodel selectedKey 是否为 team plan，zai team key
  // 永远不会触发已购团队 fallback（断裂）。改为任一 family 有持久化 team key 即显示。
  const showPurchasedTeamPlanFallback = Boolean(
    effectiveConnectionSelections.bigmodel?.kind === "team-coding-plan" ||
    effectiveConnectionSelections.zai?.kind === "team-coding-plan",
  );
  const effectiveProviderFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveProviderFamilyDomainFromOAuthProvider(activeOAuthProvider);
  // Start 与 Host 共用登录渠道映射：国内登录（zai_cn）未关联时付费家族为空，Start 仍属于 BigModel。
  const startPlanFamilyDomain =
    sharedSettings?.providerFamilyDomain ??
    resolveStartPlanFamilyFromOAuthProvider(activeOAuthProvider);
  const { entitlements: codingPlanEntitlements, refresh: refreshCodingPlanEntitlements } =
    useCodingPlanEntitlements({
      providerSettingsView,
      connectionSelections: effectiveConnectionSelections,
      suppressProviderFingerprintAutoRefresh: codingPlanStatusSyncProviderId !== null,
    });
  useEffect(() => {
    setPendingConnectionSelections((current) => {
      let next = current;
      for (const [familyId, selection] of Object.entries(current) as Array<
        [ProviderFamilyDomain, ProviderFamilyConnectionSelection]
      >) {
        if (JSON.stringify(connectionSelections[familyId]) !== JSON.stringify(selection)) {
          continue;
        }
        // API Key/Coding Plan tab 点击后 settings 落盘和 hook 刷新是异步的。
        // 等持久化快照真的追上再清 pending，避免旧 mode 把选中项短暂纠偏回去造成闪烁。
        next = clearPendingProviderFamilyConnectionSelection(next, familyId, selection);
      }
      return next;
    });
  }, [connectionSelections]);

  const refreshCodingPlanProducts = useCallback(() => {
    setCodingPlanProductsRefreshToken((current) => current + 1);
  }, []);

  const refreshCodingPlanPurchaseTokenState = useCallback(
    async (
      options: {
        clearUserWhenLoggedOut?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ) => {
      const sequence = ++purchaseAuthReadSequence.current;
      const availability = await oauthService.getAccountAvailability();
      if (
        sequence !== purchaseAuthReadSequence.current ||
        (options.shouldApply && !options.shouldApply())
      )
        return null;
      setAccountAvailability(availability);
      if (!availability.loginProvider && options.clearUserWhenLoggedOut) {
        setUser(null);
        setOAuthError(null);
      }
      return availability.loginProvider;
    },
    [oauthService, setOAuthError, setUser],
  );

  const refreshProviderPanelAfterAuthChange = useCallback(
    async ({
      refreshPlanSnapshots = true,
      refreshReason = "auth",
    }: {
      refreshPlanSnapshots?: boolean;
      refreshReason?: "auth" | "purchase";
    }) => {
      await refreshModelProviderPanelAfterAuthChange({
        refreshModelProviders: refresh,
        refreshCodingPlanEntitlements: () =>
          refreshCodingPlanEntitlements({ force: true, reason: refreshReason }),
        refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
        refreshCodingPlanProducts,
        refreshPurchaseTokenState: refreshCodingPlanPurchaseTokenState,
        refreshPlanSnapshots,
      });
    },
    [
      refresh,
      refreshAuthenticatedEnterpriseProducts,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
      refreshModelProviderPanelAfterAuthChange,
    ],
  );

  const syncCodingPlanProviderOnce = useCallback(
    async (
      item: CodingPlanConnectionNavItem,
      options: { userTransition?: boolean; refreshPlanSnapshots?: boolean } = {},
    ) => {
      const attemptKey = resolveCodingPlanProviderSyncAttemptKey({
        accountAvailability,
        oauthProviderId: item.oauthProviderId,
        providerId: item.presetId,
      });
      if (!attemptKey) {
        return;
      }
      if (
        options.userTransition !== true &&
        codingPlanStatusSyncAttemptsRef.current.has(attemptKey)
      ) {
        return;
      }
      codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "inFlight");
      setCodingPlanStatusSyncProviderId(item.presetId);
      try {
        await refreshProviderPanelAfterAuthChange({
          refreshPlanSnapshots: options.refreshPlanSnapshots,
        });
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "succeeded");
      } catch (error) {
        // 失败状态必须显式保留。自动水合看到 failed 后不循环重试，
        // 用户再次点击同一连接项时则可以按 failed 状态主动恢复。
        codingPlanStatusSyncAttemptsRef.current.set(attemptKey, "failed");
        throw error;
      } finally {
        setCodingPlanStatusSyncProviderId((current) =>
          current === item.presetId ? null : current,
        );
      }
    },
    [accountAvailability, refreshProviderPanelAfterAuthChange],
  );

  useEffect(() => {
    let disposed = false;

    void refreshCodingPlanPurchaseTokenState({
      shouldApply: () => !disposed,
    });

    return () => {
      disposed = true;
    };
  }, [providerConnectionRefreshSignal, refreshCodingPlanPurchaseTokenState]);

  const presetProviders = useMemo(
    () =>
      PRESET_PROVIDER_SPECS.filter((preset) =>
        shouldShowPresetProviderForActiveOAuth(
          preset.id,
          effectiveProviderFamilyDomain,
          accountAvailability?.families,
        ),
      ).map((preset) => ({
        ...preset,
        provider: modelProviders.find((provider) => provider.providerId === preset.id) ?? null,
      })),
    [effectiveProviderFamilyDomain, accountAvailability, modelProviders],
  );

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const accountEntitled = Boolean(
      resolveEntitledAccountProviderAccess(providerSettingsView, presetSubscriptionProviderId),
    );
    if (accountEntitled) {
      if (presetSubscriptionCompletionProviderIdRef.current === presetSubscriptionProviderId) {
        return;
      }

      presetSubscriptionCompletionProviderIdRef.current = presetSubscriptionProviderId;
      void (async () => {
        void reportPresetSubscriptionSuccess({
          platform,
          presetId: presetSubscriptionProviderId,
        });
        try {
          // Bugfix: 连接/重新授权成功后账号连接状态会先于本轮权益接口结果就绪。
          // pending 必须等本轮权益刷新完成后再清，否则 Plan Card 会短暂显示旧套餐态或非 loading 状态。
          await refreshProviderPanelAfterAuthChange({});
        } finally {
          presetSubscriptionCompletionProviderIdRef.current = null;
          setCodingPlanStatusSyncProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
          setPresetSubscriptionProviderId((current) =>
            current === presetSubscriptionProviderId ? null : current,
          );
        }
      })();
    }
  }, [
    platform,
    presetSubscriptionProviderId,
    providerSettingsView,
    refreshProviderPanelAfterAuthChange,
  ]);

  useEffect(() => {
    if (!presetSubscriptionProviderId) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setCodingPlanStatusSyncProviderId((current) =>
        current === presetSubscriptionProviderId ? null : current,
      );
      setPresetSubscriptionProviderId((current) => {
        if (current !== presetSubscriptionProviderId) {
          return current;
        }
        return null;
      });
    }, PRESET_SUBSCRIPTION_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [presetSubscriptionProviderId]);

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      presetProviders,
      modelProviders,
      entitledAccountProviderIds,
      modelProvidersLoading: loading,
      displayOrder,
      codingPlanEntitlements,
      subscribedTeamProducts,
      providerFamilyDomain: effectiveProviderFamilyDomain,
      startPlanFamilyDomain,
      availableFamilies: accountAvailability?.families,
      connectionSelections: effectiveConnectionSelections,
      pendingConnectionSelections,
      showPurchasedTeamPlanFallback,
      familyConnectionSettingsLoading: sharedSettingsLoading && sharedSettings === null,
      familyConnectionSettingsFailed,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });
  const selectedPlanAccessKey =
    selectedNavItem?.type === "codingPlan" || selectedNavItem?.type === "teamPlan"
      ? selectedNavItem.key
      : null;
  // 套餐卡每次被用户打开时按需校正；共享 freshness window 保证一分钟内切换返回
  // 不会放大 quota 请求。权益展示更新不等于用户重新打开套餐。
  useCodingPlanAccessRefresh({
    refresh: refreshCodingPlanEntitlements,
    selectedPlanKey: selectedPlanAccessKey,
  });

  useEffect(() => {
    if (selectedNavItem?.type !== "codingPlan" && selectedNavItem?.type !== "teamPlan") {
      return;
    }
    if (
      codingPlanPurchaseTokenAuthenticatedByProviderId[selectedNavItem.presetId] !== true ||
      presetSubscriptionProviderId === selectedNavItem.presetId ||
      codingPlanDisconnectProviderId === selectedNavItem.presetId
    ) {
      return;
    }

    const accountEntitled = selectedNavItem.accountEntitled === true;
    if (accountEntitled) {
      return;
    }

    // 这是首次水合校正，不是由详情 status 驱动的状态机。
    // 同一 provider/OAuth 组合只执行一次，checking 与最终状态来回切换不能重启刷新。
    void syncCodingPlanProviderOnce(selectedNavItem).catch((error) => {
      logger.warn("[ModelProviderSection] 自动同步 Coding Plan provider 失败", {
        providerId: selectedNavItem.presetId,
        error,
      });
    });
  }, [
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    codingPlanDisconnectProviderId,
    presetSubscriptionProviderId,
    selectedNavItem,
    syncCodingPlanProviderOnce,
  ]);

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        const previousProvider = modelProviders.find(
          (provider) => provider.providerId === config.providerId,
        );
        // 配置不可执行不是用户退出账号；保存不得顺带清空账号域，否则套餐再选也无法就绪。
        await saveProvider(config);
        if (shouldRefreshCodingPlanEntitlementsAfterSave(previousProvider, config)) {
          refreshCodingPlanEntitlements();
        }
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [modelProviders, refreshCodingPlanEntitlements, saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleCodingPlanLogin = useCallback(
    (
      presetId: BuiltinModelProviderId,
      providerId: OAuthProviderId,
      providerName: string,
      status: CodingPlanStatus,
      options?: CodingPlanLoginOptions,
    ) => {
      setPresetSubscriptionProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      logger.info("[ModelProviderSection] 请求通过统一登录入口登录并连接 Coding Plan", {
        presetId,
        providerId,
        providerName,
        status,
        forceOAuth: options?.forceOAuth === true,
      });
      void (async () => {
        let availability = accountAvailability;
        const family = resolveProviderFamilyDomainFromOAuthProvider(providerId);
        if (
          options?.forceOAuth !== true &&
          family &&
          !availability?.families.includes(family) &&
          availability?.loginProvider
        ) {
          try {
            availability = await oauthService.refreshAccountProfile();
            setAccountAvailability(availability);
          } catch (error) {
            logger.warn("[ModelProviderSection] 补关联失败，保留当前登录", {
              name: error instanceof Error ? error.name : "unknown",
            });
          }
        }
        if (options?.forceOAuth !== true && family && availability?.families.includes(family)) {
          try {
            await refreshProviderPanelAfterAuthChange({});
          } finally {
            setPresetSubscriptionProviderId((current) => (current === presetId ? null : current));
            setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
          }
          return;
        }
        const provider = availability?.loginProvider;
        requestLoginEntry(provider && isZaiOAuthProvider(provider) ? provider : undefined);
      })().catch((error) =>
        logger.warn("[ModelProviderSection] 连接套餐失败", {
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
    },
    [accountAvailability, oauthService, refreshProviderPanelAfterAuthChange, requestLoginEntry],
  );

  const handleCodingPlanDisconnect = useCallback(
    async (presetId: BuiltinModelProviderId, providerId: OAuthProviderId, providerName: string) => {
      if (providerId !== BIGMODEL_PROVIDER_ID && providerId !== ZAI_PROVIDER_ID) {
        return;
      }

      setCodingPlanDisconnectProviderId(presetId);
      setCodingPlanStatusSyncProviderId(presetId);
      try {
        logger.info("[ModelProviderSection] 请求解绑 Coding Plan provider", {
          presetId,
          providerId,
          providerName,
        });
        // ZAI/BigModel provider 已恢复为 App 登录镜像。
        // 这里的 Unlink 必须走 provider logout，退出当前 active provider 并触发另一组 provider 恢复 Connect。
        const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
          currentDomain: sharedSettings?.providerFamilyDomain,
        });
        await oauthService.logout();
        // Coding Plan 官网 webview 使用独立持久 partition，provider Unlink 也属于账号边界。
        if (typeof platform.executeDesktopCommand === "function") {
          await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
        }
        await updateSharedSettings({
          providerFamilyDomain: (nextProviderFamilyDomain ?? "") as never,
          providerFamilyDomainUpdatedAt: Date.now(),
          providerFamilyDomainMigrated: true,
        });
        await refreshCodingPlanPurchaseTokenState({ clearUserWhenLoggedOut: true });
        await refresh();
        // 解绑后 batch-preview 的订阅/鉴权态已经失效，套餐卡片内部缓存必须刷新，
        // 否则按钮会继续沿用解绑前的 purchased 或 authenticated 状态。
        refreshCodingPlanProducts();
        // unlink 前的 React 闭包里仍可能保留旧 Start/Coding provider key。
        // 解绑按钮只等待本地 logout 和 provider 列表刷新；权益 hook 会在新 provider 快照落地后清空旧状态。
      } catch (error) {
        logger.error("[ModelProviderSection] 解绑 Coding Plan provider 失败", {
          presetId,
          providerId,
          providerName,
          error,
        });
      } finally {
        setCodingPlanDisconnectProviderId((current) => (current === presetId ? null : current));
        setCodingPlanStatusSyncProviderId((current) => (current === presetId ? null : current));
      }
    },
    [
      oauthService,
      platform,
      updateSharedSettings,
      sharedSettings?.providerFamilyDomain,
      modelSelectionService,
      refresh,
      refreshCodingPlanEntitlements,
      refreshCodingPlanProducts,
      refreshCodingPlanPurchaseTokenState,
    ],
  );

  const persistProviderFamilyModeForNavItem = useCallback(
    async (item: (typeof navigationItems)[number]) => {
      if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
        return;
      }
      const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
      if (!familySpec) {
        return;
      }
      const selection = resolveConnectionSelectionForNavItem(item);
      if (!selection) return;
      const selectionUnchanged =
        JSON.stringify(connectionSelections[familySpec.id]) === JSON.stringify(selection);
      // 同套餐仍可能缺少持久账号域；用户重选必须补齐，不能用页面展示兜底值去重。
      const modeUnchanged = sharedSettings?.providerFamilyDomain === familySpec.id;
      const selectedKeyUnchanged = selectionUnchanged;
      const planSyncAttemptKey =
        item.type === "codingPlan" || item.type === "teamPlan"
          ? resolveCodingPlanProviderSyncAttemptKey({
              accountAvailability,
              oauthProviderId: item.oauthProviderId,
              providerId: item.presetId,
            })
          : null;
      if (modeUnchanged && selectedKeyUnchanged) {
        const isPlanItem = item.type === "codingPlan" || item.type === "teamPlan";
        const planSyncAttemptStatus = planSyncAttemptKey
          ? codingPlanStatusSyncAttemptsRef.current.get(planSyncAttemptKey)
          : undefined;
        if (
          isPlanItem &&
          shouldRetryUnchangedCodingPlanProviderSync({
            attemptKey: planSyncAttemptKey,
            attemptStatus: planSyncAttemptStatus,
            modeUnchanged,
            selectedKeyUnchanged,
          })
        ) {
          try {
            await syncCodingPlanProviderOnce(item, {
              userTransition: true,
              refreshPlanSnapshots: false,
            });
          } catch (error) {
            logger.warn("[ModelProviderSection] 重试同步 Coding Plan provider 失败", {
              providerId: item.presetId,
              error,
            });
          }
        }
        return;
      }
      setPendingConnectionSelections((current) => ({
        ...current,
        [familySpec.id]: selection,
      }));
      if (planSyncAttemptKey) {
        // pending state 会先触发渲染；先占位，避免水合 effect 在设置落盘前重复发起同步。
        codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "inFlight");
      }
      try {
        await updateSharedSettings(
          {
            providerFamilyDomain: familySpec.id,
            providerFamilyDomainUpdatedAt: Date.now(),
            providerFamilyDomainMigrated: true,
            providerFamilyConnectionSelections: {
              ...sharedSettings?.providerFamilyConnectionSelections,
              [familySpec.id]: selection,
            },
          },
          {
            // 原因：页面快照可能落后其它窗口；不能把展示/待提交映射当作锁内预期。
            providerFamilyDomain: sharedSettings?.providerFamilyDomain,
            providerFamilyConnectionSelections: sharedSettings?.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: sharedSettings?.providerFamilyDomainUpdatedAt ?? 0,
          },
        );
        if (item.type === "codingPlan" || item.type === "teamPlan") {
          // 用户动作拥有连接方式 transition：设置落盘后只刷新一次目标 Plan provider。
          await syncCodingPlanProviderOnce(item, {
            userTransition: true,
            refreshPlanSnapshots: false,
          });
        }
      } catch (error) {
        if (planSyncAttemptKey) {
          // 设置落盘或后续 provider 同步失败时必须允许同项重试。
          codingPlanStatusSyncAttemptsRef.current.set(planSyncAttemptKey, "failed");
        }
        logger.warn("[ModelProviderSection] 保存模型供应商连接方式失败", {
          familyId: familySpec.id,
          error,
        });
        setPendingConnectionSelections((current) =>
          clearPendingProviderFamilyConnectionSelection(current, familySpec.id, selection),
        );
      }
    },
    [
      accountAvailability,
      connectionSelections,
      sharedSettings,
      syncCodingPlanProviderOnce,
      updateSharedSettings,
    ],
  );

  const handleSelectNavItem = useCallback((item: (typeof navigationItems)[number]) => {
    setInvalidProviderTarget(false);
    setSelectedNodeKey(resolveModelProviderSideSelectionKey(item));
    setTemplatePickerOpen(false);
  }, []);

  const handleSelectConnectionItem = useCallback(
    (item: (typeof navigationItems)[number]) => {
      handleSelectNavItem(item);
      void persistProviderFamilyModeForNavItem(item);
    },
    [handleSelectNavItem, persistProviderFamilyModeForNavItem],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        // Provider 模板名只有中英两套，非中文界面语言用英文名。
        const created = await createPersonalProvider({ ...input, locale: toZhOrEnLocale(locale) });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings" || !marketingRequest.target.provider_id)
      return;
    if (
      loading ||
      modelProvidersRefreshing ||
      sharedSettingsLoading ||
      navigationItems.some((item) => item.type === "codingPlanLoading")
    )
      return;
    const providerId = marketingRequest.target.provider_id;
    const item = navigationItems.find((item) =>
      item.type === "custom"
        ? // 当前表单契约使用 providerId；旧 id 会让所有自定义提供商被误判为不存在。
          item.provider.providerId === providerId
        : "presetId" in item &&
          item.presetId === providerId &&
          (!isStartPlanModelProviderId(providerId) || item.type === "codingPlan"),
    );
    if (!item) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_provider_unavailable"));
      return;
    }
    const key = resolveModelProviderSideSelectionKey(item);
    if (selectedNodeKey !== key) {
      // 只定位侧栏节点；禁止复用带 mode 的选择路径，避免营销导航修改套餐连接。
      setSelectedNodeKey(key);
    } else if (selectedNavItem) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [
    marketingRequest,
    loading,
    modelProvidersRefreshing,
    sharedSettingsLoading,
    navigationItems,
    selectedNodeKey,
    selectedNavItem,
  ]);

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // 首屏慢网时之前直接 return null，导致整块模型供应商页空白，
  // 已有的左侧分组 loading 和刷新按钮 loading 都没有机会渲染。
  // 这里改为始终先渲染布局壳子，再按分组展示 loading，避免用户误以为页面坏了。
  const presetLoading = loading || modelProvidersRefreshing;
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={presetLoading}
      customLoading={customLoading}
      onRefresh={() => {
        void (async () => {
          try {
            await oauthService.refreshAccountProfile();
          } catch (error) {
            logger.warn("[ModelProviderSection] 补关联失败，继续刷新已有套餐", {
              name: error instanceof Error ? error.name : "unknown",
            });
          }
          await refreshCodingPlanPurchaseTokenState();
          await refreshModelProviderSection({
            refresh,
            refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
          });
          await refreshCodingPlanEntitlements();
        })().catch((error) =>
          logger.warn("[ModelProviderSection] 刷新套餐失败", {
            name: error instanceof Error ? error.name : "unknown",
          }),
        );
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={handleSelectNavItem}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : (
        <ModelProviderSectionDetail
          connectionSelections={effectiveConnectionSelections}
          activeProviderFamily={effectiveProviderFamilyDomain}
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          navigationItems={navigationItems}
          connectionSettingsFailed={familyConnectionSettingsFailed}
          startPlanSubscriptionCount={(() => {
            const providerId =
              selectedNavItem && "presetId" in selectedNavItem ? selectedNavItem.presetId : null;
            const family = providerId
              ? resolveModelProviderFamilySpecByProviderId(providerId)
              : null;
            const entitlement = family ? codingPlanEntitlements[family.startPlanProviderId] : null;
            // 只展示当前 Family 已查询到的权益，不用当前是否选中 Start 代替拥有数量。
            return entitlement?.error
              ? 0
              : (entitlement?.snapshot?.subscription?.details.length ?? 0);
          })()}
          presetLoading={presetLoading}
          codingPlanAuthError={oauthError}
          codingPlanPurchaseTokenAuthenticatedByProviderId={
            codingPlanPurchaseTokenAuthenticatedByProviderId
          }
          presetSubscriptionProviderId={presetSubscriptionProviderId}
          codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
          codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          // Provider 的左栏排序权限被误复用成模型排序门禁，导致 Built-in / Account
          // Provider 的 Effective 模型无法写入 Personal modelOrder。模型调序独立于成员来源。
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onCodingPlanLogin={handleCodingPlanLogin}
          onRetryCodingPlan={() => {
            // 取 Key 失败不等于登录失效；沿用 Host 手动刷新，不清除 OAuth 或重新登录。
            logger.info("[ModelProviderSection] 重试获取套餐状态");
            return refresh().then(() =>
              refreshCodingPlanEntitlements({ force: true, reason: "manual" }),
            );
          }}
          onCodingPlanDisconnect={handleCodingPlanDisconnect}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
          onSelectNavItem={handleSelectConnectionItem}
          onOpenBigModelRegistration={() => {
            // 未注册提示来自一次失败的 OAuth checking 状态；跳转注册后要恢复普通状态，避免提示卡住。
            setOAuthError(null);
            setPresetSubscriptionProviderId((current) =>
              current === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? null : current,
            );
            platform.openExternal(BIGMODEL_REGISTRATION_URL);
          }}
          onCodingPlanPurchaseComplete={async () => {
            await refreshProviderPanelAfterAuthChange({ refreshReason: "purchase" });
          }}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
