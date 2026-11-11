import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { toast } from "@/components/ui/toast.js";
/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { resolveComposerScope, composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { isComposerEditScopeId } from "@/composer-edit-mode/contract.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

export type ComposerDraftContent = Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;

export interface ComposerSubmissionDraftTransactionResult {
  current: boolean;
  applied: boolean;
}

export interface ComposerSubmissionDraftTransaction {
  claim: () => boolean;
  restore: () => ComposerSubmissionDraftTransactionResult;
  finalize: () => ComposerSubmissionDraftTransactionResult | null;
  release: () => void;
  matchesTarget: (scopeToken: symbol) => boolean;
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  /** 当前 scope incarnation；Root promotion 沿用同一 token，离开再返回会生成新 token。 */
  composerDraftScopeToken: symbol;
  /** 输入热路径只暂存正文，不触发父级 render 或 localStorage。 */
  stageComposerContent: (content: ComposerDraftContent) => void;
  /** 为 effect setup 捕获一次性生命周期收口；切换后仍只写回该 scope incarnation。 */
  captureComposerContentLifecycleCommit: () => (content: ComposerDraftContent) => void;
  /** 发送事务绑定提交时的 scope；失败恢复和成功结算都不能写入后来切换的 scope。 */
  captureComposerSubmissionDraftTransaction: (
    content: ComposerDraftContent,
  ) => ComposerSubmissionDraftTransaction;
  /** 普通保存只落盘已有正文缓冲，不发布整页配置更新。 */
  persistComposerContent: (content: ComposerDraftContent) => void;
  updateComposerContent: (content: ComposerDraftContent) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => boolean;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
  /** composer 编辑提交已结算：退出编辑态回到原草稿时保留编辑态的模型与 mode（Plan 不保留）。 */
  keepEditConfigOnExit: (editScopeId: string) => void;
  /** 预热身份就绪后观察所属草稿的新授权，不改变 Composer 的 root scope。 */
  observeDraftPermissionGrant: (
    sourceSessionId: string,
    config: Partial<SessionConfigState>,
  ) => void;
}

interface ComposerDraftPersistenceTarget {
  scopeKey: string;
  incarnation: symbol;
  contentRevision: { current: number };
  baseDraft: V4ComposerDraft;
  persist: (draft: V4ComposerDraft) => boolean;
}

interface ComposerState {
  scopeKey: string;
  incarnation: symbol;
  workspaceKey: string;
  draft: V4ComposerDraft;
  /** edit = composer 编辑态的 edit scope：内容与配置由进入编辑态时预填，不跟随 Session 快照。 */
  initialization: "new-task" | "session" | "promotion" | "edit";
  observedConfig?: {
    sourceSessionId?: string;
    permissionGrantId?: string;
    planTransitionId?: string;
  };
  promotedSessionId?: string;
}

function hasSameComposerDraftContent(left: V4ComposerDraft, right: V4ComposerDraft): boolean {
  return (
    left.text === right.text &&
    left.editorStateJson === right.editorStateJson &&
    left.mention === right.mention
  );
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
  /** composer 编辑态：草稿切到该 Session 的 edit scope，原草稿留在原 scope 不动。 */
  editScopeId?: string | null;
}): DraftConfigControl {
  const { intl } = useZCodeIntl();
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
    editScopeId = null,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const agentService = useZCodeAgentService(workspacePath, null, workspaceIdentity);
  useEffect(() => {
    const subscription = agentService.onDynamicPluginStartupDegraded({
      workspacePath,
      workspaceIdentity,
    })(() => {
      toast(intl.formatMessage({ id: "plugins.startupTimeout" }), {
        variant: "warning",
        durationMs: 10_000,
        dedupeKey: `plugins-startup:${workspaceKey}`,
      });
    });
    return () => subscription.dispose();
  }, [agentService, intl, workspacePath, workspaceIdentity, workspaceKey]);
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId === null ? V4_DRAFT_SCOPE_ROOT : (editScopeId ?? sessionId);
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const rootScope = useMemo(
    () => resolveComposerScope(draftProjectId, workspaceIdentity, clientNamespace),
    [draftProjectId, workspaceIdentity, clientNamespace],
  );
  const draftFocusVersion = useZCodeSessionStore((state) =>
    sessionId === null ? (state.workspaces[workspaceKey]?.draftFocusVersion ?? 0) : 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    draftFocusVersion,
    sessionId === null ? composerScopeKey(rootScope) : null,
  ]);
  const navigationInitialization = useZCodeSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  const loadedScope = useMemo<ComposerState>(() => {
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
    return {
      scopeKey,
      incarnation: Symbol(scopeKey),
      workspaceKey,
      draft: saved ?? { text: "", updatedAt: 0, ...navigationInitialization?.config },
      initialization: isComposerEditScopeId(scopeId)
        ? "edit"
        : sessionId === null || (!saved && navigationInitialization)
          ? "new-task"
          : "session",
    };
  }, [scopeKey]);
  const [storedState, setStoredState] = useState(loadedScope);
  const stagedContentRef = useRef<
    | (ComposerDraftPersistenceTarget & {
        content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;
      })
    | null
  >(null);
  // 进入 composer 编辑态前的原 scope 状态。
  // Bug 根因：退出编辑态回到原 scope 时按 "session" 重新载入，observedConfig 为空，首帧快照
  // 会用 Session 当前配置覆盖草稿的 mode/Plan（PA158-05 取消编辑后 Plan 从 true 变 false）。
  // 编辑态只是临时借用 composer，原 scope 的观察进度没有中断，因此退出时沿用进入前的状态；
  // 草稿优先取存储（离开 scope 时已落盘最新正文），没有落盘时用进入前的内存草稿。
  // 只在进入编辑态时覆盖，不在 render 中清除：同一次切换可能多次 render，清除会让后续 render
  // 回落到重新初始化。
  const suspendedStateRef = useRef<ComposerState | null>(null);
  const suspended = suspendedStateRef.current;
  // 提交已结算的 edit scope key（docs/ui/composer-edit-mode.md「退出编辑态的工具栏配置」）。
  // Bug 根因：退出编辑态只恢复进入前的草稿，编辑态改的模型在提交后被换回旧模型，下一条消息
  // 悄悄用回旧模型。提交成功时在退出的同一次渲染里换入模型与 mode，不在退出后再改，避免闪回一帧；
  // 取消不标记，全部恢复。每次编辑的 scope 带新 nonce，旧标记不会命中下一次编辑。
  const keptEditScopeKeyRef = useRef<string | null>(null);
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.initialization === "edit" && suspended?.scopeKey === scopeKey
        ? {
            ...suspended,
            draft: withKeptEditConfig(
              loadedScope.draft.updatedAt > 0 ? loadedScope.draft : suspended.draft,
              keptEditScopeKeyRef.current === storedState.scopeKey ? storedState.draft : null,
            ),
          }
        : storedState.workspaceKey === workspaceKey && storedState.promotedSessionId === sessionId
          ? {
              ...storedState,
              scopeKey,
              // Root→session promotion 是同一 pane 的地址迁移；发送事务必须沿用同一 incarnation。
              incarnation: storedState.incarnation,
              initialization: "promotion",
              observedConfig: undefined,
              promotedSessionId: undefined,
            }
          : loadedScope;
  if (
    storedState.scopeKey !== scopeKey &&
    currentState.initialization === "edit" &&
    storedState.initialization !== "edit"
  ) {
    suspendedStateRef.current = storedState;
  }
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  if (currentState.initialization === "new-task" && !draft.mode && modelSelectionView) {
    draft = initializeNewTaskDraft(
      draft,
      workspacePath,
      workspaceIdentity,
      modelSelectionView,
      rootScope,
    );
  }
  // 空配置先初始化了权限，旧逻辑便因已有 mode 永久跳过模型初始化。
  // 仅为无模型原意图的 Root 草稿补齐首次可用选择；不重置正文、权限或 Plan，
  // 也不替换失效的旧选择、已有 Session 或分享导入的配置。
  if (sessionId === null && !draft.modelSelection && modelSelectionView) {
    const selection = resolveDraftInitialModelSelection(modelSelectionView, null).selection;
    if (selection) draft = { ...draft, modelSelection: selection };
  }
  // edit scope 的模式/Plan 是本次编辑的提交配置，不能被 Session 快照的首帧初始化覆盖。
  if (sessionId && sessionConfig && currentState.initialization !== "edit") {
    const previous = currentState.observedConfig;
    const observedConfig = {
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const firstSnapshot = !previous;
    const mode = submissionModeSchema.safeParse(sessionConfig.mode);
    const currentMode = mode.success && mode.data !== "plan" ? mode.data : "build";
    const currentPlan = resolveExecutionState(sessionConfig).planEnabled;
    if (firstSnapshot && currentState.initialization === "session") {
      // 草稿正文存在时曾保留旧模型，导致离开期间已确认的调档在返回发送时被撤销。
      // 普通会话配置以 Session 为准，保留正文；新任务和消息编辑 scope 不走此恢复分支。
      draft = {
        ...draft,
        mode: currentMode,
        planEnabled: currentPlan,
        modelSelection: sessionConfig.modelSelection,
      };
    } else if (previous) {
      // 只处理本次打开后出现的新关联；使用最新快照值，不能从历史事件推导固定 yolo/Plan。
      const permissionChanged =
        observedConfig.permissionGrantId &&
        observedConfig.permissionGrantId !== previous.permissionGrantId;
      const planChanged =
        observedConfig.planTransitionId &&
        observedConfig.planTransitionId !== previous.planTransitionId;
      if (permissionChanged || planChanged)
        draft = {
          ...draft,
          ...(permissionChanged ? { mode: currentMode } : {}),
          ...(planChanged ? { planEnabled: currentPlan } : {}),
        };
    }
    if (
      firstSnapshot ||
      observedConfig.permissionGrantId !== previous.permissionGrantId ||
      observedConfig.planTransitionId !== previous.planTransitionId
    ) {
      currentState = { ...currentState, observedConfig };
    }
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  // 已有会话首份配置未恢复时，null selection 的 View 只是新任务默认值，不能显示到此会话。
  // edit scope 的配置在进入编辑态时已显式预置，不等待 Session 快照（docs/ui/composer-edit-mode.md）。
  const sessionConfigPending =
    sessionId !== null && currentState.initialization !== "edit" && !currentState.observedConfig;
  const effectiveSelection =
    modelSelectionView && !sessionConfigPending
      ? (modelSelectionView.effectiveSelection ?? undefined)
      : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode:
        currentState.initialization === "session" && !currentState.observedConfig
          ? undefined
          : draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [
      draft.mode,
      draft.planEnabled,
      effectiveSelection,
      currentState.initialization,
      currentState.observedConfig,
    ],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const createDraftPersistence = useCallback(
    (targetScopeId = stateRef.current.promotedSessionId ?? scopeId) => {
      const workspace = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return (value: V4ComposerDraft) => {
        const current = useZCodeSessionStore
          .getState()
          .getWorkspaceState(workspacePath, workspaceIdentity);
        // Bug 根因：自动保存不再触发父级 render 后，旧闭包可能把已关闭的分组归属写回来。
        // 同一草稿从唯一 owner 读取最新意图；新草稿/项目已接管时仍冻结原 scope 的归属。
        const placement =
          current.draftFocusVersion === workspace.draftFocusVersion &&
          current.draftProjectId === workspace.draftProjectId
            ? current
            : workspace;
        return persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          targetScopeId,
          scopeId === V4_DRAFT_SCOPE_ROOT
            ? {
                ...value,
                projectId:
                  placement.draftProjectId !== undefined
                    ? placement.draftProjectId
                    : value.projectId,
                // undefined 是显式撤销分组，不能回退到旧正文快照中的 taskGroupId。
                taskGroupId: placement.draftTaskGroupId,
              }
            : value,
          rootScope,
        );
      };
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const draftPersistence = createDraftPersistence();
  const draftPersistenceRef = useRef(draftPersistence);
  draftPersistenceRef.current = draftPersistence;
  const incarnation = currentState.incarnation;
  const scopeContentRevisionRef = useRef(new Map<string, { current: number }>());
  const promotedRevisionSourceKey =
    currentState.initialization === "promotion" && storedState.scopeKey !== scopeKey
      ? storedState.scopeKey
      : scopeKey;
  const scopePersistenceTarget = useMemo<ComposerDraftPersistenceTarget>(() => {
    const contentRevision = scopeContentRevisionRef.current.get(promotedRevisionSourceKey) ?? {
      current: 0,
    };
    scopeContentRevisionRef.current.set(scopeKey, contentRevision);
    return {
      scopeKey,
      incarnation,
      contentRevision,
      baseDraft: stateRef.current.draft,
      persist: createDraftPersistence(),
    };
  }, [createDraftPersistence, incarnation, promotedRevisionSourceKey, scopeKey]);
  const bumpScopeContentRevision = useCallback((target: ComposerDraftPersistenceTarget) => {
    target.contentRevision.current += 1;
  }, []);
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => draftPersistenceRef.current(value),
    [],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useZCodeSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      stateRef.current.incarnation === incarnation &&
      (sessionId !== null ||
        (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, incarnation, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  const mergeStagedContent = useCallback(
    (current: V4ComposerDraft): V4ComposerDraft => {
      const staged = stagedContentRef.current;
      if (!staged || staged.scopeKey !== scopeKey) return current;
      return {
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...staged.content,
      };
    },
    [scopeKey],
  );
  useEffect(() => {
    if (!hasSameComposerDraftContent(scopePersistenceTarget.baseDraft, currentState.draft)) {
      bumpScopeContentRevision(scopePersistenceTarget);
    }
    scopePersistenceTarget.baseDraft = currentState.draft;
    scopePersistenceTarget.persist = draftPersistenceRef.current;
    const pending = stagedContentRef.current;
    if (pending?.scopeKey === scopeKey) {
      pending.baseDraft = currentState.draft;
      pending.persist = draftPersistenceRef.current;
    }
  }, [currentState.draft, scopeKey, scopePersistenceTarget]);
  useEffect(
    () => () => {
      const pending = stagedContentRef.current;
      if (!pending || pending.scopeKey !== scopeKey) return;
      pending.persist({
        ...pending.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...pending.content,
      });
      stagedContentRef.current = null;
    },
    [scopeKey],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      draft.mode &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistDraft(mergeStagedContent(draft));
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft, mergeStagedContent]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      const previous = mergeStagedContent(stateRef.current.draft);
      const next = update(previous);
      if (!hasSameComposerDraftContent(previous, next)) {
        bumpScopeContentRevision(scopePersistenceTarget);
      }
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      scopePersistenceTarget.baseDraft = next;
      scopePersistenceTarget.persist = draftPersistenceRef.current;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, mergeStagedContent, persistDraft, scopePersistenceTarget],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
        ...(current.mode ? {} : { mode: mode.success ? mode.data : "build" }),
      }));
    },
    [updateComposerDraft],
  );
  const observeDraftPermissionGrant = useCallback(
    (sourceSessionId: string, config: Partial<SessionConfigState>) => {
      if (sessionId !== null || !isCurrentScope() || stateRef.current.promotedSessionId) return;
      const previous = stateRef.current.observedConfig;
      const permissionGrantId = config.permissionGrant?.interactionId;
      if (
        previous?.sourceSessionId === sourceSessionId &&
        previous.permissionGrantId === permissionGrantId
      )
        return;
      const next = { ...stateRef.current, observedConfig: { sourceSessionId, permissionGrantId } };
      stateRef.current = next;
      setStoredState(next);
      // 草稿此前未观察授权，首发会携带旧 mode 撤销完全访问；只消费同一来源的新授权。
      if (previous?.sourceSessionId !== sourceSessionId || !permissionGrantId) return;
      const mode = submissionModeSchema.safeParse(config.mode);
      if (!mode.success || mode.data === "plan") return;
      logger.info("[v4-composer] 草稿同步完全访问授权", {
        sourceSessionId,
        permissionGrantId,
        mode: mode.data,
      });
      updateComposerDraft((current) => ({ ...current, mode: mode.data }));
    },
    [sessionId, isCurrentScope, updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const stageComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      // scopeKey 会在 A₁→B→A₂ 后复用；旧输入回调必须同时校验本次挂载身份。
      if (!isCurrentScope()) return;
      stagedContentRef.current = {
        scopeKey,
        incarnation,
        contentRevision: scopePersistenceTarget.contentRevision,
        content,
        baseDraft: stateRef.current.draft,
        persist: draftPersistenceRef.current,
      };
      bumpScopeContentRevision(scopePersistenceTarget);
      if (stateRef.current.promotedSessionId) {
        // 首发接纳到路由切换之间仍是同一 pane；这一窄窗口需同步更新 owner，避免 render 读取 ref。
        const nextDraft = {
          ...stateRef.current.draft,
          editorStateJson: undefined,
          mention: undefined,
          ...content,
        };
        const nextState = { ...stateRef.current, draft: nextDraft };
        stateRef.current = nextState;
        scopePersistenceTarget.baseDraft = nextDraft;
        scopePersistenceTarget.persist = draftPersistenceRef.current;
        setStoredState(nextState);
      }
    },
    [incarnation, isCurrentScope, scopeKey, scopePersistenceTarget],
  );
  const captureComposerContentLifecycleCommit = useCallback(() => {
    const target = scopePersistenceTarget;
    let active = true;
    return (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      if (!active) return;
      active = false;
      const draft = {
        ...target.baseDraft,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      };
      target.baseDraft = draft;
      bumpScopeContentRevision(target);
      target.persist(draft);
      const pending = stagedContentRef.current;
      if (pending?.scopeKey === target.scopeKey) stagedContentRef.current = null;
    };
  }, [bumpScopeContentRevision, scopePersistenceTarget]);
  const captureComposerSubmissionDraftTransaction = useCallback(
    (content: ComposerDraftContent): ComposerSubmissionDraftTransaction => {
      const target = scopePersistenceTarget;
      const submittedContent = {
        text: content.text,
        editorStateJson: content.editorStateJson,
        mention: content.mention,
      };
      const capturedRevision = target.contentRevision.current;
      let state: "captured" | "claimed" | "restored" | "finalized" = "captured";
      let claimedRevision: number | null = null;
      let restoredRevision: number | null = null;
      const isCurrent = () =>
        mountedRef.current &&
        stateRef.current.incarnation === target.incarnation &&
        stateRef.current.draft.text === target.baseDraft.text;
      const clearPending = () => {
        const pending = stagedContentRef.current;
        if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
          stagedContentRef.current = null;
        }
      };
      return {
        matchesTarget: (candidateScopeToken) => candidateScopeToken === target.incarnation,
        claim: () => {
          if (
            state !== "captured" ||
            !isCurrent() ||
            target.contentRevision.current !== capturedRevision
          ) {
            return false;
          }
          const claimedDraft = {
            ...target.baseDraft,
            text: "",
            editorStateJson: undefined,
            mention: undefined,
          };
          target.baseDraft = claimedDraft;
          bumpScopeContentRevision(target);
          claimedRevision = target.contentRevision.current;
          state = "claimed";
          target.persist(claimedDraft);
          const nextState = { ...stateRef.current, draft: claimedDraft };
          stateRef.current = nextState;
          setStoredState(nextState);
          clearPending();
          return true;
        },
        restore: () => {
          if (state !== "claimed" || claimedRevision === null) {
            return { current: isCurrent(), applied: state === "restored" };
          }
          const current = isCurrent();
          const restored = target.contentRevision.current === claimedRevision;
          if (restored) {
            const restoredDraft = {
              ...target.baseDraft,
              ...submittedContent,
            };
            target.baseDraft = restoredDraft;
            bumpScopeContentRevision(target);
            restoredRevision = target.contentRevision.current;
            target.persist(restoredDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: restoredDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
            state = "restored";
          }
          clearPending();
          return { current, applied: restored };
        },
        release: () => {
          state = "finalized";
        },
        finalize: () => {
          // ACK、投影和发送 Promise 可先后到达；事务唯一持有结算状态，副作用只执行一次。
          if (state === "finalized") return null;
          const current = isCurrent();
          const pending = stagedContentRef.current;
          if (pending?.scopeKey === target.scopeKey && pending.incarnation === target.incarnation) {
            target.baseDraft = {
              ...pending.baseDraft,
              editorStateJson: undefined,
              mention: undefined,
              ...pending.content,
            };
            bumpScopeContentRevision(target);
            target.persist(target.baseDraft);
            stagedContentRef.current = null;
            if (current) {
              const nextState = { ...stateRef.current, draft: target.baseDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          const expectedRevision =
            state === "claimed" ? claimedRevision : state === "restored" ? restoredRevision : null;
          const finalized =
            expectedRevision !== null && target.contentRevision.current === expectedRevision;
          if (finalized) {
            const finalizedDraft = {
              ...target.baseDraft,
              text: "",
              editorStateJson: undefined,
              mention: undefined,
            };
            target.baseDraft = finalizedDraft;
            bumpScopeContentRevision(target);
            target.persist(finalizedDraft);
            if (current) {
              const nextState = { ...stateRef.current, draft: finalizedDraft };
              stateRef.current = nextState;
              setStoredState(nextState);
            }
          }
          state = "finalized";
          clearPending();
          return { current, applied: finalized };
        },
      };
    },
    [bumpScopeContentRevision, scopePersistenceTarget],
  );
  const persistComposerContent = useCallback(
    (content: ComposerDraftContent) => {
      if (!isCurrentScope()) return;
      // Bug 根因：350ms 自动保存走配置 setState，导致整页、Logo 和 Timeline 一起刷新。
      // 正文继续由编辑器及既有 staged buffer 持有；配置变更/发送事务仍会合并或结算它。
      stageComposerContent(content);
      persistDraft(mergeStagedContent(stateRef.current.draft));
    },
    [isCurrentScope, stageComposerContent, persistDraft, mergeStagedContent],
  );
  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      updateComposerDraft(() => ({ ...replacement, updatedAt: Date.now() }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return false;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return false;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const draftForPromotion = mergeStagedContent(stateRef.current.draft);
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        draftForPromotion,
      );
      if (!written) return false;
      const staged = stagedContentRef.current;
      if (staged?.scopeKey === scopeKey) stagedContentRef.current = null;
      const next = {
        ...stateRef.current,
        draft: draftForPromotion,
        promotedSessionId: targetSessionId,
      };
      stateRef.current = next;
      const promotedPersistence = createDraftPersistence(targetSessionId);
      scopePersistenceTarget.baseDraft = draftForPromotion;
      scopePersistenceTarget.persist = promotedPersistence;
      draftPersistenceRef.current = promotedPersistence;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
      return true;
    },
    [
      scopeId,
      isCurrentScope,
      mergeStagedContent,
      scopeKey,
      scopePersistenceTarget,
      workspaceIdentity,
      workspacePath,
      rootScope,
    ],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 原因：调档后解析尚未返回时，菜单仍使用同 Host 的保留目录；只读 ready view
      // 会把随后主动选模写成无档位意图，永久显示“—”。目录仅用于选模，不放行提交。
      const catalog =
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
      const modelSelection = reasoningLevel
        ? { ...parsedSelection, options: { reasoningLevel } }
        : catalog
          ? (completeNewModelSelection(catalog, parsedSelection) ?? parsedSelection)
          : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [
      modelSelectionView,
      modelSelectionRead.state,
      updateDraftConfig,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
        }));
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
        }));
    },
    [updateComposerDraft],
  );

  const keepEditConfigOnExit = useCallback(
    (editScopeId: string) => {
      // 只认当前仍在的 edit scope；ACK 迟到时已离开该 scope，不能改写回到的原草稿。
      if (editScopeId === scopeId && isComposerEditScopeId(scopeId))
        keptEditScopeKeyRef.current = scopeKey;
    },
    [scopeId, scopeKey],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    composerDraftScopeToken: incarnation,
    stageComposerContent,
    captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction,
    persistComposerContent,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    keepEditConfigOnExit,
    observeDraftPermissionGrant,
  };
}

/** 原草稿换入编辑态提交的模型与 mode；Plan、正文仍取原草稿。 */
function withKeptEditConfig(draft: V4ComposerDraft, edit: V4ComposerDraft | null): V4ComposerDraft {
  if (!edit) return draft;
  return {
    ...draft,
    ...(edit.modelSelection ? { modelSelection: edit.modelSelection } : {}),
    ...(edit.mode ? { mode: edit.mode } : {}),
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
