/**
 * 沙箱子进程逻辑。**一份实现，一份入口文件，两种启动方式**：
 *   - {@link renderChildEntry} 把 {@link childMain} 经 `toString()` 与 payload 一起渲染成一份
 *     自包含 ESM，harness 写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs`（child-entry-file.ts）；
 *   - 普通 Node：`node --max-old-space-size=N <entry>`，入口文件发现自己就是进程入口时自启；
 *   - SEA 单文件二进制：CLI 的隐藏子命令 `__zcode-dwf-child <entry>` `import()` 这份文件并调
 *     它导出的 `start(deps)`，注入 CLI 进程的 vm/readline/stdio（SEA 主程序不解释 Node CLI
 *     旗标，`--eval` 路不通）。
 *
 * Windows 的命令行上限是 32,767 字符，
 * `--eval CHILD_SOURCE -- <base64url payload>` 会把整份 lowered 脚本放在命令行上，脚本
 * 一过约 18 KB 就 `spawn ENAMETOOLONG`，Windows 上每个稍长的 run 都起不来。
 *
 * 结构：
 *   - 外层 realm（{@link childMain} 自身）是普通 Node 代码：持有 stdio、readline、vm，负责传输。
 *   - 求值单元是 `vm.createContext(...)` 建的**独立 realm**：只含 ES intrinsics + 注入的 `__host`。
 *     裸 vm context 天然没有 `process`/`require`/`Buffer`/`fetch`，也没有定时器；我们只补 `__host`
 *     与运行期禁令。channel / future 与停滞检测（docs/dynamic-workflow/authoring.md「Streams」）
 *     都在 cell 内实现：前者是纯 promise 机制，后者正是靠「cell 内没有别的唤醒源」成立。
 *
 * 跨 realm 收敛（防原型泄漏 / prototype pollution）：脚本触及的一切（Promise、JSON 解析出的
 * host 结果、Error）都在 **context 内**构造；外层与 context 间只有字符串过界：出站行经 `__send`、
 * 入站行经 `__deliver`（字符串是原始值，无 realm 归属）。故 `Array.isArray`/`instanceof`/
 * 原型链在脚本视角下全是 context-native，绝不掺入外层 realm 的 intrinsics。
 *
 * 这条收敛同时是防 vm 逃逸的边界：脚本只要摸到一个外层 realm 的函数或对象，就能经
 * `.constructor.constructor("return process")()` 拿到宿主 process。具体规则见 {@link childMain}
 * 里沙箱构造处的注释，回归测试在 tests/security.test.ts 的 "realm boundary" 两组。
 *
 * 动态 import：runFn 经 `vm.runInContext`（Script，未提供 importModuleDynamically 回调）编译，
 * 运行期 `import()` 抛 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`。`eval`/`Function` 绑定同一套
 * context 全局。
 *
 * ⚠ 本文件是 protocol.ts 线协议的**手写镜像**：入口文件里的 childMain 以内嵌字符串运行，无法 import
 * protocol.ts。改任一处必须同步另一处。故 {@link childMain} 只允许 import **类型**（编译期擦除），
 * 绝不引入运行期 package 依赖；本模块唯一的值 import（child-cell-streams.ts 的引导字符串）只被
 * {@link renderChildEntry} 读取并内嵌进入口文件，childMain 自身通过 deps 拿到它。
 */

import { CELL_STREAMS_BOOTSTRAP } from "./child-cell-streams.js";
import type { ChildPayload } from "./protocol.js";

/** {@link childMain} 用到的 `node:vm` 全部表面（窄到只有两个函数——这就是子进程的 vm 契约）。 */
export interface ChildVmModule {
  createContext(sandbox: object, options?: { name?: string }): object;
  runInContext(code: string, sandbox: object, options?: { filename?: string }): unknown;
}

/** {@link childMain} 用到的 `readline.Interface` 表面。 */
export interface ChildReadlineInterface {
  on(event: "line", listener: (line: string) => void): unknown;
  close(): void;
}

/**
 * 注入给 {@link childMain} 的宿主能力。**两种启动方式各自提供真实实现**：入口文件自启时从
 * `node:vm` / `node:readline` / `process` 现取，SEA 子命令从 CLI 进程现取。
 */
