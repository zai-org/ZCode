/**
 * Computer Use SDK —— 模型可见的 `cua` 对象面（只含 computer 部分，不含 browser）。
 *
 * 设计文档：zcode-cua/docs/refactor-port-specs/2026-09-10-cua-sdk-v3-api.md
 *
 * 三条原则（文档 §1）：
 *   R1 同名同签 —— 公开方法的名字、位置参数顺序、选项键名、返回类型保持冻结。
 *   R2 公开面之外的能力先问能不能删；留下的只能出现在可选选项键、尾部可选参数，
 *      或 `cua.computer` 逃逸口里。`Target` 上的附加成员数必须为 0。
 *   R3 安全语义只藏不删 —— state_id 强校验、frame 精确栅格、possibly_sent 防重放、
 *      controller lease、kill switch 全部保留，改为内部字段或类型化错误。
 *
 * 两处刻意的语义选择（文档 §5）：
 *   1. node_repl 的 Worker 每次 `js` 调用都是全新的，`const app` 活不到下一个 cell。
 *      stateId / frameId / diff 基线由 shared host 的 runtime session 持有，所以下一个
 *      cell 里 `getApp` 是重新绑定而非重新观察。
 *   2. 动作失败抛 ComputerUseError 并带 actionSent —— 不能把动作做成单纯的 Promise<void>，
 *      那样会丢掉「可能已下发」的信息；这条语义是事故驱动的，必须保留。
 *
 * 不融合 Browser Use：这里不存在 browsers / getBrowser / createBrowserTab / getTab；
 * `State` 没有 `browsers` 键；`Target` 只被 App 实现，不与 browser 的 Tab 共享类型。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");

/** 存活的工具面（= `cua.computer`）。协议层的事实来源在 zcode-cua/src/tools/manifest.ts。 */
const COMPUTER_METHOD_NAMES = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
]);

/**
 * 平台面收缩：某些工具在某些平台上**不存在**。事实来源同为 zcode-cua/src/tools/manifest.ts
 * 的 TOOL_PLATFORM_EXCLUSIONS —— 那边不注册 handler，这边不挂到 `cua.computer` 上，
 * 两侧必须一致，否则模型看得见一个调用即报错的方法，又会去猜替代写法。
 *
 * 2026-09-16：`open_application` 已在 producer 侧**整体删除**（不再只是 darwin 排除）——
 * 启动与激活并入 get_app_state 的透明拉起（见 zcode-cua/src/tools/manifest.ts 的说明），
 * 模型面不再有单独的启动/激活原语。于是这张表暂时为空：
 * 留着它是因为「按平台收缩」这个机制本身还需要，下一个平台专属工具直接往里加。
 */
const PLATFORM_EXCLUDED_METHODS = Object.freeze({});

/** 会改变 UI 的方法。成功即 void，失败抛错；这一集合决定 possibly_sent 的判定路径。 */
const MUTATING_METHODS = new Set([
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "stop_computer_control",
]);

// ─────────────────────────────────────────────────────────── 错误

/** broker 错误码 → SDK 错误码。未知码归 INTERNAL，绝不静默成功。 */
const ERROR_CODE_BY_BROKER = Object.freeze({
  permission_denied: "PERMISSION_DENIED",
  not_authorized: "NOT_AUTHORIZED",
  launch_failed: "LAUNCH_FAILED",
  invalid_request: "INVALID_APP",
  element_unavailable: "ELEMENT_UNAVAILABLE",
  not_settable: "NOT_SETTABLE",
  not_selectable: "NOT_SELECTABLE",
  action_unavailable: "ACTION_UNAVAILABLE",
  foreground_required: "FOREGROUND_REQUIRED",
  controller_busy: "CONTROLLER_BUSY",
  broker_unavailable: "HELPER_UNAVAILABLE",
  version_mismatch: "VERSION_MISMATCH",
  stale_socket: "HELPER_UNAVAILABLE",
  timeout: "TIMEOUT",
  unimplemented: "ACTION_UNAVAILABLE",
  method_not_found: "INTERNAL",
  internal: "INTERNAL",
});

/** 只有这些码在重试同一个动作之前必须先重新观察。 */
const REOBSERVE_CODES = new Set([
  "ELEMENT_UNAVAILABLE",
  "STALE_STATE",
  "STRUCTURED_STATE_UNAVAILABLE",
]);
const NEVER_RETRY_CODES = new Set([
  "CONTROLLER_BUSY",
  "CONTROL_STOPPED",
  "PERMISSION_DENIED",
  "NOT_AUTHORIZED",
  "VERSION_MISMATCH",
  "ACTION_UNAVAILABLE",
  "NOT_SETTABLE",
  "NOT_SELECTABLE",
]);

class ComputerUseError extends Error {
  constructor(message, { code, actionSent, dispatchStatus, details } = {}) {
    super(message);
    this.name = "ComputerUseError";
    this.code = code ?? "INTERNAL";
    // 默认 false 是**故意**的保守方向：只有在收据明确说下发过时才置 true。
    // 反过来（默认 true）会让模型对一个从未下发的动作放弃重试。
    this.actionSent = actionSent === true;
    if (dispatchStatus) this.dispatchStatus = dispatchStatus;
    this.details = Object.freeze({ ...(details ?? {}) });
    this.retry = this.actionSent
      ? "reobserve"
      : NEVER_RETRY_CODES.has(this.code)
        ? "never"
        : REOBSERVE_CODES.has(this.code)
          ? "reobserve"
          : "retry";
  }
}

