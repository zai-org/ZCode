// cli-session-data-files 对外契约：CLI 存储根下按会话与目录定位的数据文件。
/** 记忆按目录派生；调用方注入与 CLI 记忆解析同一个函数，这里不复制 hash 规则。 */
export interface SessionDataDirectory {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 会话与目录在 CLI 存储根下的文件。大小只统计真实文件（lstat，不跟随符号链接），
 * remove 返回删除前测得的字节数；路径不存在按 0 处理，因此重复删除幂等。
 */
export interface SessionDataFile {
  name: string;
  relativePath: string;
  kind: "artifact" | "record";
  bytes: number;
}
export interface SessionDataFilesPort {
  listSessionFiles?(sessionId: string): Promise<SessionDataFile[]>;
  measureSession(sessionId: string): Promise<number>;
  removeSession(sessionId: string, retainedArtifactIds?: readonly string[]): Promise<number>;
  measureMemory(directory: SessionDataDirectory): Promise<number>;
  removeMemory(directory: SessionDataDirectory): Promise<number>;
}
