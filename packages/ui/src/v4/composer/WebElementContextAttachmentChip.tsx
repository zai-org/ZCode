import { Globe2Icon, MousePointer2Icon, Trash2Icon } from "lucide-react";
import { TID_WEB_ELEMENT_CONTEXT_CHIP } from "@zcode/shared/test-ids";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WebElementContextComposerAttachment } from "@/lib/webElementContext.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

function getElementTitle(context: WebElementContextComposerAttachment) {
  return (
    context.accessibleName || context.text || context.selector || context.tagName.toLowerCase()
  );
}

function getElementMeta(context: WebElementContextComposerAttachment) {
  const role = context.role ? `role=${context.role}` : null;
  const tagName = context.tagName.toLowerCase();
  return [tagName, role].filter(Boolean).join(" · ");
}

export function WebElementContextAttachmentChip({
  contexts,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  contexts: readonly WebElementContextComposerAttachment[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (contexts.length === 0) {
    return null;
  }

  const label = intl.formatMessage(
    {
      id: contexts.length === 1 ? "chat.webElements.one" : "chat.webElements.many",
    },
    { count: String(contexts.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.webElements.remove" });

  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<MousePointer2Icon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
      triggerProps={{ "data-testid": TID_WEB_ELEMENT_CONTEXT_CHIP, "data-count": contexts.length }}
    >
      {contexts.map((context) => (
        <div
          key={context.id}
          className="group/context flex min-h-7 cursor-default gap-2 rounded-lg px-2 py-1 text-ui-base/relaxed text-foreground hover:bg-menu-hover"
        >
          <Globe2Icon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              <span className="text-foreground-subtle tabular-nums">#{context.ordinal} </span>
              {getElementTitle(context)}
            </div>
            <div className="truncate font-mono text-ui-base text-foreground-subtle">
              {getElementMeta(context)}
            </div>
            <div className="truncate text-ui-base text-foreground-subtlest">
              {context.pageTitle || context.pageUrl}
            </div>
          </div>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
