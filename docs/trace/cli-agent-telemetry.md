# CLI Agent Telemetry 设计与开发规范

> 状态：当前实现规范。
>
> Telemetry Schema Version：6。
>
> 适用范围：`apps/zcode-cli` 内部的 Agent、模型、工具、命令和上下文压缩链路。

本文定义 CLI Agent Trace 的数据模型、链路拓扑、设计约束、接入方式、隐私边界和基本查询。
完整字段、底层运行时和 OpenTelemetry 概念分别由专题参考展开。本文与专题参考及 TypeScript
Contracts 共同构成 Telemetry Schema：方法签名和类型约束以 Contracts 为准，字段语义和系统
约束以文档为准。

## 1. OpenTelemetry 数据模型

ZCode 使用以下 OpenTelemetry 数据模型描述 Agent 执行：

```text
Resource：Telemetry 生产者（CLI 版本、产品版本、构建、运行面、安装实例）
    |
    `-- Trace：一次完整的执行链
          |
          `-- Span：一段有开始、结束、耗时和结果的工作
                |
                +-- Attribute：这段工作的事实
                +-- Event：工作进行到某个瞬间发生的里程碑
                `-- Child Span：内部另一段具有独立生命周期的工作

Metric：从同一批低基数事实生成的跨请求统计，不依赖某条 Trace 是否被保留
```

主 Agent Turn 的标准拓扑是：

```text
agent_turn
|
+-- agent_step
|   +-- model_call
|   |   `-- model_attempt [1..n]
|   `-- tool_execution
|       +-- command_execution      仅真正启动 OS 进程时存在
|       `-- model_call             工具内部使用模型时存在
|
`-- context_compaction
    `-- model_call
        `-- model_attempt [1..n]
```

各 Span 的语义如下：

- `model_call` 是一次逻辑模型请求，覆盖 Retry/Fallback 后的整体结果；
- `model_attempt` 是一次真实发给 Provider 的物理请求；
- `tool_execution` 是注册工具的一次执行；
- `command_execution` 是 Tool 内真正启动的命令进程，不是 Tool 的“派生类型”；
- `agent_step` 是 Agent Loop 的一步，不等于一次模型 HTTP 请求。

逻辑调用成功率以 `model_call` 为统计对象；Provider 成功率、429/500、Endpoint 和 TTFT 以
`model_attempt` 为统计对象；工具成功率以 `tool_execution` 为统计对象；Shell/Git 退出码以
`command_execution` 为统计对象。

Resource、Context、SpanContext、Parent、Link、Event、Baggage 和 Metric 的定义及其在 ZCode
中的使用约束，详见
[OpenTelemetry 概念与 ZCode 取舍](./reference/otel-concepts.md)。

## 2. 观测设施边界

| 设施             | 用途                                              | 边界                   |
| ---------------- | ------------------------------------------------- | ---------------------- |
| CLI OTel Trace   | 单次 Agent/Model/Tool/Command 链路与故障下钻      | 页面体验、业务漏斗     |
| CLI OTel Metric  | 流量、成功率、延迟分位数、Token、Telemetry 健康   | 单次请求正文           |
| CLI SQLite Usage | 本地 Model/Turn/Tool 明细、设置页 Usage、本地对账 | ARMS 远端链路          |
| App RUM          | Renderer 页面、资源、API、前端异常和交互体验      | CLI Agent 内部执行树   |
| `/event/report`  | 产品行为、购买、反馈、业务漏斗                    | Agent 性能 Trace       |
| 本地日志         | 生命周期、人工诊断、用户可导出的排障信息          | 自动承载 Trace Payload |

Trace 不写入本地日志，也不通过 RUM 上报。即使这些数据最终进入同一个阿里云账号或 Workspace，
其数据模型和查询入口仍相互独立。

## 3. 设计原则

### 3.1 OTel 表达结构，ZCode 定义业务语义

Parent、Link、Context、Span、Event、Status、Resource 使用 OTel 原生能力；Turn、Step、
Attempt、Reasoning、Cache、Tool Outcome 等业务语义使用完整的 `zcode.*` 字段。

`zcode.*` 是内部查询的唯一权威字段。`gen_ai.*`、`http.*`、`server.*`、`process.*` 是从同一
事实投影出的兼容别名，用于外部工具理解，不能反过来决定业务 API 或内部报表。

### 3.2 在事实来源处记录

Provider 返回 Header 时记录 HTTP 状态；首段有效内容到达时标记 First Content；进程结束时记录
Exit Code。Telemetry 不应要求业务层额外构造聚合结果对象，也不应在远离事实来源的位置重新
推断或分类。

```ts
attempt.setHttpStatusCode(response.status);

