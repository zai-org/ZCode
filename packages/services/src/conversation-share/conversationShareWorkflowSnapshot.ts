import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import {
  shareWorkflowRunSchema,
  shareWorkflowPayloadSchema,
  shareArtifactSpecSchemas,
  type ShareWorkflowPayload,
  type ShareWorkflowArtifact,
  type ConversationShareCapabilities,
} from "@zcode/shared";
import {
  reduceWorkflowRunsState,
  type WireConversationRow,
  type ArtifactRow,
  type WorkflowRunsState,
  type ToolCallCreateWorkflowCausalityGraph,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { PublishTextConversationInput } from "./conversationShare.js";

export type ShareWorkflowReader = Pick<
  IZCodeAgentService,
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
>;
export interface ShareContentDraft {
  version?: 1 | 2;
  entityId: string;
  productTurnId: string;
  capturedAt: number;
  payload: ShareWorkflowPayload;
}
interface Source {
  row: WireConversationRow;
  runId?: string;
  name: string;
  graph?: ToolCallCreateWorkflowCausalityGraph;
  completion: boolean;
  summary?: string;
  duration?: number;
}
const MAX_EVENTS = 20000;
const PAGE_SIZE = 200;
const CHUNK_SIZE = 512 * 1024;
const WORKFLOW_FALLBACK_PREFIX = "workflow-share-fallback-";

/** 合成摘要只用于展示，不能把产物标题再解释为工作区文件引用。 */
export function isWorkflowShareFallbackRow(row: WireConversationRow): boolean {
  return (
    row.kind === "assistantText" && Boolean(row.entityId?.startsWith(WORKFLOW_FALLBACK_PREFIX))
  );
}

function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => keys.includes(key) && entry !== undefined),
  );
}

