// ============================================================
// AgentRuntime-backed WorkflowDriver（Boundary B）
// ============================================================
// 把 dynamic-workflow 引擎核心的向下副作用端口 WorkflowDriver 落到真实 ZCode AgentRuntime 上：
// 每个 actor 一个**持久** child runtime（重复 executeTurn 累积 messageHistory），每次 ask 一次
// executeTurn，typed ask 的结果经会话级 WorkflowSubmitPort 桥接回引擎裁决。
//
// Boundary B 的另外两半——`executeWorldRead` 与 `executeArtifactPublish`——分别住在
// workflow-world-read.ts 与 workflow-artifact-publish.ts，本文件只做转发。两者与这里没有
// 共同状态（不碰会话、turn、submit 桥接），所以分开之后本文件只剩「会话与 turn 的编排」
// 这一件事。
//
// 三条时序（本文件的核心不变式）：
//   1. accept：模型调用 submit_result → handler 阻塞在 port.respond → 本 driver 上报
//      askSubmitAttempted → 引擎校验通过 → respondToSubmit(accept) → 解开 deferred 为 {accept:true}
//      → handler 返回成功（挂 turnControl 停 turn）→ executeTurn resolve → 只上报 askStats（不再上报
//      askTurnEnded，因为该 ask 已被引擎结算）。
//   2. reject（同 turn 内修复）：respondToSubmit(reject, violations) → 解开 deferred 为
//      {accept:false, violations} → handler 抛错 → error tool_result（无 turnControl）→ 同一 turn 继续
//      → 模型重试 → 又一次 respond → 又一次 deferred。repair 预算耗尽时引擎改调 cancelAsk。
//   3. nudge（turn 结束未提交）：executeTurn resolve 且未 accept → 上报 askTurnEnded → 引擎决定 nudge
//      → respondToSubmit(nudge)（此时**无** parked deferred，turn 已结束）→ 在同一持久 runtime 上发起
//      一次**全新** executeTurn（nudge 提示）。
//
// 三值→二值裁决映射（引擎 SubmitVerdict 三值；contracts WorkflowSubmitPort 二值）：
//   accept → {accept:true}；reject → {accept:false, violations}（Violation 1:1 映射）；nudge → 无 deferred，
//   起新 turn。见 respondToSubmit。
//
// 第四条时序（升级问答）与上面三条**同层**：
//   4. escalate：模型调用 escalate → handler 阻塞在 escalatePort → driver 铸 qid、停驻 deferred、
//      把问题登记进升级注册表，并双轨发出 escalation-raised（journal + emit）→ 主代理经 run
//      service 的 resolveQuestion 查表 → driver.respondToEscalation 解开 deferred 并发出
//      escalation-resolved → 工具结果 = 答案文本 → actor 的轮次就地继续，ask 照常 settle。
//      引擎核心对此**零感知**：升级发生在 driver 执行 ask 的边界内（与 repair/nudge 轮次同层），
//      不写 dwf_node 行。逃生舱是 cancelAsk——它连同停驻的升级 deferred 一起拒绝。
//
// amend-resume 给本文件加了两件 driver 私有的事，两件都只
// 关乎会话转录，所以机制住在 workflow-actor-transcript.ts，这里只做编排（编排的三个实现体在
// workflow-driver-transcript.ts）：
//   - **ask 边界记账**：一次交换（含 repair / nudge 轮与 submit 之后的收尾消息）结束后，把该 actor
//     会话已落库的消息条数写进这个 ask 的 journal 行。每个 ask 都写——任何 run 都是未来修订的
//     潜在前驱。
//   - **转录截断**：`createActorSession` 带种子时，把源会话的前 N 条消息复制进新铸的会话再重水化。
// 本轮又多了第三件，同样只关乎转录、同样住在自己的模块（workflow-driver-quiescence.ts）：
//   - **会话静默登记**：dispose 时记下每个会话是否还有在写的 turn。修订一个在飞前驱时，amend
//     要据它判断「此刻数出来的消息条数可不可信」，才谈得上接续那条未完的 ask。

