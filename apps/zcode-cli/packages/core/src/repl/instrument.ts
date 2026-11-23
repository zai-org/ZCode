import { parseModule, type ESTree } from "meriyah";

/**
 * REPL 代码 instrument 纯函数集（路线 B：顶层绑定跨调用持久）。
 *
 * 设计动机：
 * NodeReplSession 为支持 top-level await 把用户代码包进 `(async () => {...})()`，导致顶层
 * `const/let/var/function/class` 被 IIFE 局部作用域捕获、不落持久 vm context。这里用 meriyah
 * 解析出顶层声明，在每条声明语句后注入 `globalThis.<name> = <name>;`，把绑定复制到持久 context，
 * 使下次 `js` 调用里 bare 名字能经作用域链解析到 globalThis。
 *
 * 本模块是 A-ready 接缝：将来若能加 `--experimental-vm-modules` 升级到 SourceTextModule（路线 A），
 * 只需替换执行器并新写 harvest 版 instrument，`parseReplCode`/`collectTopLevelBindingNames` 可直接复用
 * （parser 换实现只动 parseReplCode 内部）。
 */

/** parseReplCode 结果：成功携带 AST，失败携带 parseError（不 throw，交调用方回退）。 */
export type ParseReplCodeResult = { ast: ESTree.Program } | { parseError: Error };

/**
 * 解析 REPL 代码为 ESTree AST。封装 meriyah.parseModule（parser 换实现只动这里 = A-ready 接缝）。
 * 用 module 模式 + next 拿最新语法；ranges 让每个节点带 start/end（instrument 切片需要）。
 * 解析失败返回 { parseError }，绝不 throw（调用方据此回退到原样执行）。
 */
export function parseReplCode(code: string): ParseReplCodeResult {
  try {
    const ast = parseModule(code, { next: true, ranges: true });
    return { ast };
  } catch (error) {
    return { parseError: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * 递归收集一个 binding pattern 里声明的所有标识符名。
 * 覆盖：Identifier / ObjectPattern（含 shorthand 与 RestElement）/ ArrayPattern（含空位与 RestElement）
 * / AssignmentPattern（默认值）/ RestElement。
 */
function collectPatternNames(node: ESTree.Node | null | undefined, out: string[]): void {
  if (!node) {
    // ArrayPattern 里的空位（elision）是 null，跳过。
    return;
  }
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        // meriyah 在 pattern 上下文实际产出 RestElement/Property，但类型标注较宽
        // （ObjectLiteralElementLike 含 SpreadElement），故按 type 逐一收窄。
        const p = prop as ESTree.Node;
        if (p.type === "RestElement") {
          collectPatternNames(p.argument, out);
        } else if (p.type === "Property") {
          // 解构目标是 value（`{x:xx}` 的 xx；shorthand `{x}` 的 value 也是 x）。
          collectPatternNames(p.value as ESTree.Node, out);
        } else if (p.type === "SpreadElement") {
          // 防御性：pattern 里罕见地被标为 SpreadElement 时也收集其 argument。
          collectPatternNames(p.argument as ESTree.Node, out);
        }
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements) {
        collectPatternNames(el, out);
      }
      return;
    case "AssignmentPattern":
      // `const {x = 1} = o` / `const [a = 1] = arr`：绑定名在 left。
      collectPatternNames(node.left, out);
      return;
    case "RestElement":
      collectPatternNames(node.argument, out);
      return;
    default:
      // MemberExpression 等非声明目标（解构赋值到已存在属性）不产生新绑定，忽略。
      return;
  }
}

/** 收集单条顶层声明语句声明的所有绑定名（供 instrument 逐语句注入用）。 */
function collectStatementBindingNames(node: ESTree.Node): string[] {
  const names: string[] = [];
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      collectPatternNames(decl.id, names);
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    if (node.id) {
      names.push(node.id.name);
    }
  }
  return names;
}

/**
 * 把 cell 里的动态 import() 改写为注入的 importModule()。
 * vm.Script 默认不能直接执行 import expression，因此执行器使用宿主 loader，并只替换
 * AST 中真正的 ImportExpression；字符串、注释和 import.meta 不受影响。
 */
export function collectTopLevelBindingNames(ast: ESTree.Program): string[] {
  const names: string[] = [];
  for (const stmt of ast.body) {
    for (const name of collectStatementBindingNames(stmt)) {
      names.push(name);
    }
  }
  // 去重（同名重复声明或多语句同名只需一次赋值）。
  return [...new Set(names)];
}

