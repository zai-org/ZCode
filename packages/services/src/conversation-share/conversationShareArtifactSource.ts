import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

import type { IFileService } from "#src/file/file.js";

import { ConversationShareServiceError } from "./conversationShare.js";

export interface ConversationShareArtifactReadInput {
  workspacePath: string;
  ref: string;
  maxBytes: number;
}

export interface ConversationShareMaterializedArtifact {
  bytes: Uint8Array;
  canonicalPath: string;
}

export interface ConversationShareArtifactStat {
  canonicalPath: string;
  size: number;
  mtimeMs?: number;
}

export interface ConversationShareArtifactSource {
  read(input: ConversationShareArtifactReadInput): Promise<ConversationShareMaterializedArtifact>;
  stat?(
    input: Omit<ConversationShareArtifactReadInput, "maxBytes">,
  ): Promise<ConversationShareArtifactStat>;
}

const REMOTE_READ_CHUNK_BYTES = 512 * 1024;
const SKIPPABLE_ARTIFACT_READ_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

function isSkippableArtifactReadError(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === "string" && SKIPPABLE_ARTIFACT_READ_ERRNOS.has(errno);
}

/**
 * 兜底读失败统一带上 artifact_read_failed 与底层 errno：
 * 调用方据此把「正文引用的文件已不存在」降级为非阻断跳过，而不是打死整次发布。
 * errno 走已白名单化的 diagnostics，路径不进错误载荷。
 */
function unreadableArtifactError(message: string, cause: unknown): ConversationShareServiceError {
  const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new ConversationShareServiceError("invalid_conversation", message, {
    reasonCode: "artifact_read_failed",
    cause,
    ...(typeof errno === "string" ? { diagnostics: { errno } } : {}),
  });
}

function remotePathApi(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? win32 : posix;
}

function isRemoteInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const pathApi = remotePathApi(workspacePath);
  const relativePath = pathApi.relative(workspacePath, targetPath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
  );
}

/**
 * SSH/WSL/Docker 使用远端 fileService 完成 realpath/stat/range read；JWT 和 HTTP 上传仍留在 Desktop Host。
 */
export function createRemoteConversationShareArtifactSource(
  fileService: Pick<IFileService, "readFileRange" | "resolvePath" | "stat">,
): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }
      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const artifactStat = await fileService.stat({ path: artifactRealPath });
        if (artifactStat.type !== "file" || artifactStat.size === undefined) {
          throw unreadableArtifactError("Conversation artifact source is not a readable file", {
            code: "ENOTDIR",
          });
        }
        return {
          canonicalPath: artifactRealPath,
          size: artifactStat.size,
          ...(artifactStat.mtimeMs === undefined ? {} : { mtimeMs: artifactStat.mtimeMs }),
        };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }

      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }

        const before = await fileService.stat({ path: artifactRealPath });
        if (before.type !== "file" || before.size === undefined) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact source is not a readable file",
          );
        }
        if (before.size > input.maxBytes) {
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation artifact exceeds the byte limit",
            { diagnostics: { actualBytes: before.size } },
          );
        }

        const bytes = new Uint8Array(before.size);
        let offset = 0;
        while (offset < before.size) {
          const chunk = await fileService.readFileRange({
            path: artifactRealPath,
            offset,
            length: Math.min(REMOTE_READ_CHUNK_BYTES, before.size - offset),
          });
          if (chunk.byteLength === 0) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact ended during remote staging",
            );
          }
          if (offset + chunk.byteLength > before.size) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact changed during remote staging",
            );
          }
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const after = await fileService.stat({ path: artifactRealPath });
        if (
          after.type !== "file" ||
          after.size !== before.size ||
          (before.mtimeMs !== undefined && after.mtimeMs !== before.mtimeMs)
        ) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact changed during remote staging",
          );
        }
        return { bytes, canonicalPath: artifactRealPath };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // 只有明确的“文件不存在/路径不是文件”才允许发现流程降级为 warning。
        // 远端连接断开、权限不足等错误必须继续抛出，避免发布成功却静默丢失结果物。
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
  };
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function createLocalConversationShareArtifactSource(): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }
      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw unreadableArtifactError("Conversation artifact source is not a file", {
              code: "ENOTDIR",
            });
          }
          return {
            canonicalPath: artifactRealPath,
            size: artifactStat.size,
            mtimeMs: artifactStat.mtimeMs,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }

      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        // artifact Row 的 ref 来自会话数据，不能因为当前仅支持本地发布就默认可信；
        // 必须在跟随符号链接后再次验证 workspace 边界，避免分享读取任意本机文件。
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact source is not a file",
            );
          }
          if (artifactStat.size > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
              { diagnostics: { actualBytes: artifactStat.size } },
            );
          }
          // 后端能力上限可能远大于当前文件，按 maxBytes 分配会让小文件也占用大块内存；
          // 只按 stat 大小多读 1 字节，仍能识别 stat/read 间的文件增长。
          const buffer = Buffer.allocUnsafe(artifactStat.size + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
              buffer,
              bytesRead,
              buffer.byteLength - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          if (bytesRead > input.maxBytes) {
            // 读到的字节数只到 stat 大小 + 1，不是真实大小，不作为 actual 上报。
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          return {
            bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
            canonicalPath: artifactRealPath,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // 只有明确的“文件不存在/路径不是文件”才允许发现流程降级为 warning。
        // 权限不足或其它 IO 错误需要阻断发布，不能伪装成可跳过的缺失文件。
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
  };
}
