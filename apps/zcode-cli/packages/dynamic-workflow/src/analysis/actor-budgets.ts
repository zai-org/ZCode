/**
 * 子代理工具预算的编译期规则（docs/dynamic-workflow/authoring.md「A subagent's search budget」；
 * docs/analysis.md「Diagnostics」的 9013 行）。
 *
 * 规则：persona 的 `budget.webSearch` 在运行前就是已知的数——类型必须是数字字面量类型或它们的
 * 联合，且每个成员都是 0–{@link MAX_WEB_SEARCH_BUDGET_PER_ASK} 的整数。用户在确认窗里看到的脚本
 * 因此写明了每个子代理能搜多少次。
 *
 * 判法与 9010（actor-models.ts）同构：按**类型**判，内联字面量、const 绑定、字面量之间的三目一条
 * 规则全覆盖；被拓宽成 `number` 的值（`let`、参数、先装进变量的 persona 对象）恰好是数不确定的
 * 那一类。内联对象字面量按语法取初值表达式再问它的类型，避开对象字面量在 `number` 上下文里的
 * 属性拓宽——`budget` 嵌一层，所以要连取两级。
 *
 * 运行期兜底：引擎 normalizePersona 丢掉不合法的值（只有类型断言走得到），该子代理用默认预算。
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import { MAX_WEB_SEARCH_BUDGET_PER_ASK } from "../engine/types.js";
import { initializerValueType, lastPropertyInitializer } from "./actor-models.js";
import type { SiteTable } from "./sites.js";

/** persona 的 `budget.webSearch` 不是运行前已知、范围内的整数。 */
export const BUDGET_VALUE_CODE = 9013;

const WIDENED_BUDGET_MESSAGE =
  "A subagent's `budget.webSearch` must be known before the run starts: an integer literal " +
  `from 0 to ${MAX_WEB_SEARCH_BUDGET_PER_ASK}, a const bound to one, or a union of such ` +
  "literals. This value's type is {type}. Write the number inline in the agent() call, or add " +
  "`as const` where it is declared.";

/** 收集 9013 诊断。只在编译干净的程序上调用。 */
export function collectActorBudgetDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const { program, scriptFile, toScriptLoc } = workflow;
  const checker = program.getTypeChecker();
  const diagnostics: CompileDiagnostic[] = [];

  const checkValue = (expr: ts.Expression, type: ts.Type): void => {
    const members = type.isUnion() ? type.types : [type];
    const ok = members.every(
      (member) =>
        // 可选属性带进来的 undefined = 「没写」，走默认预算。
        (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 ||
        (member.isNumberLiteral() && isBudgetValue(member.value)),
    );
    if (ok) return;
    const loc = toScriptLoc(expr.getStart(scriptFile));
    diagnostics.push({
      code: BUDGET_VALUE_CODE,
      line: loc.line,
      column: loc.column,
      message: WIDENED_BUDGET_MESSAGE.replace("{type}", `'${checker.typeToString(type)}'`),
    });
  };

  // 非内联字面量：按类型逐级取 `budget` → `webSearch`。字符串 persona（= system prompt）没有预算。
  const checkByType = (at: ts.Expression, type: ts.Type, path: readonly string[]): void => {
    const members = type.isUnion() ? type.types : [type];
    for (const member of members) {
      if ((member.flags & ts.TypeFlags.StringLike) !== 0) continue;
      const [key, ...rest] = path;
      if (key === undefined) continue;
      const property = checker.getPropertyOfType(member, key);
      if (property === undefined) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, at);
      if (rest.length === 0) {
        checkValue(at, propertyType);
      } else {
        checkByType(at, checker.getNonNullableType(propertyType), rest);
      }
    }
  };

  const checkObject = (expr: ts.Expression, path: readonly string[]): void => {
    if (ts.isParenthesizedExpression(expr)) {
      checkObject(expr.expression, path);
      return;
    }
    if (ts.isConditionalExpression(expr)) {
      checkObject(expr.whenTrue, path);
      checkObject(expr.whenFalse, path);
      return;
    }
    const [key, ...rest] = path;
    if (key === undefined) return;
    if (!ts.isObjectLiteralExpression(expr)) {
      // shorthand `{ budget }` 的名字节点要取被引用绑定的类型，initializerValueType 一并处理。
      checkByType(expr, initializerValueType(expr, checker), path);
      return;
    }
    const initializer = lastPropertyInitializer(expr, key);
    if (initializer === "spread") {
      checkByType(expr, checker.getTypeAtLocation(expr), path);
    } else if (initializer !== undefined) {
      if (rest.length === 0) {
        checkValue(initializer, initializerValueType(initializer, checker));
      } else {
        checkObject(initializer, rest);
      }
    }
  };

  for (const site of table.actors) {
    const persona = site.call.arguments[1];
    if (persona !== undefined) checkObject(persona, ["budget", "webSearch"]);
  }
  return diagnostics;
}

function isBudgetValue(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_WEB_SEARCH_BUDGET_PER_ASK;
}
