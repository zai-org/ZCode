import { ChevronLeft, FolderOpen, LoaderCircle } from "lucide-react";
import {
  type StorageCategoryId,
  type StorageRootUsage,
  STORAGE_MORE_ENTRIES_PATH,
} from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  STORAGE_CATEGORY_ICONS,
  joinStoragePath,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
} from "./storageCategoryPresentation.js";

export function StorageCategoryDetail({
  categoryId,
  roots,
  cleaning,
  disabled,
  onBack,
  onClean,
  onReveal,
}: {
  categoryId: StorageCategoryId;
  roots: StorageRootUsage[];
  cleaning: boolean;
  disabled: boolean;
  onBack: () => void;
  onClean: () => void;
  onReveal: (absolutePath: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const Icon = STORAGE_CATEGORY_ICONS[categoryId];
  const perRoot = roots
    .map((root) => ({ root, category: root.categories.find((item) => item.id === categoryId) }))
    .filter((item) => item.category && item.category.bytes > 0);
  const totalBytes = perRoot.reduce((sum, item) => sum + (item.category?.bytes ?? 0), 0);
  const cleanability = perRoot[0]?.category?.cleanability ?? "none";

  return (
    <div data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL} className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK}
          onClick={onBack}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "resourceManager.storage.detailBack" })}
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: storageCategoryTitleId(categoryId) })}
          </div>
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: storageCategoryDescriptionId(categoryId) })}
          </div>
        </div>
        <span className="text-ui-base tabular-nums text-foreground">{formatBytes(totalBytes)}</span>
        {cleanability !== "none" && totalBytes > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, categoryId)}
            disabled={disabled}
            onClick={onClean}
          >
            {cleaning ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({
              id: cleaning ? "resourceManager.storage.cleaning" : "resourceManager.storage.clean",
            })}
          </Button>
        ) : null}
      </div>
      {perRoot.map(({ root, category }) => (
        <div key={root.id} className="overflow-hidden rounded-xl border border-card-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-ui-caption">
            <span
              className="min-w-0 flex-1 truncate font-mono text-foreground-subtle"
              title={root.path}
            >
              {root.path}
            </span>
            <span className="tabular-nums text-foreground">
              {formatBytes(category?.bytes ?? 0)}
            </span>
          </div>
          {(category?.entries ?? []).map((entry) => {
            const isMore = entry.relativePath === STORAGE_MORE_ENTRIES_PATH;
            return (
              <div
                key={entry.relativePath}
                data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY}
                className="flex items-center gap-3 border-t border-border px-4 py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate font-mono text-ui-base text-foreground"
                    title={entry.relativePath}
                  >
                    {isMore
                      ? intl.formatMessage(
                          { id: "resourceManager.storage.moreEntries" },
                          { count: entry.fileCount },
                        )
                      : entry.relativePath}
                  </span>
                  <span className="block text-ui-caption text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "resourceManager.storage.filesCount" },
                      { count: entry.fileCount },
                    )}
                  </span>
                </span>
                <span className="text-ui-base tabular-nums text-foreground">
                  {formatBytes(entry.bytes)}
                </span>
                {isMore ? null : (
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover"
                    title={intl.formatMessage({ id: "resourceManager.storage.reveal" })}
                    aria-label={intl.formatMessage({ id: "resourceManager.storage.reveal" })}
                    onClick={() => void onReveal(joinStoragePath(root.path, entry.relativePath))}
                  >
                    <FolderOpen className="size-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
