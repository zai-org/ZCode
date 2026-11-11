// ============================================================
// Dynamic Workflow Run 的启动执行体（submit 与 resume 的共享半身）
// ============================================================
// submit（新 runId）与 resume（既有 runId，引擎走
// resume 分支）在「装配 driver → 跑 runWorkflowScript」这一段完全同构，抽到本文件共享：
// 两条入口各自维护一份，迟早有一边忘记接事件 sequence 截取或 actor 重水化。
//
// 本文件持有三件事：
//   1. journal sequence 截取（emit 侧拿到刚 append 的那条事件的 sequence）；
//   2. RunEvent → 会话事件载荷（有界化 + 派生字段；实现在 dynamic-workflow-run-progress-payload.ts）；
//   3. actor runtime 的接入：全新（落会话行 + task link）或重水化（resumeFromStore）。

import { randomUUID } from "node:crypto";
import {
  CoreErrorType,
  ZCODE_DWF_CHILD_COMMAND,
  type CreateSessionTaskLinkInput,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import {
  type ActorSubmitProfile,
  refToString,
  validate,
  type ActorRef,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type JournalStorePort,
  type JsonSchema,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import type { CompiledHole } from "./dynamic-workflow-run-holes.js";
import { toProgressPayload } from "./dynamic-workflow-run-progress-payload.js";
import {
  readRunLaunchAnchor,
  readRunModelBindings,
  readRunSubagentModel,
  readRunSubagentPermissionMode,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowDefaultConcurrency } from "./workflow-default-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import { resolveActorPersonaModel } from "./workflow-actor-model.js";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { runBoundTarget, type WorkflowRunControl } from "./workflow-run-control.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

export { toProgressPayload, toProtocolEvent } from "./dynamic-workflow-run-progress-payload.js";

/** 适配包内校验器到引擎的 ValidateFn 契约（launch 是 runWorkflowScript 的唯一调用点）。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** 一次编译的全部产物。四个消费者共用同一个 ts.Program（编译一次，见 run service 不变式 2）。 */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** 每个 actor 站点的 submit profile。 */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
  /** 站点 → 词法出生阶段名（docs/execution-engine.md「Identity: sites, ordinals, phases」）。 */
  sitePhases: ReadonlyMap<string, string>;
  /**
   * 已补全留白的函数体文本（站点 id → `(async () => { … })`；docs/execution-engine.md「The text
   * that runs」）。补全服务把 `holeBodies[siteId]` 交给引擎作为那处留白的 `code`。
   */
  holeBodies: Readonly<Record<string, string>>;
  /** 脚本里每处留白的编译期事实（开放与已补全都在，源码序）：快照与进度载荷的 type / line 来源。 */
  holes: readonly CompiledHole[];
  /**
   * 按控制流投影取的阶段表与其中开放留白的下标（`collectPhaseNames`）。补全服务用它给引擎
   * `fillHole` 的 `phaseNames` / `holes`；launch 的声明表仍来自提交方（工具层从同一份投影算）。
   */
  phases: { phaseNames: string[]; holes: number[] };
}

interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** run 的展示名（`CreateWorkflow` 的可选 `input.name`）：随 EngineConfig 在 createRun 时落 dwf_run.name。 */
  name?: string;
  /**
   * 本次 run 的实参（saved workflow 的已校验实参袋）。两个去处：随 EngineConfig 落
   * `dwf_run.args_json`，以及进 spawn payload 注入沙箱的 `args` 全局。
   *
   * resume 分支传的是**从 journal 读回的那一份**，不是调用方新给的——见 run service 的
   * resume 注释。
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * 修订续跑的 lineage 指针（`dwf_run.resumed_from`）与导入缓存。两者**成对**出现：
   * 指针是行级事实（UI 的「续自 run X」、崩溃后 resume 据它重建），缓存是本次执行的加速结构。
   *
   * 与其余元数据同一条路——launch → harness → EngineConfig，中途零加工。构建（读前驱 journal、
   * 走 `resumed_from` 链、解析转录源）全部发生在 run service：这里已经是执行侧，把构建放进来
   * 就等于让 resume 与 submit 各构建一次（而它们必须是同一个纯函数的两次调用）。
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * 建 run 时的用量起点：前驱结算后的 `spentTokens`。
   * 与 lineage 指针同一条路——launch → harness → EngineConfig，中途零加工；amend 路径给出，
   * 全新 submit 与 resume 缺席（后者的用量从既有行恢复）。
   */
  inheritedTokens?: number;
  /**
   * 发起 run 那一轮的锚点。submit 路径给出（引擎在建 run
   * 那一世记 `run-launched`）；resume 路径缺席，本函数从 journal 读回——两条路径都用同一个值给
   * `actor-created` / `run-settled` 进度事件派生 `launchInputId`。submit 路径还随车带脚本声明的
   * 阶段表（`phaseNames`）与本 run 的子代理模型（`subagentModel`，规范 picker 串），三者同样
   * 只在建 run 那一世落 journal，resume 路径一概从那条事件读回。
   */
  launch?: RunLaunch;
  /**
   * 升级问答的停驻注册表。由 run service 持有一张、
   * 跨它名下所有在飞 run，两条入口（submit / resume）传的是**同一个对象**——注册表按完整 qid
   * 索引，两条入口各持一张会让 resume 之后的 run 作答不到自己刚提的问题。
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   * 本 run 的活体控制面（docs/dynamic-workflow/concurrency.md「The control path」）。由 run
   * service 按**注册表条目**造一个（submit / amend / resume 三条入口都造），本函数在这里把它的
   * 两端接上：harness 负责 `bind(engine)`，本函数负责 `bindSeatGate`。
   *
   * 缺席即这次启动没有控制面（snippet、集成测试）——run 照常跑完，只是上界中途改不了。
   */
  control?: WorkflowRunControl;
  /**
   * 接住本次 launch 造出来的 driver 的**会话静默探针**（workflow-driver-quiescence.ts）。
   * 三条入口都传同一件事：把它挂到这个 run 的注册表条目上，好让将来修订它的那次 amend
   * 问得着「前驱的会话写完了没有」。原样下传，本文件不读它。
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
  /**
   * 某处留白的类型实参原文（进度载荷给 `hole-reached` 补 `type`，docs/execution-engine.md
   * 「Holes」）。是函数而不是表：一次补全会换掉有效脚本，嵌套在函数体里的新留白随之出现，
   * 表在 run 的一生里会变——调用方（run service）让它读注册表条目上此刻的那张。缺席即不补。
   */
  holeTypeOf?: (siteId: string) => string | undefined;
}

