import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TraceMap, originalPositionFor, type EncodedSourceMap } from "@jridgewell/trace-mapping";

const prefix = "sess_probe_retention_";

interface HeapSnapshot {
  snapshot: {
    meta: {
      location_fields: string[];
      node_fields: string[];
      node_types: (string | string[])[];
      edge_fields: string[];
      edge_types: (string | string[])[];
    };
  };
  locations: number[];
  nodes: number[];
  edges: number[];
  strings: string[];
}

// 依据协议对象形状和测试 session 身份计数，不依赖压缩后的类名、变量名或跨快照 object id。
export async function countRetainedHistory(
  path: string,
  activeSession: string,
  sourceMapPath?: string,
) {
  const heap: HeapSnapshot = JSON.parse(await readFile(path, "utf8"));
  const meta = heap.snapshot.meta;
  const field = (fields: string[], key: string) => {
    const index = fields.indexOf(key);
    assert(index >= 0, `Heap schema missing ${key}`);
    return index;
  };
  const nf = {
    type: field(meta.node_fields, "type"),
    name: field(meta.node_fields, "name"),
    edge_count: field(meta.node_fields, "edge_count"),
  };
  const ef = {
    type: field(meta.edge_fields, "type"),
    name_or_index: field(meta.edge_fields, "name_or_index"),
    to_node: field(meta.edge_fields, "to_node"),
  };
  const nodeTypes = meta.node_types[nf.type] as string[];
  const edgeTypes = meta.edge_types[ef.type] as string[];
  const nw = meta.node_fields.length;
  const ew = meta.edge_fields.length;
  const name = (node: number) => heap.strings[heap.nodes[node + nf.name]!]!;
  const edgeStarts = new Uint32Array(heap.nodes.length / nw + 1);
  let edge = 0;
  let snapshots = 0;
  let inactiveSnapshots = 0;
  let closedStores = 0;
  let liveStores = 0;
  let inactivePrewarmCoordinators = 0;
  const bySession: Record<string, number> = {};
  for (let node = 0; node < heap.nodes.length; node += nw) {
    edgeStarts[node / nw] = edge;
    const end = edge + heap.nodes[node + nf.edge_count]! * ew;
    if (nodeTypes[heap.nodes[node + nf.type]!] === "object") {
      const props: Record<string, number> = {};
      for (let pos = edge; pos < end; pos += ew) {
        if (edgeTypes[heap.edges[pos + ef.type]!] !== "property") continue;
        props[heap.strings[heap.edges[pos + ef.name_or_index]!]!] = heap.edges[pos + ef.to_node]!;
      }
      if (
        props.protocolVersion !== undefined &&
        props.rows !== undefined &&
        props.logEpoch !== undefined &&
        props.sessionId !== undefined &&
        name(props.sessionId).startsWith(prefix)
      ) {
        const session = name(props.sessionId);
        snapshots++;
        bySession[session] = (bySession[session] ?? 0) + 1;
        if (session !== activeSession) inactiveSnapshots++;
      }
      if (
        props.subscribers !== undefined &&
        props.dispatchCommand !== undefined &&
        props.blockedInvalidationVersion !== undefined &&
        props.current !== undefined &&
        props.cleanupTimer !== undefined &&
        props.retryTimer !== undefined &&
        name(props.current) === "null" &&
        name(props.cleanupTimer) === "null" &&
        name(props.retryTimer) === "null"
      ) {
        // 正常在途创建与页面保活都有 current；收口后仍在堆中的空闲 owner 是本次泄漏特征。
        inactivePrewarmCoordinators++;
      }
      if (
        props.topic !== undefined &&
        props.state !== undefined &&
        props.transport !== undefined &&
        props.generation !== undefined &&
        props.closed !== undefined &&
        name(props.topic).includes(`/${prefix}`)
      ) {
        if (name(props.closed) === "true") closedStores++;
        else liveStores++;
      }
    }
    edge = end;
  }
  edgeStarts[heap.nodes.length / nw] = edge;
  const callbacks = sourceMapPath
    ? countCallbacks(heap, edgeStarts, JSON.parse(await readFile(sourceMapPath, "utf8")))
    : null;
  return {
    callbacks,
    snapshots,
    inactiveSnapshots,
    closedStores,
    liveStores,
    inactivePrewarmCoordinators,
    bySession,
  };
}

