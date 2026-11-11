# 手机远控输入预测（ghost hint）

手机远控的输入框在合适的时机显示一段灰色的预测文本（ghost hint），用户点一下即可采纳。本文定义 Host（桌面端 / CLI）侧的只读查询、线格式、能力探测和开关。手机端（KMP）按本文实现，并且手机侧另有自己的 feature flag。

## 链路

```text
手机 ZCodeAgentServiceClient.invoke("conversationInputPredictionV4", target, params)
  → 桌面 IZCodeAgentService.conversationInputPredictionV4（packages/services）
      开关关闭 → 直接回 unavailable，不转发
      开关开启 → getReadOnlyClient(existing-only)，不为预测拉起运行时
  → CLI v4/conversation/inputPrediction（apps/zcode-cli/packages/bootstrap）
      ConversationInputPredictionHandler：同会话替代、LRU 缓存、降级
  → core input-prediction-sidecar：上下文组装、提示词、解析、后过滤、决策
  → app.generateWorkspaceText(querySource = "input_prediction")：辅助档位，一次非流式调用
```

这是只读、无状态的查询，不改会话状态，也不做 CAS。一次预测会在会话事件日志里追加 ModelRequest/ModelComplete 两个事件，与标题生成一样。它不会进入对话转录。

## 线格式

方法：`v4/conversation/inputPrediction`，即 `V4_METHODS.conversationInputPrediction`。手机侧的 service 方法名是 `conversationInputPredictionV4`。schema 定义在 `packages/shared/src/zcode-protocol-v4/input-prediction/contract.ts`（架构登记为 managed 模块 `remote-input-prediction`，见同目录 `CONTRACT.md`）。

### 请求

手机发给 service 的请求在 `ZCodeAgentSessionTarget`（workspacePath 等）的基础上增加以下字段：

| 字段        | 类型          | 必填 | 说明                                                                                       |
| ----------- | ------------- | ---- | ------------------------------------------------------------------------------------------ |
| `sessionId` | string（≥1）  | 是   | 会话 id                                                                                    |
| `revision`  | int ≥ 0       | 是   | 手机当前看到的会话 revision，参与缓存键                                                    |
| `draft`     | string ≤ 4000 | 否   | 输入框当前草稿。缺省或纯空白表示预测下一条完整输入，非空表示续写草稿；超长请先在手机侧截断 |
| `requestId` | string 1..128 | 否   | 手机生成的请求号，原样回显                                                                 |

CLI 侧 params 使用严格 schema，多余字段会被拒绝。

### 响应

```jsonc
{
  "decision": "show", // 见下表
  "candidates": [{ "text": " 再跑一遍测试", "confidence": 0.9 }], // 0..3 个，按 confidence 降序
  "topConfidence": 0.9, // 0..1；无候选时为 0
  "requestId": "r-42", // 请求带了才回
}
```

- `candidates[].text` 是**接在草稿后面的文本**。草稿为空时它就是整条输入。
  - 长度为 1..40 UTF-16 code unit，单行。
  - 不能是纯空白。
  - **不做 trim**：例如英文续写可以以空格开头。手机直接把它拼接成 `draft + text`。
- `decision` 的取值：

| decision                   | 含义                                                                                        | 手机行为                     |
| -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| `show`                     | top 候选的 confidence ≥ 0.8                                                                 | 展示 `candidates[0]`         |
| `suppress_below_threshold` | 有候选但置信度不够，或模型输出无法解析                                                      | 不展示                       |
| `suppress_no_context`      | 上下文不足：会话不在 CLI 内存，或真实用户输入轮数不够（无草稿时要求 ≥2 轮，有草稿时 ≥1 轮） | 不展示                       |
| `unavailable`              | Host 开关关闭、无运行时、旧 CLI、无模型、模型超时或失败                                     | 不展示；本会话可适当降低频率 |
| `cancelled`                | 同一会话来了更新的请求，本请求被中止                                                        | 丢弃                         |

除 `cancelled` 外，手机都应该再核对 `requestId` 和 `revision` 是否仍是最新的，不是最新的就丢弃。

### 失败语义

- service 层**不会因为预测失败而抛错**：开关关闭、无运行时、远端旧 CLI 不认识该方法（Method not found）、CLI 返回不合 schema 的数据，都会统一回 `unavailable`。
- RPC 本身的错误（通道断开、超时）仍可能抛给手机。手机把**任何异常都视为「无 hint」**，不提示用户，也不重试。

## 能力探测

v4 `hello.capabilities.inputPrediction`：

- `true`：Host 开关已开启，手机可以发起预测。
- `false` 或字段缺席（老 Host）：手机**不得**发起预测。

判断必须写成 `=== true`。`hostCapabilitiesSchema` 不是 strict 的，加这个可选字段对老客户端是线兼容的。字段由 `createHello()`（`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`）在每次 hello 时按开关计算。它和 service 方法的门禁共用同一个判定函数，二者不会不一致。

