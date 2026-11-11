# Provider 重构 E2E 回归分析（2026-08-31）

## 1. 结论摘要

在 MacBook Pro 的标准仓库目录、当前分支提交 `21c38683e1` 上，问题清单中的 37 个 Case 已全部稳定复现：

- 没有 flaky；
- 没有 Electron、WebDriver、构建或机器环境失败；
- 37 个表面失败可归并为 7 类共同根因；
- 当前证据没有证明 37 个产品行为都发生了回归。绝大多数 Case 在进入它真正要证明的业务行为之前，就被过时的 E2E 夹具、已删除的旧持久化字段或错误的 Account Config 注入方式拦住了；
- 这些测试不能简单删除。除 3 个明确验证“未上线旧格式迁移”的 Case 外，其余业务目标仍有价值，需要迁到当前 Provider/Account/Registry 契约后重新运行，才能判断是否还存在真实产品 Bug。

当前正式事实链是：

```text
ZCode Built-in Provider Config
              |
              v
Account Overlay
├─ access.entitled
├─ 当前账号 Provider 可用性
└─ Start Plan 动态模型成员（如有）
              |
              v
Personal Overlay
├─ 用户 API Key / 自定义 Provider
├─ 用户模型成员
└─ Personal Model Config Rules
              |
              v
Effective Provider / Model Config
              |
              v
Process-owned Provider Registry
              |
              v
Model Selection / Active Model
```

失败测试中仍反复使用的旧链路则是：

```text
legacy family mode / selectedKey
              +
把 Account Provider 当 Personal API-Key Provider 写盘
              +
等待 workspace_update_provider_registry.completed
              |
              v
旧测试认为 Provider 已可用
```

这条旧链路已经不再存在，所以出现了大量“页面没有 Coding Plan”“实际回退 DeepSeek”“Registry revision 未应用”等级联失败。

## 2. 复现基线与产物

### 2.1 基线

- Samantha 工作区：独立 worktree
- MacBook Pro 标准仓库：`/Users/dev/Desktop/projects/Z.AI/z-code`
- 两端提交：`21c38683e1 test(ui): remove stale built-in model label assertion`
- MacBook Pro 使用已有标准 bootstrap/build 结果；执行时设置 `ZCODE_E2E_SKIP_BUILD=1`、`ZCODE_E2E_SKIP_AGENT_BUILD=1`，没有修改系统配置。

### 2.2 四轮原生 Desktop E2E

| 运行 | 范围                                                        | 结果                                     | Artifact                          |
| ---- | ----------------------------------------------------------- | ---------------------------------------- | --------------------------------- |
| A    | 4 个 Bot 目标 Case + 1 个同 spec 对照 Case                  | 1 pass / 4 fail                          | `desktop-e2e-20260831-093430-761` |
| B    | Coding Plan、Quota Reset、Upgrade Webview                   | 1 pass / 19 fail；清单中的 15 条全部失败 | `desktop-e2e-20260831-093509-202` |
| C    | I20、CW、OTB、I08                                           | 0 pass / 4 fail                          | `desktop-e2e-20260831-095111-677` |
| D    | Restart、Selected-key migration、Settings transition、Turbo | 1 pass / 15 fail；清单中的 14 条全部失败 | `desktop-e2e-20260831-095400-329` |

Artifact 根目录：

```text
/Users/dev/Desktop/projects/Z.AI/z-code/packages/desktop/.e2e-artifacts/
```

四轮报告均显示 `0 flaky`、`0 infra failure`。

## 3. 七类共同根因

### R1. Bot 合成 Harness 没有提供目标 Host 的 preferred selection

当前 Bot 首次提交必须在 Submission 边界固定目标 Host 的模型：未显式选择时读取 `ModelSelectionView.preferredSelection`，无法解析就拒绝创建任务。生产边界位于 `packages/services/src/bots/botsService.ts`。

但两个 Bot E2E Harness 都仍返回空 View：

```ts
getView: async () => ({ revision: 0, providers: [] });
```

位置：

- `packages/desktop/test/e2e/bots/helpers/bots-service-harness.ts`
- `packages/desktop/test/e2e/bots/delivery/feishu-streaming-card-lifecycle.test.ts`

因此消息处理在创建 Task、建立订阅以前就抛出“Bot 无法从目标 Host 解析 Submission 模型”。后面的 terminal event、AskUserQuestion 卡片、streaming card 生命周期自然全部不存在。

判断：测试 Harness 过时，不是四个独立的 Bot 产品回归。

正确处理：Harness 注入一个最小但真实的 `ModelSelectionView`（含 Provider、Model 和 preferred selection），继续验证原来的 Bot 行为；不能恢复旧 fallback 或绕开正式 Model Selection。

### R2. Coding Plan E2E 仍以旧 family mode / selectedKey 作为权威

