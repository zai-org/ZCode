import type {
  AppSessionControl,
  AppScope,
  AppSessionRef,
  AppTrustedContext,
} from "@zcode/session-control/contracts";
import type { ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { IProjectService, ProjectTree } from "#src/project/contract.js";
import type { IZCodeTaskService } from "#src/index.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type { IWindowControllerService } from "#src/window-controller/windowController.js";

/** 两类调用方共有的连接事实：fence、所属 Host、取消与代际校验。 */
export interface AppControlCallerConnection {
  /** 授权 fence：只验证连接代际，不是项目版本。 */
  connectionId: string;
  sourceServerId: string;
  signal: AbortSignal;
  /** 连接代际已变、已释放或授权已撤销时抛错。 */
  assertCurrent(): void;
}

/** 只由 Host 的活跃 CLI 连接构造；模型参数不能提供身份、权限或 bypass。 */
export interface AppControlBinding extends ZCodeAgentWorkspaceTarget, AppControlCallerConnection {
  callerSessionId: string;
  uiTarget?: string;
  turnId?: string;
  callId?: string;
  trace?: import("@zcode/shared").ZCodeProtocolTrace;
}

/**
 * 可信的非会话客户端（docs/plugins/extension-host.md §17.2）：只由 Host 进程内的可信组件构造
 * （扩展网关），不经任何 RPC。业务层只知道「客户端」，不知道插件。没有根会话，所以没有 self_wait。
 */
export interface AppControlClientBinding extends AppControlCallerConnection {
  kind: "client";
  /** 跨连接代际不变（例如 `extension:<pluginId>`），是幂等键的一部分。 */
  clientId: string;
  /**
   * 这个客户端发出的输入的来源（§17.8），由构造绑定的可信组件注入（扩展网关注入 `extension`）。
   * createSession 的首条输入与 sendToSession 必须带它；没有时报 unavailable，不发出没有来源的消息。
   */
  inputSource?: ConversationInputSource;
}

/** 导航 owner 完成实际打开后才能返回 opened；不把 open/resume 校验当作导航。 */
export interface AppControlNavigationPort {
  openSession(input: {
    session: AppSessionRef;
    uiTarget?: string;
    binding: AppControlCallerConnection & { uiTarget?: string };
  }): Promise<{ status: "opened" | "unavailable"; uiTarget?: string; reason?: string }>;
}

/** 每次可信调用捕获的只读来源；不建立连接，不创建 Agent，不保存跨调用目录。 */
export interface AppControlDiscoverySource {
  sourceServerId: string;
  scopes: readonly AppScope[];
  unavailableReason?: string;
  readTree(): Promise<ProjectTree>;
  /** 同步复验 caller 与实际连接代际；所有异步校验完成后必须无 await 地再执行一轮。 */
  assertCurrent(): void;
}

export interface AppControlDiscoveryFailure {
  sourceServerId: string;
  reason: string;
}

export interface AppControlDiscoveryBatch {
  sources: readonly AppControlDiscoverySource[];
  /** 一次读取 owner 目录快照并返回同步校验；该快照是入口授权时点，不保证分布式原子性。 */
  prepareValidation(): Promise<() => readonly AppControlDiscoveryFailure[]>;
}

export interface AppControlDiscoveryPort {
  listSources(binding: AppControlCallerConnection): Promise<AppControlDiscoveryBatch>;
}

export interface AppControlServiceDependencies {
  sourceServerId: string;
  projects: IProjectService;
  discovery?: AppControlDiscoveryPort;
  /** 只由所属 Source Server 注入 canonical 身份解析，不从路径推测远端身份。 */
  resolveWorkspaceIdentity?: (workspacePath: string) => Promise<string>;
  tasks: Pick<
    IZCodeTaskService,
    | "getTaskMeta"
    | "listTaskList"
    | "renameTask"
    | "setTaskPinned"
    | "archiveTask"
    | "unarchiveTask"
  >;
  agent: IZCodeAgentService;
  models: Pick<IModelSelectionService, "getView">;
  controller?: Pick<IWindowControllerService, "getTaskMeta" | "listTaskList" | "mutateTask">;
  navigation?: AppControlNavigationPort;
  reserveFork?: (input: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    projectId: string | null;
    /** 父任务 ID：子任务与父任务共用 cwd，预留时从父行继承 worktree 位置。 */
    forkedFromTaskId: string;
  }) => Promise<void>;
  /** 只解析本次创建的项目目录；会话身份由 Host 预留时按创建命令分配。 */
  prepareCreation?: (input: {
    projectId: string;
  }) => Promise<import("#src/project/contract.js").ProjectDirectories>;
  /**
   * 按创建命令只读查回执，不带 workspace；重试时主目录可能已变，回执及其任务目录是唯一事实源。
   * 无回执返回空数组；不预留、不分配身份。
   */
  findCreationReceipts?: (input: { clientId: string; commandId: string }) => Promise<
    Array<{
      sessionId: string;
      directories: import("#src/project/contract.js").ProjectDirectories;
    }>
  >;
}

export interface AppControlService {
  control: AppSessionControl;
  /** 绑定范围只从 Host 项目归属事实产生，不接受调用方自报授权。 */
  bind(binding: AppControlBinding): Promise<AppTrustedContext>;
  /**
   * 客户端类调用方（§17.2）：callerId 是 `<sourceServerId>:client:<clientId>`，范围与会话类相同
   * （本 Host 可读写，已连接来源可发现）。fence 是 binding.connectionId；每次调用都经 assertCurrent。
   */
  bindClient(binding: AppControlClientBinding): Promise<AppTrustedContext>;
}

/**
 * createLocalServices 交给进程内可信组件（扩展网关）的会话控制 facade 与它所属的 Host id。
 * 只在 Host 进程内传递，不注册进 ServiceCollection，不在任何 RPC 频道上（§17.2）。
 */
export interface AppControlServiceHandle {
  service: AppControlService;
  sourceServerId: string;
}
