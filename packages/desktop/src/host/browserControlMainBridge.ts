import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingArtifact,
} from "@zcode/shared";

/**
 * host↔main browser 执行桥。host 侧把一条命令经 parentPort 发给 main（WebContentsView+CDP 执行），
 * 按 requestId 关联回传结果。仿 createFullFeedbackLogArchiveViaMain 的 pending map 模式。
 *
 * 设计成可注入 postMessage + 无全局依赖，便于单测（假 parentPort）。
 */

export interface BrowserExecuteRequestMessage {
  type: typeof HostResponseTypes.BrowserExecuteRequest;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  controlScopeId?: string;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionContext: "live" | "cached";
  command: BrowserCommand;
}

export interface BrowserExecuteResultMessage {
  requestId: string;
  result: BrowserCommandResult;
}

interface PendingEntry {
  resolve: (result: BrowserCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserCommand["method"];
  startedAt: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  outputPath?: string;
}

/**
 * host→main browser 子命令预算。外层 node_repl MCP 工具默认 60s；这里保留 30s，给 JS
 * 收尾、图片归一化和结构化错误返回留下余量，不能让两层 deadline 同时竞争。
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function mayHaveSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "finalize",
    "newTab",
  ].includes(command.method);
}

export interface BrowserControlMainBridge {
  list(): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId?: string;
    browserId?: string;
    browserGeneration?: number;
    controlScopeId?: string;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: BrowserClientMode;
    sessionContext?: "live" | "cached";
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
  /** main 回传结果时由 host 消息分派调用。 */
  handleResult(message: BrowserExecuteResultMessage): Promise<void>;
  dispose(): void;
}