`coding-plan-team-usage.test.ts` 的场景准备仍写入：

```ts
modelProviderFamilyModes;
modelProviderFamilySelectedKeys;
```

当前正式字段只有：

```ts
providerFamilyConnectionSelections;
```

其结构化 union 定义在 `packages/shared/src/provider-family-connection-selection.ts`。旧字段及其迁移在提交 `8c55290f1f refactor(provider): finish model abstraction cleanup` 中被明确删除；原因是它们尚未发布，不再背负兼容迁移。

App Settings 的严格解析会丢弃旧字段。测试随后仍以旧字段断言 Team Plan identity，于是出现：

- 连接方式没有个人 / Team Coding Plan；
- Usage 页面没有 Coding Plan tab；
- Context usage trigger 和 quota reminder 没有出现；
- OAuth 恢复后“selectedKey 被覆盖”；
- I29/I30 实际已经写入新的结构化 selection，但测试仍断言旧 `mode=oauth`，所以误报失败。

判断：这是同一套旧设置夹具造成的级联失败。

正确处理：场景输入和断言都只使用 `providerFamilyConnectionSelections`；Team Plan 直接断言完整的 `productId/organizationId/projectId`，不再生成或检查字符串 selectedKey。

### R3. E2E 把 Account Provider 当成 Personal API-Key Provider

当前 Account Provider 的职责边界是：

```text
Built-in：声明 Provider 静态身份、API、模型成员
Account Overlay：声明 access.entitled、账号动态成员/访问事实
Personal Overlay：不拥有 Account access，也不能用 enabled 伪装 entitlement
```

Resolver 只有在 `access.type !== zhipu-account` 或 `access.entitled === true` 时，才认为 Provider 可执行。

失败测试仍采用旧注入方式：

- `coding-plan-team-usage.test.ts` 为 `account:bigmodel-individual-coding-plan` 写 Personal `apiKey`、`enabled`、Endpoint 和模型；
- Restart/Turbo helpers 用 `seedReplayProvider()` 给 `account:*` 写 Personal Provider，却没有建立 Account Overlay entitlement；
- Upgrade Webview 测试通过 `readModelProvider()` 读取 Personal Config，并期待 Account Provider 中出现 `apiKey` 和 `enabled`。

结果有两种：

1. Account Provider 因 `entitled !== true` 不可执行，Selection 合法回退到 DeepSeek；
2. 测试读取的是 Personal Source，自然看不到属于 Account/凭据链的动态 Key 或 entitlement。

判断：这是测试越过配置分层后的错误夹具/错误观察点，不应通过放宽生产 Schema 修复。

正确处理：

- Account Case 在 Account Source/账号 API mock 边界提供 `entitled=true` 和对应模型成员；
- OAuth/业务凭据继续由 Credential fixture 提供；
- Personal Config 只保留真正允许的 Personal Model Overlay；
- 测试 Provider 可用性时读取 Effective Settings/Selection View 或正式请求结果，不读 Personal 文件猜 Account 状态。

### R4. I20 已写入新 agents-state 结构，但 E2E 仍读取旧字段

Subagent Service 当前可以读取旧：

```text
builtInModelOverrides
builtInThoughtLevelOverrides
```

作为兼容输入，但保存时统一写：

```text
builtInModelSelectionOverrides[agentName] = {
  providerId,
  modelId,
  options: { reasoningLevel }
}
```

I20 在选择 `high` 后仍轮询原始 JSON 的 `builtInThoughtLevelOverrides.Explore`，因此报“没有写入”。这并不能证明保存失败；它只证明保存后文件已经不再维持旧双 map 结构。

判断：观察断言过时。该 Case 尚未运行到冷启动 child request 的真正核心断言。

正确处理：E2E 读取并断言 `builtInModelSelectionOverrides`；如需验证旧文件输入兼容，应另设一次性 importer/reader 单测，不让正常 E2E 继续要求写回旧格式。

### R5. CW / OTB / I08 等待一个已经删除的 workspace Registry push 日志

三项测试都把下面的日志当成 readiness barrier：

```text
zcode_protocol.workspace_update_provider_registry.completed
```

当前生产代码已经没有这个事件，仓库中只剩这三个 E2E 在搜索它。Provider 重构后 Registry 是 process-owned runtime，启动事件是：

```text
zcode_protocol.provider_registry.ready
```

Personal Config 的更新也由正式 Runtime/Registry source 处理，不再向每个 workspace 推一份 Registry snapshot。

因此三项测试均在旧日志轮询处超时，尚未检查 context window、output token budget 或新增 Provider 首发请求。

判断：测试同步屏障过时，不代表 Registry 更新真的没有应用。

