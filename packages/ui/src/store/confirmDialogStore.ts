import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** 已由调用方脱敏的只读代码，与说明分区展示。 */
  codeBlock?: { code: string; language: string };
  /**
   * 说明可能很长（如停止远端服务前的运行中任务清单）：说明区限高滚动、长路径换行，标题与按钮保持可见。
   * 只对默认确认框生效，未声明的调用方不受影响。
   */
  scrollableDescription?: boolean;
  /** E2E/可访问性使用的稳定业务语义，不依赖本地化标题文本。 */
  intent?: string;
  /** 特定业务弹框的稳定视觉规范；默认确认框不受影响。 */
  presentation?: "automation-confirmation" | "source-server-boundary" | "yolo-confirmation";
  confirmLabel?: string;
  confirmDisabled?: boolean;
  /** 弹窗挂载后开始只读检查；更新仅属于本次请求，关闭即取消。 */
  prepare?: (context: {
    signal: AbortSignal;
    update: (
      patch: Partial<
        Pick<ConfirmDialogRequest, "title" | "description" | "confirmLabel" | "confirmDisabled">
      >,
    ) => void;
  }) => Promise<void>;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  showCloseButton?: boolean;
  /** 需要用户显式确认的告知弹窗：隐藏取消，并忽略遮罩/Escape 关闭。 */
  requiredAcknowledgement?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
}

export type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
  preparation: AbortController;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest, signal?: AbortSignal) => Promise<boolean>;
  requestChoice: (
    payload: ConfirmDialogRequest,
    signal?: AbortSignal,
  ) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
  startPreparation: (identity: PendingConfirmDialogRequest["resolve"]) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload, signal) =>
    (await get().requestChoice(payload, signal)) === "confirm",
  requestChoice: (payload, signal) => {
    if (signal?.aborted) return Promise.resolve("dismiss");
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      const preparation = new AbortController();
      const pendingRequest: PendingConfirmDialogRequest = {
        ...payload,
        confirmDisabled: payload.prepare ? true : payload.confirmDisabled,
        preparation,
        resolve: (choice) => {
          preparation.abort();
          signal?.removeEventListener("abort", abort);
          resolve(choice);
        },
      };
      // 目标失效只能关闭自己的请求，不能结算后来打开的其他确认框。
      const abort = () => {
        if (get().pendingRequest?.resolve === pendingRequest.resolve) get().settleChoice("dismiss");
      };
      signal?.addEventListener("abort", abort, { once: true });
      set({ pendingRequest });
    });
  },
  startPreparation: (identity) => {
    const request = get().pendingRequest;
    if (!request?.prepare || request.resolve !== identity) return;
    // StrictMode 或进度刷新不能启动第二份检查；迟到结果只可更新原请求。
    set({ pendingRequest: { ...request, prepare: undefined } });
    const isCurrent = () =>
      !request.preparation.signal.aborted && get().pendingRequest?.resolve === request.resolve;
    void request
      .prepare({
        signal: request.preparation.signal,
        update: (patch) => {
          if (isCurrent()) set({ pendingRequest: { ...get().pendingRequest!, ...patch } });
        },
      })
      .catch((error) => {
        if (!isCurrent()) return;
        logger.warn("[ConfirmDialogStore] confirmation preparation failed", { error });
        get().settleChoice("dismiss");
      });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest || (choice === "confirm" && pendingRequest.confirmDisabled)) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
