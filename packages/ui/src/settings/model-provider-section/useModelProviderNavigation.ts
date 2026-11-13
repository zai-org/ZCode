/* eslint-disable max-lines -- Model Provider 导航需要集中计算分组、选中项与 Coding Plan 权益态，后续拆分时再收敛。 */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type {
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  type OAuthProviderId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  type CodingPlanEntitlementState,
  type ModelProviderNavGroup,
  type PresetProviderSpec,
} from "@/settings/model-provider-section/constants.js";
import { pickCodingPlanEntitlementProvider } from "@/lib/codingPlanProvider.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  buildVisibleFamilyConnectionItems,
  resolveCodingPlanEntitlementState,
} from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";

const NO_FAMILIES: readonly ProviderFamilyDomain[] = [];

interface PresetProviderWithConfig extends PresetProviderSpec {
  provider: ProviderSettingsFormProvider | null;
}

interface UseModelProviderNavigationOptions {
  presetProviders: PresetProviderWithConfig[];
  modelProviders: ProviderSettingsFormProvider[];
  /**
   * 当前账号明确有权益的 Provider。缺省等价于尚无账号权益；生产设置页始终显式传入。
   */
  entitledAccountProviderIds?: ReadonlySet<string>;
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  providerFamilyDomain?: ProviderFamilyDomain | null;
  /** Start 所属家族；国内登录未关联时 providerFamilyDomain 为空，仍由登录渠道确定唯一 Start。 */
  startPlanFamilyDomain?: ProviderFamilyDomain | null;
  availableFamilies?: readonly ProviderFamilyDomain[];
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  subscribedTeamProducts?: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback?: boolean;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  presetProviders,
  modelProviders,
  entitledAccountProviderIds = new Set(),
  modelProvidersLoading = false,
  displayOrder,
  codingPlanEntitlements = {},
  providerFamilyDomain = null,
  startPlanFamilyDomain = providerFamilyDomain,
  availableFamilies = NO_FAMILIES,
  connectionSelections = {},
  pendingConnectionSelections = {},
  familyConnectionSettingsLoading = false,
  familyConnectionSettingsFailed = false,
  subscribedTeamProducts = [],
  showPurchasedTeamPlanFallback = false,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // 这里复用模型菜单的展示排序，确保设置页和聊天框供应商顺序一致。
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const codingPlanItems = useMemo(
    () =>
      CODING_PLAN_PROVIDER_SPECS.filter((spec) =>
        shouldShowCodingPlanForProviderFamilyDomain(
          spec.oauthProviderId,
          // Bug 原因：国内无关联账号家族为空，Start 走“全部显示”分支，出现两个 Start 入口。
          isStartPlanModelProviderId(spec.id) ? startPlanFamilyDomain : providerFamilyDomain,
          availableFamilies,
        ),
      ).map((spec) => {
        const provider = modelProviders.find((item) => item.providerId === spec.id) ?? null;
        const accountEntitled = entitledAccountProviderIds.has(spec.id);
        const entitlementProvider = pickCodingPlanEntitlementProvider(provider);
        const entitlement = codingPlanEntitlements[spec.id];
        const state = resolveCodingPlanEntitlementState({
          providerId: spec.id,
          accountEntitled,
          accountAvailability: provider?.accountState?.availability,
          accountUnavailableReason: provider?.accountState?.unavailableReason,
          entitlement,
          modelProvidersLoading,
        });

        return {
          key: createCodingPlanProviderNodeKey(spec.id),
          type: "codingPlan" as const,
          presetId: spec.id,
          oauthProviderId: spec.oauthProviderId,
          label: isStartPlanModelProviderId(spec.id)
            ? "Start Plan"
            : `${spec.providerName} - ${intl.formatMessage({
                id: "settings.modelProvider.connectionMode.codingPlan",
              })}`,
          providerName: spec.providerName,
          provider: entitlementProvider,
          accountEntitled,
          status: state.status,
          statusLabelId: state.statusLabelId,
          ...(isStartPlanModelProviderId(spec.id) &&
          entitlement?.snapshot?.unavailableReason === "not_authenticated"
            ? {
                accountLoginRequired: true,
                statusLabelId: "settings.modelProvider.startPlan.status.loginExpired",
              }
            : {}),
          planLevel: state.planLevel,
          currentProductId: state.currentProductId,
          subscriptionBillingCycle: state.subscriptionBillingCycle,
          subscriptionRenewTime: state.subscriptionRenewTime,
          subscriptionExpireTime: state.subscriptionExpireTime,
          subscriptionDetails: state.subscriptionDetails,
          quotaLimits: state.quotaLimits,
          mcpQuotaLimit: state.mcpQuotaLimit ?? null,
          purchaseUrl: spec.purchaseUrl,
          statusActive: entitlementProvider?.executable === true,
        };
      }),
    [
      entitledAccountProviderIds,
      codingPlanEntitlements,
      intl,
      modelProviders,
      modelProvidersLoading,
      providerFamilyDomain,
      startPlanFamilyDomain,
      availableFamilies,
    ],
  );
  const connectionModeCodingPlanItems = useMemo(
    () =>
      buildVisibleFamilyConnectionItems({
        items: codingPlanItems.filter((item) => !isStartPlanModelProviderId(item.presetId)),
        codingPlanEntitlements,
        subscribedTeamProducts,
        showPurchasedTeamPlanFallback,
        connectionSelections: {
          ...connectionSelections,
          ...pendingConnectionSelections,
        },
        teamPlanSelections: Object.fromEntries(
          Object.entries({ ...connectionSelections, ...pendingConnectionSelections }).filter(
            ([, selection]) => selection?.kind === "team-coding-plan",
          ),
        ),
      }),
    [
      codingPlanEntitlements,
      showPurchasedTeamPlanFallback,
      codingPlanItems,
      connectionSelections,
      pendingConnectionSelections,
      subscribedTeamProducts,
    ],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    const groups: ModelProviderNavGroup[] = [
      {
        id: "preset",
        title: intl.formatMessage({ id: "settings.modelProvider.presetTitle" }),
        items: [
          ...presetProviders.map(({ id, displayName, provider }) => {
            const statusProvider = resolvePresetFamilyStatusProvider({
              presetId: id,
              provider,
              connectionModeItems: connectionModeCodingPlanItems,
              connectionSelections,
              modelProviders,
            });
            return {
              key: createPresetProviderNodeKey(id),
              type: "preset" as const,
              presetId: id,
              label: displayName,
              logo: modelProviders.find(
                (candidate) =>
                  candidate.providerId ===
                  resolveModelProviderFamilySpecByProviderId(id)?.individualCodingPlanProviderId,
              )?.config.logo,
              provider,
              displayName,
              statusProvider,
              statusActive: statusProvider?.executable === true,
            };
          }),
          ...codingPlanItems.filter((item) => isStartPlanModelProviderId(item.presetId)),
        ],
      },
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ];

    return groups;
  }, [
    customProviders,
    codingPlanItems,
    connectionModeCodingPlanItems,
    // 左侧导航分组标题在这个 memo 内格式化。
    // 语言切换时 provider/权益引用可能不变，必须依赖 intl 才能刷新旧 locale 的文案。
    intl,
    connectionSelections,
    pendingConnectionSelections,
    presetProviders,
    modelProviders,
  ]);

  const navigationItems = useMemo(() => {
    const visibleItems = navigationGroups.flatMap((group) => group.items);
    const visibleKeys = new Set(visibleItems.map((item) => item.key));
    return [
      ...visibleItems,
      ...connectionModeCodingPlanItems.filter((item) => !visibleKeys.has(item.key)),
    ];
  }, [connectionModeCodingPlanItems, navigationGroups]);

  const selectableNavigationItems = useMemo(
    () => navigationItems.filter((item) => item.type !== "codingPlanLoading"),
    [navigationItems],
  );
  const selectableSideNavigationItems = useMemo(
    () =>
      navigationGroups
        .flatMap((group) => group.items)
        .filter((item) => item.type !== "codingPlanLoading"),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(selectableNavigationItems.map((item) => [item.key, item])),
    [selectableNavigationItems],
  );
  const sideNavigationItemByKey = useMemo(
    () => new Map(selectableSideNavigationItems.map((item) => [item.key, item])),
    [selectableSideNavigationItems],
  );

  const selectedNavItem = selectedNodeKey
    ? resolveSelectedProviderFamilyConnectionItem({
        selectedNodeKey,
        navigationItemByKey,
        selectableNavigationItems,
        connectionSelections,
        pendingConnectionSelections,
        familyConnectionSettingsLoading,
        familyConnectionSettingsFailed,
        modelProvidersLoading,
      })
    : null;

  const requestedItem = selectedNodeKey ? navigationItemByKey.get(selectedNodeKey) : undefined;
  const requestedFamily =
    requestedItem?.type === "preset"
      ? resolveModelProviderFamilySpecByProviderId(requestedItem.presetId)
      : null;
  const requestedSelection = requestedFamily ? connectionSelections[requestedFamily.id] : undefined;
  const navigationUnavailable =
    !modelProvidersLoading &&
    !familyConnectionSettingsLoading &&
    (familyConnectionSettingsFailed ||
      Boolean(
        requestedFamily &&
        requestedSelection &&
        requestedSelection.kind !== "start-plan" &&
        !selectableNavigationItems.some((item) =>
          connectionSelectionMatchesNavigationItem(requestedFamily.id, requestedSelection, item),
        ),
      ));

  const fallbackNodeKey = resolveFallbackModelProviderNodeKey({
    selectedNodeKey,
    selectableNavigationItems,
  });
  useEffect(() => {
    const hasSelectedNode = selectedNodeKey ? sideNavigationItemByKey.has(selectedNodeKey) : false;
    if (hasSelectedNode) {
      return;
    }

    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [
    fallbackNodeKey,
    selectedNavItem,
    selectedNodeKey,
    setSelectedNodeKey,
    sideNavigationItemByKey,
  ]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
  };
}

