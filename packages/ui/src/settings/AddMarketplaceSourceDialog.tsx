import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { FolderOpen, LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 * 顶栏 New 直接打开添加市场源对话框：收编原 AddMarketplacePopover 的
 * github/git/URL/本地路径（含拖放与目录选择）能力，零后端新增。
 */
export function AddMarketplaceSourceDialog({
  open,
  onOpenChange,
  onAddMarketplace,
  activeOperations,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddMarketplace: (source: string) => Promise<boolean>;
  activeOperations: ReadonlyArray<{ id: string }>;
  error?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // 仅桌面端能把拖拽 File / 目录选择框解析成 agent 可访问的本地绝对路径；Web 端隐藏这些入口。
  const canPickPath = platform?.canSelectFilePath ?? false;
  const [source, setSource] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const riskAcknowledgementId = useId();
  const trimmedSource = source.trim();
  const adding = activeOperations.some(
    (operation) => operation.id === `marketplace:add:${trimmedSource}`,
  );
  // 本地输入法 composition 态：部分平台 isComposing 会提前翻 false，靠 ref 兜底，避免候选确认误触发添加。
  const compositionActiveRef = useRef(false);
  // 防重复提交：Enter 与点击共用，避免 store 回写前的窗口里重复发起同一来源的添加。
  const pendingRef = useRef(false);

  useEffect(() => {
    // 风险确认仅属于本次弹框，关闭后不得沿用上次勾选。
    if (!open) setRiskAcknowledged(false);
  }, [open]);

  const handleAdd = async () => {
    // 按钮和 Enter 共用门槛，避免键盘提交绕过风险确认。
    if (!riskAcknowledged || trimmedSource.length === 0 || adding || pendingRef.current) return;
    pendingRef.current = true;
    try {
      const added = await onAddMarketplace(trimmedSource);
      // 失败时保留输入与弹层，让用户结合上方错误提示修正来源后重试。
      if (added) {
        setSource("");
        onOpenChange(false);
      }
    } finally {
      pendingRef.current = false;
    }
  };

  const handleChooseDirectory = async () => {
    if (!platform) return;
    try {
      const dir = await platform.selectDirectory();
      if (dir) setSource(dir);
    } catch {
      // 取消或对话框异常时静默：保留当前输入，不打断添加流程。
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = platform?.getPathForFile?.(file)?.trim();
    if (path) setSource(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plugin-store-add-source-dialog"
        className={cn(
          "w-[min(420px,calc(100vw-2rem))] max-w-none transition-colors",
          canPickPath && dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
        onDragOver={
          canPickPath
            ? (event) => {
                event.preventDefault();
                setDragActive(true);
              }
            : undefined
        }
        onDragLeave={
          canPickPath
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragActive(false);
                }
              }
            : undefined
        }
        onDrop={canPickPath ? handleDrop : undefined}
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
        </DialogTitle>
        <DialogDescription
          data-testid="plugin-store-add-source-risk-warning"
          className="rounded-xl bg-warning-surface p-3 text-ui-base text-warning-surface-foreground"
        >
          {intl.formatMessage({ id: "settings.plugins.marketplaces.riskWarning" })}
        </DialogDescription>
        {error ? (
          <div
            className="max-h-[min(240px,40vh)] min-w-0 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base whitespace-pre-wrap break-words text-destructive"
            data-testid="plugin-store-add-source-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Input
          type="text"
          data-testid="plugin-store-add-source-input"
          size="lg"
          autoFocus
          aria-label={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          onCompositionStart={() => {
            compositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                nativeEvent: event.nativeEvent,
              })
            ) {
              return;
            }
            event.preventDefault();
            void handleAdd();
          }}
          placeholder={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
        />
        {canPickPath ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.marketplaces.dropHint" })}
          </p>
        ) : null}
        <div className="flex items-start gap-2">
          <Checkbox
            id={riskAcknowledgementId}
            data-testid="plugin-store-add-source-risk-acknowledgement"
            className="mt-0.5"
            checked={riskAcknowledged}
            onCheckedChange={(checked) => setRiskAcknowledged(checked === true)}
            disabled={adding}
          />
          <Label htmlFor={riskAcknowledgementId} className="min-w-0 font-normal leading-relaxed">
            {intl.formatMessage({ id: "settings.plugins.marketplaces.riskAcknowledgement" })}
          </Label>
        </div>
        <div className="flex justify-end gap-2">
          {canPickPath ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => void handleChooseDirectory()}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.marketplaces.chooseDirectory" })}
            </Button>
          ) : null}
          <Button
            type="button"
            data-testid="plugin-store-add-source-submit"
            variant="default"
            size="lg"
            disabled={!riskAcknowledged || trimmedSource.length === 0 || adding}
            onClick={() => void handleAdd()}
          >
            {adding ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Plus data-icon="inline-start" aria-hidden="true" />
            )}
            {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
