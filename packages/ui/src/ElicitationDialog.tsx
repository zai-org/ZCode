/* eslint-disable max-lines */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ZCodeElicitationQuestion, ZCodeElicitationRequest } from "@zcode/shared";
import type { InteractionAutoResolution } from "@zcode/shared/zcode-protocol-v4";
import { CheckIcon, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";

interface ElicitationDialogProps {
  request: ZCodeElicitationRequest;
  autoResolution?: InteractionAutoResolution;
  onRespond: (
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => void;
  /** 普通 AskUserQuestion 首次暂停来源；失败返回 false 后允许下一次操作重试。 */
  onFirstInteraction?: (
    source: ElicitationAutoResolutionSnoozeSource,
  ) => boolean | void | Promise<boolean | void>;
  initialFormDraft?: ElicitationFormDraft;
  onFormDraftChange?: (requestId: string, draft: ElicitationFormDraft) => void;
}

export type ElicitationAutoResolutionSnoozeSource =
  | "panelHover"
  | "answer"
  | "navigation"
  | "countdown";

const ELICITATION_FINAL_MINUTE_MS = 60_000;
const PLAN_APPROVAL_APPROVE_VALUE = "approve";

export function getElicitationCountdownSeconds(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0 || remainingMs >= ELICITATION_FINAL_MINUTE_MS) return null;
  return Math.max(1, Math.floor(remainingMs / 1_000));
}

function getElicitationCountdownRefreshDelay(
  autoResolution: InteractionAutoResolution | undefined,
  now: number,
): number | null {
  if (!autoResolution || autoResolution.state === "snoozed") return null;
  const remainingMs = autoResolution.deadlineAt - now;
  if (remainingMs <= 0) return null;
  if (remainingMs >= ELICITATION_FINAL_MINUTE_MS) {
    return remainingMs - (ELICITATION_FINAL_MINUTE_MS - 1);
  }
  const seconds = Math.max(1, Math.floor(remainingMs / 1_000));
  if (seconds <= 1) return remainingMs;
  return Math.max(1, remainingMs - (seconds * 1_000 - 1));
}

function useElicitationCountdownSeconds(autoResolution: InteractionAutoResolution | undefined) {
  const [clockNow, setClockNow] = useState(Date.now);

  useEffect(() => {
    if (!autoResolution || autoResolution.state === "snoozed") return;
    let timeoutId: number | undefined;
    const schedule = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      const now = Date.now();
      setClockNow(now);
      if (document.visibilityState === "hidden") return;
      const delay = getElicitationCountdownRefreshDelay(autoResolution, now);
      if (delay !== null) {
        timeoutId = window.setTimeout(schedule, delay);
      }
    };
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [
    autoResolution?.state,
    autoResolution?.startedAt,
    autoResolution?.state === "snoozed" ? autoResolution.snoozedAt : autoResolution?.deadlineAt,
  ]);

  return getElicitationCountdownSeconds(autoResolution, clockNow);
}

export interface NormalizedElicitationQuestion extends ZCodeElicitationQuestion {
  key: string;
}

export interface AnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export type DraftState = Record<string, AnswerDraft>;

export type ElicitationCustomInputKeyAction =
  | "advance"
  | "submit"
  | "previous"
  | "dismiss"
  | "previousOption"
  | "nextOption";

export function resolveElicitationCustomInputKeyAction(event: {
  key: string;
  advanceKind?: "next" | "submit";
  ctrlKey?: boolean;
  metaKey?: boolean;
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  isPlanApproval?: boolean;
  hasPreviousQuestion?: boolean;
}): ElicitationCustomInputKeyAction | null {
  // 自定义回答使用可自动换行的文本框；普通 AskUserQuestion 的 Enter 跟随当前题目的
  // 推进/提交语义，ExitPlanMode 属于计划审批边界，裸 Enter 才能直接提交。
  // 中文输入法用 Enter 确认候选时仍属于 composition，不能误提交给 agent。
  if (isImeComposingKeyEvent(event)) {
    return null;
  }

  // 原因：输入框也是末尾选项；只处理 Enter/Escape 会让上下键进入后无法离开。
  // 导航复用选项焦点索引，并放在 IME 检查后，避免组词选候选时跳走。
  if (event.key === "ArrowUp") return "previousOption";
  if (event.key === "ArrowDown") return "nextOption";

  if (event.key === "Enter") {
    if (event.ctrlKey || event.metaKey || event.isPlanApproval) {
      return "submit";
    }
    return event.advanceKind === "submit" ? "submit" : "advance";
  }

  if (event.key === "Escape") {
    if (!event.isPlanApproval && event.hasPreviousQuestion) {
      return "previous";
    }
    return "dismiss";
  }

  return null;
}

export function normalizeElicitationQuestions(
  request: ZCodeElicitationRequest,
): NormalizedElicitationQuestion[] {
  const sourceQuestions =
    request.questions && request.questions.length > 0
      ? request.questions
      : [
          {
            question: request.message,
            header: request.header ?? request.message,
            options: request.options,
            ...(request.multiSelect ? { multiSelect: true } : {}),
          },
        ];

  return sourceQuestions.map((question, index) => ({
    key: `${index}:${question.question}`,
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label || option.value,
      description: option.description,
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalElicitationRequest(request: ZCodeElicitationRequest): boolean {
  const schema = request.schema;
  return (
    isRecord(schema) && schema.interaction === "plan_approval" && schema.toolName === "ExitPlanMode"
  );
}

export function createInitialElicitationDrafts(
  questions: readonly NormalizedElicitationQuestion[],
  request: ZCodeElicitationRequest,
): DraftState {
  return Object.fromEntries(
    questions.map((question, index) => {
      const draftValues =
        request.answerDrafts?.[`answer_${index}`] ?? request.answerDrafts?.[String(index)] ?? [];
      const optionValues = new Set(question.options.map((option) => option.value));
      const selectedValues = draftValues.filter((value) => optionValues.has(value));
      const customAnswer = draftValues.filter((value) => !optionValues.has(value)).join(", ");
      return [question.key, { selectedValues, customAnswer }];
    }),
  );
}

function normalizeInitialQuestionIndex(
  request: ZCodeElicitationRequest,
  questions: readonly NormalizedElicitationQuestion[],
) {
  if (questions.length === 0) {
    return 0;
  }
  const index = request.currentQuestionIndex;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return 0;
  }
  return Math.max(0, Math.min(index, questions.length - 1));
}

function getQuestionOptionCount(question: NormalizedElicitationQuestion | undefined) {
  if (!question) {
    return 0;
  }
  return question.options.length + 1;
}

function getPreferredActiveOptionIndex(
  question: NormalizedElicitationQuestion | undefined,
  drafts: DraftState,
) {
  if (!question) {
    return 0;
  }
  const draft = drafts[question.key];
  const selectedValue = draft?.selectedValues[0];
  if (selectedValue) {
    const selectedIndex = question.options.findIndex((option) => option.value === selectedValue);
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
  }
  if (draft?.customAnswer.trim()) {
    return question.options.length;
  }
  // 不预选任何选项，避免用户将键盘焦点（bg-hover）误认为"已选中"。
  // 用户必须通过方向键导航或点击才能聚焦选项，聚焦后点继续/提交才会自动补选。
  return -1;
}

function getQuestionAnswers(question: NormalizedElicitationQuestion, drafts: DraftState): string[] {
  const draft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const customAnswer = draft.customAnswer.trim();
  return [...draft.selectedValues, ...(customAnswer ? [customAnswer] : [])];
}

export function buildElicitationResponseContent(
  questions: readonly NormalizedElicitationQuestion[],
  drafts: DraftState,
): Record<string, unknown> {
  // AskUserQuestion 是可选澄清，不是必填表单。只提交用户真实提供的答案，
  // 避免用空字符串伪造偏好；部分或空 answers 由 Agent 使用最佳判断继续。
  const answers = Object.fromEntries(
    questions.flatMap((question) => {
      const questionAnswers = getQuestionAnswers(question, drafts);
      return questionAnswers.length > 0 ? [[question.question, questionAnswers.join(", ")]] : [];
    }),
  );
  const content: Record<string, unknown> = { answers };

  questions.forEach((question, index) => {
    const questionAnswers = getQuestionAnswers(question, drafts);
    if (questionAnswers.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? questionAnswers : questionAnswers[0];
    }
  });

  // 兼容旧版单题 agent 读取 { answer } 的路径。
  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion) {
    const questionAnswers = getQuestionAnswers(onlyQuestion, drafts);
    if (questionAnswers.length > 0) {
      content.answer = onlyQuestion.multiSelect ? questionAnswers : questionAnswers[0];
    }
  }

  return content;
}

export function updateElicitationDraftsForOption(
  drafts: DraftState,
  question: NormalizedElicitationQuestion,
  optionValue: string,
): DraftState {
  const currentDraft = drafts[question.key] ?? {
    selectedValues: [],
    customAnswer: "",
  };
  const nextDraft = question.multiSelect
    ? {
        ...currentDraft,
        selectedValues: currentDraft.selectedValues.includes(optionValue)
          ? currentDraft.selectedValues.filter((value) => value !== optionValue)
          : [...currentDraft.selectedValues, optionValue],
      }
    : { selectedValues: [optionValue], customAnswer: "" };
  return {
    ...drafts,
    [question.key]: nextDraft,
  };
}

export function getElicitationQuestionAdvanceKind(
  questions: readonly NormalizedElicitationQuestion[],
  questionIndex: number,
): "next" | "submit" {
  return questionIndex >= questions.length - 1 ? "submit" : "next";
}

export function ElicitationDialog(props: ElicitationDialogProps) {
  // 普通 AskUserQuestion 首次操作会把 autoResolution 从计时态更新为
  // snoozed，投影因此重建 request 对象，但业务 requestId 没变。若按 request/questions
  // 引用重置，本地 questionIndex 和 drafts 会被误清空并跳回第一题。
  // 用 key 把本地表单实例绑定到协议身份：同一请求保留进度，新请求才完整初始化。
  return <ElicitationDialogContent key={props.request.requestId} {...props} />;
}

function ElicitationDialogContent({
  request,
  autoResolution,
  onRespond,
  onFirstInteraction,
  initialFormDraft,
  onFormDraftChange,
}: ElicitationDialogProps) {
  const { intl } = useZCodeIntl();
  const questions = useMemo(() => normalizeElicitationQuestions(request), [request]);
  const [questionIndex, setQuestionIndex] = useState(
    () => initialFormDraft?.questionIndex ?? normalizeInitialQuestionIndex(request, questions),
  );
  const [activeOptionIndex, setActiveOptionIndex] = useState(() =>
    isPlanApprovalElicitationRequest(request) ? 0 : -1,
  );
  const [drafts, setDrafts] = useState<DraftState>(
    () => initialFormDraft?.drafts ?? createInitialElicitationDrafts(questions, request),
  );
  const [isQuestionExpanded, setIsQuestionExpanded] = useState(false);
  const [isDialogExpanded, setIsDialogExpanded] = useState(true);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const customInputRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const customInputCompositionActiveRef = useRef(false);
  const firstInteractionReportedRef = useRef(false);
  const countdownSeconds = useElicitationCountdownSeconds(autoResolution);

  useEffect(() => {
    onFormDraftChange?.(request.requestId, { questionIndex, drafts });
  }, [drafts, onFormDraftChange, questionIndex, request.requestId]);

  const reportFirstInteraction = useCallback(
    (source: ElicitationAutoResolutionSnoozeSource) => {
      if (firstInteractionReportedRef.current) return;
      firstInteractionReportedRef.current = true;
      let request: boolean | void | Promise<boolean | void>;
      try {
        request = onFirstInteraction?.(source);
      } catch {
        firstInteractionReportedRef.current = false;
        return;
      }
      void Promise.resolve(request)
        .then((accepted) => {
          if (accepted === false) firstInteractionReportedRef.current = false;
        })
        .catch(() => {
          firstInteractionReportedRef.current = false;
        });
    },
    [onFirstInteraction],
  );

  useEffect(() => {
    setIsQuestionExpanded(false);
  }, [questionIndex]);

  const currentQuestion = questions[questionIndex];
  const currentDraft = currentQuestion
    ? (drafts[currentQuestion.key] ?? { selectedValues: [], customAnswer: "" })
    : undefined;
  const isPlanApproval = isPlanApprovalElicitationRequest(request);

  useEffect(() => {
    if (getQuestionOptionCount(currentQuestion) === 0 || activeOptionIndex < 0) {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      if (activeOptionIndex < (currentQuestion?.options.length ?? 0)) {
        optionRefs.current[activeOptionIndex]?.focus();
        return;
      }
      customInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [activeOptionIndex, currentQuestion]);

  // 初始 activeOptionIndex=-1 时无按钮有焦点。卡片容器自动聚焦后
  // 可接收键盘事件，在容器层捕获 Tab/↓/↑/Enter 启动导航或推进。
  useEffect(() => {
    if (activeOptionIndex < 0) {
      const frameId = requestAnimationFrame(() => {
        cardRef.current?.focus();
      });
      return () => cancelAnimationFrame(frameId);
    }
  }, [activeOptionIndex]);

  const updateDraft = useCallback(
    (question: NormalizedElicitationQuestion, updater: (draft: AnswerDraft) => AnswerDraft) => {
      setDrafts((current) => ({
        ...current,
        [question.key]: updater(current[question.key] ?? { selectedValues: [], customAnswer: "" }),
      }));
    },
    [],
  );

  const updateCustomAnswer = useCallback(
    (question: NormalizedElicitationQuestion, value: string) => {
      reportFirstInteraction("answer");
      updateDraft(question, (draft) => ({
        selectedValues: question.multiSelect ? draft.selectedValues : [],
        customAnswer: value,
      }));
    },
    [reportFirstInteraction, updateDraft],
  );

  const submitWithDrafts = useCallback(
    (nextDrafts: DraftState) => {
      const content = buildElicitationResponseContent(questions, nextDrafts);
      onRespond(request.requestId, "accept", content);
    },
    [onRespond, questions, request.requestId],
  );

  const advanceFromQuestion = useCallback(
    (nextDrafts: DraftState) => {
      if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "submit") {
        // 最后一题选完要直接提交；这里用传入的最新草稿，避免 React state
        // 尚未刷新时漏掉最后一次选择。
        submitWithDrafts(nextDrafts);
        return;
      }
      const nextIndex = questionIndex + 1;
      setQuestionIndex(nextIndex);
      const preferred = getPreferredActiveOptionIndex(questions[nextIndex], nextDrafts);
      // Plan mode 切题后默认聚焦第一项，与普通问答的"不预选"策略区分。
      setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
    },
    [questionIndex, questions, submitWithDrafts, isPlanApproval],
  );

  const selectOption = useCallback(
    (question: NormalizedElicitationQuestion, optionValue: string) => {
      reportFirstInteraction("answer");
      const nextDrafts = updateElicitationDraftsForOption(drafts, question, optionValue);
      setDrafts(nextDrafts);
      if (!question.multiSelect) {
        advanceFromQuestion(nextDrafts);
      }
    },
    [advanceFromQuestion, drafts, reportFirstInteraction],
  );

  // 不预选任何选项（activeOptionIndex 初始 -1），消除"焦点即选中"的 UX 混淆。
  // 用户通过方向键/Tab 将焦点移到某选项后点继续/提交，代表意图选择该选项，此时自动补选。
  // 若用户从未按键导航（activeOptionIndex 仍为 -1），提交空答案即为明确的跳过意图。
  const getDraftsWithAutoSelectedOption = useCallback((): DraftState => {
    if (!currentQuestion || currentQuestion.multiSelect) {
      return drafts;
    }
    if (activeOptionIndex < 0) {
      return drafts;
    }
    const draft = drafts[currentQuestion.key];
    const hasAnswer =
      (draft?.selectedValues.length ?? 0) > 0 || (draft?.customAnswer.trim().length ?? 0) > 0;
    if (hasAnswer) {
      return drafts;
    }
    const activeOption = currentQuestion.options[activeOptionIndex];
    if (!activeOption) {
      return drafts;
    }
    return updateElicitationDraftsForOption(drafts, currentQuestion, activeOption.value);
  }, [activeOptionIndex, currentQuestion, drafts]);

  const goBack = useCallback(() => {
    reportFirstInteraction("navigation");
    const nextIndex = Math.max(questionIndex - 1, 0);
    setQuestionIndex(nextIndex);
    const preferred = getPreferredActiveOptionIndex(questions[nextIndex], drafts);
    // Plan mode 返回上一题后默认聚焦第一项。
    setActiveOptionIndex(isPlanApproval && preferred < 0 ? 0 : preferred);
  }, [drafts, questionIndex, questions, reportFirstInteraction, isPlanApproval]);

  const submit = useCallback(() => {
    reportFirstInteraction("answer");
    submitWithDrafts(drafts);
  }, [drafts, reportFirstInteraction, submitWithDrafts]);

  const dismiss = useCallback(() => {
    reportFirstInteraction("answer");
    onRespond(request.requestId, "decline");
  }, [onRespond, reportFirstInteraction, request.requestId]);

  const goPreviousPage = useCallback(() => {
    if (questions.length === 0) {
      return;
    }
    goBack();
  }, [goBack, questions.length]);

  const goNextPage = useCallback(() => {
    if (questions.length === 0 || questionIndex >= questions.length - 1) {
      return;
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    questionIndex,
    questions.length,
    reportFirstInteraction,
  ]);

  const continueOrSubmit = useCallback(() => {
    if (
      isPlanApproval &&
      currentQuestion &&
      getQuestionAnswers(currentQuestion, drafts).length === 0
    ) {
      const approveOption = currentQuestion.options.find(
        (option) => option.value === PLAN_APPROVAL_APPROVE_VALUE,
      );
      if (approveOption) {
        // ExitPlanMode 复用普通问答组件，但空答案在计划审批协议里表示拒绝。
        // 主提交按钮没有反馈时必须显式提交 approve，不能继承 AskUserQuestion 的跳过语义。
        selectOption(currentQuestion, approveOption.value);
        return;
      }
    }
    reportFirstInteraction("navigation");
    const nextDrafts = getDraftsWithAutoSelectedOption();
    if (nextDrafts !== drafts) {
      setDrafts(nextDrafts);
    }
    advanceFromQuestion(nextDrafts);
  }, [
    advanceFromQuestion,
    currentQuestion,
    drafts,
    getDraftsWithAutoSelectedOption,
    isPlanApproval,
    reportFirstInteraction,
    selectOption,
  ]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      const optionCount = getQuestionOptionCount(currentQuestion);
      if (optionCount === 0) {
        return;
      }
      reportFirstInteraction("navigation");
      setActiveOptionIndex((index) => {
        if (index < 0) return direction > 0 ? 0 : optionCount - 1;
        return (index + direction + optionCount) % optionCount;
      });
    },
    [currentQuestion, reportFirstInteraction],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!currentQuestion) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case " ":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Enter":
          event.preventDefault();
          if (activeOptionIndex < 0) return;
          // 多选题 Space 勾选/取消勾选，Enter 确认选择并推进/提交。
          // 单选题 Enter 等同 Space，选中当前选项。
          if (currentQuestion?.multiSelect) {
            continueOrSubmit();
          } else if (activeOptionIndex < currentQuestion.options.length) {
            const option = currentQuestion.options[activeOptionIndex];
            if (option) {
              selectOption(currentQuestion, option.value);
            }
          } else {
            customInputRef.current?.focus();
          }
          return;
        case "Escape":
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
            return;
          }
          dismiss();
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      continueOrSubmit,
      currentQuestion,
      dismiss,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      selectOption,
    ],
  );

  const handleCustomInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      const action = resolveElicitationCustomInputKeyAction({
        key: event.key,
        advanceKind: getElicitationQuestionAdvanceKind(questions, questionIndex),
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        compositionActive: customInputCompositionActiveRef.current,
        nativeEvent: event.nativeEvent,
        isPlanApproval,
        hasPreviousQuestion: questionIndex > 0,
      });
      if (action === "previousOption" || action === "nextOption") {
        event.preventDefault();
        moveSelection(action === "previousOption" ? -1 : 1);
        return;
      }
      if (action) {
        // 原因：空自定义输入框也允许用 Enter / Esc 切题；这仍是明确的题目导航，
        // 不能因为没有触发 onChange 就继续保留自动结束 deadline。
        reportFirstInteraction("navigation");
      }
      if (action === "advance") {
        event.preventDefault();
        if (getElicitationQuestionAdvanceKind(questions, questionIndex) === "next") {
          advanceFromQuestion(drafts);
        }
        return;
      }
      if (action === "submit") {
        event.preventDefault();
        submit();
        return;
      }
      if (action === "previous") {
        event.preventDefault();
        // AskUserQuestion 是多题澄清流；中间题按 Esc 应先返回上一题，
        // 避免用户想改上一题答案时把整个阻塞请求取消掉。
        goBack();
        return;
      }
      if (action === "dismiss") {
        event.preventDefault();
        dismiss();
      }
    },
    [
      advanceFromQuestion,
      dismiss,
      drafts,
      goBack,
      isPlanApproval,
      moveSelection,
      questionIndex,
      questions,
      reportFirstInteraction,
      submit,
    ],
  );

  const renderOption = (
    question: NormalizedElicitationQuestion,
    option: NormalizedElicitationQuestion["options"][number],
    index: number,
  ) => {
    const isSelected = currentDraft?.selectedValues.includes(option.value) === true;
    const isActive = activeOptionIndex >= 0 && activeOptionIndex === index;
    const optionLabel =
      isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
        ? intl.formatMessage({ id: "chat.elicitation.planApproval.approve" })
        : option.label;
    const optionDescription =
      isPlanApproval && option.value === PLAN_APPROVAL_APPROVE_VALUE
        ? intl.formatMessage({
            id: "chat.elicitation.planApproval.approveDescription",
          })
        : option.description;
    return (
      <button
        key={option.value}
        ref={(node) => {
          optionRefs.current[index] = node;
        }}
        type="button"
        role={question.multiSelect ? "checkbox" : "option"}
        aria-selected={question.multiSelect ? undefined : isSelected}
        aria-checked={question.multiSelect ? isSelected : undefined}
        tabIndex={isActive || (activeOptionIndex < 0 && index === 0) ? 0 : -1}
        onClick={() => selectOption(question, option.value)}
        onFocus={() => setActiveOptionIndex(index)}
        onKeyDown={handleOptionKeyDown}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-hover",
          isSelected ? "bg-selected" : isActive ? "bg-hover" : "hover:bg-hover",
        )}
      >
        {question.multiSelect ? (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm border",
              isSelected
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border text-transparent",
            )}
          >
            <CheckIcon className="size-3" />
          </span>
        ) : (
          <span
            className={cn(
              "w-5 shrink-0 self-center text-ui-base font-medium",
              isSelected ? "text-foreground" : "text-foreground-subtlest",
            )}
          >
            {index + 1}.
          </span>
        )}
        {/* 修复原因：界面字号可动态增大，固定 20px 行高会让大字号文字贴边或裁切。 */}
        <span className="min-w-0 flex-1 text-ui-base leading-normal">
          <span className="text-ui-base font-medium leading-normal text-foreground">
            {optionLabel}
          </span>
          {optionDescription ? (
            <span className="ml-2 text-ui-base leading-normal text-foreground-subtle">
              {optionDescription}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  const renderCustomInput = (question: NormalizedElicitationQuestion, index: number) => {
    const isSelected = (currentDraft?.customAnswer.trim().length ?? 0) > 0;
    const isActive = activeOptionIndex >= 0 && activeOptionIndex === index;
    // 原因：计划审批曾隐藏输入序号；所有单选输入行都接续选项编号。
    return (
      <div
        key="custom-input"
        role={question.multiSelect ? "checkbox" : undefined}
        aria-checked={question.multiSelect ? isSelected : undefined}
        onClick={(event) => {
          if (event.target !== customInputRef.current) {
            customInputRef.current?.focus();
          }
        }}
        className={cn(
          "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
          isSelected ? "bg-selected" : isActive ? "bg-hover" : "hover:bg-hover",
        )}
      >
        {question.multiSelect ? (
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-sm border",
              isSelected
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border text-transparent",
            )}
          >
            <CheckIcon className="size-3" />
          </span>
        ) : (
          <span
            className={cn(
              // 与 textarea 首行使用相同行高并让出 1px 边框，避免顶部或整体居中造成错位。
              "mt-px w-5 shrink-0 self-start text-ui-base font-medium leading-normal md:leading-relaxed",
              isSelected ? "text-foreground" : "text-foreground-subtlest",
            )}
          >
            {index + 1}.
          </span>
        )}
        {/* 原因：按内容增高的输入框没有上限会撑满问答卡片；与权限反馈一致，五行后内部滚动。 */}
        <Textarea
          ref={customInputRef}
          rows={1}
          wrap="soft"
          value={currentDraft?.customAnswer ?? ""}
          placeholder={intl.formatMessage({
            id: "chat.elicitation.customAnswer.placeholder",
          })}
          onFocus={() => setActiveOptionIndex(index)}
          onChange={(event) => updateCustomAnswer(question, event.target.value)}
          onCompositionStart={() => {
            customInputCompositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            customInputCompositionActiveRef.current = false;
          }}
          onKeyDown={handleCustomInputKeyDown}
          className="h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 text-ui-base font-medium leading-normal shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0"
        />
      </div>
    );
  };

  const canGoPreviousPage = questions.length > 0 && questionIndex > 0;
  const canGoNextPage = questions.length > 0 && questionIndex < questions.length - 1;

  // activeOptionIndex=-1 时卡片有焦点，键盘事件到达卡片 onKeyDown。
  // Tab/↓/↑ 聚焦选项，Enter 直接推进到下一题（或提交）。
  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (activeOptionIndex >= 0) return; // 按钮已有焦点，由按钮 onKeyDown 处理
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          continueOrSubmit();
          return;
        case "Escape":
          // 初始 activeOptionIndex=-1 时卡片接收焦点，Escape 必须
          // 由卡片层处理，与按钮 onKeyDown 保持一致：非 plan mode 有上题则返回，
          // 否则 dismiss。
          event.preventDefault();
          if (!isPlanApproval && questionIndex > 0) {
            goBack();
          } else {
            dismiss();
          }
          return;
        default:
          return;
      }
    },
    [
      activeOptionIndex,
      moveSelection,
      continueOrSubmit,
      isPlanApproval,
      questionIndex,
      goBack,
      dismiss,
    ],
  );

  const primaryActionMessageId =
    questions.length === 0 || questionIndex >= questions.length - 1
      ? "chat.elicitation.submit"
      : "chat.elicitation.continue";
  const titleHeader = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.title" })
    : currentQuestion?.header;
  const titleQuestion = isPlanApproval
    ? intl.formatMessage({ id: "chat.permission.switchMode.placeholder" })
    : (currentQuestion?.question ?? intl.formatMessage({ id: "chat.elicitation.title" }));
  const shouldOfferQuestionCollapse = titleQuestion.length > 80 || titleQuestion.includes("\n");
  const questionCollapseLabel = intl.formatMessage({
    id: isQuestionExpanded
      ? "chat.elicitation.collapseQuestion"
      : "chat.elicitation.expandQuestion",
  });
  const dialogCollapseLabel = intl.formatMessage({
    id: isDialogExpanded ? "chat.elicitation.collapseDialog" : "chat.elicitation.expandDialog",
  });
  const stopCountdownLabel = intl.formatMessage({ id: "taskList.stopCountdown" });
  const countdownButton =
    countdownSeconds !== null ? (
      <Button
        type="button"
        size="xs"
        variant="secondary"
        data-elicitation-countdown-seconds={countdownSeconds}
        aria-label={stopCountdownLabel}
        title={stopCountdownLabel}
        onClick={() => reportFirstInteraction("countdown")}
        className="min-w-10 px-1.5 tabular-nums text-foreground-subtle"
      >
        {intl.formatMessage(
          { id: "chat.elicitation.countdownSeconds" },
          { seconds: String(countdownSeconds) },
        )}
      </Button>
    ) : null;

  return (
    <div className="w-full shrink-0">
      {/* Bugfix: 手机远控视口较短，长问题和多选项会把按钮顶出弹窗；卡片限高后让内容区内部滚动。 */}
      <div
        ref={cardRef}
        tabIndex={activeOptionIndex < 0 ? 0 : -1}
        data-elicitation-dialog-card="true"
        className="relative z-1 flex w-full max-h-[min(72dvh,42rem)] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-xs outline-none"
        onMouseEnter={() => reportFirstInteraction("panelHover")}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div
            data-elicitation-dialog-body="true"
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1",
              !isDialogExpanded ? "max-md:hidden" : undefined,
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 text-ui-base font-medium leading-5">
                {titleHeader ? (
                  <Badge
                    variant="outline"
                    className="mr-2 max-w-40 align-baseline text-ui-base truncate"
                  >
                    {titleHeader}
                  </Badge>
                ) : null}
                {/* Bugfix: 问题不能只放在会截断的标题行；移动端没有 hover，必须在 tag 后直接完整可读。 */}
                <span
                  title={titleQuestion}
                  className={cn(
                    "whitespace-pre-wrap break-words leading-6 text-foreground",
                    shouldOfferQuestionCollapse && !isQuestionExpanded
                      ? "max-md:line-clamp-4"
                      : undefined,
                  )}
                >
                  {titleQuestion}
                </span>
                <InteractionRequestOriginBadge origin={request.origin} className="mt-2" />
                {shouldOfferQuestionCollapse ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-expanded={isQuestionExpanded}
                    aria-label={questionCollapseLabel}
                    title={questionCollapseLabel}
                    onClick={() => setIsQuestionExpanded((expanded) => !expanded)}
                    className="mt-2 hidden max-md:inline-flex"
                  >
                    {isQuestionExpanded ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                    <span>{questionCollapseLabel}</span>
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-1 text-ui-base font-medium leading-tight text-foreground-subtlest">
                {countdownButton}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-expanded={isDialogExpanded}
                  aria-label={dialogCollapseLabel}
                  title={dialogCollapseLabel}
                  onClick={() => setIsDialogExpanded((expanded) => !expanded)}
                  className="hidden max-md:inline-flex"
                >
                  {isDialogExpanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronUp className="size-3" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canGoPreviousPage}
                  title={intl.formatMessage({
                    id: "chat.elicitation.previousQuestion",
                  })}
                  aria-label={intl.formatMessage({
                    id: "chat.elicitation.previousQuestion",
                  })}
                  onClick={goPreviousPage}
                >
                  <ChevronLeft className="size-3" />
                </Button>
                <span className="min-w-10 text-center">
                  {`${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canGoNextPage}
                  title={intl.formatMessage({
                    id: "chat.elicitation.nextQuestion",
                  })}
                  aria-label={intl.formatMessage({
                    id: "chat.elicitation.nextQuestion",
                  })}
                  onClick={goNextPage}
                >
                  <ChevronRight className="size-3" />
                </Button>
              </div>
            </div>

            {currentQuestion ? (
              <div className="space-y-3">
                <div
                  role={currentQuestion.multiSelect ? "group" : "listbox"}
                  aria-label={titleQuestion}
                  className="space-y-1"
                >
                  {currentQuestion.options.map((option, index) =>
                    renderOption(currentQuestion, option, index),
                  )}
                  {renderCustomInput(currentQuestion, currentQuestion.options.length)}
                </div>
              </div>
            ) : (
              <p className="px-1 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.elicitation.noQuestions" })}
              </p>
            )}
          </div>

          {!isDialogExpanded ? (
            <div className="hidden min-w-0 items-center justify-between gap-2 max-md:flex">
              <button
                type="button"
                onClick={() => setIsDialogExpanded(true)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left text-ui-base font-medium text-foreground hover:bg-hover"
              >
                {titleHeader ? (
                  <Badge
                    variant="outline"
                    className="max-w-32 shrink-0 align-baseline text-ui-base truncate"
                  >
                    {titleHeader}
                  </Badge>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{titleQuestion}</span>
              </button>
              {countdownButton}
              <span className="shrink-0 text-ui-base font-medium text-foreground-subtlest">
                {`${Math.min(questionIndex + 1, Math.max(questions.length, 1))} / ${Math.max(questions.length, 1)}`}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-expanded={isDialogExpanded}
                aria-label={dialogCollapseLabel}
                title={dialogCollapseLabel}
                onClick={() => setIsDialogExpanded(true)}
              >
                <ChevronUp className="size-3" />
              </Button>
            </div>
          ) : null}

          <div
            data-elicitation-dialog-footer="true"
            className={cn(
              "flex shrink-0 items-center justify-between gap-2 px-1 max-sm:flex-wrap",
              !isDialogExpanded ? "max-md:hidden" : undefined,
            )}
          >
            <p className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground-subtle max-sm:basis-full">
              <Info className="size-4 shrink-0 text-foreground" />
              <span className="min-w-0">
                {intl.formatMessage({ id: "chat.elicitation.keyboardHint" })}
              </span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="lg" variant="outline" onClick={dismiss}>
                {intl.formatMessage({ id: "chat.elicitation.dismiss" })}
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={questions.length === 0 ? submit : continueOrSubmit}
                className="bg-brand text-foreground-inverse hover:bg-brand/80"
              >
                {intl.formatMessage({ id: primaryActionMessageId })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