function parseJsonRecord(text) {
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同上，但不排除数组。
 *
 * Bug 原因（2026-09-11 真机）：list_apps 的 envelope 是一个**裸 JSON 数组**，而
 * inventory() 用 parseJsonRecord 去解析它 —— 那个函数对数组显式返回 undefined，
 * 于是紧随其后的 `else if (Array.isArray(parsed))` 是永远进不去的死分支，
 * listApps() 恒返回 []。模型据此判定「应用列表是空的，可能需要先初始化/请求权限」，
 * 白绕了三个 cell。空数组和「拿不到列表」在这里必须能被区分，所以解析要保真。
 */
function parseJsonValue(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textBlocks(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

/** 从 MCP envelope 里挖出结构化收据（顶层、structuredContent 或 action_outcome）。 */
function receiptOf(result) {
  const candidates = [];
  if (result && typeof result === "object") candidates.push(result);
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    candidates.push(result.structuredContent);
  }
  for (const text of textBlocks(result)) {
    const parsed = parseJsonRecord(text);
    if (!parsed) continue;
    candidates.push(parsed);
    if (parsed.action_outcome && typeof parsed.action_outcome === "object") {
      candidates.push(parsed.action_outcome);
    }
  }
  const merged = {};
  for (const candidate of candidates) {
    for (const key of [
      "state_id",
      "frame_id",
      "action_sent",
      "dispatch_status",
      "state_sync_status",
      "code",
      "reason",
      "snapshot_mode",
      "base_state_id",
    ]) {
      if (merged[key] === undefined && candidate[key] !== undefined) {
        merged[key] = candidate[key];
      }
    }
  }
  return merged;
}

/**
 * frame_id 的真实位置：官方 CUA 把它放在图片相邻的 `image_ref` 文本块里
 * （`{"image_ref":{"frame_id":...}}`），而不是收据顶层。SDK 两处都读，
 * 因为 image_ref 才是精确栅格契约的签发载体。
 */
function frameIdOf(result) {
  const receipt = receiptOf(result);
  if (typeof receipt.frame_id === "string") return receipt.frame_id;
  for (const text of textBlocks(result)) {
    const parsed = parseJsonRecord(text);
    const id = parsed?.image_ref?.frame_id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

function brokerErrorCodeOf(result) {
  for (const text of textBlocks(result)) {
    const parsed = parseJsonRecord(text);
    const code = parsed?.code ?? parsed?.error?.code;
    if (typeof code === "string") return code;
  }
  const receipt = receiptOf(result);
  return typeof receipt.code === "string" ? receipt.code : undefined;
}

function messageOf(result, fallback) {
  const texts = textBlocks(result);
  for (const text of texts) {
    const parsed = parseJsonRecord(text);
    if (typeof parsed?.message === "string" && parsed.message) return parsed.message;
  }
  const plain = texts.find((text) => text && !parseJsonRecord(text));
  return plain ?? texts[0] ?? fallback;
}

/**
 * 把工具结果归一成「成功 void / 失败抛错」。
 *
 * possibly_sent 的映射是这里唯一需要小心的地方（文档 §5.2）：v1 把它作为
 * isError=false 加一段文本提示，模型经常读漏；v3 变成 reject 且 actionSent=true，
 * 迫使模型先观察再决定，而不是盲重试一个可能已经落地的非幂等动作。
 */
/**
 * Helper 冷启动的 not-ready 信封。
 *
 * Bug 原因（2026-09-11 真机）：Helper 是懒启动的 —— 第一次调用触发拉起，同时工具层
 * 返回一个**非 error** 结果，单个文本块装着
 *   {kind:"CUA_NOT_READY", reasonCode:"broker_not_accepting", retryable:true,
 *    message:"...is starting up... Retry the same tool call after a brief wait."}
 * 这是 producer 刻意设计的机器可读契约（possibly_sent ⇒ retryable=false，绝不重放；
 * marker 在途 ⇒ 可重试），目的正是"宿主不必解析错误字符串"。
 *
 * 而 SDK 此前对它一无所知：appStateOf 只从 JSON 里挑 state_id/app/window/elements，
 * not-ready 载荷一个键都不匹配，于是整条信号被丢掉，模型收到的是
 * 「missing state_id, elements, app, window」。加上 node_repl 每个 cell 都是全新
 * Worker，每次尝试都停在同一刻冷启动上，模型永远走不过去（真机上它据此去 request_access
 * 并用 shell 排查环境）。
 */
const NOT_READY_KIND = "CUA_NOT_READY";
const NOT_READY_MAX_ATTEMPTS = 6;
const NOT_READY_BACKOFF_MS = [250, 500, 750, 1000, 1500];

function notReadyEnvelopeOf(result) {
  if (result?.isError === true) return undefined;
  for (const text of textBlocks(result)) {
    const parsed = parseJsonRecord(text);
    if (parsed?.kind === NOT_READY_KIND) return parsed;
  }
  return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertOk(methodName, result) {
  const receipt = receiptOf(result);
  const isError = result?.isError === true;
  const dispatch = receipt.dispatch_status;
  const actionSent = receipt.action_sent === true;
  if (!isError && dispatch !== "possibly_sent") return receipt;
  const brokerCode = brokerErrorCodeOf(result);
  const code = isError
    ? (ERROR_CODE_BY_BROKER[brokerCode] ?? "INTERNAL")
    : "TIMEOUT";
  throw new ComputerUseError(
    messageOf(result, `${methodName} failed`),
    {
      code,
      actionSent: actionSent || dispatch === "possibly_sent",
      dispatchStatus: dispatch,
      details: { method: methodName, ...(brokerCode ? { brokerCode } : {}) },
    },
  );
}

// ─────────────────────────────────────────────────────────── 目标绑定

/**
 * number → 元素索引，[x,y] → 当前栅格像素。
 *
 * 索引按**该 app 最新一次观察**解析（2026-09-12：动作形如
 * `set_value({app, elementIndex, value})`，索引身份只有 app + index，wire 上不携带
 * 「这个索引属于哪次观察」的凭证）。所以这里只发 `{type:"element", index}`，
 * 由动作自带的 app_ref 说明作用域；坐标用当前 frameId，模型永远不需要碰 frame_id。
 *
 * 仍然要求先有一次观察：没有观察就没有索引可言，自动补观察会把「模型以为点 A、
 * 实际点到 B」变成静默错误。
 */
function bindTarget(binding, target, what) {
  if (typeof target === "number") {
    if (!Number.isInteger(target) || target < 0) {
      throw new ComputerUseError(
        `${what} element index must be a non-negative integer (got ${target})`,
        { code: "INTERNAL" },
      );
    }
    if (!binding.stateId) {
      throw new ComputerUseError(
        // Bug 原因（2026-09-12 真机）：这里原先把 binding.label 拼进代码位置 ——
        // `Call await ${binding.label}.getAXState()`。label 是**显示名**，模型用
        // getApp({pid: 2697}) 绑定时它就是 "2697"，于是给出的是 `await 2697.getAXState()`
        // 这种语法都不合法的代码；绑定中文名时同样如此（`await 地图.getAXState()`）。
        // 报错要么给可直接粘贴的代码，要么就用散文描述，不能给一句假代码。
        `${what} needs a fresh accessibility state before an element index can be resolved. ` +
          `Call getAXState() on the bound app first (the object getApp(...) returned), then act in the same cell.`,
        { code: "STALE_STATE", details: { need: "getAXState" } },
      );
    }
    return { type: "element", index: target };
  }
  if (Array.isArray(target) && target.length === 2) {
    const [x, y] = target;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      throw new ComputerUseError(
        `${what} coordinate must be two non-negative integer pixels of the latest raster (got [${x}, ${y}])`,
        { code: "INTERNAL" },
      );
    }
    // 本 cell 没有取过栅格时不再拒绝。
    //
    // 工具层的坐标目标本来就允许省略 frame_id —— schemas/parseTarget.ts 的
    // `CoordinateTarget.frame_id` 注释写着「omitted targets bind inside the current
    // transport」，frame-pixel-resolver 的 `bindFramePixelTarget` 也早有 explicit /
    // implicit 两条路，implicit 走 `resolveLatestForAction()`（绑该会话最近一次可动作
    // 栅格）。所以"必须与截图同 cell"只是这一处 throw 加出来的限制，broker 侧从来不需要。
    //
    // 代价（真机 2026-09-14）：node_repl 每个 cell 都是新 Worker，binding 不跨 cell，于是
    // 每个要点坐标的 cell 都得先截一次图。模型照做前先撞一次这个错误、再补截图重来，
    // 白花一轮。模型面本来就不需要帧凭证概念：坐标就是"最近一张 app 窗口截图的像素"，
    // 只要会话已激活就能直接点。
    //
    // 放宽之后安全性不变：帧过期 / 被替换 / 非可动作，以及 app_ref 与该帧
    // 真实 owner 不一致（`frame_dispatch_identity_mismatch`），都仍然 fail-closed；一次栅格
    // 都没有过时，broker 会给出「no actionable frame is available in this transport」。
    return binding.frameId
      ? { type: "coordinate", frame_id: binding.frameId, x, y }
      : { type: "coordinate", x, y };
  }
  throw new ComputerUseError(
    `${what} target must be an element index (number) or a raster pixel ([x, y])`,
    { code: "INTERNAL" },
  );
}

/**
 * 一个字符串该当成 bundle id 还是 display name。
 *
 * Bug 原因（2026-09-11 真机）：工具层的 `app_ref` 把**裸字符串一律当成 bundle_id**
 * (`schemas/appRef.ts` 的 transform)，所以 `getApp("Notes")` 变成
 * `{bundle_id:"Notes"}` —— 即使 Notes 正在运行、`list_apps` 也把它的 `name` 报成
 * "Notes"，依然报「app 未运行且无法后台启动」。而 `{name:"Notes"}` 是通的。
 * 模型按 SKILL 的指引传 display name，于是每次都撞在这里。
 *
 * bundle id 的判据：含点、不含空格和斜杠（`com.apple.Notes`）。其余按 display name。
 * 猜错时调用方会用 {@link alternateAppRef} 换字段重试一次，所以判据只影响首选顺序，
 * 不影响能不能成。
 */
function looksLikeBundleId(target) {
  return target.includes(".") && !/[\s/]/u.test(target);
}

function appRefFor(target, windowId) {
  const field = looksLikeBundleId(target) ? "bundle_id" : "name";
  return { [field]: target, ...(windowId === undefined ? {} : { window_id: windowId }) };
}

function alternateAppRef(target, windowId) {
  const field = looksLikeBundleId(target) ? "name" : "bundle_id";
  return { [field]: target, ...(windowId === undefined ? {} : { window_id: windowId }) };
}

/** 工具层的「未运行且无法后台启动」是 app 解析失败的信号，不是别的故障。 */
/**
 * 只匹配语义核心「target app is not running」，不匹配后半句。
 *
 * 根因（2026-09-15，ZCodeArena 151 例批次）：原本匹配的是
 * `target app is not running and could not be launched`，而 producer 的文案早已改成
 * `target app is not running, and no installed application matched the ...`
 * （zcode-cua 的 nativeAxSource.ts）。一个逗号加改写就让下面的 alternateAppRef 备用查询
 * **一次都没执行过** —— 批次里 App 无法解析报错 47 次 / 23 例，模型只发了一次 name 查询就放弃。
 * 与 #29 同类：字符串在两个仓库各写一遍，一侧改了另一侧不知道。
 *
 * 前缀是这条错误的语义核心（"目标 app 没在运行"），后半句是随可执行建议演化的部分。
 * z-code 侧的 sdk 测试钉住了 producer 的现行文案必须仍被这里命中。
 */
function isAppNotFound(result) {
  if (!result?.isError) return false;
  return textBlocks(result).some((text) =>
    /target app is not running/u.test(text),
  );
}

const DIRECTIONS = new Set(["up", "down", "left", "right", "u", "d", "l", "r"]);
const LONG_DIRECTION = { u: "up", d: "down", l: "left", r: "right" };
const MOUSE_BUTTONS = { left: "left", right: "right", middle: "middle", l: "left", r: "right", m: "middle" };

// ─────────────────────────────────────────────────────────── 展示

/**
 * 观察方法自行展示结果。
 *
 * v1 把这件事写成 SKILL 里的一条纪律（「每个动作 cell 末尾必须显式
 * nodeRepl.write(state.text)」），模型忘记就整段观察丢失。纪律本该由 SDK 承担。
 * `{emit:false}` 留给「用代码判断但不想污染上下文」的场合。
 */
function emitText(globals, text, options) {
  if (options?.emit === false) return;
  try {
    globals.nodeRepl?.write?.(text);
  } catch {
    // 展示失败不能让功能调用失败。
  }
}

function isFrameAuthorityText(value) {
  const parsed = parseJsonRecord(value);
  return Boolean(
    parsed && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, "image_ref"),
  );
}

/**
 * 图片与 frame authority 走 host 的 structured sink，文本走 write。
 * 成功的纯文本动作不产生任何正文 —— 否则会和观察结果拼成两段输出。
 */
function projectToHost(globals, result, options) {
  const sink = globals.nodeRepl?.emitStructuredResult;
  if (typeof sink !== "function" || !result || !Array.isArray(result.content)) return;
  const raw = result.structuredContent;
  const structured = raw && typeof raw === "object" ? forDisplay(raw) : undefined;
  // 元数据曾只留在结构化字段，模型读取 content 时也需要它，并保持与本次截图一致。
  const metadataContent =
    options?.emit !== false && structured
      ? [{ type: "text", text: JSON.stringify(structured) }]
      : [];
  const media =
    options?.emit === false
      ? []
      : result.content.filter(
          (block) =>
            block?.type === "image" || (block?.type === "text" && isFrameAuthorityText(block.text)),
        );
  if (media.length > 0) {
    const { structuredContent: _raw, ...rest } = result;
    sink({
      ...rest,
      content: [...media, ...metadataContent],
      ...(structured ? { structuredContent: structured } : {}),
    });
    return;
  }
  if (result.isError === true) {
    sink(result);
    return;
  }
  const meta = result._meta && typeof result._meta === "object" ? result._meta : undefined;
  if (!meta && !structured) return;
  sink({
    content: metadataContent,
    ...(structured ? { structuredContent: structured } : {}),
    ...(meta ? { _meta: meta } : {}),
  });
}

/**
 * 投给宿主的结构化负载：去掉元素全表。
 *
 * Bug 原因（2026-09-11 真机）：观察结果的 `structuredContent` 里带着整棵 AX 树的
 * 元素数组，宿主把它挂到 MCP 结果上，agent 再把它序列化进**模型可见**的工具消息。
 * 打开 Notes（26 条笔记、180+ 元素）时单次 node_repl 输出 140KB 被迫落盘，模型只能
 * 反过来用 shell 去 grep 自己的工具结果。而元素表对模型是纯重复：它读的是同一次
 * 观察里已经渲染好的树文本，结构化视图只在 Worker 内部给 SDK 用。
 *
 * 宿主侧唯一的消费者是工具结果展示面板（core 的 result-display，32KB 上限），
 * 所以这里保留能标识状态的小字段，只把 `elements` 换成计数、`text` 丢掉（它已在
 * content 里）。非观察类结果（动作收据等）没有 elements，原样透传。
 */
function forDisplay(structured) {
  if (!Array.isArray(structured.elements)) return structured;
  const { elements, text: _text, ...rest } = structured;
  return { ...rest, element_count: elements.length };
}

function imageBytesOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const image = content.find((block) => block?.type === "image" && typeof block.data === "string");
  return image ? Uint8Array.from(Buffer.from(image.data, "base64")) : undefined;
}

/** AppState 的结构化事实来源。缺任何一项都 fail closed，不让模型拿到 undefined 去猜。 */
function appStateOf(methodName, result) {
  const structured =
    result?.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : {};
  const merged = { ...structured };
  for (const text of textBlocks(result)) {
    const parsed = parseJsonRecord(text);
    if (!parsed) continue;
    for (const key of ["state_id", "app", "window", "elements", "text", "snapshot_mode", "base_state_id"]) {
      if (merged[key] === undefined && parsed[key] !== undefined) merged[key] = parsed[key];
    }
  }
  if (merged.text === undefined) {
    const tree = textBlocks(result).find((text) => !parseJsonRecord(text));
    if (tree) merged.text = tree;
  }
  // 诊断性（2026-09-11 真机）：这条过去只说「Re-run the bootstrap and observe again」。
  // 模型照做了两次、次次失败，然后升级去 request_access 并用 shell 排查环境 —— 而事后
  // 从转录本也无法回溯究竟缺了哪个字段，因为结果里只剩这句话。缺什么必须写进消息，
  // 否则同一个故障既不可自愈也不可诊断。
  const missing = [
    typeof merged.state_id !== "string" ? "state_id" : null,
    Array.isArray(merged.elements) ? null : "elements",
    merged.app ? null : "app",
    merged.window ? null : "window",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ComputerUseError(
      `${methodName} returned no usable accessibility state: missing ${missing.join(", ")}. ` +
        "A hidden app with no open window can produce this, and re-observing will not change it. " +
        "Check listApps() for the app's state, or ask the user to open a window. " +
        "Do not infer a state_id from prose.",
      { code: "STRUCTURED_STATE_UNAVAILABLE", details: { method: methodName, missing } },
    );
  }
  return merged;
}

/**
 * Producer 随观察附带的**告知性文本块**（`[effect_evidence unchanged]`、
 * `[screenshot_blank]` 等），树文本本身除外。
 *
 * Bug 根因（2026-09-17 真机，会话 sess_8ec5bb22）：producer 为「AX 受理了但界面逐字节
 * 未变」专门做了一个与控件类型无关的证据位，观察响应里以独立 text block 下发。而
 * node_repl 这条链路把它整个丢了：`getAXState()` 只返回 `state.text`（= 树），
 * `emitText` 也只写这一段，`projectToHost` 的非 media 分支又把 `content` 清成 `[]`。
 * 于是模型对"点了没反应"零感知 —— 该会话里 3 次坐标点击全部静默无效、模型只能靠自己
 * diff 两棵树，最终连点 3 次同一条失效路径。
 *
 * 挂在树文本后面而不是另开通道：模型常写 `{ emit: false }` 再自行过滤，附加在返回值里
 * 两条路都覆盖到。同一个做法 getAXStateAndScreenshot 早就在用（`[screenshot unavailable: …]`）。
 */
function advisoryTextOf(result, treeText) {
  const blocks = textBlocks(result).filter(
    (text) => text && text !== treeText && !parseJsonRecord(text) && !isFrameAuthorityText(text),
  );
  return blocks.length > 0 ? `\n${blocks.join("\n")}` : "";
}

// ─────────────────────────────────────────────────────────── 首用文档

// ─────────────────────────────────────────────────────────── Target

/**
 * App / Window 共享的交互面 —— `Target` 的 12 个公开成员，签名冻结。
 * 附加成员数为 0（zoom 已在评审中删除）；ZCode 的附加能力只出现在选项袋里。
 */
function createTarget(ctx, binding) {
  const { call, globals } = ctx;

  const observe = async (options, includeScreenshot, yieldsTree) => {
    // 默认拿 delta（Helper 的 snapshot_mode），显式要整树时转发 `disable_diffing`，
    // 工具层再把它翻成 broker 的 `force_full`。字段名必须和 get_app_state 的 schema
    // 一致：它是 `.strict()` 的，凭空发明的键会让每一次观察都被 unrecognized_keys
    // 打回（2026-09-11 真机就是这么炸的）。
    const args = { app_ref: binding.appRef, include_screenshot: includeScreenshot };
    // 不变量：delta 只在基线是模型**看过**的树时才允许。
    //
    // Bug 根因（2026-09-13 真机，会话 sess_04f97297）：Helper 的 diff 基线是
    // `snapshotCache.get(pid, window)` —— "该 pid+窗口的上一次 capture"，不管发起者是谁、
    // 模型有没有看见。而 getApp() 绑定时会做一次**全量但不展示**的观察（身份解析、窗口校验、
    // 索引基线都要它），那次 capture 就成了基线。于是模型第一次 getAXState() 是对着一棵它
    // 从未见过的树做增量：飞书 930 个元素只吐出 8 行 AXMenuItem enabled 抖动，模型只能
    // 每次都显式传 disableDiffing 拿整树。node_repl 每个 cell 都是全新 Worker、每个 cell
    // 都要重新 getApp，所以这不是"首次观察"的个例，而是**每个 cell 都发生**。
    //
    // 只截图的观察同样移动了 Helper 的基线却不给树文本，所以它把 treeSeen 清掉 ——
    // 规则是「只截图观察之后，再依赖无障碍索引前必须先拿整树」，这里由 SDK 强制执行而非靠模型记住。
    if (yieldsTree === true && binding.treeSeen !== true) args.disable_diffing = true;
    if (options?.disableDiffing === true) args.disable_diffing = true;
    // yieldsTree=false（getScreenshot）不给树文本 —— 上面 binding.treeSeen 的注释里本来就写着
    // 「也不能把自己算成基线」。同一个道理对 producer 侧的位移台账成立：没展示给模型的树
    // 不能被算作「模型看到过的」，否则索引位移校验变成当前树跟当前树自比（2026-09-15 探针实测）。
    if (yieldsTree !== true) args.tree_shown_to_model = false;
    const result = await call("get_app_state", args, options);
    assertOk("get_app_state", result);
    const state = appStateOf("get_app_state", result);
    binding.stateId = state.state_id;
    binding.treeSeen = yieldsTree === true;
    const frameId = frameIdOf(result);
    if (typeof frameId === "string") binding.frameId = frameId;
    return { state, result };
  };

  const act = async (methodName, args) => {
    const result = await call(methodName, args);
    assertOk(methodName, result);
    // 这里原先动作后无条件 `binding.stateId = undefined`，逼下一次索引解析先重新观察。
    //
    // 为什么去掉（2026-09-12）：
    // 1. 与我们自己的文档打架。当时参考文档的动作示例就是 click(42) 紧跟 setValue(42)，
    //    而这条守卫让那种写法必然失败。真机上模型正是照文档写 click(9); setValue(9, ...)，
    //    然后被拒，白烧两个 cell（一个重新观察、一个重做）。
    // 2. 模型面不需要新鲜度凭证：set_value({app, elementIndex, value}) 不带
    //    stateId/stale/generation 之类的字段；失效应由持有原生元素的一侧被动判定 ——
    //    先尝试按特征重取元素，只有重取歧义/失败才报错。
    // 3. 这条守卫没有信息支撑：SDK 只知道"发生过动作"，不知道 UI 是否变化、也不知道那个
    //    元素还在不在。真正知道的是 Helper —— 索引在观察时就已冻结成 native token，
    //    元素消失时它本来就 fail-closed。
    //
    // 所以保留冻结映射 + Helper 侧校验，不再在客户端提前否决。
  };

  return {
    async getAXState(options) {
      const { state, result } = await observe(options, false, true);
      // producer 的告知性块（effect_evidence / screenshot_blank）必须跟着树一起走，
      // 否则这条链路会把它们丢光 —— 见 advisoryTextOf 的根因注释。
      const text = `${state.text}${advisoryTextOf(result, state.text)}`;
      emitText(globals, text, options);
      return text;
    },

    async getScreenshot(options) {
      // yieldsTree=false：只截图不给树文本，所以它不强制整树，也不能把自己算成基线。
      const { state, result } = await observe(options, true, false);
      const bytes = imageBytesOf(result);
      if (!bytes) {
        throw new ComputerUseError(
          // 措辞纪律（2026-09-11 真机）：这里过去写「raise the window and retry」，
          // 那是直接教模型抢用户焦点 —— 后台截图本来就能拿到（负坐标副屏窗口实测可用）。
          //
          // 而真正常见的成因是应用处于 hidden（⌘H）：macOS 不渲染隐藏窗口，Helper 的前后
          // surface 指纹必然不一致，栅格 fail-closed。此时重试永远不会成功，模型如果只看到
          // 一句无信息的 "Screenshot unavailable" 就会绕圈并升级（历史上升级成抢焦点，
          // 后来升级成 request_access + shell 排查）。所以把 producer 给出的原因带上，
          // 并指回真正可走的 AX 路径 —— 隐藏窗口的 accessibility 完全不受影响。
          `Screenshot unavailable for ${binding.label}` +
            (state.non_actionable_reason ? ` (${state.non_actionable_reason})` : "") +
            (state.screenshot_blank ? " (the captured raster was blank)" : "") +
            ". The accessibility tree still works on a hidden or unrendered window: use " +
            "getAXState() and act on element indices. Do not activate the app; ask the user " +
            "to unhide the window if pixels are genuinely required.",
          { code: "ELEMENT_UNAVAILABLE", details: { app: binding.label } },
        );
      }
      return bytes;
    },

    async getAXStateAndScreenshot(options) {
      const { state, result } = await observe(options, true, true);
      const screenshot = imageBytesOf(result);
      // 静默丢图是本轮最后一条同类缺陷（过去 screenshot===null 时直接 return {state}，
      // 一句话不给）。真机上模型正是从"没收到图"推断出「截图没有
      // 回传（窗口在副显示器上，坐标为负）」，然后去抢用户焦点——它得到的信息量是零，
      // 所以只能猜。请求了像素却没拿到，必须说清为什么、以及重试有没有用。
      const note =
        screenshot || !state.non_actionable_reason
          ? ""
          : `\n[screenshot unavailable: ${state.non_actionable_reason}]` +
            " A hidden or minimized window produces this persistently, so re-observing will not" +
            " help. The accessibility tree above is complete — act on element indices. Do not" +
            " activate the app.";
      const text = `${state.text}${advisoryTextOf(result, state.text)}`;
      emitText(globals, `${text}${note}`, options);
      return screenshot ? { state: text, screenshot } : { state: text };
    },

    async paste(text, options) {
      if (typeof text !== "string") {
        throw new ComputerUseError("paste requires text", { code: "INTERNAL" });
      }
      await act("paste", {
        app_ref: binding.appRef,
        text,
        format: options?.format ?? "text",
      });
    },

    async click(target, options) {
      const bound = bindTarget(binding, target, "click");
      const button = options?.mouseButton ? MOUSE_BUTTONS[options.mouseButton] : "left";
      if (!button) {
        throw new ComputerUseError(
          `click mouseButton must be left, right or middle (got ${options.mouseButton})`,
          { code: "INTERNAL" },
        );
      }
      await act("left_click", {
        target: bound,
        // 索引作用域：元素目标不再带 state_id，app_ref 说明"按哪个 app 的最新观察解析"。
        // 少了它，多 app 会话里的索引会退到"全局最近一次观察"，可能属于另一个 app。
        app_ref: binding.appRef,
        mouse_button: button,
        click_count: options?.clickCount ?? 1,
        ...(options?.modifiers ? { modifiers: options.modifiers } : {}),
        ...(options?.strategy ? { strategy: options.strategy } : {}),
      });
    },

    async drag(from, to, options) {
      await act("left_click_drag", {
        from_target: bindTarget(binding, from, "drag from"),
        to: bindTarget(binding, to, "drag to"),
        app_ref: binding.appRef,
        ...(options?.modifiers ? { modifiers: options.modifiers } : {}),
        // Bug 原因（2026-10-27）：文档 DragOptions 声明了 strategy，broker 的 drag
        // handler 也早已按 strategy==="event" 跳过后台中间级走前台 SendInput，但
        // 此前 SDK 只透传 modifiers —— 调用方显式选 event 被静默吞成 auto，前台
        // 拖拽从 SDK 层不可达。与 click/pressKey/scroll 同形透传。
        ...(options?.strategy ? { strategy: options.strategy } : {}),
      });
    },

    async pressKey(key, options) {
      if (typeof key !== "string" || !key.trim()) {
        throw new ComputerUseError("pressKey requires a key or chord", { code: "INTERNAL" });
      }
      await act("key", {
        text: normalizeKeyChord(key, ctx.platform),
        app_ref: binding.appRef,
        ...(options?.holdSeconds !== undefined ? { hold_seconds: options.holdSeconds } : {}),
        ...(options?.strategy ? { strategy: options.strategy } : {}),
      });
    },

    async scroll(target, direction, pages, options) {
      const dir = typeof direction === "string" ? direction.trim().toLowerCase() : "";
      if (!DIRECTIONS.has(dir)) {
        throw new ComputerUseError(
          `scroll direction must be up, down, left or right (got ${direction})`,
          { code: "INTERNAL" },
        );
      }
      await act("scroll", {
        target: bindTarget(binding, target, "scroll"),
        app_ref: binding.appRef,
        scroll_direction: LONG_DIRECTION[dir] ?? dir,
        scroll_amount: pages === undefined ? 1 : pages,
        ...(options?.strategy ? { strategy: options.strategy } : {}),
      });
    },

    async selectText(elementIndex, text, options) {
      const bound = bindTarget(binding, elementIndex, "selectText");
      // 签名按内容匹配（传要选中的文本）。range 由 SDK 在**已观察到的元素 value** 上本地算出，
      // 不需要额外的 broker 往返：value 就在上一次 getAXState 的结构化结果里。
      const range = resolveTextRange(binding, elementIndex, text, options);
      await act("select_text", { target: bound, app_ref: binding.appRef, text_range: range });
    },

    async setValue(elementIndex, value) {
      if (typeof value !== "string") {
        throw new ComputerUseError("setValue requires a string value", { code: "INTERNAL" });
      }
      await act("set_value", {
        target: bindTarget(binding, elementIndex, "setValue"),
        app_ref: binding.appRef,
        value,
      });
    },

    async typeText(text) {
      if (typeof text !== "string") {
        throw new ComputerUseError("typeText requires text", { code: "INTERNAL" });
      }
      await act("type", { text, app_ref: binding.appRef });
    },

    async performSecondaryAction(elementIndex, action) {
      if (typeof action !== "string" || !action.trim()) {
        throw new ComputerUseError(
          "performSecondaryAction requires an action advertised by the element; do not guess one",
          { code: "ACTION_UNAVAILABLE" },
        );
      }
      await act("perform_action", {
        target: bindTarget(binding, elementIndex, "performSecondaryAction"),
        app_ref: binding.appRef,
        action,
      });
    },
  };
}

/**
 * 按内容定位 [start, length]。
 *
 * `prefix` / `suffix` 用来消歧重复匹配；`selectionType` 把选区折叠成光标位置。
 * 匹配不唯一时抛 NOT_SELECTABLE 并报候选数 —— 静默取第一个会让模型在错的位置编辑。
 */
function resolveTextRange(binding, elementIndex, text, options) {
  if (text && typeof text === "object" && Number.isInteger(text.start)) {
    return [text.start, text.length ?? 0];
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new ComputerUseError("selectText requires the text to locate", { code: "INTERNAL" });
  }
  const element = binding.elements?.[elementIndex];
  const value = typeof element?.value === "string" ? element.value : undefined;
  if (value === undefined) {
    throw new ComputerUseError(
      `selectText cannot locate text in element ${elementIndex}: the latest accessibility state exposed no value for it. Observe again, or use a range { start, length }.`,
      { code: "NOT_SELECTABLE", details: { elementIndex } },
    );
  }
  const needle = `${options?.prefix ?? ""}${text}${options?.suffix ?? ""}`;
  const hits = [];
  for (let at = value.indexOf(needle); at !== -1; at = value.indexOf(needle, at + 1)) {
    hits.push(at);
  }
  if (hits.length === 0) {
    throw new ComputerUseError(
      `selectText found no occurrence of the requested text in element ${elementIndex}`,
      { code: "NOT_SELECTABLE", details: { elementIndex } },
    );
  }
  if (hits.length > 1) {
    throw new ComputerUseError(
      `selectText matched ${hits.length} occurrences in element ${elementIndex}; disambiguate with prefix/suffix`,
      { code: "NOT_SELECTABLE", details: { elementIndex, matches: hits.length } },
    );
  }
  const start = hits[0] + (options?.prefix?.length ?? 0);
  const selectionType = options?.selectionType ?? "text";
  if (selectionType === "cursor_before") return [start, 0];
  if (selectionType === "cursor_after") return [start + text.length, 0];
  return [start, text.length];
}

/**
 * 键位别名规范化：接受 xdotool / X keysym 写法（模型先验多是这种写法），
 * 输出 ZCode 的内部 token 集合。只做输入侧兼容，不改跨平台修饰键规则
 * （macOS cmd，Linux / Windows ctrl）。
 */
const KEY_ALIASES = Object.freeze({
  return: "return", enter: "return", kp_enter: "return",
  control_l: "ctrl", control_r: "ctrl", control: "ctrl", ctrl: "ctrl",
  alt_l: "alt", alt_r: "alt", meta_l: "alt", alt: "alt",
  shift_l: "shift", shift_r: "shift", shift: "shift",
  escape: "esc", esc: "esc",
  prior: "pageup", next: "pagedown",
  // 曾有 greater: ">"——输出 ">" 从未通过工具层白名单（S2 前后均如此），是端到端
  // 死路径，且会让组合契约测试（sdk-key-chord-contract.node-test.mjs）被迫开
  // 豁免口，故移除。需要输出 ">" 时应先给工具层 canonical 集补该 token。
  period: ".", comma: ",", slash: "/", minus: "-", equal: "=",
});

function normalizeKeyChord(chord, platform) {
  return chord
    .split("+")
    .map((raw) => {
      const token = raw.trim();
      const lower = token.toLowerCase();
      if (lower === "super_l" || lower === "super_r" || lower === "super") {
        return platform === "darwin" ? "cmd" : platform === "win32" ? "win" : "super";
      }
      return KEY_ALIASES[lower] ?? token;
    })
    .filter(Boolean)
    .join("+");
}

// ─────────────────────────────────────────────────────────── 装配

export async function setupComputerUseRuntime({ globals }) {
  const bridge = globals[BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object" || typeof bridge.call !== "function") {
    throw new Error(
      "Computer Use runtime bridge is unavailable. Use Computer Use from a ZCode desktop or shared-host session.",
    );
  }
  bridge.assertAvailable?.();

  const platform = globals.process?.platform ?? process.platform;

  const call = async (methodName, args, options) => {
    // not-ready 是 Helper 冷启动的正常一步，不是失败：payload 明确要求"稍等后重试同一
    // 调用"。只在 retryable 为真时重试 —— possibly_sent 的动作绝不重放（见常量注释）。
    for (let attempt = 0; ; attempt += 1) {
      bridge.assertAvailable?.();
      const result = await bridge.call(methodName, args ?? {});
      const notReady = notReadyEnvelopeOf(result);
      if (!notReady) {
        // 展示由 SDK 的 emit 控制，不能用 producer 的索引记账标志推断。
        projectToHost(globals, result, options);
        return result;
      }
      if (notReady.retryable !== true || attempt >= NOT_READY_MAX_ATTEMPTS - 1) {
        // 不可重试，或已等到上限：把 producer 自己的话和 reasonCode 交给模型，
        // 不要替换成通用句子（那正是今天反复出问题的地方）。
        throw new ComputerUseError(
          `${methodName}: ${notReady.message ?? "Computer Use is not ready."}`,
          {
            code: notReady.retryable === true ? "TIMEOUT" : "CONTROLLER_BUSY",
            details: {
              method: methodName,
              reasonCode: notReady.reasonCode,
              retryable: notReady.retryable === true,
              attempts: attempt + 1,
            },
          },
        );
      }
      await sleep(NOT_READY_BACKOFF_MS[Math.min(attempt, NOT_READY_BACKOFF_MS.length - 1)]);
    }
  };

  const ctx = { call, globals, platform };

  /** 每个绑定目标在 Worker 内的视图；跨 cell 的真身由 shared host 的 session 持有。 */
  const createBinding = (label, appRef) => ({
    label,
    appRef,
    stateId: undefined,
    frameId: undefined,
    elements: undefined,
    // delta 的基线是否是模型**看过**的那棵树。见 createTarget 的 observe()。
    treeSeen: false,
  });

  const bindApp = async (target, windowId) => {
    let objectRef;
    let label = typeof target === "string" ? target : "";
    // 也接受工具层那种 app_ref 对象。SKILL 把绑定面和逃逸口并排放着，模型学到
    // `{bundle_id: ...}` 之后很自然会把它传给 getApp（2026-09-11 真机就是这样，
    // 撞了 "getApp requires an app display name or bundle id"）。对象形态没有歧义，
    // 直接透传比让它退回去改写更省一次往返。
    if (target && typeof target === "object" && !Array.isArray(target)) {
      const direct = windowId === undefined ? { ...target } : { ...target, window_id: windowId };
      if (
        typeof direct.name !== "string" &&
        typeof direct.bundle_id !== "string" &&
        typeof direct.pid !== "number"
      ) {
        throw new ComputerUseError(
          "getApp needs an app display name, a bundle id, or {name|bundle_id|pid}",
          { code: "INVALID_APP" },
        );
      }
      objectRef = direct;
      label = String(direct.name ?? direct.bundle_id ?? direct.pid);
    } else if (typeof target !== "string" || !target.trim()) {
      throw new ComputerUseError(
        "getApp needs an app display name, a bundle id, or {name|bundle_id|pid}",
        { code: "INVALID_APP" },
      );
    }
    let appRef = objectRef ?? appRefFor(target, windowId);
    const binding = createBinding(label, appRef);
    const app = createTarget(ctx, binding);
    // 绑定时只解析身份，观察结果留在宿主通道。
    let result = await call("get_app_state", {
      app_ref: appRef,
      include_screenshot: false,
      disable_diffing: true,
      // 这棵树不展示给模型（下面 981 行那段注释说明为什么），所以它**不能**被算作
      // 「模型看到过的树」。不标的后果（2026-09-15 探针实测）：索引位移校验拿当前树
      // 跟当前树自比，必然一致，静默点错元素的保护完全失效。
      tree_shown_to_model: false,
    }, { emit: false });
    if (isAppNotFound(result) && objectRef === undefined) {
      // 只有字符串需要猜字段；对象形态是显式的，猜错的是调用方而不是我们。
      const alternate = alternateAppRef(target, windowId);
      if (alternate) {
        appRef = alternate;
        binding.appRef = alternate;
        result = await call("get_app_state", {
          app_ref: alternate,
          include_screenshot: false,
          disable_diffing: true,
          tree_shown_to_model: false,
        }, { emit: false });
      }
    }
    assertOk("get_app_state", result);
    const state = appStateOf("get_app_state", result);
    binding.stateId = state.state_id;
    binding.elements = state.elements;
    // 绑定成功后把 app_ref 收敛成**解析出来的身份**，不再继续拿模型给的原始字符串。
    //
    // Bug 原因（2026-09-12 真机）：模型写 `getApp("地图")`（Maps 的中文本地化名）。观察成功了
    // —— capture_app 按名字找不到活动应用会走透明拉起分支，那里的 LaunchServices 查表能把
    // "地图" 解成 com.apple.Maps。但同一个 cell 里紧接着的 pressKey 失败：
    //   press_key_to_app: app_ref did not resolve to a unique live application
    // 因为活动应用列表里 Maps 的 name 字段是英文 "Maps"，{name:"地图"} 匹配零行，而键盘路径
    // 只按活动应用严格匹配。观察路径宽容、输入路径严格，两边就此分叉。
    //
    // 观察结果里本来就带着已解析的身份（state.app.pid / bundle_id），此前只是没用。收敛之后
    // 本地化名、模糊名、大小写差异都只在第一跳解决一次，后续所有路径拿到的都是无歧义身份。
    // 两个字段都给：pid 精确（同 cell 内进程不会换），bundle_id 供 broker 侧交叉校验身份。
    // window_id 若已绑定必须保留 —— 它决定 macOS 后台键盘的 synthetic-focus session。
    const resolvedPid = typeof state.app?.pid === "number" ? state.app.pid : undefined;
    const resolvedBundleId =
      typeof state.app?.bundle_id === "string" && state.app.bundle_id.trim()
        ? state.app.bundle_id
        : undefined;
    if (resolvedPid !== undefined || resolvedBundleId !== undefined) {
      const boundWindowId =
        typeof appRef?.window_id === "number" ? { window_id: appRef.window_id } : {};
      appRef = {
        ...(resolvedPid !== undefined ? { pid: resolvedPid } : {}),
        ...(resolvedBundleId !== undefined ? { bundle_id: resolvedBundleId } : {}),
        ...boundWindowId,
      };
      binding.appRef = appRef;
    }
    // 判据取自**最终的 appRef**，不是位置参数 windowId。
    //
    // Bug 根因（2026-09-17 复查）：这里原先写 `windowId !== undefined`，只认
    // getWindow(target, id) 那种位置参数形态。而 `getApp({pid, window_id})` 也能钉窗口
    // （objectRef 直接透传，见上面的 direct），走那条路时 windowId 恒为 undefined，
    // 于是这道 fail-closed 被整个跳过：Helper 静默降级到最前窗口、只回一句 note，
    // 模型在错窗口上继续操作。两种钉法必须同一套校验。
    const boundWindow = typeof appRef?.window_id === "number" ? appRef.window_id : windowId;
    if (boundWindow !== undefined && state.window?.window_id_fallback === true) {
      // 现状会静默降级到最前窗口并只回一句 note，模型极易读漏后在错窗口上继续操作。
      throw new ComputerUseError(
        `Window ${boundWindow} of ${label} could not be resolved; the Helper fell back to the frontmost window. Call agent.computerUse.computer.list_windows to pick a fresh window_id.`,
        { code: "STALE_STATE", details: { app: label, windowId: boundWindow } },
      );
    }
    // getApp 不展示状态（2026-09-13）。它仍然做一次观察 —— 身份解析、窗口校验与索引解析
    // 基线都要它 —— 但不再把那棵树写进输出。
    //
    // 根因：「getApp 自动输出结果」只在 kernel **持久**时划算 —— `const app = await
    // cua.getApp(...)` 跨 cell 存活，一个会话只调一次 getApp，那次展示确实省掉一次单独观察。
    // ZCode 的 node_repl 每个 cell 都是全新 Worker，绑定不跨 cell，于是**每个 cell 都要重新
    // getApp**，那次"顺便展示"就从"一次性省一个往返"变成了"每个 cell 都多一棵注定作废的树"。
    //
    // 代价不只是 token。真机实测（会话 sess_f14c07fd）：8 个 cell 里 5 个吐两棵树，
    // 36% 的工具输出（43902/120854 字符）是被同 cell 后续观察直接覆盖的前序树；更糟的是
    // 同一个 `[35]` 在一个 cell 的输出里指向两个不同元素（先出现的 79 元素树里是
    // `genericelement Yanbao Maquanying Homeland`，后出现的 105 元素树里才是
    // `button Tsinghua University`），而**只有最后那棵**是索引解析真正会用的，输出里却
    // 没有任何标记说明这件事。读错就点到无关元素，且不会报错 —— 那个索引在旧树里合法。
    //
    // 想看状态就显式 getAXState()，与其它观察方法一致。
    //
    // 结构化元素视图。Target 的公开观察方法只给字符串，但模型写的是代码，单 cell 内
    // 「观察 → 找元素 → 动作」能省一次往返；树被按优先级裁剪（targeting/format.ts 的
    // `indices are sparse` 注记）时，它还是模型拿到隐藏元素索引的唯一途径。因此它已被
    // 提为**文档化成员**（SKILL 的 Keyboard 段 + docs/computer-use.md 的 API 段），
    // 保持 enumerable:false 只是为了不进 Object.keys —— R2 的「Target 附加成员为 0」
    // 说的是冻结的**可枚举**公开面，不是禁止具名逃逸口。
    Object.defineProperty(app, "elements", {
      enumerable: false,
      value: async () => {
        // 与 getScreenshot 不同档（2026-10-25 修正）：返回值（含 index 的元素表）
        // 回给了模型所写的 JS——els[3].index 直接进 click 参数，这张表就是模型
        // 选目标的信息来源，构成「模型可见」。2026-09-16 评审按「不 emit」把它
        // 与 bindApp/getScreenshot 一刀切标 false，掩盖了本质差异（那两条的
        // 返回值不含树）；false 的真实后果是位移台账只剩更旧的树，模型用
        // elements() 的新鲜索引点击时被拿旧树对照新树，element_index_shifted
        // 假阳性（真位移同时拦不住）。记账后 producer 台账与模型实际所见一致。
        //
        // diff 基线问题不受影响：binding.treeSeen 仍清空（treeSeen 管的是 emit
        // 展示面的整树承诺，与记账正交），下一次 getAXState 照旧强制整树。
        const fresh = appStateOf(
          "get_app_state",
          await call("get_app_state", { app_ref: appRef, tree_shown_to_model: true }, { emit: false }),
        );
        binding.stateId = fresh.state_id;
        binding.elements = fresh.elements;
        binding.treeSeen = false;
        return fresh.elements;
      },
    });
    return app;
  };

  const inventory = async (options) => {
    const result = await call("list_apps", {}, options);
    assertOk("list_apps", result);
    const apps = [];
    for (const text of textBlocks(result)) {
      const parsed = parseJsonValue(text);
      if (Array.isArray(parsed?.apps)) apps.push(...parsed.apps);
      else if (Array.isArray(parsed)) apps.push(...parsed);
    }
    const state = { apps };
    emitText(globals, JSON.stringify(state, null, 2), options);
    return state;
  };

  // `cua.computer` —— 平台特定逃逸口，暴露额外的平台相关 computer API。
  // 内容是存活的 14 个工具，入参 schema 逐字保留。
  //
  // 返回值**解封**（2026-09-16）：此前原样返回 MCP envelope，于是模型拿到的是
  // `{content:[{type:"text",text:"[...]"}],_meta:{…}}`，还得自己 `JSON.parse(r.content[0].text)`。
  // 真机代价（list_windows）：4964 字符里有用载荷只 1723（35%），另外 65% 是信封与
  // `_meta` 里的 app 图标 base64（上限 24KiB ⇒ base64 最坏 ~32KiB）。而 `_meta` 按设计
  // 就是**宿主专用**的（target-app-display 设计文档：host-only、"stripped before handlers
  // observe responses"），projectToHost 已经单独把它送给宿主展示 —— 所以泄漏给模型是
  // 契约违规，不是契约选择。连设计文档自己的示例都写成 `wins[1].window_id`（把它当裸数组），
  // 可见"保留信封"从来不是有人依赖的行为；全仓 grep 也确认零消费者。
  const unwrapEnvelope = (result) => {
    if (result === null || typeof result !== "object") return result;
    if (!Array.isArray(result.content)) return result;
    // 新增的紧凑元数据副本已由宿主展示，解封时排除它以保持单载荷调用的返回类型。
    const metadataText =
      result.structuredContent && JSON.stringify(forDisplay(result.structuredContent));
    const content =
      result.content.length > 1 && typeof metadataText === "string"
        ? result.content.filter((block) => block?.type !== "text" || block.text !== metadataText)
        : result.content;
    const textBlocks = content.filter(
      (block) => block && block.type === "text" && typeof block.text === "string",
    );
    // 只在"单一 text block"这种明确形态上解封；多块 / 图像等一律原样返回，
    // 避免把一个我们不认识的形状猜成裸值。
    if (textBlocks.length !== 1 || content.length !== 1) return result;
    const text = textBlocks[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const computer = Object.create(null);
  Object.defineProperty(computer, "target", {
    enumerable: true,
    value: platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux",
  });
  const excluded = new Set(PLATFORM_EXCLUDED_METHODS[platform] ?? []);
  for (const methodName of COMPUTER_METHOD_NAMES) {
    if (excluded.has(methodName)) continue;
    Object.defineProperty(computer, methodName, {
      enumerable: true,
      value: async (args = {}) => unwrapEnvelope(await call(methodName, args)),
    });
  }

  const cua = {
    async getState(options) {
      return await inventory(options);
    },
    async getApp(target) {
      return await bindApp(target);
    },
    async listApps(options) {
      return (await inventory(options)).apps;
    },
    computer: Object.freeze(computer),
    async requestAccess(capabilities) {
      const result = await call("request_access", capabilities ? { capabilities } : {});
      assertOk("request_access", result);
      const texts = textBlocks(result);
      return parseJsonRecord(texts[0]) ?? { ready: true };
    },
    async stop(reason) {
      const result = await call("stop_computer_control", reason ? { reason } : {});
      assertOk("stop_computer_control", result);
    },
  };
  // 未文档化成员：窗口绑定。窗口寻址各平台差异很大（有的平台没有窗口寻址，有的整套
  // 以 Window 对象寻址），ZCode 三平台统一命名，不按平台分裂公开面，
  // 所以窗口寻址留在逃逸口 + 这个未文档化入口。
  Object.defineProperty(cua, "getWindow", {
    enumerable: false,
    value: async (target, windowId) => await bindApp(target, windowId),
  });

  // 入口是 `agent.computerUse`（ZCode 自己的命名空间约定，与 agent.documentation /
  // agent.browsers 并列），不注入裸 `cua` 全局。
  // 平铺的 14 个工具在 `agent.computerUse.computer.*` 下（COMPUTER_METHOD_NAMES）。
  const agent = (globals.agent ??= {});
  agent.computerUse = cua;

  const previousDocumentation = agent.documentation;
  const previousGet =
    previousDocumentation && typeof previousDocumentation.get === "function"
      ? previousDocumentation.get.bind(previousDocumentation)
      : undefined;
  agent.documentation = Object.freeze({
    get: async (name) => {
      // Browser Use 的文档 loader 必须原样转交 —— CUA 只认自己那一个名字。
      if (name !== "computer-use") {
        if (previousGet) return await previousGet(name);
        throw new Error(`Unknown documentation entry: ${name}`);
      }
      if (typeof bridge.documentationRoot !== "string") {
        throw new Error("Computer Use documentation is unavailable");
      }
      return await readFile(join(bridge.documentationRoot, "computer-use.md"), "utf8");
    },
  });

  return cua;
}

export { COMPUTER_METHOD_NAMES, PLATFORM_EXCLUDED_METHODS, ComputerUseError, normalizeKeyChord, KEY_ALIASES };
