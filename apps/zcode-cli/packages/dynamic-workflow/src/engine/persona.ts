// ============================================================
// actor persona 的两个纯函数：规范化（createActor）与缓存身份（matchImportedActor）
// ============================================================
// 从 engine.ts / imported-cache.ts 拆出：两者都是「persona 里哪些东西算数」的回答，住在一处才不会
// 一边加了字段、另一边忘了排除（docs/execution-engine.md「Engine-side persona」）。

import { MAX_WEB_SEARCH_BUDGET_PER_ASK, type PersonaBudget, type PersonaSpec } from "./types.js";

/**
 * persona 规范化：字符串视为 system prompt；display name 落到 persona.name。
 *
 * 对象 persona 只取认得的键（`budget` 只收合法整数，其余只收字符串值）：它来自沙箱的线上 JSON，而 persona 会原样落进
 * journal、进缓存比对与宿主的建会话路径——一个脚本经类型断言塞进来的怪值（`model: 42`、多余
 * 的键）不该一路搬下去。`model` 缺席即「跑 run 的子代理模型」。
 */
export function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec = {};
  if (typeof persona === "string") {
    base.system = persona;
  } else if (persona !== null && typeof persona === "object") {
    if (typeof persona.name === "string") base.name = persona.name;
    if (typeof persona.system === "string") base.system = persona.system;
    if (typeof persona.model === "string") base.model = persona.model;
    const budget = normalizeBudget(persona.budget);
    if (budget !== undefined) base.budget = budget;
  }
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}

/**
 * persona 里参与缓存身份比对的部分：名字与 system prompt，**不含 `model`**
 * （docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
 *
 * 换模型与改 persona 不是一回事：旧 system prompt 产的转录接新 persona 是身份错乱，而「这个
 * 子代理改跑另一个模型」是用户对**接下来**的工作的显式选择——与 `AmendWorkflow` 带
 * `subagent_model` 同一条规则（execution-engine.md「Subagent sessions」）：已完成的活照旧导入，
 * 下一次 live ask 跑在新模型上。把 model 算进身份，改一个裁判的模型就会让它整段重跑。
 */
export function personaIdentity(persona: PersonaSpec): PersonaSpec {
  // `budget` 同理：调大预算是用户对接下来工作的选择（被截断后 amend 加预算），不该让已完成的活重跑。
  const { model: _model, budget: _budget, ...identity } = persona;
  void _model;
  void _budget;
  return identity;
}

/**
 * 只留合法的预算值：0–{@link MAX_WEB_SEARCH_BUDGET_PER_ASK} 的整数。编译期 9013 已挡住其余写法，
 * 走到这里的怪值只可能来自类型断言；丢掉它，该子代理用默认预算。什么都没留下则整个 `budget` 缺席。
 */
function normalizeBudget(budget: unknown): PersonaBudget | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const webSearch = (budget as PersonaBudget).webSearch;
  if (
    typeof webSearch !== "number" ||
    !Number.isInteger(webSearch) ||
    webSearch < 0 ||
    webSearch > MAX_WEB_SEARCH_BUDGET_PER_ASK
  ) {
    return undefined;
  }
  return { webSearch };
}
