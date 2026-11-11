import { LoaderCircle } from "lucide-react";
import { type StorageCategoryId } from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT,
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL,
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG,
} from "@zcode/shared/test-ids";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { storageCategoryTitleId } from "./storageCategoryPresentation.js";

export interface StorageCleanConfirmTarget {
  categoryId: StorageCategoryId;
  bytes: number;
}

export function StorageCleanConfirmDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: StorageCleanConfirmTarget | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => (!open && !pending ? onCancel() : undefined)}
    >
      <AlertDialogContent data-testid={TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target
              ? intl.formatMessage(
                  { id: "resourceManager.storage.confirmTitle" },
                  {
                    category: intl.formatMessage({ id: storageCategoryTitleId(target.categoryId) }),
                  },
                )
              : null}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `${intl.formatMessage({ id: `resourceManager.storage.confirmDescription.${target.categoryId}` })} ${intl.formatMessage(
                  { id: "resourceManager.storage.confirmSize" },
                  { size: formatBytes(target.bytes) },
                )}`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid={TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL}
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid={TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "resourceManager.storage.clean" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