/** 发布/预检共用。所有读取在原 workspace/session authority 下进行，不按 sourcePath 猜文件。 */
export async function collectConversationShareWorkflowSnapshot(options: {
  agent: ShareWorkflowReader;
  input: Pick<
    PublishTextConversationInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >;
  rows: WireConversationRow[];
  allRows: readonly WireConversationRow[];
  capabilities: ConversationShareCapabilities;
  capturedAt: number;
  preflight?: boolean;
}): Promise<{
  rows: WireConversationRow[];
  drafts: ShareContentDraft[];
  bytes: Map<string, Uint8Array>;
}> {
  const { agent, input, capabilities } = options;
  const candidates = options.rows.filter(
    (row) =>
      (row.kind === "turnHeader" &&
        (row.workflowLaunch || row.originMeta?.backgroundSource === "workflow")) ||
      (row.kind === "toolCall" &&
        (row.display?.kind === "create_workflow" || row.display?.kind === "resume_workflow_run")),
  );
  if (candidates.length === 0) return { rows: options.rows, drafts: [], bytes: new Map() };
  // 目录仅辅助 Create 行关联；通知/启动/Resume 的明确 runId 不受最近目录窗口限制。
  const directory = await Promise.resolve()
    .then(() => agent.conversationWorkflowRunsV4({ ...input, limit: 64 }))
    .catch(() => ({ runs: [] }));
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    let source: Source | undefined;
    if (row.kind === "turnHeader") {
      const launch = row.workflowLaunch;
      const meta = row.originMeta;
      const notification = meta?.workflowNotification;
      source = {
        row,
        runId: launch?.runId ?? meta?.workId,
        name: launch?.name ?? meta?.title ?? "Workflow",
        completion: notification?.kind === "terminal" && notification.status === "completed",
        ...(notification?.kind === "terminal"
          ? { summary: (notification.error ?? notification.summary).slice(0, 2048) }
          : {}),
        ...(launch?.display?.causalityGraph ? { graph: launch.display.causalityGraph } : {}),
        ...(notification?.kind === "terminal" && notification.durationMs !== undefined
          ? { duration: Math.floor(notification.durationMs) }
          : {}),
      };
    } else if (row.kind === "toolCall") {
      const entry = directory.runs.find((run) => run.toolCallId === row.toolCallId);
      // 编译失败且未产生 run 时只有工具诊断，不能凭空补一张 unavailable 运行卡。
      if (!entry && row.display?.kind === "create_workflow" && !row.display.ok) continue;
      const name =
        typeof row.input === "object" &&
        row.input &&
        "name" in row.input &&
        typeof row.input.name === "string"
          ? row.input.name
          : (entry?.label ?? "Workflow");
      source = {
        row,
        name,
        completion: false,
        runId: row.display?.kind === "resume_workflow_run" ? row.display.runId : entry?.runId,
        ...(row.display?.kind === "create_workflow" && row.display.causalityGraph
          ? { graph: row.display.causalityGraph }
          : {}),
      };
    }
    if (!source || !row.productTurnId) continue;
    const key = `${row.productTurnId}:${source.runId ?? row.rowId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = directory.runs.find((run) => run.runId === source.runId);
    const origin = options.allRows.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === entry?.toolCallId,
    );
    if (!source.graph && origin?.kind === "toolCall" && origin.display?.kind === "create_workflow")
      source.graph = origin.display.causalityGraph;
    sources.push(source);
  }
  const bytes = new Map<string, Uint8Array>();
  const artifactRows: ArtifactRow[] = [];
  const drafts: ShareContentDraft[] = [];
  const tails = new Map<string, WireConversationRow[]>();
  const cache = new Map<string, ShareWorkflowPayload>();
  let nextRow = Math.max(0, ...options.rows.map((row) => row.rowId));
  let resourceCounter = 0;
  let totalResourceBytes = 0;

  for (const source of sources) {
    const producer = source.row;
    const productTurnId = producer.productTurnId!;
    let payload: ShareWorkflowPayload = {
      name: source.name.slice(0, 512) || "Workflow",
      completion: source.completion,
      ...(source.summary ? { summary: source.summary } : {}),
      artifacts: [],
      ...(source.graph ? { graph: source.graph } : {}),
      ...(source.duration === undefined ? {} : { duration_ms: source.duration }),
    };
    try {
      if (!source.runId) throw new Error("Missing workflow identity");
      const cached = cache.get(source.runId);
      if (cached)
        payload = {
          ...cached,
          completion: source.completion,
          name: payload.name,
          ...(source.summary ? { summary: source.summary } : {}),
          ...(source.graph ? { graph: source.graph } : {}),
          ...(source.duration === undefined ? {} : { duration_ms: source.duration }),
        };
      else {
        // RPC 受条数和字节双重分页限制；读到末页后才得到可重放的完整前缀。
        let state: WorkflowRunsState | undefined;
        let sequence = -1;
        let eventCount = 0;
        for (;;) {
          const page = await agent.conversationWorkflowRunEventsV4({
            ...input,
            runId: source.runId,
            ...(sequence < 0 ? {} : { afterSequence: sequence }),
          });
          eventCount += page.events.length;
          if (
            eventCount > MAX_EVENTS ||
            (!page.events.length && (page.hasMore || eventCount === 0))
          )
            throw new Error("Incomplete workflow snapshot");
          for (const event of page.events) {
            if (event.sequence <= sequence) throw new Error("Unordered workflow journal");
            sequence = event.sequence;
            state =
              reduceWorkflowRunsState(state, {
                runId: source.runId,
                eventType: event.type,
                sequence: event.sequence,
                payload: event.payload,
              }) ?? state;
          }
          if (!page.hasMore) break;
        }
        const run = state?.runs[0];
        if (!run) throw new Error("Missing workflow state");
        if (!payload.summary && run.error) payload.summary = run.error.slice(0, 2048);
        payload.run = shareWorkflowRunSchema.parse({
          ...pick(run, Object.keys(shareWorkflowRunSchema.shape)),
          actors: run.actors.map((actor) =>
            pick(actor, Object.keys(shareWorkflowRunSchema.shape.actors.element.shape)),
          ),
          nodes: run.nodes.map((node) =>
            pick(node, Object.keys(shareWorkflowRunSchema.shape.nodes.element.shape)),
          ),
        });
        const metadata = await agent.conversationWorkflowRunArtifactsV4({
          ...input,
          runId: source.runId,
        });
        for (const summary of run.artifacts ?? []) {
          const record = metadata.artifacts.find((artifact) => artifact.id === summary.id);
          const version = record?.versions.find(
            (candidate) => candidate.version === summary.version,
          );
          const base = {
            id: summary.id,
            kind: summary.kind,
            title: version?.title ?? summary.title ?? summary.id,
            version: summary.version,
            ...(summary.primary ? { primary: true as const } : {}),
            ...(version?.description ? { description: version.description } : {}),
          };
          let artifact: ShareWorkflowArtifact;
          let resource: { id: string; data: Uint8Array; row: ArtifactRow } | undefined;
          try {
            if (!version) throw new Error("Missing artifact version");
            if (base.kind === "file" || base.kind === "markdown") {
              const mime =
                version.contentType ??
                (base.kind === "markdown" ? "text/markdown" : "application/octet-stream");
              const extension =
                extname(version.sourcePath ?? "").slice(1) ||
                (base.kind === "markdown" ? "md" : "");
              const allowed = capabilities.allowed_artifacts.find(
                (entry) =>
                  entry.mime_types.includes(mime) &&
                  entry.extensions.some((ext) => ext.replace(/^\./u, "") === extension),
              );
              if (!allowed) {
                payload.artifacts.push({ ...base, kind: base.kind, unavailable: "unsupported" });
                continue;
              }
              const remainingBytes = capabilities.max_total_artifact_bytes - totalResourceBytes;
              if (
                resourceCounter >= capabilities.max_artifact_count ||
                remainingBytes <= 0 ||
                (version.bytes ?? 0) > Math.min(capabilities.max_artifact_bytes, remainingBytes)
              ) {
                payload.artifacts.push({ ...base, kind: base.kind, unavailable: "limit_exceeded" });
                continue;
              }
              // 预检只检查元数据预算；文件物化与完整性校验留到发布，避免远程重复传输。
              if (options.preflight) {
                const declaredBytes = version.bytes ?? 0;
                payload.artifacts.push({
                  ...base,
                  kind: base.kind,
                  bytes: declaredBytes,
                  content_type: mime,
                });
                totalResourceBytes += declaredBytes;
                resourceCounter += 1;
                continue;
              }
              const chunks: Uint8Array[] = [];
              let offset = 0;
              for (;;) {
                const part = await agent.conversationWorkflowRunArtifactReadV4({
                  ...input,
                  runId: source.runId,
                  artifactId: summary.id,
                  version: summary.version,
                  offset,
                  limit: CHUNK_SIZE,
                });
                const data = Buffer.from(part.dataBase64, "base64");
                if (part.totalBytes > Math.min(capabilities.max_artifact_bytes, remainingBytes))
                  throw new RangeError("Artifact size limit");
                if (offset + data.length > part.totalBytes || !data.length)
                  throw new Error("Invalid artifact bytes");
                chunks.push(data);
                offset += data.length;
                if (part.nextOffset === null) {
                  if (offset !== part.totalBytes) throw new Error("Incomplete artifact bytes");
                  break;
                }
                if (part.nextOffset !== offset) throw new Error("Invalid artifact cursor");
              }
              const data = Buffer.concat(chunks);
              const resourceId = `workflow-resource-${resourceCounter + 1}`;
              // 标题中的版本号不是文件类型；仅已有正确后缀时不再重复追加。
              const title = basename(base.title).replace(/[\\/]/gu, "_") || "artifact";
              const name = title.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
                ? title
                : `${title}.${extension}`;
              const row: ArtifactRow = {
                rowId: nextRow + 1,
                turnId: producer.turnId,
                productTurnId,
                createdAt: options.capturedAt,
                createdAtSeq: nextRow + 1,
                kind: "artifact",
                artifactVersionId: resourceId,
                logicalArtifactKey: resourceId,
                displayName: name,
                artifactType: allowed.type,
                mimeType: mime,
                sizeBytes: data.length,
                sha256: createHash("sha256").update(data).digest("hex"),
                ref: resourceId,
                state: "current",
              };
              resource = { id: resourceId, data, row };
              artifact = {
                ...base,
                kind: base.kind,
                resource_id: resourceId,
                content_type: mime,
                ...((capabilities.content_block_versions?.workflow ?? 0) >= 2 &&
                (mime === "text/markdown" || mime === "text/plain") &&
                data.length <= 65536
                  ? {
                      preview_text: new TextDecoder("utf-8", {
                        fatal: true,
                        ignoreBOM: true,
                      }).decode(data),
                    }
                  : {}),
                bytes: data.length,
              };
            } else {
              const kind = base.kind;
              const spec = shareArtifactSpecSchemas[kind].parse(version.spec);
              const items = [];
              let afterSequence: number | undefined;
              for (;;) {
                const page = await agent.conversationWorkflowRunArtifactDataV4({
                  ...input,
                  runId: source.runId,
                  artifactId: summary.id,
                  limit: PAGE_SIZE,
                  ...(afterSequence === undefined ? {} : { afterSequence }),
                });
                for (const entry of page.items) {
                  if (entry.sequence <= (afterSequence ?? -1))
                    throw new Error("Invalid artifact item cursor");
                  afterSequence = entry.sequence;
                  if (entry.sequence <= sequence) items.push(entry);
                }
                if (items.length > 256) throw new Error("Artifact item limit");
                if (!page.hasMore || (afterSequence ?? -1) >= sequence) break;
                if (!page.items.length) throw new Error("Incomplete artifact items");
              }
              artifact = { ...base, kind, spec, items };
            }
            // 单个产物的坏 spec/条目只降级自己，不抹掉已经成功采集的其它内容。
            const checked = shareWorkflowPayloadSchema.shape.artifacts.element.parse(artifact);
            // 解码或 schema 校验失败时不能残留附件、字节或预算；通过后一次登记。
            if (resource) {
              bytes.set(resource.id, resource.data);
              artifactRows.push(resource.row);
              totalResourceBytes += resource.data.length;
              resourceCounter += 1;
              nextRow += 1;
            }
            payload.artifacts.push(checked);
          } catch (error) {
            payload.artifacts.push({
              ...base,
              kind: base.kind,
              unavailable: error instanceof RangeError ? "limit_exceeded" : "source_unavailable",
            });
          }
        }
        cache.set(source.runId, payload);
      }
    } catch {
      payload.unavailable = "source_unavailable";
    }
    const entityId = `${WORKFLOW_FALLBACK_PREFIX}${drafts.length + 1}`;
    const status = payload.run?.status ?? "unavailable";
    const summary = [
      payload.name,
      `Workflow · ${status}`,
      ...(payload.summary ? [payload.summary] : []),
      ...(payload.run?.phases?.map((phase) => phase.name) ?? []),
      ...(payload.run?.actors.map((actor) => actor.name ?? actor.siteId) ?? []),
      ...payload.artifacts.map(
        (artifact) => `${artifact.title}${artifact.unavailable ? " (未包含 / not included)" : ""}`,
      ),
      ...(payload.unavailable ? ["Workflow snapshot unavailable / 工作流快照不可用"] : []),
    ].join("\n\n");
    const tail = tails.get(productTurnId) ?? [];
    tail.push({
      rowId: ++nextRow,
      entityId,
      turnId: producer.turnId,
      productTurnId,
      createdAt: options.capturedAt,
      createdAtSeq: nextRow,
      kind: "assistantText",
      state: "complete",
      text: summary,
    });
    tails.set(productTurnId, tail);
    drafts.push({
      version: (capabilities.content_block_versions?.workflow ?? 0) >= 2 ? 2 : 1,
      entityId,
      productTurnId,
      capturedAt: options.capturedAt,
      payload,
    });
  }
  const rows: WireConversationRow[] = [];
  for (const [index, row] of options.rows.entries()) {
    if (!(row.kind === "userInput" && row.origin === "workflowLaunch")) rows.push(row);
    if (row.productTurnId !== options.rows[index + 1]?.productTurnId && row.productTurnId)
      rows.push(
        ...(tails.get(row.productTurnId) ?? []),
        ...artifactRows.filter((artifact) => artifact.productTurnId === row.productTurnId),
      );
  }
  return { rows, drafts, bytes };
}
