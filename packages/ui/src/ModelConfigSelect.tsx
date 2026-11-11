/* eslint-disable max-lines -- 模型菜单同时维护触发器、模型项、provider family 连接方式子菜单和焦点恢复，拆开会增加受控 Dropdown 状态同步成本。 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ProviderConfigObject } from "@zcode/provider";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { AlertCircle, CheckIcon, ChevronDownIcon, LoaderCircle, PackageIcon } from "lucide-react";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { ComposerTriggerTransition } from "@/chat-input-toolbar/ComposerTriggerTransition.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import {
  ComposerModelMenu,
  ComposerThoughtIndicator,
  isGlmHighspeedModel,
  type ComposerModelOptions,
} from "@/chat-input-toolbar/ComposerModelMenu.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";

export interface ModelSelectGroupItem {
  key: string;
  value: string;
  name: string;
  badgeLabel?: string;
  supportsVisionInput?: boolean;
}

export interface ModelSelectConnectionOption {
  key: string;
  label: string;
  badgeLabel?: string;
  value: string;
  providerId: string;
  familyId: string;
  mode: "oauth" | "apiKey";
  disabled?: boolean;
}

export interface ModelSelectGroup {
  key: string;
  label: string;
  labelBadge?: string;
  logo?: ProviderConfigObject["logo"];
  directItems?: boolean;
  selectedOptionKey?: string;
  connectionOptions?: ModelSelectConnectionOption[];
  items: ModelSelectGroupItem[];
}

export interface ModelSelectFooterAction {
  key: string;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}

const EMPTY_MODEL_SELECT_FOOTER_ACTIONS: readonly ModelSelectFooterAction[] = [];
export const MODEL_CONFIG_SELECT_BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle";

export function shouldShowModelProviderLevel(modelGroups: readonly ModelSelectGroup[]): boolean {
  return modelGroups.length > 0;
}

function isFamilyConnectionGroup(
  group: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  return (
    group.key.startsWith("family:") ||
    Boolean(group.labelBadge?.trim()) ||
    (group.connectionOptions?.length ?? 0) > 0
  );
}

export function shouldRenderModelGroupSeparator(
  previousGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge"> | undefined,
  currentGroup: Pick<ModelSelectGroup, "connectionOptions" | "key" | "labelBadge">,
): boolean {
  if (!previousGroup) {
    return false;
  }
  return isFamilyConnectionGroup(previousGroup) || isFamilyConnectionGroup(currentGroup);
}

export function isModelSelectGroupSelected(
  group: Pick<ModelSelectGroup, "items">,
  normalizedValue: string,
): boolean {
  return group.items.some((item) => item.value === normalizedValue);
}

export function getModelTriggerLabelClassName({
  labelVisibilityClassName,
  triggerLabelClassName,
}: {
  labelVisibilityClassName: string | undefined;
  triggerLabelClassName?: string;
}): string {
  if (triggerLabelClassName?.trim()) {
    return triggerLabelClassName;
  }

  return cn("min-w-0 text-left", labelVisibilityClassName);
}

interface ModelConfigSelectProps {
  /** Composer 合并入口；其他使用点保持原有模型选择交互。 */
  composerOptions?: ComposerModelOptions;
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  triggerLabel: string;
  triggerLabelPrefix?: string;
  triggerLabelValue?: string;
  triggerLabelPrefixClassName?: string;
  showManageModelsAction: boolean;
  lockReasonMessage: string;
  isItemLocked: (candidateValue: string) => boolean;
  onValueChange: (value: string) => void;
  onConnectionValueChange?: (option: ModelSelectConnectionOption) => void;
  disabled?: boolean;
  tooltipTitle?: string;
  guideTooltipTitle?: ReactNode;
  guideTooltipOpen?: boolean;
  onGuideTooltipDismiss?: () => void;
  shortcutLabel?: string;
  triggerRef?: RefObject<HTMLSpanElement | null>;
  /** 传入时由调用方统一协调菜单；省略则保持组件原有的内部开关状态。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  openRequestKey?: number;
  pendingLabel?: string | null;
  pending?: boolean;
  labelVisibilityClassName?: string;
  indicatorClassName?: string;
  triggerClassName?: string;
  triggerIconClassName?: string;
  triggerIcon?: ReactNode;
  triggerLabelClassName?: string;
  triggerTestId?: string;
  formatTriggerLabel?: (label: string) => string;
  /** false 时把第一个 group 作为无 provider 层的扁平模型列表展示。 */
  showProviderLevel?: boolean;
  /** 覆盖 provider 二级模型菜单样式；缺省按内容扩展并保留最小宽度。 */
  providerSubmenuClassName?: string;
  footerActions?: readonly ModelSelectFooterAction[];
  manageModelsLabel?: string;
  onManageModels?: () => void;
  focusSelectorOnClose?: string | null;
  contentSide?: "top" | "bottom" | "left" | "right";
  contentAlign?: "start" | "center" | "end";
  /**
   * 排在所有分组之上的单选项（与分组之间隔一条线）。工作流「配置」弹层用它把「会话模型」放在第一位；
   * 缺省即无。
   */
  leadingItems?: readonly ModelSelectGroupItem[];
  /** 触发器里标签之后的小徽标（如「会话模型」「不可用」）；缺省即无。 */
  triggerBadge?: ReactNode;
}