function shouldShowCodingPlanForProviderFamilyDomain(
  oauthProviderId: OAuthProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null,
  availableFamilies: readonly ProviderFamilyDomain[],
): boolean {
  if (!providerFamilyDomain) {
    return true;
  }
  const family = resolveProviderFamilyDomainFromOAuthProvider(oauthProviderId);
  return family === providerFamilyDomain || (family !== null && availableFamilies.includes(family));
}

function resolvePresetFamilyStatusProvider({
  presetId,
  provider,
  connectionModeItems,
  connectionSelections,
  modelProviders,
}: {
  presetId: PresetProviderSpec["id"];
  provider: ProviderSettingsFormProvider | null;
  connectionModeItems: ModelProviderNavGroup["items"];
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  modelProviders: ProviderSettingsFormProvider[];
}): ProviderSettingsFormProvider | null {
  const familySpec = resolveModelProviderFamilySpecByProviderId(presetId);
  if (!familySpec) {
    return provider;
  }
  const connectionItem = pickFamilyModeNavigationItem(
    connectionModeItems.filter((item) => item.type !== "codingPlanLoading"),
    familySpec.id,
    connectionSelections,
  );
  if (!connectionItem || !isPlanConnectionNavigationItem(connectionItem)) {
    return null;
  }
  // 菜单 Team 项可能从个人项派生，携带的 provider 不是团队执行身份。
  // 必须按具体套餐 ID 回到 Settings View，不能用菜单权益或继承的 provider 点灯。
  return (
    modelProviders.find((candidate) => candidate.providerId === connectionItem.presetId) ?? null
  );
}