export interface ChildMainDeps {
  vm: ChildVmModule;
  createInterface(options: { input: NodeJS.ReadableStream }): ChildReadlineInterface;
  /** 入站 response 的来源（父进程 stdin 管道）。持有它也让事件循环保持存活。 */
  stdin: NodeJS.ReadableStream;
  /** 出站 NDJSON 的去处；{@link childMain} 自己补换行。 */
  stdout: { write(chunk: string): unknown };
  /**
   * 本次 run 的 payload（{@link import("./protocol.js").ChildPayload}）。入口文件把它当 JSON
   * 字面量内嵌并原样递进来——不再经 argv、不再 base64。
   */
  payload: ChildPayload;
  /**
   * cell 的第二段引导脚本：channel / future 与停滞检测（child-cell-streams.ts 的
   * {@link import("./child-cell-streams.js").CELL_STREAMS_BOOTSTRAP}）。与 payload 同路——
   * 入口文件把它当字符串字面量内嵌、`start` 原样递进来——因为 childMain 的自包含约束不许它
   * 引用模块作用域的绑定，而把它留在本文件里会顶穿单文件行数上限。它在 BOOTSTRAP 之后、
   * lowered 体之前于同一 context 内运行，读写 BOOTSTRAP 用 `var` 建下的 context 全局。
   */
  streamsBootstrap: string;
}

/**
 * 沙箱子进程的**唯一**出口。返回的 promise 在脚本执行终结（complete 已发出、stdin 已关）后兑现。
 *
 * 为什么必须可 await：SEA 子命令跑在 CLI 进程里，而 CLI 入口在 `run()` 返回后会挂一个 1s
 * 退出 watchdog（shutdown.ts 的 `scheduleCliExitWatchdog`）。若子进程逻辑只是"装好 readline
 * 就同步返回"，watchdog 会在 run 刚起步时把整个子进程强退。入口文件自启时不需要这个 promise
 * （事件循环空了自然退出），但两条入口共用一个实现，所以由 childMain 统一给出终结信号。
 *
 * ⚠ 自包含约束（载荷性，不是风格）。{@link renderChildEntry} 靠 `childMain.toString()` 把本函数
 * 当**源码**内嵌，所以函数体必须是一段能独立成立的程序，两条规矩：
 *   1. 只引用参数、语言 intrinsics 与 `Buffer` 这类 Node 全局，**绝不引用模块作用域的任何绑定**
 *      （常量、辅助函数、import）。沙箱 bootstrap 也因此内联在函数体里，而不是模块级常量。
 *   2. **内层函数一律不许有名字**——理由和踩过的坑见函数体里那段注释（esbuild 的
 *      `minify + keepNames` 会给它们套上模块作用域的 `__name` helper）。
 * 两条约束都需要在真实打包/压缩形态下验证，光靠源码测试抓不到这类回归。
 */
