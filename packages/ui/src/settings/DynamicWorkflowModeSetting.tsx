import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import {
  DYNAMIC_WORKFLOW_MODES,
  normalizeDynamicWorkflowMode,
  readDynamicWorkflowOfferedMode,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER,
  type AppSettings,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import {
  DynamicWorkflowAlwaysOnIcon,
  DynamicWorkflowOffIcon,
  DynamicWorkflowOnCommandIcon,
} from "@/components/icons/dynamicWorkflowModeIcons.js";
import {
  Select,
  SelectContent,
  SelectRichItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import type { DynamicWorkflowAvailabilitySnapshot } from "@/store/dynamicWorkflowAvailabilityStore.js";

const MODE_ICONS: Record<DynamicWorkflowMode, ComponentType<SVGProps<SVGSVGElement>>> = {
  disabled: DynamicWorkflowOffIcon,
  onDemand: DynamicWorkflowOnCommandIcon,
  alwaysOn: DynamicWorkflowAlwaysOnIcon,
};

/**
 * 设置行要显示什么（docs/dynamic-workflow/launch.md「The user's choice」）。快照就绪后总是出现：
 * 服务端只决定默认值，提供的是 disabled 时「默认」落在「关闭」上，用户照样可以打开。
 * 只有快照加载中、读取失败、或来自不认用户选择的旧 Host（没有 offeredMode）时返回 null。
 * 值与「默认」都取 Host 算好的结果，renderer 不自己套用户选择。
 */
export function resolveDynamicWorkflowModeSettingView(
  snapshot: DynamicWorkflowAvailabilitySnapshot,
): { value: DynamicWorkflowMode; offeredMode: DynamicWorkflowMode } | null {
  const config = snapshot.config;
  if (snapshot.status !== "ready" || !config) return null;
  const offeredMode = readDynamicWorkflowOfferedMode(config);
  return offeredMode ? { value: config.mode, offeredMode } : null;
}

/** 选回服务端提供的模式等于删除选择（空串哨兵，服务层归一成删除），安装继续跟随服务端翻转。 */
export function buildDynamicWorkflowModePatch(
  next: DynamicWorkflowMode,
  offeredMode: DynamicWorkflowMode,
): Pick<AppSettings, "dynamicWorkflowMode"> {
  return {
    dynamicWorkflowMode: (next === offeredMode ? "" : next) as AppSettings["dynamicWorkflowMode"],
  };
}

export function DynamicWorkflowModeSetting() {
  const { intl } = useZCodeIntl();
  const { update } = useSettings();
  const view = resolveDynamicWorkflowModeSettingView(useDynamicWorkflowAvailability());
  // 选择落盘 → Root 通知 Host 重发策略 → 快照重读，整条链要几百毫秒；期间触发器先显示用户刚选的值。
  // 行可见即功能已提供，此时生效模式必然等于用户所选，所以乐观值与最终值一致。
  const [pending, setPending] = useState<DynamicWorkflowMode | null>(null);
  const settledValue = view?.value;
  useEffect(() => {
    if (pending !== null && settledValue === pending) setPending(null);
  }, [pending, settledValue]);

  if (!view) return null;
  const value = pending ?? view.value;
  const label = intl.formatMessage({ id: "settings.dynamicWorkflow" });

  const handleValueChange = async (rawValue: string) => {
    const next = normalizeDynamicWorkflowMode(rawValue);
    if (!next || next === value) return;
    setPending(next);
    try {
      await update(buildDynamicWorkflowModePatch(next, view.offeredMode));
    } catch (error) {
      setPending(null);
      logger.warn("[settings] 保存动态工作流模式失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.dynamicWorkflow.saveError" }));
    }
  };

  // 不包外层元素：SettingsRow 靠 first:border-t-0 画行间分隔线，包一层会让它变成首行而丢掉上边框。
  return (
    <SettingsRow
      searchId="settings.dynamicWorkflow"
      label={label}
      description={intl.formatMessage({ id: "settings.dynamicWorkflowDescription" })}
      // Bugfix：默认控件列只有 192px，flex 会把 260px 的触发器压到 192px，跟随触发器宽度的列表也随之过窄；
      // wide 布局给 280px 控件列（手机宽度下换到标签下方），触发器与列表都按设计稿的 260px 显示。
      controlLayout="wide"
      control={
        <Select value={value} onValueChange={(next) => void handleValueChange(next)}>
          <SelectTrigger
            size="lg"
            className="w-[260px] min-w-0 justify-between"
            aria-label={label}
            data-testid={TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER}
          >
            <SelectValue />
          </SelectTrigger>
          {/* 两行选项用 popper 展开在触发器下方，item-aligned 会盖住本行的标签与说明。
              Bugfix：popper 只给了 min-width，列表宽度会被最长的一行说明撑开；固定为触发器宽度（260px），
              说明在列表内折行，与设计稿一致。 */}
          <SelectContent
            position="popper"
            align="end"
            sideOffset={4}
            className="w-(--radix-select-trigger-width)"
          >
            {DYNAMIC_WORKFLOW_MODES.map((mode) => {
              const Icon = MODE_ICONS[mode];
              return (
                <SelectRichItem
                  key={mode}
                  value={mode}
                  data-testid={testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode)}
                  icon={<Icon className="size-4.5" />}
                  title={intl.formatMessage({ id: `settings.dynamicWorkflow.option.${mode}` })}
                  titleAdornment={
                    mode === view.offeredMode ? (
                      <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-ui-xs font-medium text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.dynamicWorkflow.defaultTag" })}
                      </span>
                    ) : null
                  }
                  description={intl.formatMessage({
                    id: `settings.dynamicWorkflow.option.${mode}.description`,
                  })}
                />
              );
            })}
          </SelectContent>
        </Select>
      }
    />
  );
}