正确处理：删除 workspace Registry push 的日志解析 helper，改用当前正式的 Registry ready/Selection View/最终请求捕获作为可观察完成条件。不能为了 E2E 恢复已删除的 workspace Registry 协议。

### R6. I32-I34 专门验证了已裁决删除的未发布迁移

这三个 Case 的标题和实现都要求启动时修复：

```text
modelProviderFamilyModes + modelProviderFamilySelectedKeys
                         -> 新 selectedKey
```

但当前设计不再有“新 selectedKey”；目标是结构化 `providerFamilyConnectionSelections`。旧迁移又已按“未上线，不兼容读取”裁决删除。

判断：这 3 个 Case 的目标已失效，不应修生产代码使其重新通过。

正确处理：删除这三个旧迁移 Case。若仍需启动恢复覆盖，替换为“结构化 selection JSON round-trip 后 identity 不变”，不要测试旧字符串修复。

### R7. CPUW-03 的 Webview mock 假设也已过时

`triggerCodingPlanWebviewPurchaseComplete()` 先读取可见 Webview origin，再把这个 origin 当作本地 upgrade mock server 调用“标记购买完成”。当前实际 Webview URL 是正式 ZCode Endpoint：

```text
https://zcode.z.ai/coding-plan...
```

它不是本地 mock server，所以 CPUW-03 在触发 bridge 以前就失败。该 Case 同时还在购买后读取 Personal Provider 的 `enabled`，与 R3 相同。

判断：当前失败点是 Webview E2E mock 接线和 Account 状态断言过时；尚未证明购买完成 bridge 或刷新逻辑失败。

正确处理：mock 控制面地址必须来自 WDIO 启动的 upgrade mock，而不是从 Webview 可见 origin 反推；Webview 页面/导航可继续使用受信 ZCode Endpoint fixture。购买后通过正式 Provider Settings/Account entitlement 观察刷新结果。

## 4. 37 条逐项结论

|   # | Case                            | 实际最早失败点                                        | 根因    | 判断与下一步                                               |
| --: | ------------------------------- | ----------------------------------------------------- | ------- | ---------------------------------------------------------- |
|   1 | BOT-E2E-CR-01                   | terminal event 为 false                               | R1      | Harness 补 preferred selection 后重跑 terminal delivery    |
|   2 | BOT-E2E-AQ-01                   | AskUserQuestion card 不存在                           | R1      | Task 尚未创建；补 Harness 后重跑卡片聚合                   |
|   3 | BOT-E2E-IL-01                   | completed interaction card 不存在                     | R1      | Task 尚未创建；补 Harness 后重跑 sealing                   |
|   4 | Feishu streaming card lifecycle | callback/stream/typing/terminal 未合卡                | R1      | 同一 standalone Harness 为空；补模型后重跑                 |
|   5 | CTP-02                          | 连接方式选项断言失败                                  | R2 + R3 | 用结构化 selection + Account entitlement 重建 fixture      |
|   6 | CTP-04B                         | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达 activity/detail/performance 断言                  |
|   7 | CTP-05                          | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达个人/团队组合展示                                  |
|   8 | CTP-06                          | 旧 selectedKey 未保留                                 | R2      | 改断言结构化 Team identity；不恢复 selectedKey             |
|   9 | CTP-09                          | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达 activity failure isolation                        |
|  10 | CTP-10                          | Context usage trigger 不存在                          | R2 + R3 | 当前没有可用 Coding Plan source；重建后再验 freshness      |
|  11 | CTP-11                          | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达 quota fatal/recovery                              |
|  12 | QR-E2E-01                       | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达 opportunity/status 权威关系                       |
|  13 | QR-E2E-02                       | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达多类型机会展示                                     |
|  14 | QR-E2E-09                       | initial reminder 不存在                               | R2 + R3 | source 未成立；重建后再验常驻/hover                        |
|  15 | QR-E2E-10                       | urgent reminder 不存在                                | R2 + R3 | source 未成立；重建后再验三分钟边界                        |
|  16 | QR-E2E-04                       | Context usage trigger 不存在                          | R2 + R3 | 尚未触达 HoverCard/Dialog 生命周期                         |
|  17 | QR-E2E-03                       | 无法进入 Coding Plan tab                              | R2 + R3 | 尚未触达 `used_at` 完成条件                                |
|  18 | CPUW-01                         | Personal reader 中 Account apiKey 缺失                | R3      | 改为正式凭据/Account 刷新观察点后重跑                      |
|  19 | CPUW-03                         | 对正式 Webview origin 调本地 mock 标记失败            | R7 + R3 | 修 mock 控制面接线，并移除 Personal enabled 断言           |
|  20 | I20                             | 旧 `builtInThoughtLevelOverrides` 不再出现            | R4      | 改读 structured selection；随后才验证冷启动 child request  |
|  21 | CW01-CW04                       | 等不到已删除的 workspace registry 日志                | R5      | 换正式 readiness/request barrier 后重跑 limits/compact     |
|  22 | OTB01-OTB03/06-07               | 等不到已删除的 workspace registry 日志                | R5      | 换 barrier 后重跑 request/compact/runtime budget           |
|  23 | I08                             | 等不到已删除的 workspace registry 日志                | R5      | 换 barrier 后重跑设置新增、选择和首发                      |
|  24 | I26/MP-R02                      | Account 模型不可执行，回退 DeepSeek                   | R3      | 在 Account Source seed entitlement 后验证非首模型恢复      |
|  25 | I27/MP-R03                      | 旧模型不可执行，回到目标 Host preferredSelection      | R3      | seed 当前 Coding Plan entitlement 后验证 Host 当前有效选择 |
|  26 | I28/MP-R04                      | Recent 选择不可用，回到目标 Host preferredSelection   | R3      | seed 当前连接 entitlement 后验证 Host 当前有效选择         |
|  27 | I32/MP-M01                      | 旧 selectedKey 不再迁移                               | R6      | 删除；如有需要改为 structured api-key selection round-trip |
|  28 | I33/MP-M02                      | 旧 Team selectedKey 不再迁移                          | R6      | 删除；改为 structured Team identity round-trip             |
|  29 | I34/MP-M03                      | 不再修复残缺旧 key                                    | R6      | 删除；严格 Schema 对残缺 identity 的行为放单测             |
|  30 | I29/MP-S01                      | 实际已写新 selection，旧 `mode=oauth` 断言失败        | R2      | 改断言 structured selection，再继续验证 DeepSeek draft     |
|  31 | I30/MP-S02                      | 实际已写新 selection，旧 `mode=oauth` 断言失败        | R2      | 同上；不是 transition 本身的失败证据                       |
|  32 | I31/MP-S03                      | 目标 Account Plan 不可执行，仍为 DeepSeek             | R3      | seed entitlement 后重跑 reconciliation/highspeed           |
|  33 | I35/MP-T01                      | Individual Plan/Turbo 模型不在可选集合                | R3      | 当前只出现 Team Account models；修 Account fixture 后重跑  |
|  34 | I36/MP-T02                      | Individual Plan/Turbo 模型不在可选集合                | R3      | 尚未发送首个 Plan request                                  |
|  35 | I38/MP-T04                      | 实际选中 Team GLM-5.3，非 fixture 的 Individual Turbo | R3      | Account identity/entitlement 不一致；尚未验证迟到回包      |
|  36 | I39/MP-T05                      | Individual Turbo 模型不在可选集合                     | R3      | 尚未验证原子切换和 last-selected                           |
|  37 | I42/MP-T06                      | Individual GLM-5.2 不在目标可选集合                   | R3      | 尚未验证 thought 丢弃                                      |