hello 只能说明 Host 侧已经开启。如果 Host 连接的是远端（SSH）上的旧 CLI，这一点无法通过 hello 得知，此时请求会得到 `unavailable`。

## 开关

| 项       | 值                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 环境变量 | `ZCODE_REMOTE_INPUT_PREDICTION`，由桌面 Host 进程读取（`packages/services/src/zcode-agent/inputPredictionSwitch.ts`）                                                                            |
| 取值     | 去掉首尾空白后：未设置或为空 → 取缺省值（开启）；`"1"` → 开启；`"0"` 或其它任何值 → 关闭                                                                                                         |
| 缺省     | **开启**（`REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED = true`）。用户决定（2026-10-23）：输入预测所有渠道默认打开。每次请求都会调用一次模型，有成本；需要关闭时设 `ZCODE_REMOTE_INPUT_PREDICTION=0` |
| 生效     | 每次 hello 和每次请求都会重新读取。运行中修改进程环境变量不会生效，需要重启桌面端                                                                                                                |
| 错误行为 | 无效值（非空且不是 `"1"`）按关闭处理，不报错                                                                                                                                                     |
| 测试     | `packages/services/test/inputPredictionSwitch.test.ts`、`packages/services/test/zcodeAgentService.v4.test.ts`（inputPrediction 用例）                                                            |

之所以用环境变量而不是设置项，是因为这是 Host 侧总开关，不面向普通用户。最初灰度阶段缺省关闭；2026-10-23 按用户决定改为缺省开启（与手机端所有渠道默认开一致），环境变量保留为关闭手段。后续如改为设置项，需同步更新本文。

## 服务端行为

### 取消、替代与超时

- **同会话替代**：同一个 `sessionId` 只保留一个进行中的预测。新请求一到达就中止旧请求，旧请求回 `cancelled`。不同会话互不影响。
- **超时**：CLI 单次模型调用上限为 20s（`INPUT_PREDICTION_MODEL_TIMEOUT_MS`），超时回 `unavailable`。即使模型执行面没有及时响应 abort，也会立刻放弃等待。
- **连接断开或进程关闭**：中止全部进行中的预测，并清空缓存。
- 目前没有显式的 cancel RPC。手机想取消时，直接发下一次请求即可（会触发替代）。如果手机只是不再需要结果，丢弃回包即可。

### 缓存

以 `(sessionId, revision, normalizedDraft)` 为键，做 16 条的 LRU 缓存，缓存终态结果（`unavailable` 和 `cancelled` 不缓存）。命中缓存时不调用模型，只换上本次的 `requestId`。纯空白草稿和无草稿使用同一个键。

### 上下文与决策

- 上下文取自 CLI 内存中驻留的会话。
  - 轮次 = 真实用户输入，配上它到下一条真实用户输入之前最后一条非空的助手文本。合成消息和 provider-only 上下文不算轮次，也不截断轮次（例如写在 prompt 与回答之间的隐藏提醒行）。
  - 只取最近 6 轮：用户输入取全文，助手回复截断到 800 字，总预算 6000 字，超出时从最旧的部分截掉。
- 草稿为空时用「下一条输入预测」提示词，草稿非空时用「续写」提示词。两者都要求输出 3 个带 confidence 的候选 JSON，语言与用户保持一致。
- 后过滤：
  - 把候选收敛为单行续写，剥掉模型重复的草稿前缀。
  - 截断到 40。
  - 与最近 2 条用户输入相同的候选丢弃（比较 `draft + text`，忽略大小写和空白）。
  - 候选之间去重，按置信度降序取前 3 个。
- 模型选择沿用会话当前的模型选择，使用辅助档位（与 Git Commit 消息相同的最低公开推理档位）。会话没有模型选择时回 `unavailable`。

### 日志

降级时只记 warn，内容只包括事件名、sessionId 和错误消息，**不记草稿和会话内容**。被替代的请求不记日志。

## 手机端建议（KMP）

1. 只有 `hello.capabilities.inputPrediction === true`，并且手机侧 flag 打开时，才启用预测。
2. 触发时机：输入框为空、失焦且会话空闲时，预测下一条输入；用户输入过程中停顿（防抖约 600–800ms）时，预测续写。发送消息、切换会话或收到新的 revision 后，丢弃在途结果。
3. 每次请求都带上自增的 `requestId` 和当前 `revision`。回包的 `requestId` 或 `revision` 不是最新的就丢弃，`cancelled` 直接丢弃。
4. 手机侧超时建议约 25s，比 CLI 的 20s 略长，这样服务端的降级结果能先到达。超时或任何异常都视为无 hint。
5. 只展示 `decision === "show"` 时的 `candidates[0]`，拼接到草稿后面显示为灰字；采纳时写入 `draft + text`。

## 兼容性

- 新 Host + 旧 CLI（例如远端 SSH 上的旧版本）：方法不存在，service 层回 `unavailable`。
- 旧 Host：hello 中没有该字段，手机不会发请求。
- 旧手机：不会发这个请求。hello 里多出的可选字段不影响旧手机解析。
