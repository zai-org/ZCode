import type { TraceContext } from "../tracing/tracer.js";

export interface ImageResizeRequest {
  data: Uint8Array;
  mediaType: string;
  maxDimension: number;
  trace?: TraceContext;
}

export interface ImageResizeResult {
  data: Uint8Array;
  mediaType: string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  resized: boolean;
}

export type ImageProcessorErrorCode =
  | "empty"
  | "invalid_request"
  | "processing_failed"
  | "too_large"
  | "unsupported";

export interface ImageProcessorErrorDetails {
  code: ImageProcessorErrorCode;
  message: string;
  cause?: unknown;
}

export class ImageProcessorPortError extends Error {
  readonly code: ImageProcessorErrorCode;
  override readonly cause?: unknown;

  constructor(details: ImageProcessorErrorDetails) {
    super(details.message);
    this.name = "ImageProcessorPortError";
    this.code = details.code;
    this.cause = details.cause;
  }
}

export function createImageProcessorError(
  details: ImageProcessorErrorDetails,
): ImageProcessorPortError {
  return new ImageProcessorPortError(details);
}

export function isImageProcessorPortError(error: unknown): error is ImageProcessorPortError {
  return error instanceof ImageProcessorPortError;
}

export type ImageCompressionStrategy =
  | "original"
  | "preserve-format"
  | "png-optimized"
  | "png-quantized"
  | "resized"
  | "jpeg-quality"
  | "jpeg-fallback";

export interface ImagePrepareForModelRequest extends ImageResizeRequest {
  maxBase64Bytes: number;
  maxRawBytes: number;
  maxTokens?: number;
  tokenToBase64CharRatio?: number;
}

export interface ImagePrepareForModelResult extends ImageResizeResult {
  compressed: boolean;
  originalSizeBytes: number;
  strategy: ImageCompressionStrategy;
  transformedSizeBytes: number;
}

export interface ImageProcessorPort {
  /**
   * 把图片缩放到最长边不超过 `maxDimension`；只限制尺寸，不限制字节数。
   * 调用方（例如 Bash 图片输出）依赖两条行为：解码失败时必须抛错，不能返回原始 bytes；
   * `image/webp` 原样透传、不解码，所以 WebP 是否完整要由调用方自己检查。
   */
  resizeToFit(
    request: ImageResizeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImageResizeResult>;
  prepareForModel(
    request: ImagePrepareForModelRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImagePrepareForModelResult>;
}