export function childMain(deps: ChildMainDeps): Promise<void> {
  /**
   * 在 vm context 内运行的引导脚本（纯 JS，无 backtick / ${}，以便安全内嵌）。
   * 定义 `__host`（Boundary A shims）、`__deliver`（消费入站 response）、`__execute`（跑 lowered fn），
   * 并施加运行期禁令（Date.now / argless new Date() / Math.random）——belt；编译期诊断是 suspenders。
   */
  const BOOTSTRAP = String.raw`
"use strict";

// —— 传输（跨 realm 的唯一出口）——
// 外层 realm 放在全局上的两个宿主函数 __send / __finish，必须在任何其他代码运行前收进闭包并从
// 全局删掉。原因：脚本只要拿到一个外层函数，fn.constructor 就是外层 realm 的 Function，
// Function("return process")() 即拿到宿主 process（vm 逃逸，零审批执行任意命令）。
// 包装层还要吞掉宿主函数抛出的一切：宿主异常同样属于外层 realm（比如栈将满时进入宿主函数
// 溢出的 RangeError），它的 .constructor.constructor 也是外层 Function。只有字符串过界。
var __emitLine;
var __finishExecution;
(function (send, finish) {
  __emitLine = function (line) {
    try {
      send(line);
    } catch (hostError) {
      throw new Error("workflow transport failed");
    }
  };
  __finishExecution = function () {
    try {
      finish();
    } catch (hostError) {}
  };
})(__send, __finish);
delete globalThis.__send;
delete globalThis.__finish;

var __nextLocal = 0;
var __nextReq = 0;
var __pending = new Map();
// 本世已补全的留白：站点 id → 体的文本。同一站点再次到达（循环）时直接求值，不再过线。
var __fills = new Map();

function __emit(obj) {
  __emitLine(JSON.stringify(obj));
}

function __createActor(siteId, name, persona) {
  // 同步造 child-local 句柄并即发即忘 create-actor；父进程据 stdio FIFO 在后续 ask 前完成映射。
  var localId = "local#" + (++__nextLocal);
  __emit({ kind: "create-actor", localId: localId, siteId: siteId, name: name, persona: persona });
  return localId;
}

function __ask(siteId, actor, instructions) {
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "ask", siteId: siteId, actor: actor, instructions: instructions });
  });
}

function __worldRead(siteId, op, args) {
  // args 是 lowering 打包好的位置实参数组；本 shim 原样透传，不看 op、不校验元数（归 driver）。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "world-read", siteId: siteId, op: op, args: args });
  });
}

function __evaluateFill(evaluate, code) {
  // evaluate 是 lowering 在站点处发出的 (__src) => eval(__src)：直接 eval，闭包住作者代码在
  // 那一点的全部绑定（__host 在内），求出 (async () => { … }) 这个函数；调它，结果即留白的值。
  // 每次到达都新造一个 evaluate，循环里的留白因此看见各轮自己的绑定。求值失败（语法错）与体的
  // 拒绝都在这条 promise 上冒出，落在站点处，脚本可以 catch。
  return Promise.resolve().then(function () {
    return evaluate(code)();
  });
}

function __hole(siteId, name, prompt, evaluate, body) {
  // 已补全（体就在脚本里）：直接调体，不过线。同步抛出转成拒绝，与 future 同规。
  if (body !== undefined) {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  var remembered = __fills.get(siteId);
  if (remembered !== undefined) return __evaluateFill(evaluate, remembered);
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "hole", siteId: siteId, name: name, prompt: prompt });
  }).then(function (answer) {
    __fills.set(siteId, answer.code);
    return __evaluateFill(evaluate, answer.code);
  });
}

function __log(message) {
  __emit({ kind: "event", type: "log", message: String(message) });
}

function __enterPhase(name) {
  // 阶段标记：无站点、不落 journal，只让引擎发一条事件——所以与 log 同走事件通道。
  __emit({ kind: "event", type: "phase-entered", name: String(name) });
}

function __publishArtifact(siteId, op, args) {
  // 内容产物是效应：脚本 await 它、要能 catch 它的拒绝，所以与 ask / world-read 同走
  // request/response。args 是 lowering 打包的位置实参（[id, path|content, opts]），原样透传。
  var id = "r" + (++__nextReq);
  return new Promise(function (resolve, reject) {
    __pending.set(id, { resolve: resolve, reject: reject });
    __emit({ kind: "request", id: id, type: "publish-artifact", siteId: siteId, artifactOp: op, args: args });
  });
}

function __declareArtifact(siteId, op, args) {
  // 预置产物是声明：同步返回 void，没有可等的东西，所以走事件通道。它与 report 共用同一条
  // FIFO——一条打了标签的 report 必须晚于它的声明到达父进程，而顺序正是由这一点保证的。
  __emit({ kind: "event", type: "declare-artifact", siteId: siteId, op: op, args: args });
}

function __report(siteId, item, artifactId) {
  // 即发即忘：脚本从不 await 它，所以走 event 通道而不是 request/response。父进程按 siteId ×
  // ordinal 落一行 journal，故本条消息的**到达顺序**是承重的（stdio FIFO 保证它）。
  // item 里若有环，这里的 JSON.stringify 会抛错——就在 report() 的调用点上，脚本要么 catch
  // 要么让 run 失败。两者都比静默发出一条残缺的 item 好；父进程另有同样的护栏。
  // artifactId 缺席时 JSON.stringify 直接把这个键丢掉，线上因此就是"没有标签"。
  __emit({ kind: "event", type: "report", siteId: siteId, item: item, artifactId: artifactId });
}

// —— 运行实参（Boundary A 的 args）——
// 与预算一样在 context **内**用 JSON.parse 构造，所以脚本拿到的是 context-native 对象，
// 外层 realm 的 intrinsics 一点都不掺进来（本文件顶部的跨 realm 收敛约束）。
// ⚠ Object.freeze 是**浅**冻结：嵌套对象未冻结，脚本仍能改动 args.foo.bar。v1 接受这个
// 界限——它挡的是"手滑重新赋值 args"，不是一个安全边界（实参本来就是调用方给的）。
var __args = Object.freeze(JSON.parse(__argsJson));
// run 身份（facade 的 run 全局）同一种构造：context 内 JSON.parse、浅冻结（它本身就是平的）。
var __run = Object.freeze(JSON.parse(__runJson));

globalThis.__host = {
  args: __args,
  run: __run,
  createActor: __createActor,
  ask: __ask,
  worldRead: __worldRead,
  publishArtifact: __publishArtifact,
  declareArtifact: __declareArtifact,
  report: __report,
  log: __log,
  enterPhase: __enterPhase,
  hole: __hole,
};

// —— 入站 response 消费（由外层 realm 以行字符串调用）——
globalThis.__deliver = function (line) {
  var msg = JSON.parse(line);
  if (msg.kind !== "response") return;
  var waiter = __pending.get(msg.id);
  if (!waiter) return;
  __pending.delete(msg.id);
  if (msg.ok) {
    waiter.resolve(msg.value);
    return;
  }
  // 拒绝以 context-native Error 过界，带上 code/violations/finalText 供脚本 try/catch 结构化处理。
  var e = msg.error || {};
  var err = new Error(e.message || "workflow host error");
  if (e.name) err.name = e.name;
  if (e.code !== undefined) err.code = e.code;
  if (e.violations !== undefined) err.violations = e.violations;
  if (e.finalText !== undefined) err.finalText = e.finalText;
  waiter.reject(err);
};

// run 是否已发出 complete。停滞检测（deps.streamsBootstrap 里的 __checkStalled）也读写它。
var __settled = false;

function __complete(ok, payload) {
  // 幂等：停滞检测已经以 error-complete 结束 run 之后，脚本（理论上）再完成也不再发第二条。
  if (__settled) return;
  __settled = true;
  if (ok) {
    __emit({ kind: "complete", ok: true, value: payload });
    return;
  }
  var wire;
  if (payload instanceof Error) {
    wire = {
      name: payload.name,
      message: payload.message,
      stack: payload.stack,
      code: payload.code,
      violations: payload.violations,
      finalText: payload.finalText,
    };
  } else {
    wire = { name: "Error", message: String(payload) };
  }
  __emit({ kind: "complete", ok: false, error: wire });
}

// 外层 realm 调用它跑脚本，收尾经 __finishExecution 通知外层（关 stdin）。外层不对这里返回的
// promise 调 then：脚本能改写 Promise.prototype.then，从而收到外层传进来的回调（又一条逃逸路径）。
// 所以本函数必须自己吞掉一切、无条件走到 __finishExecution。
globalThis.__execute = async function (runFn) {
  try {
    try {
      var value = await runFn(globalThis.__host);
      __complete(true, value);
    } catch (e) {
      __complete(false, e);
    }
  } catch (completeError) {
    // __complete 只在脚本改坏了 cell 的 intrinsics 时才会抛；run 仍要收尾，父进程据
    // 「退出而未完成」把它判成 interrupted。
  }
  __finishExecution();
};

// —— 运行期禁令（belt；编译诊断是 suspenders）：Date.now / argless new Date() / Math.random ——
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is disabled in workflows");
    super(...arguments);
  }
  static now() {
    throw new Error("Date.now() is disabled in workflows");
  }
  static parse(value) {
    return __NativeDate.parse(value);
  }
  static UTC() {
    return __NativeDate.UTC.apply(__NativeDate, arguments);
  }
}
globalThis.Date = __WorkflowDate;
Math.random = function () {
  throw new Error("Math.random() is disabled in workflows");
};
`;

  // ⚠ 自包含约束的第二条（见函数上方注释），比"别 import"更容易踩：**内层函数一律不许有名字**。
  // 根因（本条测试写出来之前真踩到过）：CLI 的 desktop-agent 构建用 `minify + keepNames`，
  // 那个组合下 esbuild 会把**能推导出名字**的内层函数（变量声明 `const send = …`、函数声明、
  // 对象字面量属性）改写成 `__name(fn, "send")`，而 `__name` 是注入在模块作用域的 helper。
  // 它一旦出现在 `toString()` 的文本里，内嵌出的子进程程序就会 ReferenceError——**只在压缩过的
  // 发布产物里坏**，源码测试全绿。成员赋值（`sandbox.__send = …`）与实参位置的匿名函数不被改写，
  // 所以下面一律用这两种形态。验证时需要运行真实打包、压缩后的产物。

  const payload = deps.payload;

  // 独立 realm：裸 context 只有 ES intrinsics，注入 __send / __finish 两个传输函数 + 实参 JSON。
  // 实参缺席（内联 run、老 journal 行）编码成 "{}"：`args` 恒有定义是脚本侧的不变式，
  // 沙箱这一侧就是它成立的地方。
  //
  // 跨 realm 边界（execution-engine.md「The vm cell」）。以下每条都对应一条实测可用的 vm 逃逸——
  // 脚本拿到任何一个外层 realm 的函数或对象，`.constructor.constructor` 就是外层的 Function，
  // `Function("return process")()` 即宿主 process：
  //   1. 沙箱对象必须是 null 原型。外层的 `{}` 会让 context 全局的属性查找落到外层
  //      Object.prototype 上，`globalThis.constructor.constructor` 直接就是外层 Function。
  //   2. __send / __finish 由 BOOTSTRAP 第一句收进闭包并删掉全局；它们只接收字符串、从不强转
  //      别的值（`${symbol}` 会在这里抛出外层 realm 的 TypeError），cell 侧包装再吞掉一切宿主异常。
  //   3. 三个入口（__deliver / __execute / __checkStalled）在脚本运行前取走、此后裸调：现取现调时
  //      脚本能把它们换掉，而 `sandbox.__deliver(line)` 还会把外层的沙箱对象当 `this` 递进去。
  //   4. 不对 cell 的 promise 调 then：脚本能改写 Promise.prototype.then 收到外层回调。收尾改由
  //      cell 调 __finish 通知。
  const sandbox = Object.create(null) as {
    __send: (line: unknown) => void;
    __finish: () => void;
    __argsJson: string;
    __runJson: string;
    __deliver: (line: string) => void;
    __execute: (runFn: unknown) => Promise<void>;
    __checkStalled: () => boolean;
  };
  sandbox.__argsJson = JSON.stringify(payload.args ?? {});
  sandbox.__runJson = JSON.stringify(payload.run);
  sandbox.__send = (line) => {
    if (typeof line === "string") deps.stdout.write(line + "\n");
  };
  // 脚本执行终结（complete 已发出）时 cell 调 __finish：关 stdin、兑现 childMain 的返回值。
  let settleExecution: (() => void) | undefined;
  const execution = new Promise<void>((resolve) => {
    settleExecution = resolve;
  });
  sandbox.__finish = () => {
    reader.close();
    settleExecution?.();
  };
  deps.vm.createContext(sandbox, { name: "workflow-sandbox" });
  deps.vm.runInContext(BOOTSTRAP, sandbox, { filename: "workflow-bootstrap.js" });
  deps.vm.runInContext(deps.streamsBootstrap, sandbox, { filename: "workflow-streams.js" });
  // 引导完成、脚本尚未编译：此刻取走的三个入口都是 bootstrap 自己的函数（见上方第 3 条）。
  const deliver = sandbox.__deliver;
  const execute = sandbox.__execute;
  const checkStalled = sandbox.__checkStalled;

  // 编译 lowered 函数体（context-native async fn；其 await 产生 context Promise，import() 无回调将抛错）。
  let runFn: unknown;
  try {
    runFn = deps.vm.runInContext(`(async (__host) => {\n${payload.lowered}\n})`, sandbox, {
      filename: "workflow-script.js",
    });
  } catch (error) {
    // lowered 体编译失败：发 error-complete 后直接终结。刻意**不**调 process.exit——写往管道的
    // stdout 是异步的，立即 exit 会截断刚发出的那条 complete（父进程转而只看到"退出而未完成"，
    // 丢掉 SyntaxError 明细）。此时事件循环里没有 reader，子进程冲刷完就自然退出。
    const err = error as { name?: string; message?: string; stack?: string } | undefined;
    deps.stdout.write(
      `${JSON.stringify({
        kind: "complete",
        ok: false,
        error: {
          name: err?.name ?? "SyntaxError",
          message: err?.message ?? String(error),
          stack: err?.stack,
        },
      })}\n`,
    );
    return Promise.resolve();
  }

  // stdin 持有事件循环存活；每行喂给 context 的 deliver。
  const reader = deps.createInterface({ input: deps.stdin });
  // 停滞检测（execution-engine.md「The vm cell」）：每条 response 投递后、以及脚本起步后，
  // 各在 **setImmediate** 上问一次 cell「还有事可做吗」。setImmediate 排在本轮全部微任务
  // 之后——response 能触发的每个 continuation 都已跑完——而 cell 内没有定时器与 I/O，所以
  // 「无在飞请求且未完成」在这一刻成立就永远成立。命中时 cell 已发 error-complete；这里只
  // 收 reader（execute 永远不会走到 __finish，收尾得由这条路来做）。setImmediate 是 Node 全局，
  // 两条启动路（入口文件自启 / SEA 子命令）都在 Node 里，符合本函数的自包含约束。
  // ⚠ 两处直接内联 setImmediate 而不是抽成 `const scheduleStallCheck = …`：一个能推导出名字的
  // 内层函数会被 minify + keepNames 套上模块作用域的 `__name` helper（见函数上方那条注释），
  // tests/child-source-bundled.test.ts 抓过这一条。
  reader.on("line", (line: string) => {
    if (!line.trim()) return;
    deliver(line);
    setImmediate(() => {
      if (checkStalled()) reader.close();
    });
  });

  // 跑脚本；返回的 cell promise 刻意丢弃（见上方第 4 条），收尾走 __finish。进程随空闲事件循环
  // 自然退出（父进程亦会在收到 complete 后 kill）。
  void execute(runFn);
  setImmediate(() => {
    if (checkStalled()) reader.close();
  });
  return execution;
}