/**
 * 把 cell 里的动态 `import(...)` 改写为注入的 `importModule(...)`。
 *
 * Node 的 vm.Script 只有配置 vm module loader 才能直接执行 import expression，而 desktop/SEA
 * Agent 不能稳定携带 `--experimental-vm-modules`。旧合同因此要求模型写 ZCode 私有
 * `importModule(...)`，与 skill 里通用的标准 `await import(...)` 写法不一致。AST 定位只替换真正的
 * ImportExpression，字符串、注释和 `import.meta` 均不受影响。
 */
export function rewriteDynamicImports(code: string, ast: ESTree.Program): string {
  const starts: number[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { type?: unknown; start?: unknown; range?: unknown };
    if (node.type === "ImportExpression") {
      const start =
        typeof node.start === "number"
          ? node.start
          : Array.isArray(node.range) && typeof node.range[0] === "number"
            ? node.range[0]
            : undefined;
      if (start !== undefined) starts.push(start);
    }
    for (const child of Object.values(value as Record<string, unknown>)) visit(child);
  };
  visit(ast);
  let rewritten = code;
  for (const start of starts.sort((left, right) => right - left)) {
    rewritten = `${rewritten.slice(0, start)}importModule${rewritten.slice(start + "import".length)}`;
  }
  return rewritten;
}

/**
 * 按 REPL 语法改写动态 import。用户代码允许顶层 return，而 module parser 不允许；直接解析失败时
 * 临时包进 async function 只用于取得可靠 AST range，再剥掉包装层。这样不会退回正则替换，也不会
 * 误改字符串或注释中的 `import(`。
 */
export function rewriteDynamicImportsForRepl(code: string): string {
  const direct = parseReplCode(code);
  if ("ast" in direct) return rewriteDynamicImports(code, direct.ast);

  const prefix = "(async () => {\n";
  const suffix = "\n})";
  const wrapped = `${prefix}${code}${suffix}`;
  const wrappedParsed = parseReplCode(wrapped);
  if (!("ast" in wrappedParsed)) return code;
  const rewritten = rewriteDynamicImports(wrapped, wrappedParsed.ast);
  return rewritten.slice(prefix.length, rewritten.length - suffix.length);
}

/** 取节点结束偏移；ranges:true 下 end 必然存在，缺省兜底避免类型收窄问题。 */
function nodeEnd(node: ESTree.Node): number {
  const end = node.end ?? node.range?.[1];
  if (end === undefined) {
    throw new Error("instrument requires node end (parseReplCode must use ranges: true)");
  }
  return end;
}

/** 取节点起始偏移；同 nodeEnd，用于最后表达式语句的完成值切片。 */
function nodeStart(node: ESTree.Node): number {
  const start = node.start ?? node.range?.[0];
  if (start === undefined) {
    throw new Error("instrument requires node start (parseReplCode must use ranges: true)");
  }
  return start;
}

/**
 * 在每条顶层声明后把绑定复制到持久 context，并把最后一条表达式语句转成 return，使 cell
 * 的完成值可回传。逐语句注入保证后续语句抛错时，抛错前已执行的声明仍然保留。
 */
export function instrumentForContextPersistence(code: string, ast: ESTree.Program): string {
  let cursor = 0;
  let out = "";
  const lastIndex = ast.body.length - 1;
  ast.body.forEach((stmt, index) => {
    // 最后一条顶层表达式语句：转成 return，让 async-IIFE 回传完成值（REPL 回显）。
    // 声明/控制流语句不转（其完成值本就是 undefined，REPL 语义一致）。
    if (index === lastIndex && stmt.type === "ExpressionStatement") {
      const stmtStart = nodeStart(stmt);
      const stmtEnd = nodeEnd(stmt);
      // meriyah 对 `({ value: 1 })` 的 expression range 不含最外层括号。
      // 从 expression.start 插入 return 会生成 `(return ({...});)` 非法语法；必须以完整
      // ExpressionStatement 为边界，再仅移除语句末尾分号。
      const expressionSource = code.slice(stmtStart, stmtEnd).replace(/;\s*$/, "");
      // 保留该语句前的原始 trivia（空白/注释），再把完整表达式包成 return (...)。
      out += code.slice(cursor, stmtStart);
      out += `return (${expressionSource});`;
      cursor = nodeEnd(stmt);
      return;
    }
    const end = nodeEnd(stmt);
    // 保留到该语句结束的原始片段（含前导空白/注释与语句本身）。
    out += code.slice(cursor, end);
    cursor = end;
    const names = collectStatementBindingNames(stmt);
    if (names.length > 0) {
      const assigns = names.map((name) => `globalThis.${name}=${name};`).join("");
      out += `;${assigns}`;
    }
  });
  // 保留最后一条语句之后的尾部原始片段。
  out += code.slice(cursor);
  return out;
}
