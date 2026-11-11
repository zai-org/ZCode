import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
} from "@zcode/contracts/mcp";
import { isOfficialCuaImageRefText } from "@zcode/zcode-cua/frame-contract";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import { matchBrowserScreenshotImageIndices, type NodeReplRunResult } from "@zcode/core/repl";
import type { NodeReplCallFacts } from "./call-ledger/contract.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

type EmbeddedContentBlock = CallToolResult["content"][number];

interface EmbeddedMcpResult {
  content: EmbeddedContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function parseEmbeddedMcpResult(value: string): EmbeddedMcpResult | undefined {
  const trimmed = value.trim();
  const json = trimmed.startsWith("=>") ? trimmed.slice(2).trim() : trimmed;
  if (!json.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (!Array.isArray(candidate.content)) return undefined;
    if (
      candidate.content.some(
        (block) => !block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string",
      )
    ) {
      return undefined;
    }
    return {
      content: candidate.content as EmbeddedContentBlock[],
      ...(typeof candidate.isError === "boolean" ? { isError: candidate.isError } : {}),
      ...(candidate.structuredContent && typeof candidate.structuredContent === "object"
        ? { structuredContent: candidate.structuredContent as Record<string, unknown> }
        : {}),
      ...(candidate._meta && typeof candidate._meta === "object"
        ? { _meta: candidate._meta as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 一个 cell 里多次带截图的观察，只把**最后一张** raster 交给模型。
 *
 * 模型在一个 cell 里调了两次带截图的观察，结果里就有两张图，
 * 被 exact-raster 门按「每个结果只允许一张最终 raster」把整帧原子否决 —— 模型一张都没拿到。
 *
 * 「最新者胜」本来就是 producer 的既定语义：坐标只对最新那张 raster 有效
 * （zcode-cua 的 frame-pixel-latest-only 测试即此契约），旧帧对模型没有使用价值。
 * 所以这里保留最后一对 image/authority、丢掉更早的，与契约一致，不是放宽门禁 ——
 * 真正的两张不同 raster 同时有效仍然不被允许。
 *
 * 只处理 CUA 的「图 + 紧邻权威」原子对；不带权威的图片（如 Browser Use 截图）不受影响。
 */
function keepLatestCuaFrame(blocks: EmbeddedContentBlock[]): EmbeddedContentBlock[] {
  const pairStarts: number[] = [];
  blocks.forEach((block, index) => {
    if (block.type !== "image") return;
    const next = blocks[index + 1];
    if (next?.type === "text" && isOfficialCuaImageRefText(next.text)) pairStarts.push(index);
  });
  if (pairStarts.length <= 1) return blocks;
  const dropped = new Set(pairStarts.slice(0, -1).flatMap((start) => [start, start + 1]));
  return blocks.filter((_, index) => !dropped.has(index));
}

const NO_CALL_FACTS: NodeReplCallFacts = {
  cuaApps: [],
  browserScreenshots: [],
  browserUse: false,
  computerUse: false,
};

/**
 * 组装 MCP 工具结果。run 来自 Worker 的结果消息，cell 能冒充它，所以只当作内容；
 * 可信 key 只取主线程账本记下的 facts（20-node-repl-call-ledger.md「结果组装」）。
 */
export function toMcpRunResult(
  run: NodeReplRunResult,
  facts: NodeReplCallFacts = NO_CALL_FACTS,
): CallToolResult {
  const textParts: string[] = [];
  // SDK 结果通过专用 sink 写入后，不能再从 run.result/console 日志解析第二份副本。
  // 否则模型的 JSON.stringify 会把 image base64 降成普通文本，破坏 image/image_ref 邻接关系。
  const structuredResults = run.structuredResults ?? [];
  const embedded =
    structuredResults.length === 0 && !run.error && run.result !== undefined
      ? parseEmbeddedMcpResult(run.result)
      : undefined;
  const responseMeta = { ...run.responseMeta };
  for (const structured of structuredResults) {
    if (structured._meta) Object.assign(responseMeta, structured._meta);
  }
  if (embedded?._meta) Object.assign(responseMeta, embedded._meta);
  // 该 key 决定 core 是否把原图落盘，不能允许 REPL 代码通过
  // setResponseMeta 伪造来源；只接受按账本里真实截图匹配出的下标（见下）。
  delete responseMeta[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  // 同款处置：producer 的应用元数据决定工具卡显示哪个 App 的名称和图标。它经
  // `projectToHost` -> `nodeRepl.emitStructuredResult` 到达上面的合并循环，而那个 API 挂在模型
  // 可见的 REPL globals 上 —— cell 里自己 emit 一份就能让卡片声称操作了别的应用。因此这里
  // 无条件丢弃，只接受主线程 CUA broker 记进账本的身份。
  // 修复原因（MR !3207 评审 CR-01）：原来取 run.cuaApp、run.browserScreenshotImageIndices，而 run 是
  // Worker 的结果消息，cell 能经 worker_threads 冒充它；这两个字段现在一律忽略。
  delete responseMeta[CUA_APP_ASSOCIATIONS_META_KEY];
  delete responseMeta[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY];
  const cuaApp = facts.cuaApps.at(-1);
  if (cuaApp) responseMeta[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY] = cuaApp;
  // 同款处置：core 据这两个键给会话打 browser_use / computer_use 标签。cell 经可写 meta 通道写的同名键
  // 一律丢弃，只按两个 broker 记进账本的事实写回（session-features-header.md「BUA/CUA 标签的补充规则」）。
  delete responseMeta[ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY];
  delete responseMeta[ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY];
  if (facts.browserUse) responseMeta[ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY] = true;
  if (facts.computerUse) responseMeta[ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY] = true;
  // Anthropic 兼容网关（如 bigmodel MaaS）只解析 tool_result.content 开头的连续
  // image block，一旦先遇到 text 就丢弃后面的图，模型只能看到 image_ref 元数据而看不到画面
  // （实测 [image]/[image,text] 可见，[text,image]/[text,image,text] 不可见）。
  // 把 image 排在 text 之前即可让图稳定到达模型；顺序在 Anthropic 规范里本就是自由的。
  // image 因此从 content[0] 起连续排列，image 下标与 content 下标相等，无需再做 +1 偏移。
  // 按字节把 run.images 对应到账本里代理转发过的真实截图；cell 即使冒充结果放进截图字节，
  // 被标出的也确实是那张截图。
  const browserScreenshotContentIndices = matchBrowserScreenshotImageIndices(
    run.images ?? [],
    facts.browserScreenshots,
  );
  const structuredContent = keepLatestCuaFrame(
    structuredResults.flatMap((structured) => structured.content as EmbeddedContentBlock[]),
  );
  const structuredContentResult = [...structuredResults]
    .reverse()
    .find((structured) => structured.structuredContent !== undefined);
  const structuredIsError = structuredResults.some((structured) => structured.isError === true);
  if (run.error) {
    // node_repl 若用 message-only 隐藏通用 MCP 失败前缀，只消费
    // 模型结果文本的分析链路无法区分成功与失败。继续只返回结构化 error.message，
    // 不混入错误类型、堆栈或失败前日志，并让通用 bridge 根据 isError 投影稳定标记。
    textParts.push(run.error.message);
  } else {
    if (run.logs) textParts.push(run.logs);
    if (structuredResults.length === 0 && run.result !== undefined && !embedded) {
      textParts.push(`=> ${run.result}`);
    }
  }

  const content = [
    ...(run.error
      ? []
      : structuredResults.length > 0
        ? structuredContent
        : (run.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          }))),
    ...(structuredResults.length > 0
      ? // 结构化观察已携带截图；模型再次 emitImage 同一张图时，只保留结构化结果中的副本。
        // 去重必须逐字节相等：保留截图原始像素及其 frame_id 绑定，不同图片仍交由帧校验拒绝。
        (run.images ?? [])
          .filter(
            (image) =>
              !structuredContent.some(
                (block) =>
                  block.type === "image" &&
                  (block as { data?: string }).data === image.base64,
              ),
          )
          .map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          }))
      : []),
    ...(embedded?.content ?? []),
    ...(textParts.length > 0 ? [{ type: "text" as const, text: textParts.join("\n") }] : []),
  ];

  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text: "(no output)" }],
    ...(run.error || embedded?.isError || structuredIsError ? { isError: true } : {}),
    ...(structuredContentResult?.structuredContent !== undefined
      ? { structuredContent: structuredContentResult.structuredContent }
      : embedded?.structuredContent !== undefined
        ? { structuredContent: embedded.structuredContent }
        : {}),
    ...(Object.keys(responseMeta).length > 0 ||
    (run.images?.length ?? 0) > 0 ||
    structuredContent.some((block) => block.type === "image")
      ? {
          _meta: {
            ...responseMeta,
            ...((run.images?.length ?? 0) > 0 || structuredContent.some((block) => block.type === "image")
              ? { "zcode/nodeReplEmittedImage": true }
              : {}),
            ...(browserScreenshotContentIndices && browserScreenshotContentIndices.length > 0
              ? {
                  [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]:
                    browserScreenshotContentIndices,
                }
              : {}),
          },
        }
      : {}),
  };
}
