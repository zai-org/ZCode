import { collectDiagnostics, createWorkflowProgram } from "../compiler/compile.js";
import type { CompileDiagnostic } from "../compiler/compile.js";
import { collectSites } from "./sites.js";
import { collectFacadeMisuse } from "./facade-misuse.js";
import { collectWorldRunCommands } from "./world-run.js";
import { collectArtifactDeclarations, type DeclaredArtifact } from "./artifacts.js";
import { collectPhaseMarkerDiagnostics } from "./phases.js";
import { collectHoleDiagnostics } from "./hole-sites.js";
import { collectDuplicateActorNames, FANOUT_ACTOR_NAME_CODE } from "./actor-names.js";
import { collectActorBudgetDiagnostics } from "./actor-budgets.js";
import { collectActorModels, type ModelReference } from "./actor-models.js";
import { interpret } from "./interpret.js";
import { projectSiteGraph } from "./graph.js";
import { projectCausalityGraph, type CausalityGraph } from "./causality-graph.js";
import { projectControlFlow, type ControlFlowGraph } from "./flow-graph.js";
import { projectHandoffGraph, type HandoffGraph } from "./handoff-graph.js";
import type { AnalysisCore } from "./core.js";
import type { SiteGraph } from "./types.js";

/**
 * Result of analyzing a workflow script: the same diagnostics `compileWorkflowScript`
 * produces, plus the analysis core and its two projected views.
 *
 * `ok` means "submittable": any diagnostic clears it. The core and the graphs are present
 * whenever the script was analyzable at all, which is *almost* the same thing — the one
 * diagnostic that leaves them in place is {@link FANOUT_ACTOR_NAME_CODE} (a static actor
 * name inside a fan-out). That clause describes a **run-time** failure, not something that
 * stops the analysis: the shape is perfectly analyzable, and withholding the graph would
 * hide the picture exactly when the author needs it to see which fan-out to fix. So:
 * graphs present ⟸ ok, but not the converse.
 */
export interface AnalyzeResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
  /**
   * The all-in-one analysis artifact: taint
   * facts + temporal trace, position-free. `graph` and `causality` are pure projections
   * of it — deriving them again later needs the core only, never the script.
   */
  core?: AnalysisCore;
  graph?: SiteGraph;
  /** The presentation-level happens-before view. */
  causality?: CausalityGraph;
  /** Where execution can go next, per occurrence and per phase. */
  flow?: ControlFlowGraph;
  /** Who takes part in each phase and who hands off to whom. */
  handoff?: HandoffGraph;
  /**
   * 脚本声明的**用户面产物**：`[{id, kind}]`，去重、按 id
   * 排序。与 world.run 的命令集同族的编译产物——运行前就能说出这个工作流会产出什么。
   * 与图不同，它在诊断非空时**照常给出**（它是从站点表直接读的事实，不依赖解释）。
   */
  declaredArtifacts: DeclaredArtifact[];
  /**
   * 脚本能交给子代理的每个模型名，每处出现一条（docs/dynamic-workflow/authoring.md「Choosing a
   * model per subagent」）。launch 工具在确认窗之前把它们对着宿主的模型目录解析
   * （docs/dynamic-workflow/launch.md「Models the script names」）。与 `declaredArtifacts` 同规：
   * 编译不过时是空数组，authoring 诊断在场时照常给出。
   */
  modelReferences: ModelReference[];
}

/**
 * Typecheck a workflow script and, when clean, interpret it. The pipeline is
 * createWorkflowProgram -> collectSites (the site-table substrate) -> interpret (the
 * fused taint-fixpoint + temporal walk, minting the {@link AnalysisCore}) ->
 * projectSiteGraph / projectCausalityGraph (pure projections of the core).
 *
 * Between the site table and the interpretation runs the facade-siting check
 * ({@link collectFacadeMisuse}): a facade callable that escapes into value space has
 * no site, so the graph cannot represent it. Its diagnostics are surfaced exactly like
 * typechecker diagnostics — `ok: false`, graphs withheld.
 */
