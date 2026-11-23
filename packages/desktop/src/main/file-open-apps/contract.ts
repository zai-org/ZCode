import type { FileApplicationInfo, FileApplicationTarget } from "@zcode/shared";

/** 系统关联的真实身份不跨 IPC，只将其摘要给 renderer。 */
export interface NativeFileApplication {
  key: string;
  name: string;
  isDefault: boolean;
  iconPath?: string | null;
  /** Windows 原生资源已尝试提取；null 表示失败，不回退到普通 exe 文件图标。 */
  iconDataUrl?: string | null;
  iconIndex?: number;
  iconLocationHresult?: number;
  /** Windows 套件身份、格式 handler 身份与图标资源身份分别保留。 */
  appId?: string | null;
  progId?: string | null;
  iconIdentity?: string | null;
  suiteIconPath?: string | null;
  suiteIconDataUrl?: string | null;
  /** bundle/package/desktop 身份；同一应用的安装副本共享，不能用显示名替代。 */
  identity?: string;
  /** 系统提供的版本，仅用于同身份、非默认副本的确定性选择。 */
  version?: string;
  /** Linux 缺少 GIO 时，只保留能通过系统默认启动器确认打开的项。 */
  launchKind?: "system-default";
}

export interface FileApplicationNativeAdapter {
  query(path: string, options?: { includeIcons?: boolean }): Promise<NativeFileApplication[]>;
  open(application: NativeFileApplication, path: string): Promise<void>;
}

export interface FileOpenAppsContract {
  /** 无持久状态；本地真实文件以外、系统失败均返回空数组。 */
  getFileApplications(target: FileApplicationTarget): Promise<FileApplicationInfo[]>;
  /**
   * 每次重查关联；不会执行 renderer 提供的路径/命令作为应用。
   * 会执行文件的组合先经用户确认；用户取消返回 `{ success: true, cancelled: true }`。
   */
  openFileWithApplication(
    applicationId: string,
    target: FileApplicationTarget,
  ): Promise<{ success: boolean; error?: string; cancelled?: boolean }>;
}
