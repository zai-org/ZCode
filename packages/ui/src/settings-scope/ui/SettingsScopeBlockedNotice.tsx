import { LoaderCircle, WifiOff } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SettingsScopeDevice, SettingsScopeState } from "@/settings-scope/contract.js";

export type SettingsScopeBlock = "offline" | "connecting";

/**
 * 选中设备不能读写时，分区不渲染任何列表或表单（fail-closed）：
 * - 选中项所在设备离线 → offline；
 * - 选中「用户」但该设备的 attachment / home 尚未就绪 → connecting，失败或无「用户」→ offline。
 * 不回退到本机，也不显示可写的旧快照。
 */
export function resolveSettingsScopeBlock(
  scope: Pick<SettingsScopeState, "resolution" | "user">,
  userSelected: boolean,
): SettingsScopeBlock | null {
  // 目录加载中或项目回退尚未完成时，不能用用户配置替代待解析的工作区。
  if (scope.resolution.status === "missing") return "connecting";
  if (scope.resolution.status === "offline") return "offline";
  if (!userSelected) return null;
  if (scope.user.status === "ready") return null;
  return scope.user.status === "connecting" ? "connecting" : "offline";
}

export function SettingsScopeBlockedNotice({
  state,
  device,
}: {
  state: SettingsScopeBlock;
  device: SettingsScopeDevice;
}) {
  const { intl } = useZCodeIntl();
  const name =
    device.kind === "local"
      ? intl.formatMessage({ id: "settings.scope.localDevice" })
      : device.name || intl.formatMessage({ id: "settings.machine.unknownRemote" });
  const Icon = state === "offline" ? WifiOff : LoaderCircle;
  return (
    <div
      data-testid="settings-scope-blocked"
      data-scope-blocked={state}
      className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle"
    >
      <Icon
        className={state === "connecting" ? "size-4 animate-spin" : "size-4"}
        aria-hidden="true"
      />
      <span>
        {intl.formatMessage(
          {
            id:
              state === "offline"
                ? "settings.scope.deviceOffline"
                : "settings.scope.deviceConnecting",
          },
          { device: name },
        )}
      </span>
    </div>
  );
}
