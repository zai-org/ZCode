import { useCallback, useState } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  onSubmit: (answer: { optionId?: string; freeText?: string }) => void;
}

/** v4 userInput 交互最小弹窗（竖切）。 */
export function V4UserInputDialog({ model, onSubmit }: V4UserInputDialogProps) {
  const { intl } = useZCodeIntl();
  const [freeText, setFreeText] = useState("");

  const handleOption = useCallback(
    (optionId: string) => {
      runUserAction({
        input: {
          featureId: "conversation.blocking.user_input",
          action: "select_option",
          trigger: "button",
        },
        operation: () => onSubmit({ optionId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "user_input_submit",
      });
    },
    [onSubmit],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed && model.freeText) return;
    onSubmit(model.freeText ? { freeText: trimmed } : { optionId: model.options[0]?.optionId });
  }, [freeText, model.freeText, model.options, onSubmit]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      data-testid={TID_V4_USER_INPUT_DIALOG}
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg">
        <p className="mb-3 text-ui-base text-[var(--color-foreground)]">{model.prompt}</p>
        {model.options.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            {model.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant="outline"
                data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                onClick={() => handleOption(option.optionId)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
        {model.freeText ? (
          <div className="flex flex-col gap-2">
            <Input
              type={model.sensitive ? "password" : "text"}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              data-testid={TID_V4_USER_INPUT_TEXT}
            />
            <Button type="button" onClick={handleFreeTextSubmit}>
              {/* 提交按钮跟随界面语言，复用 elicitation 的同义文案 */}
              {intl.formatMessage({ id: "chat.elicitation.submit" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