export function analyzeWorkflowScript(scriptText: string): AnalyzeResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  // 编译不过 / facade 逃逸时连站点表都不可信，产物清单只能是空的（缺省而不是缺席：读者
  // 拿到的永远是一个数组，不必在每个消费点分辨"没有产物"与"没能分析"）。
  if (diagnostics.length > 0) {
    return { declaredArtifacts: [], diagnostics, modelReferences: [], ok: false };
  }

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) {
    return { declaredArtifacts: [], diagnostics: misuse, modelReferences: [], ok: false };
  }

  // world.run 的字面量 cmd 检查与 misuse 同席：一个运行期才成形的命令没有可展示的授权
  // 对象（确认窗展示的命令集在编译期闭合），所以它和「facade 调用必须有站点」一样是
  // 编译期教改写的那类错误。phase 标记同理：非字面量
  // 名字与非语句位置的标记都没有可指的东西。
  // 字面量 actor 重名同席：规则的正门在运行期（引擎 createActor 的 DuplicateActorName），
  // 这一趟只是把字面量能看穿的那部分提前到便宜的一侧。
  // 三趟一起报——作者一次就能看全要改什么。
  const worldRun = collectWorldRunCommands(workflow, table);
  // 产物的编译期规则同席：id 是编译期字面量、标签指向一个
  // 已声明的预置、同 id 不横跨两种成员——三条都是「运行期才炸不如现在就教改写」的那一类。
  const artifacts = collectArtifactDeclarations(workflow, table);
  // 子代理模型名集合的封闭性（9010）同席：一个运行期才成形的模型名没有可在确认窗之前解析、
  // 展示的对象（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
  const models = collectActorModels(workflow, table);
  const authoring = [
    ...worldRun.diagnostics,
    ...artifacts.diagnostics,
    ...models.diagnostics,
    // 子代理工具预算（9013）同席：确认窗里的脚本写明每个子代理能搜多少次
    // （docs/dynamic-workflow/authoring.md「A subagent's search budget」）。
    ...collectActorBudgetDiagnostics(workflow, table),
    ...collectPhaseMarkerDiagnostics(workflow, table),
    // 留白的编译期规则（9012）同席（docs/dynamic-workflow/authoring.md「Holes」）。
    ...collectHoleDiagnostics(workflow, table),
    ...collectDuplicateActorNames(workflow, table),
  ];
  // fan-out 里的静态 actor 名（9006）是这批里唯一**不扣下图**的一条：它说的是这个脚本跑起来
  // 会撞 DuplicateActorName，而不是「这段代码没法分析」——形状本身完全可分析，把图扣下来只会
  // 在作者最需要看图定位是哪个 fan-out 的时候把图拿走。它照常清掉 `ok`（提交仍被挡住）。
  // 顺带的好处：分析语料因此还能钉住「fan-out 里的静态名」这个形状的图产物，否则一条挡路的
  // 编译期诊断会让它自己的形状在语料里变得不可表达。
  const withholding = authoring.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
  if (withholding.length > 0) {
    return {
      declaredArtifacts: artifacts.declaredArtifacts,
      diagnostics: authoring,
      modelReferences: models.references,
      ok: false,
    };
  }

  // One interpretation feeds everything: the core carries the taint facts AND the
  // temporal trace, and both graphs project off it without touching the AST again.
  const core = interpret(workflow, table);
  const graph = projectSiteGraph(core);
  const causality = projectCausalityGraph(core, graph);
  return {
    causality,
    core,
    declaredArtifacts: artifacts.declaredArtifacts,
    diagnostics: authoring,
    flow: projectControlFlow(core),
    graph,
    handoff: projectHandoffGraph(core, causality, graph),
    modelReferences: models.references,
    ok: authoring.length === 0,
  };
}
