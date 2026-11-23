/* eslint-disable max-lines -- 定时任务管理 store 集中维护列表/运行历史/CRUD 与立即运行等操作，稳定后再拆分。 */
import { create } from "zustand";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  isAutomationCreateLimitError,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
  type ModelSelection,
} from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";

// 定时任务(automation)管理 store：走 zcode-agent RPC（列表 / 创建 / 编辑 / 启停 / 重跑 / 删除 + 运行历史）。
// 与 pluginManagementStore 同一范式：按 workspace 缓存，切换时后台刷新避免闪烁。

/** 单条 automation 的运行历史缓存（按 automationId 记 loading/data/error）。 */
export interface AutomationRunsEntry {
  status: "loading" | "loaded" | "error";
  runs?: ZCodeAutomationRun[];
  error?: string;
}

export type AutomationRunNowResult = "queued" | "duplicate" | "hostMismatch" | "failed";

export interface CreateAutomationInput {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  // 目标项目;缺省用 store 当前列表所在项目。创建整页可在项目下拉里改。
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface UpdateAutomationInput {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface AutomationManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  automations: ZCodeAutomation[];
  loading: boolean;
  error: string | null;
  // 正在进行的写操作标记，用于禁用对应按钮（如 `automation:delete:<id>`）。
  operationId: string | null;
  runsCache: Record<string, AutomationRunsEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentService: IZCodeAgentService;
  }) => Promise<void>;
  refresh: (agentService: IZCodeAgentService) => Promise<void>;
  createAutomation: (
    input: CreateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<ZCodeAutomation | null>;
  updateAutomation: (
    automationId: string,
    input: UpdateAutomationInput,
    agentService: IZCodeAgentService,
  ) => Promise<boolean>;
  deleteAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  setEnabled: (
    automationId: string,
    enabled: boolean,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
  restartAutomation: (automationId: string, agentService: IZCodeAgentService) => Promise<void>;
  /** 立即运行一次；queued / duplicate / failed 均由调用方 toast。 */
  runAutomationNow: (
    automationId: string,
    agentService: IZCodeAgentService,
  ) => Promise<AutomationRunNowResult>;
  loadRuns: (
    automationId: string,
    agentService: IZCodeAgentService,
    force?: boolean,
  ) => Promise<void>;
  deleteRun: (
    automationId: string,
    runId: string,
    agentService: IZCodeAgentService,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let automationLoadSeq = 0;
const inFlightRunNowAutomationIds = new Set<string>();

function sameWorkspace(
  current: Pick<AutomationManagementState, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity: string | null,
): boolean {
  return current.workspacePath === workspacePath && current.workspaceIdentity === workspaceIdentity;
}

function resolveAutomationActionScope(
  state: Pick<AutomationManagementState, "automations" | "workspacePath" | "workspaceIdentity">,
  automationId: string,
): { workspacePath: string; workspaceIdentity: string | null } | null {
  const automation = state.automations.find((candidate) => candidate.automationId === automationId);
  const workspacePath = automation?.workspacePath ?? state.workspacePath;
  if (!workspacePath) return null;
  return {
    workspacePath,
    workspaceIdentity: automation?.workspaceIdentity ?? state.workspaceIdentity,
  };
}

async function loadInto(
  set: (partial: Partial<AutomationManagementState>) => void,
  get: () => AutomationManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    agentService: IZCodeAgentService;
    requestId: number;
  },
): Promise<void> {
  const { workspacePath, workspaceIdentity, agentService, requestId } = params;
  try {
    // 定时任务管理视图展示所有项目的任务，不按当前 workspace 过滤（创建/编辑仍带项目）。
    const automations = await agentService.listAllAutomations();
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    set({ automations, loading: false });
  } catch (error) {
    if (
      requestId !== automationLoadSeq ||
      !sameWorkspace(get(), workspacePath, workspaceIdentity)
    ) {
      return;
    }
    logger.error("[automations] load failed", {
      workspacePath,
      error: toMessage(error),
    });
    set({ error: toMessage(error), loading: false });
  }
}

export const useAutomationManagementStore = create<AutomationManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  automations: [],
  loading: false,
  error: null,
  operationId: null,
  runsCache: {},

  async initialize({ workspacePath, workspaceIdentity, agentService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const requestId = ++automationLoadSeq;
    const current = get();
    const hasCache =
      current.automations.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      // 有缓存时后台刷新、保留列表，避免切 workspace 闪烁；无缓存才显示阻塞 loading。
      loading: !hasCache,
      error: null,
      operationId: null,
      automations: hasCache ? current.automations : [],
      // 切换 workspace 时清运行历史缓存（历史按 automationId 记，跨 workspace 无意义）。
      ...(hasCache ? {} : { runsCache: {} }),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      agentService,
      requestId,
    });
  },

  async refresh(agentService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    const requestId = ++automationLoadSeq;
    set({ error: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      agentService,
      requestId,
    });
  },

  async createAutomation(input, agentService) {
    const { automations, workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return null;
    if (automations.length >= AUTOMATION_CREATE_LIMIT) {
      // 创建入口分散在表单、模板和会话，单独禁用某个按钮仍可绕过。
      // store 以管理页的全量列表做快速拒绝，服务层事务继续承担最终一致性校验。
      set({
        error: `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] automation limit reached`,
      });
      return null;
    }
    set({ operationId: `automation:create:${input.title}`, error: null });
    try {
      const created = await agentService.createAutomation({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        agentService,
        requestId,
      });
      return created;
    } catch (error) {
      const message = toMessage(error);
      if (isAutomationCreateLimitError(error)) {
        logger.warn("[automations] create blocked by limit", {
          limit: AUTOMATION_CREATE_LIMIT,
        });
      } else {
        logger.error("[automations] create failed", { error: message });
      }
      set({ error: message });
      return null;
    } finally {
      set({ operationId: null });
    }
  },

  async updateAutomation(automationId, input, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return false;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return false;
    set({ operationId: `automation:update:${automationId}`, error: null });
    try {
      await agentService.updateAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        ...input,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[automations] update failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async deleteAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:delete:${automationId}`, error: null });
    try {
      await agentService.deleteAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] delete failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(automationId, enabled, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({
      operationId: `automation:setEnabled:${automationId}`,
      error: null,
    });
    try {
      await agentService.setAutomationEnabled({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
        enabled,
      });
      // 编辑页持有打开时的 automation 对象；如果只等 listAllAutomations
      // 回源，菜单文案会在点击暂停/恢复后继续显示旧状态。
      set({
        automations: get().automations.map((automation) =>
          automation.automationId === automationId
            ? {
                ...automation,
                enabled,
                lifecycleStatus: enabled ? "active" : "paused",
              }
            : automation,
        ),
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] setEnabled failed", {
        automationId,
        enabled,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async restartAutomation(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:restart:${automationId}`, error: null });
    try {
      await agentService.restartAutomation({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
    } catch (error) {
      logger.error("[automations] restart failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async runAutomationNow(automationId, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return "failed";
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return "failed";
    if (inFlightRunNowAutomationIds.has(automationId)) {
      return "duplicate";
    }
    // React 禁用按钮存在一次渲染延迟，连续点击会在 UI 更新前重入。
    // 这里只在当前 RPC 请求期间使用同步内存锁；请求返回后恢复入口，
    // 活动 run 的重复触发继续交由 host single-flight 返回 duplicate。
    inFlightRunNowAutomationIds.add(automationId);
    set({ operationId: `automation:runNow:${automationId}`, error: null });
    try {
      const result = await agentService.runAutomationNow({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (result.status === "duplicate") {
        return "duplicate";
      }
      const requestId = ++automationLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return "queued";
    } catch (error) {
      logger.error("[automations] runNow failed", {
        automationId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      // 绑定会话的 tasks 行归属不是本机 Host 时，项目存储抛 project.host-mismatch.*，
      // 消息经 CLI/Host/RPC 原样到这里。单独返回原因，避免用户只看到笼统的「触发运行失败」。
      return toMessage(error).includes("project.host-mismatch") ? "hostMismatch" : "failed";
    } finally {
      inFlightRunNowAutomationIds.delete(automationId);
      set({ operationId: null });
    }
  },

  async loadRuns(automationId, agentService, force = false) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return;
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    const { runsCache } = state;
    const cached = runsCache[automationId];
    if (!force && cached && cached.status !== "error") return;
    set({
      runsCache: {
        ...get().runsCache,
        [automationId]: { status: "loading" },
      },
    });
    try {
      const runs = await agentService.listAutomationRuns({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        automationId,
      });
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "loaded", runs },
        },
      });
    } catch (error) {
      if (!sameWorkspace(get(), viewWorkspacePath, state.workspaceIdentity)) {
        return;
      }
      logger.error("[automations] load runs failed", {
        automationId,
        error: toMessage(error),
      });
      set({
        runsCache: {
          ...get().runsCache,
          [automationId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },

  async deleteRun(automationId, runId, agentService) {
    const state = get();
    const actionScope = resolveAutomationActionScope(state, automationId);
    if (!actionScope) return;
    set({ operationId: `automation:deleteRun:${runId}`, error: null });
    try {
      await agentService.deleteAutomationRun({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        runId,
      });
      await get().loadRuns(automationId, agentService, true);
    } catch (error) {
      logger.error("[automations] delete run failed", {
        runId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },
}));
