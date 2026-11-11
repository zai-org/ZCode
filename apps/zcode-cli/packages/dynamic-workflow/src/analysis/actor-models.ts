/**
 * 子代理模型的编译期规则（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」；
 * docs/analysis.md「Diagnostics」的 9010 行）。
 *
 * 规则只有一句：**一个脚本能交给子代理的模型名，在运行前就是一个封闭集合**。launch 工具据此在确认窗
 * 之前把每个名字对着宿主的模型目录解析一遍（docs/dynamic-workflow/launch.md「Models the script
 * names」），窗上显示的就是将要生效的模型，解不出来的名字作为 9011 退回、什么都不跑。
 *
 * 集合的两个来源：
 *
 * 1. `model("…")` 调用的实参——必须是非空的无洞字符串字面量（9010）。`ModelRef` 只能由它造出
 *    （facade 里是私有构造器 + 私有成员的 class，`new` 与对象字面量都造不出来），所以任何类型为
 *    `ModelRef` 的值都来自某一次 `model()`，名字已经在集合里。
 * 2. 每个 `agent(name, persona)` 站点上 persona 的 `model` 属性的**类型**：必须是 `ModelRef`、
 *    字符串字面量类型，或它们的联合（9010）。联合里的每个字面量成员都进集合。
 *
 * 为什么判**类型**而不是判语法上的字面量：`const FLASH = "…"`、`hard ? "a" : "b"`、`MODELS[k]`
 * 这些写法运行期取哪个值不定，但取值集合 checker 已经算好了——按类型判，一条规则就同时覆盖
 * 内联字面量、const 绑定和三目，而一个被拓宽成 `string` 的值（`let`、参数、带洞模板、先装进
 * 变量的 persona 对象）恰好就是集合不封闭的那一类。
 *
 * 为什么内联的 persona 对象字面量要**按语法取 `model` 的初值表达式**再问它的类型，而不是问整个
 * 对象的类型：对象字面量的属性类型在上下文类型不含字面量类型时会被拓宽（`{ model: "x" }` 在
 * `AgentPersona` 的上下文里，属性类型是 `string`），按对象类型判会把最常见的写法误报掉。初值
 * 表达式自己的类型不受这条拓宽影响。
 *
 * 与 actor-names.ts（9005/9006）不同，本诊断**没有运行期兜底**：下游没有第二处去查「一个子代理的
 * model 可能是什么」。宿主在建会话时查不到绑定只会让那一次 ask 大声失败（只有类型断言能走到那
 * 一步），而那已经是确认窗之后了。所以这里宁可多报，不可漏报。
 *
 * 顺带：`ModelRef` 在运行期不存在（lowering 把 `model("x")` 抹成 `"x"`，沙箱里没有这个 class），
 * 所以脚本在**值位置**引用 `ModelRef`（`x instanceof ModelRef`）也在这里以 9010 报出，
 * 而不是留成一个运行期 ReferenceError。
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import { facadeMemberOf, valueFunctionOfSymbol } from "../facade/registry.js";
import { findWorkflowBody, resolveSymbol, type SiteTable } from "./sites.js";

/** 模型名不封闭（persona 的 `model` 类型、`model()` 的实参、值位置的 `ModelRef`）。 */
export const MODEL_REFERENCE_CODE = 9010;

/**
 * 脚本里的模型名在宿主的模型目录里解析不出来（没有、歧义、被停用、档位不对）。**不是**本包产出的
 * 诊断——编译器不知道宿主配了哪些模型——而是 launch 工具（packages/core）在 `resolveInput` 之后
 * 按 {@link ModelReference} 的位置报出来的；码放在这里，好让两处共用一个数、诊断表只有一份。
 */
export const MODEL_UNRESOLVED_CODE = 9011;

/** 脚本能交给子代理的一个模型名，及它在脚本里出现的一处位置。 */
export interface ModelReference {
  /** 名字，**逐字**如脚本所写：运行期 persona 里带的就是这个串，launch 的绑定表以它为键。 */
  name: string;
  line: number;
  column: number;
}

export interface ActorModels {
  /** 每处出现一条，按发现顺序（`model()` 调用在前，其后是各 `agent()` 站点）。 */
  references: ModelReference[];
  /** 9010；非空即脚本不可提交。 */
  diagnostics: CompileDiagnostic[];
}

/** 被拒的 `model` 值的统一说明：给出三种改法，好让作者一次改对。 */
const WIDENED_MODEL_MESSAGE =
  "A subagent's `model` must be known before the run starts: a string literal, a union of " +
  'string literals, or a ModelRef from model("…"). This value\'s type is {type}, which could ' +
  "be any model name. Write the name inline, add `as const` where it is declared, or declare " +
  "the candidates with model() and choose among those ModelRefs at run time.";

const MODEL_CALL_MESSAGE =
  "model() takes the model name as a non-empty string literal (a model id or " +
  '"providerId/modelId", optionally with "$level"): every model a script can use is checked ' +
  "against the configured models before the run starts. Put runtime choices in which ModelRef " +
  "you pass, not in the name.";

const MODEL_REF_VALUE_MESSAGE =
  "ModelRef exists only as a type: at run time a ModelRef is its model name. Use it in type " +
  "positions only; compare ModelRefs directly or keep a table keyed by your own choice.";

