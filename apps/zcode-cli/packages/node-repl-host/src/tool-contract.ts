// 旧默认值与模型常用的 30 秒页面等待相同，发送等副作用成功后会在结果读取前被中止。
// 执行层和模型可见文案共用该常量，避免真实超时与 tools/list 描述漂移。
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;

// MCP serverInfo 曾长期硬编码为 0.1.0，与插件发布版本分叉，导致宿主无法据此判断
// 实际加载的 Browser Use runtime。版本升级时该值应与 package.json 同步。
// 宿主自己的版本，不是 browser-use 插件的版本。把宿主抽成 @zcode/node-repl-host
// 时保留了这个数字：它一直就是 node_repl server 对外宣告的版本，换个数字等于无谓地改协议。
// 从此它随宿主契约（bridge 成员、工具面）变化，与两个插件各自的版本解耦。
// 升到 0.5.0：本次宿主契约本身变了（node_repl 从 browser-use 抽出成独立 seed 单元、
// 工具面随 CUA 的 node_repl SDK 重建调整），按上面这条规则该动。数字与 browser-use 0.5.0 相同
// 只是同源历史的巧合，不构成耦合——两者仍各自独立升版。
// 升到 0.6.0：工具面收敛到只剩 `js`，`js_reset` 与 `js_add_node_module_dir` 连同
// moduleDirs 能力一起删除。前者自 fresh-kernel 改造起就是固定返回成功的空操作，且"永不失败"
// 会让模型连续重复调用（重复调用会持续消耗预算）；后者
// 是把宿主职责推给模型——模型无法自行知道该传哪个 node_modules，能告诉它的只有 skill 文档，
// 而文档知道的路径宿主自己就能注入。两者实测调用量均为 0。宿主协议变了就得让 serverInfo 能被
// 据此识别，否则宿主无法区分自己连上的是哪一代工具面。
// 升到 0.6.1：browser bridge 不再按 runtime_scope 拒绝 subagent，subagent 也能使用 Browser Use；
// 已装用户必须换到新缓存目录才能拿到新 server.js。
// 升到 0.6.2：js 结果按 turn 追加无进展提示（同码、同结果、调用量），同样需要换缓存目录生效。
export const NODE_REPL_SERVER_VERSION = "0.7.0";

// node_repl 的底层能力是通用 JS，旧文案却没有声明模型路由边界，导致非浏览器任务
// 也会误选这个高权限工具。Browser Use 与 Computer Use 是合法入口，因此 server 与 tool 文案都要显式限域。
// 旧文案的 "Import only" 被读成受限运行时，加载 node:child_process 因而被判为沙箱逃逸，所以如实写明不是沙箱。
// 路由禁令不能随之放宽：js 不经过 Bash 的 guarded 危险命令确认，模型把它当 shell 用就绕过了确认。
const NODE_REPL_CAPABILITY_AND_ROUTING =
  "The code runs unsandboxed with the ZCode agent's privileges and skips Bash's dangerous-command approval, " +
  "so never use it for shell, file, package inspection, or data processing work; use the dedicated tools. ";

export const NODE_REPL_SERVER_INSTRUCTIONS =
  "Browser Use and Computer Use only. Use `js` to run JavaScript in a fresh Node.js kernel when " +
  "the corresponding official skill instructs you to control a browser or computer. " +
  NODE_REPL_CAPABILITY_AND_ROUTING +
  `Calls default to a ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms timeout. ` +
  "Always provide `title` as a short user-facing description in the user's language. " +
  "Every `js` call starts fresh.";

export const JS_TOOL_DESCRIPTION =
  "Browser Use and Computer Use only. Run JavaScript in a fresh Node.js kernel with top-level await as " +
  "instructed by the corresponding official skill to control a browser or computer. " +
  NODE_REPL_CAPABILITY_AND_ROUTING +
  "Always provide the required `title` as a short " +
  "user-facing description in the user's language without implementation terms. If `timeout_ms` is omitted, execution times out " +
  `after ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms. If the code may take more than 30000 ms including all awaited operations, you MUST set \`timeout_ms\` to at least the estimated total runtime plus 15000 ms; split the work into multiple calls if that exceeds the 120000 ms maximum. ` +
  "Use `nodeRepl.write(value)` for text and `await nodeRepl.emitImage(imageLike)` for images. " +
  "Bootstrap the requested official capability in every call.";
