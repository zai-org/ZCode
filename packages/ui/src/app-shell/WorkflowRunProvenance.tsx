// ============================================================
// 详情页的来龙去脉块
// ============================================================
// 从 WorkflowRunSidePaneSections.tsx 拆出（max-lines 门）。两种 run 有这一块：中枢直接启动的
// 与「配置」修订出来的。
// 工具路径发起的 run 没有——它的来历是转写里那一行 CreateWorkflow。只读，无动作。

import { Fragment, memo } from "react";
import type { WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";
import { workflowSettingsProvenanceRows } from "@/components/workflow-timeline/workflowSettingsChange.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 实参值：字符串原样，其余 `JSON.stringify`（与实参窗 / 通知同一条归一化）。 */
function formatArgValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * 中枢启动：「由你从工作流中枢启动 · 时刻」与作用域徽标，其下是说明与实参键值表。
 * 「配置」修订：「由你调整设置 · 时刻」，没有作用域徽标，其下每项改动一行「{from} → {to}」。
 */
export const WorkflowRunProvenance = memo(function WorkflowRunProvenance({
  meta,
  providerName,
  startedAt,
}: {
  meta: WorkflowLaunchMeta;
  /** providerId → provider 名（与摘要行的模型段同一个查找）；缺席退回裸 modelId。 */
  providerName?: (providerId: string) => string | undefined;
  /** 启动轮 / 设置轮的 startedAt；缺席即不写时刻。 */
  startedAt?: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const amend = meta.amend;
  const caption = intl.formatMessage({
    id:
      amend === undefined
        ? "chat.workflowLaunch.startedByYou"
        : "chat.workflowLaunch.settingsChangedByYou",
  });
  const time =
    startedAt === undefined
      ? undefined
      : // 时间按界面语言格式化，不跟系统语言
        new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(startedAt);
  const rows =
    amend === undefined
      ? Object.entries(meta.args ?? {}).map(([key, value]) => ({
          key,
          label: key,
          value: formatArgValue(value),
        }))
      : workflowSettingsProvenanceRows(amend, {
          formatMessage: intl.formatMessage.bind(intl),
          ...(providerName === undefined ? {} : { providerName }),
        });

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="workflow-run-provenance"
      data-workflow-launch-kind={amend === undefined ? "launch" : "settings"}
      {...(meta.scope === undefined ? {} : { "data-workflow-launch-scope": meta.scope })}
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
        <span className="min-w-0 truncate">
          {time === undefined ? caption : `${caption} · ${time}`}
        </span>
        {/* 作用域徽标：复用中枢的小徽标类（rounded-sm border 小字）。设置轮没有保存文件，也就没有作用域。 */}
        {amend !== undefined || meta.scope === undefined ? null : (
          <span
            className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 leading-none text-foreground-subtlest"
            data-testid="workflow-run-provenance-scope"
          >
            {intl.formatMessage({ id: `chat.workflowLaunch.scope.${meta.scope}` })}
          </span>
        )}
      </div>
      {amend === undefined && meta.description ? (
        <p className="mt-1 min-w-0 text-ui-sm leading-5 text-foreground-subtle">
          {meta.description}
        </p>
      ) : null}
      {/* 键值表：实参是键 mono、值 mono 单行截断（title 兜全文）；设置改动是人话标签、值照样单行。
          侧板有的是纵向空间，不折叠。 */}
      {rows.length > 0 ? (
        <dl
          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
          data-testid={
            amend === undefined
              ? "workflow-run-provenance-args"
              : "workflow-run-provenance-settings"
          }
        >
          {rows.map((row) => (
            <Fragment key={row.key}>
              <dt
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground-subtle"
                    : "truncate text-ui-xs text-foreground-subtle"
                }
              >
                {row.label}
              </dt>
              <dd
                className={
                  amend === undefined
                    ? "truncate font-mono text-ui-xs text-foreground"
                    : "truncate text-ui-xs text-foreground tabular-nums"
                }
                title={row.value}
              >
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
});