export const ModelConfigSelect = memo(function ModelConfigSelectComponent({
  composerOptions,
  modelGroups,
  normalizedValue,
  triggerLabel,
  triggerLabelPrefix,
  triggerLabelValue,
  triggerLabelPrefixClassName,
  showManageModelsAction,
  lockReasonMessage,
  isItemLocked,
  onValueChange,
  onConnectionValueChange,
  disabled,
  tooltipTitle,
  guideTooltipTitle,
  guideTooltipOpen = false,
  onGuideTooltipDismiss,
  shortcutLabel,
  triggerRef,
  open: controlledOpen,
  onOpenChange,
  openRequestKey = 0,
  pendingLabel,
  pending,
  labelVisibilityClassName = "hidden @xl/composer:inline-flex",
  indicatorClassName,
  triggerClassName,
  triggerIconClassName = "hidden",
  triggerIcon,
  triggerLabelClassName: customTriggerLabelClassName,
  triggerTestId = TID_CHAT_MODEL_SELECT_TRIGGER,
  formatTriggerLabel,
  showProviderLevel,
  providerSubmenuClassName,
  footerActions = EMPTY_MODEL_SELECT_FOOTER_ACTIONS,
  manageModelsLabel,
  onManageModels,
  focusSelectorOnClose = '[data-testid="chat-input"]',
  contentSide = "top",
  contentAlign = "start",
  leadingItems,
  triggerBadge,
}: ModelConfigSelectProps) {
  const presentation = useRef({ composerOptions, modelGroups, normalizedValue, triggerLabel });
  if (
    composerOptions?.providerMenu?.pending &&
    presentation.current.composerOptions?.providerMenu
  ) {
    // 原因：账号刷新和草稿解析分别到达，混用新选项与旧选中值会让菜单收缩并显示“—”。
    // loading 期间只冻结展示；回调和 pending/error 仍来自当前 owner，不影响提交事实。
    const previous = presentation.current;
    composerOptions = {
      ...previous.composerOptions!,
      onValueChange: composerOptions.onValueChange,
      providerMenu: {
        ...composerOptions.providerMenu,
        groups: previous.composerOptions!.providerMenu!.groups,
        selectedKey: previous.composerOptions!.providerMenu!.selectedKey,
      },
    };
    modelGroups = previous.modelGroups;
    normalizedValue = previous.normalizedValue;
    triggerLabel = previous.triggerLabel;
  } else presentation.current = { composerOptions, modelGroups, normalizedValue, triggerLabel };
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);
  const hasSelectedModel = Boolean(normalizedValue.trim());
  const showSelectionLabel = Boolean(composerOptions && open && hasSelectedModel);
  // 未选模型不代表缺失思考档位；空态不应显示横线、绿条或 Tooltip 的伪档位。
  const selectedThoughtLabel = hasSelectedModel
    ? composerOptions?.levels.find((level) => level.value === composerOptions.value)?.label
    : undefined;
  const lastOpenRequestKeyRef = useRef(openRequestKey);
  const hasSelectableModel = modelGroups.length > 0;
  // 闲时任务白名单只有一层模型值；只要存在 group 就强制展示 provider 层的话，
  // 下方已有的扁平模型分支永远不可达，也无法复用 New Task 模型选择器。
  const shouldShowProviderLevel = showProviderLevel ?? shouldShowModelProviderLevel(modelGroups);
  // 模型名和上游占位值可能大小写敏感，强制大写会把 `<synthetic>` 改成 `<SYNTHETIC>` 这类非原始值。
  const triggerDisplayLabel = triggerLabel;
  const renderedTriggerDisplayLabel =
    formatTriggerLabel?.(triggerDisplayLabel) ?? triggerDisplayLabel;
  const renderedPendingLabel =
    pendingLabel && formatTriggerLabel ? formatTriggerLabel(pendingLabel) : pendingLabel;
  const currentTriggerLabel =
    pending && renderedPendingLabel ? renderedPendingLabel : renderedTriggerDisplayLabel;
  const currentTriggerTitle = pending && pendingLabel ? pendingLabel : triggerDisplayLabel;
  const triggerLabelClassName = getModelTriggerLabelClassName({
    labelVisibilityClassName,
    triggerLabelClassName: customTriggerLabelClassName,
  });

  const handlePopoverOpenChange = useCallback(
    (nextOpen: boolean) => {
      // 打开前测量真实按钮，不能在替换文案后反过来测量占位内容。
      if (nextOpen && composerOptions && buttonRef.current)
        setExpandedWidth(buttonRef.current.getBoundingClientRect().width);
      else if (!nextOpen) setExpandedWidth(null);
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange, composerOptions],
  );

  useEffect(() => {
    if (openRequestKey <= 0 || openRequestKey === lastOpenRequestKeyRef.current) {
      return;
    }
    lastOpenRequestKeyRef.current = openRequestKey;

    if (disabled) {
      return;
    }

    // 模型菜单是受控 DropdownMenu，快捷键不能依赖模拟 click 触发。
    // Tooltip/Dropdown 多层 asChild 合并 ref 时，click 可能找不到真实 trigger；这里直接打开菜单状态。
    handlePopoverOpenChange(true);
    triggerRef?.current?.focus();
  }, [disabled, handlePopoverOpenChange, openRequestKey, triggerRef]);

  const handleModelValueChange = useCallback(
    (nextValue: string) => {
      onValueChange(nextValue);
    },
    [onValueChange],
  );

  const triggerAriaLabel = useMemo(() => {
    return pending && pendingLabel ? pendingLabel : (tooltipTitle ?? currentTriggerTitle);
  }, [currentTriggerTitle, pending, pendingLabel, tooltipTitle]);

  const renderModelItem = useCallback(
    (item: ModelSelectGroupItem) => {
      const itemLocked = isItemLocked(item.value);
      const itemSelected = item.value === normalizedValue;
      // React 的 key 不能跟随 props spread 传入，否则开发环境会在 CDP console 报警。
      const itemKey = item.key;
      const commonProps = {
        // 保留面板时必须禁用选项，避免 ACK 在途的点击被上层屏障静默丢弃。
        disabled: Boolean(pending),
        "data-model-option-locked": itemLocked ? "true" : undefined,
        "data-model-option-selected": itemSelected ? "true" : undefined,
        "data-testid": testId(TID_CHAT_MODEL_SELECT_ITEM, item.value),
        "data-checked": itemSelected ? "true" : undefined,
      } as const;
      const content = (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            {item.badgeLabel ? (
              <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{item.badgeLabel}</span>
            ) : null}
            {item.supportsVisionInput ? <ModelInputCapabilityBadge /> : null}
          </span>
          {itemLocked ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:text-foreground-subtle"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <AlertCircle className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="center" sideOffset={6}>
                  {lockReasonMessage}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {itemLocked && itemSelected ? (
            <CheckIcon className="size-4 text-foreground-subtle" />
          ) : null}
        </>
      );

      if (itemLocked) {
        return (
          <DropdownMenuItem
            key={itemKey}
            {...commonProps}
            className="min-h-8 cursor-not-allowed gap-2 px-2 text-ui-base text-foreground-subtlest data-[highlighted]:text-foreground-subtlest"
            onSelect={(event) => event.preventDefault()}
          >
            {content}
          </DropdownMenuItem>
        );
      }

      return (
        <DropdownMenuRadioItem
          key={itemKey}
          {...commonProps}
          value={item.value}
          className="min-h-8 gap-2 pl-2 pr-8 text-ui-base"
          onSelect={(event) => {
            handleModelValueChange(item.value);
            // 合并菜单选模型后还可继续调档，阻止菜单项默认关闭；外侧点击仍走原关闭链路。
            if (composerOptions) event.preventDefault();
            else handlePopoverOpenChange(false);
          }}
        >
          {content}
        </DropdownMenuRadioItem>
      );
    },
    [
      composerOptions,
      handleModelValueChange,
      handlePopoverOpenChange,
      isItemLocked,
      lockReasonMessage,
      normalizedValue,
      pending,
    ],
  );

  const renderModelItems = useCallback(
    (items: readonly ModelSelectGroupItem[]) => (
      <DropdownMenuRadioGroup value={normalizedValue}>
        {items.map((item) => renderModelItem(item))}
      </DropdownMenuRadioGroup>
    ),
    [normalizedValue, renderModelItem],
  );

  const renderGroupLabel = useCallback(
    (group: ModelSelectGroup, options: { mutedLabel?: boolean } = {}) => (
      <span className="min-w-0 flex-1 items-center gap-1.5 text-left inline-flex">
        <span
          className={cn(
            "min-w-0 whitespace-normal break-words text-ui-base",
            options.mutedLabel && "text-foreground-subtle",
          )}
          title={group.label}
        >
          {group.label}
        </span>
        {group.labelBadge ? (
          <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{group.labelBadge}</span>
        ) : null}
      </span>
    ),
    [],
  );

  const renderProviderConnectionHeader = useCallback(
    (group: ModelSelectGroup) => {
      const options = group.connectionOptions ?? [];
      if (options.length > 0) {
        const selectedOptionKey = group.selectedOptionKey ?? options[0]?.key;
        const selectedConnection =
          options.find((option) => option.key === selectedOptionKey) ?? options[0];
        return (
          <div className="flex min-h-8 items-center gap-2 px-2 py-1">
            <span
              className="min-w-0 flex-1 truncate text-left text-ui-sm font-medium text-foreground-subtlest"
              title={group.label}
            >
              {group.label}
            </span>
            <Select
              value={selectedOptionKey}
              onValueChange={(nextKey) => {
                const option = options.find((candidate) => candidate.key === nextKey);
                if (!option) {
                  return;
                }
                // 切换连接方式后需要保留外层模型菜单，方便用户继续选择刷新后的模型。
                onConnectionValueChange?.(option);
              }}
            >
              <SelectTrigger
                size="xs"
                variant="outline"
                className="min-w-0 shrink-0 gap-0.5 rounded-full pr-1.5 text-ui-sm text-foreground-subtle [&_svg]:size-3"
                data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                data-model-provider-key={group.key}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="max-w-28 truncate">
                  {selectedConnection?.badgeLabel ?? selectedConnection?.label ?? group.label}
                </span>
              </SelectTrigger>
              <SelectContent
                align="end"
                position="popper"
                className="w-max min-w-40 max-w-72"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {options.map((option) => (
                  <SelectItem
                    key={option.key}
                    value={option.key}
                    data-model-connection-option={option.key}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      }

      return null;
    },
    [onConnectionValueChange],
  );

  const renderedFooterActions = useMemo<ModelSelectFooterAction[]>(() => {
    const actions = [...footerActions];
    if (!composerOptions && showManageModelsAction && manageModelsLabel) {
      actions.push({
        key: "manage-models",
        label: manageModelsLabel,
        onSelect: onManageModels,
      });
    }
    return actions;
  }, [composerOptions, footerActions, manageModelsLabel, onManageModels, showManageModelsAction]);

  const highspeed = isGlmHighspeedModel(
    modelGroups.flatMap((group) => group.items).find((item) => item.value === normalizedValue)
      ?.name ?? "",
  );
  const triggerContents = showSelectionLabel ? (
    <>
      <span
        data-composer-open-label
        className="absolute inset-x-1.5 truncate text-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:hidden"
      >
        {composerOptions!.selectModelLabel}
      </span>
      <span
        data-composer-open-icon
        aria-hidden="true"
        className="hidden size-4 shrink-0 items-center text-foreground-subtle group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        {triggerIcon ?? <PackageIcon className="size-4" />}
      </span>
      <span
        data-composer-open-thought
        className="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
      >
        <ComposerThoughtIndicator options={composerOptions!} highspeed={highspeed} />
      </span>
    </>
  ) : (
    <>
      {triggerIcon ?? (
        <PackageIcon
          className={cn("pointer-events-none size-4 shrink-0 text-current", triggerIconClassName)}
          aria-hidden="true"
        />
      )}
      <span className={triggerLabelClassName} title={currentTriggerTitle}>
        <RollingToolbarLabel
          label={currentTriggerLabel}
          prefix={pending ? undefined : triggerLabelPrefix}
          prefixClassName={triggerLabelPrefixClassName}
          value={pending ? undefined : triggerLabelValue}
        />
      </span>
      {composerOptions && hasSelectedModel ? (
        <ComposerThoughtIndicator options={composerOptions} highspeed={highspeed} />
      ) : null}
      {triggerBadge}
      {pending ? (
        <LoaderCircle className="pointer-events-none size-3.5 animate-spin text-foreground" />
      ) : null}
      {!pending && (
        <ChevronDownIcon
          className={cn(
            "pointer-events-none size-3.5 text-foreground-subtle",
            indicatorClassName,
            composerOptions && "group-data-[composer-compact=true]/combined:hidden",
          )}
        />
      )}
    </>
  );

  const modelTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        ref={buttonRef}
        style={
          showSelectionLabel
            ? ({
                // 锁宽只稳定打开态文案；图标态必须释放宽度，否则 resize 后仍挤占其他入口。
                "--composer-model-open-width": `max(${expandedWidth ?? 0}px, 8rem)`,
              } as CSSProperties)
            : undefined
        }
        type="button"
        variant="ghost"
        size="default"
        disabled={disabled}
        data-chat-toolbar-popover-trigger="true"
        data-testid={triggerTestId}
        data-model-current-value={normalizedValue}
        aria-label={
          selectedThoughtLabel ? `${triggerAriaLabel} ${selectedThoughtLabel}` : triggerAriaLabel
        }
        data-composer-combined-model={composerOptions ? "true" : undefined}
        data-composer-collapse-priority={composerOptions ? "3" : undefined}
        onClick={guideTooltipOpen ? onGuideTooltipDismiss : undefined}
        className={cn(
          "w-fit justify-between gap-1 rounded-lg pl-2 pr-1.5 text-ui-base whitespace-nowrap",
          triggerClassName,
          composerOptions && "group/combined relative",
          showSelectionLabel &&
            "px-2 w-(--composer-model-open-width) min-w-32 max-w-(--composer-model-open-width) group-data-[composer-model-icon=true]/toolbar:w-auto group-data-[composer-model-icon=true]/toolbar:min-w-0 group-data-[composer-model-icon=true]/toolbar:max-w-none",
          composerOptions &&
            !hasSelectedModel &&
            "text-foreground-subtle hover:text-foreground-subtle aria-expanded:text-foreground-subtle",
        )}
      >
        {composerOptions ? (
          <ComposerTriggerTransition open={showSelectionLabel}>
            {triggerContents}
          </ComposerTriggerTransition>
        ) : (
          triggerContents
        )}
      </Button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={open} onOpenChange={handlePopoverOpenChange}>
      {tooltipTitle ? (
        <ControlHintTooltip
          // 合并入口的 Tooltip 应提示操作，不重复按钮已有的模型和档位。
          title={
            guideTooltipOpen && guideTooltipTitle
              ? guideTooltipTitle
              : (composerOptions?.selectModelLabel ?? tooltipTitle)
          }
          shortcut={guideTooltipOpen ? undefined : shortcutLabel}
          triggerRef={triggerRef}
          // 菜单打开时 Tooltip 不能再成为最上层；否则 Escape 只关闭提示，菜单仍锁住指针。
          open={open ? false : guideTooltipOpen ? true : undefined}
          className={guideTooltipOpen ? "bg-background py-0.5 pr-0.5 pl-2" : undefined}
        >
          {modelTrigger}
        </ControlHintTooltip>
      ) : (
        modelTrigger
      )}
      {open && composerOptions ? (
        <DropdownMenuPortal>
          {/* 插件 webview 显式接收指针，内部事件不冒泡到宿主；透明层让外侧点击走 Radix 关闭链路。
              层级位于插件（10）之上、Composer（20）和浮窗（30）之下，保留同一工具栏的菜单切换。 */}
          <div
            aria-hidden="true"
            className="fixed inset-0 z-[19] pointer-events-auto [app-region:no-drag]"
          />
        </DropdownMenuPortal>
      ) : null}
      {open ? (
        <DropdownMenuContent
          className={cn(
            composerOptions
              ? // 外层滚动会带走供应商和 Effort；只让 Models 列表收缩，且排除窗口拖拽命中。
                "w-72 overflow-y-hidden [app-region:no-drag] [&>*:not([data-composer-model-list]):not([data-composer-provider-list])]:shrink-0"
              : shouldShowProviderLevel
                ? "w-max min-w-48 max-w-[calc(100vw-2rem)]"
                : "w-48 max-h-72 overflow-y-auto",
          )}
          collisionPadding={composerOptions ? 12 : undefined}
          align={contentAlign}
          side={contentSide}
          onCloseAutoFocus={(event) => {
            if (!focusSelectorOnClose) {
              // Automations 没有聊天输入框可恢复；保留 Radix 默认行为，
              // 让键盘焦点回到触发器，而不是 preventDefault 后掉到 body。
              return;
            }
            event.preventDefault();
            if (
              !shouldRestoreChatInputFocusAfterPickerClose({
                isCoarseTouchDevice: isCoarseTouchDevice(),
              })
            ) {
              return;
            }
            // 聊天输入框的 data-testid 挂在 contenteditable 自身上，不是父节点。
            // 这里与 mode 选择器保持同一个入口，避免关闭模型弹层后找不到输入框而丢失焦点。
            const input = document.querySelector<HTMLElement>(focusSelectorOnClose);
            input?.focus();
          }}
        >
          {leadingItems !== undefined && leadingItems.length > 0 ? (
            <>
              {renderModelItems(leadingItems)}
              {hasSelectableModel ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {composerOptions ? (
            <ComposerModelMenu
              groups={modelGroups}
              normalizedValue={normalizedValue}
              options={composerOptions}
              isItemLocked={isItemLocked}
              onSelectModel={handleModelValueChange}
              renderItems={renderModelItems}
              renderConnection={renderProviderConnectionHeader}
              providerFooter={
                showManageModelsAction && manageModelsLabel ? (
                  <DropdownMenuItem
                    className="min-h-8 gap-2 px-2"
                    data-model-footer-action="manage-models"
                    onSelect={() => {
                      handlePopoverOpenChange(false);
                      onManageModels?.();
                    }}
                  >
                    {manageModelsLabel}
                  </DropdownMenuItem>
                ) : null
              }
            />
          ) : hasSelectableModel && shouldShowProviderLevel ? (
            modelGroups.map((group, index) => {
              const groupSeparator = shouldRenderModelGroupSeparator(
                modelGroups[index - 1],
                group,
              ) ? (
                <DropdownMenuSeparator />
              ) : null;
              if (group.directItems) {
                return (
                  <Fragment key={group.key}>
                    {groupSeparator}
                    <div>
                      <DropdownMenuLabel
                        className="flex min-h-8 items-center px-2 py-1"
                        data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                        data-model-provider-key={group.key}
                      >
                        {renderGroupLabel(group)}
                      </DropdownMenuLabel>
                      {renderProviderConnectionHeader(group)}
                      <DropdownMenuRadioGroup value={normalizedValue}>
                        {group.items.map((item) => renderModelItem(item))}
                      </DropdownMenuRadioGroup>
                    </div>
                  </Fragment>
                );
              }

              const groupSelected = isModelSelectGroupSelected(group, normalizedValue);
              return (
                <Fragment key={group.key}>
                  {groupSeparator}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      className="min-h-8"
                      data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, group.key)}
                      data-model-provider-key={group.key}
                      data-model-provider-selected={groupSelected ? "true" : undefined}
                    >
                      {renderGroupLabel(group)}
                      {groupSelected ? (
                        <CheckIcon className="size-4 text-foreground-subtle" />
                      ) : null}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      className={cn(
                        "max-h-72 overflow-y-auto",
                        // 固定宽度会提前截断模型名；按内容扩展，并让可用空间优先于最小宽度。
                        providerSubmenuClassName ??
                          "w-max min-w-[min(12rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width)",
                      )}
                    >
                      {renderModelItems(group.items)}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </Fragment>
              );
            })
          ) : hasSelectableModel ? (
            renderModelItems(modelGroups[0]?.items ?? [])
          ) : null}
          {renderedFooterActions.length > 0 ? (
            <div className="sticky bottom-0 z-10 bg-menu after:absolute after:left-0 after:top-full after:h-1 after:w-full after:bg-menu after:content-['']">
              {hasSelectableModel ? <DropdownMenuSeparator /> : null}
              {renderedFooterActions.map((action) => (
                <DropdownMenuItem
                  key={action.key}
                  className="min-h-8 gap-2 px-2"
                  data-model-footer-action={action.key}
                  data-model-footer-action-selected={action.selected ? "true" : undefined}
                  onSelect={() => {
                    handlePopoverOpenChange(false);
                    action.onSelect?.();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.selected ? <CheckIcon className="size-4 text-foreground-subtle" /> : null}
                </DropdownMenuItem>
              ))}
            </div>
          ) : null}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
});