import type { SessionId, WorkflowEscalatePort } from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@zcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { executeWorldRead } from "./workflow-world-read.js";
import {
  createActorModelActivity,
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  createActorSessionQuiescence,
  releaseActorSessions,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  isTurnCancelled,
  mapViolations,
  mintActorSessionId,
  reportTurnObservations,
  schemaEpilogue,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { makeSessionSubmitPort, type SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import { makeWebSearchBudgetPort, webSearchLimitOf } from "./workflow-driver-web-search-budget.js";
import {
  countSessionTranscript,
  journalAskMessageBoundary,
  seedActorSession,
} from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * WorkflowDriver 的真实实现。构造经 {@link createAgentRuntimeWorkflowDriver}（绑定 deps，回填 sink）。
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → 其所属会话，供 respondToSubmit / cancelAsk 反查。 */
  private readonly instanceToSession = new Map<string, SessionState>();
  /** qid → 停驻它的会话，供 respondToEscalation 反查（与 instanceToSession 同族）。 */
  private readonly qidToSession = new Map<string, SessionState>();
  /** per-run 单调的升级序号；qid 的第二段。与 runId 一起构成无碰撞的 id。 */
  private escalationSeq = 0;
  /** dispose 幂等门（引擎契约是恰好一次，但门在这里更便宜也更稳）。 */
  private disposed = false;
  /** 本 run 对治理器 cap 变化的订阅（run 级一次，dispose 时退订）。 */
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * 交给升级桥接（workflow-driver-escalation.ts）的宿主面：两张表按引用共享，序号与 record
   * 经闭包回到本类——私有状态不外露，桥接函数也不需要知道类的形状。
   */
  private readonly escalationHost: EscalationHost;
  /** 交给模型侧失败收容（workflow-driver-model-failure.ts）的宿主面：同一套按引用共享的思路。 */
  private readonly modelFailureHost: ModelFailureHost;
  /** 交给 submit 桥接（workflow-driver-submit-bridge.ts）的宿主面：同上，两样都按引用共享。 */
  private readonly submitHost: SubmitBridgeHost;
  /** run 级 stall 时钟（决策 4）：所有 actor 的成功 / 重试节拍汇到这一只表。 */
  private readonly stallClock: RunStallClock;
  /**
   * 会话静默账（workflow-driver-quiescence.ts）：dispose 那一刻每个会话还有没有在写的 turn。
   * amend 查询 turn 静默；App.close 则通过 drain 等待完整的 actor 释放。
   */
  private readonly quiescence: ActorSessionQuiescenceLedger;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // 引擎的 record() 对**每一条**事件都紧接着调 driver.emit（engine.ts），所以这里是 driver
    // 看得见 ask 终点的唯一一处：`node-settled` 是三条结算路（settleOk / settleFailed /
    // abortInFlight）共同的出口，也就是座位闸门等的那条「这一位不工作了」。
    //
    // 为什么不用 driver 自己的状态判：`state.currentInstance` 从不清空，untyped ask 经
    // askTurnEnded 在引擎侧结算之后 `live()` 仍然为真——照它腾座位就永远腾不掉，FIFO 会死等。
    //
    // 递下去的**必须是同一个对象引用**：launch 侧的 sequence 截取按引用相等核对序号
    // （dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.submitHost = { sessions: this.sessions, sink };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    // 探针在**构造时**就交出去：run service 要在条目上挂住它，而 amend 可能在这个 run 生命的
    // 任意一刻到来。dispose 之后才交就晚了——那时 service 已经在数会话了。
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
      // 扇出只到在该 key 上有在飞/排队请求的 run，所以订阅本身可以在构造时一次做完。
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    if (this.disposed) return Promise.reject(new Error("Workflow driver is closed"));
    const creation = this.createOwnedActorSession(actor, persona, seed);
    // 工厂异步持久化时 dispose 也必须看得见它，避免新 actor 落在关闭快照之外。
    this.quiescence.trackRelease(
      creation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return creation;
  }

  private async createOwnedActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    const sessionId = mintActorSessionId(this.deps.runId ?? "run", actor);
    // resume 会话身份互证：journal 的 dwf_actor.session_id 是**记录**，铸造函数才是权威
    // （按 (runId, actorRef) 纯确定，重挂时必然铸出同一个 id）。两者不一致只可能是铸造规则
    // 漂移（改名/第二处实现）——后果是重水化读错会话、详情页打开不存在的会话，离成因很远，
    // 所以在重挂的第一步就大声失败，携结构化 mismatch（与两个哈希不匹配错误同形）。
    const journaled = this.journal.getActor(
      this.deps.runId ?? "run",
      actor.siteId,
      actor.ordinal,
    )?.sessionId;
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError(
        "DriverError",
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
          `id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } },
      );
    }
    const ref: SessionRef = { id: sessionId };
    // 会话级 submit 端口（实现体在 workflow-driver-submit-bridge.ts，与紧随其后的升级端口
    // 逐条对称）：closure 绑定本会话，模型无法覆盖路由身份（instance 取自 currentInstance）。
    const submitPort = makeSessionSubmitPort(this.submitHost, sessionId);
    // 升级端口同构：同样按会话 closure 绑定，同样恒注入（见 ActorRuntimeFactory 的字段注释）。
    // persona 一并入 closure：有效名是**冻结**的（引擎在 createActor 时定下，此后不变），
    // 所以在这里算一次比每次 escalate 现查便宜，也不会中途换名。
    const escalatePort = this.makeEscalatePort(sessionId, actor, persona);
    // WebSearch 预算端口同构：按会话 closure 绑定，计数在下面才建的会话状态里（端口按 id 晚查）。
    const webSearchBudgetPort = makeWebSearchBudgetPort(this.sessions, sessionId);
    // 模型活动面：准入端口随 runtime deps 下传（runner 每次尝试先过闸门），
    // waiting / executing 观察只在有在飞 ask、且它还没被引擎结算/取消时上报——迟到的观察对一个
    // 已完结的 ask 没有意义，引擎侧也会再挡一次。state 在下面才建，所以经 closure 晚绑定。
    let state: SessionState | undefined;
    const live = (): InstanceRef | undefined =>
      state === undefined ||
      state.currentInstance === undefined ||
      state.accepted ||
      state.cancelled
        ? undefined
        : state.currentInstance;
    const modelActivity = createActorModelActivity({
      port: this.deps.concurrency,
      runId: this.deps.runId ?? "run",
      live,
      // 座位闸门按 **actor** 键入（不是 ask 实例）：per-actor FIFO 保证一个 actor 至多一个在飞
      // ask，所以「工作中的子代理」与「在飞的 ask」是同一个计数，而准入端口本就是按 actor 会话
      // 造的。见 docs/dynamic-workflow/concurrency.md「Park and unpark」。
      ...(this.deps.seatGate === undefined
        ? {}
        : { seat: { gate: this.deps.seatGate, key: refToString(actor) } }),
      handlers: {
        // 子代理的第一笔工作区写入 ⇒ 引擎关导入缓存。
        onMutating: (instance) => this.sink.askMutating(instance),
        onWaiting: (info) => {
          const instance = live();
          if (instance !== undefined) this.sink.askWaiting(instance, info);
        },
        onExecuting: () => {
          const instance = live();
          if (instance !== undefined) this.sink.askExecuting(instance);
        },
        // run 级 stall 时钟的两个节拍：任一 actor 的成功归零、任一重试上膛。
        onRequestCompleted: () => this.stallClock.noteSuccess(),
        onRetryScheduled: (reason) => this.stallClock.noteRetryScheduled(reason),
      },
    });
    // submit profile：按 actor **站点**查——同一站点
    // 的每个 ordinal（fan-out 的每条 lane）跑的是同一组 ask 站点，profile 自然相同。缺席 = generic。
    const submitProfile =
      this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
    // await：生产工厂在返回前把会话落库并建 task link（FK 要求 session 行先存在）。
    // 引擎的 ensureSession 会 await 本方法，所以第一次 ask 派发前持久化已完成。
    const runtime = await this.deps.runtimeFactory({
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      webSearchBudgetPort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    state = {
      ref,
      sessionId,
      runtime,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      turnGeneration: 0,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      webSearchesUsed: 0,
      webSearchLimit: webSearchLimitOf(persona),
      modelActivity,
      actor,
      actorName: effectiveActorName(persona),
      transientAttempts: 0,
    };
    try {
      if (seed !== undefined) {
        await seedActorSession(this.deps, {
          journaledSessionId: journaled,
          runtime,
          seed,
          sessionId,
        });
      }
      if (this.disposed) throw new Error("Workflow driver closed during actor creation");
      modelActivity.observe(runtime, sessionId);
      this.sessions.set(sessionId, state);
      return ref;
    } catch (error) {
      // 创建尚未登记时也属于本 driver；种子恢复失败或关闭抢先到达，都必须释放已创建实例。
      await releaseActorSessions(this.deps, [state], this.quiescence);
      throw error;
    }
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      // 理论不会发生（引擎先建会话再 ask）；归一成 DriverError 上报而非静默。
      this.sink.askFailed(
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // 上一个 ask 若在异常路径上留下了停驻项（turn 被 abort 之外的方式打断），在这里一并撤下：
    // 新的 ask 一旦开跑，那些问题就再也不会有人读答案了，留在注册表里只会让快照说谎。
    this.withdrawEscalations(state);
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // per-ask 预算归零（nudge 走的是 runTurn，不经这里——nudge 仍在同一个 ask 里）。
    state.escalationsUsed = 0;
    state.webSearchesUsed = 0;
    state.abortController = new AbortController();
    // 上一个 ask 的 waiting / executing 相位、工具计数都不能带到这个 ask 上；瞬态重驱计数同理。
    state.modelActivity.reset();
    // ask 的起点喂给座位闸门（终点在 emit 里认 `node-settled`）：从这一刻起这个子代理算"在工作"，
    // 它的下一个 turn step 因此要过座位。同一个 actor 连着接到下一个 ask 时这是幂等的加入——
    // 它本来就一直在工作，中途没有空过。
    this.deps.seatGate?.askStarted(refToString(state.actor), instance);
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // 质量尾注对 typed / untyped 一视同仁；schema 尾注只有 typed 有。两段都在 scheduler 算完
    // inputHash 之后追加，所以不进缓存身份。
    // typed ask 的 schema 尾注按 submit profile 分叉：mono 子代理的 schema 已在工具声明里，尾注只剩
    // 一句；generic 子代理照旧把整份 schema 写进尾注。守卫先跑：静态 profile 与这次 ask 不符时它会
    // 把会话降成 generic（或让 ask 失败），下面读到的就是修正后的形态。
    if (message.typed && !ensureSubmitProfileFits(this.deps, this.sink, state, instance, message)) {
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // 尾注边界：GUI 据此把尾注折进披露。指令正文
    // 之后全是引擎文本，边界就是正文长度；模型收到的仍是全文，持久 text part 也是。
    // fire-and-forget：绝不在 startAsk 内 await turn 完成（Boundary B 契约）。
    this.runTurn(state, instance, input, message.instructions.length);
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    switch (verdict.kind) {
      case "accept": {
        // 标记 accept：该 ask 的 turn resolve 时不再上报 askTurnEnded（引擎已 settleOk）。
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        // 同 turn 内修复：handler 收到 {accept:false} 会抛错 → error tool_result → 模型重试。
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // turn 已结束、无 parked deferred：在同一持久 runtime 上发起一次全新 turn 促其提交。
        // nudge 整条都是引擎文本：边界 0。
        this.runTurn(state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    // 引擎主动取消（repair/nudge 预算耗尽、run 取消/失败）：中止在飞 turn，并解开可能挂起的 submit
    // deferred，避免 handler 永久阻塞；标记 cancelled 使 turn reject 不再上报 askFailed。
    state.cancelled = true;
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // 停驻中的升级问答与 submit deferred **同待遇**：一并拒绝，否则 `escalate` handler 会在一个
    // 已被取消的 ask 里永久阻塞。这条正是「无答案 = 无限期阻塞」的逃生舱（按设计不设超时）：
    // run cancel 与 CLI 进程亡故的行为因此与今天逐字节一致——ask 拒 Cancelled、run 转
    // Interrupted，resume 后该 ask 重跑、actor 重新提问并得到新 qid。
    this.withdrawEscalations(state);
    // 退避等待中的重驱一并撤下：ask 已被引擎结算，再起一轮只会对着一个没人听的节点烧 token。
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * run 结算后的资源释放（引擎在 run-settled 之后恰好调一次，见 WorkflowDriver.dispose）。
   *
   * 对每个 actor runtime 跑 app 关会话的**同一条**链——`closeBrowserSession` 内部依次
   * beginShutdown、node_repl 会话释放、浏览器会话关闭；不另造一套子代理关闭链，那会漂移。
   * 不关 execution / MCP / session store：子代理不拥有它们。有在飞 turn 的会话等它落地再关
   * （见 SessionState.turn）；关闭失败只 warn，结算不因它抛。三张表随之清空。
   *
   * 本方法**同步**，而且刻意不等在飞 turn——引擎的契约是结算之后立刻释放资源。代价是
   * 「结算 promise 已解决」不蕴含「被中止的 turn 已经把尾巴写完」，所以释放的同时把每个会话
   * 此刻的在飞 turn 记进静默账：amend 随后据它判断哪个会话的消息条数可信。两件事的编排在
   * {@link releaseActorSessions}（workflow-driver-quiescence.ts 的文件头写了完整论证）。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    releaseActorSessions(this.deps, this.sessions.values(), this.quiescence);
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  /**
   * 结算一个停驻中的升级问答（run service 经注册表调进来）。实现体在
   * workflow-driver-escalation.ts（{@link respondToParkedEscalation}），这里只做委托。
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /** 撤下某会话上所有停驻中的升级问答；实现体见 {@link withdrawSessionEscalations}。 */
  private withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * 世界读取：整段委托给 {@link executeWorldRead}（workflow-world-read.ts）。
   *
   * 这里只做转发，是因为世界读取与本文件的其余部分**没有共同状态**：它不碰 actor 会话、
   * 不碰 turn、不碰 submit 桥接，只需要三样东西（两个端口加一个 cwd）。分出去之后本文件
   * 只剩"会话与 turn 的编排"这一件事，而 op 元数、上限执行、git 的固定 argv 集中在一处。
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    if (this.disposed) throw new Error("Workflow driver is closed");
    const work = executeWorldRead(this.deps, op, args);
    this.quiescence.trackRelease(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await work;
  }

  /**
   * 用户面产物的发布：整段委托给 {@link executeArtifactPublish}（workflow-artifact-publish.ts），
   * 理由与上面的世界读取逐字相同——它与本文件没有共同状态，只需要两个端口、一个 cwd 与
   * 一个会话 id。
   *
   * 方法在 Boundary B 上是**可选**的（`executeArtifactPublish?`），而本 driver 恒实现它：
   * 「有没有存储」是装配事实，由 deps 里的 `artifactStore` 表达并在那一侧大声失败，不该由
   * 「方法在不在」这条第二条通道再表达一次（两条通道会给同一件事两种失败形态）。
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    if (this.disposed) throw new Error("Workflow driver is closed");
    const work = executeArtifactPublish(this.deps, request);
    this.quiescence.trackRelease(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await work;
  }

  // ——————————————————————————————— 内部：turn 编排 ———————————————————————————————

  private runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    const abortSignal = state.abortController?.signal;
    state.turnGeneration++;
    state.turn = state.runtime
      .executeTurn(input, undefined, {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
      })
      .then(
        (result) => this.onTurnResolved(state, instance, result),
        (error) => this.onTurnRejected(state, instance, error),
      );
  }

  private onTurnResolved(state: SessionState, instance: InstanceRef, result: TurnResult): void {
    // 一次 turn 解析的两条回报（进度先于用量），顺序与载荷都在 reportTurnObservations 里。
    reportTurnObservations(this.sink, state, instance, result);
    if (this.deps.actorTranscriptStore === undefined) {
      // 无转录存取面：原样的同步路径，一个 await 都不多欠（边界记账整体缺席，见 deps 字段注释）。
      this.reportTurnOutcome(state, instance, result);
      return;
    }
    void this.settleExchange(state, instance, result);
  }

  /**
   * 报告一个 turn 的终局，并回答「这次 ask 的交换到此为止了吗」。
   *
   * accept 之外只有一条路：把最终文本交给引擎（typed → nudge 或耗尽失败；untyped → 据此结算）。
   * nudge 时引擎会在**本调用栈内**经 respondToSubmit 起一轮全新 turn，于是 turnGeneration 变了——
   * 那正是"交换尚未结束"的判据（repair 轮不在此列：它们在同一个 turn 里，本方法根本不会被调用）。
   */
  private reportTurnOutcome(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): boolean {
    // 已提交并被引擎 accept：ask 已结算，turn 结束只是确认，不再上报 askTurnEnded。
    if (state.accepted) return true;
    const generation = state.turnGeneration;
    this.sink.askTurnEnded(instance, result.response);
    return state.turnGeneration === generation;
  }

  /**
   * 一次交换的收尾：数消息 → 报终局 → 交换真的结束了就把边界写进 ask 的 journal 行。
   *
   * **先数后报**，顺序是载荷性的：报出去之后引擎可能立刻在同一个会话上派发这个 actor 的下一个
   * ask（per-actor FIFO 只保证串行，不保证之间有空隙），那一轮的消息会落进同一个会话，把本次
   * 计数撑大。先数下来，读到的就是这次交换结束那一刻的长度。
   */
  private async settleExchange(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): Promise<void> {
    const boundary = await countSessionTranscript(this.deps, state, instance);
    const ended = this.reportTurnOutcome(state, instance, result);
    if (!ended || boundary === undefined) return;
    journalAskMessageBoundary(this.deps, state, instance, boundary);
  }

  private onTurnRejected(state: SessionState, instance: InstanceRef, error: unknown): void {
    // turn 死了就没有人再读工具结果了：停驻中的升级问答必须一并撤下，否则它们会永远留在
    // 快照的 pendingQuestions 里，请主代理去回答一个没有听众的问题。
    this.withdrawEscalations(state);
    if (state.cancelled || isTurnCancelled(error)) {
      // 引擎发起的取消（abort）：引擎已结算该 ask，driver 不重复上报。
      return;
    }
    // 模型侧错误的收容住在 workflow-driver-model-failure.ts（策略表判 stop / context_exceeded /
    // 瞬态重驱）；不是模型层错误才是 driver 侧失败。
    if (handleModelTurnFailure(this.modelFailureHost, state, instance, error)) return;
    this.sink.askFailed(instance, toWorkflowError(error));
  }

  // ——————————————————————————————— 内部：升级问答桥接 ———————————————————————————————

  /**
   * 造一个会话级升级端口；实现体在 workflow-driver-escalation.ts（{@link makeSessionEscalatePort}），
   * 与 {@link makeSessionSubmitPort} 逐条对称的论证也写在那边。
   */
  private makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   * 一条 driver 侧事件的双轨落地：durable 进 `dwf_event`，实时经 emit 扇出。
   *
   * 与引擎的 `record()`（engine.ts）逐字节同形，且顺序不可换：launch 侧的 sequence 截取靠
   * 「appendEvent 之后同步紧接着 emit、同一个事件对象引用」这个前提把刚分配到的 sequence 交给
   * emit（dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * 造一个绑定了 deps 的 driver 工厂，直接充当 harness 的 makeDriver。journal 与 emit 由 deps 提供，
 * 调用方（测试/生产）持有其引用以做断言与 Boundary C 扇出。
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
