import {
  SettingsScopeDeviceProvider,
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
  useSettingsScopeForm,
} from "@/settings-scope/index.js";
/* eslint-disable max-lines -- 子智能体管理页集中维护作用域列表、表单和启用状态，避免状态分散 */
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { hasExplicitModelChanged } from "@/lib/startPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ZCODE_AGENT_PROVIDER,
  type AgentColor,
  type AgentsCapability,
  type AgentsListResult,
  type AgentSummary,
  type BuiltInSubagentName,
  type ModelSelection,
  type SubAgentConfig,
} from "@zcode/shared";
import {
  TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER,
  TID_SUBAGENT_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type { ModelSelectionView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { toast } from "@/components/ui/toast.js";
import {
  ModelConfigSelect,
  type ModelSelectFooterAction,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { SUBAGENT_COLORS, SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroupHeader.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";
import {
  refreshLoadedSubagentsStoreForWorkspace,
  refreshSubagentsStoreForRemoteWorkspaces,
} from "@/store/subagentsStore.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";

const AGENT_COLORS: AgentColor[] = [...SUBAGENT_COLORS];
const MODEL_ITEM_NEVER_LOCKED = () => false;
const INHERIT_MODEL_VALUE = "inherit";
const TOOL_OPTIONS = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;
const TOOL_OPTION_SET = new Set<string>(TOOL_OPTIONS);
const RISKY_TOOLS = new Set<string>(["Bash", "Edit", "Write"]);

interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

export function projectSettingsSubagents(result: AgentsListResult): AgentSummary[] {
  // Bugfix：result.agents 是运行时调用投影，插件 agent 可能同时有规范名称与裸名称别名；
  // 设置页按已安装资源展示，插件部分必须改用一文件一条的 pluginAgents 投影。
  return [...result.agents.filter((agent) => agent.source !== "plugin"), ...result.pluginAgents];
}

export interface SubagentFormInitialState {
  name: string;
  description: string;
  color: AgentColor;
  model: string;
  thoughtLevel?: string;
  injectAgentsMd: boolean;
  inheritAllTools: boolean;
  selectedTools: string[];
  preservedTools: string[];
  systemPrompt: string;
}

interface SubagentsSectionProps {
  onManageModels?: () => void;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

function isEditableUserAgent(agent: AgentSummary): boolean {
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

// runtime 只对 user scope 应用 disabledAgentIds（CLI 侧 isDisabledUserProfile 对
// source !== "user" 直接返回 false，workspace profile 的 source 是 "project"），服务端
// attachEnabledState 也据此对非 user scope 恒返回 enabled: true。因此 workspace agent 不能
// 展示启用开关——点了会静默回弹，还会往 user 级 agents-state.json 写入永不生效的记录。
function supportsEnabledToggle(agent: AgentSummary): boolean {
  return isEditableUserAgent(agent) && agent.scope === "user";
}

function isBuiltInAgent(agent: AgentSummary): boolean {
  return agent.scope === "built-in" || agent.source === "built-in";
}

/**
 * 内置 general-purpose / Explore 与插件 agent 都是只读 profile，配置入口统一为行内
 * model / effort 覆盖控件；插件 md 属于插件安装目录，升级会覆写，所以不能像 user agent 那样改文件。
 */
function supportsModelOverride(agent: AgentSummary): boolean {
  return getBuiltInSubagentName(agent) !== null || agent.source === "plugin";
}

function getBuiltInSubagentName(agent: AgentSummary): BuiltInSubagentName | null {
  if (!isBuiltInAgent(agent)) {
    return null;
  }
  return agent.name === "general-purpose" || agent.name === "Explore" ? agent.name : null;
}

function getKnownTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => TOOL_OPTION_SET.has(tool)) ?? [];
}

function getPreservedTools(values: readonly string[] | undefined): string[] {
  return values?.filter((tool) => !TOOL_OPTION_SET.has(tool)) ?? [];
}

function mergeTools(
  selectedTools: readonly string[],
  preservedTools: readonly string[],
): string[] | undefined {
  const result = [...selectedTools, ...preservedTools].filter(
    (tool, index, tools) => tool.length > 0 && tools.indexOf(tool) === index,
  );
  return result.length > 0 ? result : undefined;
}

function allowsAllTools(tools: readonly string[] | undefined): boolean {
  // 通配符 * 表示全部工具，不能按数组长度显示成 1 个工具。
  return !tools || tools.length === 0 || tools.some((tool) => tool.trim() === "*");
}

function toPersistedModel(model: string): string | undefined {
  const trimmedModel = model.trim();
  return trimmedModel && trimmedModel !== INHERIT_MODEL_VALUE ? trimmedModel : undefined;
}

function toSubagentModelValue(selection: ModelSelection | undefined): string {
  return selection
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : INHERIT_MODEL_VALUE;
}

function toSubagentModelSelection(
  model: string | undefined,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const persistedModel = model ? toPersistedModel(model) : undefined;
  if (!persistedModel) return undefined;
  const selection = parseModelPickerValue(persistedModel);
  const reasoningLevel = thoughtLevel?.trim();
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

export type SubagentThoughtOptionState = SubagentReasoningFieldState;

/**
 * 模型目录对子智能体页的含义：ready 有目录；loading 目录仍会到达；
 * unavailable 读取失败或目标没有目录（远端设备「用户」），不会自行变成 ready。
 */
export type SubagentModelCatalogStatus = "ready" | "loading" | "unavailable";

export function resolveSubagentThoughtOptionState(params: {
  model: string;
  modelAvailable: boolean;
  modelSelectionView?: ModelSelectionView | null;
  modelCatalogStatus: SubagentModelCatalogStatus;
  thoughtLevel?: string;
}): SubagentThoughtOptionState {
  const persistedModel = toPersistedModel(params.model);
  if (!persistedModel || !params.modelAvailable) {
    return { kind: "not-applicable" };
  }
  const modelSelection = parseModelPickerValue(persistedModel);
  const explicitThoughtLevel = params.thoughtLevel?.trim();

  // Settings 只管理 Local Environment，模型能力与候选统一来自 Local Host View。
  // Workspace presentation 的 configOptions 不是第二份模型目录，也不参与 reasoning 判断。
  const metadataOption = params.modelSelectionView
    ? resolveModelThoughtOption({
        modelSelectionView: params.modelSelectionView,
        providerId: modelSelection.providerId,
        modelId: modelSelection.modelId,
        currentValue: explicitThoughtLevel,
      })
    : null;
  if (metadataOption) {
    return {
      kind: "supported",
      option: metadataOption,
    };
  }
  // Bug 原因：旧实现只有"是否 ready"一个布尔值，读取失败与远端「用户」没有目录也显示加载中，
  // 而这两种状态不会自行变成 ready，控件一直转圈。能力未知时按目录状态区分加载中与不可用。
  if (params.modelCatalogStatus !== "ready") {
    return { kind: "unknown", status: params.modelCatalogStatus };
  }
  return { kind: "unsupported" };
}

export function isSubagentThoughtLevelAvailable(
  state: SubagentThoughtOptionState,
  thoughtLevel: string | undefined,
): boolean {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return true;
  }
  if (state.kind === "unknown" || state.kind === "not-applicable") {
    return true;
  }
  if (state.kind === "unsupported") {
    return false;
  }
  return Boolean(
    state.option.type === "select" &&
    state.option.options?.some((entry) => entry.value === normalizedThoughtLevel),
  );
}

function resolvedSubagentThoughtLevel(state: SubagentThoughtOptionState): string | undefined {
  return state.kind === "supported" && typeof state.option.currentValue === "string"
    ? state.option.currentValue
    : undefined;
}

export function isSubagentModelAvailable(
  modelGroups: readonly ModelSelectGroup[],
  model: string | undefined,
  modelCatalogStatus: SubagentModelCatalogStatus = "ready",
): boolean {
  const trimmedModel = model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return true;
  }
  // 没有可用目录时无法判断模型是否失效，保留原意图。
  if (modelCatalogStatus !== "ready") {
    return true;
  }
  return modelGroups.some((group) => group.items.some((item) => item.value === trimmedModel));
}

export function createSubagentFormInitialState(
  initial?: Pick<
    AgentSummary,
    | "name"
    | "description"
    | "color"
    | "modelSelection"
    | "tools"
    | "systemPrompt"
    | "injectAgentsMd"
  >,
): SubagentFormInitialState {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    color: initial?.color ?? "yellow",
    model: toSubagentModelValue(initial?.modelSelection),
    thoughtLevel: initial?.modelSelection?.options?.reasoningLevel,
    injectAgentsMd: initial?.injectAgentsMd ?? true,
    inheritAllTools: initial?.tools === undefined || initial.tools.length === 0,
    selectedTools: getKnownTools(initial?.tools),
    preservedTools: getPreservedTools(initial?.tools),
    systemPrompt: initial?.systemPrompt ?? "",
  };
}

function createSubagentFormInitialStateKey(initial?: AgentSummary): string {
  return JSON.stringify({
    id: initial?.id ?? null,
    ...createSubagentFormInitialState(initial),
  });
}

function resolveSubagentModelLabel(params: {
  inheritLabel: string;
  modelGroups: readonly ModelSelectGroup[];
  model: string | undefined;
}): string {
  const trimmedModel = params.model?.trim();
  if (!trimmedModel || trimmedModel === INHERIT_MODEL_VALUE) {
    return params.inheritLabel;
  }
  // Registry 只包含当前可选模型，但历史 Subagent 配置仍需展示原模型身份，
  // 方便用户理解并修复失效配置。候选列表与保存校验继续以 Registry 为准。
  return resolveModelDisplayName(params.modelGroups, trimmedModel) ?? trimmedModel;
}

function FormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1.5 block text-ui-base font-medium text-foreground-subtle">
      {children}
    </label>
  );
}