export function resolveFallbackModelProviderNodeKey({
  selectedNodeKey,
  selectableNavigationItems,
}: {
  selectedNodeKey: string | null;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
}): string | null {
  const initialConnectionItem = pickInitialConnectionNavigationItem(selectableNavigationItems);
  const initialSideNodeKey = initialConnectionItem
    ? resolveSideNavigationNodeKeyForConnectionItem(initialConnectionItem)
    : null;
  if (isFamilyPresetNodeKey(selectedNodeKey) && initialSideNodeKey) {
    // App OAuth 登录成功后会按 active provider 隐藏另一组预置入口。
    // 当前选中项消失时使用初始化优先级回落到对应 family，而不是把连接方式塞回侧栏。
    return initialSideNodeKey;
  }

  // 初始化只在没有有效选中项时发生；如果当前用户选择仍有效，上层 effect 不会调用 fallback 抢焦点。
  return (
    initialSideNodeKey ??
    resolveSideNavigationNodeKeyForConnectionItem(selectableNavigationItems[0] ?? null)
  );
}

function resolveSelectedProviderFamilyConnectionItem({
  selectedNodeKey,
  navigationItemByKey,
  selectableNavigationItems,
  connectionSelections,
  pendingConnectionSelections,
  familyConnectionSettingsLoading,
  familyConnectionSettingsFailed,
  modelProvidersLoading,
}: {
  selectedNodeKey: string;
  navigationItemByKey: Map<
    string,
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  modelProvidersLoading?: boolean;
}): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const selectedItem = navigationItemByKey.get(selectedNodeKey) ?? null;
  if (!selectedItem) {
    return null;
  }
  if (selectedItem.type !== "preset") {
    return selectedItem;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedItem.presetId);
  if (!familySpec) {
    return selectedItem;
  }
  if (familyConnectionSettingsLoading) {
    // 从外部入口打开 Model Settings 时，settings 首次 hydrate 前不能按默认 oauth
    // 连接方式推导 Start Plan，否则右侧连接方式会先闪成 Start 再按已保存设置纠偏。
    return null;
  }
  const mergedSelections = { ...connectionSelections, ...pendingConnectionSelections };
  const resolvedItem =
    !familyConnectionSettingsFailed &&
    pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, mergedSelections);
  if (resolvedItem) {
    return resolvedItem;
  }
  if (modelProvidersLoading) return null;
  // 非法/过期连接只影响当前设置页的落点，不能让 null 被详情页当作永久 loading。
  // 不写回 Family 偏好，不改会话 Selection；用户可在这个同 Family 页面重新选择。
  return pickInitialConnectionNavigationItem(
    selectableNavigationItems.filter(
      (item) =>
        "presetId" in item &&
        resolveModelProviderFamilySpecByProviderId(item.presetId)?.id === familySpec.id,
    ),
  );
}

