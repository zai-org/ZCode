// ============================================================
// 用户面产物（artifact）的协议词汇表
// ============================================================
// ⚠ 术语：
// 本模块的 artifact 是**脚本经 `artifact.*` 发布给用户看的产出**——一个文件、一段 markdown、
// 或一张由 `report` 流喂养的预置看板。它与同目录 `workflow-artifact.ts`（单数）里的
// `serializeWorkflowArtifact` **不是一回事**：那个 artifact 是引擎内部对「脚本顶层返回值」
// 的叫法（`RunSettlement.artifact`），是给**模型**看的。两个文件名只差一个 s，读代码时按
// 这条注释区分，不要靠文件名。
//
// 本模块只放 schema + 三条 v4 查询的参数/结果形状。状态键上的**摘要**元素
// （`workflowRuns[].artifacts`）也住这里而不是 workflow-runs.ts：它与三条查询共享
// `kind` 的枚举与「不带 spec、不带字节、不带 items」这条裁剪规则，拆开两处早晚漂移。
//
// 分层：字节永不进任何一个 schema（除 `workflowRunArtifactRead` 一次一块的 base64）。
// 权威在 journal——`workflowRuns.artifacts` 只是「有没有变」的信号。

import { z } from "zod";

import { PROTOCOL_V4_LIMITS, v4ColdResumeWorkspaceSchema } from "./core.js";

/**
 * 用户面产物的成员种类，= facade `artifact.*` 的六个成员。
 *
 * 两族：内容成员（`file` / `markdown`）有字节与版本历史；预置看板
 * （`chart` / `table` / `metrics` / `board`）没有字节，它的每一个点都是一条打了标签的
 * `report` journal 行（看板是 journal 的投影）。
 *
 * 闭集枚举。加值是**破坏性**的偏斜（旧读端整帧拒收），与 `workflowRuns[].status` 同一档。
 */