for await (const event of stream) {
  attempt.markFirstProviderEvent();
  if (containsContent(event)) attempt.markFirstContent();
}

command.setExitCode(result.exitCode);
```

原始 Provider Error Message 经过凭据和路径脱敏后保留原意，不先折叠成少数错误模板。错误
分类仅作为额外的低基数维度，不替代原始信息。

### 3.3 一个独立生命周期才创建一个 Span

需要独立耗时、结果、错误、子节点或诊断入口的工作创建 Span；瞬时里程碑使用 Event；单个
事实使用 Attribute；跨请求聚合使用 Metric。

| 需求                               | 使用                                  |
| ---------------------------------- | ------------------------------------- |
| 一次 Tool 从开始到结束的耗时和结果 | Span                                  |
| Tool 请求权限的时刻                | Event                                 |
| 最终权限决定                       | Attribute；若要看时间点可同时有 Event |
| Provider Origin、Model、Exit Code  | Attribute                             |
| P95、全量成功率、Token 总量        | Metric                                |
| 后台任务由哪个前台操作触发         | Link                                  |

不应为 `parse`、`prepare` 这类只有失败定位价值的短阶段创建 Span；它们通常表示为
`failure_stage`。仅当该阶段需要独立 SLO 或内部子树时，才将其建模为 Child Span。

### 3.4 原始事实只有一个归属

Attempt Token 只属于 `model_attempt`，Exit Code 只属于 `command_execution`，Provider 错误正文
只记录在最接近来源、首次认领错误的 Span。父节点记录自己的 outcome 和 failure stage，不复制
Child 的 Token、错误正文或聚合摘要。

少量 ID 会为了 ARMS 查询能力投影到关键节点，例如 Turn ID、Logical Call ID。它们是受控查询
投影，不是用 Attribute 伪造父子关系。完整规则见
[Schema 字典](./reference/schema-reference.md#3-query-projection执行关联投影)。

### 3.5 Unknown 不等于 False

未观察到的事实应省略或明确写 `unknown`，不能推断为 `disabled`、Cache Miss、请求未流式、
`exit_code=0`。例如普通 Read Tool 没有进程退出码，因此不记录 Exit Code。

### 3.6 Telemetry 与业务执行隔离

Telemetry 初始化、Context 激活、Setter、Metric、导出和关闭失败，都不能改变业务返回值、异常
或执行次数。Disabled 模式返回 No-op Writer，业务调用方无需分别判断开关状态。

### 3.7 内容数据默认禁止上报

Prompt、模型输入输出、Reasoning 正文、Tool 输入输出、文件内容、完整命令、HTTP Header、Body
和 URL Query 禁止进入 Trace。无法确认隐私等级的数据在完成评审前不得采集。

## 4. Parent、Link 和独立操作

Parent/Child 表示同一条 Trace 中的执行所有权；Link 表示另一条独立 Trace 与触发者之间的因果
关系。

```text
工作是否属于当前调用者拥有的一段同步/await 生命周期？
    |
    +-- 是：Child Span，共享 traceId，parentSpanId 指向调用者
    |
    `-- 否：新 Root Span，使用 Link 指向触发者
```

当前约定：

- 普通主 Turn 是 Root；
- 前台 Subagent 被父 Tool await，Child Turn 直接挂在父 Tool 下；
- 后台 Subagent 和 Workflow Child 独立调度，创建新 Root 并 Link 到触发者；
- 标题生成、Goal 校验、Project Memory 等非 Turn 工作使用 `detached_operation`；前台执行可作为
  Child，队列/后台/恢复执行使用 Root + Link；
- Parent 可以先于 Child 结束，结束先后本身不是改用 Link 的理由；所有权和调度边界才是。

```text
同步 Subagent：
agent_turn -> agent_step -> tool_execution -> agent_turn(child)

后台 Subagent：
Trace A: tool_execution ---- Link ----> Trace B: agent_turn(root)

独立后台工作：
Trace A: triggering span -- Link ----> Trace B: detached_operation(root)
```

