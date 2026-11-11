import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type {
  ApiClient,
  CreateFeedbackTicketInput,
  FeedbackDeviceInfo,
  FeedbackTicketDetail,
} from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_VERSION,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { LocalCredentialService } from "../credential/credentialService.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import {
  FeedbackHttpClient,
  FeedbackUploadCanceledError,
  isFeedbackAccessTokenInvalidError,
} from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const FEEDBACK_ACCESS_TOKEN_KEY = "zcodefeedbackaccesstoken";

export interface CreateFeedbackServiceOptions {
  credentialService: Pick<LocalCredentialService, "load" | "saveIfAbsent" | "deleteIfEquals">;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

interface FeedbackRequestAuth {
  headers: Record<string, string>;
  /** 匿名请求使用的 access token；登录请求没有。 */
  accessToken?: string;
}

function userRequestAuth(jwtToken: string): FeedbackRequestAuth {
  return { headers: { Authorization: `Bearer ${jwtToken}` } };
}

function anonymousRequestAuth(accessToken: string): FeedbackRequestAuth {
  return { headers: { "X-Feedback-AccessToken": accessToken }, accessToken };
}

function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.ZCODE_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeZCodeApiUrl(process.env, "/api/v1")
  );
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const httpClient = new FeedbackHttpClient({
    baseUrl: resolveApiBaseUrl(options.apiBaseUrl),
    apiClient: options.apiClient,
  });
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  async function loadCredential(key: string): Promise<string | undefined> {
    return (await options.credentialService.load(key))?.trim() || undefined;
  }

  // 已登录只带 JWT，未登录只带 access token。两者都没有时调用方不能发请求：
  // 服务端会把不带凭证的请求按通参里的 X-Device-Mid 当成旧版身份。
  async function loadRequestAuth(): Promise<FeedbackRequestAuth | undefined> {
    const jwtToken = await loadCredential(ZCODE_JWT_TOKEN_KEY);
    if (jwtToken) {
      return userRequestAuth(jwtToken);
    }
    const accessToken = await loadCredential(FEEDBACK_ACCESS_TOKEN_KEY);
    return accessToken ? anonymousRequestAuth(accessToken) : undefined;
  }

  async function requireRequestAuth(): Promise<FeedbackRequestAuth> {
    const auth = await loadRequestAuth();
    if (!auth) {
      throw new Error("Missing feedback credential");
    }
    return auth;
  }

  // 只在匿名提交时申请。签发属于本次创建，随它一起超时和取消，不在进程内合并成共享请求：
  // 共享请求曾导致签发悬挂时取消创建等不到结束，之后的提交也复用同一个悬挂请求。
  // 同进程或多个 Host 进程并发申请，都由凭据文件锁内的“没有才写入”收敛到同一个 access token。
  async function ensureAccessToken(signal: AbortSignal): Promise<string> {
    const stored = await loadCredential(FEEDBACK_ACCESS_TOKEN_KEY);
    if (stored) return stored;
    const issued = await httpClient.issueAccessToken(signal);
    return options.credentialService.saveIfAbsent(FEEDBACK_ACCESS_TOKEN_KEY, issued);
  }

  // 只有服务端明确判定 access token 无效时才丢弃；网络错误等不能丢，否则会无故丢失匿名身份。
  async function discardRejectedAccessToken(
    auth: FeedbackRequestAuth,
    error: unknown,
  ): Promise<void> {
    if (auth.accessToken && isFeedbackAccessTokenInvalidError(error)) {
      await options.credentialService.deleteIfEquals(FEEDBACK_ACCESS_TOKEN_KEY, auth.accessToken);
    }
  }

  async function sendWithAuth<T>(
    auth: FeedbackRequestAuth,
    send: (authHeaders: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(auth.headers);
    } catch (error) {
      await discardRejectedAccessToken(auth, error);
      throw error;
    }
  }

  async function createTicket(
    input: CreateFeedbackTicketInput,
    signal: AbortSignal,
  ): Promise<FeedbackTicketDetail> {
    const jwtToken = await loadCredential(ZCODE_JWT_TOKEN_KEY);
    if (jwtToken) {
      return httpClient.create(input, userRequestAuth(jwtToken).headers, { signal });
    }
    const auth = anonymousRequestAuth(await ensureAccessToken(signal));
    try {
      return await httpClient.create(input, auth.headers, { signal });
    } catch (error) {
      if (!isFeedbackAccessTokenInvalidError(error)) {
        throw error;
      }
      // 服务端在鉴权阶段拒绝，工单尚未创建；丢弃失效值后重新申请一次再重试，不会重复建单。
      await discardRejectedAccessToken(auth, error);
      return sendWithAuth(anonymousRequestAuth(await ensureAccessToken(signal)), (authHeaders) =>
        httpClient.create(input, authHeaders, { signal }),
      );
    }
  }

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        return await createTicket({ ...input, device }, controller.signal);
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) => {
      const auth = await loadRequestAuth();
      if (!auth) {
        // 未登录且从未匿名提交：没有可查询的身份，不为看列表申请 access token。
        return { items: [], total: 0 };
      }
      return sendWithAuth(auth, (authHeaders) => httpClient.list(query ?? {}, authHeaders));
    },
    get: async (id) =>
      sendWithAuth(await requireRequestAuth(), (authHeaders) => httpClient.get(id, authHeaders)),
    comment: async (id, body) =>
      sendWithAuth(await requireRequestAuth(), (authHeaders) =>
        httpClient.comment(id, body, authHeaders),
      ),
    uploadAttachment: async (id, kind, file) => {
      const auth = await requireRequestAuth();
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return sendWithAuth(auth, (authHeaders) =>
        httpClient.uploadFile(id, kind, file.path, filename, contentType, {
          authHeaders,
          messageId: file.messageId,
        }),
      );
    },
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const auth = await requireRequestAuth();
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return sendWithAuth(auth, (authHeaders) =>
        httpClient.uploadFile(id, kind, file.path, filename, contentType, {
          authHeaders,
          messageId: file.messageId,
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        }),
      )
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({
              id: progressId,
              phase: "canceled",
              uploadedBytes: 0,
              totalBytes: 0,
            });
          }
          throw error;
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const auth = await requireRequestAuth();
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // 附件名来自 renderer，不能作为本地相对路径使用。
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await sendWithAuth(auth, (authHeaders) =>
          httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
            authHeaders,
            messageId: file.messageId,
          }),
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const auth = await requireRequestAuth();
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await sendWithAuth(auth, (authHeaders) =>
          httpClient.uploadFile(
            id,
            "log",
            archive.path,
            basename(archive.path),
            "application/zip",
            {
              authHeaders,
            },
          ),
        );
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
