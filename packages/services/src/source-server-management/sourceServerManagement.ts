import type { Event } from "@zcode/rpc";
import type {
  RemoteTarget,
  SourceServerUpdateRequest,
  SourceServerMigrationReport,
  SourceServerManagementSnapshot,
  SourceServerManagementSnapshotRequest,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementStateDelta,
  SourceServerOperationLog,
  SourceServerRunningTasksResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface UpdateConnectionProfileInput {
  profileId: string;
  profileDisplayName: string;
  sourceDisplayName?: string;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  sshAuthMethod?: "password" | "privateKey";
}

export interface ISourceServerManagementService {
  readonly onDidChangeState: Event<SourceServerManagementStateDelta>;
  readonly onDidChangeDirectory: Event<SourceServerManagementDirectoryDelta>;
  /** Desktop Host 的连接/更新日志变更通知；历史由 Host 内存 owner 保留。 */
  readonly onDidAppendOperationLog?: Event<SourceServerOperationLog>;
  /** 显式进入/刷新页面时请求更新统计；事件刷新只读取已有投影，避免反馈轮询。 */
  getSnapshot(
    options?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot>;
  getRecentOperationLogs(profileId: string): Promise<SourceServerOperationLog[]>;
  connectProfile(
    profileId: string,
    options?: { retainedOnly?: boolean },
  ): Promise<SourceServerManagementSnapshot>;
  confirmIdentityChange(profileId: string): Promise<SourceServerManagementSnapshot>;
  disconnectSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  ensureConversationWorkspace(sourceServerId: string): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  updateSource(input: SourceServerUpdateRequest): Promise<SourceServerManagementSnapshot>;
  /**
   * 取消该线路处于本机阶段（快照带 `updateCancelable`）的更新，`canceled` 表示 Host 是否取消了更新；
   * 已进入远端阶段或没有更新时为空操作并返回 false（R3 §6.3）。被取消的 `updateSource` 以
   * `remote-connection-canceled` 拒绝。只对桌面 Renderer 开放。
   */
  cancelSourceUpdate(profileId: string): Promise<{ canceled: boolean }>;
  /**
   * 停止设备上的远端服务（RDLC-01）：Host 先断开并删除恢复意图，再在远端执行 `stop --wait`。
   * 成功和失败后设备都保持未连接；失败抛出带 code 的错误。只对桌面 Renderer 开放。
   */
  stopSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * 重启设备上的远端服务（RDLC-01）：Host 登记生命周期操作 flight（期间显示连接中），在远端执行
   * `restart`，成功后走现有连接流程并发出重连。失败抛出带 code 的错误。只对桌面 Renderer 开放。
   */
  restartSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  /**
   * 停止 / 重启确认前读取设备上的运行中任务（RDLC-01），路由与凭据规则同上两者。设备未提供可信清单
   * 时返回 `{ available: false }`，不当作没有任务；凭据不可静默取得时抛 `credentials-required`。
   * 只对桌面 Renderer 开放。
   */
  getSourceRunningTasks(sourceServerId: string): Promise<SourceServerRunningTasksResult>;
  renameSource(
    sourceServerId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot>;
  renameProfile(profileId: string, displayName: string): Promise<SourceServerManagementSnapshot>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<SourceServerManagementSnapshot>;
  setPreferredProfile(
    sourceServerId: string,
    profileId: string,
  ): Promise<SourceServerManagementSnapshot>;
  removeProfile(profileId: string): Promise<SourceServerManagementSnapshot>;
  removeSourceServer(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  getMigrationReport(sourceServerId: string): Promise<SourceServerMigrationReport>;
  exportMigrationReport(sourceServerId: string): Promise<string>;
  abandonWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
  retryWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
}

export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
