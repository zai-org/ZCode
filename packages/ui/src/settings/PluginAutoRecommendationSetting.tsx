import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

export function PluginAutoRecommendationSetting() {
  const { intl } = useZCodeIntl();
  const services = useBaseWorkspaceServices();
  const { settings, loading, update } = useSettings({ services });
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.pluginAutoRecommendation" });
  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ pluginAutoRecommendationEnabled: enabled });
    } catch (error) {
      logger.warn("[settings] 保存插件自动推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.pluginAutoRecommendationSaveError" }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRow
      searchId="settings.pluginAutoRecommendation"
      controlLayout="wide"
      label={label}
      description={intl.formatMessage({ id: "settings.pluginAutoRecommendationDescription" })}
      control={
        <Switch
          data-testid="settings-plugin-auto-recommendation"
          aria-label={label}
          checked={settings?.pluginAutoRecommendationEnabled === true}
          disabled={loading || saving}
          onCheckedChange={(enabled) => void save(enabled)}
        />
      }
    />
  );
}