延迟任务必须在调度时调用 `captureCausation()`，不得在执行阶段读取当时的 Active Context 来
推断触发关系。
`AgentTelemetryCausation` 保存 OTel SpanContext 和少量查询投影 ID；它不是一份业务 Context。

字段命名、Lifecycle 继承、Query Projection 和各 Span 的完整字段，详见
[Span、Attribute、Event 与 Metric 字典](./reference/schema-reference.md)。

## 5. 接入方式

### 5.1 使用 Typed Writer

业务代码依赖 `@zcode/contracts/telemetry` 中的窄接口。Writer 的每个 Setter 对应一个明确事实，
内部负责 Attribute Key、校验、脱敏、Event、Metric 和外部兼容别名。

```ts
const step = runtimeTelemetry.step({
  stepId: assistantMessageId,
  stepIndex,
});

return step.run(async () => {
  try {
    const result = await executeStep();
    step.finishCompleted(result === "continue" ? "tool_requested" : "turn_completed");
    return result;
  } catch (error) {
    if (signal.aborted) {
      step.finishCancelled("abort_signal");
    } else {
      step.finishFailed("unhandled", "unknown", error);
    }
    throw error;
  }
});
```

`run()` 将当前 Span 写入 OTel Context，使内部创建的 Span 自动成为 Child，并统一处理未捕获
异常和遗漏终态。正常业务分支仍应显式调用语义准确的 `finish*()`。

### 5.2 终态处理与异常隔离

`try/catch` 记录业务已知终态，例如用户取消、权限拒绝和解析失败；`run()` 处理未捕获异常及
`missing_terminal`。已知业务分支提供准确语义，`run()` 提供异常隔离和终态完整性。

Writer 使用 exactly-once Terminal Latch。仅首个 `finishCompleted/Failed/Cancelled/...` 调用生效，
后续终态调用被忽略；Latch 在调用 OTel SDK 和 Metric 前关闭，以避免观测层异常导致重复终态。

### 5.3 Tool 和 Command

```ts
const tool = telemetry.startTool({
  registeredToolName: toolCall.name,
  toolCallId: toolCall.id,
});

return tool.run(async () => {
  tool.markPermissionRequested();
  const decision = await requestPermission();
  tool.setPermissionDecision(decision);

  if (decision === "denied") {
    tool.finishDenied("user_denied");
    return deniedResult;
  }

  const result = await executeTool(tool);
  tool.setOutputBytes(result.outputBytes);
  tool.setOutputTruncated(result.truncated);
  tool.finishCompleted();
  return result;
});
```

只有 Tool 真正启动 OS 命令时才创建 Child：

```ts
const command = tool.startCommand({
  category: "git",
  commandCount: 1,
  safeName: "git.status",
  sandboxed: true,
  shellKind: "bash",
});

return command.run(async () => {
  const result = await spawnProcess();
  command.setExitCode(result.exitCode);
  command.setOutputBytes(result.outputBytes);
  command.finishCompleted();
  return result;
});
```

`safeName` 是受控命令族，不是完整命令。参数、路径、脚本和环境变量禁止上报。

### 5.4 Model Call 和 Attempt

业务调用点只声明模型调用的业务用途；Provider Adapter 和状态记录器补齐真实请求事实。调用方
不应手填 UID、Session、Provider Origin、实际 Model、Token、Cache、HTTP 错误或 TTFT。

```text
model_call(operation=agent_step, logical_call_id=L1)
|
+-- model_attempt(request_id=R1, attempt_number=1) -> failed 429
`-- model_attempt(request_id=R2, attempt_number=2) -> completed
```

`ModelApiTelemetryStatusSink` 监听统一 Model Status Event，依次调用：

```ts
call.startAttempt(...);
attempt.setHttpStatusCode(429);
attempt.setProviderErrorCode("rate_limit");
attempt.setProviderErrorMessage(providerMessage);
attempt.markFirstProviderEvent();
attempt.markFirstContent();
attempt.setInputTokens(inputTokens);
attempt.setCacheReadTokens(cacheReadTokens);
attempt.finishCompleted();
call.finishCompleted();
```

Provider、Endpoint、Model、Reasoning 和 Usage 都从 API 封装层的真实请求/响应写入。完整字段见
[Model Span 字典](./reference/schema-reference.md#11-model_call)。

### 5.5 独立操作和所有 LLM 入口

Turn 外的模型工作必须先创建 `detached_operation`，再让内部 `model_call` 自动成为 Child。
`operation` 使用受控枚举，目前包括：

```text
goal_completion_verification
goal_title_generation
project_memory_extract
project_memory_dream
project_memory_recall
session_title_generation
tool_internal_model_call
web_fetch_processing
web_search
workspace_git_commit_message
workspace_generate_text
```

`agent_step` 和 `context_compaction` 分别由其专属 Span 承载，不使用
`detached_operation` 包裹。新增 LLM 入口时，必须先选择现有 operation；仅当执行语义和统计
维度均不相同时新增枚举。所有 Operation 的定义与调用入口详见
[Schema 字典中的 Operation 枚举](./reference/schema-reference.md#14-operation-枚举)。

## 6. 观测扩展流程

### 6.1 新增 Span

```text
需要独立耗时/结果/错误/子树吗？
    |
    +-- 否：Attribute 或 Event
    |
    `-- 是：现有 Span 能准确表达吗？
              |
              +-- 是：给现有 Writer 增加必要 Setter
              `-- 否：新增稳定 Span Name + Typed Writer
