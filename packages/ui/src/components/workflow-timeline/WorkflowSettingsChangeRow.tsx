// ============================================================
// 设置轮的那一行
// ============================================================
// 「配置」的一次修改在转写里留下一个控制轮：没有用户气泡，它的呈现是新 run 的卡，卡上方这一行说
// 改了什么——工具行的单行样式：滑杆图标、「已调整设置」、每项改动一段、时刻，以 `·` 相隔。
// 它是记录，不是控件。

import { Fragment } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowSettingsChangeSegments } from "./workflowSettingsChange.js";

export function WorkflowSettingsChangeRow({
  amend,
  at,
  providerName,
}: {
  amend: WorkflowSettingsAmendMeta;
  /** 设置轮的时刻；缺席即不写。 */
  at?: number;
  /** providerId → provider 名（与卡上的模型段同一个查找）；缺席退回裸 modelId。 */
  providerName?: (providerId: string) => string | undefined;
}) {
  const { intl, locale } = useZCodeIntl();
  const segments = workflowSettingsChangeSegments(amend, {
    formatMessage: intl.formatMessage.bind(intl),
    ...(providerName === undefined ? {} : { providerName }),
  });
  const time =
    at === undefined
      ? undefined
      : // 时间按界面语言格式化，不跟系统语言
        new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(at);
  const parts = [
    intl.formatMessage({ id: "chat.toolCall.workflow.settingsChange.kind" }),
    ...segments,
    ...(time === undefined ? [] : [time]),
  ];
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-0.5 text-ui-base text-foreground-subtle"
      data-testid="workflow-settings-change-row"
    >
      <SlidersHorizontalIcon aria-hidden className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span aria-hidden className="text-foreground-subtlest">
                ·
              </span>
            ) : null}
            <span
              className={
                index === 0
                  ? "font-medium"
                  : index === parts.length - 1 && time !== undefined
                    ? "text-foreground-subtlest tabular-nums"
                    : undefined
              }
            >
              {part}
            </span>
          </Fragment>
        ))}
      </span>
    </div>
  );
}