/**
 * 启动（或恢复）一个 run：装配 sequence 截取 → emit 钩子 → 真实 driver → runWorkflowScript。
 * fire-and-forget 语义由调用方决定（本函数只返回结算 promise，不做注册表簿记）。
 */
export function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    control,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  const childSpawn = dynamicWorkflowChildSpawn();
  // 本 run 自己上界的**第二个**执行点（docs/dynamic-workflow/concurrency.md「Two enforcement
  // points」）：调度器管「还能不能再派一个 ask」，闸门管「已经在跑的那些下一次请求能不能发出去」。
  // 起点就是这次启动的 caps（submit 是钳过的请求值，resume 是 journal 行里的那一份），所以一个
  // 从未被 retune 过的 run 永远走闸门的快路径——不发事件、不持票、与从前逐字相同。
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  // 同一个上界还要登记给进程级治理器（docs/dynamic-workflow/concurrency.md「The governor」）：
  // 它抬的是本 run 用过的 provider key 的增长上限——用户要 40 个，桶的 cap 才爬得到 40，否则
  // 调度器放出 40 个子代理、治理器只给 2D 个请求，一大半停在「等待槽位」。launch 结算时清掉。
  // retune 经控制面落到这里，与座位闸门同一刻换值，三处（调度器、闸门、治理器）不会各执一词。
  deps.concurrency?.setRunBound(runId, caps.maxConcurrency);
  control?.bindSeatGate(runBoundTarget(seatGate, deps.concurrency, runId));
  // 锚点：submit 给的（本次建 run）或 journal 里的（resume）。升级前的 run 两边都没有 → 缺席，
  // 进度事件不带 launchInputId，子代理不上报。
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // lineage 指针：submit/amend 路径由入参给出；resume 路径入参缺席（createRun 早已写死），从
  // journal 行读回——两条路径的 `run-started` 载荷因此同形。
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // 默认并发：`run-started` 载荷的第二个宿主派生字段（线上键名 `concurrencyCeiling`）。每次 launch
  // 算一次而不是每条事件算一次——它是进程事实，一个 run 跑到一半核数不会变，而
  // `availableParallelism()` 是系统调用。
  const defaultConcurrency = resolveWorkflowDefaultConcurrency(deps.availableParallelism);
  // 子代理模型：submit 给的（随锚点同车）或 journal 里的（resume 从同一条 run-launched 读回）。
  // 与锚点同一条论证，两条路径因此同形；升级前的 run 两边都没有 → 缺席 = 跑在会话模型上。
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // 字符串 → 选择，每次 launch 解析一次。进度载荷走原串（下面的 toProgressPayload），
  // actor runtime 工厂要的是结构化选择（含 reasoning 档位，pin 的两段身份带不回来）。
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);
  // 脚本点名的模型绑定表：与子代理模型同源同路（submit 给的，或 resume 从同一条 run-launched 读回）。
  // 名字在 launch 时解析过一次，此后不再对着目录重解——resume 的 run 跑的仍是用户批准时那几个模型。
  const modelBindings = input.launch?.modelBindings ?? readRunModelBindings(deps.journal, runId);
  // 子代理权限模式（docs/dynamic-workflow/launch.md「Permissions inside a run」）：submit 给的
  // 就是建 run 那一刻会话的模式；resume 只从 run-launched 读回，**不看会话此刻的模式**——
  // 会话中途换到 Full access 不能把一个 guarded / build run 的子代理放开。
  const subagentPermissionMode =
    input.launch === undefined
      ? readRunSubagentPermissionMode(deps.journal, runId)
      : input.launch.subagentPermissionMode;

  // 事件的 journal sequence 只有 appendEvent 知道，而引擎在 record() 里
  // `journal.appendEvent(...)` 之后**同步**紧接着 `driver.emit(...)`，并丢掉了返回的
  // StoredEvent（engine.ts）。所以这里包一层 journal 把分配到的 sequence 截下来：
  // emit 拿到的一定是刚才那一条。替代方案都更差——本地自增计数器会在 resume（sequence
  // 从既有最大值续下去）时整体偏移，而每条事件回查一次 journal 是白付一次 IO。
  // 「append 紧跟 emit、一一对应」这个前提由测试钉住：钩子看到的 sequence 序列必须与
  // listEvents 返回的逐条相等。
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // 事件扇出绝不能把 run 打挂：钩子是观察者，异常吞在此边界并记日志。
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            // 留白到达的两个宿主派生字段：类型来自编译产物，到达时刻来自 journal 给这条事件盖的戳
            //（冷回放从 `timeCreated` 读回同一个数，两侧载荷因此逐字节相等）。
            ...(input.holeTypeOf === undefined ? {} : { holeTypeOf: input.holeTypeOf }),
            ...(() => {
              const reachedAt = sequenceCapture.timeCreatedOf(event);
              return reachedAt === undefined ? {} : { reachedAt };
            })(),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling: defaultConcurrency,
            ...(subagentModel === undefined ? {} : { subagentModel }),
            ...(modelBindings === undefined ? {} : { modelBindings }),
          }),
          // 路由与载荷分开：事件必须落在**发起该 run 的**会话里，而 parentSessionId 是
          // 判断"是不是那个会话"的唯一依据。
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    escalationRegistry,
    cwd,
    // 用户面产物的落点。会话作用域取**本服务
    // 的**父会话（= 本 app 的会话）而不是 launch 入参里那个可选的 parentSessionId：两者在
    // 生产里同值（run start 传的就是 runtime 自己的 sessionId），但只有前者是必填的，而
    // 「字节写进哪个会话的目录」不该有一条 undefined 的分支。store 缺席时整对都不传，
    // driver 侧因此以 ArtifactStoreUnavailable 大声拒绝。
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    // 每个 actor 站点拿哪一种 submit_result（typed / generic / 无），编译期已定。
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // 边界记账与种子复制都要读写 actor 会话的消息（driver 侧，见 workflow-driver.ts 的文件头）。
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // 进程级并发治理器的窄端口：在场时 driver 给每个
    // actor runtime 一个请求级准入端口（下面 runtimeFactory 原样下传）；缺席即 actor 不受闸门约束。
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // 本 run 的座位闸门：driver 把每个 actor 的准入端口包进它，并把 ask 的起止喂给它
    // （startAsk 与引擎的 `node-settled`）。
    seatGate,
    // 测试注入的 driver 时钟（故障矩阵）；生产缺席，driver 走真时间。
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    // 会话静默探针的回填口（见入参字段注释）：driver 在构造时调一次。
    ...(input.onQuiescenceProbe === undefined
      ? {}
      : { onQuiescenceProbe: input.onQuiescenceProbe }),
    runtimeFactory: async ({
      sessionId,
      actor,
      persona,
      escalatePort,
      webSearchBudgetPort,
      seed,
      submitPort,
      submitProfile,
      modelRequestAdmission,
    }) => {
      const runtime = deps.createActorRuntime({
        runId,
        sessionId,
        actor,
        persona,
        submitPort,
        // 工厂据 profile 决定端口是否注入、声明是否 typed（create-app.ts 的 createActorRuntime）。
        submitProfile,
        // 请求级准入端口与两个工具端口同路下传到 runtime deps。
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // 升级端口与 submit 端口同路下传：core 侧的注册门以端口存在为准，所以恒传。
        escalatePort,
        webSearchBudgetPort,
        // resume 的 pin：这个 actor 上一次跑在哪个模型上。必须在**造 runtime 之前**读，
        // 因为下面那行 journalActorResolvedModel 会把这一轮的解析结果写回同一个字段。
        //
        // 种子带来的 pin 是**承袭**（amend-resume）：修订 run 的第一次派发时本 run 的 journal 还
        // 没有解析结果，pin 只能来自前驱——转录接续下静默换模型正是 pin 要防的身份突变。两者都在
        // 场（修订 run 崩溃后 resume）时以本 run 的记录为准：那是这个 actor 在**这个 run 里**实际
        // 跑过的模型，比前驱的更具体，且两者本就应当相等。畸形 pin 的大声失败沿用既有那一套
        // （workflow-actor-model.ts 的 WorkflowActorPinnedModelError），此处不分叉。
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // 本 run 的子代理模型：在 pin **之上**（workflow-actor-model.ts 的优先级表）。它是用户对
        // 这一次 run 的显式表态（AmendWorkflow 带 subagent_model 就是「resume 时换模型」的那个显式
        // 决定），pin 只守没有它时的隐式缺省。与 pin 不同，它整条带着 reasoning 档位下去——
        // journal 的 pin 只记身份两段。
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
        // persona 点名的模型（最高优先级，workflow-actor-model.ts）：按本 run 的绑定表查成整条选择。
        // 表里没有这个名字只可能来自绕过 9010 的类型断言——在建会话这里抛，这次 ask 以 DriverError 失败。
        ...(() => {
          const actorModel = resolveActorPersonaModel(persona.model, modelBindings);
          return actorModel === undefined ? {} : { actorModel };
        })(),
        ...(subagentPermissionMode === undefined ? {} : { subagentPermissionMode }),
      });
      // persona 的模型档位实际解析成了哪个模型，只有造好的 runtime 说得准（档位映射见
      // workflow-actor-model.ts）。先落库再接入会话：一次失败的会话持久化会让这次 ask 失败，
      // 但「当时选了哪个模型」这条审计事实照旧留在 journal 里。rehydrate 路径也要写——
      // pin 缺席（升级前的旧 run）时这一轮才是第一次有解析结果可记。
      journalActorResolvedModel({
        actor,
        journal: deps.journal,
        selection: requireActorModelSelection(runtime, actor),
        runId,
      });
      const attached = await attachActorSession({
        actor,
        deps,
        runId,
        runtime,
        sessionId,
      });
      if (attached === "rehydrated") return runtime;
      await persistActorSession({
        actor,
        deps,
        parentSessionId,
        runId,
        runtime,
        sessionId,
      });
      return runtime;
    },
  });

  const settlement = runWorkflowScript({
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    caps,
    // SEA 下必须换 spawn 策略，非 SEA 一律不传。
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // 入口文件写不进项目 `.zcode/` 时 harness 回落到 OS 临时目录并报一声——run 照常启动，
    // 但这条日志是排查「项目里为什么没有 workflow-runs 存档」的唯一线索。
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name 与 scriptText 同一条元数据路：harness 原样转交 EngineConfig（resume 时 journal
    // 命中短路 createRun，传它无害且保持 submit/resume 两条 launch 输入同形）。
    ...(name === undefined ? {} : { name }),
    // 实参与 name / scriptText 同一条元数据路，但多一个去处：harness 既转交 EngineConfig
    // （落 args_json），也放进 spawn payload 注入沙箱。
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // 落库的是作者原文与它的哈希，不是 lowered 函数体（resume 的比对基准是原文）。
    scriptHash: compiled.scriptHash,
    scriptText,
    // 关联锚点随 run 落库：重启后工具卡 join 与 resume 通知都只能从 dwf_run 还原它。
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // 修订续跑：lineage 指针落库（createRun 一次写死），导入缓存注入引擎（纯数据，核心零 I/O）。
    // 传的是 lineageFrom 而不是入参：它同时是脚本读到的 run.resumedFrom，resume 那一世入参缺席，
    // 只递入参的话脚本在续跑时会读到 undefined（引擎命中既有行时不再落库，传它无害）。
    ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // 用量起点与缓存同车：引擎在 createRun 时把它写成 spent_tokens 的初值，命中既有行时忽略。
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // 锚点只在建 run 那一世落 journal（引擎侧的门），resume 时传它无害。
    ...(launch === undefined ? {} : { launch }),
    signal,
    // 控制面与 signal 同一条缝：那个是「停下这个 run」，这个是「改这个 run 的一项设置」。
    // harness 在引擎构造好的同一同步片里 bind（harness.ts），所以 run 从第一条事件起就可被改。
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
  // 治理器上的上界随 launch 一起结束：结算（含失败、取消）后本 run 不再抬任何 key 的增长上限，
  // 高于新上限的 cap 由治理器当场拉下来（`limit_lowered`）。
  return settlement.finally(() => deps.concurrency?.clearRunBound(runId));
}

/**
 * 沙箱子进程的 spawn 策略：SEA 下走隐藏子命令自 re-exec，否则不表态（harness 缺省
 * `node --max-old-space-size=… <entry>`）。
 *
 * SEA 单文件二进制不解释 Node CLI 旗标，harness 缺省 argv 里的
 * `--max-old-space-size` 会原样落进 CLI 的严格 parseArgs，子进程立即报错退出——**SEA 下每一个
 * workflow run 必然失败**。修法与 official plugin host 同款
 * （official-plugin-runtime.ts 的 `officialPluginHostPrefixArgs`）。
 *
 * SEA 判定留在 bootstrap 而不下沉到 harness：harness 是 app-free 的（只依赖
 * `@zcode/dynamic-workflow` 与 node 内建），既拿不到 contracts 的子命令常量，也不该知道
 * 自己被哪种宿主打包。`isSea` 可注入只为可测——默认探针在测试进程里必然返回 false，
 * 于是「非 SEA 不得带 argsPrefix」也是一条可断言的事实。
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [ZCODE_DWF_CHILD_COMMAND] } : undefined;
}

/** SEA 运行时探针（official-plugin-runtime.ts 私有同名 helper 的本地镜像，刻意不跨文件复用）。 */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

/**
 * resume 重水化：journal 已记录该 actor 的会话 id ⇒ 这是一次重挂（会话行与消息早已落库，
 * `mintActorSessionId` 纯确定所以 sessionId 就是当年那一个，driver 侧另有互证）。
 * `resumeFromStore` 从落库的 message/part 行重建 messageHistory——被打断的 tool call 会被
 * hydrator 钉成 "[Tool execution was interrupted before resume]"，正是被杀 ask 的正确语义。
 *
 * `SessionNotFound`（会话行被清理）不是错误而是记录在案的例外：退回全新持久化路径，actor 从空上下文重来——比让整个 run 卡死诚实。
 * 其余异常原样上抛（低层不吞错，house rule）。
 */
async function attachActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<"fresh" | "rehydrated"> {
  const { actor, deps, runId, runtime } = input;
  const journaledSessionId = deps.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId;
  if (journaledSessionId === undefined) return "fresh";
  try {
    await runtime.resumeFromStore();
    // 会话行、task link 都在上一世落库过（两者皆 upsert），重挂不再重建。
    return "rehydrated";
  } catch (error) {
    if (!isSessionNotFound(error)) throw error;
    deps.logger?.warn?.("Dynamic workflow actor session pruned; starting fresh", {
      actor: refToString(actor),
      event: "dynamic_workflow.actor.rehydrate_fallback",
      module: "bootstrap.app",
      runId,
      sessionId: input.sessionId,
    });
    return "fresh";
  }
}

/** 结构化判定 core 的 SessionNotFound（不依赖错误文本做流程判断）。 */
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.SessionNotFound
  );
}

