import type { ProviderSettingsView } from "@zcode/services";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { resolveProviderTemplateName } from "@zcode/provider";
import { toZhOrEnLocale } from "@zcode/shared";
import type { ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

type ProviderTemplateCreate = (templateId: string) => Promise<void>;
type CustomProviderCreate = (label: string) => Promise<void>;

export function ProviderTemplatePicker({
  templates,
  onBack,
  onCreateFromTemplate,
  onCreateCustom,
  creating,
}: {
  templates: ProviderSettingsView["providerTemplates"];
  onBack: () => void;
  onCreateFromTemplate: ProviderTemplateCreate;
  onCreateCustom: CustomProviderCreate;
  creating: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  const customLabel = intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  const zhipuIds = ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"];
  const groups = [
    {
      id: "zhipu",
      templates: zhipuIds.flatMap((id) =>
        templates.filter((template) => template.templateId === id),
      ),
    },
    {
      id: "other",
      templates: templates.filter((template) => !zhipuIds.includes(template.templateId)),
    },
  ] as const;
  const createWithFeedback = async (create: () => Promise<void>) => {
    const feedbackKey = "provider-template-create";
    dismissFeedback(feedbackKey);
    try {
      await create();
    } catch (error) {
      // Template 创建失败过去只写日志，用户留在选择页却看不到任何结果。
      // 失败继续留在当前页，并复用详情栏底部反馈横幅提供同一次创建的重试入口。
      // 完整 Schema issues 只进入统一 UI 日志；横幅保持可读摘要，避免原始数组撑满详情区。
      logger.error("[ProviderTemplatePicker] 创建供应商失败", error);
      const retry = () => void createWithFeedback(create);
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.templateCreateFailed" }),
        actionLabel: intl.formatMessage({ id: "settings.modelProvider.templateCreateRetry" }),
        onAction: retry,
        dismissible: true,
      });
    }
  };
  return (
    <section className="space-y-5" data-testid={TID_MODEL_PROVIDER_TEMPLATE_PICKER}>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.templatePickerTitle" })}
        </h2>
      </div>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.id} data-provider-template-group={group.id} className="space-y-3">
            <h3 className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `settings.modelProvider.templateGroup.${group.id}` })}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.id === "other" ? (
                <ProviderTemplateCard
                  label={intl.formatMessage({ id: "settings.modelProvider.createCustomProvider" })}
                  disabled={creating}
                  testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}
                  icon={
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover">
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </span>
                  }
                  onClick={() => void createWithFeedback(() => onCreateCustom(customLabel))}
                />
              ) : null}
              {group.templates.map((template) => {
                const label = resolveProviderTemplateName(
                  template.templateId,
                  template,
                  // Provider 模板名只有中英两套。
                  toZhOrEnLocale(locale),
                );
                return (
                  <ProviderTemplateCard
                    key={template.templateId}
                    label={label}
                    disabled={creating}
                    testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId)}
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center">
                        <ProviderLogo logo={template.config.logo} className="size-8" />
                      </span>
                    }
                    onClick={() =>
                      void createWithFeedback(() => onCreateFromTemplate(template.templateId))
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ProviderTemplateCard({
  label,
  disabled,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  disabled: boolean;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <button
        type="button"
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </ControlHintTooltip>
  );
}
