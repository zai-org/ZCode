import {
  SettingsScopeDeviceProvider,
  SettingsScopeBlockedNotice,
  resolveSettingsScopeBlock,
  useSettingsScope,
  useSettingsScopeForm,
} from "@/settings-scope/index.js";
/* eslint-disable max-lines -- Hooks 页面聚合 Scope、插件投影、搜索与配置写入流程。 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { getHooksCacheKey, useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 导航意图指定的范围（项目 page scope key）。 */
  initialScopeKey?: string;
  /** 从受管 worktree 任务「去审核」时的会话 cwd；只作用于 initialScopeKey 对应的项目。 */
  reviewWorkspacePath?: string;
}

function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust：运行时 discovery 会下发 editable 标志（工作区 Hook 在
  // runtime 侧不可直接改配置），优先尊重；本地 Settings 发现路径无该标志时回退旧规则。
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust：editable=false 且 source=zcode 的行是「上游/祖先 zcode.json
// 里的只读工作区 Hook」。它们不是外部格式兼容导入源，塞进 Legacy 会让 Import 按钮
// 必然失败（importHook 拒绝 source=zcode），也违反「只读但可逐条 Trust」的约定。
// 这类行应留在 Installed 分组，由信任状态门控 Switch，走行内 Trust 流程。
export function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust：解析「最新 review binding」对应的 scope 切换目标。
 * 纯函数（供 HooksSection 与单测共用）：
 * - 按 request.createdAt 取最新 binding（同一 runtime flow 的 generation 递增也会
 *   刷新 createdAt，语义是「最新出现的审核」）；
 * - identity 优先精确匹配 tab 的 scope key；无 identity 的旧本地 binding 才按
 *   workspacePath 回退（与 matchesWorkspaceBinding 的降级规则一致）；
 * - 找不到对应 tab（workspace 已关闭/未知）返回 null——调用方不得切过去。
 */
export function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // key 规则与 getPluginWorkspaceKey 一致（identity 优先，回退 workspacePath），
  // 这里内联而非复用，避免 helper 依赖 WorkspaceTabState 完整类型、便于单测。
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

/**
 * Hook 读写目标只由选中的 Scope 条目决定。
 * Bug 根因：选中本地项目（无 identity）时曾用 `??` 回退到活动聊天工作区的 identity，
 * 活动工作区是远端时就把本机路径配上远端身份发往 Source Server，远端 `mkdir '/Users'` 报 EACCES。
 * User Scope 使用 Scope 菜单选中设备的「用户」锚点（本机项目 / 设备 home），不再跟随当前 workspace。
 */
export function resolveHookScopeTarget(
  selectedWorkspace: { workspacePath: string; workspaceIdentity?: string } | undefined,
  userTarget: { workspacePath: string } | null | undefined,
): { workspacePath: string | null | undefined; workspaceIdentity: string | undefined } {
  return selectedWorkspace
    ? {
        workspacePath: selectedWorkspace.workspacePath,
        workspaceIdentity: selectedWorkspace.workspaceIdentity,
      }
    : { workspacePath: userTarget?.workspacePath, workspaceIdentity: undefined };
}

export function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // overview 降级时 installedPlugins=[] 表示 scope 未知，不能伪造成 User。
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

export function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // 未知 scope 在两个 Tab 都保留并由列表标记，避免降级时隐藏真实存在的插件 Hook。
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

