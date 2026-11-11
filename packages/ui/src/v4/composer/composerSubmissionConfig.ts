import { resolveExecutionState, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

export interface ComposerSubmissionConfig {
  modelSelection: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
}

/** 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。 */
export function createComposerSubmissionConfig(
  composer:
    | { mode?: string; planEnabled?: boolean; modelSelection?: ModelSelection }
    | null
    | undefined,
  view: ModelSelectionView | null,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const selection = composer.modelSelection;
  const mode = submissionModeSchema.safeParse(composer.mode);
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!mode.success || !selection || !model || !validateModelSelectionOptions(model, selection).ok)
    return null;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: mode.data === "plan" ? "build" : mode.data,
    planEnabled: resolveExecutionState(composer).planEnabled,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel: selection.options!.reasoningLevel! }),
    }),
  });
}

/** 与 CLI 旧协议拒绝、restoreWarning 共用的稳定 code；ChatErrorBanner 按它本地化。 */
export const SESSION_MODEL_UNAVAILABLE_ERROR_CODE = "ZCODE_RUNTIME_MODEL_UNAVAILABLE";

/** 会话原选择在当前 Registry 视图里解析不出可执行模型的三种原因；档位问题不属于「模型不可用」。 */
const SESSION_MODEL_UNAVAILABLE_ISSUES = new Set<ModelSelectionView["selectionIssue"]>([
  "provider-not-found",
  "model-not-found",
  "account-connection-unavailable",
]);

export interface SessionModelUnavailable {
  /**
   * 关闭指纹 = 失效原因 + 会话原选择身份。用户关闭横幅后，同一选择、同一原因不再重复弹出
   * （目录 revision 等无关变化不影响）；换了选择或原因变化后重新评估。
   * Bug 根因：指纹曾只含原因，关掉模型 A 的横幅后改选 B、B 再因同一原因失效时横幅被旧记录吞掉，
   * 发送再次被禁用却没有解释，重现了本来要解决的静默阻塞。
   */
  key: string;
  error: ZCodeUiError;
}

/**
 * 会话常驻模型是否已不在当前 Registry 视图。
 *
 * Bug 根因：体验套餐到期、活动结束或切换账号后，账号 Provider 从 Registry 下架，会话仍绑定旧选择。
 * Model Selection View 对会话原选择只解析出 `selectionIssue`、`effectiveSelection` 为 null，于是
 * Composer 的 draftConfig 没有模型、提交门禁静默返回 null：发送按钮和回车失效，工具栏退回
 * 「选择模型」占位，却没有任何解释，用户以为「卡住」或「发不出去」。
 * 这里直接复用 View 已经算好的 selectionIssue（唯一来源，与 draftConfig 的清空同源），不再
 * 另做一次目录比对，也不新增协议状态。只有已存在的会话才判定：草稿的空选择由
 * useDraftModelReadinessGate 负责；视图未就绪时不能把「还没加载」误报成「已失效」。
 */
export function resolveSessionModelUnavailable(params: {
  sessionId: string | null;
  /** 会话原选择（View 的解析输入）；effectiveSelection 失效时为 null 的是解析结果，不是它。 */
  modelSelection: ModelSelection | undefined;
  modelSelectionState: ModelSelectionState;
}): SessionModelUnavailable | null {
  const { sessionId, modelSelection, modelSelectionState } = params;
  if (!sessionId || !modelSelection || modelSelectionState.status !== "ready") return null;
  const issue = modelSelectionState.view.selectionIssue;
  if (!issue || !SESSION_MODEL_UNAVAILABLE_ISSUES.has(issue)) return null;
  return {
    key: `${issue}:${modelSelection.providerId}/${modelSelection.modelId}`,
    error: {
      code: SESSION_MODEL_UNAVAILABLE_ERROR_CODE,
      message: `The session model selection is unavailable in the current model registry (${issue}).`,
    },
  };
}
