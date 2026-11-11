import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared/test-ids";

const query = "(max-width: 639px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const snapshot = () => window.matchMedia(query).matches;

// 合并菜单曾只渲染名称而丢失接入标识；主行和子菜单复用同一目录字段。
function ProviderAccessBadge({ group }: { group: ModelSelectGroup }) {
  return group.labelBadge ? (
    <span
      data-provider-access-badge
      title={group.labelBadge}
      className="max-w-48 shrink-0 truncate rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
    >
      {group.labelBadge}
    </span>
  ) : null;
}

export function ComposerProviderMenu({
  groups,
  disabled = false,
  loading = false,
  isDisabled,
  separatorBeforeKey,
  group,
  label,
  providerFooter,
  onSelect,
  children,
  error,
}: {
  groups: readonly ModelSelectGroup[];
  disabled?: boolean;
  loading?: boolean;
  isDisabled?: (group: ModelSelectGroup) => boolean;
  separatorBeforeKey?: string;
  group: ModelSelectGroup | undefined;
  label: string;
  providerFooter?: ReactNode;
  onSelect: (group: ModelSelectGroup) => void;
  children: ReactNode;
  error?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const narrow = useSyncExternalStore(subscribe, snapshot, () => false);
  const [open, setOpen] = useState(false);
  // 切换失败后回到对应操作区域，避免错误藏在已关闭的 Provider 子菜单。
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ side: 9, align: -5 });
  const contents = (
    <>
      {error ? (
        <div role="alert" className="px-2 py-1 text-ui-sm text-destructive">
          {error}
        </div>
      ) : null}
      <DropdownMenuRadioGroup
        value={group?.key}
        data-composer-provider-list
        className="min-h-0 overflow-y-auto"
      >
        {groups.map((candidate, index) => (
          <Fragment key={candidate.key}>
            {index > 0 && candidate.key === separatorBeforeKey ? (
              // 原因：默认负边距会撑出滚动列表 4px；列表内分隔线必须留在横向边界内。
              <DropdownMenuSeparator className="mx-0 shrink-0 bg-border/50" />
            ) : null}
            <DropdownMenuRadioItem
              disabled={disabled || isDisabled?.(candidate)}
              value={candidate.key}
              aria-label={[candidate.label, candidate.labelBadge].filter(Boolean).join(" ")}
              data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, candidate.key)}
              data-model-provider-key={candidate.key}
              className="min-h-8 gap-2 pl-2 pr-8"
              onSelect={(event) => {
                event.preventDefault();
                onSelect(candidate);
                setOpen(false);
              }}
            >
              <ProviderLogo logo={candidate.logo} className="size-4 rounded-sm" />
              {/* 名称不占满剩余空间，避免把接入标签推到行尾。 */}
              <span className="min-w-0 whitespace-normal break-words">{candidate.label}</span>
              <ProviderAccessBadge group={candidate} />
            </DropdownMenuRadioItem>
          </Fragment>
        ))}
      </DropdownMenuRadioGroup>
      {providerFooter ? (
        <>
          {groups.length > 0 ? <DropdownMenuSeparator className="shrink-0 bg-border/50" /> : null}
          <div className="shrink-0">{providerFooter}</div>
        </>
      ) : null}
    </>
  );
  const title = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {group ? <ProviderLogo logo={group.logo} className="size-4 rounded-sm" /> : null}
      <span className="truncate">{group?.label ?? "—"}</span>
      {group ? <ProviderAccessBadge group={group} /> : null}
    </span>
  );
  const loadingIndicator = loading ? (
    <span
      data-testid="composer-provider-loading"
      role="status"
      aria-label={intl.formatMessage({ id: "common.loading" })}
      className="ml-auto inline-flex size-4 shrink-0 items-center justify-center text-foreground-subtle"
    >
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
    </span>
  ) : undefined;
  const triggerProps = {
    "data-testid": "composer-provider-trigger",
    "aria-label": `${label}: ${group?.label ?? "—"}`,
    disabled: disabled || loading || (!group && !providerFooter),
    "aria-busy": loading || undefined,
    className:
      "min-h-8 gap-3 data-[highlighted]:bg-menu-hover/50 data-[state=open]:bg-menu-hover/50",
  };
  if (narrow)
    return open ? (
      <>
        <DropdownMenuItem
          data-testid="composer-provider-back"
          className="shrink-0"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ChevronLeftIcon />
          {intl.formatMessage({ id: "common.back" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="shrink-0 bg-border/50" />
        {contents}
      </>
    ) : (
      <>
        <DropdownMenuItem
          {...triggerProps}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {title}
          {loadingIndicator ?? (
            <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
          )}
        </DropdownMenuItem>
        {children}
      </>
    );
  return (
    <>
      <DropdownMenuSub
        open={open}
        onOpenChange={(next) => {
          if (next && triggerRef.current) {
            const row = triggerRef.current.getBoundingClientRect();
            const menu = triggerRef.current.closest('[role="menu"]')!.getBoundingClientRect();
            // 子菜单默认锚定行的内边缘；补偿父菜单 padding/border 后外框对齐并留 4px。
            setOffset({ side: menu.right - row.right + 4, align: menu.top - row.top });
          }
          setOpen(next);
        }}
      >
        <DropdownMenuSubTrigger {...triggerProps} ref={triggerRef} indicator={loadingIndicator}>
          {title}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            sideOffset={offset.side}
            alignOffset={offset.align}
            collisionPadding={12}
            className="z-[61] w-max min-w-0 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) [app-region:no-drag]"
          >
            {contents}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      {children}
    </>
  );
}