function resolveSideNavigationNodeKeyForConnectionItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null,
): string | null {
  if (!item) {
    return null;
  }
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) return item.key;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
  if (!familySpec) {
    return item.key;
  }
  return createPresetProviderNodeKey(familySpec.startPlanProviderId);
}

function pickInitialConnectionNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const planItems = selectableNavigationItems.filter(isPlanConnectionNavigationItem);
  const personalCodingPlanItem = planItems.find(
    (item) =>
      item.type === "codingPlan" &&
      !isStartPlanModelProviderId(item.presetId) &&
      item.status === "purchased",
  );
  if (personalCodingPlanItem) {
    return personalCodingPlanItem;
  }
  const teamPlanItem = planItems.find((item) => item.type === "teamPlan");
  if (teamPlanItem) {
    return teamPlanItem;
  }
  const personalCodingPlanFallback = planItems.find(
    (item) => item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId),
  );
  if (personalCodingPlanFallback) {
    return personalCodingPlanFallback;
  }
  if (planItems[0]) {
    return planItems[0];
  }
  return selectableNavigationItems.find((item) => item.type === "preset") ?? null;
}

function pickFamilyModeNavigationItem(
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >,
  familyId: "zai" | "bigmodel",
  connectionSelections: ProviderFamilyConnectionSelectionSettings,
): Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }> | null {
  const selection = connectionSelections[familyId];
  if (!selection) return null;
  return (
    selectableNavigationItems.find((item) =>
      connectionSelectionMatchesNavigationItem(familyId, selection, item),
    ) ?? null
  );
}

export function resolveSelectedFamilyModeNodeKey({
  selectedNavItem,
  selectableNavigationItems,
  connectionSelections = {},
  pendingConnectionSelections = {},
}: {
  selectedNavItem: Exclude<
    ModelProviderNavGroup["items"][number],
    { type: "codingPlanLoading" }
  > | null;
  selectableNavigationItems: Array<
    Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>
  >;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): string | null {
  if (
    selectedNavItem?.type !== "preset" &&
    selectedNavItem?.type !== "codingPlan" &&
    selectedNavItem?.type !== "teamPlan"
  ) {
    return null;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
  if (!familySpec) {
    return null;
  }
  const savedItem = pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, {
    ...connectionSelections,
    ...pendingConnectionSelections,
  });
  return savedItem && savedItem.key !== selectedNavItem.key ? savedItem.key : null;
}

export function connectionSelectionMatchesNavigationItem(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): boolean {
  if (item.type === "custom") return false;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId ?? "");
  if (familySpec?.id !== family) return false;
  if (selection.kind === "start-plan") {
    return false;
  }
  if (selection.kind === "individual-coding-plan") {
    return (
      item.type === "codingPlan" && item.presetId === familySpec.individualCodingPlanProviderId
    );
  }
  return (
    item.type === "teamPlan" &&
    item.presetId === familySpec.teamCodingPlanProviderId &&
    // 团队连接按平台、组织和项目定位；订阅商品会在权益快照和 pricing 校正间变化。
    // 不能把同项目的商品更新误判为连接丢失，否则初始化会出现空选项和错误提示。
    item.organizationId === selection.organizationId &&
    item.projectId === selection.projectId
  );
}

function isPlanConnectionNavigationItem(
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): item is Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" | "teamPlan" }> {
  return (
    (item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId)) ||
    item.type === "teamPlan"
  );
}

function isFamilyPresetNodeKey(nodeKey: string | null): boolean {
  return (
    nodeKey?.startsWith("coding-plan:") === true ||
    nodeKey?.startsWith("team:") === true ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan}` ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`
  );
}
