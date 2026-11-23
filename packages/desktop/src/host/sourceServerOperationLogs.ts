import { Emitter } from "@zcode/rpc";
import {
  getRemoteTransferProgressKey,
  normalizeRemoteConnectionError,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
  sourceServerOperationLogSchema,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerOperationLog,
} from "@zcode/shared";
import type { TransportContext } from "@zcode/server/source-server";

type Operation = { sequence: number; logs: SourceServerOperationLog[] };

/** 每类设备操作的开始与成功文案；失败文案来自归一化错误。 */
const OPERATION_MESSAGES: Record<
  SourceServerOperationLog["operation"],
  { phase: string; start: string; ready: string }
> = {
  connect: {
    phase: "probe",
    start: "Checking the remote device",
    ready: "Remote connection ready",
  },
  update: {
    phase: "probe",
    start: "Checking the remote device",
    ready: "Source Server update completed",
  },
  stop: { phase: "stop", start: "Stopping the remote service", ready: "Remote service stopped" },
  // 耦合点：阶段名同时是错误归一化的阶段兜底键。`restart` 已被安装进度占用（CLI
  // `source-server-install-progress` 的阶段，表示更新安装后重启 daemon）：`connectionErrors.ts`
  // 的 phaseCodes 把它兜底为 `remote-install-failed`，更新进度 UI 也按它显示“重启中”。重启远端服务
  // 若沿用 `restart`，未识别的失败会被误报为安装失败，所以用独立阶段名 `service-restart`。
  // 改名或新增阶段前须同时核对 phaseCodes 与 SourceServerUpdateActivity 的阶段映射。
  restart: {
    phase: "service-restart",
    start: "Restarting the remote service",
    ready: "Remote service restarted and reconnected",
  },
};

/** Host 内唯一日志历史；连接/更新/停止/重启共用，Renderer 的订阅仅作为查询失效通知。 */
export class SourceServerOperationLogs {
  private sequence = 0;
  private readonly profileKeys = new Map<string, string>();
  private readonly operations = new Map<string, Operation>();
  private readonly emitter = new Emitter<SourceServerOperationLog>();
  readonly onDidAppend = this.emitter.event;

  constructor(private readonly now: () => number) {}

  read(
    profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">,
  ): SourceServerOperationLog[] {
    const key = profile.sourceServerId
      ? `source:${profile.sourceServerId}`
      : this.profileKeys.get(profile.profileId);
    const operation = key ? this.operations.get(key) : undefined;
    return operation?.logs.map((entry) => ({ ...entry })) ?? [];
  }

  removeProfile(profileId: string): void {
    const key = this.profileKeys.get(profileId);
    this.profileKeys.delete(profileId);
    if (key && ![...this.profileKeys.values()].includes(key)) this.operations.delete(key);
  }

  async run<T extends { sourceServerId: string; profileId: string }>(
    operation: SourceServerOperationLog["operation"],
    profile: ConnectionProfile,
    target: RemoteTarget,
    context: TransportContext | undefined,
    task: (context: TransportContext) => Promise<T>,
  ): Promise<T> {
    const current: Operation = { sequence: ++this.sequence, logs: [] };
    let key = profile.sourceServerId
      ? `source:${profile.sourceServerId}`
      : `profile:${profile.profileId}`;
    let ownerProfileId = profile.profileId;
    const previous = this.operations.get(key);
    this.profileKeys.set(ownerProfileId, key);
    this.operations.set(key, current);
    const secrets =
      target.kind === "ssh"
        ? [target.password, target.privateKeyPassphrase, target.privateKeyPath].filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    const messages = OPERATION_MESSAGES[operation];
    let phase = messages.phase;
    let active = true;
    const emit = (
      event: { phase: string; message: string; progress?: number },
      level: SourceServerOperationLog["level"] = "info",
    ) => {
      if (!active || this.operations.get(key) !== current) return;
      phase = event.phase;
      const message = sanitizeRemoteConnectionLog(event.message, secrets);
      if (!message) return;
      const entry = sourceServerOperationLogSchema.parse({
        ...event,
        message,
        level,
        profileId: ownerProfileId,
        operation,
        timestamp: this.now(),
      });
      if (entry.progress !== undefined) {
        current.logs = current.logs.filter(
          (previous) => previous.phase !== entry.phase || previous.progress === undefined,
        );
      }
      // Bug 原因：远端下载的进度是 wget/curl 旁路脚本每秒输出的纯文本行，不带 progress，上面的规则合并不到，
      // 样本逐条追加：设备日志刷屏，慢网下载超过约 100 秒还会把同次操作的开始、预检与警告挤出窗口。
      // 文本进度在写入这份唯一历史时按传输键只保留最新一行，UI 直接展示查询结果，不再二次合并。
      const transferKey = getRemoteTransferProgressKey(entry.message);
      if (transferKey) {
        current.logs = current.logs.filter(
          (previous) => getRemoteTransferProgressKey(previous.message) !== transferKey,
        );
      }
      current.logs = [...current.logs, entry].slice(-100);
      this.emitter.fire(entry);
      context?.onLog?.({ ...event, message, level });
    };
    emit({ phase, message: messages.start });
    try {
      // 原先默认 info 覆盖了环境探测的 warn，导致风险提示失去警告样式；保留生产者级别。
      const result = await task({ ...context, onLog: (event) => emit(event, event.level) });
      const nextKey = `source:${result.sourceServerId}`;
      if (nextKey !== key && this.operations.get(key) === current) {
        // 身份换代生成新 Source/Profile；旧设备只保留换代前自己的历史。
        if (profile.sourceServerId && previous) this.operations.set(key, previous);
        else this.operations.delete(key);
      }
      key = nextKey;
      ownerProfileId = result.profileId;
      this.profileKeys.set(ownerProfileId, key);
      const latest = this.operations.get(key);
      if (!latest || latest.sequence <= current.sequence) this.operations.set(key, current);
      emit({ phase: "ready", message: messages.ready, progress: 1 });
      return result;
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      emit({ phase, message: failure.message }, remoteConnectionFailureLogLevel(failure.code));
      // 保留现有领域 Error 的 instanceof 语义，同时为 RPC 提供可识别的码与非空消息。
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), {
        ...failure,
        message:
          sanitizeRemoteConnectionLog(failure.message, secrets) || "Remote connection failed",
      });
    } finally {
      active = false;
    }
  }

  dispose(): void {
    this.profileKeys.clear();
    this.operations.clear();
    this.emitter.dispose();
  }
}