export function createBrowserControlMainBridge(deps: {
  getBackendIdentity: () => { id: string; generation: number } | undefined;
  postToMain: (message: BrowserExecuteRequestMessage) => void;
  timeoutMs?: number;
  materializeRecording?(input: {
    artifact: BrowserRecordingArtifact;
    localPath: string;
    outputPath: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<BrowserRecordingArtifact>;
}): BrowserControlMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 资源位于 Main；Host 重建不能另造代次并遗忘旧资源。
  const deletePendingIfCurrent = (requestId: string, entry: PendingEntry): boolean => {
    if (pending.get(requestId) !== entry) return false;
    pending.delete(requestId);
    return true;
  };
  const descriptor: Omit<BrowserBackendDescriptor, "id" | "generation"> = {
    type: "iab",
    name: "ZCode In-app Browser",
    capabilities: {
      // capability collection 只列 optional capability；tabs/cua/screenshot/dialog 是 core API，
      // 不能伪装成 capability。viewport 是 Playwright-like Tab 核心 API；browser capability
      // 当前只保留 visibility，pageAssets/cdp 未实现不暴露。
      browser: [
        {
          id: "visibility",
          description:
            "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
        },
      ],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tabs.finalize": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "BrowserRecordingAPI.start": true,
      "BrowserRecordingAPI.status": true,
      "BrowserRecordingAPI.cancel": true,
    },
    metadata: {
      provider: "zcode-desktop-iab",
      controlScopes: "1",
    },
  };

  return {
    async list(): Promise<BrowserBackendDescriptor[]> {
      const identity = deps.getBackendIdentity();
      return identity ? [{ ...descriptor, ...identity }] : [];
    },

    async execute({
      requestId: inputRequestId,
      browserId: requestedBrowserId,
      browserGeneration: requestedBrowserGeneration,
      controlScopeId,
      sessionId,
      turnId,
      workspaceKey = sessionId,
      workspacePath = workspaceKey,
      workspaceIdentity,
      remoteSessionId,
      clientMode = "desktop-continuous",
      sessionContext = "live",
      command,
    }): Promise<BrowserCommandResult> {
      const identity = deps.getBackendIdentity();
      if (!identity)
        return {
          ok: false,
          elapsedMs: 0,
          ...(command.method === "openScope" && controlScopeId
            ? { scope: { id: controlScopeId, state: "rejected" as const } }
            : {}),
          error: { code: "backend_unavailable", message: "browser owner is not initialized" },
        };
      // 身份是否过期、旧 scope 是否存在由 Main 判断；桥只携带原身份转发。
      const browserId = requestedBrowserId ?? identity.id;
      const browserGeneration = requestedBrowserGeneration ?? identity.generation;
      const requestId = inputRequestId ?? randomUUID();
      if (pending.has(requestId)) {
        // requestId 是结果与 Promise 的 correlation key。覆盖同 key entry
        // 会把旧结果交给新 Promise，并让旧 timer/finally 删除新请求。必须在 transport 前失败。
        return {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      const startedAt = Date.now();
      // 固定等待的 transport budget 为请求时长加 2 秒，覆盖等待本身和传输开销。
      // 否则 waitForTimeout(>=30s) 会在 timer 正常完成前被 host bridge 误判超时。
      const requestTimeoutMs =
        command.method === "playwrightWaitForTimeout"
          ? command.timeoutMs + 2_000
          : command.method === "playwright"
            ? ("timeoutMs" in command.action
                ? (command.action.timeoutMs ?? timeoutMs)
                : timeoutMs) + 2_000
            : timeoutMs;
      return await new Promise<BrowserCommandResult>((resolve) => {
        let entry: PendingEntry;
        const timer = setTimeout(() => {
          // 只允许当前 entry 结算自己的生命周期；防止未来新增路径重新引入同 key 覆盖后，
          // 旧 timer 删除或取消后来登记的请求。
          if (!deletePendingIfCurrent(requestId, entry)) return;
          // 过去 host 只结束本地等待，main/backend 中的动作仍会继续执行，调用方却已
          // 收到 timeout。现在用同一 scope 发送反向 cancel；动作是否已经下发无法证明时，
          // 必须按操作结果契约标记 uncertain，不能谎报成无副作用超时。
          const cancelRequestId = randomUUID();
          try {
            deps.postToMain({
              type: HostResponseTypes.BrowserExecuteRequest,
              requestId: cancelRequestId,
              browserId,
              browserGeneration,
              controlScopeId,
              sessionId,
              turnId,
              workspaceKey,
              workspacePath,
              workspaceIdentity,
              remoteSessionId,
              clientMode,
              sessionContext,
              command: { method: "cancelRequest", requestId },
            });
          } catch {
            // 原请求已经超时；cancel transport 失败不会覆盖更有用的 timeout 结果。
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `browser command ${command.method} timed out after ${requestTimeoutMs}ms`,
              sideEffect: mayHaveSideEffects(command) ? "uncertain" : "none",
            },
            elapsedMs: Date.now() - startedAt,
          });
        }, requestTimeoutMs);
        entry = {
          resolve,
          timer,
          method: command.method,
          startedAt,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(command.method === "recordingStatus" && command.outputPath
            ? { outputPath: command.outputPath }
            : {}),
        };
        pending.set(requestId, entry);
        try {
          deps.postToMain({
            type: HostResponseTypes.BrowserExecuteRequest,
            requestId,
            browserId,
            browserGeneration,
            controlScopeId,
            sessionId,
            turnId,
            workspaceKey,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            clientMode,
            sessionContext,
            command,
          });
        } catch (error) {
          clearTimeout(timer);
          deletePendingIfCurrent(requestId, entry);
          resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
    },

    async handleResult(message): Promise<void> {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // 迟到结果（已超时清理）——忽略。
        return;
      }
      clearTimeout(entry.timer);
      if (!deletePendingIfCurrent(message.requestId, entry)) return;
      const artifact = message.result.recording?.artifact;
      if (
        message.result.ok &&
        message.result.recording?.status === "completed" &&
        artifact &&
        entry.outputPath
      ) {
        if (!deps.materializeRecording) {
          entry.resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser recording artifact materialization is unavailable",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
          return;
        }
        try {
          const materialized = await deps.materializeRecording({
            artifact,
            localPath: artifact.path,
            outputPath: entry.outputPath,
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
            ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
          });
          entry.resolve({
            ...message.result,
            recording: { ...message.result.recording, artifact: materialized },
          });
        } catch (error) {
          entry.resolve({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
        }
        return;
      }
      if (message.result.recording?.status === "completed" && artifact && !entry.outputPath) {
        const { artifact: _mainTemporaryArtifact, ...recording } = message.result.recording;
        entry.resolve({
          ...message.result,
          recording,
        });
        return;
      }
      entry.resolve(message.result);
    },

    dispose(): void {
      for (const [requestId, entry] of pending) {
        if (!deletePendingIfCurrent(requestId, entry)) continue;
        clearTimeout(entry.timer);
        // 直接 clear map 会让所有正在 await 的调用永久悬空。bridge shutdown 必须
        // 结束 promise，并明确 backend 是否已执行不可判定。
        entry.resolve({
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser bridge disposed while command was pending",
            sideEffect: "uncertain",
          },
          elapsedMs: Date.now() - entry.startedAt,
        });
      }
    },
  };
}