/** 收集模型名集合与 9010 诊断。只在编译干净的程序上调用。 */
export function collectActorModels(workflow: WorkflowProgram, table: SiteTable): ActorModels {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const references: ModelReference[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const locOf = (node: ts.Node): ScriptLoc => toScriptLoc(node.getStart(scriptFile));
  const report = (at: ts.Node, message: string): void => {
    const loc = locOf(at);
    diagnostics.push({ code: MODEL_REFERENCE_CODE, column: loc.column, line: loc.line, message });
  };
  const collect = (name: string, at: ts.Node): void => {
    const loc = locOf(at);
    references.push({ column: loc.column, line: loc.line, name });
  };

  // 1. model() 调用与值位置的 ModelRef：一趟走完整个脚本体（含嵌套函数——模型表常在顶层，
  //    但写在 helper 里的 model() 同样在集合里）。
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (valueFunctionOfSymbol(resolveSymbol(node.expression, checker)) === "model") {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg) && arg.text.trim().length > 0) {
          collect(arg.text, arg);
        } else {
          report(arg ?? node, MODEL_CALL_MESSAGE);
        }
      }
    } else if (ts.isIdentifier(node) && isModelRefClass(resolveSymbol(node, checker))) {
      if (!isTypePosition(node)) report(node, MODEL_REF_VALUE_MESSAGE);
    }
    ts.forEachChild(node, walk);
  };
  walk(findWorkflowBody(scriptFile));

  // 2. 每个 agent() 站点上 persona 的 model。
  const checkModelValue = (expr: ts.Expression, type: ts.Type): void => {
    const members = type.isUnion() ? type.types : [type];
    for (const member of members) {
      // 可选属性带进来的 undefined = 「没选模型」，不是一个名字。
      if ((member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) continue;
      if (isModelRefType(member)) continue;
      if (member.isStringLiteral()) {
        if (member.value.trim().length > 0) {
          collect(member.value, expr);
          continue;
        }
      }
      report(expr, WIDENED_MODEL_MESSAGE.replace("{type}", `'${checker.typeToString(type)}'`));
      return;
    }
  };

  const checkPersona = (persona: ts.Expression): void => {
    if (ts.isParenthesizedExpression(persona)) {
      checkPersona(persona.expression);
      return;
    }
    if (ts.isConditionalExpression(persona)) {
      checkPersona(persona.whenTrue);
      checkPersona(persona.whenFalse);
      return;
    }
    if (ts.isObjectLiteralExpression(persona)) {
      const modelExpr = lastPropertyInitializer(persona, "model");
      if (modelExpr === "spread") {
        checkPersonaType(persona);
      } else if (modelExpr !== undefined) {
        checkModelValue(modelExpr, initializerValueType(modelExpr, checker));
      }
      return;
    }
    checkPersonaType(persona);
  };

  // 不是内联对象字面量：按实参的类型取 model 属性。字符串 persona（= system prompt）没有 model。
  const checkPersonaType = (persona: ts.Expression): void => {
    const type = checker.getTypeAtLocation(persona);
    const members = type.isUnion() ? type.types : [type];
    for (const member of members) {
      if ((member.flags & ts.TypeFlags.StringLike) !== 0) continue;
      const property = checker.getPropertyOfType(member, "model");
      if (property === undefined) continue;
      checkModelValue(persona, checker.getTypeOfSymbolAtLocation(property, persona));
    }
  };

  for (const site of table.actors) {
    const persona = site.call.arguments[1];
    if (persona !== undefined) checkPersona(persona);
  }

  return { diagnostics, references };
}

/**
 * 内联对象字面量里**最后一次**写下的 `key` 属性的初值表达式。它之后若还有展开，展开可能盖掉它，
 * 回 `"spread"` 交给按类型的判定；从没写过 `key` 但有展开时同样回 `"spread"`；两者都没有即 undefined。
 * persona 的 `model`（9010）与 `budget.webSearch`（9013，actor-budgets.ts）共用。
 */
export function lastPropertyInitializer(
  literal: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | "spread" | undefined {
  let found: ts.Expression | "spread" | undefined;
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      found = "spread";
    } else if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === key) {
      found = property.initializer;
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) {
      found = property.name;
    }
  }
  return found;
}

/** 初值表达式自己的类型（不经对象字面量的属性拓宽）；shorthand `{ model }` 取被引用绑定的类型。 */
export function initializerValueType(expr: ts.Expression, checker: ts.TypeChecker): ts.Type {
  const parent = expr.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === expr) {
    const value = checker.getShorthandAssignmentValueSymbol(parent);
    if (value !== undefined) return checker.getTypeOfSymbolAtLocation(value, expr);
  }
  return checker.getTypeAtLocation(expr);
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** facade 里的 `ModelRef` class 符号。 */
function isModelRefClass(symbol: ts.Symbol | undefined): boolean {
  const member = facadeMemberOf(symbol);
  return (
    member !== undefined &&
    member.container === undefined &&
    member.member === "ModelRef" &&
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Class) !== 0
  );
}

/** 这个类型就是 facade 的 `ModelRef`（它的实例类型）。 */
function isModelRefType(type: ts.Type): boolean {
  return isModelRefClass(type.getSymbol());
}

/** 标识符处在类型位置（`x: ModelRef`、`typeof ModelRef`、`A.ModelRef` 的限定名链上）。 */
function isTypePosition(node: ts.Identifier): boolean {
  let parent: ts.Node = node.parent;
  while (ts.isQualifiedName(parent)) parent = parent.parent;
  return ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
}