```

新增 Span 时必须同时完成：

1. 定义开始和结束边界；
2. 定义 Parent 或 Root + Link；
3. 在 Contracts 中增加专属 Start 类型和 Writer；
4. 在 Runtime 中显式写 Canonical `zcode.<span_name>.*` Key；
5. 定义 outcomes、failure stages、events 和隐私；
6. 更新 [Schema 字典](./reference/schema-reference.md)；
7. 添加拓扑、终态、异常隔离、隐私和 Metric 测试。

### 6.2 新增字段

新增字段必须明确以下内容：

- 它属于 Resource、执行投影、Lifecycle，还是某个 Span？
- 原始事实在哪里首次确定？
- 类型、单位、允许值、缺失语义是什么？
- 是否包含身份、内容、路径、URL、凭据或自由文本？
- 会不会被用于 Metric Label；若会，基数是否有界？
- 是否需要 GenAI/OTel 兼容别名，转换是否无损？

随后在具体 Writer 增加语义明确的 Setter。业务接口不得暴露 `setAttribute(key, value)`，也不应
引入运行时 Schema Registry 或二次映射层。

### 6.3 新增 Event

Event 应当是一个有诊断价值的瞬时里程碑，并通过具体方法暴露，例如
`markFirstContent()`。需要明确去重和次数上限；禁止每个 Streaming Chunk 都写 Event。

### 6.4 新增 Metric

Metric 必须定义分母、Instrument、Unit、Bucket 和 Label。只允许低基数 Label；Session ID、
Request ID、Endpoint、错误消息、安装 ID 和用户 ID 禁止成为 Label。Metric 不从 ARMS Trace
查询结果反推，而由 Writer 在事实确定时直接记录。

## 7. 隐私与性能约束

### 7.1 允许记录的数据

- 稳定枚举、计数、时长、Token、HTTP 状态；
- 受控 Registry Tool Name 和命令族 Safe Name；
- Provider/Model 的运行事实；
- 清洗后的 Provider Origin 与 Route；
- 脱敏、截断后的错误类型、错误码和错误信息；
- 产品生成的安装假名 ID、受控用户主体 ID 和执行关联 ID。

安装 ID 是持久化随机假名，不是硬件 ID，也不是“匿名无风险数据”。用户 ID 当前按受控主体 ID
原值记录，没有额外 Hash；这两者都只能用于 Trace 查询，不能进入 Metric Label。

### 7.2 禁止记录的数据

```text
Prompt / Message / Reasoning 正文
Tool 输入输出 / 文件内容 / Patch
完整 Command / 参数 / cwd / 环境变量
HTTP Header / Body / Cookie / Authorization
URL Query / Fragment / 用户名 / 密码
OTLP License Key 或其他 Secret
```

Endpoint 清洗移除用户名、密码、Query 和 Fragment，并对邮箱、UUID、长数字、长哈希和疑似 Token
Path Segment 替换占位符；结果按 `(providerKind, baseURL)` 使用有界缓存。错误消息先做有界截断，
再清除凭据、邮箱、常见本地路径和 URL 敏感部分。

### 7.3 热路径约束

Setter 只能执行常数级、小对象操作；禁止同步文件/网络 I/O、遍历 Prompt、序列化大型 JSON 或
逐 Chunk 上报。Span 经 BatchSpanProcessor 异步、批量、Gzip 导出。达到每进程 5000 个活跃
Writer 上限时，旁路新 Span 并记录 Telemetry Health，不阻塞 Agent。

Endpoint、错误信息和身份字段的脱敏算法，以及导出预算、容量上限和降级行为，详见
[Runtime 参考](./reference/runtime-and-operations.md#7-性能容量与可靠性)。

## 8. ARMS 查询

Trace 在 ARMS 应用监控/调用链分析中查询，不是在 RUM 体验看板中查询。基本过滤条件：

```text
serviceName : zcode-cli-agent
and resources.zcode.telemetry.schema_version : 5
```

常用查询：

```text
# 所有 Turn
spanName : agent_turn

