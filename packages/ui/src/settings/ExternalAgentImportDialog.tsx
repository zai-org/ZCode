/* eslint-disable max-lines -- 外部 Agent 导入弹窗复用 skills/commands 的交互状态机，业务扫描与导入在服务层按类别分开 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  MinusIcon,
  RefreshCw,
  XIcon,
} from "lucide-react";
import type {
  SettingsSyncAgentSummary,
  SettingsSyncCategory,
  SettingsSyncCommandImportResult,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
  SettingsSyncImportMode,
  SettingsSyncMcpServerImportResult,
  SettingsSyncSourceMcpServerSummary,
  SettingsSyncPluginImportResult,
  SettingsSyncSkillImportResult,
  SettingsSyncSourceCommandSummary,
  SettingsSyncSourcePluginSummary,
  SettingsSyncSourceSkillSummary,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Progress } from "@/components/ui/progress.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { ISettingsSyncService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type ImportStep = "selection" | "importing" | "complete";
export type ImportResourceCategory = Extract<
  SettingsSyncCategory,
  "skills" | "commands" | "plugins" | "mcpServers"
>;
type ImportItemSummary =
  | SettingsSyncSourceSkillSummary
  | SettingsSyncSourceCommandSummary
  | SettingsSyncSourcePluginSummary
  | SettingsSyncSourceMcpServerSummary;
type ImportItemResult =
  | SettingsSyncSkillImportResult
  | SettingsSyncCommandImportResult
  | SettingsSyncPluginImportResult
  | SettingsSyncMcpServerImportResult;

interface ExternalAgentImportDialogProps {
  open: boolean;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
  // detect/importSelected 携带调用方传入的 target 路径，但 service 曾取自
  // useServices()（当前激活 workspace）。跨 host 时会在 A 的主机上按 B 的路径解析并做
  // symlink/copy 落盘。改为必传，由调用方按 Scope target 解析后注入。
  settingsSyncService: ISettingsSyncService;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void> | void;
}

interface CategorizedExternalAgentImportDialogProps extends ExternalAgentImportDialogProps {
  category: ImportResourceCategory;
}

interface ResourceSelectionKeyPayload {
  agent: string;
  category: ImportResourceCategory;
  sourceScope?: SettingsSyncSourceScope;
  resourcePath: string;
}

function getSourceSelectionKey(
  agent: string,
  category: string,
  sourceScope?: SettingsSyncSourceScope,
): string {
  return sourceScope ? `${agent}:${category}:${sourceScope}` : `${agent}:${category}`;
}

function getResourceSelectionKey(payload: ResourceSelectionKeyPayload): string {
  return JSON.stringify(payload);
}

function readResourceSelectionKey(key: string): ResourceSelectionKeyPayload | null {
  try {
    const payload = JSON.parse(key) as Partial<ResourceSelectionKeyPayload>;
    if (
      typeof payload.agent !== "string" ||
      typeof payload.category !== "string" ||
      typeof payload.resourcePath !== "string"
    ) {
      return null;
    }
    return {
      agent: payload.agent,
      category: payload.category as ImportResourceCategory,
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      resourcePath: payload.resourcePath,
    };
  } catch {
    return null;
  }
}

export function buildExternalAgentImportSelections(
  selectedKeys: string[],
  targetScope: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode,
): SettingsSyncSelection[] {
  const grouped = new Map<string, SettingsSyncSelection>();
  for (const key of selectedKeys) {
    const payload = readResourceSelectionKey(key);
    if (!payload) {
      continue;
    }
    const groupKey = JSON.stringify([payload.agent, payload.category, payload.sourceScope ?? null]);
    const selection = grouped.get(groupKey) ?? {
      agent: payload.agent as SettingsSyncSelection["agent"],
      category: payload.category as SettingsSyncSelection["category"],
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      targetScope,
      importMode,
      ...(payload.category === "skills"
        ? { skillPaths: [] }
        : payload.category === "commands"
          ? { commandPaths: [] }
          : payload.category === "plugins"
            ? { pluginPaths: [] }
            : { mcpServerPaths: [] }),
    };
    if (payload.category === "skills") {
      selection.skillPaths = [...(selection.skillPaths ?? []), payload.resourcePath];
    } else if (payload.category === "commands") {
      selection.commandPaths = [...(selection.commandPaths ?? []), payload.resourcePath];
    } else if (payload.category === "plugins") {
      selection.pluginPaths = [...(selection.pluginPaths ?? []), payload.resourcePath];
    } else {
      selection.mcpServerPaths = [...(selection.mcpServerPaths ?? []), payload.resourcePath];
    }
    grouped.set(groupKey, selection);
  }
  return [...grouped.values()];
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getImportResults(
  result: SettingsSyncImportResult | null,
  category: ImportResourceCategory,
): ImportItemResult[] {
  return (
    result?.taskResults.flatMap((taskResult) =>
      category === "skills"
        ? (taskResult.skillResults ?? [])
        : category === "commands"
          ? (taskResult.commandResults ?? [])
          : category === "plugins"
            ? (taskResult.pluginResults ?? [])
            : (taskResult.mcpServerResults ?? []),
    ) ?? []
  );
}

function formatAgentName(agent: string, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  switch (agent) {
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "openClaw":
      return intl.formatMessage({ id: "settingsSync.agent.openClaw" });
    case "augment":
      return intl.formatMessage({ id: "settingsSync.agent.augment" });
    case "continue":
      return intl.formatMessage({ id: "settingsSync.agent.continue" });
    case "goose":
      return intl.formatMessage({ id: "settingsSync.agent.goose" });
    case "qwenCode":
      return intl.formatMessage({ id: "settingsSync.agent.qwenCode" });
    case "qode":
      return intl.formatMessage({ id: "settingsSync.agent.qode" });
    case "qodeCn":
      return intl.formatMessage({ id: "settingsSync.agent.qodeCn" });
    case "windsurf":
      return intl.formatMessage({ id: "settingsSync.agent.windsurf" });
    case "trae":
      return intl.formatMessage({ id: "settingsSync.agent.trae" });
    case "traeCn":
      return intl.formatMessage({ id: "settingsSync.agent.traeCn" });
    case "kiroCli":
      return intl.formatMessage({ id: "settingsSync.agent.kiroCli" });
    case "roo":
      return intl.formatMessage({ id: "settingsSync.agent.roo" });
    case "codeBuddy":
      return intl.formatMessage({ id: "settingsSync.agent.codeBuddy" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    case "zcode":
      return intl.formatMessage({ id: "settingsSync.agent.zcode" });
    default:
      return agent;
  }
}

function getResourceCategory(
  agent: SettingsSyncAgentSummary,
  resourceCategory: ImportResourceCategory,
) {
  return agent.categories.find((category) => category.category === resourceCategory);
}

const SOURCE_ROOT_SCOPE_ORDER: SettingsSyncSourceScope[] = ["global", "project"];
const IMPORT_MODE_ORDER: SettingsSyncImportMode[] = ["symlink", "copy"];

function formatSourceRootScope(
  scope: SettingsSyncSourceScope,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  resourceCategory: ImportResourceCategory,
): string {
  return intl.formatMessage({ id: `settings.${resourceCategory}.import.scope.${scope}` });
}

function getSourceRootItems(
  sourceRoot: SettingsSyncSourceRootSummary,
  resourceCategory: ImportResourceCategory,
): ImportItemSummary[] {
  return resourceCategory === "skills"
    ? (sourceRoot.skills ?? [])
    : resourceCategory === "commands"
      ? (sourceRoot.commands ?? [])
      : resourceCategory === "plugins"
        ? (sourceRoot.plugins ?? [])
        : (sourceRoot.mcpServers ?? []);
}

function normalizePathForScope(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function inferSourceRootScope(
  path: string,
  workspacePath: string | null | undefined,
): SettingsSyncSourceScope {
  if (!workspacePath) {
    return "global";
  }
  const normalizedPath = normalizePathForScope(path);
  const normalizedWorkspacePath = normalizePathForScope(workspacePath);
  return normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
    ? "project"
    : "global";
}

function getSourceRoots(
  agent: SettingsSyncAgentSummary,
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): SettingsSyncSourceRootSummary[] {
  const category = getResourceCategory(agent, resourceCategory);
  if (!category) {
    return [];
  }
  if (category.sourceRoots && category.sourceRoots.length > 0) {
    return category.sourceRoots;
  }
  return (category.sourcePaths ?? []).map((path) => ({
    scope: inferSourceRootScope(path, workspacePath),
    path,
    discoveredCount: category.discoveredCount,
    importableCount: category.importableCount,
    skippedCount: category.skippedCount,
  }));
}

function groupAgentsBySourceRootScope(
  agents: SettingsSyncAgentSummary[],
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): Array<{
  scope: SettingsSyncSourceScope;
  rows: Array<{
    agent: SettingsSyncAgentSummary;
    sourceRoot: SettingsSyncSourceRootSummary;
  }>;
}> {
  return SOURCE_ROOT_SCOPE_ORDER.map((scope) => ({
    scope,
    rows: agents.flatMap((agent) =>
      getSourceRoots(agent, workspacePath, resourceCategory)
        .filter((sourceRoot) => sourceRoot.scope === scope)
        .filter((sourceRoot) =>
          getSourceRootItems(sourceRoot, resourceCategory).some((item) => item.importable),
        )
        .map((sourceRoot) => ({ agent, sourceRoot })),
    ),
  }));
}

export function SkillsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="skills" />;
}

export function CommandsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="commands" />;
}

export function PluginsImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="plugins" />;
}

export function McpServersImportDialog(props: ExternalAgentImportDialogProps) {
  return <ExternalAgentImportDialog {...props} category="mcpServers" />;
}

export interface ExternalAgentImportCategoryState {
  activeScope: SettingsSyncSourceScope;
  discovery: SettingsSyncDiscoveryResult | null;
  error: string | null;
  expandedSourceKeys: string[];
  importMode: SettingsSyncImportMode;
  importTargetScope: SettingsSyncSourceScope;
  loading: boolean;
  selectedCount: number;
  selectedKeys: string[];
  selections: SettingsSyncSelection[];
  totalImportableCount: number;
  loadDiscovery: () => Promise<void>;
  setActiveSourceScope: (scope: SettingsSyncSourceScope) => void;
  setImportMode: (mode: SettingsSyncImportMode) => void;
  setImportTargetScope: (scope: SettingsSyncSourceScope) => void;
  setResourceSelection: (keys: string[], checked: boolean) => void;
  toggleExpanded: (key: string) => void;
  toggleSelection: (key: string) => void;
}

export function useExternalAgentImportCategoryState({
  category,
  enabled,
  settingsSyncService,
  workspaceIdentity,
  workspacePath,
}: {
  category: ImportResourceCategory;
  enabled: boolean;
  settingsSyncService: ISettingsSyncService;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
}): ExternalAgentImportCategoryState {
  const [loading, setLoading] = useState(false);
  const [discovery, setDiscovery] = useState<SettingsSyncDiscoveryResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [expandedSourceKeys, setExpandedSourceKeys] = useState<string[]>([]);
  const [activeScope, setActiveScope] = useState<SettingsSyncSourceScope>("global");
  const [importTargetScope, setImportTargetScope] = useState<SettingsSyncSourceScope>("global");
  const [importMode, setImportMode] = useState<SettingsSyncImportMode>("symlink");
  const [error, setError] = useState<string | null>(null);

  const totalImportableCount = useMemo(
    () =>
      discovery?.agents.reduce(
        (sum, agent) =>
          sum +
          agent.categories.reduce(
            (categorySum, category) => categorySum + category.importableCount,
            0,
          ),
        0,
      ) ?? 0,
    [discovery],
  );

  const loadDiscovery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextDiscovery = await settingsSyncService.detect({
        workspacePath: workspacePath ?? undefined,
        workspaceIdentity,
        categories: [category],
        intent: "manualImport",
      });
      setDiscovery(nextDiscovery);
      setSelectedKeys([]);
      setExpandedSourceKeys([]);
      setActiveScope("global");
      setImportTargetScope("global");
    } catch (loadError) {
      const message = normalizeError(loadError);
      logger.error("[ExternalAgentImportDialog] scan failed", { category, error: message });
      setError(message);
      setDiscovery({ agents: [] });
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  }, [category, settingsSyncService, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!enabled || discovery || loading) {
      return;
    }
    void loadDiscovery();
  }, [discovery, enabled, loadDiscovery, loading]);

  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return [...next];
    });
  }, []);

  const setResourceSelection = useCallback((keys: string[], checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return [...next];
    });
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedSourceKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }, []);

  const setActiveSourceScope = useCallback((nextScope: SettingsSyncSourceScope) => {
    setActiveScope(nextScope);
    setImportTargetScope(nextScope);
  }, []);

  const selections = useMemo(
    () => buildExternalAgentImportSelections(selectedKeys, importTargetScope, importMode),
    [importMode, importTargetScope, selectedKeys],
  );

  return {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount: selectedKeys.length,
    selectedKeys,
    selections,
    totalImportableCount,
    loadDiscovery,
    setActiveSourceScope,
    setImportMode,
    setImportTargetScope,
    setResourceSelection,
    toggleExpanded,
    toggleSelection,
  };
}

function ExternalAgentImportDialog({
  category,
  open,
  workspacePath,
  workspaceIdentity,
  settingsSyncService,
  onOpenChange,
  onImported,
}: CategorizedExternalAgentImportDialogProps) {
  const { intl } = useZCodeIntl();
  const [step, setStep] = useState<ImportStep>("selection");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<SettingsSyncImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importState = useExternalAgentImportCategoryState({
    category,
    enabled: open,
    settingsSyncService,
    workspacePath,
    workspaceIdentity,
  });
  const {
    activeScope,
    discovery,
    error,
    expandedSourceKeys,
    importMode,
    importTargetScope,
    loading,
    selectedCount,
    selectedKeys,
    totalImportableCount,
  } = importState;

  const importProgress = step === "complete" ? 100 : importing ? 62 : 0;
  const importedResults = useMemo(() => getImportResults(result, category), [category, result]);
  const displayError = error ?? importError;

  useEffect(() => {
    if (!open) {
      return;
    }
    setResult(null);
    setImportError(null);
    setStep("selection");
  }, [open]);

  const startImport = useCallback(
    async (targetScope: SettingsSyncSourceScope) => {
      if (selectedKeys.length === 0) {
        return;
      }
      setImporting(true);
      setStep("importing");
      setImportError(null);
      try {
        logger.debug("[ExternalAgentImportDialog] import start", {
          category,
          targetScope,
          importMode,
          selectedCount: selectedKeys.length,
        });
        const importResult = await settingsSyncService.importSelected({
          workspacePath: workspacePath ?? undefined,
          workspaceIdentity,
          selections: buildExternalAgentImportSelections(selectedKeys, targetScope, importMode),
        });
        setResult(importResult);
        setStep("complete");
        await onImported();
      } catch (importError) {
        const message = normalizeError(importError);
        logger.error("[ExternalAgentImportDialog] import failed", { category, error: message });
        setImportError(message);
        setStep("selection");
      } finally {
        setImporting(false);
      }
    },
    [
      onImported,
      category,
      importMode,
      selectedKeys,
      settingsSyncService,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const closeLabel =
    step === "complete"
      ? intl.formatMessage({ id: `settings.${category}.import.finish` })
      : intl.formatMessage({ id: "settingsSync.action.skip" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(84vh,640px)] max-h-[calc(100vh-2rem)] max-w-2xl overflow-hidden rounded-2xl p-0">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-5">
            <DialogHeader className="shrink-0 sm:-mt-1">
              <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between">
                <DialogTitle className="flex min-w-0 items-center text-ui-lg">
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: `settings.${category}.import.title` })}
                  </span>
                </DialogTitle>
                {step === "selection" && !loading && discovery?.agents.length ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <SourceScopeSelect
                      category={category}
                      activeScope={activeScope}
                      onActiveScopeChange={importState.setActiveSourceScope}
                    />
                    <ControlHintTooltip
                      title={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
                        onClick={() => void importState.loadDiscovery()}
                        disabled={loading}
                      >
                        <RefreshCw className="size-3" aria-hidden="true" />
                      </Button>
                    </ControlHintTooltip>
                  </div>
                ) : null}
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              <div className="h-full overflow-auto p-3">
                {displayError ? (
                  <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
                    {displayError}
                  </div>
                ) : null}

                {loading ? (
                  <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
                    <LoaderCircle className="size-4 animate-spin" />
                    {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
                  </div>
                ) : step === "importing" ? (
                  <div className="space-y-4 rounded-lg bg-surface px-4 py-5">
                    <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
                      <span>
                        {intl.formatMessage({ id: `settings.${category}.import.importing` })}
                      </span>
                      <span>{importProgress}%</span>
                    </div>
                    <Progress value={importProgress} className="h-2 rounded-full bg-background" />
                  </div>
                ) : step === "complete" ? (
                  <div className="space-y-4">
                    <ImportStatsSummary category={category} result={result} />
                    <ImportResultList category={category} results={importedResults} />
                  </div>
                ) : discovery && discovery.agents.length > 0 ? (
                  <ImportSelectionList
                    category={category}
                    discovery={discovery}
                    workspacePath={workspacePath}
                    activeScope={activeScope}
                    selectedKeys={selectedKeys}
                    expandedSourceKeys={expandedSourceKeys}
                    onToggleSelection={importState.toggleSelection}
                    onSetResourceSelection={importState.setResourceSelection}
                    onToggleExpanded={importState.toggleExpanded}
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: `settings.${category}.import.empty` })}
                  </div>
                )}
              </div>
            </div>

            <div
              className={cn(
                "flex shrink-0 flex-wrap items-center gap-3",
                step === "complete" ? "justify-end" : "justify-between",
              )}
            >
              {step === "complete" ? null : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: `settings.${category}.import.summary` },
                      { count: String(totalImportableCount) },
                    )}
                  </div>
                  {step === "selection" && category !== "mcpServers" ? (
                    <ImportModeSelect
                      category={category}
                      importMode={importMode}
                      onImportModeChange={importState.setImportMode}
                    />
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {step === "complete" ? (
                  <Button type="button" size="lg" onClick={() => onOpenChange(false)}>
                    {closeLabel}
                  </Button>
                ) : null}
                {step === "selection" ? (
                  <ImportTargetDropdownButton
                    category={category}
                    targetScope={importTargetScope}
                    disabled={selectedCount === 0 || loading}
                    workspacePath={workspacePath}
                    onTargetScopeChange={importState.setImportTargetScope}
                    onImport={(targetScope) => void startImport(targetScope)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ExternalAgentImportSelectionPanel({
  category,
  state,
  workspacePath,
}: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.summary` },
            { count: String(state.totalImportableCount) },
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SourceScopeSelect
            category={category}
            activeScope={state.activeScope}
            onActiveScopeChange={state.setActiveSourceScope}
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "settingsSync.action.rescan" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "settingsSync.action.rescan" })}
              onClick={() => void state.loadDiscovery()}
              disabled={state.loading}
            >
              <RefreshCw className="size-3" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-full overflow-auto p-3">
          {state.error ? (
            <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
              {state.error}
            </div>
          ) : null}
          {state.loading ? (
            <div className="flex h-full min-h-48 items-center justify-center gap-2 rounded-lg bg-surface px-4 py-10 text-ui-base text-foreground-subtle">
              <LoaderCircle className="size-4 animate-spin" />
              {intl.formatMessage({ id: `settings.${category}.import.scanning` })}
            </div>
          ) : state.discovery && state.discovery.agents.length > 0 ? (
            <ImportSelectionList
              category={category}
              discovery={state.discovery}
              workspacePath={workspacePath}
              activeScope={state.activeScope}
              selectedKeys={state.selectedKeys}
              expandedSourceKeys={state.expandedSourceKeys}
              onToggleSelection={state.toggleSelection}
              onSetResourceSelection={state.setResourceSelection}
              onToggleExpanded={state.toggleExpanded}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: `settings.${category}.import.empty` })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: `settings.${category}.import.selectionCount` },
            {
              selected: String(state.selectedCount),
              total: String(state.totalImportableCount),
            },
          )}
        </div>
        <div className="flex items-center gap-3">
          {category !== "mcpServers" ? (
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-ui-base text-foreground-subtlest">
                {intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
              </span>
              <ImportModeSelect
                category={category}
                importMode={state.importMode}
                onImportModeChange={state.setImportMode}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
            </span>
            <ImportTargetScopeSelect
              category={category}
              targetScope={state.importTargetScope}
              workspacePath={workspacePath}
              onTargetScopeChange={state.setImportTargetScope}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportModeSelect({
  category,
  importMode,
  onImportModeChange,
}: {
  category: ImportResourceCategory;
  importMode: SettingsSyncImportMode;
  onImportModeChange: (importMode: SettingsSyncImportMode) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
      <Select
        value={importMode}
        onValueChange={(nextMode) => {
          onImportModeChange(nextMode as SettingsSyncImportMode);
        }}
      >
        <SelectTrigger
          size="sm"
          variant="ghost"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
          className="w-fit shrink-0 justify-end border-border bg-surface text-right font-medium text-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-selected *:data-[slot=select-value]:justify-end"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {IMPORT_MODE_ORDER.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {intl.formatMessage({ id: `settings.${category}.import.mode.${mode}` })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ControlHintTooltip
        title={intl.formatMessage({ id: `settings.${category}.import.modeLabel` })}
        description={intl.formatMessage({
          id:
            importMode === "symlink"
              ? `settings.${category}.import.mode.symlink.description`
              : `settings.${category}.import.mode.copy.description`,
        })}
        side="top"
        align="start"
      >
        <span
          role="img"
          aria-label={intl.formatMessage({ id: `settings.${category}.import.modeHelp` })}
          className="inline-flex size-4 items-center justify-center rounded-full text-foreground-subtlest hover:bg-hover hover:text-foreground"
        >
          <AlertCircleIcon className="size-3" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </div>
  );
}

function ImportTargetDropdownButton({
  category,
  targetScope,
  disabled,
  workspacePath,
  onTargetScopeChange,
  onImport,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  disabled: boolean;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
  onImport: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  const hasWorkspaceTarget = Boolean(workspacePath);
  const canImportToTarget = targetScope === "global" || hasWorkspaceTarget;
  const activeTargetLabelId =
    targetScope === "project"
      ? `settings.${category}.import.target.project`
      : `settings.${category}.import.target.global`;
  return (
    <div className="flex items-center">
      <Button
        type="button"
        size="lg"
        disabled={disabled || !canImportToTarget}
        aria-label={intl.formatMessage({ id: activeTargetLabelId })}
        className="rounded-r-none border-r-0"
        onClick={() => onImport(targetScope)}
      >
        {intl.formatMessage({ id: activeTargetLabelId })}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="lg"
            className="rounded-l-none border-l-0 px-2"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => onTargetScopeChange("global")}>
            {intl.formatMessage({ id: `settings.${category}.import.target.global` })}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasWorkspaceTarget}
            onSelect={() => onTargetScopeChange("project")}
          >
            {intl.formatMessage({ id: `settings.${category}.import.target.project` })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ImportTargetScopeSelect({
  category,
  targetScope,
  workspacePath,
  onTargetScopeChange,
}: {
  category: ImportResourceCategory;
  targetScope: SettingsSyncSourceScope;
  workspacePath: string | null | undefined;
  onTargetScopeChange: (targetScope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  const hasWorkspaceTarget = Boolean(workspacePath);
  return (
    <Select
      value={targetScope}
      onValueChange={(nextScope) => {
        onTargetScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.targetLabel` })}
        className="w-fit shrink-0 justify-end border-border bg-surface text-right font-medium text-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-selected *:data-[slot=select-value]:justify-end"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="global">
          {intl.formatMessage({ id: `settings.${category}.import.scope.global` })}
        </SelectItem>
        <SelectItem value="project" disabled={!hasWorkspaceTarget}>
          {intl.formatMessage({ id: `settings.${category}.import.scope.project` })}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function ImportStatsSummary({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: SettingsSyncImportResult | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface px-3 py-2 text-ui-xs text-foreground-subtle">
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.imported` })}
        value={result?.successCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.skipped` })}
        value={result?.skippedCount ?? 0}
      />
      <ImportStat
        label={intl.formatMessage({ id: `settings.${category}.import.failed` })}
        value={result?.failedCount ?? 0}
      />
    </div>
  );
}

function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono text-ui-base font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function ImportResultList({
  category,
  results,
}: {
  category: ImportResourceCategory;
  results: ImportItemResult[];
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: `settings.${category}.import.resultList` })}
      </div>
      <div className="overflow-hidden rounded-lg bg-card">
        {results.length === 0 ? (
          <div className="px-3 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.resultEmpty` })}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {results.map((itemResult) => (
              <ImportResultRow
                key={`${itemResult.status}:${itemResult.sourceScope}:${itemResult.path}`}
                category={category}
                result={itemResult}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ImportResultRow({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2">
      <ImportStatusBadge category={category} result={result} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{result.name}</span>
        {"version" in result && result.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {result.version.startsWith("v") ? result.version : `v${result.version}`}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function ImportStatusBadge({
  category,
  result,
}: {
  category: ImportResourceCategory;
  result: ImportItemResult;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({
    id:
      result.status === "imported"
        ? `settings.${category}.import.imported`
        : result.status === "skipped"
          ? `settings.${category}.import.skipped`
          : `settings.${category}.import.failed`,
  });
  const reasonLabel = result.skipReason
    ? intl.formatMessage({ id: `settings.${category}.import.skipReason.${result.skipReason}` })
    : null;
  const accessibleLabel = reasonLabel ? `${label}: ${reasonLabel}` : label;
  const Icon =
    result.status === "imported"
      ? CheckIcon
      : result.status === "skipped"
        ? AlertCircleIcon
        : XIcon;

  return (
    <span
      aria-label={accessibleLabel}
      role="img"
      className={cn(
        "flex size-3 shrink-0 items-center justify-center rounded-full",
        result.status === "imported" && "bg-success text-success-foreground",
        result.status === "skipped" && "bg-warning text-warning-foreground",
        result.status === "failed" && "bg-destructive text-destructive-foreground",
      )}
      title={accessibleLabel}
    >
      <Icon className="size-2" aria-hidden="true" />
    </span>
  );
}

function SourceScopeSelect({
  category,
  activeScope,
  onActiveScopeChange,
}: {
  category: ImportResourceCategory;
  activeScope: SettingsSyncSourceScope;
  onActiveScopeChange: (scope: SettingsSyncSourceScope) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select
      value={activeScope}
      onValueChange={(nextScope) => {
        onActiveScopeChange(nextScope as SettingsSyncSourceScope);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        aria-label={intl.formatMessage({ id: `settings.${category}.import.scopeLabel` })}
        className="w-fit shrink-0 justify-end text-right text-foreground-subtle hover:text-foreground *:data-[slot=select-value]:justify-end"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SOURCE_ROOT_SCOPE_ORDER.map((scope) => (
          <SelectItem key={scope} value={scope}>
            {formatSourceRootScope(scope, intl, category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ImportSelectionList({
  category,
  discovery,
  workspacePath,
  activeScope,
  selectedKeys,
  expandedSourceKeys,
  onToggleSelection,
  onSetResourceSelection,
  onToggleExpanded,
}: {
  category: ImportResourceCategory;
  discovery: SettingsSyncDiscoveryResult;
  workspacePath: string | null | undefined;
  activeScope: SettingsSyncSourceScope;
  selectedKeys: string[];
  expandedSourceKeys: string[];
  onToggleSelection: (key: string) => void;
  onSetResourceSelection: (keys: string[], checked: boolean) => void;
  onToggleExpanded: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const expanded = useMemo(() => new Set(expandedSourceKeys), [expandedSourceKeys]);
  const scopes = useMemo(
    () => groupAgentsBySourceRootScope(discovery.agents, workspacePath, category),
    [category, discovery.agents, workspacePath],
  );
  const activeGroup = scopes.find((scope) => scope.scope === activeScope);
  const activeImportableResourceKeys = useMemo(
    () =>
      activeGroup?.rows.flatMap(({ agent, sourceRoot }) => {
        const resourceCategory = getResourceCategory(agent, category);
        if (!resourceCategory) {
          return [];
        }
        return getSourceRootItems(sourceRoot, category)
          .filter((item) => item.importable)
          .map((item) =>
            getResourceSelectionKey({
              agent: agent.agent,
              category,
              sourceScope: sourceRoot.scope,
              resourcePath: item.path,
            }),
          );
      }) ?? [],
    [activeGroup, category],
  );
  const activeSelectedCount = activeImportableResourceKeys.filter((key) =>
    selected.has(key),
  ).length;
  const allActiveSelected =
    activeImportableResourceKeys.length > 0 &&
    activeSelectedCount === activeImportableResourceKeys.length;
  const partiallyActiveSelected =
    activeSelectedCount > 0 && activeSelectedCount < activeImportableResourceKeys.length;
  const toggleAllLabel = intl.formatMessage({
    id: allActiveSelected
      ? `settings.${category}.import.clearAll`
      : `settings.${category}.import.selectAll`,
  });

  return (
    <div className="flex w-full flex-col gap-1">
      {activeImportableResourceKeys.length > 0 ? (
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={partiallyActiveSelected ? "mixed" : allActiveSelected}
            aria-label={toggleAllLabel}
            onClick={() => onSetResourceSelection(activeImportableResourceKeys, !allActiveSelected)}
            className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-ui-base text-foreground-subtle transition-colors hover:text-foreground"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
                (allActiveSelected || partiallyActiveSelected) &&
                  "border-primary bg-primary text-primary-foreground",
              )}
            >
              {allActiveSelected ? <CheckIcon className="size-3.5" aria-hidden="true" /> : null}
              {partiallyActiveSelected ? (
                <MinusIcon className="size-3.5" aria-hidden="true" />
              ) : null}
            </span>
            <span className="shrink-0">{toggleAllLabel}</span>
          </button>
          <div className="min-w-0 text-right text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: `settings.${category}.import.selectionCount` },
              {
                selected: String(activeSelectedCount),
                total: String(activeImportableResourceKeys.length),
              },
            )}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        {activeGroup?.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-3 py-6 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.${category}.import.scopeEmpty` })}
          </div>
        ) : null}
        {activeGroup?.rows.map(({ agent, sourceRoot }) => {
          const resourceCategory = getResourceCategory(agent, category);
          if (!resourceCategory) {
            return null;
          }
          const key = getSourceSelectionKey(agent.agent, category, sourceRoot.scope);
          const sourceKey = `${key}:${sourceRoot.path}`;
          const items = getSourceRootItems(sourceRoot, category).filter((item) => item.importable);
          const importableResourceKeys = items.map((item) =>
            getResourceSelectionKey({
              agent: agent.agent,
              category,
              sourceScope: sourceRoot.scope,
              resourcePath: item.path,
            }),
          );
          const selectedImportableCount = importableResourceKeys.filter((itemKey) =>
            selected.has(itemKey),
          ).length;
          const checked =
            importableResourceKeys.length > 0 &&
            selectedImportableCount === importableResourceKeys.length;
          const partiallyChecked =
            selectedImportableCount > 0 && selectedImportableCount < importableResourceKeys.length;
          const disabled = importableResourceKeys.length === 0;
          const isExpanded = expanded.has(sourceKey);

          return (
            <div key={sourceKey} className="rounded-lg">
              <div
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                  disabled ? "opacity-70" : "hover:bg-surface-hover/50",
                )}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={intl.formatMessage({
                    id: checked
                      ? `settings.${category}.import.deselectSource`
                      : `settings.${category}.import.selectSource`,
                  })}
                  onClick={() => onSetResourceSelection(importableResourceKeys, !checked)}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md",
                    disabled ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border border-border",
                      (checked || partiallyChecked) &&
                        !disabled &&
                        "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked && !disabled ? <CheckIcon className="size-3.5" /> : null}
                    {partiallyChecked && !disabled ? <MinusIcon className="size-3.5" /> : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-left"
                >
                  <span className="text-ui-base font-medium text-foreground">
                    {formatAgentName(agent.agent, intl)}
                  </span>
                  <span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">
                    {sourceRoot.path}
                  </span>
                  {items.length > 0 ? (
                    <span className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage(
                        { id: `settings.${category}.import.itemCount` },
                        { count: String(items.length) },
                      )}
                    </span>
                  ) : null}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: isExpanded
                      ? `settings.${category}.import.collapseSource`
                      : `settings.${category}.import.expandSource`,
                  })}
                  onClick={() => onToggleExpanded(sourceKey)}
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </Button>
              </div>
              {isExpanded ? (
                <div className="ml-9 border-l border-border pl-3">
                  {items.map((item) => (
                    <ResourceSelectionRow
                      key={`${sourceKey}:${item.path}`}
                      agent={agent}
                      category={category}
                      sourceScope={sourceRoot.scope}
                      selected={selected}
                      item={item}
                      onToggleSelection={onToggleSelection}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResourceSelectionRow({
  agent,
  category,
  sourceScope,
  selected,
  item,
  onToggleSelection,
}: {
  agent: SettingsSyncAgentSummary;
  category: ImportResourceCategory;
  sourceScope: SettingsSyncSourceScope;
  selected: Set<string>;
  item: ImportItemSummary;
  onToggleSelection: (key: string) => void;
}) {
  const itemKey = getResourceSelectionKey({
    agent: agent.agent,
    category,
    sourceScope,
    resourcePath: item.path,
  });
  const checked = selected.has(itemKey);

  return (
    <button
      type="button"
      onClick={() => onToggleSelection(itemKey)}
      className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border border-border",
            checked && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {checked ? <CheckIcon className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 truncate text-ui-base text-foreground">{item.name}</span>
        {"version" in item && item.version ? (
          <Badge
            variant="outline"
            className="h-5 border-border bg-surface px-1.5 font-mono text-ui-xs font-normal text-foreground-subtle"
          >
            {item.version.startsWith("v") ? item.version : `v${item.version}`}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}