export const workflowRunArtifactKindSchema = z.enum([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);
export type WorkflowRunArtifactKind = z.infer<typeof workflowRunArtifactKindSchema>;

/** 产物字段的展示上界。数字即契约——engine 侧的同名上限在 `ARTIFACT_CAPS`。 */
export const WORKFLOW_ARTIFACT_LIMITS = {
  maxIdLength: 64,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  /** 每 id ≤ 16 版（`ARTIFACT_CAPS.maxVersionsPerArtifact`）。 */
  maxVersions: 16,
  /** `workflowRunArtifactData` 一页的条目上界；`limit` 的钳制在网关侧。 */
  maxItemsPerPage: 500,
  /** 一页的缺省条数（调用方不传 limit 时网关用它）。 */
  defaultItemsPerPage: 200,
  /**
   * `workflowRunArtifactData` 一页的字节上界（按存储里的序列化字节计），由网关传给存储层。
   * 取协议单帧上限（16 MiB）的四分之一：条数上界单独管不住字节——500 条 × 32 KiB 就顶到了
   * 单帧上限，于是一页可能根本发不出去。一页至少带一条，所以单条的上限（`REPORT_CAPS`）
   * 必须远小于单帧上限。
   */
  maxPageBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes / 4,
  /** `workflowRunArtifactData` 一次最多点名几个字段路径（一张看板的 spec 用不到这么多）。 */
  maxFieldsPerRequest: 32,
  /** 一个字段路径的最大长度。 */
  maxFieldPathLength: 256,
  /**
   * 一个字段值的序列化字节上界。超过的值回成一段截短的字符串（前 1,000 个字符加「…」）：
   * 图表只用数值，表格与看板的格子本来就只显示短文本。
   */
  maxFieldValueBytes: 4096,
} as const;

/**
 * 按点路径从一条 report item 里取值："timing.after"、"rounds.0.ms"（docs/execution-engine.md
 * 「Reading the journal」）。
 *
 * 这是**协议上的契约**，不只是渲染器的工具函数：看板取数时 CLI 在 SQLite 里按同一套规则把
 * 字段取出来（adapters 的 dwf-journal-fields.ts），渲染器拿到的值必须与它自己从整条 item 里
 * 取出来的逐字相同。规则：按 `.` 切段；当前值是数组时，段按 `Number(段)` 当下标（非负整数且
 * 在界内才算）；是对象时按键取；走不通（null、标量、越界、缺键）得 `undefined`。
 */
export function readWorkflowArtifactField(item: unknown, path: string): unknown {
  let cursor: unknown = item;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * 一个产物版本的**元数据**（journal `dwf_node.result_json` 上 `ArtifactVersionRecord` 的
 * zod 镜像）。字节不在这里——`uri` 指向 tool-artifact store，取字节走
 * `workflowRunArtifactRead`。
 *
 * `publishedAt` **必填**：driver 在每条记录上恒写 `Date.now()`（引擎
 * 自己没有时钟，所以纯包侧的 TS 类型仍是 optional）。这里必填是让「版本没有时刻」在协议
 * 边界上就红掉，而不是让 UI 的版本步进器拿到一个 undefined 去排序。
 */
export const workflowRunArtifactVersionSchema = z
  .object({
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    /** 该版本在 store 里的字节数（内容成员才有）。 */
    bytes: z.number().int().nonnegative().optional(),
    /** store 的 `zcode-artifact://…`；**只给 CLI 侧用**，模型与 renderer 都读不了它。 */
    uri: z.string().min(1).max(512).optional(),
    /** 工作区相对的原路径（`file` 才有）——卡片的「在工作区显示」按它定位。 */
    sourcePath: z.string().min(1).max(1024).optional(),
    /** 预置看板的 spec（canonical）。形状由 UI 的四个渲染器各自解释，协议不复述。 */
    spec: z.unknown().optional(),
    /** 发布时刻（epoch 毫秒）。 */
    publishedAt: z.number().int().nonnegative(),
    /** 这一版属于 run 的交付物；引擎盖章，按 id 粘着。 */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;

/**
 * 一个产物的**全部**版本 + 喂给它的标签 report 计数。`workflowRunArtifacts` 查询的元素，
 * 也是冷恢复与中枢详情的 durable 读法。
 *
 * 顶层的 `title` / `description` / `contentType` / `sourcePath` / `spec` 取**最新版**的值：
 * 只关心「现在是什么」的读者不必自己翻 `versions`。与 contracts 的
 * `DynamicWorkflowRunArtifact` 同形（那边是 TS 镜像，这边是线上校验）。
 */
export const workflowRunArtifactSchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    sourcePath: z.string().min(1).max(1024).optional(),
    spec: z.unknown().optional(),
    /** 最新版号（= `versions` 末项的 version）。 */
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** 版本升序。失败的发布**不在**这里：失败行不认领 id / 种类 / 版本。 */
    versions: z.array(workflowRunArtifactVersionSchema).max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。 */
    itemCount: z.number().int().nonnegative(),
    /** run 的交付物（至多一件）；清单以它带头。 */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;

/**
 * `workflowRuns[].artifacts` 的元素：**只带最新版的元数据**。
 *
 * 刻意不带 `versions` / `spec` / `sourcePath` / `uri`，更不带字节或条目：这是一个高频状态键，
 * 而它的读者只需要知道「有哪些产物、现在是第几版、变了没有」。真要看内容，两条 query
 * （`workflowRunArtifacts` 取全量元数据、`workflowRunArtifactData` 取看板条目、
 * `workflowRunArtifactRead` 取字节）按需拉——权威始终在 journal。
 *
 * `itemCount` 在这里的职责是**刷新信号**：看板 hook 见它变化就带 `afterSequence` 增量取数。
 * 把标签 report 的原值放进这个高频状态键，一个 run 的条目有多少字节，每一帧就要搬多少字节。
 */
export const workflowRunArtifactSummarySchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    contentType: z.string().min(1).max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    /** run 的交付物（至多一件）。UI 据它排先后与选形态；缺席即不是。 */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;

// ── v4 query ①：workflowRunArtifacts（产物清单）──
// 与 workflowRunEvents 同族：只读、无状态、超时重发安全，刻意不是 v4 command。
// 同样**不带** atSeq / atLogEpoch：读的是 journal，与 conversation log 无关，没有陈旧可防
// （完整论证见 transport.ts 里 workflowRunEvents 结果 schema 之后那段注释）。
// 新方法天然偏斜安全——旧桌面根本不会调用它。
export const v4ConversationWorkflowRunArtifactsParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactsParamsSchema
>;

export const v4ConversationWorkflowRunArtifactsResultSchema = z
  .object({
    /** 按首次出现顺序（= journal 里该 id 第一条 artifact 行的 ordinal）。 */
    artifacts: z.array(workflowRunArtifactSchema),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactsResultSchema
>;

// ── v4 query ②：workflowRunArtifactData（预置看板的取数面）──
// 刻意**不复用** workflowRunEvents：那要翻整条 journal 才筛得出一个 id 的条目。
// cursor = journal sequence（与事件日志同一个游标语义，`afterSequence` 严格大于）。
export const v4ConversationWorkflowRunArtifactDataParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    /** 只取 sequence 严格大于该值的条目；缺省从头取。 */
    afterSequence: z.number().int().nonnegative().optional(),
    /** 缺省 200、钳 [1, 500]——两者都在网关侧执行（存储层不得自造页大小，也不得再钳）。 */
    limit: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).optional(),
    /**
     * 只取这些字段路径（{@link readWorkflowArtifactField} 的规则），而不是整条 item：看板只读
     * spec 里点名的字段，一条 1 MiB 的 item 不该为了一个数被整条搬进渲染器。给了它，结果每条
     * 带 `fields` 而不带 `item`。缺省 = 整条 item（老渲染器的形状）。
     *
     * 偏斜：老 CLI 的 strict schema 不认这个键、整条请求被拒；渲染器据此退回不带它重试。
     */
    fields: z
      .array(z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxFieldPathLength))
      .min(1)
      .max(WORKFLOW_ARTIFACT_LIMITS.maxFieldsPerRequest)
      .optional(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataParamsSchema
>;

export const v4ConversationWorkflowRunArtifactDataResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          /** journal sequence——回传成 `afterSequence` 就是下一页的游标。 */
          sequence: z.number().int().nonnegative(),
          /** 产出该条目的 report 站点（如 `report#1`）。 */
          siteId: z.string().min(1).max(64),
          ordinal: z.number().int().nonnegative(),
          /**
           * 条目原值，**不做预览序列化**：看板的纯函数要按字段路径取数
           * （`ChartSpec.x.field` 形如 "timing.after"），拿到一段 pretty JSON 文本就没法取了。
           * 单条由写入侧的 `REPORT_CAPS.maxItemSerializedBytes` 有界，一页由
           * `WORKFLOW_ARTIFACT_LIMITS.maxPageBytes` 有界。请求带 `fields` 时缺席。
           */
          item: z.unknown(),
          /**
           * 请求带 `fields` 时：路径 → 值。走不通的路径不在表里（= `undefined`）；超过
           * `maxFieldValueBytes` 的值是一段截短的字符串。
           */
          fields: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
    /** 本页之后仍有条目（页可能因条数或字节上界提前收尾；由存储层判定）。 */
    hasMore: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataResultSchema
>;

// ── v4 query ③：workflowRunArtifactRead（内容产物的字节）──
// **逐字照 `v4AttachmentRead*`**：≤ 512 KiB 一块（PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes，
// 同一个常量，不另铸），host→CLI 每请求 ≤ 1 MiB 的既有证明因此原样沿用。
//
// 刻意不复用 attachmentRead 本身：它按 conversation 的 user row 授权，而产物不挂在任何消息
// 行上。授权链在 CLI 侧：sessionId 必须是该 run 的 parentSessionId ∧
// (artifactId, version) 在 journal 有 completed 行 ⇒ 才拿行上的 uri 去 store 读。
// renderer 传来的任何 id **绝不**直接成为路径——与 attachmentRead 同一条纪律。
export const v4ConversationWorkflowRunArtifactReadParamsSchema = z
  .object({
    workspace: v4ColdResumeWorkspaceSchema,
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactReadParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadParamsSchema
>;

export const v4ConversationWorkflowRunArtifactReadResultSchema = z
  .object({
    /** base64（不带 data: 前缀）；解码后 ≤ attachmentChunkMaxBytes。 */
    dataBase64: z.string(),
    /**
     * 该版本的 contentType，取 journal 记录上的值（driver 按扩展名表算出、`opts.contentType`
     * 可覆盖）——那是 UI 分派渲染器的**精确匹配**契约。刻意不像 attachmentRead 那样把
     * mediaType 限死在 image/video/pdf：产物的合法类型就是 driver 那张 17 项扩展名表加
     * `application/octet-stream`，限死会让 markdown 与 office 文件整条读不出来。
     */
    mediaType: z.string().min(1).max(128),
    /** 该版本的总字节数（≤ ARTIFACT_CAPS.maxFileBytes = attachmentMaxBytes）。 */
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    /** 下一块的 offset；本块读到尾时为 null。 */
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "workflow artifact read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationWorkflowRunArtifactReadResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadResultSchema
>;

/**
 * base64 字符串的解码字节数，非法输入回 null。
 *
 * 与 transport.ts 里同名的私有 helper 逐字相同，而不是把那个导出过来：那个文件不导出它，
 * 而 import 它会成环——transport.ts → snapshot.ts → workflow-runs.ts → 本模块。十行纯算术
 * 复制一份，比为它开一个新的公共模块便宜——两处若漂移，双方的 superRefine 测试都会红。
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
