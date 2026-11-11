// 仅供隔离CLI进程加载：隐藏新能力，严格核验三入口出站字段；不执行合成探针命令。
import { appendFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const config = new URL(import.meta.url).searchParams;
const mode = config.get("mode");
const evidence = config.get("evidence");
if (!evidence || !["legacy", "current"].includes(mode)) throw new Error("Invalid owner fixture");
const capabilities = new Set();
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, callback) {
  let output = chunk;
  try {
    const frame = JSON.parse(String(chunk));
    if (capabilities.has(frame.id) && frame.result) {
      capabilities.delete(frame.id);
      if (mode === "legacy") delete frame.result.highspeedCardOwner;
      output = `${JSON.stringify(frame)}\n`;
    }
  } catch {
    /* 非完整协议帧原样转发，不收集内容。 */
  }
  return write(output, encoding, callback);
};

const emit = process.stdin.emit;
const decoder = new StringDecoder("utf8");
let pending = "";
process.stdin.emit = function (event, ...args) {
  if (event !== "data") return emit.call(this, event, ...args);
  pending += decoder.write(Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0]));
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      emit.call(this, event, Buffer.from(`${line}\n`));
      continue;
    }
    if (frame.method === "runtime/capabilities") capabilities.add(frame.id);
    if (
      frame.method === "v4/command" &&
      frame.params?.commandId?.startsWith("owner-compat-probe-")
    ) {
      const command = frame.params;
      const meta = command.payload?.highspeedMeta;
      const ownerPresent = typeof meta?.ownerKey === "string";
      const allowed = new Set([
        "schemaVersion",
        "cardId",
        "taskId",
        "provider",
        "model",
        "issuedAt",
        "expiresAt",
        "regularTps",
        ...(mode === "current" ? ["ownerKey"] : []),
      ]);
      const strictMetadata = !!meta && Object.keys(meta).every((key) => allowed.has(key));
      const metadataPreserved =
        meta?.schemaVersion === 1 &&
        meta?.cardId === "owner-probe-card" &&
        meta?.taskId === command.sessionId &&
        meta?.provider === "zai" &&
        meta?.model === "GLM-5.3-Flash" &&
        meta?.issuedAt === 1 &&
        meta?.expiresAt === 10000 &&
        meta?.regularTps === 50;
      const selection = command.payload?.modelSelection;
      const payloadPreserved =
        selection?.providerId === "account:bigmodel-individual-coding-plan" &&
        selection?.modelId === "GLM-5.3-Flash" &&
        selection?.options?.reasoningLevel === "high" &&
        Object.keys(selection.options).length === 1 &&
        command.payload?.modelExecution?.selectionScope === "execution" &&
        command.payload?.modelExecution?.requestAuth?.headers?.["X-Highspeed-Card-ID"] ===
          "owner-probe-card";
      const accepted =
        strictMetadata &&
        ownerPresent === (mode === "current") &&
        (mode !== "current" || meta.ownerKey === `v1:${"a".repeat(64)}`) &&
        metadataPreserved &&
        payloadPreserved;
      // 仅记录布尔证据；命令正文、headers和token都不得写入记录。
      void appendFile(
        evidence,
        `${JSON.stringify({ mode, type: command.type, strictMetadata, ownerPresent, metadataPreserved, payloadPreserved, accepted })}\n`,
      ).then(() =>
        write(
          `${JSON.stringify({ id: frame.id, result: { commandId: command.commandId, status: accepted ? "noop" : "rejected", reasonCode: accepted ? "owner_compat_validated" : "owner_metadata_rejected", revisionAtDecision: 0 } })}\n`,
        ),
      );
      continue;
    }
    emit.call(this, event, Buffer.from(`${line}\n`));
  }
  return true;
};
