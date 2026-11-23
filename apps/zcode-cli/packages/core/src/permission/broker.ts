// ============================================================
// Permission Broker - async client permission coordination
// ============================================================

import {
  CoreErrorType,
  createCoreError,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
} from "@zcode/contracts";

export interface ManualPermissionBrokerOptions {
  onRequest?: (request: PermissionBrokerRequest) => Promise<void> | void;
}

interface PendingBrokerRecord {
  request: PermissionBrokerRequest;
  resolve: (result: PermissionBrokerResult) => void;
  reject: (error: Error) => void;
}

export class DenyPermissionBroker implements PermissionBrokerPort {
  async requestPermission(request: PermissionBrokerRequest): Promise<PermissionBrokerResult> {
    if (request.mode === "guarded") {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        `No permission client configured for ${request.toolName}`,
        { recoverable: true },
      );
    }
    // 修复原因：原文字 `No permission client configured for X` 是配置诊断，模型读到后会当成环境故障反复重试；
    // 改成“已请求、未授予”，并在写文件时写出路径（00-tool-change-chain.md「工具错误的包装与文字」）。
    return {
      decision: "deny",
      reason: notGrantedMessage(request),
      resolvedAt: new Date(),
    };
  }
}

const FILE_WRITE_TOOL_NAMES = new Set(["Write", "Edit"]);
/** 没有审批客户端时给模型的文字；`action` 是 `use <Tool>`，写文件时是 `write to <file_path>`。 */
const NOT_GRANTED_MESSAGE = (action: string): string =>
  `ZCode requested permissions to ${action}, but you haven't granted it yet.`;

function notGrantedMessage(request: PermissionBrokerRequest): string {
  const filePath = readFilePath(request.input);
  return NOT_GRANTED_MESSAGE(
    FILE_WRITE_TOOL_NAMES.has(request.toolName) && filePath !== undefined
      ? `write to ${filePath}`
      : `use ${request.toolName}`,
  );
}

function readFilePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" ? filePath : undefined;
}

export class ManualPermissionBroker implements PermissionBrokerPort {
  private readonly pending = new Map<string, PendingBrokerRecord>();

  constructor(private readonly options: ManualPermissionBrokerOptions = {}) {}

  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult> {
    const key = request.requestId;
    if (this.pending.has(key)) {
      return Promise.reject(
        createCoreError(
          CoreErrorType.InvalidStateTransition,
          `Permission request already pending: ${key}`,
          {
            context: { requestId: key, toolCallId: request.toolCallId },
            recoverable: true,
          },
        ),
      );
    }

    return new Promise<PermissionBrokerResult>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        options?.signal?.removeEventListener("abort", abortHandler);
        this.pending.delete(key);
      };

      const settle = (result: PermissionBrokerResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ...result,
          resolvedAt: result.resolvedAt ?? new Date(),
        });
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const abortHandler = () => {
        fail(
          createCoreError(CoreErrorType.ToolCancelled, "Permission request cancelled", {
            context: { requestId: key, toolCallId: request.toolCallId, toolName: request.toolName },
            recoverable: true,
          }),
        );
      };

      if (options?.signal?.aborted) {
        abortHandler();
        return;
      }

      if (options?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          fail(
            createCoreError(
              CoreErrorType.PermissionTimeout,
              `Permission request timed out after ${options.timeoutMs}ms`,
              {
                context: {
                  requestId: key,
                  timeoutMs: options.timeoutMs,
                  toolCallId: request.toolCallId,
                  toolName: request.toolName,
                },
                recoverable: true,
              },
            ),
          );
        }, options.timeoutMs);
      }

      options?.signal?.addEventListener("abort", abortHandler);
      this.pending.set(key, { request, resolve: settle, reject: fail });

      Promise.resolve(this.options.onRequest?.(request)).catch(fail);
    });
  }

  resolvePermission(requestIdOrToolCallId: string, result: PermissionBrokerResult): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.resolve(result);
    return true;
  }

  rejectPermission(requestIdOrToolCallId: string, error: Error): boolean {
    const record = this.findPendingRecord(requestIdOrToolCallId);
    if (!record) return false;

    record.reject(error);
    return true;
  }

  getPendingRequest(requestIdOrToolCallId: string): PermissionBrokerRequest | undefined {
    return this.findPendingRecord(requestIdOrToolCallId)?.request;
  }

  listPendingRequests(): PermissionBrokerRequest[] {
    return Array.from(this.pending.values(), (record) => record.request);
  }

  private findPendingRecord(requestIdOrToolCallId: string): PendingBrokerRecord | undefined {
    const direct = this.pending.get(requestIdOrToolCallId);
    if (direct) return direct;

    return Array.from(this.pending.values()).find(
      (record) => record.request.toolCallId === requestIdOrToolCallId,
    );
  }
}

export const createDenyPermissionBroker = (): PermissionBrokerPort => new DenyPermissionBroker();

export const createManualPermissionBroker = (
  options?: ManualPermissionBrokerOptions,
): ManualPermissionBroker => new ManualPermissionBroker(options);