/** 入口文件名里 runId 的安全字符集之外一律换成 `_`（文件名与头注释共用同一份净化）。 */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * 渲染沙箱入口文件：一份自包含 ESM，harness 把它写到磁盘后以 `node <entry>` 启动。
 *
 * 内容：payload 作为 JSON 字面量（`JSON.stringify` 的输出就是合法的 JS 表达式）、经 `toString()`
 * 内嵌的 {@link childMain}、导出的 `start(deps)`，以及两段顶层逻辑：
 *   - 堆上限 best-effort：缺省路径由真旗标 `--max-old-space-size` 生效；SEA 自 re-exec 传不了
 *     旗标，`execArgv` 里没有它时才 `v8.setFlagsFromString`（效果不保证，与原子命令侧同款）；
 *   - 自启判定：`realpath(argv[1])` 与本文件同一路径时（`node <entry>`）以 process 的
 *     vm/readline/stdio 自启；被 SEA 子命令 `import()` 时判定为假，由子命令调 `start`。
 *     比较 realpath 而不是裸路径：macOS 的 tmpdir 经 `/var → /private/var` 符号链接，
 *     `import.meta.url` 是解析后的真实路径，裸比较会让子进程静默不启动。
 *
 * 唯一的插值是 childMain 的源文本与 payload JSON。childMain 自己带着模板字面量不成问题——插值是
 * **运行期的字符串拼接**，嵌进来的文本不会被再解析一次；真正的风险在 childMain 的自包含约束
 * 那一侧（见其注释）。生成的顶层代码刻意不用模板字面量，免得与外层的 `${}` 打架。
 */