## 5. 建议修复顺序

### 阶段 1：先修测试基础事实，不碰生产语义

1. Bot Harness 提供正式 `ModelSelectionView`。
2. 建立统一的 Account E2E fixture：从 Account Source/账号 API mock 发布 `access.entitled` 和动态模型；禁止再把 Account access 写入 Personal Config。
3. Coding Plan 场景全面切到 `providerFamilyConnectionSelections`。
4. Subagent E2E 改读 `builtInModelSelectionOverrides`。
5. 删除三个旧 selectedKey 迁移 Case，或改为结构化 round-trip。
6. 删除三个 E2E 内对 `workspace_update_provider_registry.completed` 的依赖，使用当前正式观察点。
7. 修正 Upgrade Webview mock 控制面与状态观察点。

### 阶段 2：逐组重跑，才裁定产品 Bug

```text
基础 fixture 修正
       |
       v
Case 到达原始业务断言了吗？
       |
       +-- 否 --> 继续修测试基础设施
       |
       `-- 是
            |
            +-- 通过 --> 记录为测试迁移
            |
            `-- 失败 --> 固定为真实产品回归，再最小修生产代码
```

重跑优先级：

1. Bot 4 条（修改最小、反馈最快）；
2. CW / OTB / I08（只先替换 readiness barrier）；
3. Restart / Settings Transition / Turbo（共用 Account fixture）；
4. Coding Plan / Quota Reset（共用结构化 selection + Account fixture）；
5. Upgrade Webview；
6. I20 完整冷启动 child request。

## 6. 本轮未做事项

- 没有修改任何生产代码；
- 没有为了让测试通过恢复 legacy settings、workspace Registry snapshot 或 Personal Account access；
- 没有把失败用例标记 skip/pending；
- 没有宣称底层业务行为已经通过。当前报告只裁定“目前最早失败点及其根因”，测试迁移后仍必须完整重跑原始断言。
