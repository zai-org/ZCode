/* oxlint-disable eslint(max-lines) -- V4ComposerToolbar 汇聚模型/思考深度/context usage 三件套；继续拆分会打散工具条热键与模型目录 memo 的共享状态。 */
/**
 * V4 composer 工具条。
 *
 * 展示件全部复用旧 chat-input-toolbar 的纯 props 组件（ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage），外观与旧
 * ChatInputToolbar 对齐；但状态编排是全新 v4 wiring，不复活旧 ChatInputToolbar 的
 * effect 链 / 旧协议写路径：
 * - 当前模型/档位来自 Composer；已运行会话的用量来自 snapshot.usage.contextWindow
 * - 模型、思考深度和模式只更新下一次 Submission 的 Composer 意图
 * - 模型静态事实来自目标 Host ModelSelectionView；workspace configOptions 只提供
 *   mode 等非模型 presentation
 *
 * 新任务和已有会话采用相同的 Composer 显示事实；prewarm 不补模型或档位。
 * 提交时由宿主（SessionPane）把冻结选择随 Submission 一起发送。
 * 三件套不能全部门控在 config!==null 上——草稿态会整体不渲染。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  ZCODE_AGENT_PROVIDER,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import { TID_V4_MODEL_CONFIG, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import type {
  SessionConfigState,
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { ComposerModelOptions } from "@/chat-input-toolbar/ComposerModelMenu.js";
import { Button } from "@/components/ui/button.js";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { formatHighspeedRemainingTime } from "@/highspeed/highspeedTime.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import {
  getNextThoughtLevelValue,
  getThoughtLevelLabel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import {
  setPendingSettingsSectionIntent,
  setPendingSettingsUsageCodingPlanIntent,
} from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useComposerConnectionSwitch } from "@/hooks/useComposerConnectionSwitch.js";
import {
  buildComposerPlanGroups,
  composerConnectionKey,
  chooseConnectionModel,
} from "@/lib/composerPlanGroups.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import {
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
  writeSidebarUsageCodingPlanProviderPreference,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";

// 拆分件再导出（模式选择移居 V4ComposerModeControls，超行数拆分）：
// 既有消费方（ConversationComposer）继续从本模块入口 import，接口面不变。
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

/** 稳定空回调（热键 hook 单实例只处理本组件拥有的选项，其余动作占位）。 */
function noop(): void {}

