import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「单击 HTML 文件时在内置浏览器中打开」。这是本机用户的界面偏好，固定读写本机 base host 的设置，
 * 设置页在远端 workspace 下渲染时也不写到远端。文件树读同一份设置。
 */
export function FileTreeHtmlOpenSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings({ services: useBaseWorkspaceServices() });
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowser" });

  const handleChange = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ fileTreeHtmlClickOpensBrowser: enabled });
    } catch (error) {
      logger.warn("[settings] 更新 HTML 文件打开方式失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.browser.htmlClickOpensBrowserSaveError" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      searchId="settings.browser.htmlClickOpensBrowser"
      label={label}
      description={intl.formatMessage({
        id: "settings.browser.htmlClickOpensBrowserDescription",
      })}
      control={
        <Switch
          aria-label={label}
          checked={settings?.fileTreeHtmlClickOpensBrowser === true}
          disabled={saving || !settings}
          onCheckedChange={(checked) => void handleChange(checked)}
        />
      }
    />
  );
}
