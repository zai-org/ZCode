# NodeReplSession 引擎规格（T1，通用基建）

> 状态：已实现。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`。
> 范围：agent 进程内的**持久 JS 执行引擎**，与 browser 完全解耦（无 browser 也可用）。本文定义 node_repl 的执行语义。

## 1. 范围与落点

- 文件：`apps/zcode-cli/packages/core/src/repl/node-repl-session.ts`（新）。
- 纯引擎，不含工具定义（工具在 T2）。可被最小单测（`packages/core/tests/node-repl-session.test.ts`）。
- 每个 zcode session 一个 `NodeReplSession` 实例；由 T2 的 handler 用 `Map<sessionId, NodeReplSession>` 管理（挂 agent runtime 生命周期）。

## 2. 执行语义

- **持久上下文**：`node:vm` 的 `vm.createContext(replGlobals)`。replGlobals 对象即模型看到的 `globalThis`，session 内长期持有。
- **跨调用状态**：`globalThis.x = ...` 或 `replGlobals` 上的属性跨多次 `run()` 保持；顶层 `let/const/function` **不**跨调用（vm 每次 runInContext 是独立 script scope——模型要持久就挂 globalThis）。
- **顶层 await**：把用户代码包成 `(async () => { <code> })()`，`vm.runInContext` 返回该 promise，await 之。
- **动态加载模块**：底层仍注入 `importModule(specifier)`（直通宿主 `import()`）；2026-07-13 起执行器会基于 AST 把用户代码的标准 `await import(...)` 改写到该 loader，因此 skill 与模型合同统一使用标准 `await import(...)`，不暴露私有 helper。
- **模块目录**：`addModuleDir(dir)` 累加到列表；相对 specifier 基于已注册目录解析。

## 3. 接口草案

```ts
export interface NodeReplWriteSink {
  write(text: string): void;
}

export interface NodeReplRunResult {
  /** 表达式/最后值的字符串化（可能为 undefined）。 */
  result?: string;
  /** 本次 run 期间 nodeRepl.write + console 收集的输出。 */
  logs: string;
  /** 抛错时的结构化错误（不崩进程）。 */
  error?: { name: string; message: string; stack?: string };
}

export interface NodeReplSessionOptions {
  /** 注入到 REPL globals 的额外全局（如 browser execute 桥、agent 对象）。 */
  injectedGlobals?: Record<string, unknown>;
  /** 模块解析基准目录（js_add_node_module_dir 累加）。 */
  moduleDirs?: string[];
}

export class NodeReplSession {
  constructor(options?: NodeReplSessionOptions);
  /** 执行一段代码；signal 支持取消（超时/停止）。 */
  run(code: string, options?: { signal?: AbortSignal }): Promise<NodeReplRunResult>;
  /** 丢弃并重建 context，清空所有跨调用状态。 */
  reset(): void;
  /** 追加模块解析目录。 */
  addModuleDir(dir: string): void;
  /** 释放资源。 */
  dispose(): void;
}
```

## 4. REPL 内建全局

vm context 只用于隔离每次调用的全局状态，不是安全沙箱：cell 与 agent 同权，可加载任意 Node 模块。

注入到 vm context 的 REPL globals：`console`（tee 到 sink）、`process`、`Buffer`、`URL`、`URLSearchParams`、`TextEncoder`/`TextDecoder`、`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`queueMicrotask`、`structuredClone`、`require`（宿主 createRequire）、`nodeRepl: { write }`（sink）、以及 `injectedGlobals`（含 browser `execute`、`agent` 骨架）。`globalThis` 自引用指向这份 REPL globals。

## 5. 输出与错误

- **logs**：本次 run 内 `nodeRepl.write(...)` 与 `console.log/info/warn/error` 追加到 buffer，run 结束作 `logs` 返回。空则空串。
- **result**：run 的返回值（async IIFE resolve 值）若非 undefined，安全字符串化（JSON 优先，循环引用/函数降级 `String()`）。
- **error**：run 抛错（含 reject）→ try/catch 捕获 → `{name,message,stack}` 结构化返回，**绝不 throw 出引擎**（保证 agent 进程不崩）。
- **AbortSignal**：signal abort 时尽力中断（vm 无强制中断，靠约定 + 超时；`run` 竞速 signal 的 abort promise，abort 后返回 `error:{name:"AbortError"}`）。注意 vm 死循环无法真正中断——由 T2 工具层的 timeout + 文档约束缓解，本引擎只保证 abort 后 result 不再被采用。

## 6. 验证点（T1 单测，纯，无 browser）

- `globalThis.x=1` 后下一次 run 读到 `x===1`（跨调用持久）。
- `reset()` 后 `x` 消失。
- 顶层 await：`return await Promise.resolve(42)` → result "42"。
- `nodeRepl.write("hi")` → logs 含 "hi"；`console.log("yo")` → logs 含 "yo"。
- 抛错：`throw new Error("boom")` → error.message "boom"，不 throw 出。
- 动态 import：`const m = await import("node:path"); return m.sep` → result 正常。
- injectedGlobals：注入 `{ping:()=>"pong"}`，run `return ping()` → "pong"。
- addModuleDir 累加、dispose 幂等。
