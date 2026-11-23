import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import * as RovingFocusGroup from "@radix-ui/react-roving-focus";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState({ side: 9, align: -5 });
  const contentRef = useRef<HTMLDivElement>(null);
  const openedByHover = useRef(false);
  useEffect(() => {
    if (!open || narrow) return;
    // 标题与子面板之间存在间隙，按真实几何区域判断离开，避免靠延时维持展开。
    const onPointerMove = (event: PointerEvent) => {
      if (!openedByHover.current || event.pointerType !== "mouse") return;
      const trigger = triggerRef.current?.getBoundingClientRect();
      const content = contentRef.current?.getBoundingClientRect();
      if (!trigger || !content) return;
      const inside = (rect: { left: number; right: number; top: number; bottom: number }) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      const gap = {
        left: content.left >= trigger.right ? trigger.right : content.right,
        right: content.left >= trigger.right ? content.left : trigger.left,
        top: Math.min(trigger.top, content.top),
        bottom: Math.max(trigger.bottom, content.bottom),
      };
      if (!inside(trigger) && !inside(content) && !inside(gap)) setOpen(false);
    };
    document.addEventListener("pointermove", onPointerMove);
    return () => document.removeEventListener("pointermove", onPointerMove);
  }, [open, narrow]);

  const handleOpenChange = (next: boolean) => {
    if (next && triggerRef.current) {
      const row = triggerRef.current.getBoundingClientRect();
      const menu = triggerRef.current
        .closest('[data-testid="composer-model-panel"]')!
        .getBoundingClientRect();
      // 子菜单默认锚定行的内边缘；补偿父菜单 padding/border 后外框对齐并留 4px。
      setOffset({ side: menu.right - row.right + 4, align: menu.top - row.top });
    }
    setOpen(next);
  };
  const contents = (
    <>
      {error ? (
        <div role="alert" className="px-2 py-1 text-ui-sm text-destructive">
          {error}
        </div>
      ) : null}
      <RovingFocusGroup.Root asChild orientation="vertical" loop>
        <div
          role="listbox"
          aria-label={label}
          data-composer-provider-list
          className="min-h-0 overflow-y-auto"
        >
          {groups.map((candidate, index) => (
            <Fragment key={candidate.key}>
              {index > 0 && candidate.key === separatorBeforeKey ? (
                // 原因：默认负边距会撑出滚动列表 4px；列表内分隔线必须留在横向边界内。
                <div role="separator" className="my-1 h-px shrink-0 bg-border/50" />
              ) : null}
              <RovingFocusGroup.Item
                asChild
                active={candidate.key === group?.key}
                focusable={!disabled && !isDisabled?.(candidate)}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={candidate.key === group?.key}
                  disabled={disabled || isDisabled?.(candidate)}
                  aria-label={[candidate.label, candidate.labelBadge].filter(Boolean).join(" ")}
                  data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, candidate.key)}
                  data-model-provider-key={candidate.key}
                  className="relative flex w-full min-h-8 items-center gap-2 rounded-md py-1.5 pl-2 pr-8 text-left text-ui-base outline-none hover:bg-menu-hover focus-visible:bg-menu-hover disabled:pointer-events-none disabled:text-foreground-subtlest"
                  onClick={() => {
                    onSelect(candidate);
                    setOpen(false);
                  }}
                >
                  <ProviderLogo logo={candidate.logo} className="size-4 rounded-sm" />
                  {/* 名称不占满剩余空间，避免把接入标签推到行尾。 */}
                  <span className="min-w-0 whitespace-normal break-words">{candidate.label}</span>
                  <ProviderAccessBadge group={candidate} />
                  {candidate.key === group?.key ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="absolute right-2 size-4 text-foreground-subtle"
                    />
                  ) : null}
                </button>
              </RovingFocusGroup.Item>
            </Fragment>
          ))}
        </div>
      </RovingFocusGroup.Root>
      {providerFooter ? (
        <>
          {groups.length > 0 ? (
            <div role="separator" className="-mx-1 my-1 h-px shrink-0 bg-border/50" />
          ) : null}
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
      "w-full min-h-8 justify-start gap-3 px-2 hover:bg-menu-hover data-[state=open]:bg-menu-hover",
  };
  if (narrow)
    return open ? (
      <>
        <Button
          type="button"
          variant="ghost"
          data-testid="composer-provider-back"
          className="shrink-0 justify-start"
          onClick={() => {
            setOpen(false);
          }}
        >
          <ChevronLeftIcon />
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <div role="separator" className="-mx-1 my-1 h-px shrink-0 bg-border/50" />
        {contents}
      </>
    ) : (
      <>
        <Button
          type="button"
          variant="ghost"
          {...triggerProps}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") setOpen(true);
          }}
          onClick={() => {
            setOpen(true);
          }}
        >
          {title}
          {loadingIndicator ?? (
            <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
          )}
        </Button>
        {children}
      </>
    );
  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            {...triggerProps}
            type="button"
            variant="ghost"
            ref={triggerRef}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse" || open || triggerProps.disabled) return;
              openedByHover.current = true;
              handleOpenChange(true);
            }}
            onClick={(event) => {
              if (open && openedByHover.current) {
                // 悬停已展开时，点击进入操作，不让 Trigger 再次切换成关闭。
                event.preventDefault();
                openedByHover.current = false;
                contentRef.current
                  ?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
                  ?.focus();
              } else openedByHover.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                openedByHover.current = false;
                handleOpenChange(true);
                if (open)
                  contentRef.current
                    ?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
                    ?.focus();
              }
            }}
          >
            {title}
            {loadingIndicator ?? (
              <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="composer-provider-panel"
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            // 悬停仅预览 Provider，不能夺取搜索输入焦点。
            if (openedByHover.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (openedByHover.current) event.preventDefault();
          }}
          onPointerDownCapture={() => {
            openedByHover.current = false;
          }}
          aria-label={label}
          side="right"
          align="start"
          sideOffset={offset.side}
          alignOffset={offset.align}
          collisionPadding={12}
          className="z-[61] w-max min-w-0 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) gap-0 rounded-lg bg-menu p-1 text-foreground [app-region:no-drag]"
        >
          {contents}
        </PopoverContent>
      </Popover>
      {children}
    </>
  );
}