function HighspeedCountdown({ expiresAt }: { expiresAt: number }) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingTime = formatHighspeedRemainingTime(expiresAt, now);
  const absoluteExpiryLabel = intl.formatMessage(
    { id: "chat.highspeed.expiresAt" },
    {
      time: new Date(expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  );
  const remainingTimeLabel = intl.formatMessage(
    { id: "chat.highspeed.remainingTime" },
    { time: remainingTime },
  );

  // Bug 根因：倒计时原先晚于 Think 折叠，在中等窄窗口继续占用固定 82px；
  // 窄窗口只收起数值，保留可 hover 的时钟入口。
  return (
    <span
      aria-label={absoluteExpiryLabel}
      title={remainingTimeLabel}
      data-highspeed-countdown="true"
      className="highspeed-inline-countdown inline-flex h-7 w-[82px] shrink-0 items-center justify-center gap-1 rounded-md p-1 text-ui-caption @max-xl/composer:w-7 @max-xl/composer:gap-0 @max-xl/composer:p-0"
    >
      <AlarmClockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        data-highspeed-countdown-value="true"
        className="relative h-[18px] w-[54px] shrink-0 leading-4 tabular-nums @max-xl/composer:hidden"
      >
        <span className="absolute left-0 top-0.5">{remainingTime}</span>
      </span>
    </span>
  );
}

export interface ModelSelectionSource {
  provider: string;
  model: string;
}

type V4ContextPlanConnection =
  | { kind: "none" }
  | {
      family: ProviderFamilyDomain;
      kind: "personalCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "teamCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
      selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "start";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    };

function resolveFamilyForPlanProviderId(providerId: string | null | undefined): {
  family: ProviderFamilyDomain;
  kind: "personalCoding" | "teamCoding" | "start";
} | null {
  switch (providerId?.trim()) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
      return { family: "zai", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
      return { family: "zai", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
      return { family: "zai", kind: "start" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      return { family: "bigmodel", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      return { family: "bigmodel", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return { family: "bigmodel", kind: "start" };
    default:
      return null;
  }
}

function resolveV4ContextPlanConnection(params: {
  connectionSelections?: ProviderFamilyConnectionSelectionSettings | null;
  providerId?: string | null;
}): V4ContextPlanConnection {
  const providerFamily = resolveFamilyForPlanProviderId(params.providerId);
  if (!providerFamily) {
    return { kind: "none" };
  }

  // Start 额度属于输入框的有效模型；全局付费连接不能作为它的查询门禁。
  if (providerFamily.kind === "start") {
    const providerId = params.providerId?.trim();
    if (
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan &&
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ) {
      return { kind: "none" };
    }
    return {
      family: providerFamily.family,
      kind: "start",
      providerId,
    };
  }

  const selection = params.connectionSelections?.[providerFamily.family];
  if (!selection) return { kind: "none" };

  const providerId = params.providerId?.trim();
  if (providerFamily.kind === "teamCoding" && selection.kind === "team-coding-plan") {
    return {
      family: providerFamily.family,
      kind: "teamCoding",
      providerId: providerId as
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      selection,
    };
  }
  if (providerFamily.kind !== "personalCoding" || selection.kind !== "individual-coding-plan") {
    return { kind: "none" };
  }

  return {
    family: providerFamily.family,
    kind: "personalCoding",
    providerId: providerId as
      | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  };
}

function resolveContextTeamUsageSourceFromEntitlementSnapshot({
  accountAccess,
  snapshot,
}: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  snapshot?: UsageEntitlementSnapshot | null;
}): CodingPlanUsageSource | null {
  if (snapshot?.context?.scope !== "team") {
    return null;
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return null;
  }
  const subscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() || subscription?.productId?.trim() || "current";
  // 原 createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId 硬编码，
  // zai team snapshot 也生成 bigmodel 前缀 sourceId（与设置页/usage sources 不一致）。
  // 从 snapshot.provider.id 反查 family，生成对应前缀。
  const familySpec = resolveModelProviderFamilySpecByProviderId(snapshot.provider?.id ?? "");
  const family: ProviderFamilyDomain = familySpec?.id ?? "bigmodel";
  if (!accountAccess) {
    return null;
  }
  if ("mode" in accountAccess && accountAccess.mode !== "team-coding-plan") {
    return null;
  }
  if (
    "planKind" in accountAccess &&
    (accountAccess.planKind !== "team-coding-plan" ||
      accountAccess.productId !== productId ||
      accountAccess.organizationId !== organizationId ||
      accountAccess.projectId !== projectId)
  ) {
    return null;
  }
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const sourceId = ["team", family, productId, organizationId, projectId]
    .map(encodeURIComponent)
    .join(":") as SidebarUsageCodingPlanSourceId;
  const displayName =
    snapshot.context.displayName?.trim() || subscription?.productName?.trim() || "Team";

  return {
    id: sourceId,
    providerId: codingPlanProviderId,
    accountAccess: {
      type: "zhipu-account",
      family,
      planKind: "team-coding-plan",
      productId,
      organizationId,
      projectId,
    },
    label: `${familySpec?.id === "zai" ? "ZAI" : "BigModel"} - ${displayName}`,
  };
}

function resolveContextCodingPlanUsageSource(params: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  cachedTeamSources?: readonly CodingPlanUsageSource[];
  entitlementSnapshot?: UsageEntitlementSnapshot | null;
  // 原类型/守卫硬绑 bigmodelCodingPlan，zai team 上下文永远返回 null。
  // 放开为 zai/bigmodel 两种 codingPlan providerId。
  providerId?:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan;
  teamSelection?: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  subscribedTeamProducts: Parameters<
    typeof buildCodingPlanUsageSources
  >[0]["subscribedTeamProducts"];
}): CodingPlanUsageSource | null {
  if (!params.teamSelection) return null;
  if (!params.accountAccess) return null;

  return (
    buildCodingPlanUsageSources({
      accountAccesses: {
        [resolveModelProviderFamilySpecByProviderId(params.providerId ?? "")?.id ?? "bigmodel"]:
          params.accountAccess,
      },
      subscribedTeamProducts: params.subscribedTeamProducts,
    }).find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    params.cachedTeamSources?.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    resolveContextTeamUsageSourceFromEntitlementSnapshot({
      accountAccess: params.accountAccess,
      snapshot: params.entitlementSnapshot,
    })
  );
}

export interface V4ComposerToolbarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  sessionId: string | null;
  phase: SessionPhase | null;
  provider?: ZCodeProvider;
  /** 当前工具条是否运行在 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  /** 当前视口是否为手机输入布局。 */
  isMobileViewport?: boolean;
  /** 草稿态（sessionId=null），仅区分新任务呈现，不改变选择来源。 */
  draftMode?: boolean;
  /** 当前 scope 的 Composer 选择；新任务与已有会话都只显示这份状态。 */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  disabled: boolean;
  modelSelectionPending?: boolean;
  onConnectionPendingChange?: (pending: boolean) => void;
  /** Highspeed 卡生效时固定本轮模型，禁止通过选择器或快捷键切换。 */
  modelLocked?: boolean;
  /** 扩散尾段开始后（恢复入场则立即）展示 Highspeed 模型与倒计时。 */
  highspeedPresented?: boolean;
  /** 本次入场是否为 draw 新命中的激活动效；恢复入场的模型标识不做翻页。 */
  highspeedEntranceAnimated?: boolean;
  /** 模型翻页完成并静置后播放一次扫光。 */
  highspeedSweepActive?: boolean;
  /** Highspeed 卡片过期时间；有值时在模型与 Think 之间显示倒计时。 */
  highspeedExpiresAt?: number;
  /** draw 响应绑定的模型；只覆盖锁定期的触发器文案。 */
  highspeedModel?: string;
  /** 单个 composer 内的配置 picker 排他 owner；只属于 renderer-local presentation。 */
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  /**
   * 选中模型（providerId/modelId 来自目录 value 解码），由 Composer owner 更新并持久化。
   * sourceModel 只表达这次用户操作的来源，不从 Session 投影补 CAS 或思考档位。
   */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void | Promise<void>;
  /** 选中思考深度；modelContext 固定本次用户操作的目标模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  onSendCompressionCommand?: (command: string) => void;
}

/** 模型 / 思考深度 / context usage 簇（渲染在发送键左侧，与旧 UI 同位）。 */
function V4ComposerModelControlsImpl({
  workspacePath,
  workspaceIdentity,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  sessionId,
  provider,
  isWebRemoteControl = false,
  isMobileViewport = false,
  draftMode = false,
  draftConfig,
  usage,
  disabled,
  modelSelectionPending = false,
  onConnectionPendingChange,
  modelLocked = false,
  highspeedPresented = false,
  highspeedEntranceAnimated = false,
  highspeedSweepActive = false,
  highspeedExpiresAt,
  highspeedModel,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
  onSendCompressionCommand,
  onRecoverCustomModelSelection,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // 配置面读取：workspace 缺省目录（taskId=null），不读旧会话态。
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  // 配置面存活服务读（过渡归宿 = 配置面 v4 化）：连接方式选中键喂 BigModel Team Plan 门控豁免。
  const baseServices = useBaseWorkspaceServices();
  const { settings: sharedSettings } = useSettings({ services: baseServices });
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Context 只在用户 hover/open 时刷新，不在 composer 挂载时请求额度。
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M 热键：递增 openRequestKey 请求 ModelConfigSelect 打开菜单（旧 handleOpenModelMenuShortcut 语义）。
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  const [recoveryPending, setRecoveryPending] = useState(false);
  // 独立档位下拉沿用选中关闭；合并模型面板不能因 ACK 等待收起，否则选模和滑杆都会中断。
  useEffect(() => {
    if (modelSelectionPending) {
      onConfigPickerOpenChange("thought", false);
    }
  }, [modelSelectionPending, onConfigPickerOpenChange]);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  const modelOption = modelSelectionView?.providers.some((provider) => provider.models.length > 0)
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // 空模型/档位曾被 Session 旧值补回，界面显示与实际不可提交状态矛盾。
  // 初始化已经由 Composer owner 完成；显示层只消费它，不能再次补值。
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // 剩余额度「更多」直达 Coding Plan 使用统计（按上面写入的来源偏好选中当前套餐），
      // 不落到应用用量；通用 Usage 入口仍走 setPendingSettingsUsageIntent。
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [effectiveConfig?.provider, sharedSettings?.providerFamilyConnectionSelections],
  );
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  const contextStartPlanBalanceConfig = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Start Plan 只有具备独立 Account Access 时才挂载 hover 查询入口。
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // hover access 刷新入口不能只在 Coding Plan 配置上（onAccess）：
      // start plan 用户 hover context 面板从不主动刷新今日余额，只能等设置页/侧栏
      // 刷新后被动同步。接入与 Coding Plan 相同的静默 access 刷新；60s access 窗口
      // 与 in-flight 合并由刷新策略层自动生效，不会因反复 hover 放大 billing/balance 请求。
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () => refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () => handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  const contextStartPlanBalance = hasChatStartPlanBalance(contextStartPlanBalanceConfig)
    ? contextStartPlanBalanceConfig
    : undefined;

  // 按当前连接 family 拉取团队产品，避免 zai 团队误用 bigmodel 产品目录。
  const connectionFamily =
    resolveModelProviderFamilySpecByProviderId(effectiveConfig?.provider ?? "")?.id ??
    sharedSettings?.providerFamilyDomain ??
    "bigmodel";
  const user = useZCodeStoreWithDefault((state) => state.user, undefined);
  const connectionAuthenticated =
    user !== null &&
    Boolean(
      providerSettingsView?.providers.some(
        (p) =>
          p.effectiveConfig.access?.type === "zhipu-account" &&
          p.effectiveConfig.access.accountType === connectionFamily &&
          p.enabled &&
          p.accountState?.unavailableReason !== "not-authenticated" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            p.accountState?.availability === "available"),
      ),
    );
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      (contextPlanConnection.kind === "teamCoding" || activeConfigPicker === "model") &&
      connectionAuthenticated,
    authenticated: connectionAuthenticated,
    family: connectionFamily,
  });
  const subscribedTeamProducts = useMemo(
    () =>
      (connectionAuthenticated
        ? enterpriseProducts.snapshot?.productList.filter((product) => product.subscribed === true)
        : undefined) ?? [],
    [connectionAuthenticated, enterpriseProducts.snapshot?.productList],
  );
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  const teamUsageScope = useMemo(
    () => ({}),
    [baseServices, connectionFamily, user?.id, authSessionSeq],
  );
  const contextTeamUsageSourceCacheRef = useRef<{
    scope: object;
    sources: CodingPlanUsageSource[];
  }>({ scope: teamUsageScope, sources: [] });
  // 原因：独立来源缓存可复活已清空的目录；鉴权边界要在本次渲染就隔离，不能等待 Provider 刷新。
  if (contextTeamUsageSourceCacheRef.current.scope !== teamUsageScope || !connectionAuthenticated)
    contextTeamUsageSourceCacheRef.current = { scope: teamUsageScope, sources: [] };
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      connectionAuthenticated && contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current.sources,
            // 原硬取 bigmodelCodingPlan 的 entitlement snapshot，
            // zai team plan 查不到额度。改为按 connection.providerId 取对应 snapshot。
            entitlementSnapshot: entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      connectionAuthenticated,
      teamUsageScope,
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current.sources;
    const nextCache = cache.filter((source) => source.id !== contextCodingPlanUsageTeamSource.id);
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // Team -> Personal(no_plan) -> Team 期间企业商品或个人 snapshot 可能短暂缺失。
    // 保留最近解析过的团队 source，避免输入框 context 余额跟随水合顺序闪断。
    contextTeamUsageSourceCacheRef.current = {
      scope: teamUsageScope,
      sources: nextCache.slice(0, 8),
    };
  }, [contextCodingPlanUsageTeamSource, teamUsageScope]);
  const contextCodingPlanUsageSelectedSourceId: SidebarUsageCodingPlanSourceId | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  const teamEntitlement = useUsageEntitlement({
    enabled: !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // 原硬编码 bigmodelCodingPlan，zai family team plan 选中时
    // contextCodingPlanUsageTeamSource.providerId 是 zaiCodingPlan，但这里仍传 bigmodelCodingPlan
    // → 服务端 pickQuotaProvider 按 providerId 精确匹配选不到 zai provider →
    // resolveAuthorization 返回 null → zai team plan 的输入框上下文用量区域不显示额度。
    // 改为跟随 team source 的 providerId（已在 resolveContextTeamUsageSourceFromEntitlementSnapshot
    // / resolveV4ContextPlanConnection 按 family 正确产出 zaiCodingPlan/bigmodelCodingPlan）。
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // Team Plan 的 context 面板使用 sourceId 隔离自己的 freshness key；任务边界刷新时
      // 与全局 entitlement 一起发布，底层 request key 会合并相同团队请求。
      await Promise.all([refreshCodingPlanEntitlements(options), teamEntitlement.refresh(options)]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (contextPlanConnection.kind !== "personalCoding" || !contextCodingPlanUsageProviderId) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId: contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [contextAccountProviderAccess, contextCodingPlanUsageProviderId, contextPlanConnection.kind]);
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "personalCoding" && !contextCodingPlanUsageTeamSource) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () => refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () => refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  // 高频交互排障只走 debug，避免生产日志量随每次选择增长。
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  const modelGroupLabels = useMemo(
    () => ({
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
    }),
    [intl],
  );
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(displayProvider, modelSelectionView, modelGroupLabels);
  }, [displayProvider, modelGroupLabels, modelSelectionView]);

  // 修复：恢复「管理模型」入口（老版 onManageModels = 打开设置页并定位模型供应商区）。
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(handleOpenModelProviderSettings);
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // 当前投影模型的编码值：provider 命中目录则按自定义模型编码，否则回落裸 model id。
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(effectiveConfig.provider, effectiveConfig.model);
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // 触发器显示兜底——`<synthetic>`（SDK 恢复时合成的占位模型）或当前模型
  // 不在可选组（失效/下线/退登）→ 回落占位/默认「选择模型」，不直显协议内部占位符或失效
  // 模型 id。复用存活的 resolveModelSelectTriggerDisplay。
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [manageModelsLabel, modelSelectGroups, rawModelValue, showManageModelsAction],
  );
  const normalizedModelValue = triggerDisplay.value ?? "";

  const modelTriggerDisplay = useMemo(() => {
    // 非可选值（未选 / synthetic / 不可用）：占位文案或默认「选择模型」。
    const fallbackLabel =
      triggerDisplay.placeholder ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
    const providerName =
      modelSelectionView?.providers.find(
        (candidate) => candidate.providerId === effectiveConfig?.provider,
      )?.providerName ?? undefined;
    return resolveV4ModelTriggerDisplay({
      modelGroups: modelSelectGroups,
      normalizedValue: normalizedModelValue,
      fallbackLabel,
      providerId: effectiveConfig?.provider,
      providerName,
    });
  }, [
    effectiveConfig?.provider,
    intl,
    modelSelectionView,
    modelSelectGroups,
    normalizedModelValue,
    triggerDisplay.placeholder,
  ]);
  const handleModelValueChange = useCallback(
    (value: string, reasoningLevel?: string) => {
      if (modelLocked) return;
      const decoded = decodeCustomModelValue(value);
      // 草稿的点击时可见模型可能只存在于 catalog，或已经被最新 draft
      // intent 覆盖，不能让 SessionPane 再从迟到的 prewarm projection 反推。
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // debug 日志（草稿态切模型排障）：点击值 + 解码分支。
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      const customRecoveryEligible = isApiKeyAccess(selectedRegistryProvider?.config.access);
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        if (reasoningLevel !== undefined)
          return onSelectModel(
            decoded.providerId,
            decoded.modelName ?? "",
            sourceModel,
            reasoningLevel,
          );
        else return onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel);
      }
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        return onSelectModel(value.slice(0, slashIndex), value.slice(slashIndex + 1), sourceModel);
      }
      // 裸 model id：provider 沿用当前（宿主从最新投影补齐）。
      return onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      modelLocked,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const planGroups = useMemo(
    () =>
      buildComposerPlanGroups(
        modelSelectGroups,
        subscribedTeamProducts,
        providerSettingsView,
        displayProvider,
        modelGroupLabels,
        sharedSettings?.providerFamilyConnectionSelections,
      ),
    [
      modelSelectGroups,
      subscribedTeamProducts,
      providerSettingsView,
      displayProvider,
      modelGroupLabels,
      sharedSettings?.providerFamilyConnectionSelections,
    ],
  );
  const connectionSwitch = useComposerConnectionSwitch({
    scopeId: sessionId ?? undefined,
    onPendingChange: onConnectionPendingChange,
    workspacePath,
    workspaceIdentity,
    agentProvider: displayProvider,
    normalizedValue: normalizedModelValue,
    currentReasoningLevel: effectiveConfig?.thought,
    onSelectModel: handleModelValueChange,
    waitForPresentation: true,
    refreshPresentation: modelSelectionRefresh,
    presentationStatus: modelSelectionState.status,
    presentationRevision: modelSelectionView?.revision,
    presentationErrorRevision:
      modelSelectionState.status === "ready"
        ? modelSelectionState.refreshError?.revision
        : undefined,
  });
  const selectedProviderId = decodeCustomModelValue(normalizedModelValue)?.providerId;
  const selectedPlanGroup = planGroups.find((group) => {
    const connection = group.connection;
    if (!connection || connection.providerId !== selectedProviderId) return false;
    const selection = sharedSettings?.providerFamilyConnectionSelections?.[connection.family];
    return (
      connection.selection?.kind !== "team-coding-plan" ||
      (selection && composerConnectionKey(connection.family, selection) === connection.key)
    );
  });
  const selectedPlanKey = connectionSwitch.pending
    ? connectionSwitch.previousKey
    : (selectedPlanGroup?.key ??
      // 团队共用模型 value；当前过期行隐藏后，不能误选另一团队并阻止用户点击它。
      planGroups.find(
        (group) =>
          group.connection?.selection?.kind !== "team-coding-plan" &&
          group.items.some((item) => item.value === normalizedModelValue),
      )?.key);

  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // 候选档位只来自目标 Host 的 ModelSelectionView，已选档位只来自 Composer。
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels: draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      if (!value.trim()) {
        // 跨模型受控 Select 重建时可能抛出一次空 value；它不是用户选择，
        // 若继续上抛会把模型 intent 标成 superseded，导致 accepted 模型无法写入全局元组。
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T 热键：按目录顺序循环下一次 Submission 的思考深度。
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    };
  }, [usage?.contextWindow]);
  // 工具条热键已转正为命令表命令：tooltip 快捷键文案读生效表，
  // 改绑后按钮提示即时跟随（不能用硬编码文案）。
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const selectConnection = connectionSwitch.select;
  // 原因：内联对象会在无关渲染时使 memo 选择器失效；按展示事实和回调缓存选项。
  const composerOptions = useMemo<ComposerModelOptions>(
    () => ({
      providerMenu: {
        groups: planGroups,
        selectedKey: selectedPlanKey,
        pending: connectionSwitch.pending || modelSelectionPending,
        // 团队目录查询不是用户的连接切换操作，不能把登录错误挂到 API 菜单。
        error: connectionSwitch.error,
        onSelect: (group) => {
          // 原因：展示失败时设置可能已成功；已选连接仍须允许重试，不能被同 key 短路。
          if (group.key === selectedPlanKey && !connectionSwitch.error) return;
          if (group.connection) {
            void selectConnection(group.connection, selectedPlanKey);
          } else {
            const model = chooseConnectionModel(
              group.items,
              decodeCustomModelValue(normalizedModelValue)?.modelName,
            );
            const providerId = decodeCustomModelValue(model?.value ?? "")?.providerId;
            // 原因：普通 API 原先绕过连接切换 owner，缺少 loading 且会暴露旧目录。
            if (providerId)
              void selectConnection(
                {
                  key: group.key,
                  label: group.label,
                  providerId,
                  family: connectionFamily,
                  items: group.items,
                },
                selectedPlanKey,
              );
          }
        },
      },
      providerLabel: intl.formatMessage({ id: "chat.toolbar.combined.provider" }),
      modelsLabel: intl.formatMessage({ id: "chat.toolbar.combined.models" }),
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      effortShortcutLabel: thoughtShortcutLabel,
      selectModelLabel: intl.formatMessage({ id: "chat.toolbar.combined.selectModel" }),
      levels:
        thoughtOption?.options?.map((entry) => ({
          value: entry.value,
          label: getThoughtLevelLabel(intl, displayProvider, thoughtOption, entry),
        })) ?? [],
      value: String(thoughtOption?.currentValue ?? ""),
      onValueChange: handleThoughtValueChange,
    }),
    [
      planGroups,
      selectedPlanKey,
      connectionSwitch.pending,
      modelSelectionPending,
      connectionSwitch.error,
      selectConnection,
      normalizedModelValue,
      connectionFamily,
      intl,
      thoughtShortcutLabel,
      thoughtOption,
      displayProvider,
      handleThoughtValueChange,
    ],
  );
  const isModelOptionLocked = useCallback(() => false, []);

  // 键盘热键（旧 useToolbarShortcutBindings）：Ctrl+M 打开模型菜单、Ctrl+T 循环思考深度。
  // 模式循环（Ctrl+Shift+M）由 V4ComposerModeSwitch 单独绑定（modeOption 在彼处）。
  // 模型留空是正常的待选择状态，包括已有会话；不能因为没有已选模型隐藏重选入口。
  // 有可选组时正常显示；无组但有「管理模型」入口时也显示，避免用户零模型入口。
  const modelMenuVisible = modelSelectGroups.length > 0 || showManageModelsAction;
  // 配置恢复不是用户改选：未知时不显示“选择模型”，首次恢复不播放新旧标签滚动。
  const sessionConfigPending = sessionId !== null && draftConfig?.mode === undefined;
  // Bug 根因：手机端固定宽度的二级菜单没有消费 Radix 测得的当前方向可用宽度，
  // 共享 min-w-32 还会阻止极窄空间继续收缩。保持二级交互，同时把窗口边缘作为硬上限。
  const providerSubmenuClassName =
    isWebRemoteControl && isMobileViewport
      ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
      : undefined;
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled:
      disabled || recoveryPending || connectionSwitch.pending || modelSelectionPending,
    modelMenuDisabled:
      disabled ||
      recoveryPending ||
      modelLocked ||
      connectionSwitch.pending ||
      modelSelectionPending ||
      !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  return (
    <>
      {/*
        e2e 契约（TID_V4_MODEL_CONFIG）：Composer/usage 状态的 data-* 属性锚点。
        Bug 原因：跨模型切换会主动清除源模型的显式 thought；此时可见控件已按目标模型
        Option Spec 展示默认档位，但旧锚点仍暴露空的原始投影。data-thought 必须与用户
        实际看到的受控值一致，不能重新引入一份草稿状态。
      */}
      <span
        data-testid={TID_V4_MODEL_CONFIG}
        data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
        data-provider={effectiveConfig?.provider ?? ""}
        data-model={effectiveConfig?.model ?? ""}
        data-thought={
          thoughtOption?.type === "select"
            ? String(thoughtOption.currentValue ?? "")
            : (effectiveConfig?.thought ?? "")
        }
        data-thought-levels={
          thoughtOption?.type === "select"
            ? (thoughtOption.options ?? []).map((option) => option.value).join(",")
            : ""
        }
        data-mode={draftConfig?.mode ?? ""}
        data-plan-enabled={draftConfig?.planEnabled ?? false}
        data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
        data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
        className="hidden"
      />
      {/* Highspeed 卡激活即锁定模型；不能等动效交接完成才隐藏，否则 usage 圈圈会短暂闪现。 */}
      {!modelLocked ? (
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled || recoveryPending}
        />
      ) : null}
      {/* 加速轮的模型由本次卡决定，选型菜单此时不可用，所以指示器优先于选型加载态。 */}
      {highspeedPresented && highspeedModel ? (
        <HighspeedModelIndicator
          model={highspeedModel}
          originalModel={modelTriggerDisplay.fullLabel}
          sweepActive={highspeedSweepActive}
          animateEntrance={highspeedEntranceAnimated}
        />
      ) : modelSelectionState.status === "error" && modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : modelMenuVisible &&
        !providerSourcesLoading &&
        planGroups.length === 0 &&
        !connectionSwitch.pending ? (
        // 空配置是正常状态；直接复用 Provider 设置入口，不展开无名称、无模型的菜单。
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm"
          data-testid="chat-model-select-trigger"
          onClick={handleOpenModelProviderSettings}
        >
          {manageModelsLabel}
        </Button>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          key={JSON.stringify([
            workspaceIdentity?.trim() || workspacePath,
            sessionId,
            sessionConfigPending,
          ])}
          modelGroups={modelSelectGroups}
          contentAlign="center"
          normalizedValue={normalizedModelValue}
          triggerLabel={
            sessionConfigPending && !effectiveConfig?.model ? "" : modelTriggerDisplay.modelLabel
          }
          composerOptions={composerOptions}
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: modelLocked
              ? "chat.highspeed.modelLocked"
              : "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          pending={modelSelectionPending || connectionSwitch.pending}
          disabled={
            disabled ||
            modelSelectionPending ||
            recoveryPending ||
            modelLocked ||
            (modelSelectionState.status !== "ready" &&
              !(modelSelectionState.status === "loading" && modelSelectionState.catalog))
          }
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={!modelLocked && activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName="hidden @sm/composer:inline-flex"
          indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
          triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:px-1.5 group-data-[composer-model-icon=true]/toolbar:justify-center"
          triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {highspeedPresented && highspeedExpiresAt !== undefined ? (
        <HighspeedCountdown expiresAt={highspeedExpiresAt} />
      ) : null}
      {thoughtOption && (modelLocked || highspeedPresented) ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          triggerClassName={cn(highspeedPresented && "text-ui-caption")}
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending || modelSelectionPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={!modelSelectionPending && activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}

export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
import { isApiKeyAccess } from "@zcode/provider";
