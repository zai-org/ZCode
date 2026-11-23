import { TID_FEEDBACK_LOGS_OPT_IN } from "@zcode/shared/test-ids";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { SubmitProgressView } from "@/feedback/FeedbackSubmitProgressView.js";
import { RequiredMarker } from "@/feedback/feedbackBadges.js";
import { rememberFeedbackContactInput } from "@/feedback/feedbackContactPreference.js";
import type { FeedbackSubmissionProgressState } from "@/feedback/feedbackSubmissionJob.js";
import { InboxIcon } from "lucide-react";

export function DescriptionSection({
  value,
  max,
  onChange,
  formatMessage,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <Section
      title={
        <>
          <RequiredMarker />
          {formatMessage("feedback.submit.simple.descriptionTitle")}
        </>
      }
      right={<Counter value={value.length} max={max} />}
    >
      <Field>
        <Textarea
          autoFocus
          required
          aria-required="true"
          aria-label={formatMessage("feedback.submit.simple.descriptionTitle")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={5}
          maxLength={max}
          placeholder={formatMessage("feedback.submit.simple.descriptionPlaceholder")}
          // Textarea 默认的 field-sizing-content 会让无换行长文本撑大输入框宽度。
          // 反馈弹窗宽度固定，这里切到固定尺寸并允许长词换行，避免整窗横向溢出。
          className="field-sizing-fixed h-[136px] max-h-[136px] min-w-0 max-w-full resize-none overflow-y-auto rounded-xl border-input-border bg-input text-ui-base leading-6 whitespace-pre-wrap break-words text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        />
      </Field>
    </Section>
  );
}

export function ContactSection({
  value,
  max,
  onChange,
  formatMessage,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <Section title={formatMessage("feedback.submit.simple.contactTitle")}>
      <Field>
        <Input
          type="text"
          inputMode="email"
          autoComplete="email"
          value={value}
          onChange={(event) => {
            // 联系方式是可选项，但用户一旦填过就希望下次自动带出。
            // 这里随输入实时持久化，不再依赖提交成功，避免网络失败或用户关闭弹窗导致记忆丢失。
            onChange(rememberFeedbackContactInput(event.target.value));
          }}
          maxLength={max}
          placeholder={formatMessage("feedback.submit.contact.placeholder")}
          className="h-10 rounded-xl border-input-border bg-input px-3 text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused"
        />
      </Field>
    </Section>
  );
}

export function LogUploadToggle({
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-ui-base font-medium text-foreground">{label}</span>
        <Switch
          data-testid={TID_FEEDBACK_LOGS_OPT_IN}
          aria-label={label}
          size="sm"
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="shrink-0"
        />
      </div>
      <span className="block text-ui-sm leading-5 text-foreground-subtle">{hint}</span>
    </div>
  );
}

export function SubmitFooter({
  submitting,
  submitProgress,
  submitDisabled,
  onCancel,
  onViewTickets,
  onSubmit,
  formatMessage,
}: {
  submitting: boolean;
  submitProgress: FeedbackSubmissionProgressState | null;
  submitDisabled: boolean;
  onCancel: () => void;
  onViewTickets: () => void;
  onSubmit: () => void;
  formatMessage: (id: string) => string;
}) {
  return (
    <div className="shrink-0 px-6 pb-6 pt-2">
      {submitting && submitProgress ? (
        <SubmitProgressView
          progress={submitProgress}
          processingLabel={formatMessage("feedback.submit.processing")}
        />
      ) : null}
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          submitting && submitProgress ? "mt-2.5" : "",
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onViewTickets}
          disabled={submitting}
          // Bugfix: Button 基础样式自带 shrink-0，只写 min-w-0 时这个按钮并不会收缩。日文等长文案下
          // 三个按钮的最小宽度（501px）超过 480px 窗口里的弹窗宽度（446px），整行溢出，提交按钮被裁，
          // 聚焦后弹窗被横向滚动导致左侧被截。这里显式允许这个次要入口收缩并截断文字，
          // 用 title 保留完整文案；右侧主操作保持不收缩。见 docs/ui/feedback-dialog-narrow-window-layout.md。
          title={formatMessage("feedback.center.ticketsTitle")}
          className="min-w-0 shrink justify-start rounded-lg text-foreground-subtle hover:text-foreground"
        >
          <InboxIcon className="size-4 shrink-0" />
          <span className="truncate">{formatMessage("feedback.center.ticketsTitle")}</span>
        </Button>
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {formatMessage("common.cancel")}
          </Button>
          <Button
            size="lg"
            onClick={() => void onSubmit()}
            disabled={submitDisabled}
            className="rounded-lg"
          >
            {submitting ? (
              <>
                <span className="size-3.5 animate-spin rounded-full border border-current border-t-transparent" />
                {formatMessage("feedback.submit.submitting")}
              </>
            ) : (
              formatMessage("feedback.submit.submit")
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Section({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-semibold text-foreground">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({ right, children }: { right?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {right ? <div className="flex items-center justify-end gap-2">{right}</div> : null}
      {children}
    </div>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      className={cn(
        "text-ui-xs tabular-nums",
        value > max ? "text-destructive" : "text-foreground-subtle",
      )}
    >
      {value}/{max}
    </span>
  );
}