/**
 * actor 会话真实化：落会话行 + 建 task link（legacy 路径的示范在
 * script-workflow-runtime.ts）。
 *
 * 顺序是**载荷性**的：`session_task_link.child_session_id` 对 `session(id)` 有 FK，
 * 所以必须先落会话行再建 link。这也是 ActorRuntimeFactory 允许返回 Promise 的原因。
 *
 * 这里**不再**订阅 actor runtime 的事件：直播通道在 child runtime 的**构造期**就装好了
 * （script-workflow-child-runtime.ts 的 eventSink → 父 runtime 的外部 sink 集）。旧的
 * `subscribeEvents` 通道装在下面这行 `ensureSessionPersistedForExternalActivity` 之后，
 * 而它会把 SessionTitleUpdated 写成 sequenceNumber 1——v4 网关只排水连续 seq，
 * 于是订阅从 seq 2 起永远等一个再也不会来的 seq 1，transcript 永久空白。
 */
async function persistActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  parentSessionId?: string;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<void> {
  const { actor, deps, parentSessionId, runId, runtime, sessionId } = input;
  const title = `workflow subagent ${refToString(actor)}`;

  await runtime.ensureSessionPersistedForExternalActivity(title);

  if (deps.taskLinkStore) {
    await deps.taskLinkStore.createSessionTaskLink({
      childSessionId: sessionId,
      id: `tasklink_${randomUUID()}`,
      // rootWorkflowRunId 刻意留空。**经验证的事实**（不是猜测）：该列声明为
      // `root_workflow_run_id text references workflow_run(id)`（migration 0007，
      // 见 session_task_link 建表），指向 **legacy** workflow_run 表，而 workflow run 的记录在
      // dwf_run；migration runner 开着 pragma foreign_keys = on。对着真实 store 探测过：
      // 带 workflow runId 调用得到 `FOREIGN KEY constraint failed`，省略则成功。所以 run 身份走
      // 下面这个无 FK 的 path 列。别把它"修"回来。
      //
      // path 是一个迷你契约：`dwf/<runId>/<siteId>@<ordinal>`。runId 已字符集安全；siteId 段
      // 保留原始 `#`/`@`（自由文本列，且已 sanitize 的形态就在会话 id 里）。**今天没有任何代码
      // 解析它**——它服务于人阅读与将来可能的前缀扫描（"这个 run 的所有 actor 会话"）。
      // 若将来要按 run id 建索引查询，需要一条重建
      // session_task_link 的 migration 把 FK 改指或去掉。
      path: `dwf/${runId}/${refToString(actor)}`,
      ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
      // 与 legacy 的 "workflow_agent"（script-workflow-runtime.ts）刻意区分，而不是复用：
      // 两者是不同的人群。legacy 行的 root_workflow_run_id 指向 workflow_run 且非空，dwf 行
      // 该列恒为空、run 身份在 path 里。共用一个 role 值会让"按 role 取行再解引用
      // root_workflow_run_id"的消费者从 dwf 行拿到 null。列是 `text not null`，无 CHECK、
      // 无 enum、契约侧也无 zod（已核对），所以新值合法。
      role: "workflow_actor",
      status: "running",
    } satisfies CreateSessionTaskLinkInput);
  }
}

