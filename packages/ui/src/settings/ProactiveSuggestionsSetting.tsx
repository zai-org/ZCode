import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

export function ProactiveSuggestionsSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const isOfficeMode = useIsOfficeMode();
  const [saving, setSaving] = useState(false);
  const setSuggestions = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ proactiveSuggestionsEnabled: enabled });
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: enabled })
        .catch((cause: unknown) => {
          logger.warn("[settings] 回写引导记录失败", { error: String(cause) });
        });
    } catch (error) {
      logger.warn("[settings] 更新主动任务推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.saveError" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      searchId="chat.officeSuggestions.setting"
      label={intl.formatMessage({ id: "chat.officeSuggestions.setting" })}
      description={intl.formatMessage({ id: "chat.officeSuggestions.settingDescription" })}
      control={
        <Switch
          checked={isOfficeMode && settings?.proactiveSuggestionsEnabled === true}
          disabled={!isOfficeMode || saving || !settings}
          onCheckedChange={setSuggestions}
          aria-label={intl.formatMessage({ id: "chat.officeSuggestions.setting" })}
        />
      }
    />
  );
}