// 函数由精确构建 sourcemap + SharedFunctionInfo 识别；不比较跨快照 object id 或压缩变量名。
function countCallbacks(heap: HeapSnapshot, edgeStarts: Uint32Array, sourceMap: EncodedSourceMap) {
  const { meta } = heap.snapshot;
  const nw = meta.node_fields.length,
    ew = meta.edge_fields.length;
  const nt = meta.node_fields.indexOf("type"),
    nn = meta.node_fields.indexOf("name");
  const et = meta.edge_fields.indexOf("type"),
    en = meta.edge_fields.indexOf("name_or_index"),
    to = meta.edge_fields.indexOf("to_node");
  const nodeTypes = meta.node_types[nt] as string[],
    edgeTypes = meta.edge_types[et] as string[];
  const type = (node: number) => nodeTypes[heap.nodes[node + nt]!];
  const name = (node: number) => heap.strings[heap.nodes[node + nn]!]!;
  const props = (node: number) => {
    const result: Record<string, number> = {};
    for (let e = edgeStarts[node / nw]!; e < edgeStarts[node / nw + 1]!; e += ew) {
      const key =
        edgeTypes[heap.edges[e + et]!] === "element"
          ? String(heap.edges[e + en])
          : heap.strings[heap.edges[e + en]!]!;
      result[key] = heap.edges[e + to]!;
    }
    return result;
  };
  const focus = new Set<number>(),
    lexicalUpdateListeners: number[] = [];
  for (let node = 0; node < heap.nodes.length; node += nw) {
    if (type(node) === "native" && name(node).includes('data-testid="v4-composer-input"')) {
      const p = props(node),
        key = Object.keys(p).find((key) => key.startsWith("__reactProps"));
      const callback = key ? props(p[key]!).onFocus : undefined;
      if (callback !== undefined) focus.add(callback);
    }
    if (type(node) !== "object") continue;
    const p = props(node);
    if (
      !["_listeners", "_editorState", "_rootElement", "_commands", "_key"].every(
        (key) => p[key] !== undefined,
      )
    )
      continue;
    const update = props(p._listeners!).update;
    assert(update !== undefined, "Lexical update Set 缺失");
    const table = props(update).table;
    assert(table !== undefined, "Lexical update Set table 缺失");
    lexicalUpdateListeners.push(
      new Set(Object.values(props(table)).filter((entry) => type(entry) === "closure")).size,
    );
  }
  assert.equal(focus.size, 1, "必须找到当前真实 Composer onFocus");
  assert(lexicalUpdateListeners.length > 0, "必须找到真实 Lexical editor，不能把未识别当成零残留");
  const fields = meta.location_fields;
  const locations = new Map<number, { line: number; column: number; scriptId: number }>();
  for (let pos = 0; pos < heap.locations.length; pos += fields.length)
    locations.set(heap.locations[pos + fields.indexOf("object_index")]!, {
      line: heap.locations[pos + fields.indexOf("line")]! + 1,
      column: heap.locations[pos + fields.indexOf("column")]!,
      scriptId: heap.locations[pos + fields.indexOf("script_id")]!,
    });
  const scriptId = locations.get([...focus][0]!)?.scriptId;
  assert(scriptId !== undefined, "onFocus 缺少构建位置");
  const map = new TraceMap(sourceMap);
  const families: Record<string, Set<number>> = {
    onFocus: new Set([...focus].map((node) => props(node).shared!)),
    fileLink: new Set(),
    prewarmWaiter: new Set(),
  };
  const lines = (suffix: string) => {
    const index = map.sources.findIndex((source) => source?.endsWith(suffix));
    const content = map.sourcesContent?.[index];
    assert(content, `sourcemap 缺少 ${suffix}`);
    return content.split("\n");
  };
  const fileLinkLine =
    lines("/WorkspaceShellLayout.tsx").findIndex((line) =>
      line.includes("const handleOpenMarkdownFileLink = useCallback("),
    ) + 2;
  const prewarmLines = lines("/useDraftSessionPrewarm.ts");
  const waiterLine =
    prewarmLines.findIndex(
      (line) =>
        line.includes("return async () => {") ||
        line.includes("const waitForSession = useCallback(async () => {"),
    ) + 1;
  assert(fileLinkLine > 1 && waiterLine > 0, "回调源码定位失败");
  for (const [node, location] of locations) {
    if (type(node) !== "closure" || location.scriptId !== scriptId) continue;
    const original = originalPositionFor(map, location);
    if (original.source?.endsWith("/WorkspaceShellLayout.tsx") && original.line === fileLinkLine)
      families.fileLink!.add(props(node).shared!);
    if (original.source?.endsWith("/useDraftSessionPrewarm.ts") && original.line === waiterLine)
      families.prewarmWaiter!.add(props(node).shared!);
  }
  const counts: Record<string, number> = {};
  for (const [key, shared] of Object.entries(families)) {
    assert(shared.size > 0, `${key} 未匹配到真实回调`);
    counts[key] = 0;
    for (let node = 0; node < heap.nodes.length; node += nw)
      if (type(node) === "closure" && shared.has(props(node).shared!)) counts[key]++;
  }
  return {
    onFocus: counts.onFocus!,
    fileLink: counts.fileLink!,
    prewarmWaiter: counts.prewarmWaiter!,
    lexicalUpdateListeners,
  };
}
