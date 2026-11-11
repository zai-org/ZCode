import { useCallback, useRef, useState } from "react";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { LoaderCircle, Trash2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ModelInputCapabilityBadge } from "@/components/ModelInputCapabilityBadge.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import type { ModelConfigResolution, ProviderConfigObject } from "@zcode/provider";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";
import { useProviderDetailFeedback } from "@/settings/model-provider-section/ProviderDetailFeedback.js";

export function ModelRowInput({
  model,
  providerId,
  providerName = providerId,
  providerEnabled = true,
  providerAccess,
  inputTestId,
  deleteTestId,
  onCommit,
  onResolveDraft,
  settingsRevision = 0,
  onDelete,
  onEnabledChange,
  onTest,
}: {
  model: ProviderSettingsFormModel;
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  providerAccess?: ProviderConfigObject["access"];
  inputTestId?: string;
  deleteTestId?: string;
  onCommit: (model: ProviderSettingsFormModel, basedOnRevision: number) => void | Promise<void>;
  onResolveDraft?: (
    nextModelId: string,
    personalConfig: ProviderSettingsFormModel["personalConfig"],
  ) => Promise<ModelConfigResolution>;
  settingsRevision?: number;
  onDelete?: () => void;
  onEnabledChange?: (enabled: boolean) => void;
  onTest?: (model: string) => Promise<ModelConnectivityResult>;
}) {
  const { intl, locale } = useZCodeIntl();
  const { showFeedback } = useProviderDetailFeedback();
  const [isTesting, setIsTesting] = useState(false);
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const metadataSavingRef = useRef(false);
  const [commitErrorMessage, setCommitErrorMessage] = useState<string | null>(null);
  const [draftBasedOnRevision, setDraftBasedOnRevision] = useState(settingsRevision);
  // 外部 View 每次投影会产生新对象；编辑事务固定打开时的模型与 revision，不能跟随对象刷新重置。
  const [editingModel, setEditingModel] = useState(model);
  const editor = useProviderModelDraft({
    model: editingModel,
    open: metadataDialogOpen,
    scopeKey: providerId,
    resolve: onResolveDraft,
  });
  const { draft } = editor;
  const [draftErrorField, setDraftErrorField] = useState<
    | "id"
    | "contextWindow"
    | "maxOutputTokens"
    | "inputFormat"
    | "reasoningLevelValues"
    | "reasoningLevelMap"
    | null
  >(null);

  const updateDraft = (patch: Parameters<typeof editor.change>[0]) => {
    editor.change(patch);
    setDraftErrorField(null);
  };
  const commitDraft = async (): Promise<boolean> => {
    const result = await editor.commit();
    if (result.status === "invalid") {
      setDraftErrorField(result.field);
      return false;
    }
    setDraftErrorField(null);
    await onCommit(result.model, draftBasedOnRevision);
    return true;
  };

  const cancelMetadataDialog = useCallback(() => {
    editor.reset(model);
    setDraftErrorField(null);
    setCommitErrorMessage(null);
    setMetadataDialogOpen(false);
  }, [model]);

  const openMetadataDialog = useCallback(() => {
    setEditingModel(model);
    editor.reset(model);
    setDraftErrorField(null);
    setCommitErrorMessage(null);
    setDraftBasedOnRevision(settingsRevision);
    setMetadataDialogOpen(true);
  }, [model, settingsRevision]);

  const handleMetadataDialogOpenChange = useCallback(
    (open: boolean) => {
      // 保存期间 Esc/遮罩不能结束并重开草稿，否则旧保存回包会关闭新一轮编辑。
      if (metadataSavingRef.current) return;
      if (!open) {
        cancelMetadataDialog();
        return;
      }
      openMetadataDialog();
    },
    [cancelMetadataDialog, openMetadataDialog],
  );

  const handleMetadataDialogCommit = useCallback(async (): Promise<boolean> => {
    if (metadataSavingRef.current) return false;
    metadataSavingRef.current = true;
    setMetadataSaving(true);
    setCommitErrorMessage(null);
    try {
      if (!(await commitDraft())) return false;
      setMetadataDialogOpen(false);
      return true;
    } catch (error) {
      setCommitErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      metadataSavingRef.current = false;
      setMetadataSaving(false);
    }
  }, [commitDraft]);

  const handleTest = useCallback(async () => {
    if (!onTest || isTesting || !providerEnabled) {
      return;
    }

    const modelId = draft.idValue.trim();
    const dedupeKey = `model-test:${providerId}:${modelId}`;
    showFeedback({
      key: dedupeKey,
      message: intl.formatMessage(
        { id: "settings.modelProvider.testModel.connectingWithIdentity" },
        { provider: providerName, model: modelId },
      ),
      state: "pending",
      durationMs: 0,
    });
    setIsTesting(true);
    try {
      const result = await onTest(modelId);
      if (result.success) {
        showFeedback({
          key: dedupeKey,
          message: intl.formatMessage(
            { id: "settings.modelProvider.testModel.successWithIdentity" },
            { provider: providerName, model: modelId },
          ),
          state: "success",
          successEmphasis: true,
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
        });
      } else {
        const localizedReason =
          result.error.code === "provider-unavailable"
            ? intl.formatMessage({ id: "settings.modelProvider.testModel.providerUnavailable" })
            : result.error.code === "model-unavailable"
              ? intl.formatMessage({ id: "settings.modelProvider.testModel.modelUnavailable" })
              : result.error.message.trim();
        const reason =
          localizedReason || intl.formatMessage({ id: "settings.modelProvider.testModel.failed" });
        showFeedback({
          key: dedupeKey,
          message: intl.formatMessage(
            { id: "settings.modelProvider.testModel.failedWithIdentity" },
            { provider: providerName, model: modelId, reason },
          ),
          state: "failure",
          durationMs: 8_000,
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
        });
      }
    } catch (error) {
      showFeedback({
        key: dedupeKey,
        message: intl.formatMessage(
          { id: "settings.modelProvider.testModel.failedWithIdentity" },
          {
            provider: providerName,
            model: modelId,
            reason:
              error instanceof Error
                ? error.message
                : intl.formatMessage({ id: "settings.modelProvider.testModel.failed" }),
          },
        ),
        state: "failure",
        durationMs: 8_000,
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
    } finally {
      setIsTesting(false);
    }
  }, [
    onTest,
    isTesting,
    draft.idValue,
    intl,
    providerId,
    providerName,
    providerEnabled,
    showFeedback,
  ]);

  const testIcon = isTesting ? (
    <LoaderCircle className="size-3.5 text-foreground-subtle animate-spin" />
  ) : (
    <Unplug className="size-3.5 text-foreground-subtle" />
  );
  const draftErrorMessage =
    commitErrorMessage ??
    (draftErrorField
      ? intl.formatMessage({
          id: `settings.modelProvider.modelMetadata.invalid.${draftErrorField}`,
        })
      : null);
  const shouldShowTestButton = Boolean(onTest);
  const testDisabled = !providerEnabled || isTesting || !draft.idValue.trim() || !onTest;
  const contextWindowLabel = formatModelContextWindowLabel(
    model.config.properties?.contextWindow ?? 0,
    locale,
  );
  const contextWindowAccessibleLabel = intl.formatMessage(
    { id: "settings.modelProvider.contextWindowBadgeLabel" },
    { value: contextWindowLabel },
  );

  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            data-testid={inputTestId}
            className="min-w-0 truncate font-mono text-ui-base text-foreground"
          >
            {model.modelId}
          </span>
          <span
            className="inline-flex h-5 max-w-20 shrink-0 items-center truncate rounded-md border border-border bg-surface px-1.5 font-mono text-ui-sm text-foreground-subtle"
            aria-label={contextWindowAccessibleLabel}
            title={contextWindowAccessibleLabel}
          >
            {contextWindowLabel}
          </span>
          {shouldShowModelVisionBadge(
            model.modelId,
            model.config.properties?.inputFormat?.supportsImage,
            providerAccess,
          ) ? (
            <ModelInputCapabilityBadge />
          ) : null}
        </div>
        {shouldShowTestButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 p-0"
            disabled={testDisabled}
            title={intl.formatMessage({
              id: providerEnabled
                ? "settings.modelProvider.testModel"
                : "settings.modelProvider.testModel.enableProviderFirst",
            })}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={handleTest}
          >
            {testIcon}
          </Button>
        ) : null}
        <ProviderModelMetadataDialog
          onRestore={() => {
            setDraftErrorField(null);
            setCommitErrorMessage(null);
            void editor
              .restore()
              .catch((error) =>
                setCommitErrorMessage(error instanceof Error ? error.message : String(error)),
              );
          }}
          mode="edit"
          open={metadataDialogOpen}
          draft={draft}
          draftErrorMessage={draftErrorMessage}
          draftErrorField={draftErrorField}
          overrideFields={editor.overrides}
          inheritedConfig={editor.inheritedConfig}
          onOpenChange={handleMetadataDialogOpenChange}
          onDraftChange={updateDraft}
          onCommit={handleMetadataDialogCommit}
          saving={metadataSaving}
          modelConfigResolutionPending={editor.pending}
          modelDefaultsLoaded={editor.defaultsLoaded}
          onModelIdBlur={() => {
            void editor.flush().catch(() => undefined);
          }}
          modelIdReadOnly={model.builtin}
        />
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-foreground-subtle"
            data-testid={deleteTestId}
            aria-label={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            title={intl.formatMessage({ id: "settings.modelProvider.delete" })}
            onMouseDown={(event) => {
              // 输入框聚焦时点击删除会先触发 blur 保存，父层刷新后原按钮的 click 会丢失。
              event.preventDefault();
            }}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
        {onEnabledChange ? (
          <Switch
            size="sm"
            checked={model.config.enabled !== false}
            aria-label={intl.formatMessage({
              id:
                model.config.enabled === false
                  ? "settings.modelProvider.enableAction"
                  : "settings.modelProvider.disableAction",
            })}
            onCheckedChange={onEnabledChange}
          />
        ) : null}
      </div>
    </div>
  );
}