# 失败的物理模型请求
spanName : model_attempt
and attributes.zcode.model_attempt.outcome : failed

# 某个 Turn 的关键节点
attributes.zcode.execution.turn_id : <turn-id>

# 某个安装实例的模型请求
spanName : model_attempt
and resources.zcode.device.installation_id : <installation-id>

# 某个逻辑调用的全部 Retry Attempt
attributes.zcode.execution.logical_call_id : <logical-call-id>
```

错误查询使用：

- HTTP 429/500：`attributes.zcode.model_attempt.http_status_code`；
- Provider 原始错误码：`attributes.zcode.model_attempt.provider_error_code`；
- Provider 原始错误信息（已脱敏）：
  `attributes.zcode.model_attempt.provider_error_message`；
- 终止 Attempt 的 Error（通常是 Transport/SDK 异常）：
  `attributes.zcode.model_attempt.error_message`；
- 请求地址：`provider_origin` 与 `provider_route`，不使用原始 URL。

准确成功率、QPS、Token 和 P95/P99 优先使用 OTLP Metric；Trace 用于定位具体执行样本。完整
Saved Query、Dashboard 和统计公式详见
[ARMS 参考](./reference/runtime-and-operations.md#9-arms-查询大盘与统计口径)。

## 9. 文档、代码与测试的职责

```text
核心规范
    数据模型 + 设计原则 + 接入方式 + 系统边界

专题参考
    OTel 概念 + 完整字段字典 + Runtime/运维细节

TypeScript Contracts / Writers
    可编译的方法签名、枚举和 Attribute 写入

Tests
    拓扑、字段、终态、脱敏、兼容投影和导出的可执行证明
```

主要代码位置：

- Contracts：`apps/zcode-cli/packages/contracts/src/telemetry/`；
- Writer Runtime：`apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts`；
- Context 与终态基类：`apps/zcode-cli/packages/telemetry/src/agent-trace-support.ts`；
- Model Status 到 Writer：`apps/zcode-cli/packages/telemetry/src/model-api-recorder.ts`；
- Compatibility Adapter：`apps/zcode-cli/packages/telemetry/src/compatibility-adapters.ts`；
- Metric：`apps/zcode-cli/packages/telemetry/src/agent-metrics.ts`；
- OTLP Owner/Exporter：`apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts`；
- 业务 Facade：`apps/zcode-cli/packages/core/src/telemetry/runtime-telemetry.ts`。

维护规则：

1. 新增或修改 Span、Attribute、Event、Metric、枚举、隐私和统计口径，必须同步更新字段字典；
   字段语义不能仅依赖代码表达。
2. 改变整体原则、接入接口或边界时，同时更新本文；字段级细节只更新相应专题参考。
3. 迁移过程和评审记录完成后移入 `archive/`，不得与当前规范并列。
4. 破坏字段、类型、单位、终态或拓扑时升级 Telemetry Schema Version；产品版本和 CLI 版本独立
   演进。
5. 提交前运行相关测试、`pnpm typecheck` 和 `pnpm lint`。

## 10. 版本轴

| 含义                     | 字段                             | 当前来源                               |
| ------------------------ | -------------------------------- | -------------------------------------- |
| CLI Telemetry 生产者版本 | `service.version`                | `apps/zcode-cli/package.json` 构建注入 |
| Desktop/产品版本         | `zcode.product.version`          | 产品构建元数据；文档和代码不硬编码版本 |
| 数据契约版本             | `zcode.telemetry.schema_version` | Contracts 常量，当前为 5               |
| 精确构建身份             | `zcode.build.commit_id`          | 可信 CI/Git 构建元数据                 |

报表比较发布效果时应同时保留 Schema Version、CLI Version、Product Version 和 Build Commit，
不能把它们当作同一个版本字段。
