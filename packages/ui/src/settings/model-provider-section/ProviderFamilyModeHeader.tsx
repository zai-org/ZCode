import {
  resolveModelProviderFamilySpecByProviderId,
  isStartPlanModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { connectionSelectionMatchesNavigationItem } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import { resolveModelProviderNavLogo } from "@/settings/model-provider-section/utils.js";
import { ProviderLogo } from "./ProviderLogo.js";
import type { ModelProviderNavItem } from "./constants.js";

type ProviderFamilyConnectionOption = {
  key: string;
  label: string;
  item: Extract<ModelProviderNavItem, { type: "preset" | "codingPlan" | "teamPlan" }>;
  order: number;
};

export function ProviderFamilyDetailShell({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) {
  if (!header) {
    return children;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {children}
    </div>
  );
}

export function ProviderFamilyHeader({
  selectedNavItem,
  trailingAction,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  trailingAction?: ReactNode;
}) {
  if (!selectedNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (!providerId) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  return (
    // Bug 原因：容器允许 flex-wrap 却固定 h-8，标题与连接方式在窄面板（手机 Web、桌面 480px 窗口）换行后，
    // 第二行溢出 32px 盖住下方卡片。改为 min-h-8：不换行时仍是 32px，换行时按内容撑高。
    <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProviderLogo logo={resolveModelProviderNavLogo(selectedNavItem)} className="size-5" />
        <h3 className="truncate text-ui-lg font-medium text-foreground">
          {selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId)
            ? "Start Plan"
            : familySpec.label}
        </h3>
      </div>
      {/* 修复原因：按团队全称的固有宽度参与外层换行，会让标题右侧空着却整组掉行；以操作区基础宽度参与分配，再让名称在剩余空间内收缩。 */}
      {trailingAction ? (
        <div className="min-w-0 max-w-full flex-1 basis-64">{trailingAction}</div>
      ) : null}
    </div>
  );
}

export function ProviderFamilyPlanModeSwitch({
  selectedNavItem,
  navigationItems,
  connectionSettingsFailed = false,
  connectionSelections,
  activeProviderFamily,
  onSelectNavItem,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems: ModelProviderNavItem[];
  startPlanSubscriptionCount?: number;
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  activeProviderFamily?: ProviderFamilyDomain | null;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!selectedNavItem || !onSelectNavItem) {
    return null;
  }

  const providerId =
    selectedNavItem.type === "preset" ||
    selectedNavItem.type === "codingPlan" ||
    selectedNavItem.type === "teamPlan"
      ? selectedNavItem.presetId
      : null;
  if (
    !providerId ||
    (selectedNavItem.type === "codingPlan" && isStartPlanModelProviderId(providerId))
  ) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  if (!familySpec) {
    return null;
  }

  const options = buildProviderFamilyConnectionOptions({
    familyId: familySpec.id,
    navigationItems,
    startPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.startPlan",
    }),
    codingPlanLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.codingPlan",
    }),
    teamPlanFallbackLabel: intl.formatMessage({
      id: "settings.modelProvider.connectionMode.teamPlan",
    }),
  });
  if (options.length === 0) {
    return null;
  }

  // 团队导航条目可能复用个人 provider；选中身份只来自已保存／提交中的付费选择。
  const selection = connectionSelections?.[familySpec.id];
  const isCurrentFamily =
    activeProviderFamily === undefined || activeProviderFamily === familySpec.id;
  const selectedOption =
    selection && isCurrentFamily
      ? options.find((option) =>
          connectionSelectionMatchesNavigationItem(familySpec.id, selection, option.item),
        )
      : undefined;
  if (options.length === 1 && selectedOption) return null;
  const connectionModeLabel = intl.formatMessage({
    id: connectionSettingsFailed
      ? "settings.modelProvider.connectionMode.loadFailed"
      : "settings.modelProvider.connectionMode",
  });

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span
        className={[
          "inline-flex min-w-0 shrink-0 items-center gap-1 text-ui-base",
          connectionSettingsFailed ? "text-warning" : "text-foreground-subtle",
        ].join(" ")}
      >
        {connectionSettingsFailed ? <InfoIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{connectionModeLabel}</span>
      </span>
      <Select
        value={selectedOption?.key ?? ""}
        onValueChange={(optionKey) => {
          const option = options.find((item) => item.key === optionKey);
          if (!option) {
            return;
          }
          onSelectNavItem(option.item);
        }}
      >
        <SelectTrigger
          size="lg"
          // 固定最大宽度会在宽屏仍截断全称；先占用剩余空间，只有不足控件基本宽度时才换行。
          className="min-w-0 max-w-fit flex-1 basis-12 justify-between"
          aria-label={connectionModeLabel}
          data-testid={TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER}
        >
          <SelectValue
            className="min-w-0 flex-1"
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchase.selectPlan",
            })}
          >
            {selectedOption ? (
              <span className="min-w-0 truncate text-left">{selectedOption.label}</span>
            ) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="min-w-40 max-w-[calc(100vw-2rem)]">
          {options.map((option) => (
            <SelectItem
              key={option.key}
              value={option.key}
              className="min-w-0 whitespace-normal pr-8 [overflow-wrap:anywhere]"
              data-testid={testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, option.key)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function buildProviderFamilyConnectionOptions({
  familyId,
  navigationItems,
  codingPlanLabel,
  teamPlanFallbackLabel,
}: {
  familyId: string;
  navigationItems: ModelProviderNavItem[];
  startPlanLabel: string;
  codingPlanLabel: string;
  teamPlanFallbackLabel: string;
}): ProviderFamilyConnectionOption[] {
  const options: ProviderFamilyConnectionOption[] = [];
  for (const item of navigationItems) {
    if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
      continue;
    }
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec || familySpec.id !== familyId) {
      continue;
    }
    if (item.type === "preset" || isStartPlanModelProviderId(item.presetId)) continue;
    if (item.type === "teamPlan") {
      options.push({
        key: item.key,
        item,
        label: formatTeamPlanConnectionLabel(item.teamPlanName, teamPlanFallbackLabel),
        order: 100 + options.length,
      });
      continue;
    }
    options.push({
      key: item.key,
      item,
      label: codingPlanLabel,
      order: 10,
    });
  }

  return options.sort((left, right) => left.order - right.order);
}

function formatTeamPlanConnectionLabel(
  teamPlanName: string | null | undefined,
  fallbackLabel: string,
): string {
  const normalized = teamPlanName?.trim();
  if (!normalized) {
    return fallbackLabel;
  }
  // 团队项目名已由权益接口提供，额外拼接英文 Plan 会破坏中文和自定义名称。
  return normalized;
}