/**
 * 把 actor 实际跑在哪个模型上写进 journal（`ActorRecord.resolvedModel`，落 dwf_actor 的
 * resolved_model 列）。
 *
 * 为什么必须**读改写**：`putActor` 是整条记录的替换，而这条记录的另外几个字段（name /
 * persona / sessionId）不是本函数的；直接写一条只有 resolvedModel 的记录会把引擎刚写下的
 * 冻结 persona 抹掉。
 *
 * 为什么是 driver 侧写：子代理跑在哪个模型上是宿主事实（父会话当时的选择），引擎在 createActor
 * 时同步落 persona 的那一刻看不见它。引擎那一侧的两处 putActor 会把本字段原样带过去，见
 * dynamic-workflow 的 engine.ts / scheduler.ts。
 */
export function journalActorResolvedModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  selection: ModelSelection;
  runId: string;
}): void {
  const { actor, journal, selection, runId } = input;
  const existing = journal.getActor(runId, actor.siteId, actor.ordinal);
  journal.putActor({
    ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
    resolvedModel: formatActorResolvedModel(selection),
  });
}

/** journal 里 `resolvedModel` 的写法：`providerId/modelId`，与 pin 的读法（workflow-actor-model.ts）互逆。 */
function formatActorResolvedModel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/**
 * 造好的 actor runtime 必须已经有模型选择：child 继承父会话当前的选择（script-workflow-child-runtime.ts），
 * 父会话没有选择时它连第一次模型请求都发不出去。这里大声失败，而不是把「没选模型」落成一条空 pin。
 */
function requireActorModelSelection(runtime: AgentRuntime, actor: ActorRef): ModelSelection {
  const selection = runtime.getSessionModelSelection();
  if (selection === undefined) {
    throw new Error(
      `actor 会话没有模型选择，无法记录 resolvedModel: ${actor.siteId}#${actor.ordinal}`,
    );
  }
  return selection;
}

/**
 * resume 的 pin 读取：这个 actor 在 journal 里记下的 `resolvedModel`（`providerId/modelId`）。
 *
 * 只有 resume 才会读到值：引擎 replay `createActor` 时把该字段 carry-forward 保了下来；
 * 全新 run 在 runtime 工厂运行的这一刻还没有解析结果，天然缺席。**必须在造 runtime 之前读**，
 * 因为 `journalActorResolvedModel` 随后就会把本轮的解析写回同一字段——读晚了会把本轮结果
 * 误当成上一轮的 pin。pin 与本 run 的 subagentModel 谁优先，见 workflow-actor-model.ts
 * （run 选择在上；pin 只守没有 run 选择时的缺省，persona 冻结不变式的持久化那一半）。
 */
export function pinnedActorModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): string | undefined {
  return input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal)
    ?.resolvedModel;
}