function AgentBadge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border",
        className,
      )}
    >
      {children}
    </span>
  );
}

function groupAgentsByScope(agents: readonly AgentSummary[]): AgentGroups {
  const groups: AgentGroups = { builtIn: [], plugin: [], user: [] };
  for (const agent of agents) {
    if (isEditableUserAgent(agent)) {
      groups.user.push(agent);
    } else if (agent.source === "plugin") {
      groups.plugin.push(agent);
    } else {
      groups.builtIn.push(agent);
    }
  }
  return groups;
}

/** 按完整插件 ID 分组，避免同名 marketplace 的子智能体互相合并。 */
export function groupPluginAgentsById(
  agents: readonly AgentSummary[],
): Array<[string, AgentSummary[]]> {
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key =
      agent.pluginId?.trim() || agent.pluginName?.trim() || agent.name.split(":", 1)[0] || "Plugin";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function ToolCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input-border bg-input text-transparent",
          )}
        >
          <Check className="size-3.5" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
        {label}
      </span>
      {RISKY_TOOLS.has(label) ? (
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function AgentListRow({
  agent,
  pluginIconItem,
  isOperating,
  modelGroups,
  modelSelectionView,
  modelCatalogStatus,
  modelSelectGroups,
  onModelOverrideChange,
  onDelete,
  onEdit,
  onToggle,
}: {
  agent: AgentSummary;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  isOperating: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelCatalogStatus: SubagentModelCatalogStatus;
  modelSelectGroups: readonly ModelSelectGroup[];
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
  onDelete: (agent: AgentSummary) => void;
  onEdit: (agent: AgentSummary) => void;
  onToggle: (agent: AgentSummary, enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const editable = isEditableUserAgent(agent);
  const showEnabledToggle = supportsEnabledToggle(agent);
  const rowEditable = editable && !isOperating;
  const hasModelOverrideControl = supportsModelOverride(agent);
  // 有覆盖控件的行由控件本身表达模型，不再重复显示模型徽标。
  const showModelBadge = !hasModelOverrideControl;
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const modelLabel = resolveSubagentModelLabel({
    inheritLabel: inheritModelLabel,
    modelGroups: modelSelectGroups,
    model: toSubagentModelValue(agent.modelSelection),
  });
  const toolCount = agent.tools?.length ?? 0;
  const toolsLabel = allowsAllTools(agent.tools)
    ? intl.formatMessage({ id: "settings.subagents.tools.all" })
    : intl.formatMessage({ id: "settings.subagents.toolsCount" }, { count: String(toolCount) });
  const displayName =
    agent.source === "plugin" && agent.name.includes(":")
      ? agent.name.slice(agent.name.indexOf(":") + 1)
      : agent.name;

  return (
    <div
      data-testid={testId(TID_SUBAGENT_ROW, agent.name)}
      className={cn(
        "grid cursor-default items-center gap-3 px-4 py-3 transition-colors",
        rowEditable && "hover:bg-hover",
        hasModelOverrideControl
          ? "grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
      {...settingsResourceRowInteraction(rowEditable ? () => onEdit(agent) : undefined)}
    >
      <div className="relative shrink-0" aria-hidden="true">
        {pluginIconItem ? (
          <PluginStoreAvatar
            item={pluginIconItem}
            className="size-9 bg-background"
            fallbackIcon={
              <WorkflowAgentFace
                avatarIndex={undefined}
                name={agent.name}
                color={agent.color ? SUBAGENT_WORKFLOW_COLOR[agent.color] : undefined}
                idle
                status={undefined}
                className="size-5"
              />
            }
          />
        ) : (
          <div className="flex size-9 items-center justify-center rounded-xl bg-background text-foreground-subtle">
            <WorkflowAgentFace
              avatarIndex={undefined}
              name={agent.name}
              color={agent.color ? SUBAGENT_WORKFLOW_COLOR[agent.color] : undefined}
              idle
              status={undefined}
              className="size-5"
            />
          </div>
        )}
        {pluginIconItem ? (
          // 插件保留品牌图标，身份头像只放在右下角；绝对定位不改变列表行高度。
          <span className="absolute -bottom-1 -right-1 inline-flex size-5 items-center justify-center rounded-lg border border-card bg-card leading-none">
            <WorkflowAgentFace
              avatarIndex={undefined}
              name={agent.name}
              color={agent.color ? SUBAGENT_WORKFLOW_COLOR[agent.color] : undefined}
              idle
              status={undefined}
              className="size-4 min-h-4! min-w-4!"
            />
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{displayName}</span>
          {showModelBadge ? <AgentBadge>{modelLabel}</AgentBadge> : null}
          <AgentBadge>{toolsLabel}</AgentBadge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {agent.description || intl.formatMessage({ id: "settings.subagents.noDescription" })}
        </p>
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          hasModelOverrideControl
            ? "col-span-2 min-w-0 justify-end sm:col-span-1 sm:shrink-0"
            : "shrink-0",
        )}
      >
        {hasModelOverrideControl ? (
          <SubagentModelOverrideControl
            agent={agent}
            disabled={isOperating}
            modelGroups={modelGroups}
            modelSelectionView={modelSelectionView}
            modelCatalogStatus={modelCatalogStatus}
            onModelOverrideChange={onModelOverrideChange}
          />
        ) : null}
        {showEnabledToggle ? (
          <Switch
            checked={agent.enabled}
            onCheckedChange={(enabled) => onToggle(agent, enabled)}
            disabled={isOperating}
            aria-label={intl.formatMessage(
              { id: "settings.subagents.toggleAria" },
              { name: agent.name },
            )}
          />
        ) : null}
        <div className="flex items-center gap-1">
          {editable ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              onClick={() => void onDelete(agent)}
              disabled={isOperating}
              title={intl.formatMessage({ id: "common.delete" })}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 内置与插件 subagent 共用的行内 model / effort 覆盖控件，即改即存。 */
function SubagentModelOverrideControl({
  agent,
  disabled,
  modelGroups,
  modelSelectionView,
  modelCatalogStatus,
  onModelOverrideChange,
}: {
  agent: AgentSummary;
  disabled: boolean;
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelCatalogStatus: SubagentModelCatalogStatus;
  onModelOverrideChange: (
    agent: AgentSummary,
    config: { model?: string; thoughtLevel?: string },
  ) => Promise<void>;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [config, setConfig] = useState<{
    model?: string;
    thoughtLevel?: string;
  }>(() => ({
    model: agent.modelSelectionOverride
      ? toSubagentModelValue(agent.modelSelectionOverride)
      : undefined,
    thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
  }));
  const defaultLabel = intl.formatMessage({
    id: "settings.subagents.model.defaultMain",
  });
  const selectModelLabel = intl.formatMessage({
    id: "settings.subagents.model.select",
  });
  const value = config.model ?? INHERIT_MODEL_VALUE;
  const modelAvailable = isSubagentModelAvailable(modelGroups, value, modelCatalogStatus);
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model: value,
    modelAvailable,
    modelSelectionView,
    modelCatalogStatus,
    thoughtLevel: config.thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    config.thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, config.thoughtLevel),
  );
  // Coding Plan 连接切换后，Builtin 的旧模型可能不再属于当前候选；仅隐藏 reasoning
  // 会让用户误以为模型仍有效，因此触发器改用“选择模型”提示，候选列表仍只展示当前连接。
  const triggerLabel =
    value === INHERIT_MODEL_VALUE
      ? defaultLabel
      : !modelAvailable
        ? selectModelLabel
        : resolveSubagentModelLabel({
            inheritLabel: defaultLabel,
            modelGroups,
            model: value,
          });
  useEffect(() => {
    setConfig({
      model: agent.modelSelectionOverride
        ? toSubagentModelValue(agent.modelSelectionOverride)
        : undefined,
      thoughtLevel: agent.modelSelectionOverride?.options?.reasoningLevel,
    });
  }, [agent.modelSelectionOverride]);

  const persistConfig = useCallback(
    async (nextConfig: { model?: string; thoughtLevel?: string }) => {
      if (pending) {
        return;
      }
      const previousConfig = config;
      setConfig(nextConfig);
      setPending(true);
      try {
        let selectedConfig = nextConfig;
        if (nextConfig.model && nextConfig.model !== config.model) {
          const selection = toSubagentModelSelection(nextConfig.model, nextConfig.thoughtLevel);
          const chosen = selection ? await recommendStartPlan(selection) : null;
          if (!chosen) {
            setConfig(previousConfig);
            return;
          }
          selectedConfig = {
            model: toSubagentModelValue(chosen),
            thoughtLevel: chosen.options?.reasoningLevel,
          };
        }
        await onModelOverrideChange(agent, selectedConfig);
        setConfig(selectedConfig);
      } catch {
        setConfig(previousConfig);
      } finally {
        setPending(false);
      }
    },
    [agent, config, onModelOverrideChange, pending, recommendStartPlan],
  );
  const handleValueChange = useCallback(
    (nextValue: string) => {
      const nextModel = nextValue === INHERIT_MODEL_VALUE ? undefined : nextValue;
      if (nextModel === config.model) {
        return;
      }
      const nextModelAvailable = isSubagentModelAvailable(
        modelGroups,
        nextValue,
        modelCatalogStatus,
      );
      const nextThoughtState = resolveSubagentThoughtOptionState({
        model: nextValue,
        modelAvailable: nextModelAvailable,
        modelSelectionView,
        modelCatalogStatus,
        thoughtLevel:
          nextModel && modelSelectionView
            ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(nextModel))
                ?.options?.reasoningLevel
            : undefined,
      });
      // 控件会展示 Registry 的正常默认档位，持久化必须保存同一个值，
      // 不能让界面有值而执行 Selection 缺少 reasoningLevel。
      void persistConfig({
        model: nextModel,
        thoughtLevel: resolvedSubagentThoughtLevel(nextThoughtState),
      });
    },
    [config.model, modelGroups, modelCatalogStatus, modelSelectionView, persistConfig],
  );
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:built-in-default",
        label: defaultLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [defaultLabel, handleValueChange, value],
  );

  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <span
          data-testid={testId(TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER, agent.name)}
          data-model-current-value={value}
          className="inline-flex min-w-0"
        >
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={value}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={handleValueChange}
            footerActions={footerActions}
            manageModelsLabel={intl.formatMessage({
              id: "chat.toolbar.model.manageModels",
            })}
            contentSide="top"
            contentAlign="end"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled || pending}
          />
        </span>
        <SubagentReasoningField
          intl={intl}
          state={thoughtLevelState}
          disabled={disabled || pending}
          labelVisibilityClassName="hidden sm:inline-flex"
          onValueCommit={(thoughtLevel) => {
            if (thoughtLevel === config.thoughtLevel) {
              return;
            }
            void persistConfig({ model: config.model, thoughtLevel });
          }}
        />
      </div>
      {thoughtLevelInvalid ? (
        <span className="text-ui-sm text-destructive">
          {intl.formatMessage({
            id: "settings.subagents.form.validation.thoughtLevelUnavailable",
          })}
        </span>
      ) : null}
    </div>
  );
}

function SubagentForm({
  initial,
  modelSelectionView,
  modelCatalogStatus,
  modelSelectGroups,
  onManageModels,
  saving,
  onCancel,
  onDelete,
  onSave,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: AgentSummary;
  modelSelectionView?: ModelSelectionView | null;
  modelCatalogStatus: SubagentModelCatalogStatus;
  modelSelectGroups: readonly ModelSelectGroup[];
  onManageModels?: () => void;
  saving: boolean;
  onCancel: () => void;
  onDelete?: (agent: AgentSummary) => void;
  onSave: (config: SubAgentConfig) => Promise<void>;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView, "subagent");
  const { intl } = useZCodeIntl();
  const initialFormStateKey = createSubagentFormInitialStateKey(initial);
  const initialFormState = useMemo(
    () => createSubagentFormInitialState(initial),
    [initial, initialFormStateKey],
  );
  const previousInitialFormStateKeyRef = useRef(initialFormStateKey);
  const [name, setName] = useState(initialFormState.name);
  const [description, setDescription] = useState(initialFormState.description);
  const [color, setColor] = useState<AgentColor>(initialFormState.color);
  const [model, setModel] = useState(initialFormState.model);
  const [thoughtLevel, setThoughtLevel] = useState(initialFormState.thoughtLevel);
  const [injectAgentsMd, setInjectAgentsMd] = useState(initialFormState.injectAgentsMd);
  const [inheritAllTools, setInheritAllTools] = useState(initialFormState.inheritAllTools);
  const [selectedTools, setSelectedTools] = useState<string[]>(initialFormState.selectedTools);
  const [systemPrompt, setSystemPrompt] = useState(initialFormState.systemPrompt);
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const inheritModelLabel = intl.formatMessage({
    id: "settings.subagents.model.inherit",
  });
  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (nextModel === model) {
        return;
      }
      setModel(nextModel);
      const identity = toPersistedModel(nextModel);
      const selected =
        identity && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(identity))
          : undefined;
      setThoughtLevel(selected?.options?.reasoningLevel ?? "");
      setModelError(null);
    },
    [model, modelSelectionView],
  );
  const persistedModel = toPersistedModel(model);
  const modelAvailable = isSubagentModelAvailable(modelSelectGroups, model, modelCatalogStatus);
  // 候选已明确失效时仍展示原型号会误导用户；只改触发器文案，不清空草稿或补回候选。
  // 非 ready 阶段由可用性函数保留原意图，不能把读取失败当成模型被删除。
  const modelTriggerLabel = modelAvailable
    ? resolveSubagentModelLabel({
        inheritLabel: inheritModelLabel,
        modelGroups: modelSelectGroups,
        model,
      })
    : intl.formatMessage({ id: "settings.subagents.model.select" });
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "subagent-model:inherit",
        label: inheritModelLabel,
        onSelect: () => handleModelChange(INHERIT_MODEL_VALUE),
        selected: model === INHERIT_MODEL_VALUE,
      },
    ],
    [handleModelChange, inheritModelLabel, model],
  );
  const thoughtLevelState = resolveSubagentThoughtOptionState({
    model,
    modelAvailable,
    modelSelectionView,
    modelCatalogStatus,
    thoughtLevel,
  });
  const thoughtLevelInvalid = Boolean(
    persistedModel &&
    thoughtLevel &&
    modelAvailable &&
    !isSubagentThoughtLevelAvailable(thoughtLevelState, thoughtLevel),
  );
  const trimmedName = name.trim();
  const canSave = Boolean(
    trimmedName.length >= 3 &&
    trimmedName.length <= 50 &&
    /^[a-zA-Z0-9-]+$/u.test(trimmedName) &&
    description.trim() &&
    systemPrompt.trim() &&
    modelAvailable &&
    !thoughtLevelInvalid,
  );
  const selectedColorIndex = Math.max(0, AGENT_COLORS.indexOf(color));

  useEffect(() => {
    if (previousInitialFormStateKeyRef.current === initialFormStateKey) {
      return;
    }
    previousInitialFormStateKeyRef.current = initialFormStateKey;
    const nextInitialState = createSubagentFormInitialState(initial);

    // 保存/刷新后表单组件可能复用旧实例；必须按最新 agent 快照回灌字段，
    // 否则已写入 Markdown 的 model 会继续停留在本地 inherit 状态。
    setName(nextInitialState.name);
    setDescription(nextInitialState.description);
    setColor(nextInitialState.color);
    setModel(nextInitialState.model);
    setThoughtLevel(nextInitialState.thoughtLevel);
    setInjectAgentsMd(nextInitialState.injectAgentsMd);
    setInheritAllTools(nextInitialState.inheritAllTools);
    setSelectedTools(nextInitialState.selectedTools);
    setSystemPrompt(nextInitialState.systemPrompt);
    setNameError(null);
    setDescriptionError(null);
    setPromptError(null);
    setModelError(null);
  }, [initial, initialFormStateKey]);

  const validate = (): boolean => {
    const trimmedName = name.trim();
    let valid = true;
    if (trimmedName.length < 3 || trimmedName.length > 50) {
      setNameError(
        intl.formatMessage(
          { id: "settings.subagents.form.validation.nameLength" },
          { min: "3", max: "50" },
        ),
      );
      valid = false;
    } else if (!/^[a-zA-Z0-9-]+$/u.test(trimmedName)) {
      setNameError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.nameCharacters",
        }),
      );
      valid = false;
    } else {
      setNameError(null);
    }
    if (!description.trim()) {
      setDescriptionError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.descriptionRequired",
        }),
      );
      valid = false;
    } else {
      setDescriptionError(null);
    }
    if (!systemPrompt.trim()) {
      setPromptError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.promptRequired",
        }),
      );
      valid = false;
    } else {
      setPromptError(null);
    }
    // 不可用模型会展示为“选择模型”，保存时也必须阻止历史值被静默写回。
    if (!isSubagentModelAvailable(modelSelectGroups, model, modelCatalogStatus)) {
      setModelError(
        intl.formatMessage({
          id: "settings.subagents.form.validation.modelUnavailable",
        }),
      );
      valid = false;
    } else {
      setModelError(null);
    }
    if (thoughtLevelInvalid) {
      valid = false;
    }
    return valid;
  };

  const toggleTool = (tool: string) => {
    setInheritAllTools(false);
    setSelectedTools((current) =>
      current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool],
    );
  };

  const handleToolsModeChange = (value: string) => {
    const nextInheritAllTools = value === "all";
    setInheritAllTools(nextInheritAllTools);
    if (!nextInheritAllTools && selectedTools.length === 0) {
      setSelectedTools([...TOOL_OPTIONS]);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) {
      return;
    }
    let selection = toSubagentModelSelection(persistedModel, thoughtLevel);
    if (hasExplicitModelChanged(initial?.modelSelection, selection)) {
      const chosen = await recommendStartPlan(selection);
      if (!chosen) return;
      selection = chosen;
    }
    await onSave({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      color,
      injectAgentsMd,
      ...(selection ? { modelSelection: selection } : {}),
      tools: inheritAllTools
        ? undefined
        : mergeTools(selectedTools, initialFormState.preservedTools),
      disallowedTools: initial?.disallowedTools,
      skills: initial?.skills,
      permissionMode: initial?.permissionMode,
      ...(initial?.maxTurns ? { maxTurns: initial.maxTurns } : {}),
      ...(initial?.background !== undefined ? { background: initial.background } : {}),
      mcpServers: initial?.mcpServers,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex justify-end">
        <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="shrink-0 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.scope.label" })}
          </span>
          <PluginScopeMenu
            align="end"
            disabled={Boolean(initial)}
            selectedScopeKey={scopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={onScopeKeyChange}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,14rem)_auto_minmax(0,1fr)] md:items-start">
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.name.label" })}
          </FormFieldLabel>
          <Input
            type="text"
            size="lg"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.subagents.form.name.placeholder",
            })}
          />
          {nameError ? <p className="text-ui-base text-destructive">{nameError}</p> : null}
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.color.label" })}
          </FormFieldLabel>
          <div
            role="radiogroup"
            className="relative inline-grid w-56 grid-cols-8 rounded-lg border border-input-border bg-input p-1"
          >
            <span
              className="pointer-events-none absolute top-0.5 size-7 rounded-xl border-2 border-border bg-surface transition-[left]"
              style={{
                left: `calc(0.125rem + ((100% - 0.5rem) / ${AGENT_COLORS.length}) * ${selectedColorIndex})`,
              }}
              aria-hidden="true"
            />
            {AGENT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={color === option}
                aria-label={intl.formatMessage({
                  id: `settings.subagents.color.${option}`,
                })}
                className="relative z-10 flex size-6 items-center justify-center rounded-lg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setColor(option)}
              >
                <WorkflowAgentFace
                  avatarIndex={undefined}
                  name={name}
                  color={SUBAGENT_WORKFLOW_COLOR[option]}
                  status={undefined}
                  idle
                  className="size-5"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <FormFieldLabel>
            {intl.formatMessage({ id: "settings.subagents.form.model.label" })}
          </FormFieldLabel>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ModelConfigSelect
              modelGroups={modelSelectGroups}
              normalizedValue={model}
              triggerLabel={modelTriggerLabel}
              showManageModelsAction={Boolean(onManageModels)}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleModelChange}
              footerActions={footerActions}
              manageModelsLabel={intl.formatMessage({
                id: "chat.toolbar.model.manageModels",
              })}
              onManageModels={onManageModels}
              // 聊天工具栏的模型菜单默认向上弹；Subagents add/edit 表单位于设置页正文，
              // 菜单项应贴着按钮下方展开，避免覆盖上面的表单字段。
              contentSide="bottom"
              focusSelectorOnClose={null}
              labelVisibilityClassName="inline-flex min-w-0"
              triggerClassName="h-8 w-fit max-w-full min-w-0 justify-between rounded-lg border border-input-border bg-input bg-clip-border px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
              triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            />
            <SubagentReasoningField
              intl={intl}
              state={thoughtLevelState}
              disabled={saving}
              labelVisibilityClassName="inline-flex min-w-0"
              onValueCommit={setThoughtLevel}
            />
          </div>
          {modelError ? <p className="text-ui-base text-destructive">{modelError}</p> : null}
          {thoughtLevelInvalid ? (
            <p className="text-ui-base text-destructive">
              {intl.formatMessage({
                id: "settings.subagents.form.validation.thoughtLevelUnavailable",
              })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.description.label",
          })}
        </FormFieldLabel>
        <Input
          type="text"
          size="lg"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.description.placeholder",
          })}
        />
        {descriptionError ? (
          <p className="text-ui-base text-destructive">{descriptionError}</p>
        ) : null}
      </div>

      <div className="space-y-2 pt-1">
        <FormFieldLabel>
          {intl.formatMessage({ id: "settings.subagents.form.tools.label" })}
        </FormFieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={inheritAllTools ? "all" : "custom"} onValueChange={handleToolsModeChange}>
            <SelectTrigger size="lg" className="w-fit justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.all",
                })}
              </SelectItem>
              <SelectItem value="custom">
                {intl.formatMessage({
                  id: "settings.subagents.form.tools.mode.custom",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="min-w-0 text-ui-base font-normal text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.subagents.form.tools.card.title",
            })}
          </span>
        </div>
        {inheritAllTools ? null : (
          <div className="rounded-lg border border-border bg-card p-1">
            <div className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {TOOL_OPTIONS.map((tool) => (
                <ToolCheckbox
                  key={tool}
                  checked={selectedTools.includes(tool)}
                  disabled={false}
                  label={tool}
                  onToggle={() => toggleTool(tool)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <FormFieldLabel>
          {intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.label",
          })}
        </FormFieldLabel>
        <SettingsFormTextarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={3}
          className="max-h-56 min-h-16 resize-y overflow-y-auto text-ui-base"
          placeholder={intl.formatMessage({
            id: "settings.subagents.form.systemPrompt.placeholder",
          })}
        />
        {promptError ? <p className="text-ui-base text-destructive">{promptError}</p> : null}
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2.5">
        <p className="min-w-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        </p>
        <Switch
          checked={injectAgentsMd}
          onCheckedChange={setInjectAgentsMd}
          aria-label={intl.formatMessage({
            id: "settings.subagents.form.injectAgentsMd.label",
          })}
        />
      </div>

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
              disabled={saving}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button type="submit" variant="default" size="lg" disabled={!canSave || saving}>
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={saving}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </form>
  );
}

export function SubagentsSection({
  onManageModels,
  workspacePath,
  workspaceIdentity,
}: SubagentsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  // Scope 状态唯一 owner：默认选中当前 workspace 所在设备的「用户」。
  // Bug 根因：旧实现把 User 固定为本机（避免远程 tab 下误写远端 home），用户在远程 tab 里看不出
  // 也改不了远端 User 配置；现在 User 跟随菜单选中的设备：本机走 base services，远端走该设备的
  // source-settings attachment，设备离线时 fail-closed，不回退本机。
  const scope = useSettingsScope({ workspacePath, workspaceIdentity });
  const selectedScopeKey = scope.toLocalScopeKey(scope.selectedScopeKey);
  const setSelectedScopeKey = (localKey: string) =>
    scope.setSelectedScopeKey(scope.toPageScopeKey(localKey));
  const workspaceTabs = scope.deviceTargets;
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [capability, setCapability] = useState<AgentsCapability | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // 表单归属打开它的设备（agent 为 null 表示新建），根因与修法见 useSettingsScopeForm。
  const { form, openForm, closeForm } = useSettingsScopeForm<{ agent: AgentSummary | null }>(scope);
  const editingAgent = form?.agent ?? null;
  const showForm = form !== null && form.agent === null;
  const [saving, setSaving] = useState(false);
  // 修复原因：只读刷新不再禁用整个列表后，多行写操作可能重叠；单值 id 会让后开始的行覆盖、
  // 先结束的行清空，导致仍在写盘的行提前解禁。按行记录写操作，结束时只移除本行。
  const [operatingAgentIds, setOperatingAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const markAgentOperating = useCallback((agentId: string, operating: boolean) => {
    setOperatingAgentIds((current) => {
      if (current.has(agentId) === operating) return current;
      const next = new Set(current);
      if (operating) next.add(agentId);
      else next.delete(agentId);
      return next;
    });
  }, []);
  const [loadedAgentTargetKey, setLoadedAgentTargetKey] = useState("");
  const selectedWorkspace =
    scope.resolution.status === "ready" && scope.resolution.kind === "workspace"
      ? scope.resolution.target
      : undefined;
  const userScope = scope.user.status === "ready" ? scope.user : null;
  const scopeBlocked = resolveSettingsScopeBlock(scope, !selectedWorkspace);
  const targetWorkspacePath = selectedWorkspace?.workspacePath ?? userScope?.target.workspacePath;
  const targetWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  // 本机 User 沿用 "local-user" 缓存权威；远端 User 用 source-settings 权威，项目用 identity。
  const cacheAuthorityKey = selectedWorkspace
    ? undefined
    : (userScope?.cacheAuthorityKey ?? "local-user");
  const activeAgentTargetKey = buildSourceSettingsProjectionKey(
    targetWorkspacePath,
    targetWorkspaceIdentity,
    cacheAuthorityKey,
  );
  const projectionMatchesTarget =
    !loadedAgentTargetKey || loadedAgentTargetKey === activeAgentTargetKey;
  const resolvedTargetServices = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    {
      unscopedServices: selectedWorkspace ? undefined : userScope?.unscopedServices,
      forceUnscoped: !selectedWorkspace,
    },
  );
  // 设备离线或远端 attachment 未就绪时暂停全部 RPC（fail-closed），不借用其他 Host 的服务。
  const targetServiceResolution = scopeBlocked
    ? { ...resolvedTargetServices, rpcReady: false }
    : resolvedTargetServices;
  // Bug 原因：Scope target 与 useServices() 的当前上下文可以属于不同远程 host，
  // 子智能体及插件投影必须统一使用 target-scoped services，连接恢复前暂停 RPC。
  const { pluginManagementService, subagentsService } = targetServiceResolution.services;
  const activeScope = selectedWorkspace ? "workspace" : "user";
  // Provider/Model 事实属于目标 Environment：内置模型覆盖必须读 Scope target 自己的
  // Registry 视图，等待远端连接期间不能回退到 Base Host 的模型列表。
  // Bug 原因：远端「用户」的服务来自该设备的 source-settings attachment，Host 按 R3 §8.2 不注册
  // model-selection；旧实现照常读取，Host 1s 后回 Unknown channel，页面显示"模型列表加载失败"且重试必败。
  // 这类目标没有模型目录：不读取（状态为 unavailable，不报错），表单只能选「继承默认」。
  const modelCatalogUnavailable = !selectedWorkspace && scope.device.kind === "remote";
  const modelSelectionRead = useModelSelectionServiceView(
    modelCatalogUnavailable ? null : targetServiceResolution.services.modelSelectionService,
    targetServiceResolution.rpcReady,
    modelCatalogUnavailable ? "missing-target" : "remote-waiting",
  );
  const modelSelectionState = modelSelectionRead.state;
  const modelSelectionView =
    modelSelectionState.status === "ready" ? modelSelectionState.view : null;
  // 非 Ready 生命周期均保留表单中的模型意图；error/unavailable 不能被误判成模型已失效。
  // 只有首读中与等待远端连接的目录仍会到达；读取失败与没有目录（missing-target）算不可用。
  const modelCatalogStatus: SubagentModelCatalogStatus =
    modelSelectionState.status === "ready"
      ? "ready"
      : modelSelectionState.status === "loading" ||
          (modelSelectionState.status === "unavailable" &&
            modelSelectionState.reason === "remote-waiting")
        ? "loading"
        : "unavailable";
  const latestRequestIdRef = useRef(0);
  const pluginInventoryWorkspacePath = targetWorkspacePath;
  const chatModelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);
  const subagentModelSelectGroups = chatModelSelectGroups;
  const loadAgents = useCallback(
    async (showBlockingLoading: boolean) => {
      if (!targetServiceResolution.rpcReady) return;
      setLoading(showBlockingLoading);
      setRefreshing(!showBlockingLoading);
      setError(null);
      const requestTargetKey = activeAgentTargetKey;
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await subagentsService.list({
          workspacePath: targetWorkspacePath ?? "",
          workspaceIdentity: targetWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
          mode: activeScope === "user" ? "settingsUserOnly" : "allRuntimeScopes",
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        // 插件 agent 是运行时 profile 的只读投影；设置页展示它们，但仍不展示工作区级编辑入口。
        setAgents(projectSettingsSubagents(result));
        setCapability(result.capability);
        setLoadedAgentTargetKey(requestTargetKey);
        setLoading(false);
        setRefreshing(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoading(false);
        setRefreshing(false);
        setLoadedAgentTargetKey(requestTargetKey);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [
      subagentsService,
      activeScope,
      activeAgentTargetKey,
      targetServiceResolution.rpcReady,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) {
      latestRequestIdRef.current += 1;
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    void loadAgents(true);
  }, [loadAgents, targetServiceResolution.rpcReady]);

  useEffect(() => {
    if (!pluginInventoryWorkspacePath || !targetServiceResolution.rpcReady) return;
    let active = true;
    // 冷启动 seed 晚于文件首读，旧用户页又跳过 inventory 初始化，导致插件直到重进才出现。
    // 复用已有初始化完成事件刷新只读资源，不阻塞用户列表、不轮询，也不把项目配置带入用户页。
    void (async () => {
      try {
        await initializePlugins({
          workspacePath: pluginInventoryWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          authorityKey: cacheAuthorityKey,
          configScope: activeScope === "user" ? "user" : undefined,
          pluginService: pluginManagementService,
        });
        if (active) await loadAgents(false);
      } catch (initializationError) {
        if (active)
          logger.warn("[subagents] 插件资源初始化失败，保留当前列表", initializationError);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    activeScope,
    cacheAuthorityKey,
    initializePlugins,
    loadAgents,
    pluginInventoryWorkspacePath,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
  ]);

  const refresh = useCallback(async () => {
    await loadAgents(false);
  }, [loadAgents]);

  const refreshMentionStore = useCallback(async () => {
    await Promise.all([
      refreshLoadedSubagentsStoreForWorkspace({
        scope: activeScope,
        workspacePath: targetWorkspacePath,
        workspaceIdentity: targetWorkspaceIdentity,
        subagentsService,
      }),
      // Bug 根因：远端「用户」经 source-settings 服务读写，而已打开远程项目的斜杠建议缓存按项目服务
      // 分桶，上面的刷新碰不到它们。修法：「用户」改动后再按该设备已打开项目各自的服务刷新；
      // 本机项目没有 identity，会被跳过（本机仍由上面的刷新覆盖）。
      activeScope === "user" ? refreshSubagentsStoreForRemoteWorkspaces(workspaceTabs) : undefined,
    ]);
  }, [activeScope, subagentsService, targetWorkspaceIdentity, targetWorkspacePath, workspaceTabs]);

  const handleSave = useCallback(
    async (config: SubAgentConfig) => {
      setSaving(true);
      try {
        if (editingAgent) {
          await subagentsService.updateAgent({
            agentId: editingAgent.id,
            config,
            oldFilePath: editingAgent.path,
            provider: ZCODE_AGENT_PROVIDER,
            scope: editingAgent.scope === "workspace" ? "workspace" : "user",
            workspacePath: editingAgent.projectPath ?? targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        } else {
          await subagentsService.createAgent({
            config,
            provider: ZCODE_AGENT_PROVIDER,
            scope: activeScope,
            workspacePath: targetWorkspacePath ?? undefined,
            workspaceIdentity: targetWorkspaceIdentity,
          });
        }
        closeForm();
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (saveError) {
        toast(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [
      activeScope,
      closeForm,
      editingAgent,
      refresh,
      refreshMentionStore,
      subagentsService,
      targetWorkspaceIdentity,
      targetWorkspacePath,
    ],
  );

  const handleDelete = useCallback(
    async (agent: AgentSummary) => {
      if (!isEditableUserAgent(agent)) {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.subagents.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.subagents.delete.description" },
          { name: agent.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      markAgentOperating(agent.id, true);
      try {
        await subagentsService.deleteAgent({
          agentId: agent.id,
          filePath: agent.path,
        });
        closeForm();
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (deleteError) {
        toast(deleteError instanceof Error ? deleteError.message : String(deleteError));
      } finally {
        markAgentOperating(agent.id, false);
      }
    },
    [
      closeForm,
      confirmDialog,
      intl,
      markAgentOperating,
      refresh,
      refreshMentionStore,
      subagentsService,
    ],
  );

  const handleToggle = useCallback(
    async (agent: AgentSummary, enabled: boolean) => {
      if (!supportsEnabledToggle(agent)) {
        return;
      }
      markAgentOperating(agent.id, true);
      try {
        await subagentsService.setEnabled({
          agentId: agent.id,
          enabled,
        });
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (toggleError) {
        toast(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        markAgentOperating(agent.id, false);
      }
    },
    [markAgentOperating, refresh, refreshMentionStore, subagentsService],
  );

  const handleModelOverrideChange = useCallback(
    async (agent: AgentSummary, config: { model?: string; thoughtLevel?: string }) => {
      const agentName = getBuiltInSubagentName(agent);
      if (!agentName && agent.source !== "plugin") {
        return;
      }
      markAgentOperating(agent.id, true);
      try {
        const modelSelection = toSubagentModelSelection(config.model, config.thoughtLevel);
        if (agentName) {
          await subagentsService.setBuiltInModelOverride({ agentName, modelSelection });
        } else {
          // 稳定 ID 不含插件版本；升级换目录后继续读取同一份用户 Selection 覆盖。
          await subagentsService.setPluginAgentModelOverride({ agentId: agent.id, modelSelection });
        }
      } catch (changeError) {
        toast(changeError instanceof Error ? changeError.message : String(changeError));
        markAgentOperating(agent.id, false);
        throw changeError;
      }
      try {
        await Promise.all([refresh(), refreshMentionStore()]);
      } catch (refreshError) {
        // 持久化成功即为提交点；后续投影刷新失败只能提示，不能让控件回滚磁盘状态。
        toast(refreshError instanceof Error ? refreshError.message : String(refreshError));
      } finally {
        markAgentOperating(agent.id, false);
      }
    },
    [markAgentOperating, refresh, refreshMentionStore, subagentsService],
  );

  const handleEdit = useCallback(
    (agent: AgentSummary) => {
      if (!isEditableUserAgent(agent)) {
        return;
      }
      openForm({ agent });
    },
    [openForm],
  );

  const canManageUserAgents =
    activeScope === "workspace"
      ? Boolean(targetWorkspacePath)
      : capability?.userScopeAvailable === true;

  const handleAddNew = useCallback(() => {
    if (!canManageUserAgents) {
      return;
    }
    openForm({ agent: null });
  }, [canManageUserAgents, openForm]);

  const filteredAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (activeScope === "user") {
        if (agent.scope === "workspace") return false;
      } else {
        if (isBuiltInAgent(agent) || agent.scope !== "workspace") return false;
        if (agent.source === "plugin" && agent.projectPath !== targetWorkspacePath) return false;
        if (
          agent.source !== "plugin" &&
          agent.projectPath &&
          agent.projectPath !== targetWorkspacePath
        )
          return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        agent.name,
        agent.description,
        agent.modelSelection
          ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
          : undefined,
        agent.path,
        agent.scope,
        agent.source,
        agent.tools?.join(" "),
        agent.disallowedTools?.join(" "),
        agent.skills?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [activeScope, agents, query, targetWorkspacePath]);

  const groupedAgents = useMemo(() => groupAgentsByScope(filteredAgents), [filteredAgents]);
  const pluginGroups = useMemo(
    () => groupPluginAgentsById(groupedAgents.plugin),
    [groupedAgents.plugin],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  const filteredAgentCount =
    groupedAgents.user.length + groupedAgents.plugin.length + groupedAgents.builtIn.length;
  const currentEditingAgent = useMemo(() => {
    if (!editingAgent) {
      return null;
    }
    return agents.find((agent) => agent.id === editingAgent.id) ?? editingAgent;
  }, [agents, editingAgent]);
  const isFormView = canManageUserAgents && (showForm || currentEditingAgent !== null);

  if (isFormView && targetServiceResolution.rpcReady) {
    return (
      <SettingsScopeDeviceProvider
        device={scope.device}
        userAvailable={scope.user.status !== "unavailable"}
      >
        <div className="space-y-6">
          <SettingsBreadcrumbReporter
            items={[
              {
                label:
                  currentEditingAgent?.name ??
                  intl.formatMessage({ id: "settings.subagents.addNew" }),
              },
            ]}
            onSectionSelect={closeForm}
          />
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-ui-xl font-semibold text-foreground">
                {editingAgent
                  ? intl.formatMessage({ id: "settings.subagents.edit" })
                  : intl.formatMessage({ id: "settings.subagents.addNew" })}
              </h3>
              <p className="text-ui-base text-foreground-subtle">
                {editingAgent
                  ? intl.formatMessage({
                      id: "settings.subagents.editDescription",
                    })
                  : intl.formatMessage({
                      id: "settings.subagents.addDescription",
                    })}
              </p>
            </div>

            <SubagentForm
              initial={currentEditingAgent ?? undefined}
              modelSelectionView={modelSelectionView}
              modelCatalogStatus={modelCatalogStatus}
              modelSelectGroups={subagentModelSelectGroups}
              onManageModels={onManageModels}
              saving={saving}
              onCancel={closeForm}
              onDelete={handleDelete}
              onSave={handleSave}
              scopeKey={selectedScopeKey}
              workspaceTabs={workspaceTabs}
              onScopeKeyChange={setSelectedScopeKey}
            />
          </div>
        </div>
      </SettingsScopeDeviceProvider>
    );
  }

  const renderAgentList = (items: AgentSummary[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((agent, index) => (
        <div key={agent.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <AgentListRow
            agent={agent}
            pluginIconItem={
              agent.pluginId
                ? pluginIconItemById.get(agent.pluginId)
                : agent.pluginName
                  ? {
                      name: agent.pluginName,
                      listing: resolveUniquePluginListingByName(availablePlugins, agent.pluginName),
                    }
                  : undefined
            }
            // Bug 根因：插件资源初始化完成后会在任意时刻触发只读 loadAgents，旧写法让 refreshing
            // 禁用所有行，Radix Select 被禁用即关闭用户已打开的档位菜单。只读刷新不改动行数据提交，
            // 行控件只随该行自身的写操作禁用；refreshing 仍由 Refresh 按钮展示。
            isOperating={operatingAgentIds.has(agent.id)}
            modelGroups={chatModelSelectGroups}
            modelSelectionView={modelSelectionView}
            modelCatalogStatus={modelCatalogStatus}
            modelSelectGroups={subagentModelSelectGroups}
            onModelOverrideChange={handleModelOverrideChange}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onToggle={handleToggle}
          />
        </div>
      ))}
    </div>
  );

  const hasSearchResultEmpty = Boolean(query.trim()) && filteredAgentCount === 0;
  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            groups={scope.groups}
            selectedScopeKey={scope.selectedScopeKey}
            selectedDevice={scope.device}
            onScopeKeyChange={scope.setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground">
            <span>{intl.formatMessage({ id: "settings.subagents.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{filteredAgentCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.subagents.searchPlaceholder",
          })}
        />
      </div>

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {modelSelectionRead.state.status === "error" ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          <span>{intl.formatMessage({ id: "settings.subagents.modelLoadFailed" })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={modelSelectionRead.reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && capability && !capability.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: "settings.subagents.userScopeDesktopOnly",
          })}
        </div>
      ) : null}

      {scopeBlocked ? (
        <SettingsScopeBlockedNotice state={scopeBlocked} device={scope.device} />
      ) : !targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.subagents.empty" })} />
      ) : (
        <div className="space-y-6">
          <section
            className={query.trim() && groupedAgents.user.length === 0 ? "hidden" : "space-y-4"}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SettingsResourceGroupHeader
                count={groupedAgents.user.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.user",
                })}
              />
              <SettingsResourceHeaderActions
                onRefresh={() => void Promise.all([refresh(), refreshMentionStore()])}
                onNew={canManageUserAgents ? handleAddNew : undefined}
                refreshing={refreshing}
              />
            </div>
            {groupedAgents.user.length > 0 ? (
              renderAgentList(groupedAgents.user)
            ) : (
              <PluginInstallEmptyState
                title={intl.formatMessage({ id: "settings.subagents.empty" })}
                description={intl.formatMessage({
                  id: "settings.subagents.addDescription",
                })}
                actions={
                  canManageUserAgents ? (
                    <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.create.action" })}
                    </Button>
                  ) : null
                }
              />
            )}
          </section>
          {pluginGroups.map(([pluginId, items]) => (
            <section key={pluginId} className="space-y-4">
              <SettingsResourceGroupHeader
                count={items.length}
                title={resolvePluginDisplayName(
                  {
                    name: items[0]?.pluginName ?? pluginId,
                    listing:
                      (items[0]?.pluginId ? pluginListingById.get(items[0].pluginId) : undefined) ??
                      resolveUniquePluginListingByName(
                        availablePlugins,
                        items[0]?.pluginName ?? pluginId,
                      ),
                  },
                  locale,
                )}
              />
              {renderAgentList(items)}
            </section>
          ))}
          {groupedAgents.builtIn.length > 0 ? (
            <section className="space-y-4">
              <SettingsResourceGroupHeader
                count={groupedAgents.builtIn.length}
                title={intl.formatMessage({
                  id: "settings.subagents.group.builtIn",
                })}
              />
              {renderAgentList(groupedAgents.builtIn)}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
