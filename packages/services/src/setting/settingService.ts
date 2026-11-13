import { readFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  formatLogPrefix,
  formatZodError,
  hasLegacyIncompatiblePersistedLocale,
  toPersistedSettingsLocaleFields,
  USER_INSTRUCTIONS_MAX_BYTES,
  USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import type { ISettingService, WorkspaceSettingsProjection } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import {
  copyDataDirectory,
  getAgentUserInstructionsFilePath,
  getDataBaseDir,
  validateDataBaseDirTarget,
} from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
  type LegacyTeamConnection,
} from "#src/setting/legacyAccountConnectionSettings.js";
const MAX_RECENT_PROJECTS = 10;
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
const debugLog = (...args: unknown[]) => {
  // NODE_ENV 来自用户 shell 时会误导服务层 debug 开关；统一使用 ZCODE_RUNTIME_ENV。
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // 用户手动编辑或远端磁盘异常可能把 setting.json 写成非 JSON（例如 ":wq"）。
    // 如果只返回默认值不隔离坏文件，每次启动都会重复解析失败；这里保留备份后让后续 update 重建合法配置。
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 启动时多个服务可能同时读取同一个坏 setting.json。
      // 第一个读取已经完成隔离后，后续读取再 rename 会遇到 ENOENT；这是并发下的预期结果，不应当按备份失败刷错误日志。
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    // 原因：只在内存迁移仍会把磁盘上的 3 留给回滚客户端；必须走现有写锁落盘。
    raw.remoteBoundaryOnboardingVersion === 3 ||
    // 原因：本特性开发期间内部版本把 ja-JP 等写进了旧字段 locale/localePreference；
    // 旧版本读到会重置整份设置，所以读到就立即按新格式（旧字段降级 + uiLocale 新字段）落盘。
    hasLegacyIncompatiblePersistedLocale(raw) ||
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true ||
    raw.taskAutoArchiveResetVersion !== 1
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

async function readSettingsWithMetaAt(settingsFile: string): Promise<ReadSettingsResult> {
  try {
    // settingService.get() 会被 UI 和远程会话高频调用。
    // 之前每次读取都把完整配置写入生产日志，导致日志暴涨且暴露路径/配置细节；普通读取只保留开发态 debug。
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // setting.json 可能正被另一次 update 覆盖写入，读者会短暂读到半截 JSON。
      // 先做短重试，只有连续失败才按坏文件隔离，避免把正常会话配置误清成默认值。
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    return {
      settings: result.data,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // 文件解析失败等异常兜底返回默认值
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

async function writeSettingsAt(
  settingsFile: string,
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
): Promise<void> {
  const settingsDir = dirname(settingsFile);
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  // 界面语言统一经 toPersistedSettingsLocaleFields 落盘：旧字段 locale/localePreference 只写中英，
  // 真实选择写 uiLocale/uiLocalePreference，避免旧版本读到 ja-JP 等新值时重置整份设置。
  const persisted = {
    ...rollbackFields,
    ...settings,
    ...toPersistedSettingsLocaleFields(settings),
  };
  // 旧 Team 尚待 OAuth 补组织时，schema 的默认 {} 不是用户的新选择。
  // 普通偏好保存必须保留新字段缺席；只有迁移提交或用户显式选连接才结束旧导入。
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    useFileLock: false,
    beforeRename: () => {
      if (!shouldCommit()) {
        // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  return createSettingServiceWithMigrations().service;
}

export interface SettingServiceDependencies {
  /**
   * Desktop Host 注入：数据目录复制后请求 Main 把系统密钥登记到目标数据根。
   * 失败时切换中止、路径不变。Server/Web 不注入：托管密钥与路径无关，或随目录复制。
   */
  shareCredentialKeyWithDataRoot?: (targetBaseDir: string) => Promise<void>;
}

/** Host 私有迁移入口，不加入 Setting RPC；普通 get/update 从不等待 OAuth 查询。 */
export function createSettingServiceWithMigrations(dependencies: SettingServiceDependencies = {}): {
  service: ISettingService;
  setWorkspaceProjection: (
    reader: (settings: AppSettings) => Promise<WorkspaceSettingsProjection>,
  ) => void;
  prepareLegacyAccountConnections: (
    resolveOrganization: (connection: LegacyTeamConnection) => Promise<string | null>,
  ) => Promise<readonly ProviderFamilyDomain[]>;
} {
  // 原因：每次 IO 动态读 HOME 会让旧异步投影写进后来实例的目录。
  // 在实例创建时取值，既支持测试/Host 注入，也让读取、文件锁与替换始终同源。
  const settingsFile = join(resolveUserHomeDir(), ".zcode", "v2", "setting.json");
  // 个性化指令文件与 settingsFile 同理：实例创建时取值，读取与写入始终同源。
  const userInstructionsFile = getAgentUserInstructionsFilePath();
  // 修复原因（评审 CR-01）：atomicWriteText 只保证单次替换完整，不保证多次保存的提交顺序；
  // 慢 IO 下旧写的 rename 可能晚于新写落地，用旧内容覆盖已保存的新内容。个性化指令的
  // 写入必须进程内 FIFO 排队（组件按草稿新旧顺序入队，队尾即最新内容），跨实例写入由
  // 文件锁再兜一层；读取先排空队列，避免保存后立即重开读到旧内容。
  let userInstructionsWriteQueue: Promise<unknown> = Promise.resolve();
  const enqueueUserInstructionsWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const queued = userInstructionsWriteQueue.then(write, write);
    userInstructionsWriteQueue = queued.catch(() => {});
    return queued;
  };
  const getSettingsFile = () => settingsFile;
  const getSettingsDir = () => dirname(settingsFile);
  const readSettingsWithMeta = () => readSettingsWithMetaAt(settingsFile);
  const readSettings = async () => (await readSettingsWithMeta()).settings;
  const writeSettings = (
    settings: AppSettings,
    shouldCommit?: () => boolean,
    enterCommitPhase?: () => void,
    commitAccountSelection?: boolean,
  ) =>
    writeSettingsAt(settingsFile, settings, shouldCommit, enterCommitPhase, commitAccountSelection);
  let updateQueue = Promise.resolve();
  let writeQueueGeneration = 0;
  let workspaceProjection:
    | ((settings: AppSettings) => Promise<WorkspaceSettingsProjection>)
    | undefined;
  const projectSettings = async (settings: AppSettings): Promise<AppSettings> =>
    workspaceProjection
      ? appSettingsSchema.parse({ ...settings, ...(await workspaceProjection(settings)) })
      : settings;

  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = async () => {
      const currentGeneration = ++writeQueueGeneration;
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      await mkdir(getSettingsDir(), { recursive: true });
      // Main 的窗口尺寸与 Host 的远程目录会并发保存同一文件。只锁 rename 会让后写者
      // 用锁外读取的旧快照覆盖对方字段；事务必须在锁内重新读取、合并、提交。
      return withAtomicFileLock(getSettingsFile(), () =>
        withSettingsWriteQueueTimeout(
          (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
          () => {
            if (writeQueueGeneration === currentGeneration) {
              writeQueueGeneration += 1;
            }
          },
        ),
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
    updateQueue = queued.catch(() => {});
    await queued;
  };

  const service: ISettingService = {
    async get(): Promise<AppSettings> {
      // 设置切换后可能立即创建或冷恢复 Session；读取若越过已入队写入，
      // runtime 会固定旧开关值。先等待现有写队列，保证启动偏好读取到已提交的选择。
      await updateQueue;
      const result = await readSettingsWithMeta();
      const projected = await projectSettings(result.settings);
      if (
        !result.needsMigrationPersist &&
        JSON.stringify(projected) === JSON.stringify(result.settings)
      ) {
        return projected;
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta();
        const projected = await projectSettings(latest.settings);
        if (
          !latest.needsMigrationPersist &&
          JSON.stringify(projected) === JSON.stringify(latest.settings)
        ) {
          return;
        }

        // 初始化原因：旧版设置可能已把无法区分来源的默认值落盘；升级后按 schema 统一迁移一次。
        // 迁移写盘必须进入 updateQueue，并在队列内重读最新文件，避免覆盖并发保存的其他设置。
        await writeSettings(projected, shouldCommit, enterCommitPhase);
      });

      return readSettings();
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const current = await readSettings();
        // 原因：完整连接映射来自读改写快照；任一无版本写入者都能绕过其它窗口的 CAS。
        const writesConnections = Object.hasOwn(patch, "providerFamilyConnectionSelections");
        if (
          writesConnections &&
          expectedAccountSettings?.providerFamilyDomainUpdatedAt === undefined
        ) {
          throw new Error("Account connection CAS required");
        }
        if (expectedAccountSettings) {
          // 账号查询期间用户可能已手动切换。必须在同一写队列内校验，不能靠调用方先读再写。
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            // 原因：另一窗口重新选择相同身份时映射值不变；旧回滚仍须按操作版本拒绝。
            (expected.providerFamilyDomainUpdatedAt !== undefined &&
              (current.providerFamilyDomainUpdatedAt ?? 0) !==
                expected.providerFamilyDomainUpdatedAt) ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({
          ...current,
          ...validatedPatch,
        });

        if (writesConnections) {
          // 即使选择值相同也代表一次新操作，版本由同一写锁保证单调递增。
          merged.providerFamilyDomainUpdatedAt = Math.max(
            validatedPatch.providerFamilyDomainUpdatedAt ?? Date.now(),
            (current.providerFamilyDomainUpdatedAt ?? 0) + 1,
          );
        }

        // 打开工作区后会几乎同时写 recentProjects 和 lastWorkspaceSession。
        // 之前两个 update 都是基于各自读到的旧 settings 直接覆盖写回，
        // 后写入的补丁会把前一个字段整块抹掉，导致下次启动恢复不到会话。
        // 这里把写入串行化，让每个补丁都基于上一次真正落盘后的最新状态继续合并。
        if (merged.recentProjects) {
          merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
        }

        await writeSettings(
          await projectSettings(merged),
          shouldCommit,
          enterCommitPhase,
          Object.hasOwn(patch, "providerFamilyConnectionSelections"),
        );
      };

      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器/自动更新管理，把 .zcode/v2 放进去可能在升级时被覆盖。
        // 迁移前在 service 层拦截，避免 UI 入口变化或 RPC 调用绕过前端判断。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        // 修复原因（ZCT-2120723935487688704）：3.18.0 起凭据密钥存于系统库并按凭据文件路径分条目，
        // 只复制 credentials.json 时新根没有对应条目，重启后掉登录且无法重新登录。
        // 必须在保存新路径之前登记；失败则直接抛出，路径保持不变。
        await dependencies.shareCredentialKeyWithDataRoot?.(targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },

    async getUserInstructions(): Promise<{ content: string; filePath: string }> {
      // 读取等待已接纳的写入排空：保存后立即重开分区时不能把旧内容当基线。
      await userInstructionsWriteQueue;
      try {
        const content = await readFile(userInstructionsFile, "utf8");
        return { content, filePath: userInstructionsFile };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          // 文件不存在等价于未配置个性化指令，不算错误。
          return { content: "", filePath: userInstructionsFile };
        }
        throw error;
      }
    },

    async saveUserInstructions(content: string): Promise<{ filePath: string }> {
      // 最终校验用与 CLI 读取一致的共享常量，防止其他 RPC 调用方绕过 UI 写入超限内容
      // （Agent 只读前 100KB，超限保存会让用户误以为全部生效）。
      if (Buffer.byteLength(content, "utf8") > USER_INSTRUCTIONS_MAX_BYTES) {
        const error = new Error(`user instructions exceed ${USER_INSTRUCTIONS_MAX_BYTES} bytes`);
        (error as Error & { code: string }).code = USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE;
        throw error;
      }
      await enqueueUserInstructionsWrite(async () => {
        // 修复原因（评审 CR-01 回归）：acquireFileLock 以不带 recursive 的 mkdir(lockFile)
        // 创建锁文件，父目录 ~/.zcode 不存在时会 ENOENT 抛出——建目录必须发生在取锁之前，
        // 否则首次保存（目录尚不存在）永远失败。
        maybeThrowInjectedFsFault({ operation: "mkdir", path: dirname(userInstructionsFile) });
        await mkdir(dirname(userInstructionsFile), { recursive: true });
        await withAtomicFileLock(userInstructionsFile, async () => {
          maybeThrowInjectedFsFault({ operation: "writeFile", path: userInstructionsFile });
          // 修复原因（评审 CR-01 权限）：atomicWriteText 的临时文件不带 mode，rename 换 inode
          // 后会把既有 0600 文件放宽为 umask 默认（常见 0644），同机其他账号可读。
          // 私有写入固定 0600，只会收紧不会放宽权限。
          await atomicWritePrivateTextFile(userInstructionsFile, content);
        });
      });
      return { filePath: userInstructionsFile };
    },
  };

  let inFlight: Promise<readonly ProviderFamilyDomain[]> | null = null;
  let migrationComplete = false;
  return {
    service,
    setWorkspaceProjection(reader) {
      if (workspaceProjection) throw new Error("settings.workspace-projection-already-bound");
      workspaceProjection = reader;
    },
    prepareLegacyAccountConnections(resolveOrganization) {
      // 已完成导入后不让每次请求鉴权重复读迁移文件。恢复旧备份需要重启 Host。
      if (migrationComplete) return Promise.resolve([]);
      if (inFlight) return inFlight;
      const run = async (): Promise<readonly ProviderFamilyDomain[]> => {
        await service.get();
        const original = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
        const incomplete = readIncompleteLegacyTeamConnections(original);
        if (incomplete.length === 0) return [];
        // 网络在写队列外：代理设置读取及用户操作均可继续，不形成 get -> HTTP -> get 循环。
        const resolved = await Promise.all(
          incomplete.map(async (connection) => ({
            ...connection,
            organizationId: await resolveOrganization(connection).catch(() => null),
          })),
        );
        await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const latest = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
          // 只核对迁移输入，不因普通语言/窗口设置变化丢失合法结果，也不覆盖用户新账号意图。
          if (
            Object.hasOwn(latest, "providerFamilyConnectionSelections") ||
            latest.providerFamilyDomain !== original.providerFamilyDomain ||
            JSON.stringify(retainLegacyAccountConnectionFields(latest)) !==
              JSON.stringify(retainLegacyAccountConnectionFields(original))
          )
            return;
          if (resolved.some((entry) => !entry.organizationId?.trim())) return;
          const migrated = appSettingsSchema.parse(migrateLegacyAccountConnectionSettings(latest));
          const selections: ProviderFamilyConnectionSelectionSettings = {
            ...migrated.providerFamilyConnectionSelections,
          };
          for (const { family, productId, projectId, organizationId } of resolved) {
            selections[family] = {
              kind: "team-coding-plan",
              productId,
              projectId,
              organizationId: organizationId!.trim(),
            };
          }
          await writeSettings(
            await projectSettings({ ...migrated, providerFamilyConnectionSelections: selections }),
            shouldCommit,
            enterCommitPhase,
            true,
          );
        });
        return readIncompleteLegacyTeamConnections(
          await readLegacyAccountConnectionSettingsFile(getSettingsFile()),
        ).map((entry) => entry.family);
      };
      const pending = run();
      inFlight = pending;
      void pending.then(
        (unresolved) => {
          migrationComplete = unresolved.length === 0;
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
  };
}
