import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ConnectionProfile, SourceServerRecord } from "@zcode/shared";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { RemoteConnectionFields } from "@/RemoteConnectionFields.js";
import { collectRemoteFormFieldErrors } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionKindTag } from "@/remote-connection/RemoteConnectionTags.js";

type EditConnectionProfileDialogProps = {
  open: boolean;
  profile: ConnectionProfile | null;
  source?: SourceServerRecord;
  management: ISourceServerManagementService;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  focusField?: "host" | "auth";
};

export function EditConnectionProfileDialog(props: EditConnectionProfileDialogProps) {
  return props.open && props.profile ? (
    <EditConnectionProfileForm key={props.profile.profileId} {...props} profile={props.profile} />
  ) : null;
}

function EditConnectionProfileForm({
  open,
  profile,
  source,
  management,
  onOpenChange,
  onSaved,
  focusField,
}: EditConnectionProfileDialogProps & { profile: ConnectionProfile }) {
  const { intl } = useZCodeIntl();
  const form = useRemoteConnectionForm({
    open,
    isWindowsDesktop: profile.transport === "wsl",
    preferredKind: profile.transport,
    preserveDraftOnOpen: true,
    savedSshConfigAlias: profile.target.kind === "ssh" ? profile.target.sshConfigAlias : undefined,
  });
  const {
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
  } = form;
  const [name, setName] = useState(profile.displayName ?? profile.transport);
  const [deviceName, setDeviceName] = useState(source?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  // 0 表示尚未保存；每次字段校验失败递增，用于显示内联错误并聚焦第一个出错字段。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement | null>(null);
  // 与新建向导共用校验规则；已保存密码的 SSH 连接允许密码留空沿用原凭据。
  const fieldErrors = collectRemoteFormFieldErrors(
    intl,
    {
      kind: profile.transport,
      host,
      port,
      username,
      sshAuthMethod,
      password: password.trim(),
      privateKeyPath,
      privateKeyPassphrase,
      wslDistro,
      wslUser,
      dockerContainer,
      manualDockerContainer,
    },
    {
      passwordOptional:
        profile.target.kind === "ssh" && Boolean(profile.target.passwordCredentialKey),
    },
  );
  useEffect(() => {
    if (validationAttempt === 0) return;
    // Bugfix: 从「修改主机/认证」入口打开时，focusField 会让主机或密码一直带 aria-invalid 作为提示，
    // 只按 aria-invalid 查找会把焦点给被提示的字段而不是真正出错的字段。
    // 只有存在校验错误的字段才会关联 aria-describedby，因此用两者同时成立来定位第一个出错字段。
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"][aria-describedby]')?.focus();
  }, [validationAttempt]);
  const initializeFields = useEffectEvent(() => {
    if (profile.target.kind === "ssh") {
      form.setHost(profile.target.host);
      form.setPort(String(profile.target.port ?? 22));
      form.setUsername(profile.target.username);
      form.setSshAuthMethod(profile.target.privateKeyPath ? "privateKey" : "password");
      form.setPrivateKeyPath(profile.target.privateKeyPath ?? "");
      if (profile.target.sshConfigAlias)
        form.applySshConfigAlias({
          alias: profile.target.sshConfigAlias,
          host: profile.target.host,
          port: profile.target.port ?? 22,
          username: profile.target.username,
          privateKeyPath: profile.target.privateKeyPath,
        });
      form.setAssetInstallMode(
        profile.target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE,
      );
    } else if (profile.target.kind === "wsl") {
      form.setWslDistro(profile.target.distro ?? "");
      form.setWslUser(profile.target.user ?? "");
    } else {
      form.setManualDockerContainer(profile.target.container);
    }
  });
  useEffect(() => {
    initializeFields();
  }, [profile.profileId]);
  const handleSave = async () => {
    if (savingRef.current) return;
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(intl.formatMessage({ id: "settings.source.connectionNameRequired" }));
      return;
    }
    if (source && !deviceName.trim()) {
      setError(intl.formatMessage({ id: "settings.source.deviceNameRequired" }));
      return;
    }

    if (fieldErrors.length > 0) {
      // 字段错误显示在字段下方（RDUX-27），顶部错误条只留给名称和保存失败。
      setError("");
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }

    let target;
    if (profile.target.kind === "ssh") {
      const normalizedPort = Number(port.trim() || "22");
      target = {
        kind: "ssh" as const,
        host: host.trim(),
        port: normalizedPort,
        username: username.trim(),
        assetInstallMode,
        ...(form.selectedSshConfigAlias ? { sshConfigAlias: form.selectedSshConfigAlias } : {}),
        ...(profile.target.resourcePackages
          ? { resourcePackages: profile.target.resourcePackages }
          : {}),
        ...(sshAuthMethod === "password" && password.trim() ? { password: password.trim() } : {}),
        ...(sshAuthMethod === "privateKey"
          ? {
              privateKeyPath: privateKeyPath.trim(),
              ...(privateKeyPassphrase.trim()
                ? { privateKeyPassphrase: privateKeyPassphrase.trim() }
                : {}),
            }
          : {}),
      };
    } else if (profile.target.kind === "wsl") {
      target = {
        kind: "wsl" as const,
        ...(wslDistro.trim() ? { distro: wslDistro.trim() } : {}),
        ...(wslUser.trim() ? { user: wslUser.trim() } : {}),
      };
    } else {
      target = {
        kind: "docker" as const,
        container: (manualDockerContainer || dockerContainer).trim(),
      };
    }

    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await management.updateProfile({
        profileId: profile.profileId,
        profileDisplayName: normalizedName,
        ...(source && deviceName.trim() !== source.displayName
          ? { sourceDisplayName: deviceName.trim() }
          : {}),
        ...(profile.target.kind === "ssh" ? { sshAuthMethod } : {}),
        target,
      });
      onSaved?.();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!savingRef.current) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg gap-0 overflow-y-auto p-0">
        <form
          ref={formRef}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader className="border-b border-border px-5 py-4 pr-14">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-ui-lg font-semibold">
                {intl.formatMessage({ id: "settings.source.editConnectionTitle" })}
              </DialogTitle>
              <RemoteConnectionKindTag kind={profile.transport} />
            </div>
            <DialogDescription className="text-ui-sm">
              {intl.formatMessage({ id: "settings.source.editConnectionDescription" })}
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving} className="min-w-0 space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <label htmlFor="edit-connection-name" className="text-ui-sm font-medium">
                {intl.formatMessage({ id: "settings.source.connectionName" })}
              </label>
              <Input
                id="edit-connection-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            {source ? (
              <div className="space-y-1.5">
                <label htmlFor="edit-device-name" className="text-ui-sm font-medium">
                  {intl.formatMessage({ id: "settings.source.deviceName" })}
                </label>
                <Input
                  id="edit-device-name"
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.currentTarget.value)}
                />
              </div>
            ) : null}
            <RemoteConnectionFields
              {...form}
              kind={profile.transport}
              runtimeOptionsLoading={form.currentRuntimeOptionsLoading}
              focusField={focusField}
              fieldErrors={validationAttempt > 0 ? fieldErrors : []}
              passwordPlaceholder={
                profile.target.kind === "ssh" && profile.target.passwordCredentialKey
                  ? intl.formatMessage({ id: "settings.source.keepSavedSecret" })
                  : undefined
              }
              privateKeyPassphrasePlaceholder={
                profile.target.kind === "ssh" && profile.target.privateKeyPassphraseCredentialKey
                  ? intl.formatMessage({ id: "settings.source.keepSavedSecret" })
                  : undefined
              }
            />
            {error ? (
              <p
                role="alert"
                className="rounded-md bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
              >
                {error}
              </p>
            ) : null}
          </fieldset>
          <DialogFooter className="border-t border-border px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button type="submit" disabled={saving} aria-busy={saving}>
              {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              {intl.formatMessage({ id: saving ? "common.saving" : "common.saveChanges" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
