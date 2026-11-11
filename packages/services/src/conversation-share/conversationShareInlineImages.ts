import { createHash } from "node:crypto";
import type { ConversationShareCapabilities } from "@zcode/shared";
import type { WireConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationShareFailureIssue } from "./conversationShare.js";

/** 内嵌图片转为既有 artifact；预检和发布使用同一份确定性转换，不新增文件读取通道。 */
export function materializeConversationShareInlineImages(
  sourceRows: readonly WireConversationRow[],
  capabilities: ConversationShareCapabilities,
  turnOrdinals: ReadonlyMap<string, number>,
): {
  rows: WireConversationRow[];
  bytesBySourceRef: Map<string, Uint8Array>;
  warnings: ConversationShareFailureIssue[];
  toolImages: Map<number, Array<{ resourceId: string; mimeType: string }>>;
} {
  const rows: WireConversationRow[] = [];
  const toolImages = new Map<number, Array<{ resourceId: string; mimeType: string }>>();
  const bytesBySourceRef = new Map<string, Uint8Array>();
  const warnings: ConversationShareFailureIssue[] = [];
  let nextRowId = sourceRows.reduce((max, row) => Math.max(max, row.rowId), 0);
  for (const row of sourceRows) {
    if (row.kind !== "toolCall") {
      rows.push(row);
      continue;
    }
    const display = row.display?.kind === "node_repl_images" ? row.display : undefined;
    const media = row.output?.display?.kind === "cua" ? row.output.display.media : undefined;
    if (media?.some((item) => item.artifactUri && !item.data)) {
      // 只有资源引用、没有公开可读取字节时保持文本回退，不把本地读取权限带入分享。
      warnings.push({
        code: "content_unavailable",
        scope: "turn",
        rowId: row.rowId,
        productTurnId: row.productTurnId,
      });
    }
    const images = [
      ...(display?.images ?? []),
      ...(media ?? []).flatMap((item) =>
        item.data && item.mimeType.startsWith("image/")
          ? [{ base64: item.data.replace(/^data:[^;]+;base64,/u, ""), mimeType: item.mimeType }]
          : [],
      ),
    ];
    if (display) {
      const { display: _display, ...toolRow } = row;
      rows.push(toolRow);
    } else rows.push(row);
    for (const [index, image] of images.entries()) {
      const mimeType = image.mimeType.toLowerCase();
      const allowed = capabilities.allowed_artifacts.find(
        (candidate) =>
          candidate.type === "image" &&
          candidate.mime_types.some((mime) => mime.toLowerCase() === mimeType),
      );
      const extensions: Record<string, string[]> = {
        "image/png": ["png"],
        "image/jpeg": ["jpg", "jpeg"],
        "image/webp": ["webp"],
        "image/gif": ["gif"],
        "image/svg+xml": ["svg"],
      };
      const extension = allowed?.extensions
        .map((value) => value.replace(/^\./u, "").toLowerCase())
        .find((value) => extensions[mimeType]?.includes(value));
      const displayName = `tool-image-${row.rowId}-${index + 1}.${extension ?? "image"}`;
      const issue = {
        scope: "artifact" as const,
        rowId: row.rowId,
        productTurnId: row.productTurnId,
        turnOrdinal: row.productTurnId ? turnOrdinals.get(row.productTurnId) : undefined,
        artifactDisplayName: displayName,
        artifactType: "image",
        mimeType,
      };
      if (!extension) {
        warnings.push({
          ...issue,
          code: "artifact_type_not_allowed",
          allowedArtifacts: capabilities.allowed_artifacts.map((candidate) => ({
            type: candidate.type,
            extensions: candidate.extensions,
            mimeTypes: candidate.mime_types,
          })),
        });
        continue;
      }
      const bytes = Buffer.from(image.base64, "base64");
      // Buffer.from 对非法 base64 宽松容错，必须复核，避免分享一个已损坏的图片文件。
      if (
        !bytes.length ||
        bytes.toString("base64").replace(/=+$/u, "") !== image.base64.replace(/=+$/u, "")
      ) {
        warnings.push({
          ...issue,
          code: "artifact_read_failed",
          availability: "unknown",
        });
        continue;
      }
      const ref = `inline-tool-image:${row.rowId}:${index}`;
      bytesBySourceRef.set(ref, bytes);
      const references = toolImages.get(row.rowId) ?? [];
      references.push({ resourceId: ref, mimeType });
      toolImages.set(row.rowId, references);
      rows.push({
        kind: "artifact",
        rowId: ++nextRowId,
        turnId: row.turnId,
        productTurnId: row.productTurnId,
        createdAt: row.createdAt,
        createdAtSeq: row.createdAtSeq,
        artifactVersionId: ref,
        logicalArtifactKey: ref,
        displayName,
        artifactType: "image",
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ref,
        state: "current",
      });
    }
  }
  return { rows, bytesBySourceRef, warnings, toolImages };
}
