import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface WindowsRuntimeHost {
  /** stdio 属于 CLI；ChildProcess 的 pid/exit 属于原生托管程序，不能当成 CLI 身份。 */
  readonly child: ChildProcessWithoutNullStreams;
  /** 启动握手完成前 PID 未知，但调用方已经拥有 child 与 close，不能漏记启动中的进程。 */
  readonly runtimePid: number | undefined;
  ready(): Promise<number>;
  /** 调用方安装协议和生命周期监听后才允许 CLI 开始运行；重复调用共享结果。 */
  start(): Promise<void>;
  /** EOF 后保留原生 1800ms 收尾窗口；仅在 Job 清空且 helper 退出后成功。失败可重新等待。 */
  close(deadlineAtMs: number): Promise<void>;
  /** 根退出与整棵 Job 清空是不同事实；该事件只报告根生命周期。 */
  onRootExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface WindowsRuntimeHostSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}
