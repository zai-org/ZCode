import type { ZCodeInteractionRequestOrigin } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: ZCodeInteractionRequestOrigin;
}) {
  const { intl } = useZCodeIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // description 点名是哪个子代理在问（动态工作流子代理为 `<名字> (<siteId>@<ordinal>)`，
  // docs/dynamic-workflow/launch.md「Permissions inside a run」）；来源描述完整换行显示。
  const description = origin.description?.trim();
  const label = description
    ? intl.formatMessage({ id: "chat.interactionOrigin.subagent.named" }, { description })
    : intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = !origin.agentType
    ? label
    : description
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.titleNamed" },
          { agentType: origin.agentType, description },
        )
      : intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.title" },
          { agentType: origin.agentType },
        );

  return (
    <span
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn(
        "block w-full min-w-0 basis-full whitespace-normal [overflow-wrap:anywhere] text-ui-base font-normal text-foreground-subtle",
        className,
      )}
    >
      {/* 完整换行避免长名称被裁切，连续的实例标识也不能撑出窄屏容器。 */}
      {label}
    </span>
  );
}