export function renderChildEntry(payload: ChildPayload, meta: { runId: string }): string {
  const runId = safeRunId(meta.runId);
  return `// zcode dynamic workflow run ${runId}
// Generated by @zcode/dynamic-workflow-runtime before every launch; safe to delete once the run has settled.
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import vm from "node:vm";

export const payload = ${JSON.stringify(payload)};

// cell 的第二段引导脚本（channel / future / 停滞检测），与 payload 同样以字面量内嵌。
export const streamsBootstrap = ${JSON.stringify(CELL_STREAMS_BOOTSTRAP)};

const main = ${childMain.toString()};

export const start = (deps) => main({ ...deps, payload, streamsBootstrap });

if (
  typeof payload.maxOldSpaceSizeMb === "number" &&
  Number.isFinite(payload.maxOldSpaceSizeMb) &&
  payload.maxOldSpaceSizeMb > 0 &&
  !process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
) {
  try {
    setFlagsFromString("--max-old-space-size=" + Math.trunc(payload.maxOldSpaceSizeMb));
  } catch {
    // best-effort：V8 对启动期已消费的旗标可能不再理会，失败不得影响 run。
  }
}

let isProcessEntry = false;
try {
  isProcessEntry =
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isProcessEntry = false;
}
if (isProcessEntry) {
  void start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout });
}
`;
}