export function HooksSection({
  workspacePath,
  workspaceIdentity,
  initialScopeKey,
  reviewWorkspacePath,
}: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const [query, setQuery] = useState("");
  // Scope 状态唯一 owner：默认选中当前 workspace 所在设备的「用户」；远端「用户」经 source-settings。
  const scope = useSettingsScope({ workspacePath, workspaceIdentity, initialScopeKey });
  // 表单归属打开它的设备（hook 为 null 表示新建），根因与修法见 useSettingsScopeForm。
  const { form, openForm, closeForm } = useSettingsScopeForm<{ hook: Hook | null }>(scope);
  const editingHook = form?.hook ?? null;
  const selectedScopeKey = scope.selectedScopeKey;
  const setSelectedScopeKey = scope.setSelectedScopeKey;
  // ZP-20261110-06：worktree 任务的 Hook 声明来自会话 cwd，Settings 曾只按项目目录发现，
  // 「去审核」后看到的是源仓库的声明（已信任），worktree 中待审核的那条无法信任。
  // 这里只保存本次导航带来的 cwd；用户手动切换范围即丢弃，回到按项目目录发现。
  const [worktreeReview, setWorktreeReview] = useState(() =>
    initialScopeKey && reviewWorkspacePath
      ? { scopeKey: initialScopeKey, workspacePath: reviewWorkspacePath }
      : null,
  );
  const handleScopeKeyChange = useCallback(
    (scopeKey: string) => {
      setWorktreeReview(null);
      setSelectedScopeKey(scopeKey);
    },
    [setSelectedScopeKey],
  );
  const workspaceTabs = scope.deviceTargets;
  // 审核自动切换可指向任意设备上的在线项目（项目 key 在页面与设备内相同）。
  const allWorkspaceTargets = useMemo(
    () =>
      scope.groups.flatMap((group) =>
        group.options.flatMap((option) => (option.target ? [option.target] : [])),
      ),
    [scope.groups],
  );
  const deferredQuery = useDeferredValue(query);
  const selectedWorkspace =
    scope.resolution.status === "ready" && scope.resolution.kind === "workspace"
      ? scope.resolution.target
      : undefined;
  const userScope = scope.user.status === "ready" ? scope.user : null;
  const scopeBlocked = resolveSettingsScopeBlock(scope, !selectedWorkspace);
  const activeScope: HookScope = selectedWorkspace ? "project" : "user";
  const { workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity } =
    resolveHookScopeTarget(selectedWorkspace, userScope?.target);
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  // 按 worktree 发现时 identity 固定为项目 key：Runtime 的 admission、review request 与 Settings 行
  // 都用项目 key（D23），Trust identity 由服务层按发现路径经 resolver 归一到源仓库。
  const worktreeDiscoveryPath =
    selectedWorkspace && targetWorkspaceKey && worktreeReview?.scopeKey === selectedScopeKey
      ? worktreeReview.workspacePath
      : undefined;
  // CR-01：store 读写共用发现路径，审核模式下的配置写入会落到 worktree 的 config.json。
  // 审核模式只允许信任；改配置须手动切换范围，回到按项目目录读写。
  const reviewOnly = Boolean(worktreeDiscoveryPath);
  const hooksTarget = worktreeDiscoveryPath
    ? { workspacePath: worktreeDiscoveryPath, workspaceIdentity: targetWorkspaceKey ?? undefined }
    : { workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity };
  const cacheAuthorityKey = selectedWorkspace ? undefined : userScope?.cacheAuthorityKey;
  const resolvedTargetServices = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    {
      unscopedServices: selectedWorkspace ? undefined : userScope?.unscopedServices,
      forceUnscoped: !selectedWorkspace,
    },
  );
  // 设备离线或远端 attachment 未就绪时暂停全部 RPC（fail-closed），不借用其他 Host 的服务。
  const targetServiceResolution = scopeBlocked
    ? { ...resolvedTargetServices, rpcReady: false }
    : resolvedTargetServices;
  // Scope 切到另一个远程 workspace 后，路径已切换但 hooks/plugin 服务仍来自
  // 当前激活 workspace。这里让服务 host 与 target 身份同源，等待连接时不发送越界 RPC。
  const { hooksService: targetHooksService, pluginManagementService } =
    targetServiceResolution.services;
  const hooksService = useMemo<IHooksService>(() => {
    if (activeScope !== "user") return targetHooksService;
    // Bug 原因：User scope 需要一个路径作 RPC 锚点（本机项目或设备 home），但该路径不是 project。
    // 强制 user-only 合同，避免把锚点误当 workspace 并覆盖其 .zcode/config.json。
    return {
      loadHooks: (params) => targetHooksService.loadHooks({ ...params, scope: "user" }),
      saveHooks: (params) => targetHooksService.saveHooks({ ...params, scope: "user" }),
      ...(targetHooksService.grantWorkspaceHookTrust
        ? {
            grantWorkspaceHookTrust:
              targetHooksService.grantWorkspaceHookTrust.bind(targetHooksService),
          }
        : {}),
    };
  }, [activeScope, targetHooksService]);
  // workspace-hook-trust：信任操作绑定到当前选中的 workspace（多 workspace scope 场景
  // 下 review binding 可能属于其他 workspace，此时切换 scope 菜单到对应 workspace）。
  // hooksService 必须传 target 解析结果：scope 选中远程 workspace 时 context 服务指向
  // 激活 tab 的 host，越界 RPC 会打到错误 host。
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    authorityKey: cacheAuthorityKey,
    hooksService: targetServiceResolution.rpcReady ? hooksService : undefined,
    rpcReady: targetServiceResolution.rpcReady,
    ...(worktreeDiscoveryPath
      ? {
          hooksTarget: {
            workspacePath: worktreeDiscoveryPath,
            workspaceIdentity: hooksTarget.workspaceIdentity,
          },
        }
      : {}),
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  const editableHooks = useMemo(
    () =>
      hooksState.hooks
        .filter(
          (hook) =>
            (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
            (hook.location?.scope ?? "user") === activeScope,
        )
        .map((hook) => (reviewOnly ? { ...hook, editable: false } : hook)),
    [activeScope, hooksState.hooks, reviewOnly],
  );
  const compatibilityHooks = useMemo(
    () =>
      // 兼容行不参与 Trust 审核，其「导入」也是配置写入，审核模式下不展示。
      reviewOnly
        ? []
        : hooksState.hooks.filter(
            (hook) =>
              isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
          ),
    [activeScope, hooksState.hooks, reviewOnly],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) return;
    void hooksState.initialize(
      hooksTarget.workspacePath ?? undefined,
      hooksTarget.workspaceIdentity,
      hooksService,
      cacheAuthorityKey,
    );
  }, [
    hooksService,
    cacheAuthorityKey,
    hooksState.initialize,
    hooksTarget.workspaceIdentity,
    hooksTarget.workspacePath,
    targetServiceResolution.rpcReady,
  ]);

  useEffect(() => {
    if (!targetWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    cacheAuthorityKey,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!targetServiceResolution.rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        hooksTarget.workspacePath ?? undefined,
        hooksTarget.workspaceIdentity,
        hooksService,
        cacheAuthorityKey,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            authorityKey: cacheAuthorityKey,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    cacheAuthorityKey,
    hooksState.initialize,
    hooksTarget.workspaceIdentity,
    hooksTarget.workspacePath,
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  // workspace-hook-trust（修复）：会话区对 workspace B 发起审核时，把 scope 菜单
  // 自动切到 B 一次。两条硬约束：
  // 1. 只在「新 interaction 出现」时切——B 的 review 仍 pending 期间用户手动切去
  //    A/User 属于主动选择，不得被持续抢回（否则 pending 期间设置页被锁死在 B）。
  // 2. 目标 workspace 必须仍存在于 workspaceTabs——binding 指向已关闭/断连的
  //    workspace 时切过去只会停在 Connecting，还会与上面的「失效 scope 重置 user」
  //    effect 形成乒乓循环。
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, allWorkspaceTargets),
    [reviewBindings, allWorkspaceTargets],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  useEffect(() => {
    // CR-02：设置页按导航重挂载后 ref 归零，其他项目的旧绑定会被当作新审核抢走范围，
    // worktree 审核的 cwd 随之失效。显式 worktree 审核期间不自动切换。
    // 跳过时也要登记 interaction：手动切换会清空 worktreeReview 并重跑本 effect，
    // 未登记的审核会被当作新审核，把用户刚选的范围拉回去（CR 二轮）。
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (worktreeReview) return;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey, worktreeReview]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        closeForm();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [
      closeForm,
      editingHook,
      hooksService,
      hooksState.addHook,
      hooksState.updateHook,
      invalidateDraft,
    ],
  );
  const handleCreateHook = useCallback(() => {
    openForm({ hook: null });
  }, [openForm]);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        closeForm();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [closeForm, confirmDialog, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (form && targetServiceResolution.rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={closeForm}
        />
        <SettingsScopeDeviceProvider
          device={scope.device}
          userAvailable={scope.user.status !== "unavailable"}
        >
          <HookForm
            hook={editingHook ?? undefined}
            workspaceAvailable={Boolean(targetWorkspacePath)}
            defaultStorageLevel={activeScope}
            selectedScopeKey={scope.toLocalScopeKey(selectedScopeKey)}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={(localKey) => handleScopeKeyChange(scope.toPageScopeKey(localKey))}
            onSave={handleSaveHook}
            onDelete={editingHook ? handleDelete : undefined}
            onCancel={closeForm}
            isEditing={Boolean(editingHook)}
          />
        </SettingsScopeDeviceProvider>
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady: targetServiceResolution.rpcReady,
    // 与 hooksStore 同一 key 规则：按 worktree 发现时 key 含发现路径。
    targetWorkspaceKey: hooksTarget.workspacePath
      ? getHooksCacheKey(
          hooksTarget.workspacePath,
          hooksTarget.workspaceIdentity,
          cacheAuthorityKey,
        )
      : null,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            align="start"
            groups={scope.groups}
            selectedScopeKey={selectedScopeKey}
            selectedDevice={scope.device}
            onScopeKeyChange={handleScopeKeyChange}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? (
        <WorkspaceHookTrustNotice
          hooks={editableHooks}
          worktreeSourcePath={
            worktreeDiscoveryPath ? (targetWorkspacePath ?? undefined) : undefined
          }
        />
      ) : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {scopeBlocked ? (
        <SettingsScopeBlockedNotice state={scopeBlocked} device={scope.device} />
      ) : !targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            reviewOnly ? null : (
              <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.hooks.add" })}
              </Button>
            )
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={reviewOnly ? undefined : handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => openForm({ hook: target })}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
